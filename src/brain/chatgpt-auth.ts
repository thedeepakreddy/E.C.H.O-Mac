import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { dataRoot, atomicWrite } from "../memory/paths.js";

/**
 * "Sign in with ChatGPT": run the OpenAI brain on the user's own ChatGPT plan
 * instead of a pay-per-token API key.
 *
 * This is OpenAI's documented flow for OPEN-SOURCE apps that run on the user's
 * machine (developers.openai.com/siwc/token-sharing-open-source). It is not
 * Codex's login borrowed from Codex — Echo registers itself as its own OAuth
 * client, the user consents in the browser to Echo using their plan, and usage
 * counts against their ChatGPT limits. OpenAI allows this for open-source,
 * locally-run apps only; a closed-source or commercial Echo would need OpenAI's
 * approval (openai.com/form/sign-in-with-chatgpt-interest).
 *
 * Written for Echo from the published protocol. OpenAI's DevKit implements the
 * same flow but is under a noncommercial licence, so none of its code is here.
 *
 * The flow:
 *   1. First sign-in uses client_id=dynamic_agent_client; OpenAI registers Echo
 *      and returns the issued client_id with the code. Later sign-ins reuse it.
 *   2. Authorization code + PKCE (S256) through a one-shot 127.0.0.1 listener.
 *   3. The code is exchanged for tokens (no client secret), and the ID token's
 *      signature, issuer, audience and nonce are verified against OpenAI's JWKS.
 *   4. Inference uses the access token as a Bearer on api.openai.com/v1/responses.
 *      Access tokens last an hour; refresh tokens rotate and last 30 days.
 */

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/** The permission to spend the user's ChatGPT plan, as opposed to just signing in. */
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const CALLBACK_PATH = "/auth/callback";
const APP_NAME = "Echo";
/** Where the user sees and caps what each app uses of their plan. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const DEFAULT_PORT = 8797;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export type ChatGPTStatus = "disconnected" | "connecting" | "connected" | "reauth_required";

/** What the UI and the rest of Echo may see. Never contains a token. */
export interface ChatGPTSession {
  status: ChatGPTStatus;
  /** Signed in AND allowed to use the plan. */
  planUsage: boolean;
  email?: string;
  name?: string;
  error?: string;
}

interface Stored {
  version: 1;
  clientId: string;
  subject: string;
  email?: string;
  name?: string;
  scopes: string[];
  status: "connected" | "reauth_required";
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  earliestRefreshAt?: number;
  savedAt: string;
}

export class ChatGPTError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const random = () => b64url(randomBytes(32));
const dir = () => join(dataRoot(), "chatgpt");
const connectionFile = () => join(dir(), "connection.json");
const hostFile = () => join(dir(), "host-id");

// ---- encrypted storage ------------------------------------------------------

type SafeStorage = { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string };

/** Electron's safeStorage (Keychain-backed on macOS), when running inside the app. */
function safeStorage(): SafeStorage | null {
  try {
    const electron = createRequire(import.meta.url)("electron");
    const s = electron?.safeStorage as SafeStorage | undefined;
    return s && typeof s.isEncryptionAvailable === "function" && s.isEncryptionAvailable() ? s : null;
  } catch {
    return null;
  }
}

function readStored(): Stored | null {
  if (!existsSync(connectionFile())) return null;
  try {
    const wrapper = JSON.parse(readFileSync(connectionFile(), "utf8"));
    let json: string;
    if (wrapper.encrypted) {
      const s = safeStorage();
      if (!s) throw new ChatGPTError("storage_locked", "Your ChatGPT sign-in is encrypted and can only be read by Echo itself.");
      json = s.decryptString(Buffer.from(String(wrapper.payload), "base64"));
    } else {
      json = String(wrapper.payload);
    }
    const parsed = JSON.parse(json);
    return parsed?.version === 1 && typeof parsed.clientId === "string" ? (parsed as Stored) : null;
  } catch (err) {
    if (err instanceof ChatGPTError) throw err;
    console.error("[chatgpt] saved sign-in could not be read:", (err as any)?.message ?? err);
    return null;
  }
}

