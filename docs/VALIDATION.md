# Validation record

[README](../README.md) · [Architecture](ARCHITECTURE.md)

This record separates source inspection, executed tests and untested behavior. It is a focused repository check, not a full code audit, independent security review or production reliability measurement.

For the later October 15 local reliability work, see
[acceptance boundaries](RELIABILITY_ACCEPTANCE.md) and
[the current repair checklist](../tasks/audit-reliability-2026-10-14/todo.md).
The older results below are historical, not evidence for the current dirty build.

October 15 final local gate: Mac `npm run ci:offline` passed 156/156 groups
(including typecheck) in 175 seconds, then build passed. Phone's guarded
`ci:offline` passed 240/240 tests. Selected isolated Mac Office/report and Phone
Office/Retry/report-Retry/trackpad browser fixtures passed. Runtime was Node
v26.8.2. These are local dirty-checkout results, not a committed/deployed revision
or native Calculator, audible voice, multi-display or physical-iPhone proof.

## Technology upgrade checked on November 14, 2026

Same environment as the entry below: a Linux container with Node.js `v22.23.4`, plus a virtual display (`xvfb`) so Electron itself could run. The code under test is the upgraded stack: Electron 45.3.2, TypeScript 7.0.2, esbuild 0.28.2, `@anthropic-ai/claude-agent-sdk` 0.3.325, `@google/genai` 3.3.0, `openai` 7.57.0, `@modelcontextprotocol/sdk` 1.32.2.

| Executed check | Before the upgrade | After |
| --- | --- | --- |
| `npm run typecheck` | Passed, about 8s | Passed, about 1.5s |
| `npm test` | 157/161 | 157/161, the same four environment-bound failures |
| `npm run build` | Completed | Completed |
| The real app launched under `xvfb` with `JARVIS_NO_VOICE=1` and an empty data folder | Window created, brain ready, HUD loaded | Identical startup lines, no new warnings |
| `npm run test:ui` | 6/10 on Electron 33 | 6/10 on Electron 45, the same six |

The four UI suites that fail do so on both Electron versions here. `test:calculator-ui` and `test:panel-office` write to paths that exist on macOS, `test:panel-world` fails a layout assertion with this container's fonts, and `test:panel-bots` fails because the 3D office renders slowly enough under software WebGL that a submit button is still disabled when the fixture clicks it. That last one was run six times on each Electron version under identical conditions and failed at the same assertion all twelve times, so it is not attributed to the upgrade. Whether it passes on a Mac at this revision was not established: run `npm run test:panel-bots` there.

Chromium no longer falls back to software WebGL by itself, so `scripts/test-gl.mjs` enables it for the 3D fixtures off macOS. Without it `test:panel-companion` failed on Electron 45 on a console error from `THREE.WebGLRenderer`; with it the suite passes as it did on 33.

Real model calls were made in this round, which the earlier entry had none of. Credentials for Claude were available in the environment:

- A turn through `createBrain` on the default configuration called the `list_scheduled_tasks` tool through the gate and answered from its result.
- `claude.keepWarm` was timed over four runs of four turns. Time to first text on turns after the first: about 3.8s without it (3835, 3895, 3851, 3633, 3687, 3781 ms) and about 2.3s with it (2897, 2297, 2225, 2188, 2270, 2235 ms). No run produced an error.

Electron's breaking-change notes for versions 34 through 45 were read against every Electron API the source calls; the commit that performs the upgrade lists what changed and what was checked and found unaffected.

Not verified by this round: anything on macOS, including the native helpers, voice, screen control and the Keychain-backed ChatGPT sign-in on the new Electron; Gemini, OpenAI, OpenRouter, NVIDIA or Ollama against their real services on the new SDKs; a real MCP server; the phone remote's screen capture. The size of the keep-warm saving on a Mac is not measured.

Required before Electron 46: `src/brain/chatgpt-auth.ts` stores the ChatGPT sign-in with the synchronous `safeStorage` calls, which Electron 45 deprecates and 46 removes. It must move to `isAsyncEncryptionAvailable`, `encryptStringAsync` and `decryptStringAsync`. Until then the code refuses to save a sign-in on an Electron that lacks the synchronous calls, rather than fall back to an unencrypted file.

