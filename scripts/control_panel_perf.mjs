/** Native renderer regression, with fixtures: no microphone or model starts. */
import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { installPreviewBridge } from "./preview_fixtures.mjs";
import { ipcMain } from "electron";

const root = resolve(import.meta.dirname, "..");
app.setPath("userData", resolve(tmpdir(), "echo-panel-performance-test"));
installPreviewBridge(ipcMain);
let failed = false;
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1180, height: 760, transparent: true,
    backgroundColor: "#00000000", webPreferences: {
      preload: resolve(root, "dist/preload.cjs"), sandbox: true, contextIsolation: true,
    } });
  try {
    await window.loadFile(resolve(root, "renderer/control-panel.html"));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      setView("overview");
      render({ ...await window.echoControl.snapshot(), state: { status: "idle" } });
      await wait(3000);
      await neuralCard?.ready;
      const filters = [...document.querySelectorAll("*")].filter(el =>
        el.getBoundingClientRect().width && getComputedStyle(el).backdropFilter !== "none").length;
      neuralCard.stop();
      await wait(100);
      let frames = 0;
      const draw = neuralCard._frame.bind(neuralCard);
      neuralCard._frame = dt => { frames++; draw(dt); };
      for (let i = 0; i < 12; i++) { neuralCard.start(); neuralCard.stop(); }
      neuralCard.start();
      await wait(600);
      neuralCard.stop();
      const restartFrames = frames;
      let bursts = 0;
      const burst = neuralCard.burst.bind(neuralCard);
      neuralCard.burst = n => { bursts++; burst(n); };
      neuralCard.setState("idle");
      for (let i = 0; i < 20; i++) neuralCard.setState("acting");
      const data = await window.echoControl.snapshot();
      const begin = performance.now();
      for (let i = 0; i < 100; i++) render({ ...data, logRevision: i });
      const renderMs = performance.now() - begin;
      const beginSwitch = performance.now();
      for (const view of ["settings", "tasks", "models", "overview"]) setView(view);
      const switchMs = performance.now() - beginSwitch;
      const paintBegin = performance.now();
      setView("settings");
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const switchPaintMs = performance.now() - paintBegin;
      setView("tasks");
      const stoppedWhenHidden = !neuralCard.running;
      return { filters, restartFrames, bursts, stoppedWhenHidden, renderMs, switchMs, switchPaintMs };
    })()`);
    console.log("[panel-performance] " + JSON.stringify(result));
    if (result.restartFrames > 20) throw new Error(`animation restarts multiplied render loops: ${result.restartFrames} frames in 600ms`);
    if (result.restartFrames < 1) throw new Error("animation did not render");
    if (result.bursts !== 1) throw new Error("unchanged state updates repeatedly burst the animation");
    if (result.filters !== 0) throw new Error("live backdrop filters still sample animated layers");
    if (!result.stoppedWhenHidden) throw new Error("hidden neural card is still running");
    if (result.switchPaintMs > 250) throw new Error("navigation paint exceeded 250ms after animation restarts");
    console.log("PASS animation restart keeps one loop and navigation remains responsive");
  } catch (error) {
    failed = true;
    console.error(error.message);
  } finally {
    window.destroy();
    app.exit(failed ? 1 : 0);
  }
});
