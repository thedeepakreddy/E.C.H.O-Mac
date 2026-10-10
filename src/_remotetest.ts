/**
 * The phone remote — mostly its refusals.
 *
 *   npm run remotetest
 *
 * Full control of the Mac from a phone, reached only through the phone app's
 * relay, so the tests are weighted heavily toward what it will NOT do. A real
 * server (loopback only) is started at the end and probed.
 */
import {
  newToken, tokenMatches, tokenFrom, routeOf, record, recentItems,
  isLockedOut, noteBadAttempt, resetAttempts,
  startRemote, stopRemote, isRunning, remoteStatus,
  MAX_ITEMS, MAX_BAD_ATTEMPTS, parseRemoteAction, REMOTE_KEYS, setCommandHandler, setChatHandler,
} from "./frontier/remote.js";
import { parseBattery } from "./frontier/remote-vitals.js";
import { replayLocally, relayFromConfig, RelayAgent, CLIENT_IP_HEADER } from "./frontier/relay-agent.js";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { MAX_REMOTE_VOICE_BYTES } from "./frontier/remote-voice.js";
import { turnContract, CHAT_TURN_CONTRACT, VOICE_TURN_CONTRACT } from "./brain/types.js";
import { setPassword } from "./frontier/remoteauth.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nPhone remote\n");

console.log("  tokens");
{
  const a = newToken(), b = newToken();
  ok(a.length === 32, `a token is 32 hex characters (${a.length})`);
  ok(a !== b, "and a new one each time");
  ok(/^[0-9a-f]+$/.test(a), "hex only, so it survives being typed from a screen");
}
{
  const t = newToken();
  ok(tokenMatches(t, t), "the right token matches");
  // The replacement character must actually DIFFER. Substituting a fixed "0"
  // is a no-op one time in sixteen, when the random hex token already ends in
  // "0" — the "wrong" token is then identical, the match rightly succeeds, and
  // this line fails for a reason that has nothing to do with the code.
  const wrong = t.slice(0, -1) + (t.endsWith("0") ? "1" : "0");
  ok(wrong !== t, "the altered token really is different");
  ok(!tokenMatches(t, wrong), "one character wrong does not");
  ok(!tokenMatches(t, ""), "an empty token does not");
  ok(!tokenMatches(t, undefined), "a missing token does not");
  ok(!tokenMatches(t, t + "a"), "a longer string does not");
  ok(!tokenMatches("", t), "and nothing matches when no token is set");
}
{
  ok(tokenFrom("/?t=abc123") === "abc123", "the token is read from the query");
  ok(tokenFrom("/events?since=4&t=abc") === "abc", "wherever it appears in it");
  ok(tokenFrom("/") === undefined, "no query means no token");
  ok(tokenFrom(undefined) === undefined, "and no url does not throw");
}

console.log("  routing");
{
  ok(routeOf("/") === "unknown", "the Mac serves no page of its own: the phone app lives on the relay");
  ok(routeOf("/?t=x") === "unknown", "with a query too");
  ok(routeOf("/events?t=x&since=0") === "events", "/events is the feed");
  ok(routeOf("/stop?t=x") === "stop", "/stop is the stop button");
  ok(routeOf("/../../etc/passwd") === "unknown", "a traversal attempt is not a route");
  ok(routeOf("/admin") === "unknown", "and neither is anything invented");
  ok(routeOf("/login") === "login", "/login is the password exchange");
  ok(routeOf("/command?t=x") === "command", "/command carries a phone command");
  ok(routeOf("/confirm") === "confirm", "/confirm carries an approval");
  ok(routeOf("/pending") === "confirm-poll", "/pending is the confirmation to show");
  ok(routeOf("/rtc/offer") === "rtc-offer", "/rtc/offer is the WebRTC offer");
  ok(routeOf("/rtc/answer") === "rtc-answer", "/rtc/answer returns the Mac's answer");
  ok(routeOf("/rtc/ice") === "rtc-ice-phone", "/rtc/ice takes the phone's candidates");
}
console.log("  lockout");
{
  resetAttempts();
  const ip = "192.168.1.55";
  ok(!isLockedOut(ip), "an unknown address starts unlocked");
  for (let i = 0; i < MAX_BAD_ATTEMPTS; i++) noteBadAttempt(ip);
  ok(isLockedOut(ip), `after ${MAX_BAD_ATTEMPTS} wrong tokens the address is locked out`);
  ok(!isLockedOut("192.168.1.56"), "which does not affect anyone else");
  resetAttempts();
  ok(!isLockedOut(ip), "and restarting the remote clears it");
}

