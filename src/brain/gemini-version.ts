/**
 * The Gemini Developer API version every Echo client speaks.
 *
 * Pinned, because the SDK's own default moved. Through @google/genai 2.x a
 * client built without a version talked to `v1beta`; from 3.0 it talks to
 * `v1`. Echo leans on things that live on the beta surface — the Live API
 * behind realtime voice, preview speech models, thinking levels on the newest
 * models — so taking the SDK's new default would have changed which API every
 * request reaches as a side effect of a dependency bump, with nothing in
 * Echo's code saying so.
 *
 * One constant, used by every client and by the one raw REST call
 * (voice/tts-stream.ts), so moving to `v1` later is a single deliberate edit
 * made after checking those features there. `GOOGLE_GENAI_API_VERSION` does
 * not override this: the SDK gives a version passed in code precedence.
 */
export const GEMINI_API_VERSION = "v1beta";
