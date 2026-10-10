# Echo Mac

*Created by Deepak (AskDeepakAI)*

> **Not open source.** Echo is published here to be read, not taken. **Using it without
> permission is strictly prohibited** — see [Permission and use](#permission-and-use).

Echo is a voice assistant that lives on your Mac's screen and **does things for you**. Say
"Echo", ask for something, and it looks at your screen, clicks, types, opens apps, searches
the web, runs code and answers out loud, narrating each step so you can watch it work.

```
 you speak ─► "Echo" wake word ─► speech-to-text ─► BRAIN (Claude / Gemini / GPT / local) ─► voice reply
                                                        │
                                  140 tools: see the screen · click · type · open apps · search the web
                                  remember · run code · background agents · phone remote · world intel …
                                                        │
                                  every action passes one RISK GATE: risky ones need your spoken "yes"
```

**Demo — the HUD state machine:** [`docs/echo-hud-states.mp4`](docs/echo-hud-states.mp4)
(rendered from the shipping assets using the per-state values in `renderer/hud.css`).

**Engineering deep dive:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the mechanisms,
the invariants that hold them together, and the failures each one exists to prevent.


## Screenshots

Current shipping renderers captured on October 10, 2026. Control-panel, agent and report data are sample fixtures; Osiris and Orbital show their public feeds. Captures run in isolated Electron storage with no real account, API keys, microphone or personal desktop. Click any screenshot to open it at full size.

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

```bash
brew install cliclick whisper-cpp        # mouse/keyboard control + local speech-to-text
npm install                              # dependencies
curl -L -o models/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin   # speech model (multilingual)
npm run login                            # sign the Claude brain in (or add a Gemini key, see §4)
npm start                                # build and launch
```

Then:

1. **Grant permissions** when macOS asks: Screen Recording, Accessibility, Microphone (see [§11](#grant-macos-permissions)).
2. **Say "Echo"** and a request, e.g. *"Echo, what's on my screen?"*
3. No microphone? Type into the box on the HUD. It always works.

Optional extras, each one command: offline voice (`npm run piper:setup`), private web
search and system health (`npm run selfhosted:setup`), and your own copy of the world map
(`npm run osiris:setup`). See [§11](#optional-add-ons).

---

## 2. What Echo can do

Echo has **140 tools**, grouped the same way as the code (`src/tools/registry/`):

| Area | What it means in practice | Examples |
|---|---|---|
| **See and control the Mac** | Reads the screen three ways (the accessibility tree, on-device OCR, screenshots), then clicks, types and scrolls anywhere | *"Open Safari and search flights to Hyderabad"*, *"click Export"*, *"set brightness to 60"* |
| **Memory** | Remembers facts, what was on your screen, pages you asked it to scan, and your files, all searchable by meaning | *"Remember my passport expires in March"*, *"what was that error I saw an hour ago?"* |
| **Safety** | Asks before anything irreversible and can undo recent actions | *"Undo that"*, *"what did you just do?"* |
| **Background agents** | Sends work to a team of agents running in parallel while you keep talking | *"Research three laptops and write me a comparison"* |
| **Skills and workflows** | Learns a task by watching you once, then repeats it; voice shortcuts; routines | *"Watch me do this"*, *"run my morning workflow"* |
| **Knowledge** | Private web search, world news and satellites, a live world map, overnight research, calendar, translation | *"Any earthquakes today?"*, *"when does the ISS pass over me?"* |
| **System** | Shell, files, Mac settings, health report, brain and voice switching | *"How's my Mac doing?"*, *"turn on dark mode"* |
| **Remote** | Control the Mac from your phone, hand off to your iPhone, send messages | *"Open phone remote"* |
| **Ambient** | Notices when you step away or get stuck; gestures, eye tracking, meeting notes, companion mode | *"Away mode"*, *"toggle hand gestures"* |

Echo is not scripted per app. It drives any app with one loop: **look → find the control →
read its current value → pick the most reliable input → act → check the result.**

---

## 3. Talking to Echo

### Waking it up

- **Say "Echo"**, then your request in the same breath: *"Echo, open my email."* "Hi Echo",
  "Hey Echo" and "Hello Echo" work too.
- **Just the name** (*"Echo."*) makes it answer "Yes?" and wait for your request.
- **Push-to-talk:** click the reactor core or press **⌘⇧J**.
- **Stop it:** talk over it (barge-in), say "stop", or press **⌘⇧.**

After Echo answers, a **conversation window** stays open (12 s by default; set
`voice.conversationWindowMs`, up to 60 s), so you can reply without saying "Echo" again.

Two detectors listen for the name. An **acoustic detector** matches the sound of "Echo"
against voice samples: record your own with `npm run enroll`, which improves it a lot. A
**transcript check** looks for the name in what Whisper heard; it is tuned against real
recordings of this machine's user, including the ways Whisper mishears "Hi Echo" ("Hi, Ko",
"Hi, Code").

### Languages and voices

Echo detects which language you spoke, on your Mac, and answers in the matching voice:

| You speak | What answers | Voice |
|---|---|---|
| **English** | the normal pipeline: your brain + local voice | **Piper** (offline neural voice; Northern English male here) |
| **Telugu, Hindi, Tamil, Farsi, any other language** | **Gemini Live**, which hears the audio directly | **Charon** (a Gemini male voice) |

- **Written replies in other scripts:** if a reply contains Telugu or Hindi text, those
  sentences are spoken by Gemini's voice (Piper only speaks English).
- **Detection:** Whisper's language ID, with a threshold tuned so accented English is not
  mistaken for Urdu or Hindi. It adds about 0.45 s, and only to turns Echo is actually answering.
- **Settings:** `voice.realtime` and `voice.ttsEngine` in the config ([§12](#12-configuration)).

That table is the map. For how the pieces actually behave — the loop's exit contract, the
single gated path to every tool, task leases and crash recovery, deterministic replay, and
the wake-word logic — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Setup

---

## 4. Brains (the AI models)

| Brain | Needs | Notes |
|---|---|---|
| **Claude** | `npm run login` (uses your Claude subscription) or `ANTHROPIC_API_KEY` | Runs through the Claude Agent SDK |
| **Gemini** | `GEMINI_API_KEY` | Can hear audio directly; also powers Gemini Live and the Gemini voices |
| **OpenAI (GPT)** | `OPENAI_API_KEY` | |
| **Local (Ollama)** | [Ollama](https://ollama.com) running locally | Free and offline; smaller models are less capable |

**Switch by saying the name:** *"Gemini."*, *"switch to Claude"*, *"use the local model"*.
The switch is instant (no restart) and is saved for next time. It only triggers when the
name is the whole command, so *"ask Claude what it thinks"* is an ordinary request.

> **Free Gemini keys** allow about 20 requests a day **per model**. Echo walks a list of
> fallback models (`GEMINI_MODEL_FALLBACKS` in `src/brain/types.ts`), but a heavy day can
> still run out. If Echo suddenly stops answering, check the quota first.

---

## 5. Safety

Every action any brain or agent takes goes through **one risk gate** (`src/safety/gate.ts`):

| Risk | Examples | What happens |
|---|---|---|
| **Low** | reading the screen, searching, recalling | Runs |
| **Medium** | clicking, typing, opening apps, ordinary shell commands | Runs and is shown in the action log |
| **High** | deleting files, sending messages, buying, `rm -rf`, reading credential files | **Echo asks you out loud and waits for "yes"** |

- **Classified by capability, not by command name.** A delete is high risk whether it's
  `rm`, `unlink` or a script.
- **Second opinion (optional):** a TypeSafe ("Jev") check can only make a rating *stricter*,
  never looser.
- **Undo:** snapshots let Echo undo recent actions (*"undo that"*).
- **Secrets:** they are scrubbed before anything is logged or remembered.
- **Credentials:** Echo never types passwords or card numbers; it stops and asks you to.
- **Known gap:** voice shortcuts in `shortcuts.json` run shell commands without going
  through the gate. Only add shortcuts you trust.

---

## 6. Memory and learning

- **Facts:** *"remember that…"* / *"what do you know about…"*. Stored locally in
  `~/.jarvis/memory`, scoped to the project you're working on, and searchable by meaning
  (a local embedding model; nothing is sent out).
- **Episodic memory:** what happened and how much it mattered; frequently used facts are
  promoted over time.
- **Shared conversation:** Claude, Gemini, OpenAI, Ollama and realtime voice use the
  same saved conversation for the current project. Changing brains or restarting
  preserves recent messages, user constraints and task outcomes. The working
  history is initially seeded from the latest 20 real task recordings for that
  project; private recordings and test runs are excluded. The working
  context starts at **128,000 tokens**, including instructions, tools and history;
  16,000 tokens are reserved for output. At 75% of capacity, completed tool rounds
  compact into current task state and an extractive rolling summary. Original
  messages remain available through `conversation_history`. Private turns are
  excluded; memory/cloud-recall settings and forgetting apply to the archive.
  Local model capacity is read from Ollama and capped at 8,192 tokens on Macs
  with 8 GB RAM or less (16,384 on larger machines). Local requests use a compact
  prompt and relevant tools that fit this budget; the Stop button cancels inference.
  Claude's SDK session compaction is
  configured with the same window target; its internal history is managed by the SDK.
- **Scan this page:** *"scan this"* keeps a permanent, searchable copy of whatever is on screen.
- **Screen history:** *"what was on my screen when…"*, *"what changed while I was away?"*
  New background capture is opt-in with `helpers.screenHistory`; existing history
  remains searchable. Captures default to two minutes apart, never overlap, and
  pause while the Mac sleeps, the screen is locked, or a private task is active.
- **Your files:** *"index my files"*, then *"find the contract with Acme"*.
- **Workflows:** *"watch me do this"* records a task once, and Echo repeats it, re-finding
  each button every time. Replays still go through the risk gate.
- **Skills:** Echo can combine tools it already has into a new named ability. It never
  writes new code into itself.
- **Forgetting:** *"forget …"* deletes the memory everywhere it's stored.

---

## 7. Background agents

Echo can hand work to a **team of agents** running in the background while you keep talking:

- **Missions:** a task graph where later agents wait for earlier ones. Each agent has a time
  and step budget, survives a crash, and must hand in a structured result.
- **The fleet:** six built-in roles (Lead, Research, Plan, Write, Review, Analyse), plus up
  to six of your own from the control panel.
  - Each role has a **tier**: fast = local model, balanced = your default brain, deep = Claude.
  - A custom agent can be **limited to read-only tools**, and that limit is enforced
    whichever way the agent is started.
- **Screen control:** only one agent at a time drives the mouse and keyboard; research-only
  agents run in parallel.
- **Commands:** *"what did the agents find?"*, *"cancel the mission"*. The **agent board** in
  the control panel shows everything live.

---

## 8. Knowledge: web, intel and your Mac's health

| Feature | Ask | How it works |
|---|---|---|
| **Private web search** | *"search the web for…"*, *"latest news on…"* | Your own **SearXNG**, merging Google and Brave results; no API key, and no single engine sees every query. Starts automatically. |
| **Mac health report** | *"sitrep"*, *"why is my Mac slow?"*, *"how much disk is left?"* | **Glances**: CPU, memory, swap, disk, battery, the busiest processes and warnings. Starts automatically. |
| **Open intel** | *"ISS over Hyderabad"*, *"world news on…"*, *"pharmacy near me"*, *"who owns this IP?"* | Five free public sources: satellites (CelesTrak), news (GDELT), maps (OpenStreetMap), internet routing (RIPEstat), exploited vulnerabilities (CISA). |
| **Osiris world map** | *"show me the world"*, *"add fires"*, *"show me Ukraine"* | A live globe of flights, earthquakes, fires, satellites, cameras and conflict zones. Hosted by default; run your own with `npm run osiris:setup`. |
| **Overnight research** | *"research this while I'm away"*, *"morning brief"* | Queues questions and answers them while you're gone. |
| **Calendar and translation** | *"what's on my calendar?"*, *"translate this screen"* | |

---

## 9. Echo Phone and Telegram

**Echo Phone** (the phone app, from any network):
1. Set `remote.relayUrl` to your Echo Phone address (e.g. `https://echo-phone.onrender.com`) and
   `ECHO_RELAY_SECRET` in `keys.env` to the same secret as `RELAY_SECRET` on the relay.
2. Say *"set a remote password"*, then *"open phone remote"*, and scan the QR code (the
   Echo Phone link) on your phone. Telegram's `/link` sends it too.
3. You get the live Mac screen, two-way talk, typed commands and approval of risky actions.
   The Mac never listens on the network: Echo dials out to the phone app's relay.

**Telegram:** chat with Echo through a private bot. Only the chat IDs you list can control it.

```json
{ "telegram": { "enabled": true, "botTokenEnv": "TELEGRAM_BOT_TOKEN", "allowedChatIds": ["YOUR_CHAT_ID"] } }
```

---

## 10. The HUD and control panel

Both are in [See it run](#see-it-run), recorded from the renderer itself.

- **HUD:** a floating, always-on-top reactor that shows Echo's state (listening, thinking,
  speaking), a live transcript and the action log. Skins: `jarvis` (default), `classic`,
  `mark50` (*"change your skin to …"*).
- **Control panel:** has three parts.
  - **Settings:** speech engine, recognition, wake word, conversation window and memory.
  - **API keys:** masked; stored in `~/.jarvis/keys.env`, readable only by you.
  - **Agents:** the agent board, your fleet, and a brain switcher.
- **Panels on demand:** the neural-core view, memory carousel, data pane, orbital tracker
  and the [Osiris globe](#osiris).
- **The core:** the humanoid on the overview, drawn to a single canvas by
  `renderer/humanoid-core.js`. It assembles when the panel opens, follows the pointer, and
  its mouth moves while Echo speaks — [watch it open](#the-humanoid-opening).

---

## 11. Full setup

### Install

```bash
brew install cliclick whisper-cpp
npm install
npm run build
```

**Speech model.** Use the multilingual `ggml-small.bin` (about 465 MB) so Echo can tell
languages apart. `ggml-base.en.bin` is smaller and faster, but English-only.

### Sign in a brain

```bash
npm run login        # Claude: opens the bundled CLI, type /login
```

**ChatGPT plan, no API key.** In **Control panel → Models → ChatGPT**, click
**Sign in with ChatGPT**, sign in in your browser, and allow Echo to use your plan.
The ChatGPT brain then runs on your ChatGPT Plus/Pro usage instead of API credits;
check or cap what Echo uses at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).
This is OpenAI's [plan-usage flow for open-source, locally run apps](https://developers.openai.com/siwc/token-sharing-open-source):
it is available because Echo is open source and runs on your Mac. A closed-source
or commercial build would need OpenAI's approval. Audio input is not available on
this route (Echo's hearing pass describes tone instead). Set `openai.auth` to
`"chatgpt"`, `"apiKey"` or `"auto"` (default: the plan when signed in, else the key),
and `openai.chatgptModel` to pick a model; empty uses the first your plan offers.
The sign-in is stored in `~/.jarvis/chatgpt/`, encrypted with the macOS Keychain.

Or add keys in **Control panel → Settings → API keys**, or in a `.env` file:

```bash
GEMINI_API_KEY=...          # Gemini brain, Gemini Live, Gemini voices
ANTHROPIC_API_KEY=...       # Claude without a subscription login
OPENAI_API_KEY=...          # GPT brain
ELEVENLABS_API_KEY=...      # ElevenLabs voice
PICOVOICE_ACCESS_KEY=...    # optional Porcupine wake-word engine
TELEGRAM_BOT_TOKEN=...      # Telegram chat
SARVAM_API_KEY=...          # Sarvam Indian-language voice and recognition
TYPESAFE_API_KEY=...        # optional second opinion for the risk gate
COMPOSIO_API_KEY=...        # hosted MCP tools (mcp.json)
```

> **Never commit `.env` or any file containing a key.** The `.gitignore` already covers
> `.env`, `vendor/`, `models/`, run logs and personal data.

### Grant macOS permissions

```bash
npm run doctor        # checks binaries, models, brain login and permissions
```

| Permission | Why | If missing |
|---|---|---|
| **Screen Recording** | to see the screen | Echo is blind (it only sees the wallpaper) |
| **Accessibility** | to click and type | **Fails silently**: Echo describes actions that never happen |
| **Microphone** | to hear you | No voice; typing still works |

macOS gives these to the app that **launches** Echo: your terminal and/or
`node_modules/electron/dist/Electron.app`. Quit and relaunch after granting.

### Optional add-ons

| Add-on | Install | What you get |
|---|---|---|
| **Piper voices** | `npm run piper:setup [voice]` | Offline neural voice; see [voices](https://huggingface.co/rhasspy/piper-voices). `npm run piper:voices` lists installed ones. |
| **SearXNG + Glances** | `npm run selfhosted:setup` | Private web search and the Mac health report. Echo starts them when needed; `npm run selfhosted:status` shows if they're running. |
| **Osiris (local)** | `npm run osiris:setup`, then `npm run osiris:start` | Your own world map: no rate limits, exact camera control. |
| **Your voice for the wake word** | `npm run enroll` | Records you saying "Echo" so the acoustic detector knows your voice. |
| **Ollama** | install from ollama.com, `ollama pull llama3.2:3b` | Free offline brain (and the "fast" agent tier). |

---

## 12. Configuration

**Where it lives:** `~/.jarvis/config.json` is the file Echo uses. The repo's `config.json` /
`config.example.json` are only starting points; editing them has no effect once
`~/.jarvis/config.json` exists. Most settings can also be changed in the control panel.

| Setting | Default | What it does |
|---|---|---|
| `brain` | `claude` | Starting brain: `claude`, `gemini`, `openai`, `ollama` |
| `gemini.model`, `claude.model`, `openai.model`, `ollama.model` | | Model for each brain |
| `voice.ttsEngine` | `mac` | Voice: `piper`, `mac`, `gemini`, `elevenlabs`, `sarvam` |
| `voice.piperVoice` | `en_GB-alan-medium` | Which Piper voice |
| `voice.ttsVoice` | `Daniel` | macOS voice (`say -v '?'` lists them) |
| `voice.realtime.enabled` | off | Gemini Live speech-to-speech |
| `voice.realtime.languages` | `all` | `non-english`: only other languages go to Gemini Live |
| `voice.realtime.voice` | `Kore` | Gemini voice (`Charon`, `Orus`, `Fenrir`, `Puck` are male) |
| `voice.sttProvider` | `whisper` | Speech recognition: `whisper` (local), `sarvam`, `apple` |
| `voice.sttModel` | `models/ggml-base.en.bin` | Whisper model; use `ggml-small.bin` for multiple languages |
| `voice.sttLanguage` | `en` | Keep `en`: it helps the wake word in every language |
| `voice.wakeWord` | on | Listen for "Echo" |
| `voice.wakeEngine` | `auto` | `auto`, `template`, `porcupine`, `onnx`, `none` |
| `voice.wakeTranscriptFallback` | off | Also transcribe room speech alongside the acoustic wake detector; costs extra local inference. Transcript fallback still runs if no acoustic detector is available. |
| `voice.conversationWindowMs` | 12000 | How long you can reply without "Echo" |
| `voice.bargeIn` | on | Talk over Echo to stop it |
| `voice.sendAudioToBrain` | off | Let the brain hear your tone, not just the words |
| `voice.inputDevice` | `-1` | Microphone: `-1` = system default, or a name |
| `memory.enabled` | on | Long-term memory |
| `context.maxTokens` | 128000 | Shared context target; increase this to grow the working window |
| `context.outputReserveTokens` | 16000 | Output space reserved inside that target |
| `context.compactAt` | 0.75 | Fraction at which accumulated tool history is compacted |
| `context.providerLimits` | `{}` | Smaller caps by model/provider, where required |
| `memory.retentionDays` | 0 | Delete memories older than N days (0 = keep) |
| `helpers.screenHistory` | off | Background screen OCR; restart after changing |
| `helpers.screenHistoryIntervalSeconds` | 120 | Delay after each capture finishes; minimum 30 seconds |
| `helpers.memoryIndexing` | off | Background Ollama vector indexing of screen history; restart after changing |
| `hud.skin` | `jarvis` | HUD look |
| `learning.enabled` | off | Record runs as training data for the local model |
| `osiris.baseUrl` | hosted | Pin one Osiris instance |
| `telegram.*` | off | See [§9](#9-phone-remote-and-telegram) |

**MCP servers** (extra tools from other programs) are listed in `mcp.json`. Entries under
`disabledMcpServers` are kept but not loaded. Sarvam's server is there while its account is
out of credit.

### Environment variables

```bash
ECHO_NO_VOICE=1                 # start without the microphone (type only)
ECHO_MCP=0                      # don't load any MCP servers
ECHO_DATA_ROOT=~/.jarvis        # where memory, keys and settings live
ECHO_LOG_DIR=…                  # where run journals go (default: runs/)
ECHO_FULL_LOG=0                 # journal metadata only
ECHO_RECOVERY_ATTEMPTS=3        # automatic retries after a run stops early
ECHO_LLM_TIMEOUT_MS=120000      # give up on a stuck model request
ECHO_TOOL_TIMEOUT_MS=120000     # give up on a stuck tool
SEARXNG_URL / GLANCES_URL       # use search/health services running elsewhere
OSIRIS_URL=http://localhost:3000
```

---

## 13. Commands

| Command | What it does |
|---|---|
| `npm start` | Build and launch Echo |
| `npm run dev` | Rebuild on every save |
| `npm test` | Typecheck and every offline test (~2 min) |
| `npm run test:live` | Tests that use real API keys, network or permissions |
| `npm run doctor` | Check installation, models, login and permissions |
| `npm run permissions` | Show which macOS permissions are granted (`-- --fix` opens the panes) |
| `npm run login` | Sign the Claude brain in |
| `npm run enroll` | Teach the wake-word detector your voice |
| `npm run miccheck` | List microphones and check levels |
| `npm run piper:setup` / `piper:voices` | Install or list Piper voices |
| `npm run selfhosted:setup` / `selfhosted:status` | Install or check SearXNG and Glances |
| `npm run osiris:setup` / `osiris:start` | Install or run a local Osiris |
| `npm run voicepreview` | Render samples of the Gemini voices |
| `npm run voicelog` | Voice timing per turn (end of speech → first sound) |
| `npm run hudpreview` / `panelpreview` | Render the HUD or control panel for checking layout |
| `npm run media` | Re-record the README's demo clips into `docs/media/` (add a name for one: `-- hud`) |
| `npm run dataset` | Inspect training candidates; add `-- --export` to snapshot all available recorded providers/messages/tools into `~/.jarvis/datasets/` |

---

## 14. Testing

```bash
npm test                # typecheck + 74 offline test suites, about 2 minutes
npm test -- wake piper  # only suites whose name contains "wake" or "piper"
npm run test:live       # the 5 suites that call real services (they use API quota)
```

Tests are discovered automatically from `package.json`: any script ending in `test`, so a
new test file joins `npm test` as soon as its script is added. Test sources are
`src/_*test.ts`. Always typecheck before trusting a build: the bundler (esbuild) skips type
checking, so `npm run build` succeeds even with type errors.

---

## 15. How the code is organised

```
Echo Mac/
├── src/
│   ├── main.ts              Electron app: windows, wiring, and the voice turn (handleUtterance)
│   ├── config.ts            settings and their defaults
│   ├── brain/               the AI models: claude, gemini, openai, ollama, switching,
│   │                        MCP servers (mcp.ts), tool pruning, model health/fallbacks
│   ├── tools/
│   │   ├── registry.ts      the tool list, assembled from:
│   │   ├── registry/        screen · memory · safety · agents · skills · remote ·
│   │   │                    knowledge · system · ambient (+ shared helpers)
│   │   ├── computer-actions.ts, ax.ts, vision.ts   mouse/keyboard, accessibility tree, OCR
│   │   ├── selfhosted.ts    SearXNG and Glances
│   │   └── intel-feeds.ts, osiris-intel.ts         open intelligence sources
│   ├── voice/               microphone, wake word (wake/), speech-to-text, language
│   │                        detection, voices (Piper, Gemini, macOS…), Gemini Live, session
│   ├── safety/              risk classification, the gate, confirmations, snapshots, redaction
│   ├── memory/              facts, recall, scopes, deletion, task state
│   ├── cognition/           episodic memory, local embeddings
│   ├── frontier/            agents (swarm, fleet), workflows, skills, presence, research,
│   │                        phone remote, Telegram, screen history, translation…
│   ├── agent-replay/        run journals, crash recovery, replay
│   └── learn/               training-data recorder for the local model
├── renderer/                HUD, control panel and panels (HTML/CSS/JS)
├── native/                  small compiled macOS helpers (audio, vision, speech)
├── scripts/                 setup, doctor, test runner, Piper worker,
│                         previews and the README's clip recorder (capture_media.mjs)
├── docs/media/              the demo clips in this README (recorded, not hand-made)
├── models/                  speech and wake-word models (downloaded, not in git)
└── vendor/                  Piper, SearXNG, Osiris installs (not in git)
```

**Where to start reading:** `main.ts` → `handleUtterance` for a spoken turn;
`brain/claude.ts` or `brain/gemini.ts` for the agent loop; `tools/registry/*.ts` for any
tool; `safety/risk.ts` for how actions are rated.

---

## 16. Privacy: what stays on your Mac

**Stays on your Mac:**
- Wake-word detection and speech-to-text (Whisper) for anything not addressed to Echo.
- Language detection, the Piper voice, OCR, screen history, embeddings and memory.
- SearXNG and Glances, which listen only on `127.0.0.1`.

**Leaves your Mac:**
- Your request, and the screenshots the brain asks for, go to the brain you chose
  (Claude/Gemini/OpenAI); a local Ollama brain sends nothing.
- Gemini Live receives the audio of non-English turns.
- Web searches go to the search engines, but through SearXNG, so no single engine sees them all.

**Where things are kept:**
- **`~/.jarvis/`:** settings, API keys (owner-only permissions), memory, workflows.
- **`runs/`:** run journals, with secrets redacted.
- **Voice recordings:** deleted 5 minutes after use; older leftovers are cleared at startup.

---

## 17. Troubleshooting

| Problem | Fix |
|---|---|
| **Echo doesn't wake up** | Say "Echo" clearly at the start. Check the HUD shows the level moving (the mic works). Run `npm run enroll` so the detector knows your voice. Check the right microphone is the system default (AirPods in their case = silence). |
| **Echo hears me but never answers** | Brain not signed in (`npm run login`) or Gemini quota used up. `npm run doctor` shows which. |
| **It narrates clicks that don't happen** | Accessibility permission is missing; see [§11](#grant-macos-permissions). |
| **It only sees the wallpaper** | Screen Recording permission is missing. |
| **Voice goes silent** | A cloud voice failed; Echo now falls back to Piper. If Piper isn't installed, it uses the macOS voice. Install Piper with `npm run piper:setup`. |
| **Answers in the wrong language/voice** | Language detection needs `models/ggml-small.bin` (multilingual). |
| **Web search / sitrep says "not running"** | `npm run selfhosted:setup`, then `npm run selfhosted:status`. |
| **Two Echos answering** | An old copy is still running; quit all Echo/Electron windows and start one. |

---

## 18. Debugging runs: journals and replay

Every run writes a crash-tolerant journal to `runs/`, one folder per run: `Echo--…` for the
main assistant and `Echo Clone N--…` for agents. Each folder records the task, model calls,
tool calls and results, and why the run ended.

- **Recovery:** if a run stops early (timeout, crash, closed stream), Echo resumes it from its
  checkpoint, up to 3 times. An action whose result wasn't recorded is checked before it is
  repeated. Anything you interrupted is never resumed.
- **Why did it stop?** *"why did that stop?"* or `./check-run.sh` summarises the latest run.
- **Replay:** `ECHO_REPLAY_RUN=/path/to/run npm start` re-runs a recorded session using the
  recorded model responses and tool results. Nothing live is called. It stops at the first
  point the new run differs from the recording.

---

## Permission and use

Echo is published here to be read and reviewed. It is **not** open source, and there is no
licence granting you the right to use it.

**Using it without permission is strictly prohibited.** That covers running it, copying it,
building on it, publishing it, and reusing any part of it — the code, the renderer, the
artwork in `assets/`, the recordings in `docs/media/`, or the design — for any purpose,
personal, academic or commercial, unless the author has given you written permission.

Ask first: **Deepak (AskDeepakAI)**, [@thedeepakreddy](https://github.com/thedeepakreddy).

---

**Platform:** macOS only (uses `cliclick`, `screencapture`, AppleScript and native helpers).
The brain, tools, voice and HUD are platform-independent; porting would mean a new
`tools/computer-actions.ts` for another OS.

### Graceful shutdown

Use **Power off** in the control panel, or run `npm run stop` from the Echo Mac project directory. The terminal command asks the existing instance to release resources; it does not start a new assistant when Echo is already stopped. Ctrl+C in Echo’s launch terminal and SIGTERM/SIGHUP also use the same cleanup routine. Repeated requests do not run cleanup twice.

Shutdown closes the microphone, speech/realtime sessions, shared Piper workers, managed coding processes, brain/MCP connections, remote server, windows and sensor helpers. Project files and saved progress remain on disk. Failed or stalled cleanup steps are logged and bounded so other resources can still be released. SIGKILL (`kill -9`) cannot run graceful cleanup.
