/**
 * Which OpenRouter models Echo can actually use, asked at runtime.
 *
 * A hardcoded list was the first attempt and it is wrong by construction:
 * OpenRouter retires free tiers without notice — two of the models measured
 * while writing this had already gone by the time the list was finished, and
 * DeepSeek, GLM and Kimi now answer "unavailable for free, the paid version
 * is available now". A catalogue that cannot notice that strands the user on
 * a model that no longer exists.
 *
 * Two filters, and the second is the one people forget:
 *
 *   free   — `:free` tiers bill nothing, so they work on an account with a
 *            zero balance, which is the state most people start in.
 *   tools  — Echo is agentic. A model that will not emit a `function_call`
 *            cannot see the screen, press a key or read mail; it can only
 *            chat. Offering one as a brain is offering a broken Echo, so a
 *            model without tool support is excluded rather than ranked low.
 */

/** OpenRouter's own catalogue entry, trimmed to what matters here. */
interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
  supported_parameters?: string[];
}

export interface OpenRouterModel {
  id: string;
  label: string;
  contextLength: number;
  free: boolean;
  tools: boolean;
}

const MODELS_URL = "https://openrouter.ai/api/v1/models";
/** Long enough that a turn never waits on it, short enough to notice a retirement. */
const CACHE_MS = 30 * 60_000;

let cache: { at: number; models: OpenRouterModel[] } | null = null;

const price = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 1; // unknown price is treated as paid
};

export function toModel(m: RawModel): OpenRouterModel {
  return {
    id: m.id,
    label: m.name || m.id,
    contextLength: Number(m.context_length ?? 0),
    free: price(m.pricing?.prompt) === 0 && price(m.pricing?.completion) === 0,
    tools: (m.supported_parameters ?? []).includes("tools"),
  };
}

/**
 * Every model OpenRouter currently lists. Cached; never throws.
 *
 * A failure here must not break the brain — the configured model still works
 * whether or not the catalogue could be read — so the caller gets an empty
 * list and decides what to say about it.
 */
export async function fetchOpenRouterModels(
  opts: { fetchImpl?: typeof fetch; now?: () => number; force?: boolean } = {}
): Promise<OpenRouterModel[]> {
  const now = (opts.now ?? Date.now)();
  if (!opts.force && cache && now - cache.at < CACHE_MS) return cache.models;
  try {
    const res = await (opts.fetchImpl ?? fetch)(MODELS_URL, { signal: AbortSignal.timeout(20_000) });
    const body: any = await res.json();
    const models = (Array.isArray(body?.data) ? body.data : []).map(toModel);
    if (models.length) cache = { at: now, models };
    return models;
  } catch (err) {
    console.error("[openrouter] could not read the model catalogue:", (err as any)?.message ?? err);
    return cache?.models ?? [];
  }
}

/**
 * Models whose own catalogue entry is wrong, with what actually happened.
 *
 * `supported_parameters: ["tools"]` is a CLAIM, and four of eighteen did not
 * honour it when called with a real tool definition through the endpoint Echo
 * uses. Discovery keeps the list fresh; this keeps it honest. Each entry is a
 * measurement, so it can be re-tested and removed rather than taken on faith.
 */
export const KNOWN_BAD: Record<string, string> = {
  "qwen/qwen3.8-27b:free": "answers plain chat but returns \"Provider returned error\" on any request carrying tools",
  "google/gemma-4-31b-it:free": "provider error on a tool call",
  "thinkingmachines/inkling:free": "refused — \"only available on agentic harnesses\"",
  "thinkingmachines/inkling-small:free": "same harness restriction as inkling",
  "nvidia/nemotron-3.5-lightning:free": "54.7 SECONDS for one tool call, despite the name",
};

/**
 * The ones worth offering: free, tool-capable, roomiest first.
 *
 * Sorted by context rather than by name or price — they all cost nothing, so
 * the only thing left to prefer is how much of a conversation they can hold.
 * Speed would be the better key and the catalogue does not report it; the
 * measured timings live in `openroutertest`, which re-checks them.
 */
export function usableModels(all: OpenRouterModel[]): OpenRouterModel[] {
  return all
    .filter((m) => m.free && m.tools && !KNOWN_BAD[m.id])
    .sort((a, b) => b.contextLength - a.contextLength);
}

/** For the panel: free+tool-capable, or a reason there are none. */
export async function offerableModels(
  opts: Parameters<typeof fetchOpenRouterModels>[0] = {}
): Promise<{ models: OpenRouterModel[]; note?: string }> {
  const all = await fetchOpenRouterModels(opts);
  if (!all.length) return { models: [], note: "Couldn't reach OpenRouter's model list." };
  const usable = usableModels(all);
  if (!usable.length) {
    return { models: [], note: `OpenRouter lists ${all.length} models but none are both free and able to call tools right now.` };
  }
  return { models: usable };
}
