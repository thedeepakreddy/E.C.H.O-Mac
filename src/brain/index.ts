import { Brain, LOOP_CAPS, type BrainExecutionLimits } from "./types.js";
import { ClaudeBrain } from "./claude.js";
import { GeminiBrain } from "./gemini.js";
import { OllamaBrain } from "./ollama.js";
import { OpenAIBrain } from "./openai.js";
import { resolveOpenAIAuth, openAIUnavailableReason } from "./openai-auth.js";
import { RecordingBrain, type RecordingBrainOptions } from "../agent-replay/runtime.js";
import { configuredReplayDirectory, configuredReplayProvider } from "../agent-replay/runtime.js";
import { RecordedPlaybackBrain } from "../agent-replay/playback-brain.js";
import { setCliclickBin } from "../tools/computer-actions.js";
import type { JarvisConfig } from "../config.js";

export { Brain } from "./types.js";

/** Derived from the config union so a new brain cannot be added to only one of them. */
export type Provider = JarvisConfig["brain"];

export { LOOP_CAPS } from "./types.js";

export type CreateBrainOptions = Pick<
  RecordingBrainOptions,
  "identity" | "autoResume" | "maxRecoveryAttempts" | "recoveryDelayMs"
> & { limits?: BrainExecutionLimits };

/** Build the brain named in config, falling back to Claude if a key is missing. */
export function createBrain(cfg: JarvisConfig, options: CreateBrainOptions = {}): { brain: Brain; provider: Provider } {
  setCliclickBin(cfg.control.cliclickBin);

  // The Agent SDK owns Claude's transport and has no cassette/fetch adapter.
  // Avoid a deceptive "replay" that would still make a live API request: for
  // Claude recordings Echo replays the recorded session presentation only.
  const replayDir = configuredReplayDirectory();
  if (replayDir && configuredReplayProvider() === "claude") {
    return { brain: new RecordedPlaybackBrain(replayDir), provider: "claude" };
  }

  // A recording chooses its own adapter. Requiring the user to first switch
  // config.json to the original provider would make a replay silently diverge.
  const requestedProvider = (configuredReplayProvider() ?? cfg.brain) as Provider;

  let selected: Brain;
  let provider: Provider;
  if (requestedProvider === "gemini") {
    const key = process.env[cfg.gemini.apiKeyEnv];
    if (key || replayDir) {
      // The client constructor requires a key-shaped value, but `recordLLM`
      // returns before the SDK sends a request during replay.
      selected = new GeminiBrain(cfg, key ?? "replay-no-network", options.limits);
      provider = "gemini";
      return {
        brain: new RecordingBrain(selected, provider, { ...LOOP_CAPS.gemini, maxIterations: options.limits?.maxIterations ?? LOOP_CAPS.gemini.maxIterations, model: cfg.gemini.model }, options),
        provider,
      };
    }
    console.warn(
      `[brain] config selects gemini but ${cfg.gemini.apiKeyEnv} is not set — falling back to Claude.`
    );
  }

  if (requestedProvider === "openai") {
    // Your ChatGPT plan when you have signed in with ChatGPT, otherwise an API
    // key — see openai-auth.ts, the one place that decides.
    const auth = resolveOpenAIAuth(cfg);
    if (auth || replayDir) {
      selected = new OpenAIBrain(cfg, auth, options.limits);
      if (auth) console.log(`[brain] openai: paying with ${auth.via === "chatgpt" ? "your ChatGPT plan" : "the API key"}`);
      provider = "openai";
      return {
        brain: new RecordingBrain(selected, provider, { ...LOOP_CAPS.openai, maxIterations: options.limits?.maxIterations ?? LOOP_CAPS.openai.maxIterations, model: cfg.openai.model }, options),
        provider,
      };
    }
    console.warn(
      `[brain] config selects openai but it can't run (${openAIUnavailableReason(cfg)}) — falling back to Claude.`
    );
  }

  if (requestedProvider === "openrouter") {
    // The SAME Responses loop as OpenAI, pointed elsewhere. Verified that
    // OpenRouter implements it: /api/v1/responses answers 401 where an
    // invented route answers 404.
    const key = process.env[cfg.openrouter?.apiKeyEnv ?? "OPENROUTER_API_KEY"]?.trim();
    if (key || replayDir) {
      const base = (cfg.openrouter?.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
      selected = new OpenAIBrain(
        // The loop reads `cfg.openai.model`, so hand it the OpenRouter one
        // rather than teaching every call site which brain it is serving.
        { ...cfg, openai: { ...cfg.openai, model: cfg.openrouter?.model ?? "openai/gpt-4o-mini" } },
        key ? { via: "apiKey", key } : null,
        options.limits,
        {
          url: `${base}/responses`,
          label: "openrouter",
          // OpenRouter asks third-party apps to identify themselves; it is
          // what their dashboard attributes usage to.
          headers: { "HTTP-Referer": "https://osirisai.live", "X-Title": "Echo" },
          maxOutputTokens: cfg.openrouter?.maxOutputTokens ?? 4096,
        }
      );
      provider = "openrouter";
      console.log(`[brain] openrouter: ${cfg.openrouter?.model} via ${base}`);
      return {
        brain: new RecordingBrain(selected, provider, { ...LOOP_CAPS.openai, maxIterations: options.limits?.maxIterations ?? LOOP_CAPS.openai.maxIterations, model: cfg.openrouter?.model }, options),
        provider,
      };
    }
    console.warn(
      `[brain] config selects openrouter but ${cfg.openrouter?.apiKeyEnv ?? "OPENROUTER_API_KEY"} is not set — falling back to Claude.`
    );
  }

  if (requestedProvider === "ollama") {
    selected = new OllamaBrain(cfg, cfg.ollama?.host, options.limits);
    provider = "ollama";
    return {
      brain: new RecordingBrain(selected, provider, { ...LOOP_CAPS.ollama, maxIterations: options.limits?.maxIterations ?? LOOP_CAPS.ollama.maxIterations, model: cfg.ollama?.model }, options),
      provider,
    };
  }

  selected = new ClaudeBrain(cfg, options.limits);
  provider = "claude";
  return {
    brain: new RecordingBrain(selected, provider, { ...LOOP_CAPS.claude, maxTurns: options.limits?.maxIterations ?? LOOP_CAPS.claude.maxTurns, model: cfg.claude.model }, options),
    provider,
  };
}
