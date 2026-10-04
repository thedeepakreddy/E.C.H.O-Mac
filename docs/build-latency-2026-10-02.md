# StudyForge delay and progress fixes

## Recorded causes

- `Echo--28e87a1a-b218-4086-9aaf-289d156c6481`: “did you finish?” sent a cloud request which timed out after 120,000 ms, then checkpoint recovery started another model request. It performed no project action during that wait.
- StudyForge requests repeatedly hit Gemini input-token quota (429), overload (503), and unavailable legacy fallback models (404). These are provider availability limits, not evidence of compilation taking two minutes.
- Several incoming commands are almost verbatim copies of Echo's preceding progress speech, including “I'll start by initializing…” and “Now installing dependencies…”. That is strong evidence of playback returning through the microphone. Some progress-only replies then ended without taking the promised next action.
- The completion guard also rejected intermediate dependency/file checks as if they claimed the entire application was finished. That added unnecessary repair calls.
- A recorded coding request carried 74 tool schemas, including unrelated email/social-service actions. Those schemas occupied 62,587 JSON characters. Applying the focused coding profile to that exact request leaves 47 schemas / 25,798 characters: 59% less schema text. This is an offline prompt-size measurement, not a claimed 59% live latency reduction.

## Changes

1. Natural status questions read owned local project/worker/process records before any cloud call. Status does not answer pending build questions or interrupt a worker; saved phase alone is never called active work.
2. Operational `progress` events show request waits and fallback attempts separately from spoken/model conversation. Existing loop heartbeats provide rate-limited visible updates across recorded providers.
3. Gemini bounds stream silence to 30 seconds by default, cancels the underlying request, falls back on a stall, and gives overloaded/stalled models a 60-second cooldown. A request-wide cancellation runs before the recorder's total deadline so abandoned streams cannot emit later text. `ECHO_GEMINI_STREAM_SILENCE_MS` is an advanced override; split large tasks into milestones rather than assuming a fast response proves completeness.
4. Explicit coding action promises can trigger a bounded first-step continuation even before the first tool. Blocking questions and capability explanations do not trigger it. Hosted Gemini/OpenAI share that rule.
5. Voice captures that are long, nearly verbatim ordered copies of recent playback are rejected before dispatch, including a second guard after the hearing pass. Short status questions, corrections and explicit commands remain eligible.
6. Coding requests keep precise coding schemas and essential control/memory/discovery tools. Connected external schemas are discovered on demand; an explicit service request still loads them. User-disabled pruning is respected.
7. `verify_task scope: artifact` verifies an intermediate milestone without certifying application completion. Default project verification still requires current checks and acceptance evidence. Successful install process exit is sufficient evidence of installation, not a completed product.

8. Shutdown cancels active provider requests, releases speech/microphone helpers before waiting on services, and bounds coding/brain/MCP/remote cleanup. Individual MCP closes have deadlines so a stalled server cannot prevent the remaining cleanup. Shared Piper workers are explicitly released. Once cleanup finishes, Electron exits directly rather than entering a second pending native quit. Regressions cover hung/throwing shutdown services and idempotent worker release. A live application-menu quit logged shutdown cleanup complete and exited with code 0.

## Validation

`npm test -- buildlatency context codingdialogue codingimprovement codingconformance modelhealth taskprogress interjection latencyfix recovery releasefix`: all 12 selected fixtures passed. The new regression exercises instant status with a live/pending-question worker, partial-vs-final verification, recorded self-speech variants, SDK silence cancellation even when abort is ignored, explicit tool discovery, actual Gemini fallback, and concrete action after a first-step promise. Existing voice tests passed 59/59 cases; recovery 43/43; shared context 32/32. Typecheck/build pass separately.

StudyForge remains unfinished in its saved project state: implementation phase, no acceptance evidence, and only a manifest plus index.html found during inspection. A prior “Yes, all done” response was not proof of a completed backend or tested application. The fixes improve execution/status reliability; they do not fabricate completion or eliminate the provider's external quota/overload limits.
