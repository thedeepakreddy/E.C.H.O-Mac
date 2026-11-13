import { activeConfig } from "../config.js";

/**
 * One short question to the local model, for the background helpers.
 *
 * Ghost mode, shadow mode and the auto-debugger each carried their own copy of
 * this call, with the host and the model written in as literals:
 * `http://localhost:11434` and `llama3.2:3b`. So they ignored `ollama.host` and
 * `ollama.model` entirely. On a machine set up with any other local model the
 * request came back 404 and each helper did nothing at all — switched on in
 * Settings, never once speaking, and nothing anywhere saying why. The
 * auto-debugger was worse: it read `response` off the error body and spoke
 * whatever was there.
 *
 * None of them had a deadline either. They run on a timer, so a local server
 * that accepted the connection and never answered left one more request
 * pending on every tick for as long as Echo stayed open.
 *
 * Returns the model's text, or null when there is nothing usable — the server
 * is down, the model is missing, the reply is empty, or it took too long.
 * Never throws: these are background conveniences, and a failure here must not
 * reach the turn the user is actually in.
 */
export async function localGenerate(prompt: string, timeoutMs = 60_000): Promise<string | null> {
  const { host, model } = localModel();
  try {
    const res = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      noteFailure(`${model} at ${host} answered ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { response?: unknown };
    const text = typeof body?.response === "string" ? body.response.trim() : "";
    lastFailure = "";
    return text || null;
  } catch (err) {
    noteFailure(`${model} at ${host}: ${(err as any)?.message ?? err}`);
    return null;
  }
}

/** The local model the user configured, with the same defaults the Ollama brain uses. */
export function localModel(): { host: string; model: string } {
  const cfg = activeConfig();
  return {
    host: (cfg.ollama?.host || "http://localhost:11434").replace(/\/+$/, ""),
    model: cfg.ollama?.model || "llama3.2:3b",
  };
}

let lastFailure = "";

/**
 * Logged once per distinct cause, not once per tick. Silence is what hid the
 * wrong-model failure; a line every sixty seconds would only bury it again.
 */
function noteFailure(reason: string): void {
  if (reason === lastFailure) return;
  lastFailure = reason;
  console.warn(`[helpers] the local model is not answering (${reason}); background helpers are idle until it does`);
}
