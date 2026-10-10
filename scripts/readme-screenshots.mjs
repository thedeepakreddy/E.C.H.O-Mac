// Shipping renderers, deterministic sample data, and isolated Electron storage.
// This never starts Echo's runtime, microphone, memory store or task workers.
import {app, BrowserWindow, ipcMain} from 'electron';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import {installPreviewBridge} from './preview_fixtures.mjs';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'docs/screenshots');
mkdirSync(out, {recursive: true});
app.setPath('userData', join(tmpdir(), `echo-readme-preview-${process.pid}`));
app.on('window-all-closed', () => {});
const {fleet} = installPreviewBridge(ipcMain);
const report = '## Project plan\n\n**One useful outcome:** prepare a clear launch brief.\n\n1. Collect the approved evidence.\n2. Draft the decisions and next steps.\n3. Review the result before sharing.\n\n> Keep claims connected to their sources.';
const result = {status: 'completed', summary: report, artifacts: [], verificationRefs: [], blockers: []};
ipcMain.handle('control:bots', () => ({bots: fleet.members.map(b => ({...b, revision: 'a'.repeat(24), mode: 'native tools'})), jobs: [{id: 'sample-plan', botId: 'plan', botName: 'Plan', goal: 'Prepare a clear launch plan', status: 'completed', updatedAt: Date.now(), result, steps: [], live: false}]}));
ipcMain.handle('setup:load', () => ({path: '/Users/preview/.jarvis/.env', values: {}, fields: [{env: 'GEMINI_API_KEY', label: 'Gemini', optional: true, help: 'Connect your chosen brain provider.', url: 'https://aistudio.google.com/apikey'}, {env: 'RELAY_SECRET', label: 'Echo Phone', optional: true, help: 'Optional connection to your Phone app.', url: 'https://echo-phone.onrender.com/'}]}));
ipcMain.handle('setup:save', () => ({ok: true, count: 0}));
const captures = [];
const selected = process.env.ECHO_SCREENSHOTS_ONLY?.split(',');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function capture(win, id, title, delay = 650) {
  if (selected && !selected.includes(id)) return;
  win.focus(); win.webContents.focus(); // Canvas animation pauses while unfocused.
  await wait(delay);
  const image = await win.webContents.capturePage();
  writeFileSync(join(out, id + '.png'), image.resize({width: Math.min(1180, win.getContentSize()[0])}).toPNG());
  captures.push({id, title}); console.log('Captured', id);
}
function windowFor(width = 1180, height = 760, preload = 'preload.cjs', webviewTag = false) {
  const win = new BrowserWindow({width, height, show: false, backgroundColor: '#04070a', webPreferences: {preload: join(root, 'dist', preload), contextIsolation: true, sandbox: true, webviewTag}});
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  return win;
}
app.whenReady().then(async () => {
  let win;
  try {
    win = windowFor(); await win.loadFile(join(root, 'renderer/control-panel.html')); win.showInactive();
    for (const [id, title] of [['overview','Live Overview'],['day','Now & Next / Needs You'],['brain','Second Brain'],['tasks','Agents board'],['bots','Bots'],['world','World Intelligence'],['models','Models & Routing'],['settings','Settings']]) {
      await win.webContents.executeJavaScript(`setView(${JSON.stringify(id)})`);
      await capture(win, id, title, id === 'overview' ? 4000 : 650);
      if (id === 'bots') {
        await win.webContents.executeJavaScript(`document.querySelector('#bots-view .companion-scroll').scrollTop=10000`);
        await capture(win, 'bots-results', 'Bot results');
      }
    }
    await win.webContents.executeJavaScript(`setView('tasks');document.getElementById('board-manage').click()`);
    await capture(win, 'agents', 'Agent roster');
    await win.webContents.executeJavaScript(`document.getElementById('fleet-dialog').close();document.querySelector('[data-ops-view="missions"]').click()`);
    await capture(win, 'missions', 'Missions'); win.destroy();
    win = windowFor(1040, 900, 'report-preload.cjs'); await win.loadFile(join(root, 'renderer/task-report.html')); win.showInactive();
    await win.webContents.executeJavaScript(`window.renderTaskReport({report:${JSON.stringify({id: 'sample-report', status: 'completed', title: 'Launch brief', duration: '1 minute', summary: 'A clear plan prepared from supporting notes.', steps: [], reviews: [], checks: [], outputs: [{label: 'Project plan', value: report}], blockers: [], cleanup: 'All workers stopped.'})}})`);
    await capture(win, 'task-report', 'Task report'); win.destroy();
    win = windowFor(680, 780); await win.loadFile(join(root, 'renderer/setup.html')); win.showInactive(); await capture(win, 'setup', 'API keys'); win.destroy();
    win = windowFor(480, 480); await win.loadFile(join(root, 'renderer/index.html')); win.showInactive();
    win.webContents.send('state', {status: 'idle', skin: 'jarvis'});
    await capture(win, 'hud', 'Voice HUD');
    // A clean desktop-sized preview shows the production reactor at its normal
    // bottom-right position. Only this disposable preview gets a background;
    // the app's real 240×240 always-on-top window stays transparent.
    win.setSize(1200, 800);
    await win.webContents.executeJavaScript(`Object.assign(document.body.style, {
      background: 'radial-gradient(ellipse at 18% 10%, #6591c4 0%, transparent 48%), radial-gradient(ellipse at 88% 80%, #3c205c 0%, transparent 55%), linear-gradient(135deg, #214579, #14274d 52%, #242147)',
      alignItems: 'flex-end', paddingRight: '55px', paddingBottom: '42px'
    })`);
    await capture(win, 'desktop-hud', 'Main desktop HUD (clean preview)'); win.destroy();
    for (const [id, file, title] of [['neural','neural.html','Neural Core'],['synapse','synapse/synapse.html','Synaptic Field']]) {
      win = windowFor(); await win.loadFile(join(root, 'renderer', file)); win.showInactive(); await capture(win, id, title, 1600); win.destroy();
    }
    // Public intelligence panels use their real public feeds in a separate
    // temporary partition. No personal browser profile is connected.
    for (const [id, title] of [['osiris','Osiris globe'],['orbital','Orbital feed']]) {
      win = windowFor(1180, 760, 'preload.cjs', true);
      await win.loadFile(join(root, 'renderer', id + '.html')); win.showInactive();
      await capture(win, id, title, 12000); win.destroy();
    }
    if (!selected) writeFileSync(join(out, 'manifest.json'), JSON.stringify({source: 'Shipping renderers in isolated storage. Control-panel and report data are sample fixtures; desktop HUD uses a clean preview background. Osiris/Orbital are public feeds. No personal desktop, microphone, account or API keys captured.', captures}, null, 2) + '\n');
    app.exit(0);
  } catch (e) {console.error(e); win?.destroy(); app.exit(1);}
});
