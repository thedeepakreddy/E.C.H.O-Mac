# Echo championship readiness — 11 October 2026

## First objective

The selected demonstration is **build and test an application by voice**.
Use one repeatable workflow to establish end-to-end evidence, then expand
coverage. Component tests and scripted provider responses are not evidence
that a live model completes the same task reliably.

The candidate entry is a personal agent that helps non-technical people turn
spoken requirements into a verified local application. Registration eligibility
(including the inconsistent Dubai trade-licence requirement), originality,
and the exact submission deadline still need organiser clarification.

## Current observations

- Working tree was clean before this readiness document.
- `df -h .` reported **1.7 GiB available** on the Mac's data volume. This is a
  resource blocker for sustained application builds. Use **15 GiB free** as our
  initial test budget; this is a proposed operating target, not an Apple rule.
- Read-only sizes: dependencies 922 MiB, build output 68 MiB, models 635 MiB,
  Echo data 464 MiB, generated projects 636 KiB. Deleting these small directories
  would not meet that budget. No user files have been deleted.
- Today's initial baseline checked 116 items (type checking plus discovered
  offline suites): 104 passed, eleven were blocked by local socket/Electron
  sandbox restrictions, and the main-runtime fixture failed reproducibly.
  The eleven permission-blocked fixtures then passed in a supported environment
  with the offline network guard retained. The dispatcher fixture omitted the
  real phone-update and bot parsers; restoring those imports and adding local
  command routing coverage made all 22 main-runtime groups pass. Four focused
  suites passed. All 116 baseline items therefore have passing results across
  the initial run and these targeted rechecks; this is not a single 116/116 run.
- Production build and post-fix TypeScript checks passed. Explicit native
  panel-routing, panel-performance and coding-UI fixtures also passed. Panel
  navigation paint was 12.6 ms in the synthetic fixture; this is not a live
  loaded-system latency measurement. The coding fixture verified a Python
  UI/API/SQLite flow, not a live model-generated application.
- `npm test` discovers named component tests but skips `test:*` scripts.
  Native panel, coding UI and desktop fixture checks require explicit execution.
- The existing `e2e` script checks a live brain, screenshot tool, gate and reply;
  it does not test spoken app building. It captures the current screen, so a
  synthetic test screen must be foreground before using it with a cloud brain.
- The doctor script does not yet cover all providers or load the same stored
  configuration and key sources as the application. Do not use its "all clear"
  verdict as championship certification.
- The last Kimi checks timed out before response headers. Recheck its live
  service before selecting it for the demo. Never silently substitute a brain
  when reporting a provider's result.

## Ordered execution

1. **Resources and baseline.** Make adequate disk space available; record the
   exact commit, active model, configuration, macOS/toolchain versions and
   permissions without exposing keys. Run the offline suite and production
   build sequentially. Classify OS permission failures separately from product
   failures and rerun affected fixtures in their supported environment.
2. **Desktop and voice smoke.** Verify startup, panel navigation/scrolling,
   microphone recognition, audible output, interruption, graceful stop and
   restart. Use the actual output device. A person must confirm that the spoken
   response is audible; a generated audio file alone does not prove playback.
3. **One live app build.** Use a new disposable project and synthetic data.
   Start with one authenticated cloud brain. Exercise requirements questions,
   automatic supervision, worker tools, independent inspector, build/checks,
   preview interactions and the final persistent report.
4. **Fault and recovery trials.** Repeat with a seeded application bug, a
   requested feature change, cancel, interrupted restart, unavailable model,
   tool timeout, offline network and failed build. Confirm actual cleanup and
   truthful blocked states. Never retry an uncertain external mutation blindly.
5. **Provider and MCP compatibility.** Repeat a smaller identical contract
   suite through each configured brain. Test real read-only calls to each
   required MCP service. Record unavailable services as blocked. Inspect real
   argument validation, results, permissions, provenance and tool cancellation.
6. **Normal-load endurance.** Run sequential voice/build/panel use for one hour
   while measuring CPU, resident memory, memory pressure, swap, disk growth,
   event-loop delay and owned child processes. Establish a baseline before
   changing concurrency or model/context settings. Check that resources return
   after cancellation and idle; do not deliberately drive the Mac into a freeze.
7. **Competition evidence.** Produce an unedited successful demonstration,
   task-level evaluation results, measured latency/cost, user feedback, an
   accurate architecture diagram and an English pitch deck. Explain the
   original agent implementation and third-party model/library dependencies.

## First spoken task

> Build a study planner called StudyForge Demo on my Mac. I need subjects,
> study tasks, due dates, completed states, persistent storage and a responsive
> interface. Ask me the important questions, test the app and show it when done.

The request intentionally does not mention a supervision mode. Echo must select
its worker–inspector workflow automatically. Use synthetic subjects and tasks.
Do not deploy, publish or access personal files for this first local trial.

### Observable acceptance criteria

- The recognised request preserves the required features, and material answers
  are saved and applied. Status questions remain responsive during work.
- One worker and one independent inspector execute the saved plan. Their
  actual actor identities and review evidence are available in the report.
- A user can create/edit/complete/delete a task; invalid input is handled.
- Data survives app/server restart; a fresh project begins without demo data.
- The primary flow works at narrow and normal desktop widths. No blocking
  console/runtime errors occur during the tested interactions.
- Configured tests/builds really run, with actual exit codes and current source
  fingerprints. Inspector findings lead to observed repairs and fresh checks.
- A seeded bug goes red in a relevant test or interaction, is repaired, and
  goes green. A feature change invalidates and renews affected evidence.
- The final report identifies the tested revision, results, artifacts, review,
  unresolved blockers and cleanup. It remains visible until the user closes it.
- No working worker/inspector or unowned build children remain after completion.
  The user-requested app/preview may remain open as the output.

## Measurements and release gate

Use one run ID across speech end, transcript finalisation, request dispatch,
first model token, first audible response, tool starts/ends, checks, inspector
review, output display and cleanup. Measure median and p95 across repeated
runs; keep failures, stalls and timeouts in the denominator. Record the exact
model, token usage, estimated cost and any intervention.

Initial goals, **not measured results**: acknowledge a request within 3 seconds,
panel navigation paints within 250 ms, give meaningful build progress with no
unexplained gap over 15 seconds, and promptly acknowledge cancellation. Record
actual cancellation/cleanup latency and investigate anything over 5 seconds.
Measure full build time before choosing a realistic demo time limit.

Start with ten live build/repair/recovery cases on the lead provider. Before
recording the demo, require five consecutive clean runs of the exact demo,
with no manual code repair, no false completion, and no unresolved crash,
credential leak, destructive action or cleanup failure. Broader provider and
endurance trials must also have explicit observed results. Unverified tasks
and inaccessible services remain labelled; they are not counted as passes.

For each failure: save a redacted run record, reproduce the exact symptom,
minimise it, rank falsifiable causes, apply a focused fix, add a regression at
the real failure seam, and rerun the original live scenario. Prioritise crashes,
freezes, false success and unsafe side effects before latency and appearance.

## Existing commands

```sh
npm test
npm run build
npm run test:panel-routes
npm run test:panel-performance
npm run test:coding-ui
npm run test:coding-desktop
```

Run these sequentially and inspect each result before continuing. The panel
and coding commands use fixtures; they supplement the live voice trial.
Review individual scripts in `scripts/test-modes.mjs` before live/device runs:
these can call paid services, capture the screen, access the microphone or
play audio. Neither `test:live` nor `test:device` alone certifies the demo.
