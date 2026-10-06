# Echo voice coding implementation — 2026-10-02

The first implementation is built into Echo's common tool registry and main
voice/typed dispatch. The original 14-task acceptance plan remains in
`tasks/todo.md`; implementation does not imply every release acceptance test
has passed. No model, framework or Docker runtime was installed. VibeVoice
remains paused.

## Available workflow

Ask Echo to create a website or application. `open_project` creates a named
project in `~/EchoProjects` when no path is supplied, or opens an explicit
external project. Save requirements and acceptance criteria, inspect its
recipe, and start a background project build. The selected brain is used;
there is one active coding writer and at most four managed project processes.
Main Echo remains available for status, answers and changed requirements.

The worker can ask a persisted question with suggested options. Voice and typed
answers use the same coordinator. “Pause coding” interrupts the worker and
retains servers; “Stop coding” also stops its owned processes. “Resume coding”
resumes saved project work. Ordinary unrelated questions go to the main brain.

Changes use UTF-8 paginated reads, content hashes, atomic single-file patches,
project revisions, bounded search and conflict-aware undo. Git worktrees use
argument arrays; existing dirty source stays intact. Recovery inventories
saved questions/processes/deployments before repeating side effects. Unknown
or reused saved PIDs are never signalled.

Managed execution returns immediately, streams bounded logs, supports stdin,
real exit status, timeout and process-group cleanup. macOS interactive commands
use a tested Python PTY bridge. Child environments exclude Echo's provider
keys. Project directories are **not an operating-system security sandbox**:
executed project code has the user's OS access.

Static sites and configured Node/Python projects can be served locally and
shown in a separate isolated browser window. It has no Echo preload or Node
access, denies permissions/downloads/new windows, and scopes top-level
navigation to the preview origin. DOM controls/text, console messages and
network outcomes can be inspected; exact selectors support fill/click flows.
This is a basic preview inspector, not a complete browser automation suite.

Checks record actual exits and a source fingerprint. Changes made outside Echo
also invalidate old evidence. Repeated unchanged failures stop after three
matching failure signatures. Completion requires current configured checks
and evidence for each saved acceptance criterion. Evidence remains an agent
observation, requiring independent review before benchmark certification.

## Supported capabilities and limits

| Area | Implemented | Evidence / remaining validation |
|---|---|---|
| Project/files/Git | Saved sessions, grants, revisions, guarded edits, undo, worktrees | Isolated fixtures pass; full crash/restart side-effect matrix remains |
| Processes | Pipes, macOS PTY, output bounds, owned group stop, timeout | Real executable/PTY fixtures pass; heavy-model/voice pressure trial remains |
| Web preview | Static server and configured dev/start commands, isolated window, inspection/actions | Actual browser form flow, console/network and privilege isolation pass |
| Repair | Recorded checks, source invalidation, repeated-failure budget | Seeded JavaScript syntax repair passes; broad autonomous repair quality unmeasured |
| Full stack | Explicit Python/other commands in `echo.project.json` | Python UI → API → SQLite flow and restart persistence pass in a labelled prototype fixture; production auth/services are project-specific |
| Desktop | Detected Swift commands and configured application start | Actual Swift compile and visible macOS window pass; signing, packaging and other OS targets not tested |
| Languages | Node package scripts, static web, Python check, Swift/Rust/Go manifests, simple Java/CMake commands, explicit custom commands | Only available compiler/SDKs can run; Rust/Go/Java/CMake end-to-end quality not measured; language detection is not universal support |
| Vercel | Private token setting, bounded preview submission, deployment ownership/status and uncertain-retry refusal | Mock lifecycle passes. Token, real project/team and live deployment/protection/log validation remain required. No production deployment tool; larger file-upload adapter not implemented |
| Brains | Common tools/router/gate; compact exact-schema discovery/invocation for small-context brains | Offline schema/routing/gate conformance passes; live build trials per provider/model and latency/resource benchmarks remain |
| Dataset | Sessions, patches, process/check/preview/deployment evidence and project split index | Export/forget fixture passes; gold remains empty/unreviewed; independent benchmark review and leakage audit remain |

For custom entrypoints, create `echo.project.json`, for example:

```json
{"language":"Python","commands":{"start":{"program":"python3","args":["server.py"]},"check":{"program":"python3","args":["-m","compileall","-q","."]}}}
```

All commands still pass the shared gate. Missing toolchains/credentials,
unsupported checks and unavailable services are explicit failures. Dependency
installation requires at least 2 GiB free; it is not a prediction of a specific
framework's final disk requirements. Historical recordings grow with saved
work; in-memory process output and retained live handles are bounded.

## Vercel setup

Enter **VERCEL_TOKEN** privately in Echo's API key settings when ready, and
provide the project identifier and optional team identifier. Prepare the file
manifest before authorizing publication. Hidden files, apparent secrets and
private storage are refused; inline submission is limited to 100 files/1 MiB.
A provider `READY` state is not proof that a protected URL or app flow works.

The adapter follows the current official [deployment creation API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)
and [deployment status API](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url).
Credentials are used only in request headers, not process arguments or saved
session metadata. An uncertain remote submission refuses automatic resubmission.

## Validation

`npm test -- coding` runs the coding fixtures, including loopback/PTY tests that
need local OS/network permissions. `npm run test:coding-ui` exercises the actual
isolated browser and Python form/database flow. `npm run test:coding-desktop`
compiles and briefly opens the isolated Swift fixture. They create temporary
projects and stop their owned processes. No paid brain generation or live
Vercel deployment was used in these tests.

Shared gate, memory, local-tool, routing, context, wiring, dataset, task-progress
and shutdown regression checks passed. TypeScript and production builds pass.
Ruflo/ToolSearch capabilities requested by AGENTS.md were not available in the
enabled tool inventory; no Ruflo orchestration was invoked.

## Improvements after the calculator trial

The real calculator run exposed a project-name/UUID mismatch, file-only task verification, repeated Gemini quota fallback, and arithmetic returning `Infinity`. These paths are now corrected:

- Exact unique owned project names resolve to canonical UUIDs before gate resource locks. Unknown, ambiguous and ungranted references fail. UUIDs remain the preferred durable reference.
- Showing a project starts its managed preview when needed. Restart recovery can reuse an owned identity-checked running server only when its recorded output matches a saved loopback URL and HTTP responds. A failed readiness check does not authorize a duplicate server.
- `assert_project_preview` checks actual DOM text/form values with an exact selector, fails on mismatches, checks source freshness and can save the observed assertion as acceptance evidence. `verify_task` cannot certify a coding app from file existence while current checks/acceptance evidence are missing. Acceptance observations still require review before gold dataset certification.
- Coding memory packets have a 4,000 estimated token ceiling; other shared memory packets have an 8,000 token ceiling. Current project IDs/revisions and requirements travel with the coding packet. Full transcripts/task results remain available through inspection/history tools. Cloud recall disabled does not disclose earlier project specs through the new summary.
- Gemini retains the successful fallback for the remaining steps of the same turn, instead of retrying the exhausted first model on each step.
- `inspect_vercel_connection` makes an authenticated GET and returns only accessible project IDs/names. The saved live token authenticated successfully; its default scope returned zero projects. No remote deployment was made, and deployment permission has not been proven.
- The user's calculator was patched reversibly (`0aa30e1b-ed2e-49da-90ed-d39f9a31f0a8`), removing `eval`, adding finite/zero-division checks, error recovery, decimal/keyboard input and viewport metadata. Its source exactly matched the tested fixture. The source check passed, current browser evidence was recorded and the project finalized at revision 11.

Validation: 21 selected offline fixtures passed (two HTTP socket fixtures required unsandboxed loopback access); the isolated Electron calculator test exercised 12 actual button flows, error recovery, new entry, keyboard input, 320px display fit, assertion mismatch refusal and preview process recovery. Typecheck and production build passed. Recorded first calculator request: 69 tool schemas, 41,714 schema characters, 74,819 system characters, including 47,896 memory-packet characters. Prompt ceilings reduce repeated memory; end-to-end live latency and per-provider build quality need a fresh trial after restarting Echo.

The built source is ready for restart. Automatic approval review could not perform the running-process inspection due to an account usage-limit error, so a running Echo instance was not restarted or asserted to be using the new build.
