import { codingToolNames } from '../coding/tool-selection.js';
import { intelligenceToolNames } from './intelligence-routing.js';
import { creatorProjectToolNames } from '../creator-projects.js';
import { TOOLS } from "../tools/registry.js";
import { embedder } from "../cognition/embeddings.js";
import { cosine } from "../cognition/episodic.js";
import { getAppPath } from "../utils/appPath.js";

/**
 * AGI blueprint #9: dynamic tool pruning.
 *
 * Every turn currently gets the full tool list — well over a hundred entries
 * (see `npm run gatetest`'s "all N registered tools" count) — which is real,
 * recurring prompt cost paid on every single request of every turn, most of
 * it irrelevant to what was actually asked. This picks the K tools most
 * similar to the user's own words, using the same local embedder as the
 * semantic reflex cache, plus a fixed allowlist that is never pruned because
 * pruning them wrong would be a safety or memory regression, not a prompt-
 * size one.
 *
 * Never a hard cut: any failure — the model unavailable, an embedding that
 * comes back null, the survivors looking implausibly few — returns `null`,
 * which every caller treats as "send everything", exactly today's behaviour.
 * A tool that got pruned when it was needed is a worse turn; a turn that paid
 * for the full list is only ever a slightly more expensive one.
 */

/** Never pruned: safety, memory and control-flow tools the model must always be able to reach. */
/** Shared with the Claude brain, which keeps these loaded rather than deferred. */
export const ROUTER_ALWAYS_INCLUDE = new Set([
  // Keep creator follow-ups reachable even when they only say "tell me about it".
  "read_creator_project", "show_creator_project",
  "confirm_action", "undo_last", "list_undo", "remember", "recall", "forget",
  "stop_learning_here", "memory_status", "inspect_memory", "inspect_task", "conversation_history",
  "verify_task", "tool_memory", "run_skill", "list_skills", "learn_workflow",
  "discover_tools", "read_tool_result", "refresh_observations", "update_task_plan",
  'run_supervised_task','inspect_supervised_task','read_supervised_evidence','submit_task_review','cancel_supervised_task','show_task_report','read_browser_page',
  // The free way to look something up, and the fallback for every paid one.
  //
  // Measured on four plainly research-shaped asks, `web_search` survived
  // top-K on ONE of them — "look up the best way to do echo cancellation on
  // macOS" offered no web tool at all. That was survivable while nothing else
  // searched the web. It stopped being survivable once Perplexity arrived:
  // MCP tools are never pruned, so PERPLEXITYAI_SEARCH is offered every turn
  // and spends real credit, and on the turn it finally answers "out of
  // credit" there was nothing left in the tool set to fall back to. This runs
  // against the user's own SearXNG, so it costs nothing and cannot run out.
  "web_search",
  // Read-only intelligence stays available for indirect and multilingual asks.
  "open_intel", "osiris_intel", "open_project", "inspect_project", "inspect_coding_tools", "invoke_coding_tool",
]);

/** The text of a tool worth matching against — name and description carry the intent, arguments do not. */
const toolText = (name: string, description: string) => `${name.replace(/_/g, " ")}: ${description}`;

export interface PoolEntry {
  name: string;
  description: string;
}

/**
 * Which tool names to send this turn, or null to send all of them (pruning
 * off, unavailable, or not worth the risk for a small registry).
 *
 * `pool` defaults to the full registry; a brain that already curates its own
 * candidate set — Ollama's `toolsForLocalModel`, tuned for what a small local
 * model can reliably choose between — passes that instead, so this narrows
 * WITHIN an already-safe set rather than scoring against tools that were
 * deliberately excluded for it.
 *
 * `topK` is how many RELEVANCE-RANKED tools are added on top of the always-
 * included ones, not a total to divide between the two — an always-included
 * list at or past `topK` in size must never be able to crowd out every
 * genuinely relevant tool for the turn, which a shared budget would do
 * silently the moment the safety list grew to match a small topK.
 */
export async function selectToolNames(
  userText: string,
  topK: number,
  appRoot = getAppPath(),
  pool: PoolEntry[] = TOOLS
): Promise<Set<string> | null> {
  if (!userText?.trim() || topK <= 0) return null;

  try {
    const emb = embedder(appRoot);
    if (!emb.available()) return null;
    const qv = await emb.embed(userText);
    if (!qv) return null;

    const always = pool.filter((t) => ROUTER_ALWAYS_INCLUDE.has(t.name));
    const rest = pool.filter((t) => !ROUTER_ALWAYS_INCLUDE.has(t.name));
    if (rest.length <= topK) return null; // nothing to prune: keeping "the rest" is everything already

    const scored = await Promise.all(
      rest.map(async (t) => {
        const v = await emb.embed(toolText(t.name, t.description));
        return { name: t.name, score: v ? cosine(Array.from(qv), Array.from(v)) : -1 };
      })
    );
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, topK).map((s) => s.name);

    const relevant = new Set([...intelligenceToolNames(userText), ...codingToolNames(userText), ...creatorProjectToolNames(userText)]);
    const forced = pool.filter(t => relevant.has(t.name)).map(t => t.name);
    if (/\b(?:save|export|training)\b.*\b(?:dataset|data)\b|\bdataset\b.*\b(?:save|export)\b/i.test(userText) && pool.some(t => t.name === 'export_training_data')) forced.push('export_training_data');
    const keep = new Set([...always.map((t) => t.name), ...forced, ...picked]);
    // A sanity floor: if pruning somehow produced far fewer usable tools than
    // asked for (every embedding failed midway, say), it is not to be trusted.
    if (picked.length < Math.min(topK, rest.length) * 0.5) return null;
    return keep;
  } catch (err) {
    console.error("[tool-router] pruning failed, sending the full tool list:", (err as any)?.message ?? err);
    return null;
  }
}
