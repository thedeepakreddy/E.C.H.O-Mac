# Echo Mac runtime and provider wiring audit

This audit improves the existing application through concrete fixes and regression tests. It covers foreground orchestration in `main.ts`, settings, provider replacement, credentials, recovery wiring, MCP argument contracts, background polling, and the existing tool/agent/terminal boundaries. It is not a claim that every line is perfect or that every model will complete every task.

## Architecture and repaired behavior

Foreground brains now have one lifecycle owner in `brain/lifecycle.ts`. Replacement prepares a candidate before stopping the current provider; a construction or preparation failure leaves the current brain available. Concurrent identical switches share work, conflicting switches report busy, retirement has a deadline, and late callbacks cannot reach the active UI or speech handlers. Shutdown closes current and pending instances once. Selecting a new model on the same provider can explicitly rebuild it.

Settings normalization lives in `runtime/control-settings.ts` and uses the shared provider list. Claude, Gemini, Ollama, OpenAI and OpenRouter all survive settings validation. Missing OpenRouter credentials are reported accurately. OpenRouter model changes persist the model and rebuild the active adapter; saving an empty settings object no longer stands in for model persistence.

Credential changes rebuild the brain that copied them. Sign-out retires that adapter through provider replacement, using an available OpenAI API credential or Claude when the signed-out provider becomes unavailable. These operations wait for pending replacement. Saving an unrelated Vercel or voice key preserves the current task. Browser/setup and control-panel key updates use the same path.

Errors settle a foreground task once. An error followed by `turnEnd`, or repeated errors in one turn, cannot mark the next queued task successful or failed. Consecutive local failures now reach the escalation threshold; a failed escalation is reported as a failure. Delayed build dispatch and typed/remote input respect stop, replacement and shutdown. Input during replacement waits for readiness.

Recovered mission agents use the fleet factory, preserving profile grants and budgets. Brain project hints, task state and recovery methods have typed contracts instead of unchecked wrapper access. Claude continues to start inside its recorded execution context.

`runtime/timers.ts` owns main-process polling. Slow asynchronous polls cannot overlap, shutdown clears timers, and late startup callbacks do not start helpers or open windows. Foreground retirement starts immediately during shutdown. Startup and voice initialization failures have explicit error paths.

MCP validators compile once per discovered handle. AJV enforces draft 2020-12 by default and declared draft-07/2019-09 schemas, including tuple constraints. Invalid arguments and invalid schemas fail before remote execution. Credential scrubbing preserves only strictly shaped internal UUID observation references; numeric UUID groups can no longer corrupt read-reuse evidence.

## Provider connections

| Brain | Adapter and tool connection |
| --- | --- |
| Claude | Recorded Claude Agent SDK session; Echo's in-process MCP registry; SDK external MCP configuration and permission hook |
| Gemini | Recorded Gemini adapter; shared registry/gate and Echo MCP client |
| Ollama | Recorded local adapter; shared registry/gate and Echo MCP client, with local context budgets |
| OpenAI | Recorded Responses adapter; API/ChatGPT authentication; shared registry/gate and Echo MCP client |
| OpenRouter | Recorded Responses adapter with OpenRouter endpoint/model; shared registry/gate and Echo MCP client |

Provider discovery may narrow declarations for relevance or grants; execution enforces grants independently. Custom agents and nested dispatch cannot broaden permissions. Terminal processes retain deadlines, output/concurrency budgets and process-group cancellation. See `tool-agent-architecture-2026-10-03.md` for those execution boundaries.

## Verification

The broad run executed 104 offline suites plus TypeScript checking. 104 of the 105 checks passed in that run; the remaining source-pattern assertion was updated to accept the strengthened startup guard and passed on rerun. All 104 offline suites are verified across the broad run and targeted reruns. Final type checking and the production build passed.

`mainruntimetest` executes lifecycle races and extracts the actual main callbacks as complete TypeScript AST nodes, without starting Electron. Its 18 regression groups cover every brain event, replacement failure, deadlines, shutdown races, queued outcomes, OpenRouter model persistence, credential updates, cancellation and polling. `testrunnertest` adds seven groups for classification, cancellation, process ownership, output bounds and the offline network guard. Existing wiring checks cover all 181 registry tools; provider, mission, MCP, terminal, dataset, coding and shutdown suites also pass.

Tests get private temporary data directories. Real service and device/audio suites are explicit modes; the offline HTTP guard permits only this Mac's addresses and rejects remote APIs and automatic redirects. This guard is not an OS sandbox. Test fixture configuration and recording overrides are scoped to the fixture, and generated MCP fixtures receive their explicit execution grants.

Live cloud authentication, live model reasoning, actual remote-server uptime and audible playback were not measured in this audit. Those depend on current credentials, server availability and model capability. Echo was built without launching a live session or resuming an old project.
