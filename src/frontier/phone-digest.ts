import { upcomingEvents } from "../tools/system.js";
import { osascript } from "../tools/shell.js";
import { loadMcpConfig, connectMcpServers } from "../brain/mcp.js";

/**
 * What the Mac leaves with the phone app for the morning briefing, so the
 * briefing has your day even when the Mac has been off all night.
 *
 * Sent to the relay about once an hour while Echo is connected; the relay
 * keeps it encrypted. Small on purpose: titles and times, senders and
 * subjects — never message bodies.
 *
 *   calendar   the next 36 hours, read from Calendar. Calendar's scripting
 *              launches the app, so it is read every hour only while Calendar
 *              is already open, and otherwise once a day, quitting it again.
 *   email      sender and subject of a few unread inbox messages, through the
 *              Gmail connection (Composio) — a direct read, no AI call. Every
 *              few hours, to keep Composio usage small.
 *   missions   what finished in the last day.
 */

export interface PhoneDigest {
  at: number;
  calendar: { title: string; start: string }[] | null;
  calendarAt: number | null;
  email: { from: string; subject: string }[] | null;
  emailAt: number | null;
  missions: { goal: string; status: string; at: number }[];
}

export const DIGEST_EVERY_MS = 60 * 60_000;
const FULL_CALENDAR_MS = 20 * 3600_000;
const EMAIL_EVERY_MS = 3 * 3600_000;

let calendar: { at: number; items: { title: string; start: string }[] } | null = null;
let fullCalendarAt = 0;
let email: { at: number; items: { from: string; subject: string }[] } | null = null;

async function readCalendar(now: number): Promise<void> {
  let running = false;
  try { running = (await osascript('return application "Calendar" is running')).trim() === "true"; } catch { /* treat as closed */ }
  const full = !running && now - fullCalendarAt > FULL_CALENDAR_MS;
  if (!running && !full) return; // keep the last reading
  const events = await upcomingEvents(36, { onlyIfRunning: !full });
  if (full) {
    fullCalendarAt = now;
    try { await osascript('tell application "Calendar" to quit'); } catch { /* already closed */ }
  }
  calendar = { at: now, items: events.slice(0, 40).map((e) => ({ title: e.title.slice(0, 120), start: e.start })) };
}

/** Sender/subject pairs anywhere in a Gmail tool's JSON, newest first as given. */
export function emailsFrom(payloads: unknown[]): { from: string; subject: string }[] {
  const out: { from: string; subject: string }[] = [];
  const seen = new Set<string>();
  const walk = (v: any, depth: number) => {
    if (!v || depth > 8 || out.length >= 8) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== "object") return;
    const subject = typeof v.subject === "string" ? v.subject : null;
    const from = [v.sender, v.from, v.from_email, v.fromAddress].find((x) => typeof x === "string") as string | undefined;
    if (subject !== null && from) {
      const name = from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "").trim() || from;
      const key = `${name}|${subject}`;
      if (!seen.has(key)) { seen.add(key); out.push({ from: name.slice(0, 80), subject: (subject || "(no subject)").slice(0, 160) }); }
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  for (const p of payloads) walk(p, 0);
  return out.slice(0, 5);
}

async function readEmail(now: number): Promise<void> {
  if (email && now - email.at < EMAIL_EVERY_MS) return;
  const spec = loadMcpConfig().composio;
  if (!spec) return;
  const conn = await connectMcpServers({ config: { composio: spec }, timeout: 15_000 });
  try {
    const tool = conn.tools.find((t) => t.originalName === "GMAIL_FETCH_EMAILS");
    if (!tool) return;
    const props = tool.inputSchema?.properties ?? {};
    const args: Record<string, unknown> = {};
    if ("query" in props) args.query = "is:unread in:inbox category:primary newer_than:2d";
    if ("max_results" in props) args.max_results = 8;
    if ("include_payload" in props) args.include_payload = false;
    if ("verbose" in props) args.verbose = false;
    const result: any = await tool.call(args, { signal: AbortSignal.timeout(25_000) });
    if (result?.status === "failed") return;
    const content = Array.isArray(result?.data?.content) ? result.data.content : [];
    const payloads = [result?.data?.structuredContent, ...content.filter((b: any) => b?.type === "text").map((b: any) => { try { return JSON.parse(b.text); } catch { return null; } })];
    email = { at: now, items: emailsFrom(payloads) };
  } finally {
    await conn.close();
  }
}

/** Missions that finished (or failed) in the last day, from the status the phone already sees. */
export function recentMissions(status: any, now = Date.now()): PhoneDigest["missions"] {
  const list = Array.isArray(status?.missions) ? status.missions : [];
  return list
    .filter((m: any) => m && m.status !== "running" && Number(m.updatedAt) > now - 86400_000)
    .slice(0, 10)
    .map((m: any) => ({ goal: String(m.goal ?? "").slice(0, 160), status: String(m.status ?? ""), at: Number(m.updatedAt) || now }));
}

export async function collectDigest(status: () => any, now = Date.now()): Promise<PhoneDigest> {
  await Promise.all([
    readCalendar(now).catch(() => {}),
    readEmail(now).catch(() => {}),
  ]);
  let missions: PhoneDigest["missions"] = [];
  try { missions = recentMissions(await status(), now); } catch { /* none */ }
  return {
    at: now,
    calendar: calendar?.items ?? null, calendarAt: calendar?.at ?? null,
    email: email?.items ?? null, emailAt: email?.at ?? null,
    missions,
  };
}
