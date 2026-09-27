/** The Mac and Echo itself: shell, files, settings, health, brains, voice and restarts. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import * as system from "../system.js";
import { getAppPath } from "../../utils/appPath.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sendToOverlay } from "../../overlay.js";
import { currentLoop } from "../../agent-replay/loop-log.js";
import { runShutdown } from "../../lifecycle.js";
import { exec } from "node:child_process";
import { pauseAllMedia, lockScreen } from "../../frontier/presence.js";
import { check_health } from "../health.js";
import { electronApp, appRoot } from "./shared.js";

export const SYSTEM_TOOLS: ToolDef[] = [
  {
    name: "check_health",
    description: "Check the health of the Jarvis system. This verifies native binaries, running servers, AI models, and APIs. Use this when the user asks you to check your health or look for bugs/inconsistencies.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const res = await check_health();
      return { text: res.text };
    },
  },
  {
    name: "system_sitrep",
    description:
      "A live situation report on this Mac from Glances: CPU and load, memory and swap, disk space, battery, uptime, the busiest processes, and active warnings. " +
      "Use when the user asks how the machine is doing, why it is slow or hot, what is eating CPU or memory, how much disk is left, or for a status or sitrep.",
    schema: {
      sortBy: z.enum(["cpu", "memory"]).optional().describe("Rank the busiest processes by cpu (default) or memory."),
    },
    readOnly: true,
    handler: async (a) => {
      const { systemSitrep, withAutostart } = await import("../selfhosted.js");
      try {
        const r = await withAutostart("glances", appRoot(), () => systemSitrep(a.sortBy === "memory" ? "memory" : "cpu"));
        const { text, ...data } = r;
        return { text, data: data as any };
      } catch (err: any) {
        return { text: `No sitrep: ${err?.message ?? err}`, status: "failed" };
      }
    },
  },
  {
    name: "run_terminal_command",
    description:
      "Run an arbitrary bash command in the background. Use this for 'Agentic' coding, building projects, testing code, creating folders, or executing scripts. " +
      "For a git repository, prefer create_worktree to try something before touching the real checkout. " +
      "For a non-git directory, pass sandbox:true to run the SAME way — against an isolated copy — for a command you are not sure about (an installer, a generator, an untested script).",
    schema: {
      command: z.string().describe("The bash command to run."),
      cwd: z.string().optional().describe("The working directory. Defaults to the Jarvis app path."),
      sandbox: z
        .boolean()
        .optional()
        .describe(
          "Run against an ISOLATED COPY of cwd instead of the real directory — nothing here can touch the user's actual files. " +
            "For a git repo, use create_worktree instead, which does the same thing properly (a real branch, mergeable). " +
            "Reports where the copy lives, so you can inspect it or copy changes back yourself once you're confident."
        ),
    },
    readOnly: false,
    handler: async (a) => {
      const realCwd = a.cwd || getAppPath();
      let runCwd = realCwd;
      let sandboxPath: string | null = null;

      if (a.sandbox) {
        const { tmpdir } = await import("node:os");
        const { randomUUID } = await import("node:crypto");
        const { execFile } = await import("node:child_process");
        sandboxPath = join(tmpdir(), `echo-sandbox-${randomUUID()}`);
        try {
          mkdirSync(sandboxPath, { recursive: true });
          // execFile with an argument array, not a shell string: realCwd is
          // arbitrary model-supplied text, and cp's own "/." suffix (copy this
          // directory's CONTENTS) needs no shell globbing to work.
          await new Promise<void>((resolve, reject) => {
            execFile("/bin/cp", ["-R", `${realCwd}/.`, `${sandboxPath}/`], (err) => (err ? reject(err) : resolve()));
          });
          runCwd = sandboxPath;
        } catch (err: any) {
          return {
            text: `Could not set up the sandbox copy: ${err?.message ?? err}. Nothing was run.`,
            status: "failed",
            error: { category: "filesystem", message: String(err?.message ?? err) },
          };
        }
      }

      return new Promise((resolve) => {
        exec(a.command, { cwd: runCwd }, (error, stdout, stderr) => {
          let output = "";
          if (sandboxPath) output += `[ran in an isolated copy — the real directory (${realCwd}) was not touched: ${sandboxPath}]\n`;
          if (stdout) output += `STDOUT:\n${stdout}\n`;
          if (stderr) output += `STDERR:\n${stderr}\n`;
          if (error) output += `ERROR:\n${error.message}\n`;
          if (sandboxPath) output += `\nReview the sandbox at ${sandboxPath}, or copy specific files back once you trust the result — nothing is applied automatically.`;
          resolve({ text: output.trim() || "Command executed successfully with no output.",
            status: error ? "failed" : "success", verification: "unverified",
            data: { exitCode: error?.code ?? 0, stdout, stderr, sandboxPath },
            ...(error ? { error: { category: "process_exit", message: error.message, retryable: false } } : {}) });
        });
      });
    },
  },
  {
    name: "write_local_file",
    description: "Write raw text or code to a local file. Use this instead of trying to open an editor when asked to write code.",
    schema: {
      path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("The file contents"),
    },
    readOnly: false,
    handler: async (a) => {
      try {
        writeFileSync(a.path, a.content, "utf8");
        return { text: `Wrote ${a.content.length} characters to ${a.path}`, status: "success", verification: "unverified", data: { path: a.path, characters: a.content.length } };
      } catch (err: any) {
        return { text: `Failed to write file: ${err.message}`, status: "failed", error: { category: "filesystem", message: err.message }, verification: "unverified" };
      }
    },
  },
  {
    name: "read_local_file",
    description: "Read the contents of a local file into context. Use this to read files to summarize them offline.",
    schema: {
      path: z.string().describe("Absolute path to the file"),
    },
    readOnly: true,
    handler: async (a) => {
      try {
        const text = readFileSync(a.path, "utf8");
        return { text: text.slice(0, 10000) }; // prevent massive overflow
      } catch (err: any) {
        return { text: `Failed to read file: ${err.message}`, status: "failed", error: { category: "filesystem", message: err.message }, verification: "unverified" };
      }
    },
  },
  {
    name: "change_mac_voice",
    description: "Change the default local text-to-speech voice used by Jarvis. Use names like 'Daniel', 'Samantha', 'Alex', etc.",
    schema: {
      voiceName: z.string().describe("The exact name of the Mac voice to use."),
    },
    readOnly: false,
    handler: async (a) => {
      const configPath = join(getAppPath(), "config.json");
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        config.voice = config.voice || {};
        config.voice.ttsVoice = a.voiceName;
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      }
      return { text: `My voice is now set to ${a.voiceName} in config.json. This will apply fully on the next restart.` };
    },
  },
  {
    name: "switch_brain",
    description: "Switch Echo's brain between Claude, Gemini, and Ollama (the local model). The swap happens live — no restart — though it does start a fresh conversation on the new brain. Use this when the user asks you to switch models or brains.",
    schema: {
      brain: z.enum(["claude", "gemini", "ollama"]).describe("Which brain to use"),
    },
    readOnly: false,
    handler: async (a) => {
      // The live swap lives in the main process, reached through the same kind
      // of global the brain itself is — importing main.ts here would be a cycle.
      // A tool cannot simply return after replacing the brain that is running
      // it, so the loop is told this exit was deliberate, exactly as the old
      // restart path did.
      const swap = (globalThis as any).__switchBrain as ((p: string) => Promise<string>) | undefined;
      if (typeof swap === "function") {
        currentLoop()?.exit("abort_signal", { detail: `switch_brain to ${a.brain} — swapping the brain live` });
        return { text: await swap(a.brain) };
      }

      // Fallback for a build where the main process never registered the swap
      // (tests, tooling): the original config-rewrite-and-relaunch.
      const configPath = join(appRoot(), "config.json");
      if (!existsSync(configPath)) {
        return { text: "config.json not found." };
      }
      try {
        const raw = readFileSync(configPath, "utf8");
        const config = JSON.parse(raw);
        config.brain = a.brain;
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
        
        // A tool that kills the process looks identical to the silent-stop bug
        // from the outside: the log just ends. Say on the way out that this was
        // deliberate, so a reader is not left guessing which of the two it was.
        currentLoop()?.exit("abort_signal", {
          detail: `switch_brain to ${a.brain} — restarting the app on purpose`,
        });

        setTimeout(async () => {
          // app.exit() force-terminates without firing will-quit, so tear down
          // here or this path orphans the camera helpers, the whisper server and
          // the `say` child — the very hole main.ts's spoken brain-switch avoids
          // by calling shutdown() directly. runShutdown() reaches that same
          // handler without importing main.ts (which would cycle). The old note
          // that it was "undefined" was only a missing import, now added above.
          await runShutdown();
          const el = electronApp();
          el?.relaunch();
          el?.exit(0);
        }, 1000);
        
        return { text: `Successfully updated config to use ${a.brain}. Restarting application now.` };
      } catch (err: any) {
        return { text: `Failed to switch brain: ${err.message}` };
      }
    },
  },
  {
    name: "pause_media",
    description: "Pause whatever audio or video is playing — Music, Spotify, or a video in the browser.",
    schema: {},
    readOnly: false,
    handler: async () => ({
      text: (await pauseAllMedia()) ? "Paused." : "Nothing seemed to be playing.",
    }),
  },
  {
    name: "lock_screen",
    description: "Lock the screen immediately.",
    schema: {},
    readOnly: false,
    handler: async () => {
      await lockScreen();
      return { text: "Locking up." };
    },
  },
  {
    name: "read_changelog",
    description: "Read the history of your system updates and new features. Call this when the user asks what features they have added to you, or what your current update/build includes. This will automatically display the log on the user's GUI for 7 seconds as well.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const p = join(appRoot(), "changelog.json");
      if (!existsSync(p)) return { text: "No changelog found." };
      
      const logData = JSON.parse(readFileSync(p, "utf8"));
      let logText = "";
      
      // Build a readable string and an HTML version for the GUI
      let htmlContent = "<ul>";
      for (const entry of logData) {
        logText += `\\nUpdates on ${entry.date}:\\n`;
        for (const feat of entry.features) {
          logText += `- ${feat}\\n`;
          htmlContent += `<li style="margin-bottom:8px;">${feat}</li>`;
        }
      }
      htmlContent += "</ul>";
      
      // Send to the overlay GUI data pane for 7 seconds
      sendToOverlay("show-data-pane", {
        title: "SYSTEM CHANGELOG",
        content: htmlContent,
        duration: 7000
      });
      
      return { text: `Changelog:\n${logText}` };
    }
  },
  {
    name: "restart_system",
    description: "Reboots your entire core system and reloads the UI. Use this when the user asks you to restart, reboot, or refresh yourself.",
    schema: {},
    readOnly: false,
    handler: async () => {
      const { exec } = await import("child_process");
      exec("npm run build", { cwd: getAppPath() }, async (err) => {
        if (err) {
          console.error("Build failed during restart:", err);
          return;
        }
        await runShutdown();
        const el = electronApp();
        el?.relaunch();
        el?.exit(0);
      });
      return { text: "Rebooting system now." };
    }
  },
  {
    name: 'adjust_brightness',
    description: 'Adjusts the Mac screen brightness by simulating the physical brightness keys. You cannot set an absolute percentage.',
    schema: {
      action: z.enum(['up', 'down']).describe('Whether to turn the brightness up or down.'),
      steps: z.number().optional().describe('How many times to press the key (default 1, max 16).')
    },
    readOnly: false,
    handler: async (a: { action: 'up' | 'down', steps?: number }) => {
      const steps = Math.min(Math.max(a.steps || 1, 1), 16);
      const keyCode = a.action === 'up' ? 144 : 145;
      
      // Build a script that presses the key multiple times
      const scriptLines = Array.from({ length: steps }, () => `key code ${keyCode}`).join("\\n");
      const script = `tell application "System Events"\n${scriptLines}\nend tell`;
      
      const { execSync } = await import("node:child_process");
      execSync(`osascript -e '${script}'`);
      return `Pressed brightness ${a.action} ${steps} time(s).`;
    }
  } as any,
  {
    name: 'control_mac_setting',
    description: 'Controls Mac system settings like WiFi, Bluetooth, Volume, Dark Mode, Sleep, and Screen Saver.',
    schema: {
      setting: z.enum(['wifi', 'bluetooth', 'volume', 'mute', 'dark_mode', 'sleep', 'screen_saver', 'do_not_disturb']),
      action: z.enum(['on', 'off', 'toggle', 'set']).optional().describe('Action to perform (default toggle)'),
      value: z.number().optional().describe('Used for setting volume level (0-100).')
    },
    readOnly: false,
    handler: async (a: { setting: string, action?: string, value?: number }) => {
      const { execSync } = await import('node:child_process');
      const { existsSync } = await import('node:fs');
      
      switch (a.setting) {
        case 'wifi': {
          const wifiState = a.action === 'on' ? 'on' : a.action === 'off' ? 'off' : 'toggle';
          if (wifiState === 'toggle') {
            const out = execSync('networksetup -getairportpower en0').toString();
            const turnTo = out.includes('On') ? 'off' : 'on';
            execSync(`networksetup -setairportpower en0 ${turnTo}`);
            return `Wi-Fi turned ${turnTo}.`;
          } else {
            execSync(`networksetup -setairportpower en0 ${wifiState}`);
            return `Wi-Fi turned ${wifiState}.`;
          }
        }
          
        case 'bluetooth': {
          if (!existsSync('/opt/homebrew/bin/blueutil')) {
            execSync('brew install blueutil', { stdio: 'ignore' });
          }
          const btState = a.action === 'on' ? '1' : a.action === 'off' ? '0' : 'toggle';
          if (btState === 'toggle') {
            execSync('/opt/homebrew/bin/blueutil -p toggle');
            return 'Bluetooth toggled.';
          } else {
            execSync(`/opt/homebrew/bin/blueutil -p ${btState}`);
            return `Bluetooth turned ${btState === '1' ? 'on' : 'off'}.`;
          }
        }
          
        case 'volume': {
          if (a.value !== undefined) {
            execSync(`osascript -e 'set volume output volume ${a.value}'`);
            return `Volume set to ${a.value}%.`;
          } else {
            return 'Volume setting requires a value (0-100). Use the mute setting to mute/unmute.';
          }
        }
          
        case 'mute': {
          const muteState = a.action === 'on' ? 'true' : a.action === 'off' ? 'false' : 'toggle';
          if (muteState === 'toggle') {
            const out = execSync(`osascript -e 'output muted of (get volume settings)'`).toString().trim();
            const turnTo = out === 'true' ? 'false' : 'true';
            execSync(`osascript -e 'set volume output muted ${turnTo}'`);
            return turnTo === 'true' ? 'Muted.' : 'Unmuted.';
          } else {
            execSync(`osascript -e 'set volume output muted ${muteState}'`);
            return muteState === 'true' ? 'Muted.' : 'Unmuted.';
          }
        }
          
        case 'dark_mode': {
          const dmState = a.action === 'on' ? 'true' : a.action === 'off' ? 'false' : 'not dark mode';
          execSync(`osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to ${dmState}'`);
          return 'Dark mode adjusted.';
        }
          
        case 'sleep': {
          execSync('pmset sleepnow');
          return 'System put to sleep.';
        }
          
        case 'screen_saver': {
          execSync('open -a ScreenSaverEngine');
          return 'Screen saver started.';
        }
          
        case 'do_not_disturb': {
          const out = execSync('shortcuts list').toString();
          const shortcutName = ['Toggle Do Not Disturb', 'Do Not Disturb', 'Toggle Focus', 'Focus'].find(name => out.includes(name));
          if (shortcutName) {
            execSync(`shortcuts run "${shortcutName}"`);
            return `Toggled Do Not Disturb via Apple Shortcut: ${shortcutName}`;
          } else {
            return 'Failed: On modern macOS, Apple blocks CLI access to Do Not Disturb/Focus modes. Please tell the user exactly this: "Apple has locked down Focus modes, but if you open the Apple Shortcuts app and create a simple shortcut named \\"Toggle Do Not Disturb\\" that turns Focus on and off, I will be able to trigger it for you next time!"';
          }
        }
          
        default:
          return 'Unknown setting.';
      }
    }
  } as any,
  {
    name: "set_hud_skin",
    description:
      "Change which reactor the on-screen HUD shows. 'classic' is the round coil reactor drawn in CSS; 'mark50' is the triangular chest reactor; 'jarvis' is the segmented J.A.R.V.I.S interface reactor. Use when the user asks to change how you look, switch the reactor, or asks for a specific one by name. Pass no skin to report the current one.",
    schema: {
      skin: z
        .enum(["classic", "mark50", "jarvis"])
        .optional()
        .describe("Which reactor to show. Omit to report what is showing now."),
    },
    readOnly: false,
    handler: async (a) => {
      const { sendHudState } = await import("../../frontier/hudstate.js");
      const configPath = join(appRoot(), "config.json");

      let config: any = {};
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, "utf8"));
        } catch {
          /* a broken config should not stop the HUD from changing */
        }
      }
      const current = config?.hud?.skin ?? "classic";
      const SKIN_NAMES: Record<string, string> = { classic: "classic", mark50: "Mark 50", jarvis: "J.A.R.V.I.S" };
      const nameOf = (skin: string) => SKIN_NAMES[skin] ?? skin;

      if (!a.skin) {
        return { text: `Currently showing the ${nameOf(current)} reactor.` };
      }
      if (a.skin === current) {
        return { text: `Already showing the ${nameOf(a.skin)} reactor.` };
      }

      // Change what is on screen first — the HUD should respond immediately,
      // whether or not the config can be written.
      sendHudState({ skin: a.skin });

      // Then remember it, so it survives a restart. No relaunch needed: the
      // renderer swaps skins live.
      let saved = true;
      try {
        config.hud = { ...(config.hud ?? {}), skin: a.skin };
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      } catch {
        saved = false;
      }

      const name = nameOf(a.skin);
      return {
        text: saved
          ? `Switched to the ${name} reactor.`
          : `Switched to the ${name} reactor for now — I couldn't save it, so it will revert on restart.`,
      };
    },
  },
];
