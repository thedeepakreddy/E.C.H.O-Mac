import type { JarvisConfig } from "../config.js";
import { chatgpt } from "./chatgpt-auth.js";

/**
 * How the OpenAI brain will pay for this turn, or null if it cannot run.
 *
 * One function, so the brain factory, the brain itself, the availability check
 * and the control panel can never disagree about which credential is in use.
 */
export type OpenAIAuth = { via: "chatgpt" } | { via: "apiKey"; key: string };

export function resolveOpenAIAuth(cfg: JarvisConfig, env: NodeJS.ProcessEnv = process.env): OpenAIAuth | null {
  const mode = cfg.openai?.auth ?? "auto";
  const key = env[cfg.openai?.apiKeyEnv ?? "OPENAI_API_KEY"]?.trim();
  const signedIn = (() => {
    try { return chatgpt.isReady(); } catch { return false; }
  })();
  if (mode === "chatgpt") return signedIn ? { via: "chatgpt" } : null;
  if (mode === "apiKey") return key ? { via: "apiKey", key } : null;
  if (signedIn) return { via: "chatgpt" };
  return key ? { via: "apiKey", key } : null;
}

/** Why the OpenAI brain cannot run, said the way a person would fix it. */
export function openAIUnavailableReason(cfg: JarvisConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  if (resolveOpenAIAuth(cfg, env)) return null;
  const mode = cfg.openai?.auth ?? "auto";
  const keyEnv = cfg.openai?.apiKeyEnv ?? "OPENAI_API_KEY";
  if (mode === "chatgpt") return "sign in with ChatGPT first";
  if (mode === "apiKey") return `${keyEnv} isn't set`;
  return `sign in with ChatGPT or set ${keyEnv}`;
}
