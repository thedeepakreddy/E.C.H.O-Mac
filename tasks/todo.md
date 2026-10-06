# Echo voice coding — ordered implementation tasks

Implementation started in the listed order on 2026-10-02. Core code and fixture
evidence are documented in [voice-coding-2026-10-02.md](../docs/voice-coding-2026-10-02.md).
Unchecked release items retain outstanding acceptance coverage; do not treat
implemented adapters or mocked tests as full release certification.
Design and audited existing capabilities: [plan.md](plan.md).
Suggested new files are proposals; reuse existing modules where practical.

## Task 1: Create project-bound build sessions

- [x] Implement a durable BuildSession referencing task/conversation state,
  workspace root, spec, target, phase, revision and artifacts.

Acceptance:
- A new or existing project opens without modifying Echo's installation.
- Relative/absolute paths and symlinks resolve against an explicit workspace;
  external locations do not become writable merely from a model-supplied path.
- Restart restores the same project and pending phase/revision.

Verification: isolated temporary-project state tests, restart fixture and
TypeScript/build checks. Files: proposed `src/coding/session.ts`,
`src/coding/workspace.ts`, `src/tools/registry/coding.ts`, existing task-state.
Dependencies: none. Scope: medium.

## Task 2: Add repository reading and atomic patches

- [x] Add ignore-aware search, ranged reads, atomic expected-hash patches,
  diffs and revision-aware edit ownership.

Acceptance:
- Large files are paginated with explicit offsets/completeness; no silent cutoff.
- A stale hash/concurrent user edit rejects the patch and preserves both states.
- Unicode/line endings and project path boundaries survive read/edit/diff.

Verification: large-file, symlink escape, stale-edit and competing-writer fixtures;
inspect generated Git diff. Files: proposed `src/coding/files.ts`,
`src/coding/patch.ts`, coding registry, existing gate/task ownership.
Dependencies: 1. Scope: medium.

## Task 3: Manage processes and terminals

- [ ] Implement process sessions with spawn, stream/poll, stdin, exit/readiness,
  timeout/cancel and verified process-group cleanup.

Acceptance:
- A persistent dev server returns a handle and logs without holding the tool
  call until server exit; build commands report actual exit status.
- Timeout/cancel terminates the owned child group, and leaves unrelated
  processes intact. PID reuse cannot make a saved handle own a different app.
- Buffered output, worker count and log storage stay bounded; interactive
  commands use a tested PTY/stdin path where necessary.

Verification: long-running/large-output/stdin/child-process tests and UI heartbeat
under load. Files: proposed `src/coding/processes.ts`,
`src/coding/process-worker.ts`, coding registry, replay cancellation integration.
Dependencies: 1. Scope: medium.

## Task 4: Make Git checkpoints and recovery reliable

- [ ] Replace worktree shell interpolation with argument-array execution;
  persist checkpoint/branch/project ownership and recover safe work state.

Acceptance:
- Branch/path metacharacters are handled as data; failed worktree creation is
  structured failure, with no misleading success.
- Existing dirty work remains intact; undo applies only Echo's selected change.
- Recovery inspects patches/process readiness and resumes without repeating
  completed installs, servers or external side effects.

Verification: dirty repository, worktree failure, interrupted patch and running
server restart scenarios. Files: registry/agents, proposed `src/coding/git.ts`,
`src/coding/recovery.ts`, build session.
Dependencies: 1–3. Scope: medium.

## Checkpoint A: Foundation

- [ ] Create/read/edit/diff/run/cancel/resume passes in an isolated fixture.
- [ ] Existing Echo suites and production build remain healthy.
- [ ] Review concrete tool contracts and recorded evidence before adding UI.

## Task 5: Add language recipes and the first website slice

- [ ] Implement recipe detection/probes and one static/JS/TS web recipe with
  scaffold, lockfile-aware installation, build/test and server readiness.

Acceptance:
- A minimal voice-requested site can be generated, built and served locally.
- Existing-project scripts and package manager are detected rather than replaced.
- Missing dependencies/toolchain/disk budget is surfaced before claiming build
  readiness; no mass installation of unused frameworks.