console.log("  the feed does not grow forever");
{
  // Not running: nothing should be recorded at all.
  for (let i = 0; i < 5; i++) record(`line ${i}`);
  ok(recentItems().items.length === 0, "nothing is recorded while the remote is off");
}

console.log("  app files and controls");
{
  ok(routeOf("/app/remote.css") === "unknown", "no app files are served from the Mac");
  ok(routeOf("/app/../remote.ts") === "unknown", "nor anything under /app");
  ok(routeOf("/status") === "status" && routeOf("/action") === "action" && routeOf("/keys") === "keys", "status, action and keys are routes");

  ok(parseRemoteAction({ type: "switch-model", provider: "claude" })?.type === "switch-model", "switching the brain is allowed");
  ok(parseRemoteAction({ type: "set-voice", key: "wakeWord", value: false })?.type === "set-voice", "the three voice switches are allowed");
  ok(parseRemoteAction({ type: "stop-mission", missionId: "supervised.abc-123" })?.type === "stop-mission", "stopping a task is allowed");
  for (const type of ["shutdown", "save-api-keys", "api-keys", "save-settings", "spawn-agent", "save-agent", "openrouter-sign-out"]) {
    ok(parseRemoteAction({ type }) === null, `"${type}" is refused from the phone`);
  }
  ok(parseRemoteAction({ type: "set-voice", key: "sttProvider", value: true }) === null, "a voice setting outside the three is refused");
  ok(parseRemoteAction({ type: "set-voice", key: "wakeWord", value: "yes" }) === null, "and a non-boolean value");
  ok(parseRemoteAction({ type: "switch-model", provider: "../x" }) === null, "and a malformed provider");
  ok(!("cmd+q" in REMOTE_KEYS) && !("cmd+w" in REMOTE_KEYS), "no key chord can quit or close the Mac's apps");

  ok(routeOf("/frame") === "frame", "/frame is a screen still");
  ok(routeOf("/ping") === "ping", "/ping is a cheap check behind the link token");
  ok(turnContract({ channel: "telegram", modality: "text" }) === CHAT_TURN_CONTRACT, "a Telegram turn is asked to chat like a person");
  ok(turnContract({ channel: "telegram", modality: "voice" }) === CHAT_TURN_CONTRACT, "even if it came in as a voice note");
  ok(turnContract({ channel: "phone", modality: "voice" }) === VOICE_TURN_CONTRACT, "speech from the phone keeps the short spoken style");
  ok(turnContract({ modality: "text" }) === null, "and a typed turn at the Mac gets neither");

  const b = parseBattery(" -InternalBattery-0 (id=22675555)\t81%; discharging; 9:17 remaining present: true");
  ok(b?.percent === 81 && !b.charging && b.remaining === "9:17", "the battery line is read");
  ok(parseBattery("Now drawing from 'AC Power'") === null, "and a Mac without one reads as none");
  ok(parseBattery("-InternalBattery-0\t100%; charged; 0:00 remaining")?.charging === true, "charged counts as on power");
}

