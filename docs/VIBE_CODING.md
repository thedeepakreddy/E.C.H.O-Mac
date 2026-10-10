# Vibe coding with Echo

[README](../README.md#vibe-coding-with-a-human-in-the-loop) · [Setup](GETTING_STARTED.md) · [Validation](VALIDATION.md)

Echo's coding tools let a configured model work on an actual software project through conversation. You describe the outcome and make important product decisions; Echo can inspect, edit, execute, preview and verify the work. Human review remains part of deciding whether to keep, distribute or deploy the result.

## Start with a concrete goal

Useful requests include:

- “Build a personal expense tracker with a local database, monthly totals and tests. Show me a working preview before publication.”
- “Open this project, reproduce the login bug, fix its cause and rerun the affected checks.”
- “Add keyboard support to this calculator and test invalid input and division by zero.”
- “Review this codebase, explain the main risks and propose a plan before editing.”

Specify the project or path, the behavior you want, constraints that matter and what would count as success. An explanation or review request does not necessarily start a background build. Clear complex action requests can be recognized by [automatic task planning](../src/tasks/automatic.ts); ambiguous goals stay in conversation for clarification.

## How the work is connected

The [coding registry](../src/tools/registry/coding.ts) exposes project, file, process, preview, verification and deployment tools to Echo's model adapters. Existing project-build entry points use the [supervised task workflow](../src/tasks/supervisor.ts), so coding does not require a separate reasoning engine or a user-enabled supervision mode.

| Stage | Echo's tools and behavior | Your involvement |
| --- | --- | --- |
| Requirements | Open or create a project; save specification, decisions and acceptance criteria. | Explain desired behavior and answer material questions. |
| Implementation | Read/search files; apply patches with expected hashes and revisions; inspect diffs. | Review direction and request changes as needed. |
| Execution | Start owned processes, collect logs and actual exit status, run configured checks. | Supply missing toolchains or credentials where necessary; review consequential operations. |
| Preview | Serve a supported project locally; inspect DOM, console and network observations; exercise exact controls. | Try the app yourself and identify behavior that needs improvement. |
| Inspection | A separate model context reviews real evidence and can request bounded repairs. | Review assumptions and the final report; model review does not replace your judgment. |
| Handoff | Preserve project files, results, checks and unresolved blockers. | Decide what to keep, change or publish. |

New projects can be created under `~/EchoProjects`; an explicit path opens an existing project. [File operations](../src/coding/files.ts) support paginated reads, bounded searches, guarded patches and conflict-aware undo. A patch that would overwrite newer content is refused. Git status and worktree tools can inspect or isolate work without discarding existing dirty files.

Managed [processes](../src/coding/processes.ts) return IDs, bounded logs and real exit status. A started process is not automatically a successful build. Echo's provider keys are excluded from child environments, but executed project code still has the user's operating-system access.

## Keep the human in the loop

Echo can persist a blocking build question and suggested options. The answer is checked against the pending question and saved into project decisions. Voice and typed input share the coordinator. You can inspect progress, request changes, and use the task controls to stop active work; saved state and partial output remain available for review.

For a useful collaboration, state what should require your decision: design direction, storage of private data, changing a public API, paid services or publication. Echo's risk policies provide action checks and confirmation paths, but context and classification still matter. Inspect approvals and the resulting state.

The inspector is another model-based role with a separate context and restricted tools. It can inspect original results rather than accepting a worker's summary as proof. The final guard rejects missing, fabricated or stale evidence. Repair attempts and time budgets are bounded; unresolved problems produce a blocked report rather than a guaranteed finish.

## Verification means observable checks

[Completion checks](../src/coding/diagnostics.ts) require successful current configured checks and evidence for each saved acceptance criterion. Source fingerprints invalidate evidence after relevant changes, including edits outside Echo.

For web projects, the [preview tools](../src/coding/preview.ts) can fill or click an exact control and assert its text or value. This lets a request such as “the total changes after adding an expense” be checked against the rendered app. HTTP readiness or file existence alone does not establish that behavior.

The preview window uses isolated browser storage without Echo's preload or Node access. It is a basic inspector for supported local flows, not comprehensive automation of every website. Native application verification requires available compilers and observable application behavior.

## Project support and publication

Project recipes cover static web and configured Node/Python commands, with detection or command support for Swift, Rust, Go and other manifests. Missing dependencies, SDKs or meaningful checks can block work. Detection is not evidence of successful generation for every language or framework. Custom projects can define commands in `echo.project.json`; see the [implementation notes](voice-coding-2026-10-02.md).

The [Vercel adapter](../src/coding/vercel.ts) prepares a reviewable, bounded file manifest and supports preview submission after authorization. It needs privately configured credentials and accessible project identifiers. It is not a production-deployment tool. Uncertain submissions are not automatically repeated, and a provider's ready state does not verify the deployed user flows.

Before publishing, review the diff, test evidence, data handling, required secrets, deployment target and outstanding blockers. The human decides whether those checks are sufficient for the intended use.

## Evidence and AGI-like behavior

Relevant harnesses include [coding conformance](../src/_codingconformancetest.ts), [project files](../src/_codingfilestest.ts), [diagnostics](../src/_codingdiagnosticstest.ts), [dialogue](../src/_codingdialoguetest.ts), [supervision](../src/_supervisedtest.ts) and [automatic routing](../src/_automatictasktest.ts). The [validation record](VALIDATION.md) identifies which checks were actually executed; links alone are not test results. This documentation addition did not run new live builds or benchmarks.

Coding illustrates Echo's [AGI-like working process](../README.md#agi-like-skills-what-that-means-here): interpret a goal, retain decisions, plan, use tools, inspect feedback and revise. This describes an implemented assistant workflow. It does not establish general intelligence or the ability to produce correct arbitrary software without review.
