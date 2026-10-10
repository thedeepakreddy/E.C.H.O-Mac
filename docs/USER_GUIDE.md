# Using and operating Echo

[README](../README.md) · [Setup](GETTING_STARTED.md) · [Configuration](CONFIGURATION.md) · [Validation](VALIDATION.md)

## Voice and model selection

Say “Echo” followed by a request, click the reactor, or use **⌘⇧J** for push-to-talk. A follow-up window can accept another utterance without repeating the wake word. Its duration, silence threshold and interruption behavior are configuration choices, not fixed promises about every device.

Try “switch to Gemini,” “switch to Claude” or “use the local model” after configuring that provider. Model switching preserves the shared project conversation, subject to the context and memory settings. A provider's own model limits, authentication, quota and availability still apply.

Local Whisper, Apple recognition, cloud recognition, local synthesis and cloud synthesis are separate paths. Realtime audio is optional. If language or voice behavior is unexpected, inspect the active settings rather than assuming an automatic routing rule. [src/voice](../src/voice) implements these paths.

## Tasks, Bots and agents

For building or changing software through conversation, see [Vibe coding with Echo](VIBE_CODING.md), including project tools, previews, the worker–inspector workflow and human review.

The **Bots** page starts a task or a coordinated team, shows progress, and displays the result. The **Agents** views show the underlying task board and configured roles. They share [the task service](../src/frontier/swarm.ts); they are not two independent task engines.

Built-in fleet roles are Lead, Research, Plan, Write, Review and Analyse. Role tier and grants influence which model and tools a worker can use. Bot teams use dependencies so later roles can consume earlier work. Screen-control ownership limits competing input; separate research workers can proceed without taking over the desktop.

Useful requests include “research three laptops and compare them,” “what did the agents find?” and “cancel the mission.” Review the report and sources before acting on it. A completed status indicates the workflow ended, not that every statement or external effect was independently verified.

The [Bots usage notes](bots-integration/usage.md) describe task routing, results and research access. [Bots tests](../src/_botstest.ts) check lifecycle and orchestration with controlled dependencies. They do not measure real-provider research quality.

## Now & Next, Needs You and Second Brain

Use **Now & Next** to inspect commitments and upcoming work. **Needs You** surfaces items requiring attention or approval. **Second Brain** exposes remembered information and retrieval. The [companion tests](../src/_controlcompaniontest.ts) exercise shared state and handoff behavior.

Examples to try are “don't let me forget this,” “remember that the renewal is in March,” and “send me updates to my phone.” For a reminder, check that Echo captured the correct date and recurrence. For a phone handoff, confirm the target is paired and reachable. Natural-language interpretation can require clarification.

## Memory and learning

- “Remember that…” saves a fact; “what do you know about…” requests recall.
- “Scan this” captures screen content for retrieval. Saved content can contain private material; choose what to capture deliberately.
- Background screen history and indexing are opt-in. Existing history may remain searchable after new capture is disabled.
- “Index my files” enables file-oriented retrieval; access and indexing depend on configured paths and installed helpers.
- “Watch me do this” records a supported workflow. Replays must find current controls again and can fail when the app changes.
- “Forget…” requests deletion through the memory service. Check which stored item was selected; forgetting memory is distinct from deleting unrelated files, logs or provider-held data.

Working conversation history can be compacted to fit the selected model. Compaction preserves task state and a summary rather than keeping every prior message in every prompt. The history tool can retrieve archived content where settings permit it. Claude's SDK also manages its own session history.

See [memory services](../src/memory), [provider context](../src/memory/provider-context.ts) and [configuration](CONFIGURATION.md) for recall, private mode and retention rules. Training-data recording is separately controlled by `learning.enabled` and is off in the built-in defaults.

## Actions and approvals

The ordinary tool path uses [runGated](../src/safety/gate.ts) for risk classification, grants, confirmation and supported snapshots. Provider-specific integration paths also have their own checks. [Tool architecture tests](../src/_toolarchitecturetest.ts) exercise denied writes, nested dispatch and tool grants across controlled provider fixtures.

| Classification | Intended behavior |
| --- | --- |
| Low | Read or recall operations can proceed within their grants. |
| Medium | Ordinary input and permitted operations can proceed and be recorded. |
| High | Operations classified as consequential require confirmation before proceeding. |

Classification can be imperfect, and a click's consequence depends on the app's current state. Review requested approvals and verify the result. “Undo that” uses supported snapshots; it cannot generally retract a message, purchase or other external side effect. Redaction and sensitive-input policies are implemented protections, not proof that every possible secret is detected.

Voice shortcuts in `shortcuts.json` use a separate path in [src/main.ts](../src/main.ts): expanded commands are classified and high-risk commands request confirmation before execution. This path does not call `runGated`. Treat shortcut definitions as trusted operator configuration and review their shell commands.

## Web, research and World Intelligence

Ask for web research, papers, news or source comparisons. The research tools can query live research indexes and fetch public pages when services permit it. Returned sources may be incomplete, stale, rate-limited or inaccessible; check dates and citations in the report.

