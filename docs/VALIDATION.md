# Validation record

[README](../README.md) · [Architecture](ARCHITECTURE.md)

This record separates source inspection, executed tests and untested behavior. It is a focused repository check, not a full code audit, independent security review or production reliability measurement.

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
