/**
 * Turn off onnxruntime's telemetry before the native library loads.
 *
 * This build of onnxruntime-node ships Microsoft's 1DS telemetry SDK compiled
 * in (`PosixTelemetry`, `Microsoft::Applications::Events`), pointed at
 * `https://mobile.events.data.microsoft.com/OneCollector/1.0`. Two reasons it
 * has no business running here:
 *
 *   1. It crashed the whole app. A telemetry HTTP *response* was decoded on a
 *      background worker thread, `recursive_mutex::lock()` threw a
 *      std::system_error, nothing on that thread caught it, and an uncaught C++
 *      exception is an abort() — SIGABRT, Electron gone, mid-session. Nothing
 *      in JS can catch that: by the time it reaches std::terminate the process
 *      is already ending. The only fix available from here is to stop the
 *      telemetry thread existing.
 *   2. Echo reads the user's screen. A component quietly posting to a vendor
 *      endpoint is not something this app should carry by default, whatever it
 *      sends.
 *
 * `ORT_DISABLE_TELEMETRY` is read by the native library when it initialises, so
 * this has to run BEFORE the first `import("onnxruntime-node")` — which is why
 * it is a function called at each load site rather than a side effect of an
 * import someone might reorder. All three loaders (VAD, wake spotter, embedder)
 * import onnxruntime lazily, so calling it just before each one is enough.
 */
export function disableOrtTelemetry(): void {
  // Never override an explicit choice, including someone deliberately turning
  // telemetry back on to debug onnxruntime itself.
  if (process.env.ORT_DISABLE_TELEMETRY === undefined) {
    process.env.ORT_DISABLE_TELEMETRY = "1";
  }
}