Verification: new static site, new JS/TS site and existing-repo fixtures;
intentional missing-toolchain/disk-budget cases. Files: proposed
`src/coding/recipes.ts`, `src/coding/recipes/web.ts`, session/coding registry.
Dependencies: 1–4. Scope: medium.

## Task 6: Add the build dialogue coordinator

- [ ] Implement build questions, answers, status and revision-aware feature
  changes without blocking voice behind a coding worker.

Acceptance:
- Voice and typed answers resolve the same persisted question; a theme/feature
  change is distinguished from status, pause or cancellation.
- Requirements, suggested defaults, theme tokens and acceptance criteria are
  saved; only architecture-blocking choices stop dependent work.
- New instructions reach safe build boundaries, and stale revisions cannot
  overwrite newer answers or report old checks as current completion.

Verification: simulated ASR corrections, interrupted speech, queued feature
change and pending-question restart tests. Files: proposed
`src/coding/dialogue.ts`, `src/coding/questions.ts`, main dispatch and turn queue.
Dependencies: 1, 4–5. Scope: medium.

## Task 7: Show and inspect a local web preview

- [ ] Add a project-aware isolated preview surface and preview inspection tools.

Acceptance:
- “Show me” opens the ready localhost app and updates after edits; port conflicts
  and failed readiness do not yield a fabricated URL.
- Generated/remote preview content has no Echo preload/Node privileges and
  cannot invoke privileged IPC; navigation/permissions remain scoped.
- DOM, browser console/page errors, failed requests and screenshots are
  attributable to the exact project revision.

Verification: UI smoke, console-error, navigation/IPC isolation, responsive
layouts and closed-server cases. Files: proposed `src/coding/preview.ts`,
`src/coding/browser-inspection.ts`, control-panel event/UI integration.
Dependencies: 3, 5–6. Scope: medium.

## Task 8: Reproduce and repair errors with evidence

- [ ] Implement diagnostics/check runners and a bounded issue-driven repair loop.

Acceptance:
- Syntax/type errors, failing tests and a broken primary browser flow are
  captured, reproduced, patched and rerun to verified resolution.
- Repeated unchanged issue signatures stop with actionable evidence; missing
  APIs/quota cannot turn into unlimited edit/retry loops.
- Completion requires actual check/interaction evidence; a successful file write
  or server start cannot certify application behavior.

Verification: seeded syntax/type/runtime/UI bugs and irreparable external
service fixture; meaningful regression assertions. Files: proposed
`src/coding/diagnostics.ts`, `src/coding/checks.ts`, `src/coding/repair.ts`,
verification tools/session integration.
Dependencies: 2–3, 5–7. Scope: medium.

## Checkpoint B: Voice web-builder release candidate

- [ ] Novice asks for a website, answers questions and sees it locally.
- [ ] A spoken design/feature change and undo work; an intentional bug is fixed.
- [ ] Cancel/restart, voice responsiveness and M2 memory/disk checks pass.

## Task 9: Build one complete full-stack feature

- [ ] Add a Python or web-framework backend recipe and a complete persisted
  data flow, preserving project-specific real auth/API/database requirements.

Acceptance:
- Create/read/update flow is tested through UI → API → persistence.
- Missing service keys/schema/configuration are explicit blockers, with a
  clearly labelled prototype alternative only if the user chooses it.
- Backend/API/schema changes rerun both server and affected client checks.

Verification: CRUD integration/browser tests, restart persistence, invalid input,
API failure and missing-secret tests. Files: proposed
`src/coding/recipes/python.ts`, backend/service capability metadata, check/recipe
fixtures (generated app code belongs to isolated test projects).
Dependencies: 5–8. Scope: medium.

## Task 10: Integrate Vercel preview deployment

- [ ] Add private token/team/project setup and one deploy adapter with status,
  logs, preview verification and authorized production target.

Acceptance:
- Exact source revision maps to deployment identity; preview creation yields a
  verified ready URL, and protected previews are handled without secret URLs.
- Failed deployment logs feed the repair loop; retries inspect existing
  deployment state rather than duplicating submissions after restart.
- User authorization distinguishes local preview, hosted preview and production;
  runtime/account incompatibility or real-service requirements are reported.

