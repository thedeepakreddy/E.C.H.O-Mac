# Echo task performance — 2 October 2026

## Observed cause

The real OpenRouter inbox run `Echo--207688c6-5624-4aca-9081-32bca2864304`
took 323,397 ms and used 28 model iterations, 14 Gmail fetches, 10 task
inspections and two automatic continuations. The initial model request logged
72,856 input tokens, 102 tool schemas (182,831 characters) and 48,515 characters
of instructions. Each inbox result contained about 132 KB, mostly email HTML.
`inspect_task` counted its own running invocation as an unresolved action, and
successful reads provided no recorded task evidence. These are confirmed local
causes of repeated work; external model latency remains a separate factor.

## Changes

- Task inspection excludes its current call. Successful observations provide
  read evidence; read evidence alone cannot prove an action succeeded.
- Identical successful reads within a task share in-flight requests and reuse
  evidence for 30 seconds. Actions and explicit refresh invalidate reuse.
  Failed reads are retried normally. Live screen observations are always fresh.
  Reuse preserves the original observation time.
- Five repeated unchanged observations stop the task as blocked, retain progress,
  and report the loop instead of triggering another automatic recovery. The
  guard also applies when slow model requests outlast the cache window.
- OpenAI, OpenRouter and Gemini load up to eight relevant external schemas at
  first, with `discover_tools` available to load others. The loaded external set
  is capped at 24. Independent reads run in groups of at most three; internal
  progress/refresh operations and actions retain their requested order.
- Model-facing tool results are bounded excerpts, with email HTML converted to
  readable text. Full sanitized originals remain retrievable by call ID through
  `read_tool_result`, including after restart. Private tasks keep their originals
  in memory only, and forgetting a task removes its result archive.
- `update_task_plan` saves steps, dependencies and verified completed progress.
  Cycles, invented references and erasing completed steps are rejected. Pending
  steps prevent a completed task status. Existing recovery carries this durable
  state back to the model.
- Own-voice matching recognizes common spoken contractions and split
  OpenRouter names, while preserving the existing conservative overlap threshold.
- Startup recovery skips exhausted and superseded main tasks, preserves the
  selected provider when nothing can resume, and recognizes OpenRouter recovery.
- MCP errors nested inside a successful transport response remain failures.

The shared gate, plans and context are used by Echo's built-in tool paths.
Claude's SDK owns its external MCP calls; that external path does not use the
new shared read cache or schema selection. Its built-in tool results use the
bounded representation. Local-model tool lists include the progress tools,
subject to the existing local context budget.

## Validation and limits

`npm run taskprogresstest` checks the real Responses loop and safety gate with
100 synthetic external tools and a large inbox fixture: one fetch, three model
requests, one relevant external schema, bounded model output and completed read
task status. It also checks archived originals, refresh, failed reads, concurrent
reads, expiry, repeated unchanged data, private mode, forgetting, plans and a
real RecordingBrain loop stop without recovery.

The 13 focused suites passed: task progress, replay, recovery, exits, risk,
latency fixes, memory OS, shared context, resource caps, tool routing,
interjections, release fixes and grounding. TypeScript and production build pass.
These are offline regressions; they do not establish a new live provider latency
or a recognition-accuracy percentage. The selected model and voice are unchanged.
VibeVoice installation and activation remain paused.

Echo was restarted to load the rebuilt main process. The first graceful quit
exceeded its shutdown wait; its remaining owned processes were terminated.
A general graceful-shutdown stall is still a separate issue to investigate.
