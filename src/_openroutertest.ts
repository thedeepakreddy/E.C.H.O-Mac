/**
 * OpenRouter as a brain.   npm run openroutertest
 *
 * OpenRouter is not a second brain — it is the OpenAI Responses loop pointed
 * at a different host. That is only sound if the host really speaks that API,
 * so this checks the wiring offline and then, with a funded key, drives a
 * real request through `makeBrain` exactly as a turn would.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An isolated data root, set before anything reads one.
//
// Without it this test inherits ~/.jarvis — including the CHECKPOINT of a
// task that failed on an earlier run. Echo dutifully resumes it, the reply
// comes back as "Echo stopped before finishing, so I'm continuing from its
// checkpoint", and the result flips between pass and fail depending on what
// the last run left behind. `scripts/test-all.mjs` does this for every test
// it runs; a test run on its own has to do it itself.
process.env.ECHO_DATA_ROOT = mkdtempSync(join(tmpdir(), "echo-openrouter-"));

import { loadEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { PROVIDERS, PROVIDER_LABELS } from "./brain/switching.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

loadEnv(process.cwd());
const cfg = loadConfig(process.cwd());
const key = process.env[cfg.openrouter?.apiKeyEnv ?? "OPENROUTER_API_KEY"]?.trim();

/**
 * Whether to spend real requests.
 *
 * OpenRouter allows **50 free-model requests per day** on an account with no
 * credit (`X-RateLimit-Limit: 50`; $10 of credit raises it to 1000, and that
 * $10 is an unlock rather than something the free models consume). Calling
 * every catalogue entry plus a live turn costs eight of those fifty — so on
 * by default, `npm test` would exhaust the day's budget in six runs and then
 * report a wall of red that says nothing about the code.
 *
 * The free half — config, the endpoint's existence, the model catalogue — is
 * unauthenticated and uncapped, so it always runs.
 */
const LIVE = process.env.ECHO_OPENROUTER_LIVE === "1";

/** A refusal that is about the account, not the code. */
const isQuota = (m: string) => /rate limit|free-models-per-day|exceed your available credits|insufficient/i.test(m);
const skip = (m: string, why: string) => console.log(`  ⚠ ${m} — skipped: ${why.slice(0, 90)}`);

console.log("\nOpenRouter as a brain\n");