Verification: mock API lifecycle/auth/rate/error/protection/idempotency cases;
then an actual private test project deployment once credentials are supplied.
Files: proposed `src/coding/deploy/vercel.ts`, deployment state/registry,
keystore/settings integration, deployment fixtures.
Dependencies: 4, 7–9; Vercel account/token and correct team permissions.
Scope: medium.

## Checkpoint C: Full-stack and hosted preview

- [ ] A complete data flow works locally and on a compatible hosted target.
- [ ] Intentionally failed deployment is diagnosed and repaired.
- [ ] Production remains a distinct authorized operation; logs/exports contain
  no deployment credentials or protection-bypass tokens.

## Task 11: Build, launch and show a macOS desktop application

- [ ] Add one verified desktop recipe (Electron or Swift chosen after toolchain
  probe) using the same project, process, dialogue and verification core.

Acceptance:
- A generated utility compiles and launches a real window from managed execution.
- Runtime/compile errors are captured and repairable; the primary user flow is
  checked using app-appropriate tests/accessibility rather than window presence.
- Stop/undo/restart preserves the user's other applications; packaging and
  signing requirements are reported separately from local launch.

Verification: compiled small utility, seeded runtime error, window/flow assertion,
owned-process teardown and reopen tests. Files: proposed
`src/coding/recipes/desktop.ts`, `src/coding/desktop-preview.ts`, recipe/test
fixtures and process integration.
Dependencies: 3–4, 6, 8; usable desktop SDK. Scope: medium.

## Task 12: Extend languages and deployment capabilities

- [ ] Register further adapters for verified Python, Rust, Swift, Go, Java,
  .NET or user-selected stacks; keep unsupported targets explicit.

Acceptance:
- Each enabled adapter passes detect/build/test/run/diagnostic conformance with
  a small real compiled/interpreted fixture on its target toolchain.
- Missing SDKs/foreign target OS are reported, with an explicit optional remote
  build path; a PATH stub does not count as usable support.
- Deployment capability maps workload to compatible hosting; no claim that
  every backend/language/native binary runs on Vercel.

Verification: per-language fixtures and unsupported-target matrix. Files:
recipe plugins, proposed `src/coding/capabilities.ts`, `src/coding/toolchains.ts`,
adapter conformance tests. Implement one adapter per small follow-on task rather
than modifying all languages simultaneously.
Dependencies: 5, 9–11. Scope: small per adapter.

## Task 13: Conform brains, budgets and lifecycle

- [ ] Add shared coding-tool/provider conformance and M2 resource/lifecycle tests.

Acceptance:
- All five text providers and Live voice offer applicable tools, obey project
  grants, preserve call/error evidence and handle blocked quota honestly.
- One writer/build default keeps voice/control-panel responsive; unrelated
  processes/files survive timeout, cancellation and shutdown.
- A future-provider fixture and new-tool fixture pass without separate
  feature-specific provider lists; live-model quality is measured separately.

Verification: offline conformance/replay plus authorized live trials per
available brain, resource pressure/port conflict/cancel/restart scenarios.
Files: provider tool/router/gate integration, proposed coding conformance test,
resource manager/session tests. Dependencies: 1–12. Scope: medium.

## Task 14: Record and evaluate complete build sessions

- [ ] Add project/revision links to dataset evidence and a held-out build-task
  evaluation suite with independently checked acceptance criteria.

Acceptance:
- Prompts/questions, decisions, patches, diagnostics, tests, previews and
  deployments are attributable to provider/model and project revision.
- Entire related tasks/projects are kept together for dataset splitting;
  raw successes are not automatically certified gold benchmark examples.
- Completion/repair/latency/resource measurements come from real runs, with
  failures and unsupported/blocked cases retained and reported.

Verification: export/replay fixture with multi-revision build and independent
flow checks; cross-split task/leakage checks and reviewer sample audit.
Files: dataset exporters/replay context, proposed
`src/_codingbenchmark.ts`, versioned evaluation fixtures/results schema.
Dependencies: 8–13. Scope: medium.

## Checkpoint D: Release

- [ ] End-to-end web, full-stack, seeded-bug, existing-repo and macOS app scenarios
  pass with actual evidence and documented supported targets.
- [ ] Existing Echo regression suites and production build pass.
- [ ] Benchmarks, known limits, resource behavior and deployment policy are
  reviewable; ship the usable capability matrix, not a universal guarantee.
