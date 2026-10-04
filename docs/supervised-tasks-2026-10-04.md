# Supervised long tasks

Echo now has a native worker–inspector workflow shared by Claude, Gemini, OpenAI, OpenRouter and Ollama. The selected provider supplies both roles through `createBrain`. Model ability and service availability still vary; this change does not guarantee error-free generated code.

## Automatic use from natural requests

Users do not need to turn on a mode or name a tool. Clear complex action requests such as “Build a StudyForge app with login, lessons, a database and tests” or “Research battery technologies, compare the evidence and create a detailed report” enter the supervisor from the shared input dispatcher. Local recognition adds no classifier model call. It seeds a plan for requirements, execution, tests/verification and handoff; the worker records detailed requirements and project acceptance criteria before editing. The selected brain executes the work and the independent inspector checks it.

The same dispatch serves voice, typed, phone and Telegram input. Recognized long-task/status input bypasses the voice-only model and cached workflow replay. Progress questions use saved supervisor state before legacy coding status. Repeated or conflicting new long requests cannot start a second job; stop controls cancel the owned worker and inspector together. Private mode and scoped memory settings also apply to the bounded conversation context passed to the worker.

Greetings, explanations, simple single commands and small edits stay lightweight. Ambiguous goals and references to earlier discussion remain with the foreground brain, whose shared instructions require automatic supervision after resolving material missing requirements. The user is never asked to enable supervision. Existing project build/answer/continue entry points now use the same supervisor by default. Supervised workers cannot start another coding writer.

Supervision tools remain available through both general tool routing and the additional coding-tool pruning pass, including the compact local model path. Starting the bounded workflow is an ordinary action; each actual operation still passes through the existing schema, permission, cancellation and risk gates. Destructive or external actions retain their own authorization requirements.

## Execution contract

`run_supervised_task` accepts a goal, ordered plan, observable acceptance criteria, existing project IDs, a knowledge/GUI lane, total time budget, iteration budget and repair limit. Material user choices should be clarified first. The tool returns a durable task ID immediately so the main voice conversation stays available.

Only one supervised job runs at once. It reserves capacity for one worker and one temporary inspector within the existing four-agent limit. GUI jobs own the desktop lane against other swarm GUI jobs. Knowledge workers use isolated project/browser tools and cannot drive the shared desktop.

The worker implements the plan, runs relevant checks and regressions, exercises requested flows, records verified plan steps, and submits a structured result. It can call registered local tools and connected external MCP services, through the existing schema, permission, risk and cancellation gates. Its hard grants prevent recursively creating more Echo workers or missions. Native Claude schema search remains available; native SDK execution tools are excluded in favor of Echo's guarded tools.

The inspector has a separate context and a narrow read-only tool set. It reviews progress every minute while work runs, and conducts a new final inspection after the worker stops. It reads actual project files, process results, browser/app observations and paginated original worker tool results. It sends specific repair instructions to the active worker; a final failure creates a fresh repair attempt that inspects saved work before changing it. Default maximum: two repairs and 30 minutes total. Repeated failure, missing evidence, uncertain actions, unavailable providers and exhausted budgets produce a blocked report.

## Completion gate

A worker reply or stream ending is insufficient. A final pass requires:

- A completed structured worker result with artifacts and no unresolved result blockers.
- Every required plan step completed with observed evidence.
- Worker evidence recorded by verification tools, separately from model-submitted references.
- An actor-owned independent review covering every exact acceptance criterion, with evidence produced in the inspector's own task.
- A current review token; stale snapshots and invented evidence are rejected.
- No unresolved worker tool calls.
- Current project checks, acceptance evidence and unchanged source fingerprints for associated coding projects.
- Both owned brains stopped, once, within cleanup deadlines.

Evidence confirms the checks that actually ran. Tests and model review cannot establish that arbitrary software has zero defects. External operations need observable postconditions; unsupported or inaccessible apps must be reported as blockers. A restart preserves records and marks interrupted supervised jobs blocked for explicit continuation rather than silently repeating side effects. Swarm recovery refuses supervisor-owned checkpoints, preserving inspector authority limits.

