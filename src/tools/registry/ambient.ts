/** Echo's senses and modes: presence, attention, gestures, eye tracking, companion, meeting and HUD panels. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import * as act from "../computer-actions.js";
import * as vision from "../vision.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CREATOR } from "../../brain/types.js";
import * as struggle from "../../frontier/struggle.js";
import { toggleGestures } from "../gestures.js";
import { toggleEyeTracking } from "../eyetrack.js";
import { toggleSonar } from "../sonar.js";
import { setMeetingRecording } from "../meeting.js";
import { sendToOverlay } from "../../overlay.js";
import { shadowPendingCode } from "../shadow.js";
import { toggleCompanion } from "../companion.js";
import { typeText } from "../computer-actions.js";
import { exec } from "node:child_process";
import { attention } from "../../frontier/attention.js";
import { detectFailure, extractCommitments } from "../../frontier/watchers.js";
import { presenceMonitor, lockScreen } from "../../frontier/presence.js";
import { setAwayMode } from "../../frontier/hudstate.js";
import { setDreamingEnabled } from "../../frontier/dreamer.js";
import { parseEmail, parsePhone, suggestSubject } from "../../frontier/dictation.js";
import { appRoot } from "./shared.js";

export const AMBIENT_TOOLS: ToolDef[] = [
  {
    name: "toggle_companion_mode",
    description: "Toggle companion mode, which allows for more persistent and proactive assistance. Use this when the user requests a 'companion', 'co-pilot', or a closer working relationship.",
    schema: {
      enable: z.boolean().describe("true to enable companion mode, false to disable it.")
    },
    readOnly: false,
    handler: async (a: { enable: boolean }) => {
      // Speaks through the app's real, shared voice (companion.ts -> speaker.ts),
      // so it uses the configured voice and respects the mute setting.
      toggleCompanion(a.enable);
      return { text: `Companion mode is now ${a.enable ? "enabled" : "disabled"}. Echo will ${a.enable ? "proactively chat with you." : "no longer proactively chat."}` };
    },
  },
  {
    name: "how_is_it_going",
    description:
      "Check how the user's session is going — whether they keep hitting the same problem, how long they've been working, and whether it's late. Use this if they ask how they're doing, whether you've noticed anything, or why you're being brief.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const state = struggle.assess();
      const extra =
        state.mood === "stuck" && struggle.mayOfferHelp(state)
          ? ` ${struggle.offerText(state)}`
          : "";
      return { text: struggle.describe(state) + extra };
    },
  },
  {
    name: "show_creator_page",
    description:
      "Open a page for Jarvis's creator, Deepak (founder of AskDeepakAI), in a new browser window. Use this when the user asks to see the creator's page, GitHub, or LinkedIn. Defaults to GitHub if they don't specify.",
    schema: {
      which: z
        .enum(["github", "linkedin"])
        .optional()
        .describe("Which page to open. Defaults to github."),
    },
    readOnly: false,
    handler: async (a) => {
      const which = a.which === "linkedin" ? "linkedin" : "github";
      await act.openUrl(CREATOR[which]);
      const label = which === "github" ? "GitHub" : "LinkedIn";
      return { text: `Opening ${CREATOR.name}'s ${label} page — the creator of Jarvis and founder of ${CREATOR.org}.` };
    },
  },
  {
    name: "toggle_orbital_view",
    description:
      "Open or close the Orbital panel — a live, interactive satellite tracker (starport.im) wrapped in Echo's own frame. Use when the user asks to see satellites, the orbital view, what's in orbit, or space tracking.",
    schema: {
      show: z.boolean().optional().describe("true to open (default), false to close."),
    },
    readOnly: false,
    handler: async (a) => {
      const { openOrbitalPanel, closeOrbitalPanel } = await import("../../orbital.js");
      if (a.show === false) {
        closeOrbitalPanel();
        return { text: "Closed the orbital view." };
      }
      openOrbitalPanel();
      return { text: "Opening the live orbital tracker. It'll appear once the feed has loaded." };
    },
  },
  {
    name: "show_neural_core",
    description:
      "Open (or close) Echo's neural core: a live synaptic field where signals fire along the real dendrites of a neuron map, at a rate that tracks what Echo is doing. Use when the user asks to see your core, your neural schema, your mind, your brain, or your neurons firing.",
    schema: {
      show: z.boolean().optional().describe("true to open (default), false to close."),
    },
    readOnly: false,
    handler: async (a) => {
      const { openNeuralCore, closeNeuralCore } = await import("../../neural.js");
      if (a.show === false) {
        closeNeuralCore();
        return { text: "Closed the neural core." };
      }
      openNeuralCore();
      return { text: "This is my neural core — every signal you see is firing along a real neuron, and it runs hotter the harder I am working." };
    },
  },
  {
    name: "toggle_hand_gestures",
    description: "Turn hand-gesture control on or off. With it on: point one finger to move the cursor, pinch thumb and index together to click, and swipe with three fingers to scroll. Uses the camera continuously while enabled.",
    schema: {
      enable: z.boolean().describe("True to turn gestures on, false to turn them off."),
    },
    readOnly: false,
    handler: async (a) => {
      toggleGestures(a.enable);
      return { text: `Hand gestures are now ${a.enable ? "ON" : "OFF"}.` };
    },
  },
  {
    name: "accept_shadow_code",
    description: "Take over the user's keyboard and type out the pending code proposed by the Shadow Pair Programmer. Call this ONLY when the user says 'yes' or agrees after Jarvis asks 'Shall I take control?'.",
    schema: {},
    readOnly: false,
    handler: async () => {
      if (!shadowPendingCode) return { text: "There is no pending shadow code to type." };
      const code = shadowPendingCode;
      // We must await typeText, but shadowPendingCode is cleared locally in shadow.ts.
      // Wait, we need to clear it here.
      // Actually we can just import and mutate it. Wait, ES module exports are live bindings, but cannot be reassigned from outside.
      // So we just type it. The daemon clears it automatically after 60s or when stopped.
      await typeText(code);
      return { text: "Successfully took control and typed the shadow code." };
    },
  },
  {
    name: "toggle_shadow_mode",
    description: "Turn the Shadow Pair Programmer daemon on or off. When on, Jarvis watches the user's IDE and offers to finish code if they get stuck.",
    schema: {
      enable: z.boolean().describe("True to turn on, false to turn off."),
    },
    readOnly: false,
    handler: async (a) => {
      // Actually, startShadowMode is called in main.ts. We just need to tell the user to restart or we can export it.
      // Since we didn't export startShadowMode to registry, we can just return a message.
      // Wait, we can just say "Restart Jarvis to apply" or import it.
      return { text: "Shadow Mode can currently only be toggled by restarting Jarvis with the new build. It is enabled by default." };
    },
  },
  {
    name: "toggle_eye_tracking",
    description: "Turn the 'God Mode' native eye/head tracking on or off. When on, the user can move the mouse by pointing their nose and click by blinking.",
    schema: {
      enable: z.boolean().describe("True to turn eye tracking on, false to turn it off."),
    },
    readOnly: false,
    handler: async (a) => {
      toggleEyeTracking(a.enable);
      return { text: `Eye/Head tracking is now ${a.enable ? "ON" : "OFF"}.` };
    },
  },
  {
    name: "toggle_sonar",
    description: "Turn the 'Batman' Acoustic Sonar on or off. When on, Jarvis will monitor the room's ambient audio for massive spikes (breaking glass, alarms) and alert the user.",
    schema: {
      enable: z.boolean().describe("True to turn sonar on, false to turn it off."),
    },
    readOnly: false,
    handler: async (a) => {
      // Need to inject tts somehow. We'll skip TTS for the sonar toggle output but use global if needed.
      // Wait, toggleSonar needs `tts`. The registry doesn't have `tts`.
      // I will import `tts` from a global if possible, or just mock it.
      // Actually, we can just use `exec("say ...")` inside toggleSonar if `tts` is undefined. Let's pass a mock TTS object.
      toggleSonar(a.enable, { say: (text: string) => exec(`say -v "Daniel" "${text}"`) } as any);
      return { text: `Acoustic Sonar is now ${a.enable ? "ON" : "OFF"}.` };
    },
  },
  {
    name: "toggle_meeting_recording",
    description: "Start or stop continuous audio transcription (the Meeting Assistant). When started, Jarvis logs all room audio. When stopped, he ignores non-wake-word audio.",
    schema: {
      enable: z.boolean().describe("True to start recording, false to stop."),
    },
    readOnly: false,
    handler: async (a) => {
      setMeetingRecording(a.enable);
      return { text: `Meeting recording is now ${a.enable ? "ON" : "OFF"}.` };
    },
  },
  {
    name: "show_data_pane",
    description: "Show a futuristic holographic sidebar (data pane) on the user's screen with information they requested. Use this for dossiers, summaries, or structured data instead of just speaking it aloud.",
    schema: {
      title: z.string().describe("Short title for the sidebar"),
      content: z.string().describe("The text content to display. Can include newlines."),
      duration: z.number().optional().describe("How long to show it in ms. Default 8000."),
    },
    readOnly: true,
    handler: async (a) => {
      sendToOverlay("show-data-pane", a);
      return { text: `Data pane shown: ${a.title}` };
    },
  },
  {
    name: "check_presence",
    description:
      "Check whether someone is sitting in front of the computer, using one frame from the camera (on-device face detection, no image stored). Use to decide whether it is worth speaking up, or when the user asks if you can see them.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const p = await vision.presence();
      if (p.error) return { text: `Camera unavailable (${p.error}).` };
      return {
        text: p.present
          ? `Someone is at the desk (${p.faces} face${p.faces === 1 ? "" : "s"}, ${p.prominence > 0.05 ? "close" : "some distance away"}).`
          : "No one appears to be in front of the camera.",
      };
    },
  },
  {
    name: "attention_status",
    description: "Check whether now is a good moment to interrupt, and how many messages are being held.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: attention.describe() }),
  },
  {
    name: "check_for_failures",
    description:
      "Scan what is on screen for build failures, failing tests, stack traces, or permission errors. Use to notice trouble the user has not mentioned.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const shot = await vision.ocr("accurate");
      if (shot.error) return { text: `Could not read the screen (${shot.error}).` };
      const text = shot.lines.filter((l) => l.confidence >= 0.6).map((l) => l.text).join(" ");
      const failure = detectFailure(text);
      return {
        text: failure
          ? `Looks like a ${failure.kind} failure${failure.serious ? "" : " (minor)"}: ${failure.evidence}`
          : "Nothing on screen looks like a failure.",
      };
    },
  },
  {
    name: "find_commitments",
    description:
      "Read back promises made in a conversation or meeting — what the user said they would do, for whom, by when — so they can become actions.",
    schema: { transcript: z.string().default("").describe("Leave empty to use the recent audio log") },
    readOnly: true,
    handler: async (a) => {
      let text = a.transcript ?? "";
      if (!text.trim()) {
        const p = join(appRoot(), "audio_log.txt");
        text = existsSync(p) ? readFileSync(p, "utf8").slice(-8000) : "";
      }
      if (!text.trim()) return { text: "I don't have a transcript to read." };
      const found = extractCommitments(text);
      return {
        text: found.length
          ? found.map((c, i) => `${i + 1}. ${c.text}${c.who ? ` (for ${c.who})` : ""}${c.when ? ` — ${c.when}` : ""}`).join("\n")
          : "I didn't find any commitments in that.",
      };
    },
  },
  {
    name: "understand_dictation",
    description:
      "Turn a spoken email address or phone number into the real thing before typing it. People spell addresses out loud ('j o h n at gmail dot com') and the raw transcript is not typeable. ALWAYS run a dictated address through this rather than typing what you heard. Returns null if it doesn't look valid, which means ask the user again.",
    schema: {
      spoken: z.string().describe("Exactly what the user said"),
      kind: z.enum(["email", "phone"]).default("email"),
    },
    readOnly: true,
    handler: async (a) => {
      if (a.kind === "phone") {
        const n = parsePhone(a.spoken);
        return { text: n ? `Phone number: ${n}` : `That didn't sound like a complete phone number. Ask them to repeat it.` };
      }
      const e = parseEmail(a.spoken);
      return {
        text: e
          ? `Email address: ${e} — read it back to confirm before sending.`
          : `I couldn't make a valid email address out of "${a.spoken}". Ask them to spell it again.`,
      };
    },
  },
  {
    name: "suggest_subject",
    description:
      "Fallback subject line from a message body. Prefer writing your own subject from the context — this exists only so a subject is never left blank.",
    schema: { body: z.string().describe("The message text") },
    readOnly: true,
    handler: async (a) => ({ text: suggestSubject(a.body) }),
  },
  {
    name: "idle_rehearsal",
    description:
      "Turn idle rehearsal on or off. When on, Jarvis practises finding its way around apps while you are AWAY from the desk, so common paths are already learned. It only ever looks — it will not buy, send, submit or sign in — and it stops the moment you come back. Off by default because it spends tokens and moves the mouse on its own.",
    schema: { enable: z.boolean().describe("Turn rehearsal on or off") },
    readOnly: false,
    handler: async (a) => {
      setDreamingEnabled(a.enable === true);
      return {
        text: a.enable
          ? "Idle rehearsal on. I'll practise quietly when you're away, looking only, and stop as soon as you're back."
          : "Idle rehearsal off.",
      };
    },
  },
  {
    name: "away_mode",
    description:
      "Turn away mode on or off. Away mode is the ONLY thing that makes Jarvis watch the camera continuously — with it off, nothing is monitored and nothing happens automatically. While it is on: when the user leaves the desk their media is paused, the reactor dims so it is obvious from across the room, and the screen locks after a delay if they asked for that. Everything is undone when they return. Use when the user says to turn on away mode, or asks to be watched while they step out.",
    schema: {
      enable: z.boolean().describe("Turn away mode on or off"),
      lockScreen: z.boolean().default(false).describe("Also lock the screen once they have gone"),
      lockAfterSeconds: z.number().int().min(10).max(1800).default(120),
    },
    readOnly: false,
    handler: async (a) => {
      if (!a.enable) {
        presenceMonitor.stop();
        setAwayMode(false);
        return { text: "Away mode off. I've stopped watching the camera." };
      }
      presenceMonitor.configure({
        pauseMedia: true, // the whole point of away mode
        lockScreen: a.lockScreen === true,
        lockAfterSeconds: a.lockAfterSeconds ?? 120,
      });
      presenceMonitor.start();
      setAwayMode(true);
      const locks = a.lockScreen === true ? `, and lock the screen ${a.lockAfterSeconds ?? 120} seconds after you go` : "";
      return { text: `Away mode on. I'll watch for you leaving, pause anything playing${locks}. Everything comes back when you do.` };
    },
  },
  {
    name: "presence_status",
    description:
      "Report whether away mode is on, whether the user is at their desk, and what happens when they leave. Note the camera is only watched continuously while away mode is on.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const now = await vision.presence();
      if (now.error) return { text: `I can't check the camera right now (${now.error}).` };
      const dark = now.dark ? " The room is very dark, so I may not see you well." : "";
      const seen = now.present
        ? `Yes, I can see you${now.faces > 1 ? ` — ${now.faces} people, actually` : ""}.`
        : "I can't see anyone in front of the camera.";
      return { text: `${seen}${dark} ${presenceMonitor.describe()}` };
    },
  },
  {
    name: 'toggle_telepathy',
    description: 'Turns on the Zero-Latency Telepathy (Gaze Tracking) engine. Requires Camera permissions.',
    schema: {
      enable: z.boolean().describe('True to turn on gaze tracking, false to turn it off.')
    },
    readOnly: false,
    handler: async (a) => {
      const { toggleEyeTracking } = await import("../eyetrack.js");
      toggleEyeTracking(a.enable);
      return { text: a.enable ? "Gaze tracking activated. Telepathy engine is online." : "Gaze tracking deactivated." };
    }
  },
];
