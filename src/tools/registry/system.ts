/** The Mac and Echo itself: shell, files, settings, health, brains, voice and restarts. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import * as system from "../system.js";
import { getAppPath } from "../../utils/appPath.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sendToOverlay } from "../../overlay.js";
import { currentLoop } from "../../agent-replay/loop-log.js";
import { currentAgentRunContext } from '../../agent-replay/context.js';
import { runShutdown } from "../../lifecycle.js";
import { exec, execFile } from "node:child_process";
import { pauseAllMedia, lockScreen } from "../../frontier/presence.js";
import { check_health } from "../health.js";
import { electronApp, appRoot } from "./shared.js";
import { runCommand } from '../../system/terminal.js';
import { activeConfig, readUserConfig, writeUserConfig } from "../../config.js";

/** Run a program with an argument list (no shell), without blocking the main process. */
function runFile(bin: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout ?? ""),
        error: err ? String(stderr || err.message).trim().slice(0, 300) : "",
      });
    });
  });
}

/**
 * The Wi-Fi interface. It is not always en0: on a Mac with built-in Ethernet
 * en0 is the Ethernet port, and switching "Wi-Fi" off there did nothing.
 */
async function wifiDevice(): Promise<string | null> {
  const r = await runFile("/usr/sbin/networksetup", ["-listallhardwareports"]);
  if (!r.ok) return null;
  const m = /Hardware Port:\s*(?:Wi-Fi|AirPort)\s*\nDevice:\s*(\S+)/i.exec(r.stdout);
  return m?.[1] ?? null;
}

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
      "Run a bounded bash command and return its output. Use start_process for persistent servers. Use this for 'Agentic' coding, building projects, testing code, creating folders, or executing scripts. " +
      "For a git repository, prefer create_worktree to try something before touching the real checkout. " +
      "For a non-git directory, pass sandbox:true to run the SAME way — against a working copy — for a command you are not sure about (an installer, a generator, an untested script).",
    schema: {
      command: z.string().min(1).max(64000).describe("The bash command to run."),
      timeoutMs: z.number().int().min(1).max(600000).optional().describe("Wall time limit, default 120,000 ms; use start_process for longer jobs."),
      cwd: z.string().optional().describe("The working directory. Defaults to the user's configured working folder (their home folder unless they changed it)."),
      sandbox: z
        .boolean()
        .optional()
        .describe(
          "Run in a working COPY of cwd. This is not an OS sandbox: absolute paths, symlinks and network access remain available. " +
            "For a git repo, use create_worktree instead, which does the same thing properly (a real branch, mergeable). " +
            "Reports where the copy lives, so you can inspect it or copy changes back yourself once you're confident."
        ),
    },
    readOnly: false,
    handler: async (a) => {
      // The user's working folder, not Echo's own install. Defaulting to the
      // app path ran every cwd-less command inside Echo's source tree, while
      // the risk gate judged it against the working folder instead.
      const realCwd = a.cwd || activeConfig(getAppPath()).control.workingDir;
      let runCwd = realCwd;
      let sandboxPath: string | null = null;

      if (a.sandbox) {
        const { tmpdir } = await import("node:os");
        const { randomUUID } = await import("node:crypto");
        sandboxPath = join(tmpdir(), `echo-sandbox-${randomUUID()}`);
        try {
          mkdirSync(sandboxPath, { recursive: true });
          // execFile with an argument array, not a shell string: realCwd is
          // arbitrary model-supplied text, and cp's own "/." suffix (copy this
          // directory's CONTENTS) needs no shell globbing to work.
          const copied = await runCommand("/bin/cp", ["-R", `${realCwd}/.`, `${sandboxPath}/`], realCwd, 30_000, currentAgentRunContext()?.toolSignal);
          if (copied.status !== "success") throw new Error(copied.error || copied.stderr || `Copy ${copied.status}`);
          runCwd = sandboxPath;
        } catch (err: any) {
          return {
            text: `Could not set up the sandbox copy: ${err?.message ?? err}. Nothing was run.`,
            status: "failed",
            error: { category: "filesystem", message: String(err?.message ?? err) },
          };
        }
      }

      const result = await runCommand('/bin/bash', ['-c', a.command], runCwd, a.timeoutMs, currentAgentRunContext()?.toolSignal);
      const sections = [
        sandboxPath ? `Working copy: ${sandboxPath}. Absolute paths and symlinks can still reach files outside it.` : '',
        result.stdout ? `STDOUT:\n${result.stdout}` : '',
        result.stderr ? `STDERR:\n${result.stderr}` : '',
        result.truncated ? '[output truncated at 64,000 characters]' : '',
        result.status !== 'success' ? `Command ${result.status}; exit code ${result.exitCode ?? 'none'}${result.signal ? `, signal ${result.signal}` : ''}. ${result.error ?? ''}` : '',
      ].filter(Boolean);
      return {text: sections.join('\n') || 'Command completed with no output.', status: result.status, verification: 'unverified',
        data: {...result, sandboxPath},
        ...(result.status !== 'success' ? {error: {category: result.status === 'failed' ? 'process_exit' : result.status, message: result.error || `Command ${result.status}`, retryable: false}} : {})};
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
      // Saved to the user's own config, the one Echo actually loads. It used
      // to go to <app>/config.json, which that one overrides — so the change
      // was announced and then lost on the next launch.
      try {
        const config = readUserConfig(appRoot());
        config.voice = { ...(config.voice ?? {}), ttsVoice: a.voiceName };
        writeUserConfig(config);
      } catch (err: any) {
        return { text: `Could not save the voice: ${err?.message ?? err}`, status: "failed" };
      }
      activeConfig(appRoot()).voice.ttsVoice = a.voiceName;
      return { text: `Saved ${a.voiceName} as my voice. It takes effect the next time I start.` };
    },
  },
  {
    name: "switch_brain",
    description: "Switch Echo's brain between Claude, Gemini, OpenAI, OpenRouter, NVIDIA / Kimi, and Ollama (the local model). The swap happens live — no restart — though it does start a fresh conversation on the new brain. Use this when the user asks you to switch models or brains.",
    schema: {
      brain: z.enum(["claude", "gemini", "ollama", "openai", "openrouter", "nvidia"]).describe("Which brain to use"),
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
      try {
        const config = readUserConfig(appRoot());
        config.brain = a.brain;
        writeUserConfig(config);
        
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
      const el = electronApp();
      if (!el) return { text: "I can only restart myself when running as the app.", status: "failed" };
      // Rebuilding first only makes sense when running from source. An
      // installed app has no npm and no source to build — this used to try
      // anyway, fail, and never restart while having already said it would.
      if (!el.isPackaged) {
        const built = await new Promise<{ ok: boolean; error: string }>((resolve) =>
          exec("npm run build", { cwd: getAppPath(), timeout: 180_000 }, (err, _out, stderr) =>
            resolve({ ok: !err, error: String(stderr || err?.message || "").trim().slice(-400) })
          )
        );
        if (!built.ok) {
          return { text: `The rebuild failed, so I haven't restarted: ${built.error}`, status: "failed" };
        }
      }
      currentLoop()?.exit("abort_signal", { detail: "restart_system — restarting the app on purpose" });
      setTimeout(async () => {
        await runShutdown();
        el.relaunch();
        el.exit(0);
      }, 1000);
      return { text: "Restarting now." };
    }
  },
  {
    name: "adjust_brightness",
    description: "Adjusts the Mac screen brightness by simulating the physical brightness keys. You cannot set an absolute percentage.",
    schema: {
      action: z.enum(["up", "down"]).describe("Whether to turn the brightness up or down."),
      steps: z.number().optional().describe("How many times to press the key (default 1, max 16)."),
    },
    readOnly: false,
    handler: async (a: { action: "up" | "down"; steps?: number }) => {
      const steps = Math.min(Math.max(Math.round(a.steps || 1), 1), 16);
      const keyCode = a.action === "up" ? 144 : 145;
      const lines = Array.from({ length: steps }, () => `key code ${keyCode}`).join("\n");
      const r = await runFile("/usr/bin/osascript", ["-e", `tell application "System Events"\n${lines}\nend tell`]);
      if (!r.ok) return { text: `Could not change the brightness: ${r.error}`, status: "failed" };
      return { text: `Pressed brightness ${a.action} ${steps} time(s).` };
    },
  },
  {
    name: "control_mac_setting",
    description: "Controls Mac system settings like WiFi, Bluetooth, Volume, Dark Mode, Sleep, and Screen Saver.",
    schema: {
      setting: z.enum(["wifi", "bluetooth", "volume", "mute", "dark_mode", "sleep", "screen_saver", "do_not_disturb"]),
      action: z.enum(["on", "off", "toggle", "set"]).optional().describe("Action to perform (default toggle)"),
      value: z.number().optional().describe("Used for setting volume level (0-100)."),
    },
    readOnly: false,
    // Every command here runs as a child process, never execSync: this handler
    // runs in Electron's main process, and a blocking call froze the HUD, the
    // microphone and the speech player for as long as it took.
    handler: async (a: { setting: string; action?: string; value?: number }) => {
      const osa = (script: string) => runFile("/usr/bin/osascript", ["-e", script]);
      const failed = (what: string, error: string) => ({ text: `Could not ${what}: ${error}`, status: "failed" as const });

      switch (a.setting) {
        case "wifi": {
          const device = await wifiDevice();
          if (!device) return failed("change Wi-Fi", "this Mac has no Wi-Fi interface");
          let turnTo = a.action === "on" ? "on" : a.action === "off" ? "off" : "";
          if (!turnTo) {
            const now = await runFile("/usr/sbin/networksetup", ["-getairportpower", device]);
            if (!now.ok) return failed("read the Wi-Fi state", now.error);
            turnTo = /\bOn\b/.test(now.stdout) ? "off" : "on";
          }
          const r = await runFile("/usr/sbin/networksetup", ["-setairportpower", device, turnTo]);
          return r.ok ? { text: `Wi-Fi turned ${turnTo}.` } : failed(`turn Wi-Fi ${turnTo}`, r.error);
        }

        case "bluetooth": {
          // Never installed on the user's behalf: installing software is a
          // decision for them, and `brew install` could hold the turn for minutes.
          const blueutil = ["/opt/homebrew/bin/blueutil", "/usr/local/bin/blueutil"].find((b) => existsSync(b));
          if (!blueutil) {
            return {
              text: "Bluetooth control needs the free `blueutil` tool, which isn't installed. Tell the user they can install it with `brew install blueutil`, then ask again.",
              status: "failed",
            };
          }
          const state = a.action === "on" ? "1" : a.action === "off" ? "0" : "toggle";
          const r = await runFile(blueutil, ["-p", state]);
          if (!r.ok) return failed("change Bluetooth", r.error);
          return { text: state === "toggle" ? "Bluetooth toggled." : `Bluetooth turned ${state === "1" ? "on" : "off"}.` };
        }

        case "volume": {
          if (a.value === undefined) {
            return { text: "Volume needs a value from 0 to 100. Use the mute setting to mute or unmute.", status: "failed" };
          }
          const level = Math.min(100, Math.max(0, Math.round(a.value)));
          const r = await osa(`set volume output volume ${level}`);
          return r.ok ? { text: `Volume set to ${level}%.` } : failed("set the volume", r.error);
        }

        case "mute": {
          let muted = a.action === "on" ? "true" : a.action === "off" ? "false" : "";
          if (!muted) {
            const now = await osa("output muted of (get volume settings)");
            if (!now.ok) return failed("read the mute state", now.error);
            muted = now.stdout.trim() === "true" ? "false" : "true";
          }
          const r = await osa(`set volume output muted ${muted}`);
          return r.ok ? { text: muted === "true" ? "Muted." : "Unmuted." } : failed("change mute", r.error);
        }

        case "dark_mode": {
          const state = a.action === "on" ? "true" : a.action === "off" ? "false" : "not dark mode";
          const r = await osa(`tell application "System Events" to tell appearance preferences to set dark mode to ${state}`);
          return r.ok ? { text: "Dark mode adjusted." } : failed("change dark mode", r.error);
        }

        case "sleep": {
          const r = await runFile("/usr/bin/pmset", ["sleepnow"]);
          return r.ok ? { text: "Putting the Mac to sleep." } : failed("put the Mac to sleep", r.error);
        }

        case "screen_saver": {
          const r = await runFile("/usr/bin/open", ["-a", "ScreenSaverEngine"]);
          return r.ok ? { text: "Screen saver started." } : failed("start the screen saver", r.error);
        }

        case "do_not_disturb": {
          const list = await runFile("/usr/bin/shortcuts", ["list"]);
          const names = list.ok ? list.stdout.split("\n").map((l) => l.trim()) : [];
          const shortcutName = ["Toggle Do Not Disturb", "Do Not Disturb", "Toggle Focus", "Focus"].find((n) => names.includes(n));
          if (!shortcutName) {
            return {
              text: 'macOS does not let apps switch Focus modes directly. Tell the user: "If you create a shortcut named \"Toggle Do Not Disturb\" in the Shortcuts app that turns Focus on and off, I can run it for you."',
              status: "failed",
            };
          }
          const r = await runFile("/usr/bin/shortcuts", ["run", shortcutName]);
          return r.ok ? { text: `Toggled Do Not Disturb with your "${shortcutName}" shortcut.` } : failed("toggle Do Not Disturb", r.error);
        }

        default:
          return { text: `Unknown setting "${a.setting}".`, status: "failed" };
      }
    },
  },
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
      // The live config says what is showing; the user's config file is where
      // the choice is kept. Both used to be <app>/config.json, which Echo does
      // not load once the user's own config exists — so "saved" reverted.
      const live = activeConfig(appRoot());
      const current = live.hud?.skin ?? "classic";
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
      live.hud = { ...(live.hud ?? {}), skin: a.skin } as typeof live.hud;

      let saved = true;
      try {
        const config = readUserConfig(appRoot());
        config.hud = { ...(config.hud ?? {}), skin: a.skin };
        writeUserConfig(config);
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