console.log("  it is a first-class brain, not a special case");
{
  ok(PROVIDERS.includes("openrouter" as any), "listed with the others, so voice switching reaches it");
  ok(PROVIDER_LABELS.openrouter === "OpenRouter", "and has a spoken name");
  ok(!!cfg.openrouter?.model && !!cfg.openrouter?.baseUrl, `configured (${cfg.openrouter?.model})`);
  ok(/^https?:\/\//.test(cfg.openrouter?.baseUrl ?? ""), "with a usable base url");
}

console.log("\n  the endpoint it will post to actually exists");
{
  // The claim the whole design rests on. A route that is merely unauthorised
  // answers 401; one that does not exist answers 404 — so this distinguishes
  // "OpenRouter speaks the Responses API" from "we are guessing".
  const base = (cfg.openrouter!.baseUrl).replace(/\/+$/, "");
  const probe = async (path: string) =>
    (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status;
  const responses = await probe("/responses");
  const bogus = await probe("/definitely-not-a-route");
  ok(responses !== 404, `/responses exists (HTTP ${responses})`, "if this 404s, the OpenAI loop cannot drive OpenRouter");
  ok(bogus === 404, `and a made-up route still 404s (HTTP ${bogus})`, "otherwise the check above proves nothing");
}

console.log("\n  the key");
if (!key) {
  console.log("  ⚠ OPENROUTER_API_KEY is not set — skipping the live half.");
} else {
  ok(key.startsWith("sk-or-"), "looks like an OpenRouter key");
  const info: any = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` } })
    .then((r) => r.json()).catch(() => null);
  const d = info?.data;
  ok(!!d, "the key is recognised by OpenRouter", JSON.stringify(info).slice(0, 80));
  if (d) {
    // TWO different budgets, and raising the wrong one changes nothing.
    //
    // `/key` reports the KEY's spending cap. `/credits` reports the money in
    // the account behind it. A $1000 key limit on a $0 balance still answers
    // "would exceed your available credits" — which is exactly what happened
    // here, and cost a round of debugging because both were called "limit".
    const credits: any = await fetch("https://openrouter.ai/api/v1/credits", { headers: { authorization: `Bearer ${key}` } })
      .then((r) => r.json()).catch(() => null);
    const balance = Number(credits?.data?.total_credits ?? 0) - Number(credits?.data?.total_usage ?? 0);
    const capOk = d.limit === null || Number(d.limit_remaining ?? 0) > 0;
    // A `:free` model costs nothing, so an empty account is not a problem —
    // which is the entire reason the catalogue is free-only. Credit is only
    // required if someone points `openrouter.model` at a paid one.
    const paid = !/:free$/.test(cfg.openrouter.model) && cfg.openrouter.model !== "openrouter/free";
    const spendable = capOk && (!paid || balance > 0);
    console.log(`      key cap  : ${d.limit ?? "none"} · remaining ${d.limit_remaining ?? "n/a"}`);
    console.log(`      account  : ${credits?.data?.total_credits ?? "?"} bought · ${Number(credits?.data?.total_usage ?? 0).toFixed(3)} used · ${balance.toFixed(3)} left`);
    // Not a code fault, and worth saying in words rather than failing silently:
    // a key with a zero cap answers 403 to every model, free ones included.
    console.log(`      model    : ${cfg.openrouter.model} (${paid ? "PAID — needs credit" : "free — no credit needed"})`);
    ok(spendable, paid ? "it has credit for the paid model configured" : "the configured model is free, so no credit is needed",
      !capOk
        ? "the KEY's cap is 0 — raise it at openrouter.ai/keys"
        : `${cfg.openrouter.model} is a paid model and the ACCOUNT has no credits (${balance.toFixed(3)} left) — buy some at openrouter.ai/credits, or switch openrouter.model to a :free one. Raising the key cap does not add money.`);

    if (spendable) {
      if (!LIVE) {
        console.log("\n  ⚠ live turn skipped (ECHO_OPENROUTER_LIVE=1 to spend a request)");
      } else {
      console.log("\n  a real turn through createBrain");
      // MCP off for this one turn, deliberately.
      //
      // The first live attempt failed with "Prompt tokens limit exceeded:
      // 57967 > 34680" — and that is not the brain. Echo sends a 26 KB system
      // prompt plus ~174 KB of Composio tool definitions that are exempt from
      // pruning (see the MCP-tools-bypass-pruning note), which is ~58k tokens
      // before the user has said anything. That is a payload problem worth
      // knowing about separately; this check is about whether the OpenRouter
      // endpoint speaks the Responses API at all, so it is isolated from it.
      process.env.ECHO_MCP = "0";
      const { createBrain } = await import("./brain/index.js");
      const { brain, provider } = createBrain({ ...cfg, brain: "openrouter" } as any, {});
      ok(provider === "openrouter", `the factory selected it (${provider})`);
      const said: string[] = [];
      const errors: string[] = [];
      // An unlistened 'error' throws and takes the process down — the same
      // trap as the audio player. Production attaches one; so must this.
      brain.on("error", (m: string) => errors.push(String(m)));
      brain.on("text", (t: string) => said.push(t));
      const done = new Promise<void>((r) => brain.once("turnEnd", () => r()));
      brain.send("What is 2 plus 2? Reply with just the number.", undefined, { modality: "text" });
      await Promise.race([done, new Promise((r) => setTimeout(r, 60_000))]);
      // NOT just "some text arrived". Echo narrates its own recovery when a
      // turn fails ("Echo stopped before finishing, so I'm continuing…"),
      // which made the first version of this check pass on a turn that had
      // errored — a test reporting success for a broken integration.
      ok(errors.length === 0, "the service did not refuse the request",
        errors.map((e) => e.slice(0, 200)).join(" | "));
      const reply = said.join(" ");
      // Twice now a weak version of this check passed on a broken turn: first
      // on Echo's own recovery narration, then on a reply that merely quoted
      // the word being looked for. So assert the ANSWER, and separately that
      // it is not the recovery text.
      ok(/\b4\b|four/i.test(reply), `the model answered the question (${reply.slice(0, 70)})`,
        "a reply came back but it is not an answer");
      ok(!/stopped before finishing|continuing from its checkpoint/i.test(reply),
        "and it is a model reply, not Echo narrating its own failure");
      }
    }
  }
}

// ── the catalogue ─────────────────────────────────────────────────────────
//
// Every entry was picked by measurement: called through this same endpoint
// with a real tool definition and kept only if it answered with an actual
// function_call. Echo is agentic — a model that will not call a tool is
// decoration. Free tiers are also retired without notice here (two already
// were between writing this and running it), so the list is re-checked
// rather than trusted.
console.log("\n  every model in the catalogue still works");
if (!key) {
  console.log("  ⚠ no key — skipped");
} else if (!LIVE) {
  console.log(`  ⚠ skipped — would spend ${cfg.openrouter.catalogue.length} of the day's 50 free requests (ECHO_OPENROUTER_LIVE=1 to run it)`);
} else {
  const tool = {
    type: "function", name: "get_weather", description: "Current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  };
  for (const m of cfg.openrouter.catalogue) {
    const t0 = Date.now();
    let verdict = "";
    try {
      const r: any = await fetch(`${cfg.openrouter.baseUrl.replace(/\/+$/, "")}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: m.id, input: "Weather in Tokyo? Use the tool.", tools: [tool], max_output_tokens: 200, store: false }),
      }).then((x) => x.json());
      verdict = r?.error
        ? `refused: ${String(r.error.message).slice(0, 48)}`
        : (r.output ?? []).some((o: any) => o?.type === "function_call") ? "" : "answered but would not call the tool";
    } catch (e: any) {
      verdict = `unreachable: ${String(e?.message ?? e).slice(0, 40)}`;
    }
    // A quota refusal is the account, not the model. Reporting it as a
    // failure would train everyone to ignore this list, which is the one
    // thing that must not happen to a list whose job is to notice retirements.
    if (verdict && isQuota(verdict)) skip(m.label, verdict);
    else ok(!verdict, `${m.label} (${Date.now() - t0}ms)`, `${m.id} — ${verdict}`);
  }
  ok(cfg.openrouter.catalogue.some((m) => m.id === cfg.openrouter.model),
    "and the configured model is one of them", cfg.openrouter.model);
}

console.log(`\n${pass}/${pass + fail} OpenRouter checks passed\n`);
process.exit(fail === 0 ? 0 : 1);
