import type { IncomingMessage } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normaliseCommand } from "./remotesignal.js";

export const MAX_REMOTE_VOICE_BYTES = 12 * 1024 * 1024;
export class RemoteVoiceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Read the complete upload before acknowledging it or running any command. */
export async function transcribeRemoteVoice(req: IncomingMessage, transcribe: (path: string) => Promise<string>): Promise<string> {
  const wav = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_REMOTE_VOICE_BYTES) chunks.push(chunk);
      else { chunks.length = 0; reject(new RemoteVoiceError(413, "voice_too_long", "That recording is too long. Keep it under a minute.")); }
    });
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("aborted", () => reject(new RemoteVoiceError(400, "voice_interrupted", "The recording upload was interrupted. Try again.")));
    req.once("error", () => reject(new RemoteVoiceError(400, "voice_interrupted", "The recording upload was interrupted. Try again.")));
  });
  if (wav.length <= 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(4) + 8 > wav.length) {
    throw new RemoteVoiceError(400, "voice_invalid", "The recording didn't arrive correctly. Record it again.");
  }
  const folder = await mkdtemp(join(tmpdir(), "echo-remote-voice-"));
  const path = join(folder, "recording.wav");
  try {
    await writeFile(path, wav, { mode: 0o600 });
    const result = normaliseCommand(await transcribe(path));
    if (!result.ok) throw new RemoteVoiceError(422, "voice_unheard", result.reason === "too long" ? "That voice message is too long. Try a shorter request." : "I couldn't hear any speech in that recording. Try again closer to the microphone.");
    return result.text;
  } finally { await rm(folder, { recursive: true, force: true }); }
}
