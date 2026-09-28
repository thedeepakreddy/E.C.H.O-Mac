#!/usr/bin/env node
/**
 * Record the README's demo clips straight from the shipping renderer.
 *
 *   npm run media                    every clip
 *   npm run media -- hud osiris      just those
 *
 * The point is that nothing here is a mock-up. Each clip loads the REAL
 * renderer files — index.html and hud.css, control-panel.html, humanoid-core.js,
 * osiris.html — so a README video can never show a UI the app does not ship.
 * The control panel is driven by the same deterministic fixture the preview
 * harness uses (scripts/preview_fixtures.mjs), so no runtime, microphone,
 * memory store or model starts.
 *
 * How the recording works: Chromium hands us every painted frame through
 * beginFrameSubscription, we keep the most recent one, and a fixed-rate timer
 * pushes it into ffmpeg as raw BGRA. Sampling on a timer rather than encoding
 * each paint is what keeps playback real-time — a still moment is still a
 * frame of video, and dropping it would speed the clip up.
 *
 * That timer cannot always keep its cadence: a raw 30fps feed is hundreds of
 * megabytes a second, and when the encoder falls behind, the samples thin out
 * and the clip plays fast. So the recorder times itself against the wall clock
 * and, if the two disagree, re-times the finished file. A clip is worthless if
 * it misrepresents how fast the UI actually moves.
 *
 * Output: docs/media/*.mp4, which the README embeds.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installPreviewBridge } from "./preview_fixtures.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RENDERER = join(ROOT, "renderer");
const OUT = join(ROOT, "docs", "media");
const WORK = join(tmpdir(), "echo-media-capture");
const FPS = 30;

app.setPath("userData", join(WORK, "userData"));
app.commandLine.appendSwitch("disable-background-timer-throttling");
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const BLANK = join(WORK, "blank.html");
writeFileSync(BLANK, '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#04070c}</style>', "utf8");

const run = (bin, args) => new Promise((done, fail) => {
  const child = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", fail);
  child.on("close", (code) => (code === 0 ? done() : fail(new Error(`${bin} exited ${code}`))));
});

/* ── the recorder ──────────────────────────────────────────────────────────
   One ffmpeg per clip, fed raw frames.

   The frames are shrunk to the clip's output width HERE rather than in ffmpeg,
   and only the ones actually sampled are shrunk. A Retina window paints at 2x:
   a full-size panel frame is 16MB, which at 30fps is half a gigabyte a second
   down a pipe, and the encoder falls far enough behind that frames are lost
   outright. Resized first, the same feed is a twentieth of that. */
