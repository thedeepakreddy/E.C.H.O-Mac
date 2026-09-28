#!/usr/bin/env node
/**
 * Open the production control-panel renderer against deterministic Mission data.
 * No Echo runtime, microphone, network service, memory store, or model starts.
 *
 *   npm run panelpreview
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { installPreviewBridge } from "./preview_fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
app.setPath("userData", resolve(tmpdir(), "echo-control-panel-preview"));
installPreviewBridge(ipcMain, { onClose: () => app.quit() });

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    title: "ECHO — Mission Monitor Preview",
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: resolve(root, "dist", "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadFile(resolve(root, "renderer", "control-panel.html"));
  const previewView = process.env.ECHO_PANEL_VIEW || "tasks";
  const previewState = await window.webContents.executeJavaScript(`(() => {
    setView(${JSON.stringify(previewView)});
    return [...document.querySelectorAll("[data-view-panel]")].map((panel) => ({ view: panel.dataset.viewPanel, hidden: panel.hidden }));
  })()`, true);
  console.log(`[panel-preview] view ${JSON.stringify(previewState)}`);
  if (process.env.ECHO_PANEL_SCREENSHOT) {
    if (process.env.ECHO_PANEL_POWER_DIALOG === "1") {
      await window.webContents.executeJavaScript('document.getElementById("power-off").click()', true);
    }
    await window.webContents.executeJavaScript("new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))", true);
    // Some panels settle after first paint (the synaptic field builds on idle).
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Number(process.env.ECHO_PANEL_DELAY_MS) || 400));
    const image = await window.webContents.capturePage();
    await writeFile(process.env.ECHO_PANEL_SCREENSHOT, image.toPNG());
    console.log(`[panel-preview] screenshot ${process.env.ECHO_PANEL_SCREENSHOT}`);
    app.quit();
  }
  if (process.env.ECHO_PANEL_SMOKE === "1") {
    const smoke = await window.webContents.executeJavaScript(`(async () => {
      const checkbox = document.getElementById("settings-start-listening");
      const saveButton = document.getElementById("settings-save");
      document.getElementById("power-off").click();
      const powerDialogOpen = document.getElementById("shutdown-dialog").open;
      document.getElementById("shutdown-cancel").click();
      checkbox.click();
      const dirtyState = document.getElementById("settings-save-state").textContent;
      document.getElementById("settings-form").requestSubmit();
      const deadline = Date.now() + 2000;
      while (saveButton.disabled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const latest = await window.echoControl.snapshot();
      return { powerDialogOpen, dirtyState, savedState: document.getElementById("settings-save-state").textContent,
        persisted: latest.settings.hud.startListeningOnLaunch === checkbox.checked,
        saveEnabled: !saveButton.disabled };
    })()`, true);
    console.log(`[panel-smoke] ${JSON.stringify(smoke)}`);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
