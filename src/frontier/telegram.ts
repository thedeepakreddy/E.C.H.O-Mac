import { currentRemoteUrl, publicLinkState } from "./remote.js";
import type { JarvisConfig } from "../config.js";

type CommandHandler = (text: string) => void;

interface TelegramMessage {
  message_id: number;
  chat?: { id: number | string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * A deliberately small Telegram Bot API client. Long polling needs no public
 * webhook or inbound port, and an explicit chat allow-list keeps a leaked bot
 * username from becoming a remote-control back door.
 */
export class TelegramBridge {
  private running = false;
  private offset = 0;
  private activeChatId: string | null = null;

  constructor(
    private readonly token: string,
    private readonly allowedChatIds: Set<string>,
    private readonly onCommand: CommandHandler,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    this.activeChatId = null;
    this.stopTyping();
  }

  /** Stop routing later, unrelated spoken replies to the last Telegram chat. */
  finishTurn(): void {
    this.activeChatId = null;
    this.stopTyping();
  }

  /**
   * "typing…" in the chat while Echo works, as a person's phone would show.
   * Telegram clears it after about five seconds, so it is renewed until the
   * reply goes out — and never for more than two minutes.
   */
  private typingTimer: NodeJS.Timeout | null = null;
  private startTyping(chatId: string): void {
    this.stopTyping();
    const started = Date.now();
    const tick = () => {
      if (Date.now() - started > 120_000) return this.stopTyping();
      void this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    };
    tick();
    this.typingTimer = setInterval(tick, 4500);
  }
  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  /** Deliver Echo's response to the Telegram chat that issued the active turn. */
  async reply(text: string): Promise<void> {
    const chatId = this.activeChatId;
    if (!chatId || !text.trim()) return;
    this.stopTyping();
    // Telegram limits a text message to 4096 characters.
    for (let at = 0; at < text.length; at += 4096) {
      await this.call("sendMessage", { chat_id: chatId, text: text.slice(at, at + 4096) });
    }
  }

  /**
   * Tell every allowed chat something Echo started on its own — the phone
   * remote's new public link. Only the configured chats, never whoever wrote
   * last, so a message from an unknown chat cannot redirect it.
   */
  async notify(text: string): Promise<void> {
    if (!text.trim()) return;
    for (const chatId of this.allowedChatIds) {
      await this.call("sendMessage", { chat_id: chatId, text: text.slice(0, 4096) });
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.call<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message"],
        });
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          this.accept(update.message);
        }
      } catch (error) {
        // Do not make a transient network failure a tight retry loop.
        console.error("[telegram] polling failed:", error instanceof Error ? error.message : error);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }

  private accept(message: TelegramMessage | undefined): void {
    const chatId = message?.chat?.id == null ? null : String(message.chat.id);
    const text = message?.text?.trim();
    if (!chatId || !text || !this.allowedChatIds.has(chatId)) return;
    if (text === "/start") {
      this.activeChatId = chatId;
      void this.reply("Echo is connected. Send me a command.");
      return;
    }
    // The phone remote's link, answered here rather than by the brain: it is
    // instant, works while Echo is busy, and cannot be paraphrased away.
    if (/^\/?(link|remote)$/i.test(text)) {
      this.activeChatId = chatId;
      // With the any-network link on, never hand out the Wi-Fi-only link: it
      // looks like it should work and fails on mobile data.
      const pub = publicLinkState();
      const url = pub.enabled ? pub.url : currentRemoteUrl();
      void this.reply(url
        ? `Here's your Echo remote — works on Wi-Fi and mobile data:\n${url}`
        : pub.enabled
          ? "The any-network link is reconnecting right now. I'll send it here the moment it's back — usually within a minute."
          : "The phone remote is off. Send \"open the phone remote\" to start it.");
      return;
    }
    this.activeChatId = chatId;
    this.startTyping(chatId);
    try {
      this.onCommand(text);
    } catch (error) {
      console.error("[telegram] command handler failed:", error);
    }
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { ok?: boolean; result?: T; description?: string };
    if (!response.ok || !result.ok) throw new Error(result.description || `Telegram ${method} failed`);
    return result.result as T;
  }
}

export function startTelegram(cfg: JarvisConfig, onCommand: CommandHandler): TelegramBridge | null {
  if (!cfg.telegram?.enabled) return null;
  const token = process.env[cfg.telegram.botTokenEnv];
  const allowed = new Set(cfg.telegram.allowedChatIds.map(String).filter(Boolean));
  if (!token || !allowed.size) {
    console.error("[telegram] disabled: set a bot token and at least one allowed chat ID.");
    return null;
  }
  const bridge = new TelegramBridge(token, allowed, onCommand);
  bridge.start();
  console.log("[telegram] private command bridge started.");
  return bridge;
}
