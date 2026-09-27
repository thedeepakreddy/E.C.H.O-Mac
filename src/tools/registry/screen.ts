/** Seeing and driving the Mac: screenshots, the accessibility tree, OCR, mouse, keyboard, apps, windows and displays. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import * as act from "../computer-actions.js";
import * as ax from "../ax.js";
import { deepHookClick } from "../deep-hook.js";
import * as vision from "../vision.js";
import { activeConfig } from "../../config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contains, desktopToScreenshot, describeDisplays, displayAt, resolveDisplay, screenshotToDesktop,
  type Display, type Point,
} from "../displays.js";
import { moveFrontWindowTo } from "../windowmove.js";
import { sendToOverlay } from "../../overlay.js";
import { typeText } from "../computer-actions.js";
import { exec } from "node:child_process";
import * as demo from "../../frontier/demonstrate.js";
import * as extract from "../../frontier/extract.js";
import { dismissPopups } from "../../frontier/popups.js";
import { nodeRequire, appRoot, pointerAt, describeDisplayShort } from "./shared.js";

/**
 * Resolve coordinates supplied by a model into the desktop space macOS uses.
 * With `display`, x/y are local to that display's screenshot. Without it they
 * remain global for compatibility with Accessibility and OCR coordinates.
 */
async function desktopPoint(x: number, y: number, display?: string): Promise<Point> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Coordinates must be finite numbers.");
  }

  const list = await vision.displays();
  if (!list.length) return { x, y }; // helper unavailable: preserve the old path

  if (display) {
    const chosen = resolveDisplay(list, display, await pointerAt());
    if (!chosen) throw new Error(`I couldn't resolve display "${display}".`);
    const mapped = screenshotToDesktop(chosen, { x, y });
    if (!mapped) {
      throw new Error(
        `Point ${x},${y} is outside display ${chosen.index + 1}'s ` +
        `${chosen.width}x${chosen.height} screenshot. I did not move or click.`
      );
    }
    return mapped;
  }

  const point = { x, y };
  if (!list.some((candidate) => contains(candidate, point))) {
    throw new Error(`Desktop point ${x},${y} is outside every attached display. I did not move or click.`);
  }
  return point;
}

const DISPLAY_COORDINATE_DESCRIPTION =
  "Optional display name/number. When set, x/y are coordinates inside that display's screenshot and Echo translates them to desktop coordinates.";

