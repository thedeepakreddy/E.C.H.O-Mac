/** What Echo remembers: facts, scans, files on disk, screen history and the long-term record. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import { owningTaskId, putHandoff, readHandoff } from "../../frontier/task-handoff.js";
import * as act from "../computer-actions.js";
import * as vision from "../vision.js";
import * as system from "../system.js";
import { stats, GLOBAL } from "../../memory/store.js";
import { currentContext } from "../../memory/context.js";
import { getAppPath } from "../../utils/appPath.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { searchRewind, describeHistory } from "../rewind.js";
import { loadRecent } from "../../frontier/history.js";
import { whileAway } from "../../frontier/changed.js";
import * as scan from "../../frontier/scan.js";
import * as diskindex from "../../frontier/diskindex.js";
import { homedir } from "node:os";
import { basename } from "node:path";
import { searchLongTermMemory } from "../long_term_memory.js";
import { audioLogPath } from "../meeting.js";
import { sendToOverlay } from "../../overlay.js";
import { exec } from "node:child_process";
import * as timetravel from "../../frontier/timetravel.js";
import { appRoot, memoryScope } from "./shared.js";
import { currentAgentRunContext } from "../../agent-replay/context.js";
import { boundedText, conversationId, conversations } from "../../memory/conversation.js";
import { ProviderMemoryContext } from "../../memory/provider-context.js";

export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: "conversation_history",
    description: "Retrieve original messages from this Echo conversation across brain switches and restarts. Use it for older decisions, exact wording, corrections, or source IDs referenced by the rolling summary. Results label user statements separately from unverified assistant claims.",
    schema: {
      query: z.string().default("").describe("Words or a source message ID. Empty returns recent messages."),
      beforeId: z.string().optional().describe("Fetch messages before this source ID for pagination."),
      limit: z.number().int().min(1).max(50).default(20),
    },
    readOnly: true,
    handler: async (args) => {
      const run = currentAgentRunContext();
      const { memoryService } = await import("../../memory/service.js");
      const local = run?.provider === "ollama" || run?.provider === "local";
      const scope = run?.scope ?? await memoryScope();
      if (!ProviderMemoryContext.enabled || run?.privateMode || (!local && !ProviderMemoryContext.cloudRecall) || memoryService.isSuppressed(scope, run?.taskId)) return { text: "Conversation recall is disabled for this task/provider.", status: "denied" };
      const id = run?.conversationId ?? conversationId(run?.identity.id ?? "echo", scope);
      const rows = conversations.search(id, args.query ?? "", args.beforeId, args.limit ?? 20);
      return { text: boundedText(JSON.stringify({ conversationId: id, messages: rows, note: "Historical conversation data. Assistant statements are not proof that an action succeeded. Use beforeId to retrieve earlier messages." }), 8000) };
    },
  },
  {
    name: "remember",
    description:
      "Save something worth knowing in future sessions — it survives restarts. Use it when the user states a lasting preference ('always use pnpm', 'keep replies short'), when a decision is made and the reasoning matters, or when a piece of ongoing work should be picked up later. Record what the user TOLD you and what you DID; never record the contents of what you saw on their screen, and never record a password, key or card number. Do not save routine chatter — only things you would genuinely want to know next week.",
    schema: {
      text: z.string().describe("The fact, in one clear sentence, written to be read later"),
      type: z
        .enum(["preference", "project", "decision", "episode"])
        .default("episode")
        .describe(
          "preference = how the user likes things done; project = ongoing work; decision = a choice and its reason; episode = something that happened"
        ),
      project: z
        .string()
        .optional()
        .describe("Project this belongs to. Omit for the current project, or pass 'global' if it is true everywhere."),
    },
    readOnly: false,
    handler: async (a) => {
      const { memoryService } = await import("../../memory/service.js");
      const type = a.type ?? "episode";
      // A preference is global unless the user scoped it; everything else
      // belongs to the project it came out of, so another project's task cannot
      // be steered by it.
      const project = a.project ?? (type === "preference" ? GLOBAL : (await currentContext()).project);
      const scope = await memoryScope(project);
      const taskId = owningTaskId();
      const saved = memoryService.propose({
        layer: type === "episode" ? "episodic" : "semantic",
        kind: type,
        key: type === "preference" || type === "decision" ? `${type}:${a.text.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}` : undefined,
        summary: a.text,
        scope,
        status: "active",
        confidence: 1,
        confidenceBasis: "The user stated this directly",
        importance: type === "preference" ? 0.9 : 0.6,
        observedAt: new Date().toISOString(),
        source: {
          kind: "user", trust: "user_asserted", origin: "real", taskId,
          evidenceRefs: taskId ? [`task:${taskId}`] : [], derivedFromIds: [],
        },
      });
      if (!saved) return { text: "I did not save that — it was empty, or you had asked me to stop learning here.", status: "denied", error: { category: "write_policy", message: "memory write refused by policy" } };
      const where = project && project !== GLOBAL ? `, ${project}` : "";
      const note = saved.status === "disputed" ? " It contradicts something I already had, so I've flagged both rather than overwriting." : "";
      return { text: `Remembered (${type}${where}): ${saved.summary}${note}`, data: { id: saved.id, status: saved.status } };
    },
  },
  {
    name: "recall",
    description:
      "Search what you remember from earlier sessions. The most relevant memories are already in your context at the start of a turn — use this when you need something older or more specific, or when the user asks what you remember. Results carry their source and how far they can be trusted; reading one does not make it more certain.",
    schema: {
      query: z.string().default("").describe("What to look for. Empty returns the most recent memories."),
      project: z.string().optional().describe("Limit to one project"),
    },
    readOnly: true,
    handler: async (a) => {
      const { executeMemoryCommand } = await import("../../memory/commands.js");
      const scope = await memoryScope(a.project);
      return { text: executeMemoryCommand(`/memory inspect ${a.query ?? ""}`.trim(), { scope, appRoot: appRoot() }) ?? "Nothing remembered yet." };
    },
  },
  {
    name: "forget",
    description:
      "Delete remembered things everywhere they were kept — when the user says to forget something, or when a memory turns out to be wrong or out of date. This reaches the derived copies too: episodes, learned facts, screen embeddings, scans and training captures that came from the same source. Pass the words the memory actually used, or its ID from inspect_memory. It cannot be undone.",
    schema: {
      query: z.string().default("").describe("What to forget. EVERY word must appear in the memory, so be specific — this is deliberately strict so an ordinary sentence cannot delete the wrong thing."),
      id: z.string().optional().describe("An exact memory ID from inspect_memory. Preferred when you have one."),
      taskId: z.string().optional().describe("Forget everything learned from one task, by its ID."),
    },
    readOnly: false,
    handler: async (a) => {
      const query = (a.query ?? "").trim();
      if (!a.id && !a.taskId && !query) {
        return { text: "Tell me specifically what to forget — a memory ID, a task ID, or the words the memory used.", status: "failed", error: { category: "invalid_arguments", message: "an unscoped forget is refused" } };
      }
      const { forgetEverywhere } = await import("../../memory/deletion.js");
      const scope = await memoryScope();
      const receipt = forgetEverywhere({ ids: a.id ? [a.id] : undefined, taskId: a.taskId, query: a.id || a.taskId ? undefined : query, scope, appRoot: appRoot() });
      if (!receipt.count && !Object.keys(receipt.stores).length) {
        return { text: `Nothing I remember matches that.`, status: "success", data: { count: 0 } };
      }
      const places = Object.keys(receipt.stores).length;
      const caveats = receipt.limitations.length ? `\n${receipt.limitations.map((l) => `Note: ${l}`).join("\n")}` : "";
      const failed = receipt.failures.length ? `\nI could not reach: ${receipt.failures.join(", ")}.` : "";
      return {
        text: `Forgotten. ${receipt.count} memory record${receipt.count === 1 ? "" : "s"} removed${places ? `, along with derived copies in ${places} other place${places === 1 ? "" : "s"}` : ""}. Receipt ${receipt.id}.${failed}${caveats}`,
        data: { receipt: receipt.id, count: receipt.count, stores: receipt.stores },
      };
    },
  },
  {
    name: "stop_learning_here",
    description:
      "Stop remembering anything from this project or task, and keep it that way. Different from forgetting: forgetting removes what is already there, this prevents new memory being written here at all, including in the background. Use it when the user says 'do not remember this', 'stop learning from this project', or 'keep this off the record'. Pass on=false to resume.",
    schema: {
      on: z.boolean().default(true).describe("true stops learning here; false resumes it."),
      scope: z.enum(["task", "project"]).default("task").describe("task = only what you are doing right now; project = everything in this project until you turn it back on."),
      reason: z.string().optional().describe("Why, in a few words, for the user's own record."),
    },
    readOnly: false,
    handler: async (a) => {
      const { memoryService } = await import("../../memory/service.js");
      const taskId = owningTaskId();
      const scope = await memoryScope();
      const perTask = (a.scope ?? "task") === "task";
      if (perTask && !taskId) return { text: "There is no active task to exclude.", status: "failed", error: { category: "invalid_arguments", message: "no task in scope" } };
      memoryService.setSuppression({
        scope: perTask ? {} : { projectId: scope.projectId },
        taskId: perTask ? taskId : undefined,
        enabled: a.on !== false,
        reason: a.reason,
      });
      const where = perTask ? "this task" : scope.projectId ? `the ${scope.projectId} project` : "this workspace";
      return { text: a.on === false ? `Learning from ${where} is on again.` : `I will not remember anything from ${where}. What I already remember is untouched — say forget if you want that gone too.` };
    },
  },
  {
    name: "memory_status",
    description: "Report how much is remembered, in which layers, and where it is stored — for when the user asks about their data.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const { memoryService } = await import("../../memory/service.js");
      const { memoryRoot } = await import("../../memory/paths.js");
      const ctx = await currentContext();
      const scope = await memoryScope();
      const all = memoryService.list(undefined, { includeInactive: true });
      const byLayer = new Map<string, number>();
      for (const m of all) byLayer.set(m.layer, (byLayer.get(m.layer) ?? 0) + 1);
      const layers = [...byLayer.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([l, n]) => `${l} ${n}`).join(", ");
      const here = memoryService.list(scope).length;
      const legacy = stats();
      const suppressed = memoryService.suppressions().filter((r) => r.enabled).length;
      return {
        text: [
          `${all.length} memory record(s)${layers ? ` (${layers})` : ""} at revision ${memoryService.revision()}, stored in ${memoryRoot()}.`,
          `${here} of them apply to the current project, which looks like "${ctx.project}" (${ctx.app}).`,
          `${legacy.count} record(s) remain in the older store at ${legacy.file}.`,
          suppressed ? `${suppressed} place(s) where you have told me to stop learning.` : "",
        ].filter(Boolean).join("\n"),
      };
    },
  },
  {
    name: "inspect_memory",
    description:
      "Show what you actually remember, with where each memory came from and how far it can be trusted. Use it when the user asks what you remember, what you know about this project, or why you believed something — and use it on yourself before relying on a memory that would be expensive to get wrong. Reading a memory never makes it more certain.",
    schema: {
      query: z.string().default("").describe("What to look for. Empty lists everything in the current scope, newest first."),
      id: z.string().optional().describe("One memory's ID, to see its full provenance: source, evidence, what it superseded and what it contradicts."),
      project: z.string().optional().describe("Limit to one project. Omit for the current one."),
    },
    readOnly: true,
    handler: async (a) => {
      const { executeMemoryCommand } = await import("../../memory/commands.js");
      const scope = await memoryScope(a.project);
      const command = a.id ? `/memory why ${a.id}` : `/memory inspect ${a.query ?? ""}`.trim();
      return { text: executeMemoryCommand(command, { scope, appRoot: appRoot() }) ?? "Memory inspection is unavailable." };
    },
  },
  {
    name: "tool_memory",
    description:
      "What you have learned about how well your own tools work — how often each one actually succeeded, how it usually fails, and how long it takes. Consult it before choosing between two tools that do the same job, and after a tool fails twice. Reliability is counted only from outcomes that were verified, so a small sample says 'not enough evidence' rather than a confident number.",
    schema: { tool: z.string().default("").describe("One tool's name. Empty gives the least reliable tools first.") },
    readOnly: true,
    handler: async (a) => {
      const { memoryService } = await import("../../memory/service.js");
      const rows = memoryService.list(undefined, { layer: "tool", includeInactive: true })
        .filter((m) => !a.tool || m.key === `tool:${a.tool}`);
      if (!rows.length) return { text: a.tool ? `Nothing has been observed about ${a.tool} yet.` : "No tool outcomes have been recorded yet." };
      const describe = (m: (typeof rows)[number]) => {
        const p = (m.payload ?? {}) as Record<string, number | string | null>;
        const sample = Number(p.verifiedAttempts ?? 0);
        const rate = sample ? `${Math.round(Number(p.reliability ?? 0) * 100)}% verified success over ${sample} verified outcome${sample === 1 ? "" : "s"}` : "no verified sample yet";
        const notes = [
          `${p.attempts ?? 0} call(s) observed`,
          Number(p.failed) ? `${p.failed} failed` : "",
          Number(p.denied) ? `${p.denied} denied` : "",
          Number(p.uncertain) ? `${p.uncertain} uncertain or partial` : "",
          Number(p.unverified) ? `${p.unverified} unverified` : "",
          p.averageDurationMs ? `~${p.averageDurationMs}ms each` : "",
          p.lastErrorCategory ? `last error: ${p.lastErrorCategory}` : "",
        ].filter(Boolean).join(", ");
        return `${String(m.key).replace(/^tool:/, "")}: ${rate}. ${notes}.`;
      };
      const ranked = [...rows].sort((a2, b2) => (Number(a2.payload?.reliability ?? 1) - Number(b2.payload?.reliability ?? 1)) || String(a2.key).localeCompare(String(b2.key)));
      return { text: ranked.slice(0, 20).map(describe).join("\n") };
    },
  },
  {
    name: "search_rewind_memory",
    description: "Search Jarvis's 'Rewind' photographic memory. Use this when the user asks what was on the screen recently, or asks about something they saw a few minutes or hours ago.",
    schema: {
      query: z.string().describe("The word or phrase to search for in the screen memory."),
    },
    readOnly: true,
    handler: async (a) => {
      const results = searchRewind(a.query);
      if (!results.length) return { text: "No matches found in the Rewind memory." };
      return { text: `Found ${results.length} matches:\n${results.join("\n")}` };
    },
  },
  {
    name: "search_my_files",
    description:
      "Search the user's own documents by MEANING, not just keywords. Use this whenever they ask about something they wrote, received, agreed or saved — 'what did we agree the pricing was', 'find that contract', 'what were the notes from the meeting'. Searches Documents, Desktop and Downloads, including PDFs and Word files. Everything stays on this machine.",
    schema: {
      query: z.string().describe("What to look for, phrased as a question or description."),
      limit: z.number().optional().describe("How many passages to return. Default 5."),
    },
    readOnly: true,
    handler: async (a) => {
      const hits = await diskindex.search(a.query, a.limit ?? 5);
      if (!hits.length && !diskindex.loadIndex(diskindex.indexDir()).chunks.length) {
        return { text: diskindex.indexStatus() };
      }
      return { text: diskindex.describeHits(hits, a.query) };
    },
  },
  {
    name: "index_my_files",
    description:
      "Read through the user's documents and build a searchable index, so search_my_files can answer from them. Runs in the background and reports progress. Only needs to be done once; afterwards it updates only what changed. Use this when the user asks to index their files, or when search_my_files reports there is no index yet.",
    schema: {
      folders: z
        .array(z.string())
        .optional()
        .describe("Specific folders to index. Defaults to Documents, Desktop and Downloads."),
    },
    readOnly: false,
    handler: async (a) => {
      if (diskindex.isIndexing()) return { text: "I'm already indexing — ask me for the status." };

      const roots = a.folders?.length
        ? a.folders.map((f: string) => (f.startsWith("~") ? join(homedir(), f.slice(1)) : f))
        : diskindex.defaultRoots();

      // Kick off and return immediately: a first index takes minutes, and
      // holding the conversation open for it would look like a hang.
      void diskindex
        .buildIndex({
          roots,
          // A small pause between files keeps this off the CPU the user is
          // trying to work on. Indexing that makes the machine feel slow is
          // worse than indexing that takes longer.
          throttleMs: 40,
          onProgress: (p) => {
            if (p.filesDone % 10 === 0) {
              sendToOverlay("feed", {
                text: `Indexing ${p.filesDone}/${p.filesTotal}: ${basename(p.currentFile)}`,
              });
            }
          },
        })
        .then((r) => {
          const msg = r.error
            ? `Indexing failed: ${r.error}`
            : `Indexed ${r.filesIndexed} documents (${r.chunksAdded} passages). You can ask me about them now.`;
          sendToOverlay("feed", { text: msg });
          console.log(`[jarvis] ${msg}`);
        });

      return {
        text: `Started indexing ${roots.length} folder(s). This takes a few minutes the first time — I'll tell you when it's done, and you can keep working.`,
      };
    },
  },
  {
    name: "file_index_status",
    description:
      "Report how many of the user's documents have been indexed for searching. Use this when they ask whether their files are indexed or how the indexing is going.",
    schema: {},
    readOnly: true,
    handler: async () => ({
      text: diskindex.isIndexing()
        ? `Still indexing. ${diskindex.indexStatus()}`
        : diskindex.indexStatus(),
    }),
  },
  {
    name: "what_changed_while_away",
    description:
      "Report what changed on screen while the user was away or not looking. Use this for 'what did I miss?', 'what happened while I was gone?', 'anything change?', or when the user returns to the desk and asks to be caught up. Compares the screen before they left with the screen now, ignoring clocks, battery levels and progress bars.",
    schema: {
      minutes: z
        .number()
        .optional()
        .describe("How far back to compare if Jarvis never saw them leave. Defaults to 30 minutes."),
    },
    readOnly: true,
    handler: async (a) => ({
      text: whileAway(getAppPath(), (a.minutes ?? 30) * 60_000),
    }),
  },
  {
    name: "screen_history_status",
    description:
      "Report how much screen history Jarvis is holding, how far back it goes, and how much disk it uses. Use this when the user asks how much history you keep, how far back you can remember, how much space it takes, or when old history is deleted.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: describeHistory() }),
  },
  {
    name: "search_long_term_memory",
    description: "Search Jarvis's long-term semantic vector database. Use this when the user asks about something from days, weeks, or months ago that wouldn't be in the immediate rewind buffer.",
    schema: {
      query: z.string().describe("The semantic concept or question to search for."),
    },
    readOnly: true,
    handler: async (a) => {
      const result = await searchLongTermMemory(a.query);
      return { text: result };
    },
  },
  {
    name: "search_audio_log",
    description: "Search or summarize the continuous transcript of everything said in the room (the Meeting Assistant feature).",
    schema: {
      timeframe: z.string().describe("E.g., 'last 10 minutes', 'today'"),
    },
    readOnly: true,
    handler: async () => {
      const logPath = audioLogPath();
      if (!existsSync(logPath)) return { text: "Audio log is empty." };
      const rawData = readFileSync(logPath, "utf8");
      // Just returning the raw text. The LLM brain can summarize it.
      // Trim to last 100 lines so it fits in context.
      const lines = rawData.split("\n").filter(Boolean).slice(-100);
      return { text: lines.join("\n") };
    },
  },
  {
    name: "show_memory_carousel",
    description: "Show a holographic 3D carousel of the user's recent memories on screen. Use this when the user asks 'what was I just doing?' or 'show me my memory'.",
    schema: {},
    readOnly: true,
    handler: async () => {
      // This used to split on "\\n" — the two-character sequence backslash-n,
      // not a newline — so the whole file came back as one unparseable line and
      // the carousel was always empty.
      const memories = loadRecent(getAppPath(), 5);
      if (!memories.length) return { text: "No memories available." };

      sendToOverlay("show-memory-carousel", memories);
      return { text: "Memory carousel shown." };
    },
  },
  {
    name: "scan_page",
    description:
      "Scan and PERMANENTLY remember what is on screen right now — a PDF, a screen of code, an email, a message thread, lecture notes, an image, or a web page. Unlike ordinary screen reading, a scan is kept forever and can be recalled by meaning months later. Use this whenever the user says 'scan this', 'remember this page', 'save this for later', 'keep this', or wants to be able to find something again in the future. After scanning, offer to save it to their Desktop.",
    schema: {},
    readOnly: false,
    handler: async () => {
      const [{ app, title }, ocrResult] = await Promise.all([
        scan.frontContext(),
        vision.ocr("accurate"),
      ]);
      const text = (ocrResult.lines ?? []).map((l) => l.text).join("\n").trim();

      // A screenshot too, so the scan can be SHOWN, not only described. Best
      // effort — a scan is still worth keeping if the capture fails.
      let png: string | undefined;
      try {
        png = (await act.captureScreen()).data;
      } catch {
        /* keep the text-only scan */
      }

      if (!text && !png) {
        return { text: "There's nothing readable on screen to scan right now." };
      }
      const saved = await scan.commitScan({ text, app, title, pngBase64: png });
      const handle = putHandoff("scan", { scanId: saved.id }, { ttlMs: 30 * 60_000 });
      return { text: scan.offerFor(saved) + ` Scan handle: ${handle.id}.`, data: { scanId: saved.id, handleId: handle.id } };
    },
  },
  {
    name: "save_last_scan",
    description:
      "Save the most recently scanned page to the Desktop. Use this when the user answers yes to the offer after scan_page, or says 'save that', 'put it on my desktop', 'save the PDF'. Saves the real file when the scan was a document, otherwise the captured text or image.",
    schema: { handleId: z.string().optional().describe("The scan handle returned by scan_page.") },
    readOnly: false,
    handler: async (a) => {
      const handle = readHandoff<{ scanId: string }>("scan", { id: a.handleId });
      const last = handle ? scan.loadScans().find(item => item.id === handle.value.scanId) : undefined;
      if (!last) return { status: "failed", text: "This task has no current scan handle. Ask me to scan the page first." };
      try {
        const dest = await scan.saveScanToDesktop(last);
        return { text: `Saved to ${dest.replace(process.env.HOME ?? "", "~")}.` };
      } catch (e: any) {
        return { text: `I couldn't save it: ${e?.message ?? e}` };
      }
    },
  },
  {
    name: "recall_scan",
    description:
      "Recall something the user previously asked you to SCAN — by meaning, not exact words. Use this for 'what was that PDF I scanned', 'find the code I saved last month', 'that email I scanned about the invoice', or any reference to a page they had you remember earlier. Searches only deliberately scanned pages, and works even months later.",
    schema: {
      query: z.string().describe("What they're looking for, in their own words."),
    },
    readOnly: true,
    handler: async (a) => {
      const matches = await scan.recallScans(a.query);
      return { text: scan.describeMatches(matches, a.query) };
    },
  },
  {
    name: "search_my_past",
    description:
      "Search everything seen on the user's screen over time. Answers 'what was that error an hour ago?' or 'when did I last see the invoice schema?'. Understands spoken time windows ('an hour ago', 'this morning', 'yesterday'). Use before saying you don't know something they saw earlier.",
    schema: {
      query: z.string().describe("What to look for, in the user's own words"),
      limit: z.number().int().min(1).max(10).default(3),
    },
    readOnly: true,
    handler: async (a) => ({ text: timetravel.answer(a.query, a.limit ?? 3) }),
  },
  {
    name: "export_training_data",
    description: "Save dataset: export all available recorded brains, conversations, tool calls/results, outcomes and training candidates. Use for 'save dataset', 'save all training data' or 'export dataset'. Gold benchmark examples require independent review.",
    schema: {},
    readOnly: false,
    handler: async () => {
      try {
        const {exportDataset} = await import("../../learn/dataset-export.js");
        const result = await exportDataset({appRoot: getAppPath()});
        return {text: `Dataset saved to ${result.path}. Includes ${result.runs} recorded runs across ${result.providers.join(", ") || "no recorded providers"}, ${result.recordedRows} rows and ${result.trainingExamples} training candidates. Gold examples: 0 (review required). ${result.activeRuns} unfinished runs; ${result.warnings.length} recording gaps. The current save command's later result is included in the next snapshot.`, data: result};
      } catch (error: any) {
        return {text: `Dataset export failed: ${error.message}`, status: "failed", verification: "unverified"};
      }
    }
  },
];