console.log("  the phone app's relay connection");
{
  // A stand-in for Echo's own loopback listener.
  const seen: Array<{ method: string; url: string; ip: string; cookie: string; body: string }> = [];
  const local = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, ip: String(req.headers[CLIENT_IP_HEADER] ?? ""), cookie: String(req.headers.cookie ?? ""), body });
      res.writeHead(201, { "content-type": "application/json", "set-cookie": "js=abc", "x-private": "no" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", () => r()));
  const localBase = `http://127.0.0.1:${(local.address() as any).port}`;
  const reply = await replayLocally({ id: "j1", method: "POST", path: "/login?t=abc", ip: "203.0.113.5",
    headers: { "content-type": "application/json", cookie: "js=old" }, body: Buffer.from('{"password":"x"}').toString("base64") }, localBase);
  ok(reply.status === 201 && Buffer.from(reply.body, "base64").toString() === '{"ok":true}', "a collected request is replayed locally and its answer carried back");
  ok(seen[0].url === "/login?t=abc" && seen[0].body === '{"password":"x"}' && seen[0].cookie === "js=old", "path, query, body and session cookie arrive unchanged");
  ok(seen[0].ip === "203.0.113.5", "with the phone's own address, for the lockout");
  ok(reply.headers["set-cookie"] === "js=abc" && !("x-private" in reply.headers), "only content-type, set-cookie and cache-control go back");
  const bad = await replayLocally({ id: "j2", method: "GET", path: "//evil.example.com/x", ip: "", headers: {}, body: "" }, localBase);
  ok(bad.status === 400 && seen.length === 1, "a path that could leave this Mac is refused before any request");
  const other = await replayLocally({ id: "j3", method: "DELETE", path: "/stop", ip: "", headers: {}, body: "" }, localBase);
  ok(other.status === 201 && seen[1].method === "GET", "only GET and POST are ever replayed");

  const saved = process.env.ECHO_RELAY_SECRET;
  process.env.ECHO_RELAY_SECRET = "x".repeat(48);
  ok(relayFromConfig("https://echo-remote.onrender.com")?.url === "https://echo-remote.onrender.com", "an https relay with a long secret is used");
  ok(relayFromConfig("http://echo-remote.onrender.com") === undefined, "plain http is refused (except on this Mac, for testing)");
  ok(relayFromConfig("") === undefined, "no address, no relay");
  process.env.ECHO_RELAY_SECRET = "short";
  ok(relayFromConfig("https://echo-remote.onrender.com") === undefined, "a short secret is refused");
  if (saved === undefined) delete process.env.ECHO_RELAY_SECRET; else process.env.ECHO_RELAY_SECRET = saved;

  // The agent against a minimal stand-in relay: one job in, one reply out.
  const SECRET = "y".repeat(48);
  let replied: any = null, polls = 0;
  const relay = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(404); return res.end(); }
    if (req.url === "/agent/poll") {
      polls++;
      if (polls === 1) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ id: "r1", method: "GET", path: "/status?t=zz", ip: "198.51.100.1", headers: {}, body: "" })); }
      return setTimeout(() => { res.writeHead(204); res.end(); }, 100);
    }
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { replied = JSON.parse(body); res.writeHead(204); res.end(); });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  const states: boolean[] = [];
  const agent = new RelayAgent(`http://127.0.0.1:${(relay.address() as any).port}`, SECRET, localBase, (on) => states.push(on));
  agent.start();
  for (let i = 0; i < 40 && !replied; i++) await new Promise((r) => setTimeout(r, 50));
  agent.stop();
  ok(replied?.id === "r1" && replied.status === 201, "the agent collects a phone request and answers it");
  ok(states[0] === true && states.at(-1) === false, "and reports connecting and disconnecting");
  local.closeAllConnections(); local.close(); relay.closeAllConnections(); relay.close();
}

