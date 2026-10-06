/**
 * The phone app's own features on Echo's side: the chat, Face ID (passkeys)
 * and the actions behind them.
 *
 *   npm run remoteapptest
 *
 * Face ID is exercised end to end with a real P-256 key standing in for the
 * iPhone's Secure Enclave, so every check the phone's signature meets in
 * production is met here too — and every way to fake one is refused.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatLog, MAX_MESSAGES } from "./frontier/remote-chat.js";
import { PasskeyStore, decodeCbor } from "./frontier/passkeys.js";
import { parseRemoteAction, routeOf } from "./frontier/remote.js";
import { signPass, PassGeneration } from "./frontier/cloudpass.js";
import { RelayAgent } from "./frontier/relay-agent.js";
import http from "node:http";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const throws = (fn: () => unknown, m: string, match?: RegExp) => {
  try { fn(); ok(false, m); } catch (e: any) { ok(!match || match.test(String(e?.message)), `${m}${match && !match.test(String(e?.message)) ? ` (said: ${e?.message})` : ""}`); }
};
const dir = mkdtempSync(join(tmpdir(), "echo-remoteapp-"));

console.log("\nPhone app (Echo side)\n");

console.log("  chat");
{
  const file = join(dir, "chat.json");
  const log = new ChatLog(file);
  const a = log.add("you", "hey, how's the game going?");
  log.setTyping(true, 1000);
  ok(log.typing(1500), "typing… shows while Echo works on an answer");
  log.add("echo", "Pretty well!");
  ok(!log.typing(1500), "and clears the moment Echo answers");
  log.setTyping(true, 0);
  ok(!log.typing(200_000), "a turn that never answers stops showing typing… on its own");
  ok(log.since(0).length === 2 && log.since(a.id).length === 1, "the phone fetches only what it hasn't seen");
  const reopened = new ChatLog(file);
  ok(reopened.since(0).map((m) => m.text).join("|") === "hey, how's the game going?|Pretty well!", "the conversation survives a restart of Echo");
  ok(reopened.add("you", "x").id === 3, "and keeps numbering where it left off");
  for (let i = 0; i < MAX_MESSAGES + 20; i++) reopened.add("you", `m${i}`);
  ok(reopened.since(0).length === MAX_MESSAGES, `it keeps the last ${MAX_MESSAGES} messages`);
  ok(routeOf("/chat?t=x") === "chat" && routeOf("/chat/voice") === "chat-voice", "/chat and /chat/voice are routes");
}

console.log("  Face ID (passkeys)");
{
  const RP = "echo-remote.onrender.com", ORIGIN = `https://${RP}`;
  const store = new PasskeyStore(join(dir, "passkeys.json"));
  // The iPhone: a P-256 key pair, and the bytes its authenticator would produce.
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as any;
  const credId = randomBytes(16);
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
  // Tiny CBOR writer for the test's attestation object.
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const cbor = (v: any): Buffer => {
    if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
    if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
    if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
    if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
    throw new Error("cbor?");
  };
  const cose = cbor(new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  const authData = (flags: number, count: number, attested = false) => Buffer.concat([
    sha(RP), Buffer.from([flags]), Buffer.from([0, 0, 0, count]),
    ...(attested ? [Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cose] : []),
  ]);
  const client = (type: string, challenge: string, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin }));
  const UP_UV = 0x01 | 0x04;

  const reg = store.options("register", RP) as any;
  ok(reg.authenticatorSelection.userVerification === "required" && reg.rp.id === RP, "registration asks for Face ID on this app's own site");
  const created = {
    id: credId.toString("base64url"),
    response: {
      clientDataJSON: client("webauthn.create", reg.challenge).toString("base64url"),
      attestationObject: cbor(new Map<any, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(UP_UV | 0x40, 0, true)]])).toString("base64url"),
    },
  };
  ok(decodeCbor(Buffer.from(created.response.attestationObject, "base64url")).value.get("fmt") === "none", "the CBOR reader reads an attestation object");
  store.register(created, ORIGIN, RP);
  ok(store.count === 1, "a phone's Face ID is registered");
  throws(() => store.register(created, ORIGIN, RP), "the same registration cannot be replayed", /expired/);

  const assertion = (purpose: "login" | "confirm", opts: { flags?: number; count?: number; origin?: string; sign?: boolean; challenge?: string } = {}) => {
    const challenge = opts.challenge ?? (store.options(purpose, RP) as any).challenge;
    const cd = client("webauthn.get", challenge, opts.origin);
    const ad = authData(opts.flags ?? UP_UV, opts.count ?? 0);
    const signer = createSign("sha256");
    signer.update(Buffer.concat([ad, sha(cd)]));
    const sig = opts.sign === false ? randomBytes(70) : signer.sign(privateKey);
    return { id: credId.toString("base64url"), response: { clientDataJSON: cd.toString("base64url"), authenticatorData: ad.toString("base64url"), signature: sig.toString("base64url") } };
  };
  ok(store.verify(assertion("login"), ORIGIN, RP, "login") === true, "Face ID signs in");
  ok(store.verify(assertion("confirm"), ORIGIN, RP, "confirm") === true, "and confirms an action");
  throws(() => store.verify(assertion("login", { sign: false }), ORIGIN, RP, "login"), "a forged signature is refused", /didn't match/);
  throws(() => store.verify(assertion("login", { flags: 0x01 }), ORIGIN, RP, "login"), "a tap without Face ID (no user verification) is refused", /Face ID/);
  throws(() => store.verify(assertion("login", { origin: "https://evil.example.com" }), ORIGIN, RP, "login"), "a request from another site is refused", /somewhere else/);
  throws(() => store.verify(assertion("login"), ORIGIN, RP, "confirm"), "a sign-in signature cannot approve an action", /expired/);
  const once = assertion("login");
  store.verify(once, ORIGIN, RP, "login");
  throws(() => store.verify(once, ORIGIN, RP, "login"), "the same Face ID answer cannot be used twice", /expired/);
  throws(() => store.verify(assertion("login", { challenge: "made-up" }), ORIGIN, RP, "login"), "an invented challenge is refused", /expired/);
  ok(store.verify(assertion("login", { count: 5 }), ORIGIN, RP, "login") === true, "a device-bound key's counter is tracked");
  throws(() => store.verify(assertion("login", { count: 3 }), ORIGIN, RP, "login"), "and a counter that goes backwards (a cloned key) is refused", /cloned/);
  const other = new PasskeyStore(join(dir, "passkeys.json"));
  ok(other.count === 1, "registrations survive a restart");
  throws(() => new PasskeyStore(null).verify(assertion("login"), ORIGIN, RP, "login"), "a phone that never registered cannot sign in");

  console.log("  hand-off to the Mac (Face ID over the task itself)");
  const { taskChallenge, processHandoffs, SeenTasks } = await import("./frontier/handoff.js");
  const now = Date.now();
  const task = { id: "0a1b2c3d-1111-4222-8333-444455556666", text: "Build the settings screen for the weather app", createdAt: now - 3600_000, device: "f".repeat(32) };
  let counter = 10; // the key above is device-bound and at 5 now: each signature counts up
  const signedFor = (t: any) => assertion("confirm", { challenge: taskChallenge(t), count: ++counter });
  ok(taskChallenge(task) === taskChallenge({ ...task }) && taskChallenge(task) !== taskChallenge({ ...task, text: task.text + "!" }), "the challenge is the hash of exactly the task");
  ok(store.verifySigned(signedFor(task), ORIGIN, RP, taskChallenge(task)) === true, "Face ID over a task verifies on the Mac, with no challenge from the Mac");
  throws(() => store.verifySigned(signedFor(task), ORIGIN, RP, taskChallenge({ ...task, text: "Delete my Documents folder" })), "a task edited after Face ID is refused", /approved something else/);
  throws(() => store.verifySigned(assertion("confirm", { challenge: taskChallenge(task), sign: false, count: ++counter }), ORIGIN, RP, taskChallenge(task)), "a forged signature is refused", /didn't match/);
  throws(() => store.verifySigned(assertion("confirm", { challenge: taskChallenge(task), origin: "https://evil.example.com", count: ++counter }), ORIGIN, RP, taskChallenge(task)), "a task approved on another site is refused", /somewhere else/);

  const updates: string[] = [];
  const ran: string[] = [];
  const seen = new SeenTasks(join(dir, "seen.json"));
  const old = { ...task, id: "0a1b2c3d-2222-4222-8333-444455556666", createdAt: now - 8 * 86400_000 };
  const edited = { ...task, id: "0a1b2c3d-3333-4222-8333-444455556666" };
  const second = { ...task, id: "0a1b2c3d-4444-4222-8333-444455556666", text: "Then run its tests", createdAt: now - 1800_000 };
  let busyAfter = Infinity;
  const deps = (list: any[]) => ({
    list: async () => list,
    update: async (id: string, status: string, summary?: string) => { updates.push(`${id.slice(9, 13)}:${status}${summary ? `:${summary.slice(0, 24)}` : ""}`); },
    verify: (t: any, a: any) => { store.verifySigned(a, ORIGIN, RP, taskChallenge(t)); },
    run: async (t: any) => { ran.push(t.text); return { ok: true, summary: `Done: ${t.text}` }; },
    busy: () => ran.length >= busyAfter,
    seen, now: () => now,
  });
  const aTask = signedFor(task), aSecond = signedFor(second); // signed in the order they'll run (the key counts up)
  const n = await processHandoffs(deps([
    { task: second, assertion: aSecond },
    { task, assertion: aTask },
    { task: old, assertion: signedFor(old) },
    { task: edited, assertion: signedFor({ ...edited, text: "something else" }) },
  ]));
  ok(n === 2 && ran.join(" | ") === "Build the settings screen for the weather app | Then run its tests", "approved jobs run, oldest first");
  ok(updates.includes("1111:started") && updates.some((u) => u.startsWith("1111:done:Done: Build")), "each reports started, then done with Echo's answer");
  ok(updates.some((u) => u.startsWith("2222:rejected:That job is more than")), "a job over a week old is refused");
  ok(updates.some((u) => u.startsWith("3333:rejected:Face ID check failed")), "a job whose Face ID approved different text is refused");
  updates.length = 0;
  await processHandoffs(deps([{ task, assertion: signedFor(task) }]));
  ok(ran.length === 2 && updates[0] === "1111:done:Already done on your Mac", "a job never runs twice, even if the relay offers it again");
  ok(new SeenTasks(join(dir, "seen.json")).has(task.id), "and that survives a restart");
  busyAfter = 0;
  const third = { ...task, id: "0a1b2c3d-5555-4222-8333-444455556666" };
  updates.length = 0;
  const waited = await processHandoffs(deps([{ task: third, assertion: signedFor(third) }]));
  ok(waited === 0 && !updates.some((u) => u.startsWith("5555:started")), "while Echo is busy, jobs wait");
}

console.log("  actions");
{
  ok(parseRemoteAction({ type: "power-off" }) === null, "power off without a Face ID answer is not even an action");
  ok(parseRemoteAction({ type: "power-off", assertion: {} })?.type === "power-off", "with one, it goes on to be verified");
  ok(parseRemoteAction({ type: "open-neural" })?.type === "open-neural", "opening the neural map on the Mac is allowed");
  ok(parseRemoteAction({ type: "shutdown" }) === null, "the control panel's own shutdown is still refused");
  ok(routeOf("/passkey/options") === "passkey-options" && routeOf("/passkey/login") === "passkey-login" && routeOf("/passkey/register") === "passkey-register", "the Face ID routes exist");
}

console.log("  Phone mode (cloud pass and chat import)");
{
  // The same vector echo-remote's test checks (test/phone.test.mjs): Echo signs, the relay verifies.
  const vector = signPass("v".repeat(40), { device: "f".repeat(32), gen: 3, now: 1791300000000 });
  ok(vector === "cp1.eyJ2IjoxLCJkIjoiZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmYiLCJpYXQiOjE3OTEzMDAwMDAsImV4cCI6MTc5Mzg5MjAwMCwiZyI6M30.pOA4SN7qh0I460FKakT56xpRZMA7ATc6gwJFKZ8NiUs",
    "a cloud pass signed here is byte-for-byte what the relay expects");
  const genFile = join(dir, "pass-gen.json");
  const g = new PassGeneration(genFile);
  ok(g.get() === 1, "passes start at generation 1");
  g.bump();
  ok(new PassGeneration(genFile).get() === 2, "\"sign out every phone\" survives a restart");
  g.adopt(5); g.adopt(3);
  ok(new PassGeneration(genFile).get() === 5, "a higher generation from the relay is adopted, a lower one ignored");

  const log = new ChatLog(join(dir, "chat-import.json"));
  log.add("you", "earlier on the Mac");
  const t0 = Date.now() - 60_000;
  const n = log.importFromPhone([
    { ref: "c-abc1", from: "you", text: "what's the weather?", at: t0 },
    { ref: "c-abc2", from: "echo", text: "14° and raining.", at: t0 + 2000 },
    { ref: "bad ref!", from: "you", text: "x", at: t0 },
    { ref: "c-abc3", from: "someone" as any, text: "x", at: t0 },
  ]);
  ok(n === 2, "Phone mode's messages are copied in; malformed ones are skipped");
  ok(log.importFromPhone([{ ref: "c-abc1", from: "you", text: "what's the weather?", at: t0 }]) === 0, "a retried copy is never duplicated");
  const copied = log.since(0).filter((m) => m.via === "phone");
  ok(copied.length === 2 && copied[0].at === t0 && copied[0].ref === "c-abc1", "they keep their times and the phone's id");
  ok(routeOf("/chat/import") === "chat-import", "/chat/import is a route");

  // The agent tells the relay its generation on every poll, and adopts the relay's when higher.
  let sent = "";
  const fake = http.createServer((req, res) => {
    sent ||= String(req.headers["x-echo-pass-gen"] ?? ""); // the first poll, before any adoption
    res.writeHead(204, { "x-relay-pass-gen": "9" });
    res.end();
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const gen = new PassGeneration(null);
  const agent = new RelayAgent(`http://127.0.0.1:${(fake.address() as any).port}`, "x".repeat(40), "http://127.0.0.1:1", () => {}, () => {}, { get: () => gen.get(), adopt: (k) => gen.adopt(k) });
  agent.start();
  for (let i = 0; i < 40 && gen.get() !== 9; i++) await new Promise((r) => setTimeout(r, 50));
  agent.stop();
  fake.closeAllConnections?.();
  fake.close();
  ok(sent === "1", "each poll carries Echo's pass generation");
  ok(gen.get() === 9, "and a sign-out done from the phone (higher on the relay) reaches Echo");
}

console.log("  Morning briefing digest");
{
  const { emailsFrom, recentMissions } = await import("./frontier/phone-digest.js");
  const gmail = { data: { messages: [
    { messageId: "1", sender: "Anna Kovacs <anna@example.com>", subject: "Contract draft", preview: { body: "secret body" } },
    { messageId: "2", from: "\"Render\" <no-reply@render.com>", subject: "Deploy failed" },
    { messageId: "3", sender: "Anna Kovacs <anna@example.com>", subject: "Contract draft" },
  ] } };
  const found = emailsFrom([null, gmail]);
  ok(found.length === 2 && found[0].from === "Anna Kovacs" && found[1].from === "Render", "sender names and subjects are found in Gmail's results, duplicates dropped");
  ok(!JSON.stringify(found).includes("secret body"), "and never a message body");
  ok(emailsFrom([{ nested: { deeper: [{ sender: "X", subject: "" }] } }])[0].subject === "(no subject)", "however deep, and an empty subject says so");
  const now = Date.now();
  const missions = recentMissions({ missions: [
    { goal: "weather app tests", status: "completed", updatedAt: now - 3600_000 },
    { goal: "still going", status: "running", updatedAt: now },
    { goal: "last week", status: "completed", updatedAt: now - 8 * 86400_000 },
  ] }, now);
  ok(missions.length === 1 && missions[0].goal === "weather app tests", "only missions that finished in the last day");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} phone app checks passed\n`);
process.exit(fail ? 1 : 0);
