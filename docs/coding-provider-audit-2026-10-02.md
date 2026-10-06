# Coding provider audit — 2026-10-02

Claude, OpenAI and OpenRouter expose the common coding tool registry. OpenRouter uses the OpenAI Responses adapter with its own endpoint/model/key. Claude exposes the registry through an in-process Agent SDK MCP server, with deferred tool discovery when pruning is enabled. All providers created through createBrain are wrapped by RecordingBrain for task records and recovery. Background coding workers use the configured provider through the same factory.

## Verified offline

`npm run codingproviderstest` drives the actual Responses fetch/SSE adapter for OpenAI and OpenRouter with scripted server responses, and the actual in-memory MCP client/server for Claude. Each declares every coding action, creates a project/file, reads the file, refuses incorrect file hashes through direct and nested calls, and refuses premature finalize_project. This verifies dispatch and failure propagation, not model reasoning or Claude's live SDK subprocess loop. Nested free-form argument objects remain permissible by JSON Schema defaults; omission of explicit additionalProperties alone is not a confirmed failure.

18 selected suites passed after rerunning four localhost-dependent fixtures outside the sandbox. Covered shared routing, file/process/recipe/dialogue/preview/diagnostics/full-stack/dataset/recovery/repair paths, intelligence routing, ChatGPT authentication fixtures and OpenRouter authentication fixtures. Sandbox EPERM on localhost binding caused the initial four failures; their authorized rerun passed. Typecheck passed. The newly added provider fixture is picked up by the normal test runner.

Real local preview and Python/SQLite backend persistence fixtures ran; fake authentication tests did not validate the user's live credentials. OpenAI and OpenRouter have nonempty configured environment entries; Claude has a local credentials file. These establish configuration presence only. No paid live model request was sent and no provider was switched.

## Limits and remaining work

- Tool availability is not evidence that every hosted model reliably chooses valid arguments. The latest StudyForge run supplied incorrect tool arguments and file hashes before exhausting Gemini provider retries.
- The project completion gate requires current configured check exits and acceptance evidence. It prevents finalize_project and update_project from silently certifying unfinished work. Plain conversational claims are not a universal independent product evaluation.
- run_project_checks runs configured project scripts; it does not guarantee the model creates comprehensive unit/integration/regression tests. Browser assertions verify observed flows, not all possible behavior. Native UI checks, production security, scale/performance, accessibility and deployment readiness need explicit acceptance tests.
- record_project_acceptance accepts evidence text tied to the current source. It is not an independent reviewer or guarantee that a model's evidence is truthful. Browser assertion evidence is observed directly; manually recorded evidence needs review.
- src/coding/evaluation.ts implements stable project-level train/validation/held-out splitting and marks records unreviewed/non-gold. It is not a scored cross-provider benchmark or automatic golden-standard dataset.
- Claude delegates continuation and context management to its SDK; it does not share Gemini/OpenAI's explicit progress-promise continuation heuristic. A real end-to-end coding benchmark per configured model remains necessary.
- A scored benchmark should use isolated projects, fixed task specs, independent acceptance/regression checks and report completion, tool errors, repair success, latency and cost. Do not label scripted provider fixtures as model-quality scores.
