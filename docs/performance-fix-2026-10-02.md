# Echo performance investigation — 2 October 2026

The Mac has 8 GB RAM. Echo was closed at the first measurement; Spotlight's
`mds`, `mds_stores`, and indexing workers dominated CPU usage. That is a separate
source of current slowness. The full-machine freeze was not reproduced, so this
change addresses verified resource-load defects rather than claiming a proven
cause of every hard reset.

## Findings and fixes

- **Oversized local AI allocation:** the installed `llama3.2:3b` advertises
  131,072 tokens. Echo used that capacity and the shared cloud context target to
  request 128,000 tokens even on an 8 GB Mac. An offline regression reproduced
  that exact request before the fix. Requests now cap context at 8,192 tokens
  on machines with at most 8 GB RAM, or 16,384 on larger machines; smaller model
  and user limits still apply. The local prompt is compact, and tool schemas
  fit the same budget as conversation memory. Local inference uses two CPU
  threads and releases its model after 60 seconds without another request.
- **Stop did not cancel local inference:** it only changed a JavaScript flag.
  Stop and shutdown now abort the HTTP request and response stream. Requests
  also have a two-minute deadline.
- **Unrequested background work:** full-screen accurate OCR ran every 30
  seconds regardless of helper settings, and vector indexing periodically
  loaded another Ollama model. Both are now opt-in. Existing history remains
  searchable. Enabled OCR waits two minutes after each capture finishes, and
  checks sleep, screen lock, private mode, and shutdown before writing results.
- **Overlapping speech work:** wake verification, ordinary transcription, and
  language detection shared the native speech worker without a bounded queue.
  They now run one at a time, with at most two waiting jobs. Whisper uses two
  CPU threads and one processor. Inference requests time out after 30 seconds
  and stop a stalled worker instead of starting more inference beside it.
- **Room speech was transcribed unnecessarily:** transcript wake fallback was
  enabled alongside the acoustic detector. It is now off by default. Wake-word
  detection and command transcription remain active; installations without an
  acoustic detector still use transcript matching.

