import { totalmem } from "node:os";
import type { JarvisConfig } from "../config.js";

/** Model capacity is not an allocation budget: KV caches share RAM with macOS. */
export function localContextBudget(cfg: JarvisConfig, capacity = 4096, ram = totalmem()): number {
  const hardwareLimit = ram <= 8 * 1024 ** 3 ? 8192 : 16384;
  const limits = [hardwareLimit, capacity, cfg.context?.maxTokens,
    cfg.context?.providerLimits?.ollama, cfg.context?.providerLimits?.[cfg.ollama.model]]
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 2048);
  return Math.floor(Math.min(...limits));
}