console.log("  refuses to open with no password set");
{
  // JARVIS_REMOTE_DIR points at a throwaway dir (set by the npm script), which
  // starts empty — so this proves the refusal before a password exists.
  const noRelay = await startRemote({ port: 7798, ttlMs: 60_000 });
  ok(!noRelay.ok && /phone app isn't set up/.test(noRelay.message), "it won't open without the phone app's relay: nothing listens on the network");
  const noPass = await startRemote({ port: 7798, ttlMs: 60_000, relay: { url: "http://127.0.0.1:9", secret: "s".repeat(48) } });
  ok(!noPass.ok && /password/.test(noPass.message),
     "full control will not open without a password");
  ok(!isRunning(), "and nothing is left running");
}

console.log("  a real server, on the loopback");
{
  {
    setPassword("test-remote-pass"); // into the throwaway JARVIS_REMOTE_DIR
    const RELAY = { url: "http://127.0.0.1:9", secret: "s".repeat(48) };
    let recognizer: (path: string) => Promise<string> = async () => "test voice";
    const voiceFiles: string[] = [];
    const started = await startRemote({ port: 7799, ttlMs: 60_000, relay: RELAY, transcribeVoice: async path => { voiceFiles.push(path); return recognizer(path); } });
    ok(started.ok, `it starts (${started.message.split("\n")[0].slice(0, 50)})`);
    ok(isRunning(), "and reports as running");
    ok(started.url?.startsWith("http://127.0.0.1:9/?t=") === true, "the link is the phone app's, never a network address of this Mac");

    const tok = new URL(started.url!).searchParams.get("t")!;
    const base = `http://127.0.0.1:7799`;

    // ---- the link token gates existence ----
    const noToken = await fetch(`${base}/ping`);
    ok(noToken.status === 404, `no token gets 404, not 401 (${noToken.status})`);
    const badToken = await fetch(`${base}/ping?t=${"0".repeat(32)}`);
    ok(badToken.status === 404, "a wrong token gets 404 too — nothing confirms a server is here");
    const good = await fetch(`${base}/ping?t=${tok}`);
    ok(good.status === 204, "the right token is answered");
    const page = await fetch(`${base}/?t=${tok}`);
    ok(page.status === 404, "and there is no page here: the phone app is on the relay");

    // ---- the password gates control ----
    const controlNoSession = await fetch(`${base}/events?t=${tok}&since=0`);
    ok(controlNoSession.status === 401, "control routes need a session, not just the link");

    const wrongPw = await fetch(`${base}/login?t=${tok}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "not-the-password" }),
    });
    ok(wrongPw.status === 401, "the wrong password is refused");

    const login = await fetch(`${base}/login?t=${tok}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-remote-pass" }),
    });
    ok(login.status === 200, "the right password signs in");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    ok(/^js=/.test(cookie), "and hands back a session cookie");
    const auth = { cookie };

    // Voice acknowledges the actual transcript and delivery, never just the upload.
    const wav = Buffer.alloc(32044);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    const voiceBase = base;
    const voiceLogin = await fetch(`${voiceBase}/login?t=${tok}`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({password: "test-remote-pass"})});
    const voiceAuth = {cookie: voiceLogin.headers.get("set-cookie")!.split(";")[0]};
    const voicePost = (body = wav, path = "/voice", signal?: AbortSignal) => fetch(`${voiceBase}${path}?t=${tok}`, { method: "POST", headers: voiceAuth, body, signal });
    ok((await fetch(`${base}/voice?t=${tok}`, { method: "POST", body: wav })).status === 401, "voice uploads require the password session");
    ok((await voicePost()).status === 503, "voice refuses success while the brain handler is unavailable");
    const delivered: Array<{text: string; via: string}> = [];
    setCommandHandler((text, via) => delivered.push({ text, via }));
    let finishSTT!: (value: string) => void, enteredSTT!: () => void;
    let entered = new Promise<void>(r => { enteredSTT = r; });
    recognizer = async path => {
      ok(readFileSync(path).equals(wav), "the complete WAV reaches speech recognition unchanged");
      enteredSTT(); return new Promise<string>(r => { finishSTT = r; });
    };
    let acknowledged = false;
    const streamed = new Promise<{status: number; body: any}>((resolve, reject) => {
      const req = http.request(`${voiceBase}/voice?t=${tok}`, { method: "POST", headers: voiceAuth }, res => {
        acknowledged = true; let body = "";
        res.on("data", c => { body += c; });
        res.on("end", () => resolve({status: res.statusCode!, body: JSON.parse(body)}));
      });
      req.on("error", reject); req.write(wav.subarray(0, 44));
      setTimeout(() => {
        ok(!acknowledged && delivered.length === 0, "a partial upload cannot be acknowledged or dispatched");
        req.end(wav.subarray(44));
      }, 80);
    });
    await entered;
    ok(!acknowledged && delivered.length === 0, "a complete upload still waits for transcription");
    finishSTT("  what is two plus two?  ");
    const spoken = await streamed;
    ok(spoken.status === 200 && spoken.body.text === "what is two plus two?", "success contains the recognized words");
    ok(delivered.length === 1 && delivered[0].text === spoken.body.text && delivered[0].via === "voice", "the brain receives exactly one voice turn");
    ok(voiceFiles.every(path => !existsSync(path)), "temporary recordings are removed after success");
    const count = delivered.length;
    recognizer = async () => "   ";
    const empty = await voicePost();
    ok(empty.status === 422 && (await empty.json() as any).code === "voice_unheard" && delivered.length === count, "unheard speech reports an error without dispatch");
    recognizer = async () => { throw new Error("private provider key and path"); };
    const failedVoice = await voicePost(), failure = await failedVoice.json() as any;
    ok(failedVoice.status === 503 && failure.code === "voice_transcription_failed" && !failure.error.includes("private provider"), "recognition failures are reported without leaking provider details");
    const calls = voiceFiles.length;
    ok((await voicePost(Buffer.alloc(45))).status === 400, "a corrupt WAV is refused before recognition");
    ok((await voicePost(wav.subarray(0, 100))).status === 400, "an incomplete WAV is refused before recognition");
    ok((await voicePost(Buffer.alloc(MAX_REMOTE_VOICE_BYTES + 1))).status === 413 && voiceFiles.length === calls, "oversized uploads are bounded and never transcribed");
    recognizer = async () => "chat voice words";
    setChatHandler((text, via) => delivered.push({text, via}));
    const chatVoice = await voicePost(wav, "/chat/voice"), chatResult = await chatVoice.json() as any;
    ok(chatVoice.status === 200 && chatResult.message.kind === "voice" && chatResult.message.text === "chat voice words", "chat voice keeps its recognized message and voice kind");
    setChatHandler(() => { throw new Error("dispatch failed"); });
    ok((await voicePost(wav, "/chat/voice")).status === 503, "a rejected chat dispatch does not acknowledge success");
    const chatState = await fetch(`${base}/chat?t=${tok}`, {headers: auth}).then(r => r.json()) as any;
    ok(!chatState.typing, "failed chat dispatch clears the typing indicator");
    entered = new Promise<void>(r => { enteredSTT = r; });
    recognizer = async () => { enteredSTT(); return new Promise<string>(r => { finishSTT = r; }); };
    const beforeCancel = delivered.length, abort = new AbortController();
    const cancelled = voicePost(wav, "/voice", abort.signal).catch(() => null);
    await entered; abort.abort(); await cancelled;
    await new Promise(r => setTimeout(r, 80)); finishSTT("cancelled voice");
    await new Promise(r => setTimeout(r, 80));
    ok(delivered.length === beforeCancel, "a cancelled request cannot dispatch a late voice command");
    ok(voiceFiles.every(path => !existsSync(path)), "temporary recordings are removed after failures and cancellation too");
    recognizer = async () => "through the relay";
    const relayLogin = await replayLocally({id: "voice-login", method: "POST", path: `/login?t=${tok}`, ip: "198.51.100.1", headers: {"content-type": "application/json"}, body: Buffer.from(JSON.stringify({password: "test-remote-pass"})).toString("base64")}, voiceBase);
    const relayAuth = {cookie: relayLogin.headers["set-cookie"].split(";")[0]};
    const relayVoice = await replayLocally({id: "voice-relay", method: "POST", path: `/voice?t=${tok}`, ip: "198.51.100.2", headers: relayAuth, body: wav.toString("base64")}, voiceBase);
    ok(relayVoice.status === 200 && JSON.parse(Buffer.from(relayVoice.body, "base64").toString()).text === "through the relay" && delivered.at(-1)?.via === "voice", "the relay returns the transcript after delivering the voice turn");

    // ---- with a session, control works ----
    record("did a thing", "go");
    const ev = await fetch(`${base}/events?t=${tok}&since=0`, { headers: auth }).then((r) => r.json() as any);
    ok(ev.items.some((i: any) => i.line === "did a thing"), "the feed carries recorded events once signed in");
    // Positions are absolute: when old items fall off the ring buffer, the phone
    // never gets one it has already seen (it read old replies aloud again).
    const seenAt = (recentItems(0) as any).nextIndex;
    for (let i = 0; i < 250; i++) record(`filler ${i}`, "progress");
    const after = recentItems(seenAt);
    ok(after.items.length === 200 && after.items[0].line === "filler 50", "after the buffer wraps, only what's new and still kept comes back");
    ok(after.items.every((i) => i.line !== "did a thing"), "an item the phone already saw never comes back");
    const end = after.nextIndex;
    record("one more", "reply");
    const next = recentItems(end);
    ok(next.items.length === 1 && next.items[0].line === "one more" && next.nextIndex === end + 1, "and the next poll gets exactly the new item");
    ok(recentItems(end + 999).items.length === MAX_ITEMS, "a position past the end (Echo restarted) starts over");

    const rtc = await fetch(`${base}/rtc/offer?t=${tok}`, {
      method: "POST", headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ sdp: { type: "offer", sdp: "v=0 test" } }),
    }).then((r) => r.json() as any);
    ok(rtc.ok === true, "the phone can post a WebRTC offer");

    const traversal = await fetch(`${base}/../../etc/passwd?t=${tok}`, { headers: auth });
    ok(traversal.status === 404, "a path traversal with a valid token and session still gets nothing");

    const getStop = await fetch(`${base}/stop?t=${tok}`, { headers: auth });
    ok(getStop.status === 404, "stop cannot be triggered by a GET");

    // ---- the controls ----

    const statusNoSession = await fetch(`${base}/status?t=${tok}`);
    ok(statusNoSession.status === 401, "status needs the password, not just the link");
    const status = await fetch(`${base}/status?t=${tok}`, { headers: auth }).then((r) => r.json() as any);
    ok(typeof status.vitals?.uptimeSec === "number" && status.vitals.cores > 0, "status carries the Mac's vitals");
    ok(status.remote?.expiresAt > Date.now(), "and when the link closes");

    const post = (path: string, payload: unknown) => fetch(`${base}${path}?t=${tok}`, {
      method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(payload),
    });
    ok((await post("/action", { type: "shutdown" })).status === 400, "quitting Echo is refused over the network");
    ok((await post("/action", { type: "save-api-keys", apiKeys: { X: "y" } })).status === 400, "and saving API keys");
    ok((await post("/keys", { key: "cmd+q" })).status === 400, "a key chord outside the list is refused");
    ok((await post("/keys", { text: "x".repeat(501) })).status === 400, "and over-long typing");
    ok((await post("/mouse", { action: "teleport" })).status === 400, "and an unknown mouse action");
    const getKeys = await fetch(`${base}/keys?t=${tok}`, { headers: auth });
    ok(getKeys.status === 404, "typing cannot be triggered by a GET");

    let stopped = false;
    await stopRemote();
    await startRemote({ port: 7799, ttlMs: 60_000, relay: RELAY, onStop: () => { stopped = true; } });
    const tokNew = /t=([0-9a-f]{32})/.exec(remoteStatus())?.[1] ?? "";
    ok(tokNew === tok, "restarting keeps the SAME token, so a saved link keeps working");

    // The old session cookie must still NOT survive a restart — the link is
    // permanent, but each session dies on restart and needs the password again.
    // A reset socket (from the server that closed) counts the same as a 401.
    const oldSession = await fetch(`${base}/events?t=${tokNew}&since=0`, { headers: auth })
      .then((r) => r.status as number | "reset")
      .catch(() => "reset" as const);
    ok(oldSession === 401 || oldSession === "reset",
       `the session still dies on restart, even though the link lives (${oldSession})`);

    // The saved link (its token) still works after a restart.
    const savedLink = await fetch(`${base}/ping?t=${tok}`).then((r) => r.status).catch(() => "reset" as const);
    ok(savedLink === 204, `the saved link still works after a restart (${savedLink})`);

    // Sign in again to drive stop.
    const login2 = await fetch(`${base}/login?t=${tokNew}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-remote-pass" }),
    });
    const cookie2 = (login2.headers.get("set-cookie") ?? "").split(";")[0];
    await fetch(`${base}/stop?t=${tokNew}`, { method: "POST", headers: { cookie: cookie2 } });
    ok(stopped, "a POST to stop, signed in, reaches the stop handler");

    const ping = await fetch(`${base}/ping?t=${tokNew}`);
    ok(ping.status === 204, "the watchdog's ping answers with the link token");
    const pingNoToken = await fetch(`${base}/ping`);
    ok(pingNoToken.status === 404, "and is a 404 without it, like everything else");
    const frameNoSession = await fetch(`${base}/frame?t=${tokNew}`);
    ok(frameNoSession.status === 401, "a screen still needs the password, not just the link");

    const msg = await stopRemote();
    ok(/won't work again/.test(msg), "closing says the link is dead");
    ok(!isRunning(), "and it is no longer running");

    let unreachable = false;
    await fetch(`${base}/ping?t=${tokNew}`).catch(() => { unreachable = true; });
    ok(unreachable, "the port is actually closed");
  }
}

console.log(`\n${pass}/${pass + fail} remote checks passed\n`);
process.exit(fail ? 1 : 0);