## Browser and apps

`read_browser_page` reads rendered HTTP(S) content in one hidden Electron renderer. It uses an ephemeral session, no signed-in browser cookies, sandboxing, disabled Node access/WebGL, muted audio, denied permissions/downloads/popups, bounded text/links, cancellation and a deadline. `waitForText` supports delayed dynamic content. The renderer closes after the read, including failure paths, and does not steal focus.

Interactive or authenticated browser work uses the existing `open_url`, accessibility targeting, OCR and exact UI actions. Native apps use `open_app` followed by fresh accessibility/OCR observations. Permissions, app accessibility support and the user's actual signed-in state remain necessary. Fetched app/page content is treated as untrusted data.

## Report and shutdown

A dedicated report window shows plan outcomes, actual verification checks, inspector review/repair history, output artifacts, unresolved blockers and agent cleanup status. It has working vertical scrolling at narrow and wide widths, renders untrusted text as text, and exposes only close/select/output IPC operations. HTTP(S) output opens on a user click; local output is revealed in Finder, never executed by the report. It has no expiry timer. New reports share one window, with recent history and durable task records available to reopen through `show_task_report`.

Supervised jobs also appear in the existing control-panel mission view. Its stop controls close both roles together; messaging routes to the worker; deleting a job removes its task records and report while preserving output files. Live progress is bounded and UI broadcasts are throttled. Mission snapshots project relevant bindings and cached panel metadata instead of cloning every historical tool call.

Graceful application shutdown cancels supervised tasks, waits for background agent cleanup, closes the hidden browser and report window, and then releases the existing terminal/coding/MCP resources. Output previews and applications intentionally created for the user are separate from the working brains.

The report design follows the user-approved generic 12ui candidate B, its HTML conversion, extracted backdrop/icons and alignment kit. Functional changes replace sample facts with actual records, use dynamic scrollable rows and inspector history, and keep native system fonts without a remote font request. Layout remains responsive instead of restoring the target's fixed absolute coordinates or fictional test totals.

## Framework assessment

LangGraph provides durable, stateful agent orchestration; LangChain supplies a higher-level agent and integration layer. Neither is required for this implementation. Echo already has provider adapters, a persisted task coordinator, tool gates, process ownership and cancellation. Adding a second orchestrator now would duplicate those responsibilities. LangGraph could be reconsidered for distributed execution or more complex cross-process workflow scheduling.

Official references: [LangGraph JavaScript overview](https://docs.langchain.com/oss/javascript/langgraph/overview), [LangChain JavaScript overview](https://docs.langchain.com/oss/javascript/langchain/overview).

## Validation

Offline validation covers worker → inspector → repair → final verification, fabricated/stale evidence, task ownership, cancellation/late events, cleanup deadlines, initialization failures, restart records, repeated-request reuse, all five provider factory limits, external MCP permission boundaries and shared agent capacity. Electron fixtures verify delayed JavaScript page content, denied popups, focus isolation, window cleanup, persistent reports, injection protection, scrolling, responsive layout and the Close button. These fixtures do not make paid model calls or prove access to every application or authenticated website.

Validation: the full offline suite passed **109/109**, followed by focused checks after the final panel/cache changes. TypeScript checking and the production build passed. Supervised lifecycle coverage contains 14 groups; native Electron fixtures use synthetic page/report data and isolated temporary profiles. Live paid model runs, audio permissions and every third-party application were not exercised.

Automatic-routing follow-up: the full offline suite passed **110/110**. New cases cover natural complex requests, exclusions for explanations/simple commands, GUI lane selection, duplicate prevention, truthful progress, scoped/private handoff, actor-owned cancellation, all five foreground providers and voice/text dispatch, voice-only transport bypass, coding-tool pruning, and saved-project plans. Follow-up checks cover the final progress-routing refinements. No paid model calls were made.