function writeStored(value: Stored): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const s = safeStorage();
  const json = JSON.stringify(value);
  // Outside Electron (tests, scripts) there is no Keychain; the file is then
  // owner-only, like keys.env.
  const wrapper = s
    ? { version: 1, encrypted: true, payload: s.encryptString(json).toString("base64") }
    : { version: 1, encrypted: false, payload: json };
  atomicWrite(connectionFile(), JSON.stringify(wrapper));
}

/**
 * This installation's stable, opaque identity. OpenAI's flow asks every host
 * to keep one for its lifetime; it is sent only when `sendHostId` is enabled,
 * matching OpenAI's own reference app.
 */
function hostId(): string {
  try {
    const saved = readFileSync(hostFile(), "utf8").trim();
    if (/^urn:uuid:[0-9a-f-]{36}$/.test(saved)) return saved;
  } catch {
    /* first run */
  }
  const id = `urn:uuid:${randomUUID()}`;
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  atomicWrite(hostFile(), id);
  return id;
}

// ---- OAuth -----------------------------------------------------------------

interface Discovery { authorization_endpoint: string; token_endpoint: string; revocation_endpoint?: string; jwks_uri: string }
let discovered: Promise<Discovery> | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function discovery(): Promise<Discovery> {
  discovered ??= (async () => {
    const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
    const data: any = await res.json().catch(() => null);
    const same = (u: unknown) => typeof u === "string" && new URL(u).origin === ISSUER;
    if (!res.ok || data?.issuer !== ISSUER || !same(data.authorization_endpoint) || !same(data.token_endpoint) || !same(data.jwks_uri)) {
      throw new ChatGPTError("discovery_failed", "Couldn't reach ChatGPT's sign-in service. Check your connection and try again.", true);
    }
    return data as Discovery;
  })().catch((err) => {
    discovered = null;
    throw err;
  });
  return discovered;
}

async function verifyIdToken(idToken: string, clientId: string, nonce?: string) {
  const config = await discovery();
  jwks ??= createRemoteJWKSet(new URL(config.jwks_uri));
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: ISSUER,
      audience: clientId,
      algorithms: ["RS256"],
      clockTolerance: 5,
      requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
    });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("no subject");
    if (nonce !== undefined && payload.nonce !== nonce) throw new Error("nonce mismatch");
    if (payload.azp !== undefined && payload.azp !== clientId) throw new Error("azp mismatch");
    return {
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
    };
  } catch {
    throw new ChatGPTError("invalid_id_token", "ChatGPT's identity check failed. Please sign in again.");
  }
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const config = await discovery();
  const res = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    const code = String(data?.error?.code ?? data?.error ?? `http_${res.status}`);
    throw new ChatGPTError(code, String(data?.error_description ?? data?.error?.message ?? `ChatGPT sign-in failed (${res.status}).`), res.status >= 500);
  }
  if (!data || typeof data !== "object") throw new ChatGPTError("invalid_token_response", "ChatGPT returned an invalid response. Please sign in again.");
  return data;
}

/** Fold a token response into the stored record. */
function withTokens(base: Stored, data: any): Stored {
  if (typeof data.access_token !== "string" || String(data.token_type ?? "").toLowerCase() !== "bearer" ||
      typeof data.expires_in !== "number" || data.expires_in <= 0) {
    throw new ChatGPTError("invalid_token_response", "ChatGPT returned incomplete credentials. Please sign in again.");
  }
  const earliest = data.earliest_refresh_at;
  const earliestMs = typeof earliest === "number" ? earliest * 1000 : typeof earliest === "string" ? Date.parse(earliest) : undefined;
  return {
    ...base,
    scopes: typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : base.scopes,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : base.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    earliestRefreshAt: Number.isFinite(earliestMs) ? earliestMs : undefined,
    status: "connected",
    savedAt: new Date().toISOString(),
  };
}

