import { getAppPath } from "../utils/appPath.js";
import { loadRecent } from "../frontier/history.js";
import { Tts } from "../voice/tts.js";
import { localGenerate } from "./local-llm.js";
import { addressed } from "../brain/character.js";
import { activeConfig } from "../config.js";

let ghostInterval: NodeJS.Timeout | null = null;

export function startGhostMode(tts: Tts) {
  if (ghostInterval) return;
  // Run every 10 minutes
  ghostInterval = setInterval(async () => {
    try {
      // Take the last 50 entries to avoid massive payloads
      const rows = loadRecent(getAppPath(), 50);
      if (!rows.length) return;
      const recent = rows.map((r) => r.text).join("\n");
      
      const prompt = `You are a background pattern analyzer. Look at the following screen text history from the last 10 minutes. If you notice a highly repetitive task (like repeatedly copying emails, or constantly switching between the same two apps for data entry), reply with EXACTLY a short, 1-sentence suggestion asking if the user wants to automate it. If you do not see a repetitive pattern, reply with EXACTLY the word "NONE".\n\nHistory:\n${recent}`;
      
      const reply = await localGenerate(prompt);
      if (reply && reply.toUpperCase() !== "NONE") {
        tts.say(addressed(activeConfig().persona, "Ghost mode has detected a pattern. ") + reply);
      }
    } catch (e) {
      // History unreadable; localGenerate already reports a model that is not answering.
    }
  }, 10 * 60 * 1000); // 10 minutes
}

export function stopGhostMode() {
  if (ghostInterval) clearInterval(ghostInterval);
  ghostInterval = null;
}
