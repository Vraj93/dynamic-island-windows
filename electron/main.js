'use strict';
/*
 * Dynamic Island - main process.
 * One see-through, always-on-top window pinned to the top-centre of the main screen.
 *  - Clicks pass straight through it, except where the island is drawn (the UI reports that area).
 *  - The mouse is watched for the top-edge "hover zone" that opens the utility sheet.
 * All coordinates here are Windows display pixels (DIP), the same unit as CSS pixels in the UI.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, session, desktopCapturer, clipboard, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

// Inside an installed app this file lives in app.asar. Scripts run by PowerShell or Node must be real
// files on disk, so they're shipped "unpacked" next to it; these paths point there.
const UNPACKED = __dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
const UNPACKED_ROOT = path.resolve(UNPACKED, '..');
// Start with Windows: the installed app starts itself; in development, Electron starts this folder.
const loginArgs = () => (app.isPackaged ? [] : [path.resolve(__dirname, '..')]);
const crypto = require('crypto');

const WIN_W = 1000;           // big enough for the largest panel plus its shadow
const WIN_H = 760;
const ZONE_W = 320;           // width of the top-edge hover zone, centred
const ZONE_HOLD_MS = 150;     // how long the mouse must rest there before the sheet opens

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // timer chimes
// Keep data in %APPDATA%\dynamic-island whatever the app's display name is: settings, alarms, notes and the
// shelf live there, and the Claude Code hook looks there for the island's address.
app.setPath('userData', path.join(app.getPath('appData'), 'dynamic-island'));

let win = null;
let tray = null;
let rects = [];               // clickable areas, relative to the window
let mouseCaptured = false;
let zone = { inside: false, since: 0, fired: false };

const logFile = path.join(app.getPath('userData'), 'island.log');
function log(text) {
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`); } catch { /* never crash on logging */ }
}

function windowBounds() {
  const d = screen.getPrimaryDisplay().bounds;
  return { x: Math.round(d.x + (d.width - WIN_W) / 2), y: d.y, width: WIN_W, height: WIN_H };
}

function createWindow() {
  win = new BrowserWindow({
    ...windowBounds(),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,          // never steals focus from what you're doing
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) log('ui: ' + message); });
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone: ' + d.reason));
}

function send(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('host', msg);
}

/* ---------- messages from the UI ---------- */
ipcMain.on('ui', (_e, msg) => {
  switch (msg && msg.type) {
    case 'ready':
      log('ui ready');
      if (lastMedia) send(lastMedia);
      if (lastFullscreen) send(lastFullscreen);
      // Development only: ISLAND_TEST_SCRIPT=<file.js> runs that script in the UI (used to test drag-and-drop screens).
      if (process.env.ISLAND_TEST_SCRIPT && fs.existsSync(process.env.ISLAND_TEST_SCRIPT)) {
        win.webContents.executeJavaScript(fs.readFileSync(process.env.ISLAND_TEST_SCRIPT, 'utf8')).catch((e) => log('test script: ' + e.message));
      }
      break;
    case 'rects': rects = Array.isArray(msg.rects) ? msg.rects : []; break;
    case 'log': log('ui: ' + msg.text); break;
    case 'media-cmd': mediaCommand(msg.cmd); break;
    case 'agent-decision': answerPermission(msg.reqId, msg.decision); break;
    case 'focus':
      // Text boxes (notes, reminders) need keyboard focus; otherwise the island never takes it.
      if (!win) break;
      if (msg.on) { win.setFocusable(true); win.focus(); }
      else if (win.isFocusable()) { win.blur(); win.setFocusable(false); }
      break;
    case 'clip-copy': if (typeof msg.text === 'string') { clipSkip = msg.text; clipboard.writeText(msg.text); } break;
    case 'clip-clear': clipHistory = []; send({ type: 'clip', items: clipHistory }); break;
    case 'settings':
      // Older builds kept settings in the island; adopt them once if there's no settings file yet.
      if (!settingsFromDisk && msg.settings && typeof msg.settings === 'object') {
        for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof msg.settings[k] === typeof DEFAULT_SETTINGS[k]) settings[k] = msg.settings[k];
        saveSettings();
      }
      applySettings(settings);
      break;
    case 'set-setting': setSetting(msg.key, msg.value); break;
    case 'open-settings': openSettings(); break;
    case 'open-data-folder': shell.openPath(app.getPath('userData')); break;
    case 'open-repo': shell.openExternal('https://github.com/Vraj93/dynamic-island-windows'); break;
    case 'open-path': if (typeof msg.path === 'string' && fs.existsSync(msg.path)) shell.showItemInFolder(msg.path); break;
    case 'quit': app.quit(); break;
  }
});

