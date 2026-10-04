/**
 * Sign in to OpenRouter in the browser, instead of pasting a key.
 *
 * OpenRouter's PKCE flow, which exists precisely for third-party apps — see
 * the Claude case in echo-chatgpt-signin for a provider where it does not.
 * Verified against the live service: `/api/v1/auth/keys` answers 400 to an
 * empty body while an invented route answers 404, and `/auth` redirects.
 *
 * Far smaller than `chatgpt-auth.ts` and deliberately so. There is no dynamic
 * client registration, no ID token to verify and nothing to refresh: the
 * exchange hands back an ordinary API key that the user owns and can revoke
 * from their dashboard. So it is stored like every other key — through
 * `keystore`, where the control panel already lists it — rather than in a
 * second credential store with its own lifecycle to get wrong.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const AUTH_PAGE = "https://openrouter.ai/auth";
export const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
/** The user has to find the window, log in and approve. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface SignInOptions {
  /** Show the user this url. Electron passes shell.openExternal. */
  openUrl: (url: string) => void | Promise<void>;
  /** Testing seam. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 0 lets the OS pick, which is what avoids a clash with a port in use. */
  port?: number;
}

export interface SignInResult {
  key: string;
}

/** base64url, which PKCE requires and Buffer's "base64" is not. */
function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** What the browser tab shows once it is done, so nobody is left on a blank page. */
const DONE_PAGE = (ok: boolean, detail = "") =>
  `<!doctype html><meta charset="utf-8"><title>Echo</title>` +
  `<body style="font:16px -apple-system,system-ui;display:grid;place-items:center;height:90vh;margin:0;color:#111">` +
  `<div style="text-align:center"><p style="font-size:42px;margin:0">${ok ? "✓" : "✕"}</p>` +
  `<p>${ok ? "Signed in to OpenRouter. You can close this tab." : `Sign-in failed. ${detail}`}</p></div>`;

/**
 * Run the whole flow and resolve with a usable key.
 *
 * The callback server is started BEFORE the browser opens, so a user who
 * approves instantly is never met by a connection refused.
 */
export async function signInToOpenRouter(opts: SignInOptions): Promise<SignInResult> {
  const { verifier, challenge } = pkcePair();
  const doFetch = opts.fetchImpl ?? fetch;
  let server: Server | undefined;

  try {
    const code = await new Promise<string>((resolve, reject) => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const got = url.searchParams.get("code");
        const err = url.searchParams.get("error");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE(!!got, err ?? "No code was returned."));
        if (got) resolve(got);
        else reject(new Error(err ? `OpenRouter refused: ${err}` : "no code in the callback"));
      });
      server.on("error", reject);
      server.listen(opts.port ?? 0, "127.0.0.1", () => {
        const port = (server!.address() as AddressInfo).port;
        const callback = `http://127.0.0.1:${port}`;
        const url = `${AUTH_PAGE}?callback_url=${encodeURIComponent(callback)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`;
        void opts.openUrl(url);
      });
      setTimeout(() => reject(new Error("timed out waiting for the browser")), opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
        .unref?.();
    });

    const res = await doFetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    const body: any = await res.json().catch(() => null);
    const key = typeof body?.key === "string" ? body.key : "";
    if (!res.ok || !key) {
      throw new Error(`OpenRouter would not exchange the code (HTTP ${res.status}) ${String(body?.error?.message ?? "").slice(0, 120)}`.trim());
    }
    return { key };
  } finally {
    // Always, on every path. A listener left on a loopback port after a
    // failed sign-in is a port that the next attempt cannot have.
    try { server?.close(); } catch { /* already gone */ }
  }
}