Ollama documents that context length increases memory requirements and that
`keep_alive` controls model residency: [context length](https://github.com/ollama/ollama/blob/main/docs/context-length.mdx),
[API reference](https://github.com/ollama/ollama/blob/main/docs/api.md).

## Verification

- TypeScript checks, production build, and whitespace checks passed.
- Fifteen relevant test suites passed across the focused runs: performance,
  wake word, wake engines, voice, local tools, history, history trimming, voice
  latency, Memory OS, shared context, scripted voice, player guard, exit,
  identity, and model health. Native audio tests required normal macOS access:
  56/56 wake-word cases and 19/19 wake-engine cases passed.
- New regressions cover context allocation, real prompt/tool budget fitting,
  aborting stalled requests, queue overload and recovery, non-overlapping OCR,
  shutdown during capture, and private-mode changes during capture.
- A 35-second run used fresh temporary data, the configured microphone and
  local speech model, and no restored tasks or phone remote. It exited normally.
  Total process RSS in the three samples was approximately 1.0–1.2 GB;
  Whisper used 0.3–0.4% CPU. No main-process stall was reported. The control panel
  reported one dropped frame of roughly 53 ms. This is a short idle check,
  not evidence about every workload or long-term stability.
- A real local inference request confirmed an 8,192-token context in Ollama's
  resident-model report, with approximately 2.8 GB allocated to that model.
  This verifies allocation; model response quality was not part of the
  performance acceptance checks.

The active `~/.jarvis/config.json` and repository config have the lower-load
background and wake settings. The original active configuration is preserved at
`~/.jarvis/config.json.bak-before-performance-fix`. Existing memory was not deleted.
The production bundle has been rebuilt; launch Echo normally with `npm start`.

## Control-panel follow-up

Rapid view switches exposed a separate animation lifecycle bug: `stop()` left
an animation frame queued, and `start()` allowed that old callback to resume
alongside the new loop. Twelve restarts produced **234 draws in 600 ms**. The
engine now cancels queued frames and invalidates old callbacks; the same test
produced **11 draws** with the panel's new 20 fps cap. Repeating the same state
also no longer generates a fresh particle burst on every telemetry update.

The panel's live backdrop filters were removed while keeping its gradients,
rounded surfaces, and highlights. The figure paints at 15 fps while idle and
30 fps while active; decorative canvases pause when unfocused. Full runtime
updates coalesce over 150 ms and pause while the panel is minimized. Immediate
state events update the status indicators without rendering all the lists.

The native regression is `npm run test:panel-performance`. It exercises the
production renderer with fixtures, verifies a single animation loop, hidden-card
shutdown, unchanged-state handling, blur removal, and navigation paint time.
The native settings smoke check also confirmed saved settings, enabled controls,
and the shutdown confirmation dialog continue working.

## Routing and scrolling follow-up

The native Electron regression reproduced missing routing workspace scrolling,
model-picker focus loss on unrelated provider updates, and model-card replacement
while the routing page was hidden. The routing grid sized its model rows to their
full content while the outer shell clipped overflow. Activity logs also explicitly
hid their overflow.

The routing workspace now owns vertical scrolling for models and connections;
activity logs and the route detail pane can scroll. Responsive columns adapt to
smaller windows. Settings no longer forces a minimum center-column width beyond
the available space, and its sidebar sections retain their natural height when
scrolling. Hidden page lists defer updates until navigation, and model cards are
updated individually so unrelated changes preserve the OpenRouter picker.

Model switches disable provider controls until completion, restore controls on
failure, and the main process coalesces duplicate requests while refusing a
competing switch. The control action also accepts the displayed OpenRouter route.

Validation: `npm run test:panel-routes` uses five provider cards, 80 connections,
and 240 activity entries without starting audio or models. Native mouse-wheel
scrolling passes. All connection cards are reachable; routing, settings, and task
columns fit at 1180x760, 780x560, and 680x500 outer window sizes. One hundred
routing updates took about 32ms. Repeated clicks submitted exactly one switch,
and a failed switch restored usable controls. Overview animation/navigation
regression, Settings save smoke, TypeScript checks, 62 switching checks, and
local performance regressions also pass. These isolated tests verify the panel
faults; they do not establish that every possible laptop freeze is eliminated.

## Silent speech on AirPods follow-up

The active OpenRouter reply reached Gemini TTS, produced audio, and triggered
`audio.start`, but never completed playback before a manual stop about 87 seconds
later. System output was unmuted, directed to AirPods Pro. Sampling the existing
playback-only helper showed no active audio rendering thread; a freshly started
helper progressed and drained normally. The missing engine configuration recovery
was reproduced in a temporary build of the real Swift helper by stopping its
AVAudioEngine and posting the configuration-change notification.

Apple documents that hardware sample-rate/channel changes stop and uninitialize
AVAudioEngine: https://developer.apple.com/documentation/foundation/nsnotification/name-swift.struct/avaudioengineconfigurationchange
The exact physical change that stopped this session was not captured, but the
stopped-engine failure and its recovery were reproduced directly.

`native/voiceio.swift` now handles configuration changes on its serial playback
queue, restarts a stopped engine before accepting PCM, and retains incomplete
buffers for rescheduling. Stop/reset completion callbacks no longer falsely mark
unheard buffers as played. Explicit user stops still clear retained audio.
Playback progress resets per utterance and carries forward across engine recovery.
A partially played buffer may repeat a short fragment when resumed.

`npm run test:audio-recovery` failed before the repair and now passes mid-speech
recovery, idle recovery, completion, progress reset, and cancellation checks.
Playback tests pass 6/6, TypeScript and native build pass. A complete 2.45-second
local test sentence finished playback without interruption. The user confirmed
hearing the intentionally interrupted test phrases in AirPods. Echo's existing
playback helper was replaced with the built fix through its existing automatic
recovery; the application and OpenRouter connection stayed running.

## Response latency follow-up

The real OpenRouter voice session `runs/voice/2026-10-02T00-49-06-990Z.jsonl`
shows several serial waits, even for greetings. Sample spoken turns took
680–839ms for local transcription, another 1.50–1.83 seconds between final
transcription and brain dispatch, 5.21–12.43 seconds from dispatch to first
model text, and 756ms–2.67 seconds from first text to first audio. A typed
turn took 15.48 seconds to first text and another 5.84 seconds to first audio.
These are sample stage timings, not a benchmark of every provider. Capture
end stamps on the manual path can overlap transcription; they are not an
additional independent endpoint delay.

Changes:

- Complete English greetings and social check-ins have a deterministic local
  response, bypassing the full agent request. Greeting-plus-task commands,
  confirmations, stops and all other requests continue through their normal
  routes. Responses use the selected voice, in one sentence, with normal
  session and conversation-window bookkeeping.
- For already-addressed captures, the cloud hearing correction starts alongside
  local Whisper. Ungated room audio still waits for the local wake-word check.
  The hearing pass has a three-second total deadline across its model fallbacks
  and cancels outstanding work. Successful corrections preserve negations and
  original-language text. On failure the configured transcription fallback
  remains available; Whisper is no longer run a second time on the same capture.
  Deadline fallback can lose a cloud correction when the service is slow; it
  does not establish an improvement in measured recognition accuracy.
- Gemini 3.1+ TTS uses streaming generation and forwards PCM chunks as received,
  rather than waiting for a complete JSON audio response. Older voice models
  retain their existing request path. Requests are cancelled on stop and have
  a 20-second upper bound; quota errors release the existing voice fallback.
  The selected brain, model, voice and full task capabilities are preserved.

Google's speech generation documentation describes streaming audio generation:
https://ai.google.dev/gemini-api/docs/generate-content/speech-generation

Validation: the new `npm run latencyfixtest` reproduced the complete-audio wait
before the streaming repair and now passes early PCM delivery, fragmented SSE,
exact greeting routing, bounded hearing, negation/script preservation, quota
refusal, older voice compatibility and cancellation. Existing chunker (9),
voice pipeline (14), script voice (17), and speech-clock (32) checks pass.
TypeScript and the production build pass.

A live test of the unchanged configured Gemini voice returned HTTP 429 / quota
exhausted in 468ms, with no audio. Therefore the new cloud time-to-first-audio
cannot yet be measured on this account. The model's external response delay
also remains: these changes remove local serial waits and the full agent call
for exact greetings; they do not guarantee a latency for arbitrary commands
or increase any service quota. Restart Echo to load the rebuilt main process.
