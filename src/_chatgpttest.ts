/**
 * Sign in with ChatGPT, end to end against a fake OpenAI.
 *
 *   npm run chatgpttest
 *
 * Offline. `fetch` is stubbed to play OpenAI's discovery, token, JWKS, models
 * and Responses endpoints; ID tokens are real RS256 JWTs signed by a key made
 * here, so the signature check is exercised for real. The browser is replaced
 * by a request to Echo's real 127.0.0.1 callback listener.
 */
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const scratch = mkdtempSync(join(tmpdir(), "echo-chatgpttest-"));
process.env.ECHO_DATA_ROOT = scratch;
process.env.ECHO_MCP = "0";
process.env.ECHO_LOG = "0";
delete process.env.OPENAI_API_KEY;

const { chatgpt, PLAN_SCOPE } = await import("./brain/chatgpt-auth.js");
const { resolveOpenAIAuth } = await import("./brain/openai-auth.js");
const { OpenAIBrain, replayableOutput, trimResponseImages } = await import("./brain/openai.js");
const { loadConfig, setActiveConfig } = await import("./config.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a fake OpenAI ---------------------------------------------------------
const ISSUER = "https://auth.openai.com";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const CLIENT = "client_issued_123";
const idToken = (claims: Record<string, unknown>) =>
  new SignJWT({ email: "deepak@example.com", name: "Deepak", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER).setAudience(CLIENT).setSubject("user-abc").setIssuedAt().setExpirationTime("1h")
    .sign(privateKey);

let authorizeParams: URLSearchParams | null = null;
let grantScope = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const tokenCalls: Array<Record<string, string>> = [];
const responsesBodies: any[] = [];
let responsesScript: Array<(body: any) => { events?: any[]; status?: number; json?: any }> = [];
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (events: any[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`, jwks_uri: `${ISSUER}/.well-known/jwks.json` });
  }
  if (url === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [jwk] });
  if (url === `${ISSUER}/api/accounts/oauth/token`) {
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    tokenCalls.push(body);
    if (body.grant_type === "authorization_code") {
      const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
      if (body.code !== "good-code" || challenge !== authorizeParams?.get("code_challenge") || body.resource !== "https://api.openai.com/v1") {
        return json({ error: "invalid_grant" }, 400);
      }
      return json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600, scope: grantScope, id_token: await idToken({ nonce: authorizeParams?.get("nonce") }) });
    }
    if (body.grant_type === "refresh_token") {
      if (body.refresh_token === "refresh-1") {
        return json({ access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600, id_token: await idToken({}) });
      }
      return json({ error: "invalid_grant" }, 400);
    }
  }
  if (url === `${ISSUER}/api/accounts/oauth/revoke`) return new Response("", { status: 200 });
  if (url === "https://api.openai.com/v1/models") {
    return json({ models: [{ slug: "gpt-plan-1", display_name: "GPT Plan", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hidden" }] });
  }
  if (url === "https://api.openai.com/v1/responses") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    responsesBodies.push({ body: JSON.parse(JSON.stringify(body)), auth: init?.headers?.authorization });
    const step = responsesScript.shift()?.(body) ?? { events: [{ type: "response.completed", response: { output: [] } }] };
    if (step.status) return json(step.json ?? {}, step.status);
    return sse(step.events ?? []);
  }
  return json({ error: `unexpected ${url}` }, 404);
}) as typeof fetch;

/** The user, in the browser, approving Echo and being sent back. */
const PORT = 18000 + Math.floor(Math.random() * 2000);
chatgpt.configure({
  redirectPort: PORT,
  openBrowser: async (url: string) => {
    authorizeParams = new URL(url).searchParams;
    const back = new URL(authorizeParams.get("redirect_uri")!);
    back.searchParams.set("code", "good-code");
    back.searchParams.set("state", authorizeParams.get("state")!);
    back.searchParams.set("client_id", CLIENT);
    setTimeout(() => void realFetch(back.toString()).catch(() => {}), 20);
  },
});

console.log("\nSign in with ChatGPT\n");
{
  // Someone else hitting the callback must not consume the sign-in.
  const stray = await realFetch(`http://127.0.0.1:${PORT}/auth/callback?code=x&state=wrong`).catch(() => null);
  ok(stray === null, "nothing listens on the callback port before a sign-in starts");

  const session = await chatgpt.signIn();
  const p = authorizeParams!;
  ok(p.get("client_id") === "dynamic_agent_client" && p.get("agent_name_hint") === "Echo", "the first sign-in registers Echo as its own app");
  ok(p.get("code_challenge_method") === "S256" && !!p.get("code_challenge") && !!p.get("nonce") && !!p.get("state"), "it uses PKCE, a nonce and a state");
  ok(p.get("redirect_uri") === `http://127.0.0.1:${PORT}/auth/callback`, "the redirect is the 127.0.0.1 loopback");
  ok((p.get("scope") ?? "").includes(PLAN_SCOPE) && p.get("resource") === "https://api.openai.com/v1", "it asks to use the ChatGPT plan, for the API resource");
  ok(!p.has("ext_agent_host_id"), "the host id is not sent unless enabled (as in OpenAI's reference app)");
  ok(tokenCalls[0]?.client_id === CLIENT && !("client_secret" in tokenCalls[0]), "the code is exchanged with the issued client id and no secret");
  ok(session.status === "connected" && session.planUsage && session.email === "deepak@example.com", "signed in, with plan use, as the verified account");
  const file = join(scratch, "chatgpt", "connection.json");
  // Outside Electron there is no Keychain, so the file is plain but owner-only;
  // inside the app it is encrypted with safeStorage.
  ok((statSync(file).mode & 0o777) === 0o600, "the connection is saved under the data folder, readable only by the user");
  ok(chatgpt.isReady() && resolveOpenAIAuth(loadConfig(process.cwd()))?.via === "chatgpt", "the OpenAI brain now pays with the plan, with no API key set");
}
{
  ok((await chatgpt.accessToken()) === "access-1", "a fresh token is used as is");
  // Force expiry: the next request must refresh, once, and keep the new token.
  const file = join(scratch, "chatgpt", "connection.json");
  const wrapper = JSON.parse(readFileSync(file, "utf8"));
  const stored = JSON.parse(wrapper.payload);
  stored.expiresAt = Date.now() - 1000;
  (chatgpt as any).cache = stored;
  const [a, b] = await Promise.all([chatgpt.accessToken(), chatgpt.accessToken()]);
  const refreshes = tokenCalls.filter((c) => c.grant_type === "refresh_token").length;
  ok(a === "access-2" && b === "access-2" && refreshes === 1, `an expired token is refreshed exactly once, even when asked for twice at once (${refreshes})`);
  ok(tokenCalls.at(-1)?.refresh_token === "refresh-1", "the refresh spends the stored refresh token");
}
{
  // A rejected refresh token means sign in again — keeping the issued client.
  (chatgpt as any).cache = { ...(chatgpt as any).cache, refreshToken: "refresh-dead", expiresAt: Date.now() - 1000 };
  let said = "";
  try { await chatgpt.accessToken(); } catch (e: any) { said = e.message; }
  ok(/sign in again/i.test(said) && chatgpt.session().status === "reauth_required", "a dead refresh token asks for a new sign-in");
  await chatgpt.signIn();
  ok(authorizeParams!.get("client_id") === CLIENT && !authorizeParams!.has("agent_name_hint"), "signing in again reuses the issued client, not a second registration");
}
{
  // Declining plan use leaves a sign-in that cannot pay.
  grantScope = "openid profile email offline_access";
  const s = await chatgpt.signIn();
  ok(!s.planUsage && /plan use wasn't allowed/i.test(s.error ?? ""), "signing in without allowing plan use says so");
  ok(resolveOpenAIAuth(loadConfig(process.cwd())) === null, "and the OpenAI brain does not try to run on it");
  grantScope = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
  await chatgpt.signIn();
}

console.log("\nOpenAI brain on the plan (Responses API)\n");
{
  const cfg = loadConfig(process.cwd());
  cfg.agi.toolPruning.enabled = false;
  cfg.agi.confidenceToDemo.enabled = false;
  cfg.learning.enabled = false;
  setActiveConfig(cfg);
  responsesScript = [
    () => ({ events: [
      { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "wait", arguments: "{\"seconds\":0.2}" } },
      { type: "response.completed", response: { output: [
        { id: "rs_1", type: "reasoning", summary: [] },
        { id: "fc_1", type: "function_call", call_id: "call_1", name: "wait", arguments: "{\"seconds\":0.2}", status: "completed" },
      ] } },
    ] }),
    () => ({ events: [
      { type: "response.output_text.delta", delta: "All " },
      { type: "response.output_text.delta", delta: "done." },
      { type: "response.completed", response: { output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "All done." }] }], usage: { input_tokens: 10, output_tokens: 3 } } },
    ] }),
  ];
  const brain = new OpenAIBrain(cfg, { via: "chatgpt" }) as any;
  const said: string[] = [];
  const deltas: string[] = [];
  let ended = 0;
  brain.on("text", (t: string) => said.push(t));
  brain.on("textDelta", (d: any) => deltas.push(d.text));
  brain.on("turnEnd", () => ended++);
  brain.send("wait a moment then say done");
  for (let i = 0; i < 40 && !ended; i++) await sleep(100);

  const [first, second] = responsesBodies;
  const forbidden = ["temperature", "max_output_tokens", "metadata", "previous_response_id", "top_p", "truncation", "user", "background", "conversation", "prompt"];
  ok(first?.auth === "Bearer access-1", "requests carry the plan's access token");
  ok(first?.body.store === false && first?.body.stream === true, "store:false and stream:true, as the plan route requires");
  ok(forbidden.every((k) => !(k in first.body)), "none of the fields the plan route rejects are sent");
  ok(first?.body.model === "gpt-plan-1", "the model comes from the account's own catalog when none is configured");
  ok(typeof first?.body.instructions === "string" && !first.body.input.some((i: any) => i.role === "system"), "guidance goes in instructions, never a system message");
  ok(first?.body.tools?.length === 1 && first.body.tools[0].type === "namespace" && first.body.tools[0].tools.some((t: any) => t.name === "wait"), "Echo's tools are grouped in one namespace");
  const echoed = second?.body.input ?? [];
  const call = echoed.find((i: any) => i.type === "function_call");
  const result = echoed.find((i: any) => i.type === "function_call_output");
  ok(call && !("id" in call) && !echoed.some((i: any) => i.type === "reasoning"), "the call is sent back without server ids or reasoning items");
  ok(result?.call_id === "call_1" && /"status":"success"/.test(result.output), "the tool really ran through the gate, and its result follows the call");
  ok(said.includes("All done.") && deltas.join("") === "All done." && ended === 1, "the reply streams, is said once, and the turn ends");
}
{
  responsesScript = [() => ({ status: 429, json: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } })];
  const brain = new OpenAIBrain(loadConfig(process.cwd()), { via: "chatgpt" }) as any;
  let error = "";
  let ended = false;
  brain.on("error", (m: string) => (error = m));
  brain.on("turnEnd", () => (ended = true));
  brain.send("hello");
  for (let i = 0; i < 30 && !ended; i++) await sleep(100);
  ok(/usage limit your ChatGPT plan allows/.test(error) && /chatgpt\.com\/settings\/usage/.test(error), "hitting the plan's limit is explained, with where to check it");
}
{
  const items = replayableOutput([{ id: "x", type: "message", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: [] }] }]);
  ok(items.length === 1 && !("id" in items[0]) && items[0].content[0].text === "hi", "assistant text is kept for the next request, without its id");
  const history = [1, 2, 3].map((n) => ({ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(n)}` }] }));
  trimResponseImages(history, 2);
  ok(history[0].content[0].type === "input_text" && history[2].content[0].type === "input_image", "only the newest screenshots stay in the history");
}

console.log("\nSign out\n");
{
  const { revoked } = await chatgpt.signOut();
  ok(revoked && chatgpt.session().status === "disconnected", "signing out revokes the session at OpenAI and forgets it here");
  ok(resolveOpenAIAuth(loadConfig(process.cwd())) === null, "and the OpenAI brain needs a sign-in or a key again");
}

globalThis.fetch = realFetch;
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} ChatGPT sign-in cases passed\n`);
process.exit(fail ? 1 : 0);