function startRecording(contents, { width }) {
  // Named for this process: two recorders running at once must not encode into
  // the same file, or each one splices the other's frames into its clip.
  const raw = join(WORK, `take-${process.pid}.mp4`);
  let ffmpeg = null;
  let latest = null;
  let frames = 0;
  let firstAt = 0;
  let lastAt = 0;
  let frameBytes = 0;

  contents.beginFrameSubscription(false, (image) => { latest = image; });

  const timer = setInterval(() => {
    if (!latest) return;
    const bitmap = latest.resize({ width, quality: "better" }).getBitmap();
    if (!ffmpeg) {
      frameBytes = bitmap.length;
      const height = bitmap.length / 4 / width;
      ffmpeg = spawn("ffmpeg", [
        "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgra",
        "-s", `${width}x${height}`, "-r", String(FPS),
        "-i", "-",
        // yuv420p needs even dimensions, and every player needs yuv420p.
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        raw,
      ], { stdio: ["pipe", "inherit", "inherit"] });
      // A closed pipe after we stop is expected; anything else would be noise.
      ffmpeg.stdin.on("error", () => {});
    }
    // A frame of the wrong length would slide every pixel after it; the raw
    // stream has no framing of its own to resynchronise on.
    if (bitmap.length !== frameBytes) return;
    ffmpeg.stdin.write(bitmap);
    lastAt = Date.now();
    if (!frames++) firstAt = lastAt;
  }, 1000 / FPS);

  /* `file` is decided at the end, not the start: a take that turns out to be no
     good must not have already overwritten the last good one. */
  return async function stop(file) {
    clearInterval(timer);
    try { contents.endFrameSubscription(); } catch { /* window already gone */ }
    if (!frames) throw new Error("no frames were painted");
    await new Promise((done) => { ffmpeg.on("close", done); ffmpeg.stdin.end(); });

    // What the clock says happened, against what the file claims happened. The
    // last sample only stands for one frame's worth of time, hence the +1/FPS.
    const real = (lastAt - firstAt) / 1000 + 1 / FPS;
    const claimed = frames / FPS;
    const drift = real / claimed;
    if (Math.abs(drift - 1) < 0.03) {
      await run("ffmpeg", ["-loglevel", "error", "-y", "-i", raw, "-c", "copy", "-movflags", "+faststart", file]);
    } else {
      // Stretch the timestamps back onto the wall clock and resample to a
      // steady rate, so the clip runs at the speed the UI really ran at.
      await run("ffmpeg", ["-loglevel", "error", "-y", "-i", raw,
        "-filter:v", `setpts=${drift.toFixed(6)}*PTS,fps=${FPS}`,
        "-c:v", "libx264", "-preset", "medium", "-crf", "24",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
    }
    rmSync(raw, { force: true });
    return { frames, seconds: real, drift };
  };
}

/* A still for the README to show before the video loads — and the only thing
   anyone sees where videos do not play at all. */
async function writePoster(file, at) {
  const poster = file.replace(/\.mp4$/, ".jpg");
  await run("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(at), "-i", file,
    "-frames:v", "1", "-q:v", "3", poster]);
  return poster;
}

/* ── the HUD page ──────────────────────────────────────────────────────────
   Built from the real markup and stylesheet rather than a copy of them, the
   way scripts/preview_hud.mjs does, so this clip cannot drift from the app.
   hud.js is left out on purpose: it talks to the main process over a bridge
   that only exists inside Echo, and the states it would set are exactly the
   states this script steps through itself. */
function buildHudPage(size) {
  const html = readFileSync(join(RENDERER, "index.html"), "utf8");
  const css = readFileSync(join(RENDERER, "hud.css"), "utf8");
  const start = html.indexOf('<div id="orb"');
  const end = html.indexOf('<script src="hud.js"');
  if (start < 0 || end < 0) {
    throw new Error("Could not find the reactor markup in renderer/index.html — update the anchors here.");
  }
  const markup = html.slice(start, end).trim();
  // The jarvis skin is the default, and hud.js is what normally wires its
  // layers up; do the same three assignments here.
  const page = `<!doctype html><meta charset="utf-8"><style>${css}
body{background:#05070a;margin:0;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
#orb,#orb50{--size:${size}px !important}
</style><body data-status="idle" data-skin="jarvis">${markup}
<script>
  const art = { full: "../assets/reactor-jarvis.png",
    layers: { core: "../assets/reactor-jarvis-core.png", mid: "../assets/reactor-jarvis-mid.png", outer: "../assets/reactor-jarvis-outer.png" } };
  document.getElementById("orb").hidden = true;
  const orb50 = document.getElementById("orb50");
  orb50.hidden = false;
  for (const img of orb50.querySelectorAll(".m50-art, .m50-bloom, .m50-bloom-wide, .m50-flash")) img.src = art.full;
  for (const [ring, src] of Object.entries(art.layers)) orb50.querySelector(".m50-l-" + ring).src = src;
  orb50.querySelector(".m50-l-sweep").src = art.layers.outer;
<\/script>`;
  // Written beside the renderer, not in a temp dir: the artwork is referenced
  // as ../assets/…, so the page has to sit where the real one sits.
  const file = join(RENDERER, ".capture-hud.html");
  writeFileSync(file, page, "utf8");
  return file;
}

/* A voice level for the reactor and the humanoid to breathe with. Both read
   --level off the document root, which is where the bridge publishes it. */
const BREATHE = `(() => {
  if (window.__breathe) return;
  window.__breathe = setInterval(() => {
    const t = performance.now() / 1000;
    const v = Math.max(0, 0.42 + 0.34 * Math.sin(t * 5.2) + 0.2 * Math.sin(t * 13.7));
    document.documentElement.style.setProperty("--level", v.toFixed(3));
  }, 40);
})()`;
const CALM = `(() => { clearInterval(window.__breathe); window.__breathe = 0;
  document.documentElement.style.setProperty("--level", "0"); })()`;

/* ── the clips ─────────────────────────────────────────────────────────────
   Each one says how to open a window on a real renderer page, and then walks
   it through the states a person would actually see. */
const CLIPS = {
  /* The reactor through every state it has, at the size it floats on screen. */
  hud: {
    file: "hud.mp4",
    width: 520,
    settleMs: 900,
    posterAt: 4.0,        // listening: the reactor lit and spinning
    window: { width: 460, height: 460, backgroundColor: "#05070a" },
    async open(win) {
      const file = buildHudPage(300);
      await win.loadFile(file);
      rmSync(file, { force: true });                     // never leave it in the tree
    },
    async run(js) {
      const hold = async (status, ms, voice) => {
        await js(`document.body.dataset.status = ${JSON.stringify(status)}`);
        await js(voice ? BREATHE : CALM);
        await wait(ms);
      };
      await hold("idle", 2400);
      await hold("listening", 3000, true);
      await hold("thinking", 2600);
      await hold("acting", 2600);
      await hold("speaking", 3000, true);
      await hold("idle", 1800);
    },
  },

  /* The panel the long-press opens, across its four views. */
  "control-panel": {
    file: "control-panel.mp4",
    width: 1000,
    posterAt: 3.6,        // the overview, once the core has assembled
    window: { width: 1240, height: 800, backgroundColor: "#05070a", preload: true },
    async open(win) { await win.loadFile(join(RENDERER, "control-panel.html")); },
    async run(js) {
      await js(BREATHE);
      await js(`document.body.dataset.status = "acting"`);
      await wait(4200);                                   // overview: the core assembles
      await js(`setView("tasks")`); await wait(3600);      // missions and the agent board
      await js(`setView("models")`); await wait(3000);     // brains and routing
      await js(`document.body.dataset.status = "speaking"`);
      await js(`setView("settings")`); await wait(3400);   // voice, memory, keys
      await js(`setView("overview")`); await wait(2600);
    },
  },

  /* The core's open effect on its own: 2.1 seconds of particles finding the
     figure, then the gaze and the mouth. Recording starts BEFORE the page
     loads, because the assembly begins the moment the script does. */
  "humanoid-open": {
    file: "humanoid-open.mp4",
    width: 720,
    posterAt: 8.0,        // assembled, mid-sentence
    window: { width: 820, height: 820, backgroundColor: "#04070c" },
    recordBeforeLoad: true,
    async open(win) {
      // A bare host for the real humanoid-core.js: the panel's own canvas id,
      // and nothing else on screen to look at.
      const page = `<!doctype html><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;background:#04070c;overflow:hidden}
        #core-canvas{display:block;width:100vw;height:100vh}
      </style><body data-status="idle"><canvas id="core-canvas"></canvas>
      <script src="humanoid-core.js"><\/script>`;
      const file = join(RENDERER, ".capture-humanoid.html");   // beside its script, for the src
      writeFileSync(file, page, "utf8");
      await wait(900);                                          // a beat of black before it opens
      await win.loadFile(file);
      rmSync(file, { force: true });                            // never leave it in the tree
    },
    async run(js) {
      await wait(4200);                                  // the assembly, then settling
      await js(`document.body.dataset.status = "listening"`);
      await js(BREATHE);
      await wait(2600);
      await js(`document.body.dataset.status = "speaking"`);
      await js(CALM);                                    // speech drives its own envelope
      await wait(4000);
      await js(`document.body.dataset.status = "idle"`);
      await wait(1600);
    },
  },

  /* The Osiris panel: Echo's chrome and loader over the live grid. */
  osiris: {
    file: "osiris.mp4",
    width: 1000,
    posterAt: 18.0,       // the grid, once it is actually the grid
    window: { width: 1180, height: 780, backgroundColor: "#04070c", webview: true },
    recordBeforeLoad: true,
    async open(win) {
      const src = process.env.ECHO_OSIRIS_URL || "https://osirisai.live/";
      await wait(600);
      await win.loadFile(join(RENDERER, "osiris.html"), { query: { src, base: src } });
    },
    async run(js) {
      // Let the grid actually arrive: the loader is part of the clip, but a
      // clip that is only the loader would be a clip of nothing.
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const shown = await js(`document.getElementById("feed").classList.contains("show")`);
        if (shown) break;
        await wait(500);
      }
      await wait(20_000);   // the grid's own splash, then the globe itself
    },
    /* The grid is a live service, and a live service can be down. Echo's own
       panel answers a refusal with its own curtain (src/osiris.ts) — this
       harness does not carry that logic, so a bad take here would put someone
       else's error page inside Echo's chrome and call it a demo. Refuse it. */
    async verify(js) {
      const state = await js(`(() => {
        const feed = document.getElementById("feed");
        return { title: feed.getTitle?.() ?? "", url: feed.getURL?.() ?? "",
                 shown: feed.classList.contains("show") };
      })()`);
      if (!state.shown) throw new Error("the grid never loaded");
      if (/\b[45]\d\d\b|bad gateway|error code|not found|unavailable/i.test(state.title)) {
        throw new Error(`the grid answered with an error page (${state.title})`);
      }
    },
  },
};

