import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "../memory/paths.js";

/**
 * The phone app's chat with Echo — a conversation, like the Telegram one.
 *
 * Kept on this Mac only (the relay passes messages through and stores
 * nothing), so the history survives a restart of Echo or a new phone. Small by
 * design: the last MAX_MESSAGES, owner-readable only. Echo's own memory of the
 * conversation lives where every other turn's does; this is just what the chat
 * screen shows.
 */
export interface ChatMessage {
  id: number;
  at: number;
  from: "you" | "echo";
  text: string;
  kind: "text" | "voice";
}

export const MAX_MESSAGES = 300;
/** "typing…" clears on its own if a turn never answers. */
export const TYPING_MS = 120_000;

export class ChatLog {
  private messages: ChatMessage[] = [];
  private nextId = 1;
  private typingUntil = 0;

  constructor(private readonly file: string | null = join(dataRoot(), "remote-chat.json")) {
    if (!file || !existsSync(file)) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(saved?.messages)) {
        this.messages = saved.messages.filter((m: any) => m && typeof m.text === "string" && (m.from === "you" || m.from === "echo")).slice(-MAX_MESSAGES);
        this.nextId = Math.max(0, ...this.messages.map((m) => m.id)) + 1;
      }
    } catch { /* a damaged file starts a fresh conversation rather than breaking the remote */ }
  }

  add(from: ChatMessage["from"], text: string, kind: ChatMessage["kind"] = "text", at = Date.now()): ChatMessage {
    const message: ChatMessage = { id: this.nextId++, at, from, text: text.slice(0, 8000), kind };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    if (from === "echo") this.typingUntil = 0;
    this.save();
    return message;
  }

  /** Messages after `afterId` (all of them for 0), oldest first. */
  since(afterId = 0): ChatMessage[] {
    return this.messages.filter((m) => m.id > afterId);
  }

  setTyping(on: boolean, now = Date.now()): void {
    this.typingUntil = on ? now + TYPING_MS : 0;
  }

  typing(now = Date.now()): boolean {
    return now < this.typingUntil;
  }

  clear(): void {
    this.messages = [];
    this.typingUntil = 0;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    try { writeFileSync(this.file, JSON.stringify({ messages: this.messages }), { mode: 0o600 }); } catch { /* the screen still works from memory */ }
  }
}
