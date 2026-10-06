/**
 * Echo's side of the phone app's relay (the echo-remote server on Render).
 *
 * The phone app lives at one permanent https address. This keeps a few
 * long-lived requests open to it — "anything for me?" — from the Mac, so no
 * port, tunnel or router change is needed and it works from any network. Each
 * phone request it collects is replayed against the remote's own loopback
 * listener, exactly as if the phone had asked it directly: the link token,
 * password session, lockouts, approvals and the action allowlist all apply
 * unchanged. The answer goes back the same way.
 *
 * The relay passes the phone's own address along; the loopback listener trusts
 * it (for the lockout) only on requests arriving through this path.
 */

export const CLIENT_IP_HEADER = "x-echo-client-ip";
/** Parallel polls, so a slow request (a voice note) never holds up the rest. */
export const POLLERS = 4;

export interface RelayJob {
  id: string;
  method: string;
  path: string;
  ip: string;
  headers: { "content-type"?: string; cookie?: string };
  body: string;
}

export interface RelayReply {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Replay one collected request against the local listener and package the answer. */
export async function replayLocally(job: RelayJob, localBase: string): Promise<RelayReply> {
  if (!/^\/[^\s]*$/.test(job.path) || job.path.startsWith("//")) {
    return { id: job.id, status: 400, headers: { "content-type": "text/plain" }, body: Buffer.from("Bad path").toString("base64") };
  }
  const method = job.method === "POST" ? "POST" : "GET";
  const headers: Record<string, string> = { [CLIENT_IP_HEADER]: String(job.ip || "?").slice(0, 64) };
  if (job.headers?.["content-type"]) headers["content-type"] = String(job.headers["content-type"]);
  if (job.headers?.cookie) headers.cookie = String(job.headers.cookie);
  try {
    const res = await fetch(localBase + job.path, {
      method, headers,
      body: method === "POST" && job.body ? Buffer.from(job.body, "base64") : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(85_000),
    });
    const out: Record<string, string> = {};
    for (const name of ["content-type", "set-cookie", "cache-control"]) {
      const v = res.headers.get(name);
      if (v) out[name] = v;
    }
    return { id: job.id, status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()).toString("base64") };
  } catch {
    return { id: job.id, status: 502, headers: { "content-type": "application/json" }, body: Buffer.from('{"error":"Echo could not answer."}').toString("base64") };
  }
}

export class RelayAgent {
  private running = false;
  private connected = false;
  private failures = 0;
  private aborts = new Set<AbortController>();

  constructor(
    private readonly relayUrl: string,
    private readonly secret: string,
    private readonly localBase: string,
    /** Told when the relay starts or stops answering. */
    private readonly onConnected: (connected: boolean) => void,
    private readonly log: (line: string) => void = () => {},
    /**
     * The cloud-pass generation (cloudpass.ts): sent on every poll so the relay
     * refuses cancelled passes, and raised when the relay knows a higher one.
     */
    private readonly passGen?: { get(): number; adopt(n: number): void },
    /** Told how many hand-off jobs are waiting, whenever the relay says (on each poll). */
    private readonly onHandoffs?: (waiting: number) => void,
  ) {}

  get base(): string {
    return this.relayUrl.replace(/\/+$/, "");
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log(`connecting to the phone app at ${this.base}`);
    for (let i = 0; i < POLLERS; i++) void this.loop(i);
  }

  stop(): void {
    this.running = false;
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
    this.setConnected(false);
  }

  private setConnected(on: boolean): void {
    if (on === this.connected) return;
    this.connected = on;
    this.log(on ? "connected to the phone app" : "disconnected from the phone app");
    try { this.onConnected(on); } catch { /* a listener must not stop the agent */ }
  }

  private async loop(n: number): Promise<void> {
    // Stagger the pollers so they do not all hit a cold relay at once.
    await new Promise((r) => setTimeout(r, n * 250));
    while (this.running) {
      const abort = new AbortController();
      this.aborts.add(abort);
      try {
        const res = await fetch(`${this.base}/agent/poll`, {
          headers: { authorization: `Bearer ${this.secret}`, ...(this.passGen ? { "x-echo-pass-gen": String(this.passGen.get()) } : {}) },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(40_000)]),
        });
        if (res.status === 404 || res.status === 401) {
          // Wrong secret, or the wrong address: retrying fast will not fix it.
          this.setConnected(false);
          if (n === 0) this.log(`the phone app refused Echo (${res.status}) — check the relay address and ECHO_RELAY_SECRET`);
          await this.backoff(true);
          continue;
        }
        const waiting = Number(res.headers.get("x-relay-handoffs"));
        if (this.onHandoffs && Number.isInteger(waiting) && waiting > 0) { try { this.onHandoffs(waiting); } catch { /* never stop polling */ } }
        const relayGen = Number(res.headers.get("x-relay-pass-gen"));
        if (this.passGen && Number.isInteger(relayGen)) this.passGen.adopt(relayGen);
        if (res.status === 204) { this.failures = 0; this.setConnected(true); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.failures = 0;
        this.setConnected(true);
        const job = (await res.json()) as RelayJob;
        const reply = await replayLocally(job, this.localBase);
        await fetch(`${this.base}/agent/reply`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
          body: JSON.stringify(reply),
          signal: AbortSignal.timeout(30_000),
        }).catch(() => {});
      } catch {
        if (!this.running) break;
        // Render's free tier sleeps; the first request wakes it, which can
        // take most of a minute. Back off gently rather than hammering it.
        if (++this.failures >= 2) this.setConnected(false);
        await this.backoff(false);
      } finally {
        this.aborts.delete(abort);
      }
    }
  }

  /** Read something from the relay itself, e.g. waiting hand-off jobs. */
  async get(path: string): Promise<any | null> {
    try {
      const res = await fetch(`${this.base}${path}`, { headers: { authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(20_000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  /** Send something to the relay itself (not a reply to the phone), e.g. the briefing digest. */
  async post(path: string, body: unknown): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private backoff(slow: boolean): Promise<void> {
    const ms = slow ? 60_000 : Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
    return new Promise((r) => setTimeout(r, ms));
  }
}

/** The relay to connect to, from config and keys, or undefined when it is not set up. */
export function relayFromConfig(relayUrl?: string): { url: string; secret: string } | undefined {
  const url = String(relayUrl ?? "").trim();
  if (!/^https:\/\/[^\s/]+/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)) return undefined;
  const secret = process.env.ECHO_RELAY_SECRET?.trim();
  if (!secret || secret.length < 32) {
    console.error("[jarvis] remote.relayUrl is set but ECHO_RELAY_SECRET is missing or too short; the phone app can't connect.");
    return undefined;
  }
  return { url, secret };
}