/* ---------- mouse: click-through + hover zone ---------- */
function poll() {
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const d = screen.getPrimaryDisplay().bounds;

  // Take the mouse only while it is over the island.
  const lx = p.x - b.x, ly = p.y - b.y;
  const over = rects.some((r) => lx >= r.x && lx < r.x + r.w && ly >= r.y && ly < r.y + r.h);
  if (over !== mouseCaptured) {
    mouseCaptured = over;
    win.setIgnoreMouseEvents(!over, { forward: true });
  }

  // Top-edge hover zone.
  const centre = d.x + d.width / 2;
  const inZone = settings.edgeTrigger !== false && p.y <= d.y + 1 && Math.abs(p.x - centre) <= ZONE_W / 2;
  const now = Date.now();
  if (inZone && !zone.inside) {
    zone = { inside: true, since: now, fired: false };
    send({ type: 'edge-enter' });
  } else if (inZone && !zone.fired && now - zone.since >= (Number(settings.hoverDelay) || 0)) {
    zone.fired = true;
    send({ type: 'edge-open' });
  } else if (!inZone && zone.inside) {
    zone.inside = false;
    send({ type: 'edge-exit' });
  }
}

/* ---------- media: a Windows PowerShell helper reads "now playing" and runs play/pause/next ---------- */
let media = null;
let mediaRestarts = 0;
let lastMedia = null;
let lastFullscreen = null;

function startMedia() {
  const script = path.join(UNPACKED, 'media.ps1');
  media = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  if (settings.volumeKeys === false) media.stdin.write('volkeys off\n'); // the helper reads it once it's running
  let buf = '';
  media.stdout.setEncoding('utf8');
  media.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.type === 'media') { lastMedia = m; send(m); mediaRestarts = 0; }
        else if (m.type === 'fullscreen') { lastFullscreen = m; send(m); log('fullscreen ' + m.on); }
        else if (m.type === 'sys') send(m);
        else if (m.type === 'media-error') log('media: ' + m.message);
      } catch { log('media (bad line): ' + line.slice(0, 120)); }
    }
  });
  media.stderr.on('data', (d) => log('media stderr: ' + String(d).slice(0, 300)));
  media.on('exit', (code) => {
    log('media helper exited ' + code);
    media = null;
    if (app.isQuitting) return;
    // Restart with a growing delay so a broken helper can't spin the CPU.
    const delay = Math.min(30000, 1000 * 2 ** mediaRestarts++);
    setTimeout(startMedia, delay);
  });
}

function mediaCommand(cmd) {
  if (!media || !/^(toggle|next|prev|seek [\d.]+|select [\w.!\-]+|volkeys (on|off))$/.test(String(cmd))) return;
  media.stdin.write(cmd + '\n');
}

/* ---------- AI agents: Claude Code hooks report here over a local-only HTTP server ----------
 * POST /event       {hook JSON}  -> status update (answered immediately)
 * POST /permission  {hook JSON}  -> held open until you press Allow or Deny in the island
 * Only this PC can connect (127.0.0.1), and every request must carry the secret token that
 * electron/hooks/claude-hook.js reads from the same file, so web pages can't post to it.
 */
const AGENT_PORT = 48653;
const agentInfoFile = () => path.join(app.getPath('userData'), 'agent-server.json');
const pendingPermissions = new Map(); // reqId -> { res, session }
let agentToken = '';

