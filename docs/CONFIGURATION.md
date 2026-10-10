# Configuration

[README](../README.md) · [Setup](GETTING_STARTED.md) · [User guide](USER_GUIDE.md)

## Files and precedence

[src/config.ts](../src/config.ts) defines the schema, built-in defaults and loading rules. Echo reads the first existing configuration in this order:

1. `<data root>/config.json`, normally `~/.jarvis/config.json`.
2. The checkout's `config.json`.
3. The checkout's `config.example.json`.

It merges that file with the built-in defaults. It does not merge all three files. Once the user configuration exists, editing the repository template does not change the active settings. Echo's settings writes go to the user configuration. Some runtime helpers require a restart after changes.

API keys saved by the Control Panel use `keys.env` in the data root. The checkout can also load `.env`; existing process environment variables take precedence over values loaded by [src/env.ts](../src/env.ts). Keep these files and tokens private.

## Selected built-in defaults

These are code defaults, not a description of an existing user's settings. Model names and provider access must be checked against the configured account. The complete schema is in [src/config.ts](../src/config.ts).

| Setting | Built-in default | Meaning |
| --- | --- | --- |
| `brain` | `claude` | Starting model adapter. |
| `voice.ttsEngine` | `mac` | Speech synthesis engine; optional engines need their own setup. |
| `voice.ttsVoice` | `Daniel` | Requested macOS voice. Installed voices vary. |
| `voice.sttProvider` | `whisper` | Local recognition by default; Apple and Sarvam are alternative paths. |
| `voice.sttModel` | `models/ggml-base.en.bin` | Local English recognition model path. |
| `voice.sttLanguage` | `en` | Recognition language configuration. |
| `voice.wakeWord` | `true` | Enable wake detection. |
| `voice.wakeEngine` | `auto` | Choose from available detectors. |
| `voice.wakeTranscriptFallback` | `false` | Avoid parallel room transcription when an acoustic detector is available. Fallback can still be used if no acoustic detector is available. |
| `voice.conversationMode` | `true` | Allow follow-up speech during the conversation window. |
| `voice.conversationWindowMs` | `12000` | Follow-up window in milliseconds. |
| `voice.silenceMs` | `900` | Silence threshold used in utterance capture. |
| `voice.maxUtteranceMs` | `15000` | Utterance capture duration limit. |
| `voice.bargeIn` | `true` | Enable voice interruption. |
| `voice.bargeInMode` | `finish` | Configured interruption mode; see the voice implementation for behavior. |
| `voice.sendAudioToBrain` | `false` | Whether the normal brain path may receive audio. Separate realtime/cloud speech settings also matter. |
| `voice.inputDevice` | `-1` | System-default microphone. |
| `memory.enabled` | `true` | Long-term memory. |
| `memory.cloudRecall` | `true` | Permit eligible recalled content in cloud-model prompts. Current task context is separate. |
| `memory.retentionDays` | `0` | Keep consolidated episodes until forgotten. A nonzero value applies to eligible episodes created after enabling retention; it is not a purge of all old data. |
| `context.maxTokens` | `128000` | Working-context target, subject to provider/model capacity. |
| `context.outputReserveTokens` | `16000` | Reserved output space within that target. |
| `context.compactAt` | `0.75` | Compaction threshold. |
| `helpers.screenHistory` | `false` | Opt-in background screen capture. |
| `helpers.screenHistoryIntervalSeconds` | `120` | Capture interval configuration. |
| `helpers.memoryIndexing` | `false` | Background indexing. |
| `learning.enabled` | `false` | Training-data recording. |
| `remote.alwaysOn` | `false` | Keep the optional Mac remote active. |
| `telegram.enabled` | `false` | Enable the optional Telegram channel. |
| `hud.skin` | `jarvis` | Default HUD renderer. |

`voice.realtime` is optional and is not enabled by the built-in defaults. Language detection, realtime routing and voice choice depend on your configuration and available provider. There is no universal English/Piper versus other-language/Gemini rule.

## Environment controls

| Variable | Purpose |
| --- | --- |
| `ECHO_DATA_ROOT` | Override the normal `~/.jarvis` data directory. |
| `ECHO_NO_VOICE=1` | Launch without microphone capture. A working brain is still required for typed replies. |
| `ECHO_MCP=0` | Disable loading MCP servers. |
| `ECHO_LOG_DIR` | Override the run-journal directory. |
| `ECHO_FULL_LOG=0` | Request metadata-only journals. |
| `ECHO_RECOVERY_ATTEMPTS` | Bound automatic recovery attempts. |
| `ECHO_LLM_TIMEOUT_MS` | Model request timeout. |
| `ECHO_TOOL_TIMEOUT_MS` | Tool timeout. |
| `SEARXNG_URL`, `GLANCES_URL` | Select configured search and health endpoints. |
| `OSIRIS_URL` | Select an Osiris endpoint. |
| `ECHO_RELAY_SECRET` | Authenticate the Mac's connection to the Phone relay; keep private. |

MCP server definitions are in `mcp.json`. Review their commands, credentials, capabilities and network access before enabling them. Entries under `disabledMcpServers` are not loaded. Extra servers change the tools available at runtime.
