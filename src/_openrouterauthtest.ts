/**
 * Signing in to OpenRouter in the browser.   npm run openrouterauthtest
 *
 * The flow is short but every step of it is a place to leak something: a
 * verifier that does not match its challenge, a loopback listener left open
 * after a failure, a key that never reaches the keystore. Driven here against
 * a fake OpenRouter so all of that is exercised without a real sign-in.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { signInToOpenRouter, pkcePair, AUTH_PAGE } from "./brain/openrouter-auth.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log("\nOpenRouter browser sign-in\n");

console.log("  the PKCE pair");
{
  const { verifier, challenge } = pkcePair();
  ok(verifier.length >= 43, `the verifier is long enough to be a secret (${verifier.length} chars)`);
  ok(!/[+/=]/.test(verifier + challenge), "both are base64URL, not base64",
    "a '+' or '/' in a query string is a different string by the time it arrives");
  ok(challenge === b64url(createHash("sha256").update(verifier).digest()),
    "the challenge really is S256 of the verifier",
    "if these do not match, OpenRouter rejects the exchange and the cause is invisible");
  const second = pkcePair();
  ok(second.verifier !== verifier, "and a fresh pair each time");
}

/** A stand-in OpenRouter: hands back a key only for a correctly-derived verifier. */
function fakeOpenRouter() {
  const seen: any[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push(body);
    const expected = b64url(createHash("sha256").update(String(body.code_verifier)).digest());
    if (body.code !== "good-code") return new Response(JSON.stringify({ error: { message: "bad code" } }), { status: 400 });
    if (body.challenge_echo && body.challenge_echo !== expected) return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ key: "sk-or-v1-fromtheflow" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

console.log("\n  the whole round trip");
{
  const { fetchImpl, seen } = fakeOpenRouter();
  let opened = "";
  const result = await signInToOpenRouter({
    fetchImpl,
    openUrl: async (url) => {
      opened = url;
      // Act as the browser would: approve, and call the loopback back.
      const cb = new URL(url).searchParams.get("callback_url")!;
      await fetch(`${cb}/?code=good-code`).catch(() => {});
    },
  });
  ok(result.key === "sk-or-v1-fromtheflow", "it returns the key OpenRouter issued", result.key);
  ok(opened.startsWith(AUTH_PAGE), "the browser was sent to OpenRouter's own page", opened.slice(0, 60));
  const q = new URL(opened).searchParams;
  ok(q.get("code_challenge_method") === "S256", "declaring S256");
  ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(q.get("callback_url") ?? ""),
    `callback is loopback only (${q.get("callback_url")})`,
    "anything else would invite the code to be delivered off-machine");
  ok(seen[0]?.code_verifier && seen[0]?.code === "good-code", "and the verifier was sent with the code");
  ok(!opened.includes(seen[0].code_verifier), "the VERIFIER never goes in the url — only its hash",
    "sending it would make PKCE pointless");
}

console.log("\n  failures do not leave anything behind");
{
  const { fetchImpl } = fakeOpenRouter();
  let port = 0;
  let threw = "";
  try {
    await signInToOpenRouter({
      fetchImpl,
      openUrl: async (url) => {
        port = Number(new URL(new URL(url).searchParams.get("callback_url")!).port);
        const cb = new URL(url).searchParams.get("callback_url")!;
        await fetch(`${cb}/?error=access_denied`).catch(() => {});
      },
    });
  } catch (e: any) { threw = String(e?.message ?? e); }
  ok(/refused|access_denied/i.test(threw), `a refusal is reported in words (${threw.slice(0, 48)})`);
  // The listener must be gone, or the next attempt cannot bind.
  // Re-bind the same port. `require` does not exist in this ESM bundle, and
  // the first version of this check used it — so it threw, the catch said
  // false, and a passing implementation looked like a leak.
  const free = await new Promise<boolean>((r) => {
    const probe = createServer();
    probe.once("error", () => r(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => r(true)));
  });
  ok(free, `the loopback port ${port} was released`, "a leaked listener blocks every later sign-in");
}

console.log("\n  a timeout is not a hang");
{
  const { fetchImpl } = fakeOpenRouter();
  let threw = "";
  const t0 = Date.now();
  try {
    await signInToOpenRouter({ fetchImpl, timeoutMs: 300, openUrl: () => {} /* user never approves */ });
  } catch (e: any) { threw = String(e?.message ?? e); }
  ok(/timed out/i.test(threw), `it gives up and says so (${threw.slice(0, 40)})`);
  ok(Date.now() - t0 < 4000, "promptly");
}

console.log(`\n${pass}/${pass + fail} sign-in checks passed\n`);
process.exit(fail === 0 ? 0 : 1);