function startAgentServer() {
  agentToken = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.headers['x-island-token'] !== agentToken) { res.writeHead(403); return res.end(); }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let ev;
      try { ev = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      // AI agents switched off in Settings: answer at once so Claude Code just shows its normal prompt.
      if (settings.agents === false) {
        if (req.url === '/permission') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"decision":null}'); }
        res.writeHead(204); return res.end();
      }
      if (req.url === '/event') {
        res.writeHead(204); res.end();
        // A later step means any open approval for that session was answered somewhere else.
        if (['PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd', 'UserPromptSubmit', 'PermissionDenied'].includes(ev.hook_event_name)) {
          for (const [id, p] of pendingPermissions) if (p.session === ev.session_id) closePermission(id, null);
        }
        send({ type: 'agent', event: ev });
      } else if (req.url === '/permission') {
        const reqId = crypto.randomBytes(8).toString('hex');
        pendingPermissions.set(reqId, { res, session: ev.session_id });
        // If the hook gives up (Claude Code answered in the terminal, or its timeout hit), the socket closes.
        // (Watch the response: the request's own 'close' fires as soon as its body has been read.)
        res.on('close', () => { if (pendingPermissions.has(reqId)) closePermission(reqId, null); });
        send({ type: 'agent-permission', reqId, event: ev });
      } else { res.writeHead(404); res.end(); }
    });
  });
  server.on('error', (e) => log('agent server: ' + e.message));
  server.listen(AGENT_PORT, '127.0.0.1', () => {
    fs.writeFileSync(agentInfoFile(), JSON.stringify({ port: AGENT_PORT, token: agentToken, pid: process.pid }));
    log('agent server on ' + AGENT_PORT);
  });
}

function answerPermission(reqId, decision) {
  if (decision !== 'allow' && decision !== 'deny') return;
  closePermission(reqId, decision);
}

function closePermission(reqId, decision) {
  const p = pendingPermissions.get(reqId);
  if (!p) return;
  pendingPermissions.delete(reqId);
  try {
    if (!p.res.writableEnded) { p.res.writeHead(200, { 'Content-Type': 'application/json' }); p.res.end(JSON.stringify({ decision })); }
  } catch { /* the hook already gave up */ }
  if (!decision) send({ type: 'agent-permission-gone', reqId });
}

/* ---------- clipboard history: text you copy, kept in memory only (never written to disk) ---------- */
let clipHistory = [];
let clipLast = '';
let clipSkip = '';
let clipEnabled = true;
let clipReading = false;
async function pollClipboard() {
  if (!clipEnabled || clipReading) return;
  let text = '';
  clipReading = true;
  // Newer Electron returns the clipboard text as a promise; await works either way.
  try { text = await clipboard.readText(); } catch (e) { log('clipboard read: ' + e.message); return; } finally { clipReading = false; }
  if (typeof text !== 'string' || !text || text === clipLast) return;
  clipLast = text;
  if (text === clipSkip) { clipSkip = ''; return; } // the island itself just copied this
  if (text.length > 20000) return;
  clipHistory = [{ text, at: Date.now() }, ...clipHistory.filter((c) => c.text !== text)].slice(0, 25);
  send({ type: 'clip', items: clipHistory, fresh: true });
}

/* ---------- settings: saved in settings.json, edited in the Settings window, applied everywhere ---------- */
const DEFAULT_SETTINGS = {
  edgeTrigger: true,      // mouse at the top-centre edge opens the utility sheet
  hoverDelay: 150,        // ms the mouse must rest there first
  media: true,            // show what's playing
  mediaPeek: true,        // "Now playing" pop-up when the song changes
  liveBars: true,         // sound bars follow the real audio
  agents: true,           // Claude Code status and approvals
  volumeKeys: true,       // island handles the volume keys (hides Windows' pop-up)
  hudVolume: true, hudBrightness: true, hudCaps: true, hudBattery: true,
  clipboard: true,        // clipboard history (memory only)
  chimes: true,           // sounds for timers, alarms, reminders, agents
  hideFullscreen: true,   // step aside for full-screen video and games (alerts still show)
  startWithWindows: false,
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULT_SETTINGS };
let settingsFromDisk = false;
function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; settingsFromDisk = true; }
  catch { settings = { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); settingsFromDisk = true; } catch (e) { log('settings save: ' + e.message); }
}
function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS) || typeof value !== typeof DEFAULT_SETTINGS[key]) return;
  settings[key] = value;
  saveSettings();
  applySettings(settings);
}
function broadcastSettings() {
  const msg = { type: 'settings', settings };
  send(msg);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('host', msg);
}
function applySettings(s) {
  settings = s;
  broadcastSettings();
  clipEnabled = s.clipboard !== false;
  if (!clipEnabled) clipHistory = [];
  mediaCommand(s.volumeKeys === false ? 'volkeys off' : 'volkeys on');
  // Start with Windows: run this same Electron with this app folder (works with Smart App Control on).
  try {
    const args = loginArgs();
    // Earlier builds registered under Electron's default name; remove that so there's only one entry.
    app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args, name: 'electron.app.Electron' });
    app.setLoginItemSettings({ openAtLogin: !!s.startWithWindows, path: process.execPath, args, name: 'Dynamic Island' });
  } catch (e) { log('login item: ' + e.message); }
}