export const SCREEN_TOOLS: ToolDef[] = [
  {
    name: "screenshot",
    description:
      "Capture one display as an image. This is the LAST of the three ways to look: use list_ui_elements for controls and read_screen_text for words. The result gives the exact image size and desktop origin. When acting on image coordinates, pass the same `display` to click, move_mouse, drag, set_value, scroll, or background_click so Echo translates display-local pixels into global desktop coordinates. Never reuse coordinates after the screen layout changes.",
    schema: {
      display: z
        .string()
        .optional()
        .describe("Which screen to capture: 'other', 'left', 'right', 'main', 'external', 'second'. Defaults to the one the pointer is on."),
    },
    readOnly: true,
    handler: async (a) => {
      const list = await vision.displays();
      // Default to the screen the user is actually working on rather than
      // always the primary — with two monitors those are often not the same.
      const chosen = list.length
        ? resolveDisplay(list, a.display ?? "this", await pointerAt())
        : null;

      const shot = await act.captureScreen(chosen ?? undefined);
      const displayHint = chosen ? `"${chosen.index + 1}"` : undefined;
      const which = chosen
        ? ` This is display ${chosen.index + 1} of ${list.length} (${describeDisplayShort(chosen, list)}).`
        : "";
      return {
        text:
          `Screen captured at exactly ${shot.width}x${shot.height} logical pixels.${which} ` +
          `Image coordinate (0,0) maps to desktop (${shot.originX},${shot.originY}). ` +
          (displayHint
            ? `For a point read from this image, pass display: ${displayHint} to a mouse tool; use the image x/y unchanged.`
            : "This is the main desktop origin, so image and desktop coordinates are identical."),
        image: shot,
      };
    },
  },
  {
    name: "list_ui_elements",
    description:
      "List the interactive controls (buttons, fields, links, checkboxes, menus) of the frontmost app from the macOS accessibility tree, with their exact labels and centre coordinates. FIRST choice when you need to click something: it tells you what the control is really called, so nothing is guessed. Costs no image. If it reports no accessibility data — usual for Chrome, Brave and some Electron apps — switch to read_screen_text and click_text rather than screenshot.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const d = await ax.dump();
      return { text: ax.summarize(d) };
    },
  },
  {
    name: "click_ui_element",
    description:
      "Click a control by describing it ('the Send button', 'Search field', 'Sign in'), resolved against the accessibility tree rather than pixels. FIRST choice for clicking: it activates the control directly, needs no mouse movement, and still works when the control is partly covered or the window has moved. Call list_ui_elements first if you are unsure of the exact label. If the app exposes no accessibility tree, use click_text instead.",
    schema: {
      description: z
        .string()
        .describe("What to click, in words — the visible label works best"),
    },
    readOnly: false,
    handler: async (a) => {
      const d = await ax.dump();
      if (!d.axAvailable || !d.elements.length) {
        return {
          text: `No accessibility data for ${d.app}${d.error ? ` (${d.error})` : ""}. Take a screenshot and click by coordinates instead.`,
        };
      }
      const scored = ax.rankScored(d.elements, a.description);
      if (!scored.length) {
        return {
          text: `Nothing in ${d.app} matches "${a.description}". Elements available: ${d.elements
            .slice(0, 20)
            .map((e) => `"${e.label}"`)
            .filter((l) => l !== '""')
            .join(", ")}. Or use a screenshot.`,
        };
      }

      // The critic (AGI blueprint #1): `rankScored` was computing exactly how
      // well the top candidate fits and it used to be thrown away. Two shapes
      // of a bad guess are visible in the scores alone, for free — no model
      // call, no extra screen read, checked before anything is clicked rather
      // than discovered afterwards from a failed screenshot:
      //   weak     the only match is a single partial word overlap
      //   ambiguous a strong second candidate is nearly as good as the first
      if (activeConfig().agi.critic.enabled) {
        const verdict = ax.criticVerdict(scored);
        if (!verdict.ok) {
          const candidates = scored.slice(0, 5)
            .map((s) => `"${s.element.label || s.element.role.replace(/^AX/, "")}"${s.element.value ? ` (${s.element.value})` : ""}`)
            .join(", ");
          return {
            text:
              (verdict.reason === "weak"
                ? `Not confident "${a.description}" is really on screen in ${d.app} — the best match is a weak, partial guess.`
                : `"${a.description}" is ambiguous in ${d.app} — more than one control fits about equally well.`) +
              ` Candidates, best first: ${candidates}. Call list_ui_elements to see the full picture, or take a screenshot, before clicking.`,
            status: "failed",
            verification: "unverified",
            error: { category: "low_confidence", message: "the critic held this click back — the match was weak or ambiguous", retryable: true },
          };
        }
      }

      const el = scored[0].element;
      const where = `${el.role.replace(/^AX/, "")} "${el.label}"`;

      if (!el.enabled) {
        return {
          text: `${where} in ${d.app} is disabled, so I did not click it.`,
          status: "failed",
          verification: "verified",
          error: { category: "target_disabled", message: "the matched control is disabled", retryable: true },
        };
      }

      // Prefer AXPress — no mouse move, survives occlusion.
      if (el.press) {
        const r = await ax.press(d.pid, el.path);
        if (r.ok) {
          demo.noteStep({ kind: "click", target: a.description, role: el.role });
          return { text: `Activated ${where} in ${d.app}.` };
        }
        return {
          text: `${where} moved or stopped accepting Accessibility actions before it could be pressed, so I did not fall back to a possibly stale coordinate. Look again and retry.`,
          status: "failed",
          verification: "unverified",
          error: { category: "stale_target", message: r.error ?? "AXPress failed", retryable: true },
        };
      }
      // Fallback: click the element's centre.
      const cx = el.x + Math.round(el.w / 2);
      const cy = el.y + Math.round(el.h / 2);
      await act.click(cx, cy, "left");
      demo.noteStep({ kind: "click", target: a.description, role: el.role });
      return { text: `Clicked ${where} at ${cx},${cy} in ${d.app}.` };
    },
  },
  {
    name: "get_screen_info",
    description: "Get the logical width and height of the screen in points.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const s = await act.getScreenInfo();
      return { text: `Screen is ${s.width}x${s.height} logical points.` };
    },
  },
  {
    name: "move_mouse",
    description: "Move the cursor without clicking. Use for hover UI or to park the pointer before scrolling. Do NOT call this before click because click moves the pointer itself. Coordinates are global desktop points unless `display` is supplied; with `display`, they are local to that display's latest screenshot.",
    schema: {
      x: z.number().describe("X coordinate in logical points from the left edge"),
      y: z.number().describe("Y coordinate in logical points from the top edge"),
      display: z.string().optional().describe(DISPLAY_COORDINATE_DESCRIPTION),
    },
    readOnly: false,
    handler: async (a) => {
      const p = await desktopPoint(a.x, a.y, a.display);
      return { text: await act.moveMouse(p.x, p.y) };
    },
  },
  {
    name: "click",
    description:
      "Click at exact logical coordinates. LAST choice: prefer click_ui_element or click_text. For a point taken from a screenshot, pass that screenshot's `display`; Echo then converts image-local x/y to the correct desktop point, including negative and secondary-monitor origins. Without `display`, x/y must already be global desktop coordinates. button is 'left' (default), 'right', or 'double'.",
    schema: {
      x: z.number().describe("X coordinate in logical points"),
      y: z.number().describe("Y coordinate in logical points"),
      button: z.enum(["left", "right", "double"]).default("left"),
      display: z.string().optional().describe(DISPLAY_COORDINATE_DESCRIPTION),
    },
    readOnly: false,
    handler: async (a) => {
      const p = await desktopPoint(a.x, a.y, a.display);
      return { text: await act.click(p.x, p.y, a.button ?? "left") };
    },
  },
  {
    name: "drag",
    description: "Press at one point, move, and release at another. This is how you move a slider handle that has no number box, reorder a list, select a range of text, or drag a file. If the control has an editable number beside it, set_value is exact and a drag is a guess — prefer set_value.",
    schema: {
      fromX: z.number(),
      fromY: z.number(),
      toX: z.number(),
      toY: z.number(),
      display: z.string().optional().describe(DISPLAY_COORDINATE_DESCRIPTION),
    },
    readOnly: false,
    handler: async (a) => {
      const from = await desktopPoint(a.fromX, a.fromY, a.display);
      const to = await desktopPoint(a.toX, a.toY, a.display);
      return { text: await act.dragTo(from.x, from.y, to.x, to.y) };
    },
  },
  {
    name: "type_text",
    description:
      "Type at the current keyboard focus, as if on the keyboard; newlines are sent as Return. Click the target field first so it has focus. Typing into a field that already has content APPENDS to it — to set a field to an exact value, use set_value, which clears what is there first.",
    schema: { text: z.string().describe("The exact text to type") },
    readOnly: false,
    handler: async (a) => {
      const text = await act.typeText(a.text);
      demo.noteStep({ kind: "type", text: a.text });
      return { text };
    },
  },
  {
    name: "press_keys",
    description:
      "Press a keyboard shortcut or special key, optionally repeated. modifiers is any of cmd, alt, ctrl, shift, fn. key is a single character (e.g. 'c' for Cmd+C) or a named key: return, tab, esc, space, delete, arrow-left, arrow-right, arrow-up, arrow-down, page-up, page-down, home, end, f1..f16. Use repeat to step a focused control — e.g. key 'arrow-up' with repeat 20 nudges a selected slider up 20 steps.",
    schema: {
      modifiers: z
        .array(z.enum(["cmd", "alt", "ctrl", "shift", "fn"]))
        .default([])
        .describe("Modifier keys to hold"),
      key: z.string().describe("Single character or named key"),
      repeat: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(1)
        .describe("How many times to press the key"),
    },
    readOnly: false,
    handler: async (a) => {
      const text = await act.hotkey(a.modifiers ?? [], a.key, a.repeat ?? 1);
      // A workflow replays a shortcut once; "repeat" is how THIS call reached
      // an effect a single press wouldn't (e.g. nudging a slider), which is a
      // property of this invocation, not something to bake into a recording.
      demo.noteStep({ kind: "keys", modifiers: a.modifiers ?? [], key: a.key });
      return { text };
    },
  },
  {
    name: "set_value",
    description:
      "Set an editable field to an EXACT value: double-clicks the field, selects what is there, types the new value and presses Return. This is the precise way to set a numeric control — e.g. a Lightroom slider's number box, a form field, a zoom percentage — instead of nudging it. Take a screenshot first to find the field's coordinates.",
    schema: {
      x: z.number().describe("X coordinate of the editable value field"),
      y: z.number().describe("Y coordinate of the editable value field"),
      value: z.string().describe("The exact value to set, e.g. '+20' or '1024'"),
      display: z.string().optional().describe(DISPLAY_COORDINATE_DESCRIPTION),
    },
    readOnly: false,
    handler: async (a) => {
      const p = await desktopPoint(a.x, a.y, a.display);
      return { text: await act.setValueAt(p.x, p.y, a.value) };
    },
  },
  {
    name: "scroll",
    description:
      "Scroll up or down. If x and y are given the cursor moves there first, which is how you scrub a slider, knob or panel that responds to the scroll wheel under the pointer.",
    schema: {
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(1).max(30).default(5).describe("Roughly how far to scroll"),
      x: z.number().optional().describe("Optional X to hover before scrolling"),
      y: z.number().optional().describe("Optional Y to hover before scrolling"),
      display: z.string().optional().describe(DISPLAY_COORDINATE_DESCRIPTION),
    },
    readOnly: false,
    handler: async (a) => {
      if ((a.x == null) !== (a.y == null)) {
        throw new Error("scroll needs both x and y when a hover point is supplied");
      }
      const p = a.x == null ? undefined : await desktopPoint(a.x, a.y, a.display);
      return { text: await act.scroll(a.direction, a.amount ?? 5, p?.x, p?.y) };
    },
  },
  {
    name: "wait",
    description:
      "Pause for a moment to let the screen catch up — an app finishing launch, a page loading, a render completing. Follow with a screenshot to see the new state.",
    schema: {
      seconds: z.number().min(0.2).max(15).default(1.5).describe("Seconds to wait"),
    },
    readOnly: true,
    handler: async (a) => {
      const s = Math.min(15, Math.max(0.2, a.seconds ?? 1.5));
      await new Promise((r) => setTimeout(r, s * 1000));
      demo.noteStep({ kind: "wait", seconds: s });
      return { text: `waited ${s}s` };
    },
  },
  {
    name: "open_app",
    description: "Open (or focus) a macOS application by name, e.g. 'Safari', 'Google Chrome', 'Visual Studio Code', 'Mail'.",
    schema: { name: z.string() },
    readOnly: false,
    handler: async (a) => {
      const text = await act.openApp(a.name);
      demo.noteStep({ kind: "open", app: a.name });
      return { text };
    },
  },
  {
    name: "open_url",
    description: "Open a URL in the default web browser.",
    schema: { url: z.string() },
    readOnly: false,
    handler: async (a) => ({ text: await act.openUrl(a.url) }),
  },
  {
    name: "frontmost_app",
    description: "Get the name of the application currently in the foreground.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: `Frontmost app: ${await act.frontmostApp()}` }),
  },
  {
    name: "get_mouse_position",
    description: "Get the current cursor position as both a global desktop coordinate and a local coordinate inside the display screenshot under the pointer.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const raw = await act.getMousePosition();
      const [x, y] = raw.split(",").map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { text: raw };
      const list = await vision.displays();
      const display = displayAt(list, { x, y });
      const local = display ? desktopToScreenshot(display, { x, y }) : null;
      if (!display || !local) return { text: `Cursor desktop coordinate: ${x},${y}.` };
      return {
        text:
          `Cursor desktop coordinate: ${x},${y}. ` +
          `It is on display ${display.index + 1} (${describeDisplayShort(display, list)}) ` +
          `at screenshot coordinate ${local.x},${local.y}.`,
      };
    },
  },
  {
    name: "background_click",
    description:
      "Click at screen coordinates WITHOUT moving the physical mouse cursor, by pressing the UI element directly in the frontmost app. Use when you need to click something but must not disturb where the user's cursor is.",
    schema: {
      x: z.number().describe("X coordinate in logical points"),
      y: z.number().describe("Y coordinate in logical points"),
      display: z.string().optional().describe(DISPLAY_COORDINATE_DESCRIPTION),
    },
    readOnly: false,
    handler: async (a) => {
      const p = await desktopPoint(a.x, a.y, a.display);
      const d = await ax.dump();
      if (!d.pid) return { text: "I couldn't find the frontmost app to click into." };
      const r = await deepHookClick(d.pid, p.x, p.y);
      return {
        text: r.ok
          ? `Clicked at ${Math.round(p.x)},${Math.round(p.y)} in ${d.app} without moving the mouse.`
          : `Background click didn't land: ${r.message}`,
      };
    },
  },
  {
    name: "watch_my_screen",
    description: "Starts or stops a periodic background routine that watches the user's screen every 60 seconds to proactively track progress, issues, or what they are researching on Google/ChatGPT/Claude.",
    schema: { enable: z.boolean().describe("True to start watching, false to stop") },
    readOnly: false,
    handler: async (a) => {
      const globalAny: any = global;
      if (a.enable) {
        if (globalAny.watchScreenInterval) clearInterval(globalAny.watchScreenInterval);

        const { loadConfig } = await import("../../config.js");
        const { Tts } = await import("../../voice/tts.js");
        const cfg = loadConfig(appRoot());
        // A speaker built from the app's own voice settings. Created once, not
        // per tick, so it does not stutter.
        const watcherTts = new Tts(
          cfg.voice.ttsVoice, cfg.voice.ttsEnabled, cfg.voice.ttsEngine, cfg.voice.elevenLabsVoiceId,
          undefined, { speaker: cfg.voice.sarvamSpeaker, pace: cfg.voice.sarvamPace }, cfg.voice.piperVoice
        );
        const host = (cfg.ollama.host || "http://localhost:11434").replace(/\/$/, "");

        globalAny.watchScreenInterval = setInterval(async () => {
          try {
            // Read the screen as TEXT on-device — enough to tell the user is on
            // Google or ChatGPT/Claude and possibly stuck, without a paid vision
            // call and without spinning up a second agent that would fight the
            // main one. This uses the real OCR path, not an imagined API.
            const r = await vision.ocr("accurate");
            const text = (r.lines ?? []).map((l) => l.text).join(" ").slice(0, 4000).trim();
            if (text.length < 20) return;

            const prompt =
              `You are quietly watching the user's screen. Here is the on-screen text:\n"""${text}"""\n\n` +
              `If they appear to be searching Google or chatting with ChatGPT/Claude and seem stuck or researching, ` +
              `reply with ONE short, genuinely helpful spoken sentence (max 2 sentences). ` +
              `Otherwise reply with EXACTLY the single word NOTHING.`;

            const res = await fetch(`${host}/api/generate`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model: cfg.ollama.model, prompt, stream: false }),
            });
            if (!res.ok) return;
            const j: any = await res.json();
            const out = String(j?.response ?? "").trim();
            if (out.length > 5 && !/^nothing\b/i.test(out)) {
              console.log("[WatchMyScreen] " + out);
              watcherTts.say(out);
            }
          } catch (e) {
            console.error("[WatchMyScreen] error:", e);
          }
        }, 60000); // every 60s
        return { text: "Started watching your screen. Every 60 seconds I'll glance at it and speak up if you seem to be researching or getting stuck." };
      } else {
        if (globalAny.watchScreenInterval) {
          clearInterval(globalAny.watchScreenInterval);
          globalAny.watchScreenInterval = null;
          return { text: "Stopped proactively watching your screen." };
        }
        return { text: "Screen watching was already off." };
      }
    }
  },
  {
    name: "list_displays",
    description:
      "List every display attached to the machine, with its size and where it sits relative to the main one. Use this when the user mentions monitors or screens, before reading or acting on a specific one, or when they ask how many screens they have.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const list = await vision.displays();
      return { text: describeDisplays(list) };
    },
  },
  {
    name: "read_display_text",
    description:
      "Read the text on a SPECIFIC display, or on all of them. Use this instead of read_screen_text when the user mentions a particular monitor ('what's on my other screen?', 'read the left monitor'). Coordinates returned are global and can be clicked directly.",
    schema: {
      display: z
        .string()
        .optional()
        .describe(
          "Which screen: 'other', 'left', 'right', 'main', 'external', 'second', or 'all' to read every display."
        ),
    },
    readOnly: true,
    handler: async (a) => {
      const list = await vision.displays();
      if (!list.length) return { text: "I can't see any displays." };

      const want = (a.display ?? "").toLowerCase();
      if (/\ball\b|\bboth\b|\bevery\b/.test(want)) {
        const r = await vision.ocrAll("accurate");
        if (r.error) return { text: `Couldn't read the screens: ${r.error}` };
        const byDisplay = new Map<number, string[]>();
        for (const l of r.lines) {
          const k = l.display ?? 0;
          if (!byDisplay.has(k)) byDisplay.set(k, []);
          byDisplay.get(k)!.push(l.text);
        }
        const parts = [...byDisplay.entries()].map(
          ([i, texts]) => `Display ${i + 1}:\n${texts.join(" ")}`
        );
        return { text: parts.join("\n\n") || "No text found on any display." };
      }

      // Resolve against where the pointer is, so "the other one" means
      // something relative to where the user is actually working.
      const chosen = resolveDisplay(list, a.display, await pointerAt());
      if (!chosen) return { text: `I couldn't work out which display you meant.` };

      const r = await vision.ocr("accurate", chosen.index);
      if (r.error) return { text: `Couldn't read display ${chosen.index + 1}: ${r.error}` };
      const text = r.lines.map((l) => l.text).join(" ");
      return {
        text: text
          ? `Display ${chosen.index + 1} (${describeDisplayShort(chosen, list)}):\n${text}`
          : `Display ${chosen.index + 1} has no readable text.`,
      };
    },
  },
  {
    name: "move_window_to_display",
    description:
      "Move the frontmost window to another display. Use this for 'move this to my other monitor', 'put this on the big screen', 'send this to the left screen'.",
    schema: {
      display: z
        .string()
        .describe("Which screen to move it to: 'other', 'left', 'right', 'main', 'external', 'second'."),
      fullscreen: z.boolean().optional().describe("Fill that display after moving."),
    },
    readOnly: false,
    handler: async (a) => {
      const list = await vision.displays();
      if (list.length < 2) {
        return { text: "There's only one display, so there's nowhere to move it to." };
      }
      const target = resolveDisplay(list, a.display, await pointerAt());
      if (!target) return { text: "I couldn't work out which display you meant." };

      const moved = await moveFrontWindowTo(target, a.fullscreen === true);
      return { text: moved };
    },
  },
  {
    name: "analyze_screen_visually",
    description: "Take a hidden screenshot of the user's screen and look at the actual image. Use this when the user asks you to 'look at this graph', 'describe this photo', or 'what is wrong with this UI'. You must have a Multimodal brain (like Gemini) active to understand the returned image.",
    schema: {},
    readOnly: true,
    handler: async () => {
      sendToOverlay("show-targeting");
      const tmpPath = "/tmp/jarvis_vision.jpg";
      return new Promise((resolve) => {
        exec(`screencapture -x -c -t jpg ${tmpPath}`, (err) => {
          if (err) {
            resolve({ text: "Failed to capture screen." });
            return;
          }
          exec("osascript -e 'the clipboard as «class JPEG»'", { encoding: "buffer" }, (err2, stdout) => {
             // Fallback: If clipboard fails, read the temp file. `screencapture -c` puts it in clipboard.
             // Actually, `screencapture -x /tmp/jarvis_vision.jpg` is safer than clipboard. Let's do that.
             exec(`screencapture -x -t jpg ${tmpPath}`, (err3) => {
                try {
                  const data = readFileSync(tmpPath).toString("base64");
                  resolve({
                    text: "I am looking at the image now.",
                    image: { mimeType: "image/jpeg", data, width: 0, height: 0, originX: 0, originY: 0 }
                  });
                } catch {
                  resolve({ text: "Failed to read screenshot." });
                }
             });
          });
        });
      });
    },
  },
  {
    name: "read_screen_text",
    description:
      "FIRST choice when you need to READ something rather than click it. Reads the text on screen with on-device OCR. Nothing leaves the machine and no image enters the conversation, so prefer this over screenshot whenever you only need to READ something: an error, a value, a status, what an app is currently showing. Every line comes back with coordinates, which is also how you click inside Chrome and Brave, whose contents the accessibility tree cannot see. Use screenshot only for layout, colour or images.",
    schema: {
      fast: z.boolean().default(false).describe("Leave this false. Fast mode roughly halves accuracy (measured 0.51 vs 0.95 confidence, garbling words) and is only fit for detecting that the screen changed — never for reading or clicking."),
    },
    readOnly: true,
    handler: async (a) => {
      const list = await vision.displays();
      const chosen = list.length ? resolveDisplay(list, "this", await pointerAt()) : null;
      return { text: vision.summarizeOcr(await vision.ocr(a.fast ? "fast" : "accurate", chosen?.index ?? 0)) };
    },
  },
  {
    name: "click_text",
    description:
      "Click on-screen text by the words visible on it, located with OCR. SECOND choice for clicking, and the one that works inside Chrome, Brave, canvas apps and anything else the accessibility tree cannot see. Give the complete visible label. Echo refuses to guess when the same label appears more than once; provide a longer unique phrase or use list_ui_elements. Defaults to the display containing the pointer.",
    schema: {
      text: z.string().describe("The complete visible text to click on"),
      display: z.string().optional().describe("Display to search: 'this', 'other', 'left', 'right', 'main', 'external', or its number."),
    },
    readOnly: false,
    handler: async (a) => {
      const list = await vision.displays();
      const chosen = list.length
        ? resolveDisplay(list, a.display ?? "this", await pointerAt())
        : null;
      const r = await vision.ocr("accurate", chosen?.index ?? 0);
      if (r.error) return { text: `Could not read the screen (${r.error}).` };
      const matches = vision.rankText(r, a.text);
      const hit = matches[0]?.line;
      if (!hit) return { text: `No on-screen text matches "${a.text}".` };
      if (vision.textMatchIsAmbiguous(matches)) {
        const candidates = matches.slice(0, 5)
          .map((match) => `"${match.line.text}" at ${match.line.cx},${match.line.cy}`)
          .join("; ");
        return {
          text: `"${a.text}" matches more than one place, so I did not guess. Matches: ${candidates}. Use a longer unique phrase or click_ui_element.`,
          status: "failed",
          verification: "unverified",
          error: { category: "ambiguous_target", message: "multiple OCR targets matched equally well", retryable: true },
        };
      }
      await act.click(hit.cx, hit.cy, "left");
      return { text: `Clicked "${hit.text}" at ${hit.cx},${hit.cy}.` };
    },
  },
  {
    name: "extract_table",
    description:
      "Pull structured data out of an app with no export button — legacy tools, dashboards, portals. Reads rows from the accessibility tree where available, falls back to positioned screen text, and scrolls until no new rows appear. Returns CSV.",
    schema: {
      scroll: z.boolean().default(true).describe("Scroll to collect rows beyond the first screen"),
      maxScreens: z.number().int().min(1).max(40).default(20),
    },
    readOnly: true,
    handler: async (a) => {
      const table = a.scroll === false ? await extract.readVisible() : await extract.readAll(a.maxScreens ?? 20);
      if (!table.rows.length) return { text: `I couldn't find tabular data on screen (${table.note}).` };
      return { text: `${table.note}\n\n${extract.toCsv(table.rows).slice(0, 4000)}` };
    },
  },
  {
    name: "dismiss_popups",
    description:
      "Clear banners, dialogs and overlays that are in the way — storage warnings, update prompts, cookie notices, 'try our new feature' popups. Call this whenever a page looks obstructed, before clicking something important, and again if a click seems to hit the wrong thing. Only unambiguous dismissals ('Not now', 'Close', 'No thanks', ×) are clicked; anything that decides something ('OK', 'Allow', 'Continue') is reported back to you instead of guessed at.",
    schema: {
      rounds: z.number().int().min(1).max(5).default(3).describe("Dismissing one can reveal another"),
    },
    readOnly: false,
    handler: async (a) => {
      const r = await dismissPopups(a.rounds ?? 3);
      const skipped = r.skipped.length ? ` Left alone: ${r.skipped.join("; ")}.` : "";
      return { text: r.note + skipped };
    },
  },
  {
    name: 'getActiveBrowserUrl',
    description: 'Fetches the URL of the currently active tab in the user\'s frontmost browser (supports Brave, Chrome, Safari). Use this when the user says "this video" or "this page".',
    schema: {},
    readOnly: true,
    handler: async () => {
      try {
        const { execSync } = nodeRequire('node:child_process');
        const script = `
          tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
          end tell
          if frontApp is "Google Chrome" or frontApp is "Brave Browser" then
            tell application frontApp to get URL of active tab of front window
          else if frontApp is "Safari" then
            tell application "Safari" to get URL of front document
          else
            return ""
          end if
        `;
        const url = execSync(`osascript -e '${script}'`, { encoding: 'utf-8' }).trim();
        if (!url) return { text: "No supported browser is currently active or could not retrieve URL." };
        return { text: `Active browser URL: ${url}` };
      } catch (e: any) {
        return { text: `Failed to get browser URL: ${e.message}` };
      }
    }
  },
];
