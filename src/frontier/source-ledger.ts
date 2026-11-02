/**
 * Pages an agent task actually read this run, keyed by its task id, so the
 * completion gate can check what the deliverable attributes to each source
 * (cited figures and claim wording). Written by read_browser_page; read and
 * cleared when the task's Result is gated (swarm.ts). Bounded per task.
 */
const MAX_PAGES = 12, MAX_TEXT = 60000;
const ledger = new Map<string, Map<string, string>>();

export function recordSource(taskId: string, url: string, text: string): void {
  if (!taskId || !url) return;
  const pages = ledger.get(taskId) ?? new Map<string, string>();
  if (!pages.has(url) && pages.size >= MAX_PAGES) return;
  pages.set(url, String(text ?? '').slice(0, MAX_TEXT));
  ledger.set(taskId, pages);
}

export function sourcesFor(taskId: string | undefined): Record<string, string> {
  return taskId ? Object.fromEntries(ledger.get(taskId) ?? []) : {};
}

export function clearSources(taskId: string | undefined): void {
  if (taskId) ledger.delete(taskId);
}