## Check performed on November 13–14, 2026

Baseline: `main` at `1220956`. Runtime: a Linux container, Node.js `v22.23.4`. This is not macOS, so nothing here exercises voice, screen control, native helpers, Electron windows or a live model.

| Executed check | Result | Scope |
| --- | --- | --- |
| `npm run typecheck` | Passed | TypeScript project checking. |
| `npm test` at the baseline, before any change | **155/159** | Offline suites with controlled dependencies. |
| `npm test` after the changes | **157/161** | The same suites plus two new ones (`localllmtest`, `schedulestest`). |
| `npm run build` | Completed | Bundles main and preloads; native helpers are skipped off macOS. |

The four suites that fail do so identically before and after, for reasons in the environment rather than the code: `composetest` looks for installed macOS applications (Safari, Chrome, Finder, Terminal), and `embedtest`, `toolroutertest` and `autoreflextest` need the local embedder in `models/embed/`, which could not be downloaded from this network. They were not made to pass and should be re-run on a Mac with `npm run embedder` done.

A static pass with typescript-eslint (floating promises, misused promises, unsafe `finally`, exhaustive switches) was run over the non-test source outside the project; it is not a project dependency. It reported 26 findings, of which the `return` inside `finally` in `brain/claude.ts` and three unhandled rejections were fixed. The remainder are intentional (`setInterval` callbacks that catch internally, switches with a default).

New or extended assertions in this round: `exittest` 53 (was 31), `modelhealthregressiontest` 15 tests (was 13), `memoryostest` 137 (was 125), `personatest` 65 (was 42), `supervisedtest` 62 groups (was 59), `schedulestest` 26, `localllmtest` 7, plus team cases in `botstest`.

Not run in this round: every UI, live and device suite; the `claude.keepWarm` option against the real SDK (its tests use a stand-in for the SDK stream, and its effect on latency is unmeasured); a scheduled task on a real provider; whether a given model follows the character guidance.

## Check performed on October 10, 2026

Baseline: GitHub `main` at `4ddebf6` (`Update usage policy in README`), with the remote test fixture correction included in this documentation update. Runtime: macOS, Node.js `v26.8.2`.

The initial typecheck found three errors in `src/_remotetest.ts`: an obsolete `remoteAssetDir` import, a missing `readFileSync` import and an undefined relay fixture. The fixture also omitted the relay required by `startRemote`. These test-only references were corrected; no application runtime or renderer behavior changed.

| Executed check | Result | Scope |
| --- | --- | --- |
| `npm run typecheck` | Passed | TypeScript project checking; no live provider calls. |
| Selected offline suites below | **13/13 passed in 18 seconds** | Controlled dependencies, temporary test data and loopback transport where needed. |

The selected suites were `replaytest`, `recoverytest`, `risktest`, `remotetest`, `gatetest`, `wiringtest`, `fleettest`, `intelwiringtest`, `codingrecoverytest`, `toolarchitecturetest`, `supervisedwiringtest`, `controlcompaniontest` and `botstest`. Substring filtering also selected the additional wiring and recovery suites.

Reported assertion tallies included 170/170 risk checks, 24/24 gate checks, 73/73 wiring checks, 24/24 fleet cases, 130/130 remote checks, 43/43 recovery checks and 24/24 companion checks. These tallies describe these harnesses, not percentages of overall product correctness.

## What this supports

