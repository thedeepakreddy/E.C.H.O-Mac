# Graceful shutdown — 2026-10-02

Control-panel power off, application Quit, the terminal stop command, SIGINT, SIGTERM and SIGHUP now converge on a single idempotent shutdown request. `npm run stop` uses Electron's existing single-instance channel with --echo-shutdown; it does not locate processes by name or start an assistant when Echo is already stopped. It acknowledges the request; the primary process logs cleanup completion before exiting.

Cleanup blocks incoming brain dispatch and automatic microphone reopening, releases microphone/speech/realtime/Piper/Telegram/STT/player resources, stops coding processes/workers and the brain, closes MCP connections and the phone server, then releases UI/sensors. Failures in individual cleanup steps are reported and do not skip subsequent steps. Existing deadlines bound asynchronous waits. Native synchronous code cannot be preempted by a JavaScript timeout.

The live Ctrl+C check reproduced an EPIPE from the voice helper's stdin: terminal interrupts reach child helpers before Echo can send its final stop message. VoiceIoPlayer now handles closed-pipe stream errors, avoids writing to destroyed/killed children and cancels queued recovery when disposed. It cannot restart a helper after shutdown merely because recovery was scheduled earlier.

Validation: 7 selected lifecycle/routing/recovery/coding suites passed; after the audio-race fix, shutdown, playerguard and buildlatency suites passed again. Typecheck, production build and diff whitespace checks passed. The shutdown fixture tests concurrent requests, failed/hung cleanup, real child SIGINT/SIGTERM/SIGHUP (including repeated signals), a real spawned fake audio helper's closed-pipe event, and recovery cancellation.

Live application checks: npm run stop caused the primary Echo to log terminal stop command → shutdown cleanup complete and exit 0. Repeating npm run stop while off returned already stopped and did not start an assistant. Ctrl+C initially exposed the pipe race; after the fix the real Echo logged application quit → shutdown cleanup complete and exited 0 without that error. Control-panel routing was inspected; its action calls the same coordinator after acknowledging the UI request. No live model request, deployment or project source change was performed as part of these checks. Echo was left off after validation.

Project source and durable progress remain saved. SIGKILL cannot execute cleanup; use the control panel, npm run stop, Ctrl+C or SIGTERM for graceful shutdown.
