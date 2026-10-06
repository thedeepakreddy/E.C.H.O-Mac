import { watch, existsSync } from "node:fs";
import { join } from "node:path";
import { sendToOverlay } from "../overlay.js";
import { speak } from "../voice/speaker.js";

/**
 * Warns when many files in ~/Documents disappear within a few seconds.
 *
 * Opt-in (`helpers.watchdog`). It used to start on every launch, which asked
 * every new user for access to their Documents folder, and it fired on ANY ten
 * renames in five seconds — a git checkout, an unzip, an app's save-as — with
 * a critical "ransomware" alert that said "I have halted the system". It halts
 * nothing; it cannot. Now it counts only files that are actually gone, says
 * what it saw, and speaks through Echo's own voice, so muting Echo mutes it.
 */

let watchdog: import("node:fs").FSWatcher | null = null;
let deletions = 0;
let resetTimer: NodeJS.Timeout | null = null;
let lastAlertAt = 0;

/** Deletions within the window that count as a mass deletion. */
const THRESHOLD = 10;
const WINDOW_MS = 5000;
/** One warning per burst, not one per file after the threshold. */
const ALERT_COOLDOWN_MS = 60_000;

export function startWatchdog() {
  if (watchdog) return;
  const home = process.env.HOME;
  if (!home) return;
  const docsDir = join(home, "Documents");

  function attachWatcher() {
    try {
      watchdog = watch(docsDir, { recursive: true }, (eventType, filename) => {
        // "rename" is also a create or a move. Only a path that no longer
        // exists is a deletion.
        if (eventType !== "rename" || !filename) return;
        if (existsSync(join(docsDir, filename.toString()))) return;
        deletions++;
        if (!resetTimer) {
          resetTimer = setTimeout(() => {
            deletions = 0;
            resetTimer = null;
          }, WINDOW_MS);
        }
        if (deletions >= THRESHOLD && Date.now() - lastAlertAt > ALERT_COOLDOWN_MS) {
          lastAlertAt = Date.now();
          console.warn(`[watchdog] ${deletions} files deleted from Documents within ${WINDOW_MS / 1000}s`);
          sendToOverlay("show-friday-protocol");
          speak(`Heads up — ${deletions} files were just deleted from your Documents folder. If you didn't do that, check what's running.`);
          deletions = 0;
        }
      });

      watchdog.on("error", (err: any) => {
        if (err.code === "EINTR") {
          console.warn("[watchdog] interrupted (EINTR), reattaching");
          watchdog?.close();
          watchdog = null;
          setTimeout(attachWatcher, 1000);
        } else {
          console.error("[watchdog] error:", err);
        }
      });
    } catch (e: any) {
      if (e.code === "EINTR") {
        setTimeout(attachWatcher, 1000);
      } else {
        console.error("[watchdog] failed to start:", e);
      }
    }
  }

  attachWatcher();
}

export function stopWatchdog() {
  if (watchdog) {
    watchdog.close();
    watchdog = null;
  }
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  deletions = 0;
}