/* ── the reel ──────────────────────────────────────────────────────────────
   One clip for the top of the README, cut from the four above. It is an edit,
   not a recording: every frame in it was still painted by the real renderer.

   The sources are different shapes — a square reactor, a wide panel — so each
   segment is fitted into one frame and padded rather than stretched. */
const REEL = {
  file: "echo.mp4",
  width: 1000,
  height: 660,
  segments: [
    { from: "humanoid-open.mp4", start: 0.4, seconds: 6.0 },
    { from: "hud.mp4", start: 1.6, seconds: 5.4 },
    { from: "control-panel.mp4", start: 1.0, seconds: 7.0 },
    { from: "osiris.mp4", start: 13.0, seconds: 6.5 },
  ],
};

async function buildReel() {
  const missing = REEL.segments.filter((s) => !existsSync(join(OUT, s.from)));
  if (missing.length) {
    throw new Error(`record ${missing.map((s) => s.from).join(", ")} first — the reel is cut from them`);
  }
  const { width, height } = REEL;
  const inputs = REEL.segments.flatMap((s) => ["-ss", String(s.start), "-t", String(s.seconds), "-i", join(OUT, s.from)]);
  const fit = REEL.segments
    .map((_, i) => `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
                   `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#04070c,setsar=1,fps=${FPS}[v${i}]`)
    .join(";");
  const chain = REEL.segments.map((_, i) => `[v${i}]`).join("");
  await run("ffmpeg", ["-loglevel", "error", "-y", ...inputs,
    "-filter_complex", `${fit};${chain}concat=n=${REEL.segments.length}:v=1:a=0[out]`,
    "-map", "[out]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "23",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    join(OUT, REEL.file)]);
  await writePoster(join(OUT, REEL.file), 4.4);
  const seconds = REEL.segments.reduce((total, s) => total + s.seconds, 0);
  console.log(`[media] ${REEL.file} — ${REEL.segments.length} segments, ${seconds.toFixed(1)}s`);
}

/* ── driver ────────────────────────────────────────────────────────────── */
async function capture(name) {
  const clip = CLIPS[name];
  const out = join(OUT, clip.file);
  const win = new BrowserWindow({
    ...clip.window,
    show: true,
    // Off to the side of the desktop: the window must stay composited to keep
    // painting, but it does not have to sit on top of what you are doing.
    x: 40, y: 40,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      preload: clip.window.preload ? resolve(ROOT, "dist", "preload.cjs") : undefined,
      webviewTag: Boolean(clip.window.webview),
      sandbox: !clip.window.webview,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const js = (code) => win.webContents.executeJavaScript(code, true);
  let stop = null;
  if (clip.recordBeforeLoad) {
    // Nothing is painted until something is loaded, and an unpainted window
    // hands the frame subscription nothing at all. So give it a dark page to
    // hold — which is also the beat of black the clip opens on.
    await win.loadFile(BLANK);
    stop = startRecording(win.webContents, clip);
  }
  await clip.open(win);
  // loadFile resolves before the artwork does; a clip should not open on the
  // frame where the images are still missing.
  if (!stop) { await wait(clip.settleMs ?? 600); stop = startRecording(win.webContents, clip); }
  // Two frames, so the first thing recorded is a painted page and not a flash.
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await clip.run(js);
  // Check the take BEFORE closing the encoder: once the window is gone there
  // is nothing left to ask.
  const complaint = await clip.verify?.(js).then(() => null, (error) => error);
  // A rejected take is still encoded — the recorder has to be closed either way
  // — but it goes to the scratch directory, never over the clip in docs/media.
  const take = await stop(complaint ? join(WORK, `rejected-${process.pid}.mp4`) : out);
  win.destroy();
  if (complaint) throw complaint;
  await writePoster(out, clip.posterAt ?? take.seconds * 0.5);
  const retimed = Math.abs(take.drift - 1) < 0.03 ? "" : ` (re-timed ×${take.drift.toFixed(2)})`;
  console.log(`[media] ${clip.file} — ${take.frames} frames, ${take.seconds.toFixed(1)}s${retimed}`);
}

/* A clip that records something wrong is worse than one that is missing, so a
   failed take is retried rather than shipped. */
async function captureWithRetries(name, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      await capture(name);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.warn(`[media] ${name} attempt ${attempt} failed: ${error.message} — retrying`);
      await wait(4000);
    }
  }
}

installPreviewBridge(ipcMain, { onClose: () => {} });

app.whenReady().then(async () => {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const names = asked.length ? asked : [...Object.keys(CLIPS), "echo"];
  const unknown = names.filter((n) => !CLIPS[n] && n !== "echo");
  if (unknown.length) {
    console.error(`Unknown clip(s): ${unknown.join(", ")}. Have: ${Object.keys(CLIPS).join(", ")}, echo`);
    app.exit(1);
    return;
  }
  try {
    for (const name of names) {
      if (name === "echo") await buildReel();
      else await captureWithRetries(name);
    }
    console.log(`[media] wrote ${names.length} clip(s) to docs/media/`);
    app.exit(0);
  } catch (error) {
    console.error(`[media] ${error?.stack || error}`);
    app.exit(1);
  }
});

app.on("window-all-closed", () => {});