/* ---------- the Settings window (centred, like a normal app window) ---------- */
let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 980, height: 660, minWidth: 760, minHeight: 520,
    center: true, show: false,
    title: 'Dynamic Island Settings',
    icon: path.join(__dirname, '..', 'assets', 'app-icon.png'),
    backgroundColor: '#141416',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0c0e', symbolColor: '#e4e4e7', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(__dirname, '..', 'ui', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  packaged: app.isPackaged,
  dataFolder: app.getPath('userData'),
}));

/* ---------- shelf: file icons and dragging files back out ---------- */
const iconCache = new Map();
ipcMain.handle('file-info', async (_e, filePath) => {
  try {
    const st = fs.statSync(filePath);
    let icon = iconCache.get(filePath);
    if (!icon) { icon = await app.getFileIcon(filePath, { size: 'large' }); iconCache.set(filePath, icon); }
    return { ok: true, size: st.size, dir: st.isDirectory(), icon: icon.toDataURL() };
  } catch { return { ok: false }; }
});
ipcMain.on('shelf-drag', async (e, filePath) => {
  if (typeof filePath !== 'string' || !fs.existsSync(filePath)) return;
  let icon = iconCache.get(filePath);
  if (!icon) { try { icon = await app.getFileIcon(filePath, { size: 'normal' }); } catch { icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')); } }
  e.sender.startDrag({ file: filePath, icon });
});
ipcMain.handle('login-item', () => app.getLoginItemSettings({ path: process.execPath, args: loginArgs(), name: 'Dynamic Island' }).openAtLogin);

/* ---------- file converter ---------- */
const IMAGE_IN = /\.(jpe?g|png|bmp|gif|tiff?|heic|heif|webp|ico|jxr)$/i;
const MEDIA_IN = /\.(mp4|mov|m4v|mkv|avi|wmv|webm|mp3|wav|m4a|aac|flac|wma|ogg|3gp)$/i;

function uniqueOut(file, ext) {
  const dir = path.dirname(file), base = path.basename(file).replace(/\.[^.]+$/, '');
  let out = path.join(dir, `${base}.${ext}`), n = 1;
  while (fs.existsSync(out) || out.toLowerCase() === file.toLowerCase()) out = path.join(dir, `${base} (${n++}).${ext}`);
  return out;
}

function runConvert(mode, input, output, format, quality) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(UNPACKED, 'convert.ps1'),
      '-Mode', mode, '-In', input, '-Out', output, '-Format', format, '-Quality', String(quality || 90)];
    const p = spawn('powershell.exe', args, { windowsHide: true });
    let last = null, buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) { try { const m = JSON.parse(line); if ('ok' in m) last = m; } catch { /* progress noise */ } }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    p.on('exit', () => {
      try { const m = JSON.parse(buf.trim()); if ('ok' in m) last = m; } catch { /* nothing */ }
      resolve(last || { ok: false, error: 'The converter stopped unexpectedly.' });
    });
  });
}