const CALLBACK_PAGE = (ok: boolean, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Echo</title><style>body{font:17px -apple-system,system-ui;max-width:30rem;margin:18vh auto;padding:24px;color:#1d1d1f}h1{font-size:24px}</style>` +
  `<h1>${ok ? "You're signed in" : "Sign-in didn't finish"}</h1><p>${text}</p>`;

/** A one-shot listener on 127.0.0.1 for the browser's redirect. */
function listen(port: number, state: string, savedClientId: string | undefined, signal: AbortSignal) {
  let server: Server;
  let settled = false;
  const result = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
    const fail = (err: ChatGPTError) => { if (!settled) { settled = true; reject(err); } };
    signal.addEventListener("abort", () => fail(new ChatGPTError("cancelled", "Sign-in was cancelled.")), { once: true });
    server = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      let url: URL;
      try { url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`); } catch { res.writeHead(400).end(); return; }
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || req.headers.host !== `127.0.0.1:${port}` || settled) {
        res.writeHead(404).end("Not found");
        return;
      }
      const got = Buffer.from(url.searchParams.get("state") ?? "");
      const want = Buffer.from(state);
      if (url.searchParams.getAll("state").length !== 1 || got.length !== want.length || !timingSafeEqual(got, want)) {
        // Not ours — never let an unrelated request consume the sign-in.
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE(false, "This link doesn't match the sign-in Echo started. Go back to Echo and try again."));
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const clientId = url.searchParams.get("client_id") ?? savedClientId;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (error) {
        res.end(CALLBACK_PAGE(false, "ChatGPT didn't grant access. You can close this tab."));
        fail(new ChatGPTError(error === "access_denied" ? "consent_declined" : error, error === "access_denied" ? "You declined access in ChatGPT." : `ChatGPT sign-in failed: ${error}.`));
        return;
      }
      if (!code || !clientId || clientId === "dynamic_agent_client" || !/^[A-Za-z0-9_-]{1,200}$/.test(clientId)) {
        res.end(CALLBACK_PAGE(false, "ChatGPT didn't finish registering Echo. Go back to Echo and try again."));
        fail(new ChatGPTError("registration_incomplete", "ChatGPT didn't finish registering Echo. Please try again."));
        return;
      }
      res.end(CALLBACK_PAGE(true, "Go back to Echo — you can close this tab."));
      if (!settled) { settled = true; resolve({ code, clientId }); }
    });
    server.requestTimeout = 15_000;
  });
  void result.catch(() => {});
  const ready = new Promise<void>((resolve, reject) => {
    server!.once("error", () => reject(new ChatGPTError("port_in_use", `Port ${port} is in use, so Echo can't receive the sign-in. Close whatever is using it, or set openai.chatgptRedirectPort in your config.`)));
    server!.listen({ port, host: "127.0.0.1" }, () => resolve());
  });
  const close = () => { try { server.close(); server.closeAllConnections(); } catch { /* already closed */ } };
  return { result, ready, close, redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}` };
}

async function openInBrowser(url: string): Promise<void> {
  if (new URL(url).origin !== ISSUER) throw new ChatGPTError("bad_destination", "Refusing to open an unexpected sign-in address.");
  try {
    const { shell } = createRequire(import.meta.url)("electron");
    if (shell?.openExternal) return await shell.openExternal(url);
  } catch { /* not inside Electron */ }
  await new Promise<void>((resolve, reject) =>
    execFile("/usr/bin/open", [url], (err) => (err ? reject(new ChatGPTError("browser_unavailable", "Couldn't open your browser.")) : resolve())));
}

// ---- the client ------------------------------------------------------------

export interface ChatGPTOptions {
  redirectPort?: number;
  sendHostId?: boolean;
  /** Tests replace the browser. */
  openBrowser?: (url: string) => Promise<void>;
}

class ChatGPTAuth {
  private options: ChatGPTOptions = {};
  private signing: AbortController | null = null;
  private lastError: string | undefined;
  /** One refresh at a time: a refresh token is single-use, and racing two burns both. */
  private refreshing: Promise<string> | null = null;
  private listeners = new Set<(s: ChatGPTSession) => void>();
  /**
   * The stored connection, cached. Only this class writes the file, and the
   * control panel asks for the session many times a second — decrypting it
   * through the Keychain on every ask would be the slow path.
   */
  private cache: Stored | null | undefined;

  private load(): Stored | null {
    if (this.cache === undefined) this.cache = readStored();
    return this.cache;
  }

  private save(value: Stored | null): void {
    if (value) writeStored(value);
    else rmSync(connectionFile(), { force: true });
    this.cache = value;
  }

  configure(options: ChatGPTOptions): void {
    this.options = { ...this.options, ...options };
  }

  onChange(fn: (s: ChatGPTSession) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private publish(): void {
    const s = this.session();
    for (const fn of this.listeners) try { fn(s); } catch { /* a listener cannot break sign-in */ }
  }

  session(): ChatGPTSession {
    if (this.signing) return { status: "connecting", planUsage: false };
    let stored: Stored | null = null;
    try { stored = this.load(); } catch (err) { return { status: "disconnected", planUsage: false, error: (err as Error).message }; }
    if (!stored) return { status: "disconnected", planUsage: false, ...(this.lastError ? { error: this.lastError } : {}) };
    return {
      status: stored.status,
      planUsage: stored.status === "connected" && Boolean(stored.accessToken) && stored.scopes.includes(PLAN_SCOPE),
      email: stored.email,
      name: stored.name,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** Signed in with permission to use the plan — the OpenAI brain can run on it. */
  isReady(): boolean {
    return this.session().planUsage;
  }

  /** Open the browser, wait for consent, and store the connection. */
  async signIn(opts: { reconsent?: boolean } = {}): Promise<ChatGPTSession> {
    if (this.signing) throw new ChatGPTError("busy", "A ChatGPT sign-in is already open in your browser.");
    const controller = new AbortController();
    this.signing = controller;
    this.lastError = undefined;
    this.publish();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SIGN_IN_TIMEOUT_MS)]);
    let previous: Stored | null = null;
    try { previous = this.load(); } catch { previous = null; }
    const port = this.options.redirectPort ?? DEFAULT_PORT;
    const state = random();
    const nonce = random();
    const verifier = random();
    const listener = listen(port, state, previous?.clientId, signal);
    try {
      await listener.ready;
      const config = await discovery();
      const url = new URL(config.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: previous?.clientId ?? "dynamic_agent_client",
        response_type: "code",
        redirect_uri: listener.redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      }).toString();
      if (!previous?.clientId) url.searchParams.set("agent_name_hint", APP_NAME);
      if (this.options.sendHostId) url.searchParams.set("ext_agent_host_id", hostId());
      if (previous?.email) url.searchParams.set("login_hint", previous.email);
      if (opts.reconsent) url.searchParams.set("prompt", "consent");
      hostId(); // persisted before the first authorization, whether or not it is sent
      await (this.options.openBrowser ?? openInBrowser)(url.toString());

      const { code, clientId } = await listener.result;
      const data = await tokenRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: listener.redirectUri,
        resource: RESOURCE,
      });
      if (typeof data.id_token !== "string") throw new ChatGPTError("invalid_id_token", "ChatGPT didn't return a verifiable identity. Please try again.");
      const who = await verifyIdToken(data.id_token, clientId, nonce);
      const stored = withTokens(
        { version: 1, clientId, subject: who.subject, email: who.email, name: who.name, scopes: [], status: "connected", savedAt: "" },
        data
      );
      this.save(stored);
      if (!stored.scopes.includes(PLAN_SCOPE)) {
        this.lastError = "You're signed in, but ChatGPT plan use wasn't allowed. Sign in again and allow Echo to use your plan, or use an API key.";
      }
      // Cleared before reading the session, or it would still say "connecting".
      this.signing = null;
      return this.session();
    } catch (err: any) {
      const e = err instanceof ChatGPTError ? err : new ChatGPTError("sign_in_failed", String(err?.message ?? err));
      if (e.code !== "cancelled") this.lastError = e.message;
      throw e;
    } finally {
      listener.close();
      this.signing = null;
      this.publish();
    }
  }

  cancelSignIn(): void {
    this.signing?.abort();
  }

  /** Forget the connection here, and revoke it at OpenAI when possible. */
  async signOut(): Promise<{ revoked: boolean }> {
    let stored: Stored | null = null;
    try { stored = this.load(); } catch { stored = null; }
    this.save(null);
    this.lastError = undefined;
    this.publish();
    if (!stored?.refreshToken) return { revoked: false };
    try {
      const config = await discovery();
      if (!config.revocation_endpoint) return { revoked: false };
      const res = await fetch(config.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: stored.refreshToken, token_type_hint: "refresh_token", client_id: stored.clientId }),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => {});
      return { revoked: res.ok };
    } catch {
      return { revoked: false };
    }
  }

  /**
   * A valid access token, refreshed when it is within a minute of expiring.
   * Throws a ChatGPTError the brain can say out loud when there is none.
   */
  async accessToken(): Promise<string> {
    const stored = this.load();
    if (!stored || stored.status !== "connected" || !stored.accessToken) {
      throw new ChatGPTError("sign_in_required", "Sign in with ChatGPT in Echo's control panel to use your ChatGPT plan.");
    }
    if (!stored.scopes.includes(PLAN_SCOPE)) {
      throw new ChatGPTError("plan_usage_not_allowed", "You're signed in with ChatGPT, but didn't allow Echo to use your plan. Sign in again and allow it.");
    }
    const fresh = (stored.expiresAt ?? 0) > Date.now() + 60_000;
    const mayRefresh = !stored.earliestRefreshAt || stored.earliestRefreshAt <= Date.now();
    if (fresh || (!mayRefresh && (stored.expiresAt ?? 0) > Date.now())) return stored.accessToken;
    this.refreshing ??= this.refresh(stored).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(stored: Stored): Promise<string> {
    if (!stored.refreshToken) return this.requireReauth(stored, "Your ChatGPT sign-in has expired. Sign in again.");
    let data: any;
    try {
      data = await tokenRequest({ grant_type: "refresh_token", client_id: stored.clientId, refresh_token: stored.refreshToken, resource: RESOURCE });
    } catch (err: any) {
      const code = String(err?.code ?? "");
      if (/^(invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused)$/.test(code)) {
        return this.requireReauth(stored, "Your ChatGPT sign-in has expired or was disconnected. Sign in again.");
      }
      throw err; // a network or server failure: keep the credentials and let the caller retry
    }
    // The old refresh token is spent the moment this returns, so the new one is
    // written before anything else can fail.
    const next = withTokens({ ...stored, scopes: stored.scopes }, { ...data, scope: data.scope ?? stored.scopes.join(" ") });
    this.save(next);
    if (typeof data.id_token === "string") {
      const who = await verifyIdToken(data.id_token, stored.clientId);
      if (who.subject !== stored.subject) return this.requireReauth(next, "ChatGPT returned a different account. Sign in again with the original one.");
    }
    this.publish();
    return next.accessToken!;
  }

  private requireReauth(stored: Stored, message: string): never {
    // The issued client_id is kept: signing in again must not register Echo twice.
    const { accessToken: _a, refreshToken: _r, expiresAt: _e, earliestRefreshAt: _x, ...rest } = stored;
    this.save({ ...rest, status: "reauth_required", scopes: [], savedAt: new Date().toISOString() });
    this.lastError = message;
    this.publish();
    throw new ChatGPTError("sign_in_required", message);
  }

  /** Models this ChatGPT account may use, in OpenAI's own display order. */
  async listModels(): Promise<Array<{ slug: string; displayName: string }>> {
    const token = await this.accessToken();
    const res = await fetch(`${RESOURCE}/models`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(body?.models)) {
      throw new ChatGPTError("model_catalog_failed", `Couldn't read the models your ChatGPT plan includes (${res.status}).`, true);
    }
    return body.models
      .filter((m: any) => m?.visibility === "list" && typeof m.slug === "string" && m.slug.trim())
      .map((m: any) => ({ slug: m.slug, displayName: typeof m.display_name === "string" ? m.display_name : m.slug }));
  }
}

export const chatgpt = new ChatGPTAuth();

/**
 * Turn a ChatGPT-plan error from the Responses API into something to say.
 * Codes from developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.
 */
export function explainPlanError(code: string | undefined, status?: number): string | null {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return `I've reached the usage limit your ChatGPT plan allows for Echo. You can check or raise it at ${CHATGPT_USAGE_URL}.`;
    case "subscription_sharing_user_not_eligible":
      return "Your ChatGPT account isn't eligible to share its plan with apps like Echo. You can use an API key instead.";
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return "ChatGPT couldn't check your plan's usage just now. Try again in a moment.";
    case "subscription_sharing_invalid_user":
      return "ChatGPT couldn't verify your account. Sign in with ChatGPT again in Echo's control panel.";
    case "subscription_sharing_unsupported_capability":
      return "ChatGPT plan usage doesn't support something in that request.";
    default:
      if (status === 401) return "ChatGPT didn't accept Echo's sign-in. Sign in with ChatGPT again in the control panel.";
      if (status === 403) return "ChatGPT refused that request for this account or region.";
      return null;
  }
}
