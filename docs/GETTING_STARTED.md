# Getting started

[README](../README.md) · [Configuration](CONFIGURATION.md) · [User guide](USER_GUIDE.md)

Follow the repository's [permission and use policy](../README.md#permission-and-use) before running a checkout. These instructions describe the macOS development launch.

## Install and launch

Install Node.js and npm, then run from the repository directory:

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

`npm start` builds and launches Electron. The build uses esbuild and does not substitute for `npm run typecheck`. `npm run dev` rebuilds on changes; it is not the normal launch command. Check the [validation record](VALIDATION.md) for the runtime used in the latest checks.

The built-in Whisper default is the English model above. For multilingual local recognition, download a multilingual Whisper model, select its path in `voice.sttModel`, and configure the desired recognition language. Provider-specific realtime audio is a separate feature; installing a multilingual model does not enable it.

## Configure a brain

The default brain is Claude. `npm run login` opens the bundled login flow. An API key can also be configured. The code includes Gemini, OpenAI, OpenRouter, NVIDIA and Ollama adapters; inspect the Models page and [brain implementations](../src/brain) for the supported configuration.

Add keys through the Control Panel's API key page or a private `.env` file. Examples of key names are `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` and `SARVAM_API_KEY`. Use only the services you enable. Never commit keys or account tokens.

Echo also implements an optional ChatGPT sign-in route. Its implementation is not evidence that this project or every account is eligible for a provider's subscription flow. Check the provider's current eligibility, usage terms and model access before relying on that route. No fixed free quota or subscription entitlement is assumed here.

For Ollama, install the local service, pull a model such as `llama3.2:3b`, and configure `ollama.host` and `ollama.model`. A local model can keep inference local; enabled web tools, remote services and cloud voices have their own data flows.

## Grant permissions

Run `npm run permissions` to inspect permission state, or `npm run permissions -- --fix` to open the relevant settings panes. Depending on how you launch Echo, macOS may attach the permission to the terminal or Electron app. Quit and relaunch after changing permissions.

| Permission | Used for | What to check when missing |
| --- | --- | --- |
| Screen Recording | Screenshot-based observation | Captures may omit app content or show an incomplete desktop. |
| Accessibility | Reading controls and sending input | Clicks, typing or control discovery may fail. Check the actual app state. |
| Microphone | Voice capture | Voice input cannot work without a permitted, functioning input device. |
| Speech Recognition | Apple recognition when selected | This is distinct from microphone permission. |

## First request

With a working brain and microphone, say “Echo” followed by a request. Click the reactor or use **⌘⇧J** for push-to-talk. Use the Control Panel's input for typed requests. Start with an observable task, such as asking what is on screen, and check the result.

The built-in conversation window is 12 seconds when conversation mode is enabled. Installed configuration can override it. **⌘⇧.** stops the active turn. Voice interruption depends on the configured barge-in behavior and functioning audio capture.

## Optional components

| Component | Command | Purpose |
| --- | --- | --- |
| Piper | `npm run piper:setup`, `npm run piper:voices` | Install or list offline neural voices. |
| SearXNG and Glances | `npm run selfhosted:setup`, `npm run selfhosted:status` | Configure search aggregation and system health. Search still contacts upstream engines. |
| Local Osiris | `npm run osiris:setup`, `npm run osiris:start` | Run a local globe UI. Its feeds can still depend on remote services and their limits. |
| Wake enrollment | `npm run enroll` | Record local samples for the acoustic detector. Performance depends on environment and microphone. |
| Microphone check | `npm run miccheck` | Inspect available inputs and levels. |

See the [user guide](USER_GUIDE.md#phone-and-telegram) for optional phone pairing and Telegram configuration.

## Stop cleanly

Use **Power off** in the Control Panel or `npm run stop` from this checkout. The stop command requests shutdown from an existing instance without starting another assistant. Ctrl+C in the launch terminal and SIGTERM/SIGHUP also request cleanup.

Cleanup closes audio sessions, workers, managed processes, connections and windows with bounded waits. Saved files remain on disk. SIGKILL cannot run cleanup. See the [shutdown implementation](../src/main.ts) when diagnosing a resource that remains active.
