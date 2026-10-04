import { join } from "node:path";
import { dataRoot } from "../memory/paths.js";

export let isRecordingMeeting = false;

export function setMeetingRecording(state: boolean) {
  isRecordingMeeting = state;
}

/**
 * The meeting transcript. With the user's data — it was written into the app
 * folder, which an installed app cannot write to, and read back from there by
 * three different places that each built the path themselves.
 */
export function audioLogPath(): string {
  return join(dataRoot(), "audio_log.txt");
}
