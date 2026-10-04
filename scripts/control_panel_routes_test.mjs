/** Real Electron layout/update regression; fixtures never start models or audio. */
import { app, BrowserWindow, ipcMain } from "electron";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { installPreviewBridge } from "./preview_fixtures.mjs";
const root = resolve(import.meta.dirname, "..");
app.setPath("userData", resolve(tmpdir(), "echo-panel-routes-test"));
installPreviewBridge(ipcMain);
app.whenReady().then(async () => {
const panel = new BrowserWindow({ width: 900, height: 600, webPreferences: {
  preload: resolve(root, "dist/preload.cjs"), sandbox: true, contextIsolation: true,
} });
let failed = false;
try {
  await panel.loadFile(resolve(root, "renderer/control-panel.html"));
  const result = await panel.webContents.executeJavaScript(`(async () => {
    const data = await bridge.snapshot();
    data.logs = Array.from({length: 240}, (_, i) => ({at: Date.now(), kind: 'tool', text: 'Activity ' + i}));
    data.logRevision = 9876;
    data.models.push({id: 'claude', label: 'Claude', model: 'fixture', available: true, active: false},
      {id: 'ollama', label: 'Local', model: 'fixture', available: true, active: false});
    data.connections = Array.from({length: 80}, (_, i) => ({name: 'Connection ' + i, status: 'active', tools: 12}));
    render(data); setView('models');
    const pane = document.querySelector('.route-workspace');
    pane.scrollTop = 120;
    const canScroll = pane.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(pane).overflowY);
    const layoutFits = [...document.querySelectorAll('#models-view > *')].every(el => {
      const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1;
    });
    const picker = document.querySelector('[data-openrouter-model]');
    picker.focus();
    const next = structuredClone(data);
    next.models[0].model += '-updated';
    render(next);
    const preservesPicker = picker === document.querySelector('[data-openrouter-model]') && document.activeElement === picker;
    setView('tasks');
    const card = document.querySelector('.model-card');
    next.models[0].model += '-hidden'; render(next);
    const defersHiddenModels = card === document.querySelector('.model-card');
    setView('models');
    const catchesUp = document.querySelector('.model-card').textContent.includes('-hidden');
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      next.connections[0].lastActivityAt = Date.now() + i;
      render(next);
    }
    const updatesMs = performance.now() - start;
    document.activeElement?.blur();
    pane.scrollTop = 0;
    const r = pane.getBoundingClientRect();
    return { canScroll, layoutFits, preservesPicker, defersHiddenModels, catchesUp, updatesMs,
      viewport: [innerWidth, innerHeight], wheelX: Math.round(r.left + r.width / 2), wheelY: Math.round(r.top + 25) };
  })()`);
  panel.focus();
  panel.webContents.sendInputEvent({ type: "mouseMove", x: result.wheelX, y: result.wheelY });
  await new Promise(r => setTimeout(r, 100));
  panel.webContents.sendInputEvent({ type: "mouseWheel", x: result.wheelX, y: result.wheelY, deltaY: -220, deltaX: 0, canScroll: true });
  await new Promise(r => setTimeout(r, 150));
  result.wheelScrolls = await panel.webContents.executeJavaScript("document.querySelector('.route-workspace').scrollTop > 0");
  const sizes = [];
  for (const [width, height] of [[1180, 760], [780, 560], [680, 500]]) {
    panel.setSize(width, height);
    await new Promise(r => setTimeout(r, 60));
    sizes.push(await panel.webContents.executeJavaScript(`(() => {
      const fits = view => [...document.querySelectorAll('#' + view + '-view > *')].every(el => {
        if (getComputedStyle(el).display === 'none') return true;
        const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1;
      });
      setView('models');
      const routingFits = fits('models');
      const log = byId('routing-log');
      log.scrollTop = 120;
      const activityScrolls = getComputedStyle(document.querySelector('.model-activity')).display === 'none' || log.scrollTop > 0;
      const route = document.querySelector('.route-workspace');
      route.scrollTop = route.scrollHeight;
      const last = document.querySelector('#connection-list .connection-card:last-child').getBoundingClientRect();
      const bottomReachable = last.bottom <= route.getBoundingClientRect().bottom + 1;
      setView('settings');
      const settingsFits = fits('settings');
      const form = byId('settings-form'); form.scrollTop = 120;
      const settingsScrolls = form.scrollTop > 0;
      setView('tasks');
      const tasksFit = fits('tasks');
      return {width: innerWidth, height: innerHeight, routingFits, bottomReachable, activityScrolls, settingsFits, settingsScrolls, tasksFit};
    })()`));
  }
  result.sizes = sizes;
  let switches = 0;
  ipcMain.removeHandler("control:action");
  ipcMain.handle("control:action", async () => {
    switches++;
    await new Promise(r => setTimeout(r, 100));
    return {ok: false, message: "Fixture switch failure"};
  });
  const pending = await panel.webContents.executeJavaScript(`(async () => {
    setView('models');
    const buttons = [...byId('model-list').querySelectorAll('[data-provider]')].filter(b => !b.disabled);
    buttons[0].click();
    for (let i = 0; i < 20; i++) buttons.forEach(b => b.click());
    const blockedWhilePending = [...byId('model-list').querySelectorAll('[data-provider]')].every(b => b.disabled);
    const deadline = Date.now() + 2000;
    while (modelSwitchPending && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    const restoredAfterFailure = !modelSwitchPending && [...byId('model-list').querySelectorAll('[data-provider]')].some(b => !b.disabled);
    return {blockedWhilePending, restoredAfterFailure};
  })()`);
  result.switches = switches;
  result.pending = pending;
  console.log("[panel-routes] " + JSON.stringify(result));
  for (const key of ["canScroll", "layoutFits", "preservesPicker", "defersHiddenModels", "catchesUp", "wheelScrolls"]) {
    if (!result[key]) { console.error("FAIL " + key); failed = true; }
  }
  for (const size of sizes) for (const key of ["routingFits", "bottomReachable", "activityScrolls", "settingsFits", "settingsScrolls", "tasksFit"]) {
    if (!size[key]) { console.error(`FAIL ${key} at ${size.width}x${size.height}`); failed = true; }
  }
  if (switches !== 1 || !pending.blockedWhilePending || !pending.restoredAfterFailure) {
    console.error("FAIL repeated model switch clicks or recovery"); failed = true;
  }
  if (result.updatesMs > 250) { console.error("FAIL routing update stress exceeded 250ms"); failed = true; }
} catch (error) { failed = true; console.error(error); }
finally { panel.destroy(); app.exit(failed ? 1 : 0); }

});