| Claim | Source and executed evidence | Boundary |
| --- | --- | --- |
| Tool execution has risk checks and grants | [gate](../src/safety/gate.ts), [risk tests](../src/_risktest.ts), [gate tests](../src/_gatetest.ts), [architecture tests](../src/_toolarchitecturetest.ts) | Tests exercise known commands and controlled provider/tool paths. Unknown app consequences and unrecognized command patterns remain possible. |
| Bots use the existing task service | [Bots implementation](../src/frontier/bots.ts), [Bots tests](../src/_botstest.ts), [fleet tests](../src/_fleettest.ts) | Fixtures cover routing, dependencies, grants, lifecycle and results. Real model quality and sustained workloads were not measured. |
| Phone voice delivery waits for transcription and dispatch | [remote service](../src/frontier/remote.ts), [remote tests](../src/_remotetest.ts) | Tests exercise HTTP uploads, auth, local relay transport and injected transcription. They do not test a real phone microphone, cloud recognizer or deployed relay. |
| Companion state and handoff are wired | [companion tests](../src/_controlcompaniontest.ts), [wiring tests](../src/_wiringtest.ts) | Controlled state does not prove real-device notifications are timely or received. |
| Recorded runs support replay and bounded recovery | [replay](../src/agent-replay), [replay tests](../src/_replaytest.ts), [recovery tests](../src/_recoverytest.ts) | Recorded or simulated outcomes do not guarantee safe recovery from every external side effect. |

## Not checked in this run

- The complete offline suite, live-provider suites, device suites and Electron renderer suites.
- Wake accuracy, accent/language performance, microphone capture, audible speech quality, latency and interruption on physical devices.
- Live model authentication, subscription eligibility, quota behavior and task quality across providers.
- Real app control, protected surfaces and Accessibility behavior under changing layouts.
- Deployed Phone relay availability, actual phone-to-Mac voice responses and notification delivery.
- Long-running workloads, memory growth, load testing, external side-effect rollback or an independent security review.

The [README gallery](../README.md#screenshots) uses isolated renderer captures with sample data, except labeled public feeds. It demonstrates the UI, not successful live execution of the tasks shown. Historical feature-specific checks in [Bots integration notes](bots-integration/usage.md) have their own scope and are not a fresh full-suite result here.

## Save-for-training alias check on October 10, 2026

Baseline: `main` at `b69b79d`, with the explicit “save yourself for training” alias and shared dataset-intent matcher added in this update. Typechecking passed. `npm test -- datasetexporttest localtest codingdatasettest` passed **3/3 suites in 2 seconds** using isolated data.

`npm run build` also passed. It reported the existing duplicate `researchtest` key in `package.json`; that script definition was not changed in this update. Generated native binaries were not included in the commit.

The export fixture checks that a repeated save includes a newly recorded training example, produces a new snapshot path and leaves the earlier snapshot intact. Routing checks force an unrelated tool to rank first under mocked semantic embeddings and limit the local tool budget to one tool; the dataset-export action remains available for the exact phrase. Existing export privacy, gap, provenance and coding-evidence checks also passed. The local model harness reported 19/19 checks.

These checks do not exercise a live model interpreting microphone input. The alias makes the existing export tool explicit and reachable; model/tool execution, permissions and recording availability still determine the outcome. No personal dataset was exported by these tests, and no training or paid model job was started.

## Reproduce the checks

```bash
npm run typecheck
npm test -- risktest gatetest toolarchitecturetest wiringtest botstest fleettest remotetest replaytest recoverytest controlcompaniontest
```

The runner selects test names by substring. Filtered runs do not automatically include typechecking. [scripts/test-all.mjs](../scripts/test-all.mjs) gives each suite temporary data, a deadline and a process group. Offline mode disables MCP and uses a network guard; loopback fixtures remain available.

For broader checks:

```bash
npm test                 # typecheck plus discovered offline suites
npm run test:live        # real remote services; credentials and quota may be used
npm run test:device      # audio, local models, screen and macOS permissions
npm run test:panel-bots
npm run test:panel-markdown
```

At this baseline, the script inventory discovers 115 offline, 8 live and 7 device suites, excluding the automatic typecheck and separately invoked renderer checks. Inventory size is not a result. Inspect [test mode definitions](../scripts/test-modes.mjs) and `package.json` when the repository changes.

The build uses esbuild and can succeed with TypeScript errors. Run typechecking explicitly when validating a build. Renderer previews and screenshot scripts should use isolated storage and fixtures; they should not connect to personal accounts just to generate documentation.

Future release records should identify the code baseline, machine/runtime, exact commands, failures and remaining limits. Device and live-service evidence should name the conditions tested, without publishing credentials or private task content.