async function imagesToPdf(files) {
  const out = uniqueOut(files[0], 'pdf');
  const tmp = path.join(app.getPath('temp'), `island-pdf-${Date.now()}.html`);
  const pages = files.map((f) => `<div class="p"><img src="${require('url').pathToFileURL(f).href}"></div>`).join('');
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:0}html,body{margin:0}
    .p{width:210mm;height:297mm;display:flex;align-items:center;justify-content:center;page-break-after:always;overflow:hidden}
    .p:last-child{page-break-after:auto}img{max-width:190mm;max-height:277mm;object-fit:contain}</style>${pages}`);
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await w.loadFile(tmp);
    await w.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.decode().catch(() => {})))');
    const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' } });
    fs.writeFileSync(out, pdf);
    return { ok: true, out };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { w.destroy(); try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

// Converts each file in turn and reports progress to the UI as it goes.
ipcMain.handle('convert', async (_e, job) => {
  const files = (job && Array.isArray(job.files) ? job.files : []).filter((f) => typeof f === 'string' && fs.existsSync(f));
  const to = String(job && job.to || '').toLowerCase();
  if (!files.length) return [];
  if (to === 'pdf') {
    send({ type: 'convert-progress', index: 0, total: 1, state: 'working' });
    const r = await imagesToPdf(files.filter((f) => IMAGE_IN.test(f)));
    send({ type: 'convert-progress', index: 0, total: 1, state: r.ok ? 'done' : 'failed', result: r });
    return [r];
  }
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const mode = IMAGE_IN.test(f) ? 'image' : MEDIA_IN.test(f) ? 'media' : null;
    send({ type: 'convert-progress', index: i, total: files.length, state: 'working', file: f });
    const r = mode ? await runConvert(mode, f, uniqueOut(f, to), to, job.quality)
      : { ok: false, error: 'Only images, audio and video can be converted.' };
    r.input = f;
    results.push(r);
    send({ type: 'convert-progress', index: i, total: files.length, state: r.ok ? 'done' : 'failed', result: r });
  }
  return results;
});

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: 'Choose files to convert' });
  return r.canceled ? [] : r.filePaths;
});

/* ---------- Claude Code connection, from the settings panel ---------- */
ipcMain.handle('claude-hooks', (_e, cmd) => new Promise((resolve) => {
  if (!['connect', 'disconnect', 'status'].includes(cmd)) return resolve('');
  const p = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [path.join(UNPACKED_ROOT, 'scripts', 'claude-hooks.js'), cmd], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', () => resolve('Could not run Node.js.'));
  p.on('exit', () => resolve(out.trim()));
}));

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')));
  tray.setToolTip('Dynamic Island');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open utility sheet', click: () => send({ type: 'edge-open' }) },
    { label: 'Settings…', click: () => openSettings() },
    { label: 'Reload UI', click: () => win && win.reload() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => send({ type: 'edge-open' }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    log(`start, display ${JSON.stringify(screen.getPrimaryDisplay().bounds)} scale ${screen.getPrimaryDisplay().scaleFactor}`);
    // Sound bars: let the island listen to what's playing on the PC (system audio "loopback").
    // Only our own window can ask for it, and the audio never leaves the PC; it only drives the bars.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      if (!win || request.frame !== win.webContents.mainFrame) return callback({});
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}));
    });
    loadSettings();
    createWindow();
    createTray();
    startMedia();
    applySettings(settings);
    startAgentServer();
    setInterval(poll, 16);
    setInterval(pollClipboard, 800);
    // Re-pin to the top-centre if screens or scaling change.
    const replace = () => win && win.setBounds(windowBounds());
    screen.on('display-metrics-changed', replace);
    screen.on('display-added', replace);
    screen.on('display-removed', replace);
    // Other always-on-top windows can push us down; re-assert now and then.
    setInterval(() => win && !win.isDestroyed() && win.setAlwaysOnTop(true, 'screen-saver'), 3000);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    app.isQuitting = true;
    if (media) { try { media.stdin.end(); media.kill(); } catch { /* already gone */ } }
    try { fs.unlinkSync(agentInfoFile()); } catch { /* not there */ }
    for (const id of [...pendingPermissions.keys()]) closePermission(id, null);
  });
}