SearXNG aggregates upstream web search results. A locally hosted search endpoint does not make upstream queries anonymous or offline. Glances supplies system-health information when configured; try “sitrep” or “why is my Mac slow?”

World Intelligence and Osiris display public feeds such as satellites, news and geographic events. Feed coverage and refresh schedules differ. A local Osiris UI can still depend on remote feeds. Use the displayed source and timestamp before treating an item as current. [Knowledge tools](../src/tools/registry/knowledge.ts) are the implementation entry point.

## Phone and Telegram

Echo Phone works independently in Phone mode. Connecting Echo Mac adds Mac-specific control; it is optional for using the phone app.

For paired Mac control:

1. Set `remote.relayUrl` to your Echo Phone deployment.
2. Configure private `ECHO_RELAY_SECRET` on the Mac to match `RELAY_SECRET` on the Phone relay.
3. Set a remote password, then ask “open phone remote” and open the generated Phone link.
4. Keep the Mac awake and Echo running. Inspect pairing/status before testing typed commands, voice delivery or approvals.

The Mac remote binds to loopback and connects outward to the relay. The relay must be reachable and correctly authenticated. A browser upload or “sent” acknowledgment is not a completed Mac response; inspect transcription, delivery and the actual reply when debugging.

Telegram is optional and restricts control to configured chat IDs:

```json
{
  "telegram": {
    "enabled": true,
    "botTokenEnv": "TELEGRAM_BOT_TOKEN",
    "allowedChatIds": ["YOUR_CHAT_ID"]
  }
}
```

Store the token privately. [Remote service](../src/frontier/remote.ts) and [remote tests](../src/_remotetest.ts) cover tokens, password sessions, transport and voice delivery with local fixtures.

## HUD and Control Panel

The floating HUD displays the assistant's state; the Control Panel provides the detailed activity, results, configuration and task views. Available HUD skins include `jarvis`, `classic` and `mark50`. Neural Core, Synaptic Field, Osiris and Orbital are separate views.

The humanoid renderer reacts to panel and speech state. It is a visual interface, not evidence of an additional reasoning model. See the [screenshots](../README.md#screenshots) for each page; captured data is labeled as fixtures or public feeds.

## Data handling

Data handling depends on the enabled path:

| Path | What to expect |
| --- | --- |
| Local wake detection, Whisper, OCR, Piper | Processing can remain local when these local implementations are selected. |
| Cloud brain | Requests, task context and requested observations can be sent to the selected provider. Eligible memory recall is controlled separately by `memory.cloudRecall`. |
| Cloud recognition, synthesis or realtime audio | Audio or speech text is sent to the configured speech provider. |
| Local Ollama | Model inference can remain local; enabled network tools and speech services still have their own outbound traffic. |
| Search and public feeds | Queries or requests reach configured endpoints and upstream providers. |
| Phone relay, Telegram or MCP | Data reaches the configured transport or server according to that feature's operation. |

The normal data root is `~/.jarvis`, containing configuration, keys, memory and saved workflows. Run journals normally live under `runs/`; full journals can retain task content even with redaction. `ECHO_FULL_LOG=0` requests metadata-only journals. Recording, history and training settings deserve separate review; disabling one does not automatically remove all previously stored data.

Private-mode and suppression rules constrain recording and recall in their implementation paths. They should be checked against the features enabled in a particular installation rather than treated as a universal network-isolation mode.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| No wake response | Microphone permission, input device, level, wake settings and installed models. Run `npm run miccheck` and `npm run doctor`. |
| Transcription but no answer | Selected brain, login/key, model access, quota, request errors and active task state. |
| Clicks narrated but not applied | Accessibility permission, actual control target and app state. |
| Incomplete screen observation | Screen Recording permission and which display/window was captured. |
| Silent or fragmented speech | Active voice engine, provider failures, installed local voice and audio device. Inspect voice timing with `npm run voicelog`. |
| Wrong language | Recognition model, recognition language and optional realtime routing. |
| Mac offline on Phone | Relay configuration, matching private secret, Mac sleep state and whether the remote is running. First test a typed command. |
| Search or health unavailable | `npm run selfhosted:status`, endpoint configuration and upstream service availability. |
| Duplicate responses | Check for multiple Echo/Electron instances before restarting. |

## Journals, recovery and replay

Run journals record task lifecycle, model/tool events and termination reasons, subject to log settings. `./check-run.sh` summarizes the latest run. Inspect the reported reason rather than treating every interruption as a model failure.

Recovery uses checkpoints and bounded attempts. Unknown effects, explicit interruption and task-specific policy can prevent continuation. A recorded checkpoint does not make every pending action safe to repeat or reversible.

```bash
ECHO_REPLAY_RUN=/path/to/recorded/run npm start
```

Replay supplies recorded model/tool results and checks for divergence. It helps reproduce a recorded path; it does not simulate every possible app or network state. See [replay implementation](../src/agent-replay) and [validation](VALIDATION.md) for the checks that were actually run.

For shutdown and installation commands, see [Getting started](GETTING_STARTED.md). For test modes and release verification, see [Validation](VALIDATION.md#reproduce-the-checks).
