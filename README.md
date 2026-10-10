# Echo Mac

*Created by Deepak (AskDeepakAI)*

Echo is a macOS voice assistant with screen interaction, task execution, memory and a companion phone app. You can speak or type a request, inspect what it is doing in the Control Panel, and review results and approvals there.

This repository contains the implementation, renderer previews and test harnesses. Features depend on the selected model, installed helpers and macOS permissions. The code and checks below show what is implemented; they do not establish reliability across every app or task.

**Use requires permission.** See [Permission and use](#permission-and-use), including the recruiter exception.

[Setup](docs/GETTING_STARTED.md) · [Configuration](docs/CONFIGURATION.md) · [User guide and troubleshooting](docs/USER_GUIDE.md) · [Validation results](docs/VALIDATION.md) · [Architecture](docs/ARCHITECTURE.md)

## Capabilities and evidence

| Capability | Implementation | Checks and practical limits |
| --- | --- | --- |
| Screen interaction | [Screen tools](src/tools/registry/screen.ts), [Accessibility](src/tools/ax.ts), [computer actions](src/tools/computer-actions.ts) | [Targeting tests](src/_screentargettest.ts). Accessibility, OCR and screenshots provide different ways to locate controls; layouts, permissions and protected surfaces can still prevent an action. |
| Model selection | [Brain adapters](src/brain), [configuration](src/config.ts) | [Wiring tests](src/_wiringtest.ts). Hosted providers require credentials and available quota; local models require an installed service and sufficient resources. |
| Action checks and approvals | [Risk classification](src/safety/risk.ts), [tool gate](src/safety/gate.ts) | [Risk tests](src/_risktest.ts), [gate tests](src/_gatetest.ts), [tool architecture tests](src/_toolarchitecturetest.ts). Classification and grants reduce risk; they are not a guarantee against every unintended action. |
| Bots and background work | [Bots](src/frontier/bots.ts), [task service](src/frontier/swarm.ts), [agent fleet](src/frontier/fleet.ts) | [Bots tests](src/_botstest.ts), [fleet tests](src/_fleettest.ts). Bots use the existing task service and agent roles. Results still require review; interrupted work may need recovery. |
| Second Brain and conversation history | [Memory](src/memory), [history tests](src/_historytest.ts) | [Memory tests](src/_memtest.ts). Saved content can be recalled into model prompts according to the memory settings; see [data handling](docs/USER_GUIDE.md#data-handling). |
| Voice interaction | [Voice pipeline](src/voice) | [Voice tests](src/_voicetest.ts), [prosody tests](src/_prosodytest.ts). Microphones, wake detection, language routing and cloud voices need separate device/service checks. |
| Phone connection and handoff | [Remote service](src/frontier/remote.ts), [companion state](src/_controlcompaniontest.ts) | [Remote tests](src/_remotetest.ts). Mac control requires a paired relay and a running Mac. Echo Phone can also be used independently in Phone mode. |
| Web and research | [Research sources](src/tools/research.mjs), [research tests](scripts/research-test.mjs) | Search and fetched pages provide current source material when available. Availability, coverage and factual accuracy are separate questions; inspect the cited sources. |
| Run review and recovery | [Run journals and replay](src/agent-replay) | [Replay tests](src/_replaytest.ts), [recovery tests](src/_recoverytest.ts). Checkpoints support diagnosis and bounded recovery; an external side effect may not be reversible. |

The [tool registry](src/tools/registry.ts) is the source of truth for built-in tools. Configured MCP servers can add tools at runtime, so a fixed tool count does not describe every installation.

## Run an authorized local checkout

Echo currently supports **macOS**. Screen control and voice depend on macOS helpers and permissions; other operating systems are not supported.

```bash
brew install cliclick whisper-cpp
npm install
mkdir -p models
curl -L -o models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
npm run login
npm run doctor
npm start
```

This example uses the default local English recognition model and Claude login path. Configure a working brain before expecting responses. Follow the [setup guide](docs/GETTING_STARTED.md) for alternative providers, permissions and multilingual recognition.

## Verification

The [validation record](docs/VALIDATION.md) lists the commands run, results, code baseline and untested boundaries. Existing test files indicate coverage intent; a link to a test does not mean it was executed in the latest check.

```bash
npm run typecheck
npm test
```

The default runner discovers offline suites and isolates their data. Device, live-provider and renderer checks have separate commands. Filtered runs skip the runner's automatic typecheck, so run it explicitly. See [validation](docs/VALIDATION.md#reproduce-the-checks).

## Constraints to understand

- Screen actions depend on what an app exposes and what Echo can observe. A narrated action is not proof that the app accepted it.
- Approval policies and tool grants are implemented defenses. Review consequential actions and their results; snapshots only support undo for the actions they cover.
- Choosing a local model does not make every enabled tool or voice service offline. Web search, remote connections and cloud speech can still send data.
- Public intelligence feeds and research endpoints can be delayed, unavailable or incomplete. Model output is not a verified report simply because a task says it finished.
- The screenshots below demonstrate the renderer with fixtures. They do not prove live task completion or sustained production reliability.

## Screenshots

Current shipping renderers captured on October 10, 2026. Control-panel, agent and report data are sample fixtures; Osiris and Orbital show their public feeds. Captures run in isolated Electron storage with no real account, API keys, microphone or personal desktop. Click any screenshot to open it at full size.

**Main Echo HUD on the desktop**

[![Echo's floating desktop HUD](docs/screenshots/desktop-hud.png)](docs/screenshots/desktop-hud.png)

The shipping reactor HUD in its normal bottom-right position, shown against a clean desktop preview background. It floats above your work; the full Control Panel opens separately. [See the HUD close-up](docs/screenshots/hud.png).

| Page | Page |
| --- | --- |
| **Live Overview**<br><a href="docs/screenshots/overview.png"><img src="docs/screenshots/overview.png" width="480" alt="Echo Live Overview screenshot"></a> | **Now & Next / Needs You**<br><a href="docs/screenshots/day.png"><img src="docs/screenshots/day.png" width="480" alt="Echo Now & Next / Needs You screenshot"></a> |
| **Second Brain**<br><a href="docs/screenshots/brain.png"><img src="docs/screenshots/brain.png" width="480" alt="Echo Second Brain screenshot"></a> | **Bots**<br><a href="docs/screenshots/bots.png"><img src="docs/screenshots/bots.png" width="480" alt="Echo Bots screenshot"></a> |
| **Agents board**<br><a href="docs/screenshots/tasks.png"><img src="docs/screenshots/tasks.png" width="480" alt="Echo Agents board screenshot"></a> | **Missions**<br><a href="docs/screenshots/missions.png"><img src="docs/screenshots/missions.png" width="480" alt="Echo Missions screenshot"></a> |
| **World Intelligence**<br><a href="docs/screenshots/world.png"><img src="docs/screenshots/world.png" width="480" alt="Echo World Intelligence screenshot"></a> | **Models & Routing**<br><a href="docs/screenshots/models.png"><img src="docs/screenshots/models.png" width="480" alt="Echo Models & Routing screenshot"></a> |

<details>
<summary>Settings, reports and every additional visible window</summary>

| Page | Page |
| --- | --- |
| **Settings**<br><a href="docs/screenshots/settings.png"><img src="docs/screenshots/settings.png" width="480" alt="Echo Settings screenshot"></a> | **Agent roster**<br><a href="docs/screenshots/agents.png"><img src="docs/screenshots/agents.png" width="480" alt="Echo Agent roster screenshot"></a> |
| **Bot results**<br><a href="docs/screenshots/bots-results.png"><img src="docs/screenshots/bots-results.png" width="480" alt="Echo Bot results screenshot"></a> | **Task report**<br><a href="docs/screenshots/task-report.png"><img src="docs/screenshots/task-report.png" width="480" alt="Echo Task report screenshot"></a> |
| **API keys**<br><a href="docs/screenshots/setup.png"><img src="docs/screenshots/setup.png" width="480" alt="Echo API keys screenshot"></a> | **Voice HUD**<br><a href="docs/screenshots/hud.png"><img src="docs/screenshots/hud.png" width="480" alt="Echo Voice HUD screenshot"></a> |
| **Neural Core**<br><a href="docs/screenshots/neural.png"><img src="docs/screenshots/neural.png" width="480" alt="Echo Neural Core screenshot"></a> | **Synaptic Field**<br><a href="docs/screenshots/synapse.png"><img src="docs/screenshots/synapse.png" width="480" alt="Echo Synaptic Field screenshot"></a> |
| **Osiris globe**<br><a href="docs/screenshots/osiris.png"><img src="docs/screenshots/osiris.png" width="480" alt="Echo Osiris globe screenshot"></a> | **Orbital feed**<br><a href="docs/screenshots/orbital.png"><img src="docs/screenshots/orbital.png" width="480" alt="Echo Orbital feed screenshot"></a> |

</details>

Regenerate with `node_modules/.bin/electron scripts/readme-screenshots.mjs` after building. This uses the existing preview bridge and never starts Echo’s runtime. Invisible capture/transport windows are not user pages.

**HUD state preview:** [video](docs/echo-hud-states.mp4), rendered from the shipping assets and state values in `renderer/hud.css`. It demonstrates animation states rather than a recorded end-to-end task.

## Permission and use

Echo is published here to be read and reviewed. It is **not** open source, and there is no
licence granting you the right to use it.

**Using it without permission is strictly prohibited.** That covers running it(exception for recruiters), copying it,
building on it, publishing it, and reusing any part of it — the code, the renderer, the
artwork in `assets/`, the recordings in `docs/media/`, or the design — for any purpose,
personal, academic or commercial, unless the author has given you written permission.

Ask first: **Deepak (AskDeepakAI)**, [@thedeepakreddy](https://github.com/thedeepakreddy).
