'use strict';
/* Dynamic Island UI.
 * The Electron main process (electron/main.js) sends:
 *   edge-enter / edge-open / edge-exit   mouse at the top-centre edge
 *   media                                what Windows says is playing (from electron/media.ps1)
 * and receives:
 *   ready, rects (where islands are drawn, so only there takes clicks), media-cmd, log
 */

const host = window.islandHost; // from electron/preload.js
const post = (m) => { if (host) host.send(m); };
window.addEventListener('error', (e) => post({ type: 'log', text: `${e.message} @ ${e.lineno}:${e.colno}` }));
const $ = (s) => document.querySelector(s);

const island = $('#island');
const content = $('#content');
const bubble = $('#bubble');
const measurer = $('#measure');

const SHOULDER = 18;   // curved shoulders stick out this far on each side
const PAD_SIDE = 26;   // room for the soft shadow, also clickable
const PAD_BOTTOM = 44;
const LIP = { w: 200, h: 10, r: 10 };
const PAUSED_HIDE_MS = 2 * 60 * 1000;

const state = {
  view: 'none',
  battery: null,
  setupSec: 10 * 60,
  timer: null,        // { total, endAt, pausedLeft, done }
  soon: '',
  media: null,        // latest report from the media helper
  mediaColor: '255,138,92',
  pausedSince: 0,
  showSources: false,
  agents: new Map(),  // session id -> { id, project, title, status, step, startedAt, doneAt, feed, answer }
  approvals: [],      // permission requests waiting for Allow / Deny: { reqId, session, tool, input }
  focusAgent: null,   // session shown in the expanded agent panel
  dismissedMedia: '', // track you hid by hand: stays hidden until something else plays
  dismissedAgents: new Set(), // agent sessions you hid: back on their next task
  fullscreen: false,  // a full-screen app is in front: only alerts show
  sys: null,          // last volume / brightness / Caps Lock reading
  hud: null,          // the system pop-up being shown: { kind, ... }
  lowBatteryShown: 0, // last low-battery level we warned about (15 or 5)
};
const HUD_MS = 1800;
// Preferences from the Settings window (kept in sync by tools.js).
const prefs = { media: true, mediaPeek: true, lyrics: true, findCovers: true, hideFullscreen: true, chimes: true, hudVolume: true, hudBrightness: true, hudCaps: true, hudBattery: true,
  tiles: ['calendar', 'timer', 'alarm', 'focus', 'reminder', 'note', 'clipboard', 'shelf', 'convert'] };
const mediaKey = (x) => (x && x.active ? `${x.source}|${x.title}|${x.artist}` : '');
const DONE_SHOW_MS = 90 * 1000; // a finished agent stays in the island this long

/* ---------------- icons ---------------- */
const I = {
  timer: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.3 1.8M9.5 2.8h5"/></svg>',
  alarm: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.5M4.5 4.5 7 2.5M19.5 4.5 17 2.5"/></svg>',
  stopwatch: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5 15 10.5M10 2.8h4M12 2.8V6"/></svg>',
  focus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 1.5h-14zM10 20.5a2 2 0 0 0 4 0"/></svg>',
  note: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h10l4 4v12H5z"/><path d="M9 12h6M9 16h4"/></svg>',
  clip: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5.5" y="4.5" width="13" height="16" rx="2.5"/><path d="M9 4.5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v.5M9 11h6M9 15h4"/></svg>',
  shelf: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3.5 13.5 6 5.5h12l2.5 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/></svg>',
  convert: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  minus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12M12 6v12"/></svg>',
  play: (s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10.4-6.8c.6-.4.6-1.2 0-1.6L9.6 4.4C8.9 3.9 8 4.4 8 5.2z"/></svg>`,
  pause: (s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M7.5 4.5h2.8c.6 0 1 .4 1 1v13c0 .6-.4 1-1 1H7.5c-.6 0-1-.4-1-1v-13c0-.6.4-1 1-1zm6.2 0h2.8c.6 0 1 .4 1 1v13c0 .6-.4 1-1 1h-2.8c-.6 0-1-.4-1-1v-13c0-.6.4-1 1-1z"/></svg>`,
  next: (s = 26) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="#fff"><path d="M3.5 6.6v10.8c0 .8.9 1.2 1.5.8L12 13v4.4c0 .8.9 1.2 1.5.8l7.6-5.4c.5-.4.5-1.2 0-1.6l-7.6-5.4c-.6-.4-1.5 0-1.5.8V11L5 5.8c-.6-.4-1.5 0-1.5.8z"/></svg>`,
  prev: (s = 26) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="#fff"><path transform="matrix(-1 0 0 1 24 0)" d="M3.5 6.6v10.8c0 .8.9 1.2 1.5.8L12 13v4.4c0 .8.9 1.2 1.5.8l7.6-5.4c.5-.4.5-1.2 0-1.6l-7.6-5.4c-.6-.4-1.5 0-1.5.8V11L5 5.8c-.6-.4-1.5 0-1.5.8z"/></svg>`,
  speaker: (muted, level) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M4 9.5v5h3.5l5 4v-13l-5 4z" fill="#fff"/>${muted ? '<path d="M16 9.5l5 5M21 9.5l-5 5"/>' : `${level > 0 ? '<path d="M16 9a4 4 0 0 1 0 6"/>' : ''}${level > 50 ? '<path d="M18.5 6.5a8 8 0 0 1 0 11"/>' : ''}`}</svg>`,
  sun: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffd60a" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4" fill="#ffd60a"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  caps: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><path d="M12 4l8 8h-4v4H8v-4H4z"/><path d="M8 20h8"/></svg>',
  bolt: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#30d158"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  plug: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="2" stroke-linecap="round"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>',
  gear: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  music: '<svg width="45%" height="45%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
};

const TILES = [
  { id: 'timer', name: 'Timer', sub: '5 · 10 · 25 min', icon: I.timer, color: '255,159,10', ready: true },
  { id: 'alarm', name: 'Alarm', sub: 'Coming soon', icon: I.alarm, color: '255,105,97' },
  { id: 'stopwatch', name: 'Stopwatch', sub: 'Coming soon', icon: I.stopwatch, color: '255,214,10' },
  { id: 'focus', name: 'Focus', sub: 'Coming soon', icon: I.focus, color: '191,140,255' },
  { id: 'reminder', name: 'Reminder', sub: 'Coming soon', icon: I.bell, color: '255,111,174' },
  { id: 'note', name: 'Note', sub: 'Coming soon', icon: I.note, color: '99,230,190' },
  { id: 'clipboard', name: 'Clipboard', sub: 'Coming soon', icon: I.clip, color: '100,210,255' },
  { id: 'shelf', name: 'Shelf', sub: 'Coming soon', icon: I.shelf, color: '48,209,88' },
  { id: 'convert', name: 'Convert', sub: 'Coming soon', icon: I.convert, color: '64,200,224' },
];

/* ---------------- helpers ---------------- */
const pad2 = (n) => String(n).padStart(2, '0');
function fmt(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}
function fmtTrack(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
function timeLeft() {
  const t = state.timer;
  if (!t) return 0;
  return t.pausedLeft != null ? t.pausedLeft : (t.endAt - Date.now()) / 1000;
}
function ring(size, stroke, frac, color) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg);flex-shrink:0">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(${color},.22)" stroke-width="${stroke}"/>
    <circle data-ring="${c}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgb(${color})" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - frac)}"/></svg>`;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
const clockText = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/* ---------------- media helpers ---------------- */
const SOURCES = [
  [/spotify/i, 'Spotify', '#1ed760'], [/chrome/i, 'Chrome', '#4c8bf5'], [/msedge|edge/i, 'Edge', '#2fb1e8'],
  [/firefox|308046B0AF4A39CB/i, 'Firefox', '#ff7139'], [/zunemusic|mediaplayer/i, 'Media Player', '#ff5c5c'],
  [/vlc/i, 'VLC', '#ff8800'], [/applemusic|itunes/i, 'Apple Music', '#fa2d48'], [/opera/i, 'Opera', '#ff1b2d'],
  [/brave/i, 'Brave', '#fb542b'], [/discord/i, 'Discord', '#5865f2'], [/youtube/i, 'YouTube', '#ff0033'],
];
function sourceInfo(id) {
  for (const [re, name, color] of SOURCES) if (re.test(id || '')) return { name, color };
  const base = String(id || 'App').split(/[\\/!_]/)[0].replace(/\.exe$/i, '');
  return { name: base.charAt(0).toUpperCase() + base.slice(1), color: '#a1a1aa' };
}
const mediaPlaying = () => !!(state.media && state.media.active && state.media.status === 'Playing');
function mediaVisible() {
  const m = state.media;
  if (!m || !m.active || !(m.title || m.artist)) return false;
  if (!prefs.media) return false;
  if (state.dismissedMedia && state.dismissedMedia === mediaKey(m)) return false;
  if (m.status === 'Playing') return true;
  return m.status === 'Paused' && Date.now() - state.pausedSince < PAUSED_HIDE_MS;
}
function mediaPos() {
  const m = state.media;
  if (!m || !(m.duration > 0)) return 0;
  let p = m.position;
  if (m.status === 'Playing' && m.updatedAt > 0) p += (Date.now() - m.updatedAt) / 1000;
  return Math.min(m.duration, Math.max(0, p));
}
/* Artwork. When a site in a browser gives Windows no artwork (Netflix does this), the browser hands over its own
 * logo instead; the tab's icon isn't available. Then, and whenever there's no artwork at all, show a tile with the
 * first letter of the title in the site's colour. */
const SITE_COLORS = [[/netflix/i, '#e50914'], [/youtube/i, '#ff0033'], [/prime video|amazon/i, '#00a8e1'], [/disney/i, '#113ccf'],
  [/hotstar|jiocinema/i, '#1f80e0'], [/spotify/i, '#1ed760'], [/twitch/i, '#9146ff'], [/soundcloud/i, '#ff5500'], [/apple/i, '#fa2d48'], [/hulu/i, '#1ce783']];
const artUsable = () => !!(state.media && state.media.art && state.mediaArtOk !== false);
function tileColor() {
  const m = state.media || {}, text = `${m.title} ${m.artist} ${m.album}`;
  for (const [re, c] of SITE_COLORS) if (re.test(text)) return c;
  let h = 0; for (const ch of String(m.title || 'x')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h},55%,42%)`;
}
const artStyle = () => (artUsable() ? `background-image:url('${state.media.art}')` : `background:${tileColor()}`);
const artInner = () => {
  if (artUsable()) return '';
  const letter = esc((String((state.media && state.media.title) || '').trim()[0] || '♪').toUpperCase());
  return `<svg viewBox="0 0 10 10" width="100%" height="100%" aria-hidden="true"><text x="5" y="7.1" text-anchor="middle" font-size="6.4" font-weight="700" fill="#fff" font-family="Segoe UI Variable Display,Segoe UI,sans-serif">${letter}</text></svg>`;
};
const eq = () => `<span class="eq${mediaPlaying() ? '' : ' off'}">${'<i></i>'.repeat(7)}</span>`;

/* Pick a lively colour from the album art for the sound bars and the tint. */
function extractColor(src) {
  const img = new Image();
  img.onload = () => {
    // When a site gives no artwork, the browser sends its own round logo instead. Real covers fill the whole square
    // (even small ones, like Apple Music's 150 px); the logo has see-through corners. That's how they're told apart.
    const fromBrowser = /chrome|msedge|edge|firefox|308046B0AF4A39CB|opera|brave|vivaldi/i.test((state.media && state.media.source) || '');
    let ok = true;
    if (fromBrowser) {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 32;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 32, 32);
        const a = (x, y) => g.getImageData(x, y, 1, 1).data[3];
        ok = [a(1, 1), a(30, 1), a(1, 30), a(30, 30)].filter((v) => v < 200).length < 3;
      } catch { ok = true; }
    }
    if (ok !== (state.mediaArtOk !== false)) { state.mediaArtOk = ok; if (/^media|sheet/.test(state.view)) render(state.view); }
    // The browser's logo, not the song's cover: look for the real one. A small real cover (150 px from Apple Music):
    // look for a sharp one to replace it.
    if (!ok || (fromBrowser && img.naturalWidth < 300 && !(state.media && state.media.foundArt))) findCover(state.media);
    if (!ok) {
      state.mediaColor = tileColor().startsWith('#') ? [1, 3, 5].map((i) => parseInt(tileColor().slice(i, i + 2), 16)).join(',') : '255,138,92';
      document.documentElement.style.setProperty('--mc', state.mediaColor);
      return;
    }
    try {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 24, 24);
      const px = g.getImageData(0, 0, 24, 24).data;
      let best = null, bestScore = -1, r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) {
        const R = px[i], G = px[i + 1], B = px[i + 2];
        const max = Math.max(R, G, B), min = Math.min(R, G, B);
        const sat = max ? (max - min) / max : 0, lum = max / 255;
        const score = sat * 1.4 + lum * (lum > .25 ? 1 : 0);
        r += R; gg += G; b += B; n++;
        if (lum > .3 && score > bestScore) { bestScore = score; best = [R, G, B]; }
      }
      let col = best || [r / n, gg / n, b / n];
      // Lift very dark colours so they show on black.
      const mx = Math.max(...col);
      if (mx < 150) col = col.map((v) => v * (150 / Math.max(1, mx)));
      state.mediaColor = col.map((v) => Math.round(Math.min(255, v))).join(',');
    } catch { state.mediaColor = '255,138,92'; }
    document.documentElement.style.setProperty('--mc', state.mediaColor);
  };
  img.src = src;
}

/* ---------------- agent helpers ---------------- */
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
}
function toolKind(tool) {
  if (/^(Read|NotebookRead)$/.test(tool)) return ['Read', '76,156,255'];
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return ['Edit', '255,214,10'];
  if (/^(Bash|PowerShell|BashOutput)$/.test(tool)) return ['Run', '228,228,231'];
  if (/^(Grep|Glob|LS)$/.test(tool)) return ['Search', '191,140,255'];
  if (/^Web/.test(tool)) return ['Web', '100,210,255'];
  if (/^(Task|Agent)$/.test(tool)) return ['Agent', '255,111,174'];
  if (tool === 'Step') return ['Step', '48,209,88'];
  return ['Tool', '161,161,170'];
}
function describeStep(tool, input = {}) {
  const file = baseName(input.file_path || input.notebook_path || input.path);
  if (/^(Read|NotebookRead)$/.test(tool)) return `Reading ${file || 'a file'}`;
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return `Editing ${file || 'a file'}`;
  if (/^(Bash|PowerShell)$/.test(tool)) return `Running ${String(input.description || input.command || 'a command').slice(0, 48)}`;
  if (/^(Grep|Glob|LS)$/.test(tool)) return 'Searching files';
  if (/^Web/.test(tool)) return 'Looking things up online';
  if (/^(Task|Agent)$/.test(tool)) return 'Running a helper agent';
  if (/^(TodoWrite|mcp__.*update_plan)$/.test(tool)) return 'Planning';
  if (/^mcp__/.test(tool)) return 'Using ' + tool.split('__').pop().replace(/_/g, ' ');
  return tool || 'Working';
}
function feedText(tool, input = {}) {
  if (/^(Bash|PowerShell)$/.test(tool)) return String(input.command || '').slice(0, 80);
  const f = input.file_path || input.notebook_path || input.path;
  if (f) return baseName(f);
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.query) return input.query;
  return tool;
}
function approvalText(a) {
  const t = a.tool, i = a.input || {};
  if (/^(Bash|PowerShell)$/.test(t)) return { title: 'Allow this command?', detail: i.command || '', mono: true };
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(t)) return { title: `Allow editing ${baseName(i.file_path || i.notebook_path)}?`, detail: i.file_path || i.notebook_path || '', mono: true };
  if (/^Web/.test(t)) return { title: 'Allow going online?', detail: i.url || i.query || '', mono: true };
  return { title: `Allow ${t}?`, detail: JSON.stringify(i).slice(0, 300), mono: true };
}
function liveAgents() {
  const now = Date.now();
  return [...state.agents.values()].filter((a) => !state.dismissedAgents.has(a.id)
    && (a.status === 'working' || a.status === 'waiting' || ((a.status === 'done' || a.status === 'error') && now - a.doneAt < DONE_SHOW_MS)));
}
function primaryAgent() {
  const live = liveAgents().sort((x, y) => y.updated - x.updated);
  return live.find((a) => a.status === 'waiting') || live.find((a) => a.status === 'working') || live[0] || null;
}
const spinner = (s = 18) => `<svg class="spin" width="${s}" height="${s}" viewBox="0 0 24 24" style="flex-shrink:0"><circle cx="12" cy="12" r="9" fill="none" stroke="rgba(76,156,255,.22)" stroke-width="3"/><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="#4c9cff" stroke-width="3" stroke-linecap="round"/></svg>`;
const check = (s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#30d158" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`;
const AGENT_NAME = 'Claude Code';
const AGENT_COMPACT_W = 420;
// Display names for each agent that can report to the island (see electron/hooks/agent-hook.js).
const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot', cursor: 'Cursor' };
const agentName = (a) => (a && (a.agentName || AGENT_NAMES[a.agent])) || AGENT_NAME;

/* Timer | Stopwatch switch at the top of both panels (the stopwatch lives inside Timer). */
function modeSwitch(active) {
  const timerView = state.timer ? 'timerExpanded' : 'timerSetup';
  return `<div class="modes" role="tablist">
    <button role="tab" aria-selected="${active === 'timer'}" class="${active === 'timer' ? 'on' : ''}" data-act="go" data-arg="${timerView}">Timer</button>
    <button role="tab" aria-selected="${active === 'stopwatch'}" class="${active === 'stopwatch' ? 'on' : ''}" data-act="go" data-arg="stopwatch">Stopwatch</button></div>`;
}

/* ---------------- views ---------------- */
const views = {
  none: () => null,

  lip: () => ({ html: '<div class="v lip"></div>', radius: LIP.r }),

  sheet() {
    const now = new Date();
    const date = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    const b = state.battery;
    const batt = b && b.has ? `
      <div class="row" style="gap:8px">
        <svg width="30" height="15" viewBox="0 0 30 15"><rect x=".75" y=".75" width="25" height="13.5" rx="4" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.5"/>
        <rect x="3" y="3" width="${Math.max(1.5, 20.5 * b.percent / 100)}" height="9" rx="2" fill="${b.percent <= 15 && !b.charging ? '#ff453a' : '#30d158'}"/>
        <rect x="27" y="5" width="2.2" height="5" rx="1.1" fill="rgba(255,255,255,.4)"/></svg>
        <span class="f13" style="font-weight:600">${b.percent}%${b.charging ? ' · charging' : ''}</span></div>` : '';
    // Only the tools chosen in Settings, in the chosen order.
    const shown = prefs.tiles.map((id) => TILES.find((t) => t.id === id)).filter(Boolean);
    const tiles = shown.map((t) => `
      <button class="tile${t.ready ? '' : ' soon'}" data-act="tile" data-arg="${t.id}">
        <span class="ic" style="background:rgba(${t.color},.16);color:rgb(${t.color})">${t.icon}</span>
        <span><span class="t">${t.name}</span><span class="s">${t.id === 'timer' && state.timer ? 'Running · ' + fmt(timeLeft())
          : t.id === 'timer' && typeof T !== 'undefined' && (T.sw.running || T.sw.acc) && !prefs.tiles.includes('stopwatch') ? 'Stopwatch · ' + fmtSw(swElapsed())
          : t.id === 'timer' && !prefs.tiles.includes('stopwatch') ? 'Timer and stopwatch' : t.sub}</span></span>
      </button>`).join('');
    const m = state.media;
    const strip = m && m.active && (m.title || m.artist) ? `
      <div class="strip mstrip" data-act="openPlayer">
        <div class="art" style="width:44px;height:44px;${artStyle()}">${artInner()}</div>
        <div class="sp"><div class="f14 ell" style="font-weight:600">${esc(m.title)}</div><div class="d f12 ell">${esc(m.artist || sourceInfo(m.source).name)}</div></div>
        ${eq()}
        ${m.readOnly ? '' : `<button class="ctl sm" data-act="media" data-arg="prev" aria-label="Previous" ${m.canPrev ? '' : 'disabled'}>${I.prev(20)}</button>
        <button class="ctl sm" data-act="media" data-arg="toggle" aria-label="Play or pause" style="background:rgba(255,255,255,.1)">${mediaPlaying() ? I.pause(18) : I.play(18)}</button>
        <button class="ctl sm" data-act="media" data-arg="next" aria-label="Next" ${m.canNext ? '' : 'disabled'}>${I.next(20)}</button>`}
      </div>` : '';
    // Agents at work (or just finished) get a row of their own, like the song.
    const agentRows = liveAgents().sort((x, y) => y.updated - x.updated).slice(0, 2).map((a) => {
      const done = a.status === 'done', err = a.status === 'error', wait = a.status === 'waiting';
      return `<button class="strip astrip" data-act="focusAgent" data-arg="${esc(a.id)}" style="--ac:${agentRgb(a)}">
        <span class="alogo" style="width:44px;height:44px;border-radius:12px">${esc(agentName(a)[0])}</span>
        <div class="sp" style="text-align:left"><div class="f14 ell" style="font-weight:600">${esc(agentName(a))}${a.project ? `<span class="d" style="font-weight:400"> · ${esc(a.project)}</span>` : ''}</div>
          <div class="d f12 ell">${esc(err ? 'Stopped with an error' : done ? 'Finished' : wait ? 'Needs you in its window' : a.step || 'Thinking')}</div></div>
        ${done ? check(18) : err ? '<span style="color:#ff6b6b;font-weight:700">!</span>' : spinner(18)}
        <span class="f13 tn" style="font-weight:600;min-width:44px;text-align:right" ${done || err ? '' : `data-bind="agentClock" data-since="${a.startedAt}"`}>${fmtClock((done || err ? a.doneAt : Date.now()) - a.startedAt)}</span>
      </button>`;
    }).join('');
    return {
      html: `<div class="v sheet">
        <div class="row" style="padding:0 4px">
          <div class="sp"><div class="big" style="font-size:34px" data-bind="clock">${clockText()}</div><div class="m f13" style="margin-top:6px">${date}</div></div>
          ${batt}
          <button class="x" data-act="openSettings" aria-label="Settings" title="Settings" style="margin-left:6px">${I.gear}</button>
        </div>
        ${shown.length ? `<div class="grid" style="grid-template-columns:repeat(${Math.min(3, shown.length)},minmax(0,1fr))">${tiles}</div>` : ''}
        ${strip}
        ${agentRows}
        ${state.soon ? `<div class="soonmsg">${esc(state.soon)}</div>` : ''}
      </div>`,
      radius: 34,
    };
  },

  timerSetup() {
    const presets = [1, 5, 10, 15, 25, 45].map((m) =>
      `<button class="chip${state.setupSec === m * 60 ? ' on' : ''}" data-act="preset" data-arg="${m}">${m}m</button>`).join('');
    return {
      html: `<div class="v setup">
        <div class="row"><button class="ib" data-act="go" data-arg="sheet" aria-label="Back" style="width:36px;height:36px">${I.back}</button><span class="sp"></span>${modeSwitch('timer')}<span class="sp"></span><span style="width:36px"></span></div>
        <div class="row" style="justify-content:center;gap:18px;padding:4px 0">
          <button class="ib" data-act="adjust" data-arg="-60" aria-label="One minute less">${I.minus}</button>
          <div class="big" style="font-size:72px;color:#ff9f0a;min-width:220px;text-align:center">${fmt(state.setupSec)}</div>
          <button class="ib" data-act="adjust" data-arg="60" aria-label="One minute more">${I.plus}</button>
        </div>
        <div class="row" style="gap:6px;justify-content:center">${presets}</div>
        <button class="btn w" data-act="start" style="width:100%;height:50px;font-size:15px">Start timer</button>
      </div>`,
      radius: 34,
    };
  },

  timerCompact() {
    const t = state.timer, left = timeLeft();
    return {
      html: `<div class="v compact">
        ${ring(20, 3, left / t.total, '255,159,10')}
        <span class="f14 tn" style="font-weight:600;color:#ff9f0a" data-bind="left">${fmt(left)}</span>
        ${t.pausedLeft != null ? '<span class="d f12">paused</span>' : ''}
      </div>`,
      radius: 19,
    };
  },

  timerExpanded() {
    const t = state.timer, left = timeLeft();
    const end = new Date(Date.now() + left * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const paused = t.pausedLeft != null;
    return {
      html: `<div class="v texp">
        <div class="row" style="justify-content:center">${modeSwitch('timer')}</div>
        <div class="row" style="gap:20px">
          ${ring(92, 7, left / t.total, '255,159,10')}
          <div class="sp"><div class="m f13">Timer</div>
            <div class="big" style="font-size:54px;color:#ff9f0a;margin-top:4px" data-bind="left">${fmt(left)}</div>
            <div class="d f12" style="margin-top:6px">${paused ? 'Paused' : 'Ends at ' + end}</div></div>
        </div>
        <div class="row" style="gap:8px">
          <button class="btn f" data-act="${paused ? 'resume' : 'pause'}">${paused ? 'Resume' : 'Pause'}</button>
          <button class="btn f" data-act="addmin">+1 min</button>
          <button class="btn f" data-act="cancel" style="color:#ff8a84">Cancel</button>
        </div>
      </div>`,
      radius: 34,
    };
  },

  timerDone: () => ({
    html: `<div class="v alert">
      <span style="color:#ff9f0a;display:flex">${I.bell}</span>
      <span class="f14" style="font-weight:600">Time's up</span>
      <button class="btn sm" data-act="repeat">Repeat</button>
      <button class="btn sm" data-act="stop" style="background:#ff9f0a;color:#000">Stop</button>
    </div>`,
    radius: 29,
    ring: { color: '#ff9f0a', rgb: '255,159,10' },
  }),

  agentCompact() {
    const a = primaryAgent();
    if (a.status === 'error') {
      return {
        html: `<div class="v compact" style="gap:10px">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6961" stroke-width="2.4" stroke-linecap="round" style="flex-shrink:0"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.1"/></svg>
          <span class="f13 ell" style="max-width:260px"><b>${esc(agentName(a))}</b> <span style="color:#ff8a84">stopped · ${esc(a.answer)}</span></span></div>`,
        radius: 19,
      };
    }
    if (a.status === 'done') {
      return {
        html: `<div class="v compact" style="gap:10px">${check()}
          <span class="f13 ell" style="max-width:260px"><b>${esc(a.project || agentName(a))}</b> <span style="color:#30d158">finished</span></span>
          <span class="d f12">${fmtDur(a.doneAt - a.startedAt)}</span></div>`,
        radius: 19,
      };
    }
    if (a.status === 'waiting') {
      // Agents that can't be answered from the island (Gemini): point you to its window.
      return {
        html: `<div class="v compact" style="gap:10px">
          <span class="dot" style="width:10px;height:10px;border-radius:50%;background:#ff9f0a"></span>
          <span class="f13 ell" style="max-width:260px"><b>${esc(agentName(a))}</b> <span style="color:#ffb340">needs you · answer in its window</span></span></div>`,
        radius: 19,
        ring: { color: '#ff9f0a', rgb: '255,159,10' },
      };
    }
    const others = liveAgents().length - 1;
    return {
      // A steady width: the island doesn't jump around as the step text changes ("Thinking" -> "Editing main.js");
      // long steps end in "…" and each new step fades in.
      // Just the spinner, who, and how long: the steps are in the expanded view. A steady width, so it never jumps.
      html: `<div class="v compact" style="gap:10px">${spinner()}
        <span class="f13 ell" style="font-weight:700;max-width:180px;flex-shrink:0">${esc(agentName(a))}</span>
        <span class="d f12 tn" style="min-width:46px;text-align:right" data-bind="agentElapsed" data-since="${a.startedAt}">${fmtDur(Date.now() - a.startedAt)}</span>
        ${others > 0 ? `<span class="src">+${others}</span>` : ''}</div>`,
      radius: 19,
    };
  },

  agentAlert() {
    const n = state.approvals.length;
    return {
      html: `<div class="v alert" style="gap:12px">
        <span class="dot" style="width:10px;height:10px;border-radius:50%;background:#ff9f0a"></span>
        <span class="f14"><b>${esc(agentName(state.agents.get((state.approvals[0] || {}).session)))}</b> <span style="color:#ffb340">needs your approval${n > 1 ? ` (${n})` : ''}</span></span>
        <button class="btn sm w" data-act="review">Review</button>
      </div>`,
      radius: 29,
      ring: { color: '#ff9f0a', rgb: '255,159,10' },
    };
  },

  approvalExpanded() {
    const req = state.approvals[0];
    const a = state.agents.get(req.session) || {};
    const t = approvalText(req);
    return {
      html: `<div class="v texp" style="width:520px;gap:14px">
        <div class="row"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:#ff9f0a"></span>
          <div class="sp"><div class="f15">${esc(t.title)}</div><div class="d f12">${esc(agentName(a))}${a.project ? ' · ' + esc(a.project) : ''}</div></div>
          ${state.approvals.length > 1 ? `<span class="src">${state.approvals.length - 1} more</span>` : ''}</div>
        <div style="background:#0e0e12;border-radius:14px;padding:12px 14px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);font-family:Consolas,'Cascadia Mono',monospace;font-size:13px;line-height:1.5;word-break:break-all;max-height:150px;overflow:auto;user-select:text">${esc(t.detail)}</div>
        <div class="row" style="gap:10px"><button class="btn f" data-act="decide" data-arg="deny">Deny</button><button class="btn f w" data-act="decide" data-arg="allow">Allow once</button></div>
      </div>`,
      radius: 34,
      ring: { color: '#ff9f0a', rgb: '255,159,10' },
    };
  },

  agentExpanded() {
    const list = liveAgents();
    const a = state.agents.get(state.focusAgent) || primaryAgent();
    if (!a) return views.none();
    const done = a.status === 'done' || a.status === 'error', err = a.status === 'error';
    const rgb = agentRgb(a);
    const stage = done ? 3 : (a.stage == null ? 0 : a.stage);
    const seen = done ? [0, 1, 2, 3] : (a.stages || [0]);
    const name = agentName(a);
    const elapsed = (done ? a.doneAt : Date.now()) - a.startedAt;
    // Right side: the code being changed, or the latest steps.
    const d = a.diff;
    const ext = d ? (d.file.match(/\.([\w]+)$/) || [, ''])[1].toLowerCase() : '';
    const diffCard = d ? `<div class="adiff">
        <div class="row" style="gap:10px"><span class="lang">${esc(LANG[ext] || (ext || 'TXT').slice(0, 4).toUpperCase())}</span>
          <span class="f14 sp ell" style="font-weight:600">${esc(d.file || 'file')}</span><span class="d f12">${d.live && !done ? (d.isNew ? 'being written' : 'being edited') : d.isNew ? 'new file' : 'edited'}</span></div>
        ${d.old.map((l) => `<div class="dl del"><span>−</span><code>${esc(l.trim().slice(0, 70)) || ' '}</code></div>`).join('')}
        ${d.new.map((l) => `<div class="dl add"><span>+</span><code>${esc(l.trim().slice(0, 70)) || ' '}</code></div>`).join('')}
        ${d.more ? '<div class="d f12" style="padding-left:4px">…</div>' : ''}
      </div>` : '';
    const feed = a.feed.slice(-4).map((f) => {
      const [k, frgb] = toolKind(f.tool);
      return `<div class="row f13" style="gap:10px"><span class="tag" style="background:rgba(${frgb},.14);color:rgb(${frgb})">${k}</span>
        <span class="sp ell" style="font-family:Consolas,'Cascadia Mono',monospace;font-size:12px">${esc(f.text)}</span>${f.failed ? '<span style="color:#ff6b6b" class="f12">failed</span>' : ''}</div>`;
    }).join('');
    const right = diffCard || (feed ? `<div class="adiff" style="gap:9px">${feed}</div>` : '');
    const bars = STAGES.map((s, i) => {
      const fill = i < stage || (done && i <= 3) ? 100 : i === stage ? null : 0;
      return `<div class="aseg${i === stage && !done ? ' cur' : ''}${seen.includes(i) || i < stage ? ' seen' : ''}">
        <div class="bar">${fill === null ? '<b class="run"></b>' : `<b style="width:${fill}%"></b>`}</div><span>${s}</span></div>`;
    }).join('');
    const others = list.filter((x) => x !== a).map((x) => `
      <button class="srcrow" data-act="focusAgent" data-arg="${esc(x.id)}">${x.status === 'done' ? check(16) : spinner(16)}
        <span class="f13 sp ell" style="font-weight:600">${esc(agentName(x) + (x.project ? ' · ' + x.project : ''))}</span><span class="d f12 ell" style="max-width:220px">${esc(x.status === 'done' ? 'finished' : x.step)}</span></button>`).join('');
    const script = a.agent === 'custom'; // a script or program posting by itself: its own steps, no Read/Edit/Test
    const nSteps = script ? a.feed.length : a.steps;
    const sub = err ? 'Stopped with an error' : done ? `Finished${nSteps ? ` · ${nSteps} step${nSteps === 1 ? '' : 's'}` : ''}`
      : script ? `Running${nSteps ? ` · step ${nSteps}` : ''}` : `${STAGE_TEXT[stage]} · stage ${stage + 1} of 4${a.steps ? ` · step ${a.steps}` : ''}`;
    return {
      html: `<div class="v texp aexp" style="--ac:${rgb}">
        <div class="atint"></div>
        <div class="row" style="gap:12px">
          <span class="alogo">${esc(name[0])}</span>
          <div class="sp"><div class="f15 ell">${esc(a.project || name)}</div><div class="d f12 ell">${esc(name)}${a.title ? ' · ' + esc(a.title) : ''}</div></div>
          ${done ? (err ? '<span class="astate" style="color:#ff6b6b">Error</span>' : `<span class="astate" style="color:#30d158">${check(14)} Done</span>`) : `<span class="astate">${spinner(14)} Working</span>`}
          <button class="x" data-act="hideAgent" aria-label="Hide until its next task" title="Hide until its next task">${I.close}</button>
        </div>
        <div class="abody${right ? '' : ' solo'}">
          <div class="col" style="gap:8px;min-width:0">
            <div class="aclock tn" data-bind="${done ? '' : 'agentClock'}" data-since="${a.startedAt}">${fmtClock(elapsed)}</div>
            <div class="f14" style="color:rgba(255,255,255,.75)">${esc(sub)}</div>
            ${!done ? `<div class="d f13 ell">${esc(a.step || 'Thinking')}</div>` : ''}
          </div>
          ${right}
        </div>
        ${done && a.answer ? `<div class="aanswer">${esc(a.answer)}</div>` : ''}
        ${script ? '' : `<div class="astages">${bars}</div>`}
        ${others ? `<div class="srclist">${others}</div>` : ''}
      </div>`,
      radius: 34,
    };
  },

  hud() {
    const h = state.hud;
    const batt = (pct, color) => `<svg width="32" height="16" viewBox="0 0 32 16"><rect x=".75" y=".75" width="27" height="14.5" rx="4.5" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.5"/><rect x="3" y="3" width="${Math.max(2, 22.5 * pct / 100)}" height="10" rx="2.5" fill="${color}"/><rect x="29" y="5.5" width="2.4" height="5" rx="1.2" fill="rgba(255,255,255,.4)"/></svg>`;
    let inner;
    if (h.kind === 'volume' || h.kind === 'brightness') {
      const vol = h.kind === 'volume';
      const pct = vol && h.muted ? 0 : h.value;
      inner = `${vol ? I.speaker(h.muted, h.value) : I.sun}
        <div class="hudbar"><b data-bind="hudbar" style="width:${pct}%;${vol ? '' : 'background:#ffd60a'}"></b></div>
        <span class="f13 tn" style="font-weight:600;width:30px;text-align:right" data-bind="hudnum">${vol && h.muted ? 'Mute' : h.value}</span>`;
      return { html: `<div class="v hudv" style="width:340px">${inner}</div>`, radius: 23 };
    }
    if (h.kind === 'caps') inner = `${I.caps}<span class="f13" style="font-weight:600">Caps Lock ${h.on ? 'on' : 'off'}</span>`;
    if (h.kind === 'charge') {
      inner = h.charging
        ? `${I.bolt}<span class="f14" style="font-weight:600">Charging</span><span class="sp"></span><span class="f14" style="font-weight:600;color:#30d158">${h.percent}%</span>${batt(h.percent, '#30d158')}`
        : `${I.plug}<span class="f14" style="font-weight:600">On battery</span><span class="sp"></span><span class="f14" style="font-weight:600">${h.percent}%</span>${batt(h.percent, h.percent <= 15 ? '#ff453a' : '#fff')}`;
      return { html: `<div class="v hudv" style="width:300px">${inner}</div>`, radius: 23 };
    }
    return { html: `<div class="v hudv">${inner}</div>`, radius: 23 };
  },

  lowBattery() {
    const b = state.battery || { percent: 0 };
    return {
      html: `<div class="v alert" style="gap:12px">
        <svg width="32" height="16" viewBox="0 0 32 16"><rect x=".75" y=".75" width="27" height="14.5" rx="4.5" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.5"/><rect x="3" y="3" width="${Math.max(2, 22.5 * b.percent / 100)}" height="10" rx="2.5" fill="#ff453a"/><rect x="29" y="5.5" width="2.4" height="5" rx="1.2" fill="rgba(255,255,255,.4)"/></svg>
        <span class="f14"><b>Battery low</b> <span style="color:#ff6961">· ${b.percent}%</span></span>
        <span class="d f12">Plug in soon</span>
        <button class="btn sm" data-act="dismissLow">Dismiss</button>
      </div>`,
      radius: 29,
      ring: { color: '#ff453a', rgb: '255,69,58' },
    };
  },

  mediaCompact() {
    return {
      html: `<div class="v mcompact">
        <div class="art" style="width:26px;height:26px;border-radius:8px;${artStyle()}${mediaPlaying() ? '' : ';opacity:.45;filter:grayscale(.5)'}">${artInner()}</div>
        ${mediaPlaying() ? eq() : `<span style="color:rgba(255,255,255,.6);display:flex">${I.pause(14)}</span>`}
      </div>`,
      radius: 19,
    };
  },

  mediaPeek() {
    const m = state.media;
    return {
      html: `<div class="v mpeek">
        <div class="art" style="width:46px;height:46px;border-radius:13px;${artStyle()}">${artInner()}</div>
        <div class="sp"><div class="f12" style="font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgb(var(--mc))">Now playing</div>
          <div class="f15 ell" style="margin-top:2px">${esc(m.title)}</div><div class="d f12 ell">${esc(m.artist)}</div></div>
        ${eq()}
      </div>`,
      radius: 32,
    };
  },

  mediaExpanded() {
    const m = state.media;
    const src = sourceInfo(m.source);
    const pos = mediaPos(), dur = m.duration || 0;
    const many = (m.sessions || []).length > 1;
    const sources = state.showSources && many ? `
      <div class="srclist">${m.sessions.map((s) => {
        const si = sourceInfo(s.id);
        return `<button class="srcrow${s.id === m.source ? ' on' : ''}" data-act="select" data-arg="${esc(s.id)}">
          <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${si.color}"></span>
          <span class="f13 sp" style="font-weight:600">${esc(si.name)}</span><span class="d f12">${esc(s.status)}</span></button>`;
      }).join('')}</div>` : '';
    // Three parts: the big cover alone on the left; on the right, lyrics on top and the song with its controls below.
    const lyr = state.lyricsOpen && prefs.lyrics !== false;
    return {
      html: `<div class="v mexp${lyr ? ' withlyr' : ''}">
        <div class="tint"></div>
        <div class="mgrid">
          <div class="art mcover" style="${artStyle()}">${artInner()}</div>
          <div class="mright">
            <div class="row" style="gap:8px">
              <${many ? 'button' : 'span'} class="src" ${many ? 'data-act="sources"' : ''}><span style="width:7px;height:7px;border-radius:50%;background:${src.color}"></span>${esc(src.name)}${many ? ' ▾' : ''}</${many ? 'button' : 'span'}>
              <span class="sp"></span>
              ${prefs.lyrics !== false ? `<button class="lyrbtn${lyr ? ' on' : ''}" data-act="lyrics" aria-label="Lyrics" title="Lyrics">${I.lyrics}</button>` : ''}
              <button class="x" data-act="hideMedia" aria-label="Hide until something else plays" title="Hide until something else plays">${I.close}</button>
            </div>
            ${lyr ? lyricsDrawer() : `<div class="mtitle">
              <div class="ttl big">${esc(m.title || 'Unknown title')}</div>
              <div class="m f15 ell" style="font-weight:500;margin-top:6px">${esc(m.artist)}</div>
              ${m.album ? `<div class="d f13 ell" style="margin-top:3px">${esc(m.album)}</div>` : ''}</div>`}
            <div class="mbottom">
              ${lyr ? `<div class="row" style="gap:8px;min-width:0"><span class="f14 ell" style="font-weight:700">${esc(m.title || 'Unknown title')}</span><span class="d f13 ell">${esc(m.artist)}</span></div>` : ''}
              ${dur > 0 ? `<div>
                <div class="seek" data-seek="1" ${m.canSeek ? '' : 'style="cursor:default"'}><div class="line"><b data-bind="mbar" style="width:${(pos / dur) * 100}%"></b></div></div>
                <div class="times"><span data-bind="mpos">${fmtTrack(pos)}</span><span data-bind="mrem">−${fmtTrack(dur - pos)}</span></div>
              </div>` : ''}
              <div class="row" style="justify-content:center;gap:18px">
                <button class="ctl" data-act="media" data-arg="prev" aria-label="Previous" ${m.canPrev ? '' : 'disabled'}>${I.prev(28)}</button>
                <button class="ctl pl" data-act="media" data-arg="toggle" aria-label="Play or pause">${mediaPlaying() ? I.pause(26) : I.play(26)}</button>
                <button class="ctl" data-act="media" data-arg="next" aria-label="Next" ${m.canNext ? '' : 'disabled'}>${I.next(28)}</button>
              </div>
            </div>
          </div>
        </div>
        ${sources}
      </div>`,
      radius: 36,
    };
  },
};

/* What the island shows when nobody is interacting with it. */
function baseView() {
  if (state.hud) return 'hud';
  if (state.timer && state.timer.done) return 'timerDone';
  if (state.approvals.length) return 'agentAlert';
  if (state.lowBattery) return 'lowBattery';
  if (state.fullscreen && prefs.hideFullscreen) return 'none'; // full-screen video or game: stay out of the way, alerts only
  if (primaryAgent()) return 'agentCompact';
  if (mediaVisible()) return 'mediaCompact';
  if (state.timer) return 'timerCompact';
  return 'none';
}
const RESTING = new Set(['none', 'mediaCompact', 'timerCompact', 'timerDone', 'mediaPeek', 'agentCompact', 'agentAlert', 'hud', 'lowBattery']);
const CLOSABLE = new Set(['sheet', 'timerSetup', 'timerExpanded', 'mediaExpanded', 'agentExpanded', 'approvalExpanded']);

/* ---------------- rendering ---------------- */
let hideTimer = null;
let lastHtml = '';

function render(name, { animate } = {}) {
  const changed = name !== state.view;
  state.view = name;
  if (changed) viewChangedAt = Date.now();
  const v = views[name]();

  clearTimeout(hideTimer);
  if (!v) {
    island.classList.add('gone');
    island.classList.remove('ring', 'pulse');
    // After fading out, shrink back to the lip size so the next opening grows in one smooth motion.
    hideTimer = setTimeout(() => {
      if (state.view !== 'none') return;
      snapSize(LIP.w, LIP.h, LIP.r);
      sendRects();
    }, 260);
    updateBubble();
    return;
  }

  const prevHtml = lastHtml;
  lastHtml = v.html;
  measurer.innerHTML = v.html;
  const root = measurer.firstElementChild;
  // Round up, so text is never cut by a fraction of a pixel ("Claude Co…").
  const box = root.getBoundingClientRect(), w = Math.ceil(box.width), h = Math.ceil(box.height);

  if (island.classList.contains('gone')) {
    // Coming back from hidden: start from the small lip, never from the last panel size.
    snapSize(LIP.w, LIP.h, LIP.r);
    island.classList.remove('gone');
  }
  island.classList.toggle('ring', !!v.ring);
  island.classList.toggle('pulse', !!v.ring);
  if (v.ring) {
    island.style.setProperty('--rc', v.ring.color);
    island.style.setProperty('--rgb', v.ring.rgb);
  }
  island.style.width = w + 'px';
  island.style.height = h + 'px';
  island.style.setProperty('--r', (v.radius || Math.min(34, h / 2)) + 'px');

  // Same screen with only some words or numbers changed (the next agent step, the next song...): update just
  // those in place, so the spinner keeps turning and nothing else blinks.
  if (!changed && !animate && prevHtml !== v.html && patchInPlace(content, v.html)) {
    island.classList.add('calm');
    updateBubble();
    trackRects(650);
    return;
  }
  content.innerHTML = v.html;
  if (changed || animate) {
    content.classList.remove('enter', 'soft');
    void content.offsetWidth; // restart the fade-in
    content.classList.add('enter');
    island.classList.remove('calm');
  } else if (prevHtml !== v.html) {
    // Same screen, new details (the next agent step, a new song...): a gentle fade, and a calm resize
    // without the bouncy spring used for opening and closing panels.
    content.classList.remove('enter', 'soft');
    void content.offsetWidth;
    content.classList.add('soft');
    island.classList.add('calm');
  }
  updateBubble();
  trackRects(650);
}

/* Update `root` to match `html` without rebuilding it, when only text and attributes differ.
 * Returns false (and changes nothing) if the structure is different. Changed text gets a short fade. */
function patchInPlace(root, html) {
  const tpl = document.createElement('div');
  tpl.innerHTML = html;
  const same = (a, b) => {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName || a.childNodes.length !== b.childNodes.length) return false;
    for (let i = 0; i < a.childNodes.length; i++) if (!same(a.childNodes[i], b.childNodes[i])) return false;
    return true;
  };
  if (!same(root, tpl)) return false;
  const faded = new Set();
  const apply = (a, b) => {
    if (a.nodeType === 3) {
      if (a.nodeValue !== b.nodeValue) {
        a.nodeValue = b.nodeValue;
        const p = a.parentElement;
        // Live counters (elapsed time, positions) just change; words fade in.
        if (p && !p.closest('[data-bind]') && !faded.has(p)) { faded.add(p); p.classList.remove('tfade'); void p.offsetWidth; p.classList.add('tfade'); }
      }
      return;
    }
    if (a.nodeType !== 1) return;
    for (const at of [...a.attributes]) if (!b.hasAttribute(at.name) && at.name !== 'class') a.removeAttribute(at.name);
    for (const at of [...b.attributes]) {
      if (at.name === 'class') { const keep = a.classList.contains('tfade'); if (a.getAttribute('class') !== at.value) { a.setAttribute('class', at.value); if (keep) a.classList.add('tfade'); } continue; }
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    }
    for (let i = 0; i < a.childNodes.length; i++) apply(a.childNodes[i], b.childNodes[i]);
  };
  apply(root, tpl);
  return true;
}

function snapSize(w, h, r) {
  island.style.transition = 'none';
  island.style.width = w + 'px';
  island.style.height = h + 'px';
  island.style.setProperty('--r', r + 'px');
  void island.offsetWidth;
  island.style.transition = '';
}

/* The small second island: a running timer next to the music. */
/* Two things at once: the main island shows one activity, a small bubble beside it shows the other.
 * Music gets the bubble while an agent, a call, Focus or the stopwatch holds the island; a timer gets it otherwise. */
const SIDE_HOSTS = ['agentCompact', 'agentAlert', 'callCompact', 'focusCompact', 'swCompact', 'timerCompact'];
function bubbleKind() {
  if (SIDE_HOSTS.includes(state.view) && mediaVisible() && state.media && state.media.active) return 'media';
  if (state.timer && !state.timer.done && ['mediaCompact', 'mediaPeek', 'agentCompact', 'agentAlert', 'callCompact'].includes(state.view)) return 'timer';
  return '';
}
function bubbleWanted() { return !!bubbleKind(); }
function updateBubble() {
  const kind = bubbleKind(), want = !!kind;
  if (kind === 'timer') {
    const t = state.timer, left = timeLeft();
    bubble.innerHTML = `${ring(18, 3, left / t.total, '255,159,10')}<span class="f13 tn" style="font-weight:600;color:#ff9f0a" data-bind="left">${fmt(left)}</span>`;
  } else if (kind === 'media') {
    const html = `<div class="art" style="width:24px;height:24px;border-radius:7px;${artStyle()}${mediaPlaying() ? '' : ';opacity:.45;filter:grayscale(.5)'}">${artInner()}</div>${mediaPlaying() ? eq() : `<span style="color:rgba(255,255,255,.6);display:flex">${I.pause(13)}</span>`}`;
    if (bubble.dataset.html !== html) { bubble.innerHTML = html; bubble.dataset.html = html; } // don't restart the bars
  }
  if (kind !== 'media') bubble.dataset.html = '';
  bubble.dataset.kind = kind;
  bubble.classList.toggle('gone', !want);
  positionBubble();
  trackRects(1100);
}
function positionBubble() {
  const r = island.getBoundingClientRect();
  bubble.style.left = (r.right + 16 + 10 + 16) + 'px'; // shoulder + gap + its own shoulder
}

/* Tell the main process which areas take clicks. Followed every frame while sizes animate. */
let lastRects = '';
function sendRects() {
  const rects = [];
  const add = (el) => {
    const r = el.getBoundingClientRect();
    rects.push({ x: r.left - SHOULDER - PAD_SIDE, y: 0, w: r.width + 2 * (SHOULDER + PAD_SIDE), h: r.bottom + PAD_BOTTOM });
  };
  if (state.view !== 'none') add(island);
  if (bubbleWanted()) add(bubble);
  const key = JSON.stringify(rects);
  if (key === lastRects) return;
  lastRects = key;
  post({ type: 'rects', rects });
}
let trackUntil = 0;
function trackRects(ms) {
  const idle = trackUntil < performance.now();
  trackUntil = Math.max(trackUntil, performance.now() + ms);
  if (!idle) return;
  const step = () => {
    positionBubble();
    sendRects();
    if (performance.now() < trackUntil) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* Update ticking numbers in place (no re-render, no flicker). */
function tick() {
  const t = state.timer;
  if (t && !t.done && t.pausedLeft == null && timeLeft() <= 0) return finishTimer();
  const left = timeLeft();
  document.querySelectorAll('[data-bind="left"]').forEach((e) => { e.textContent = fmt(left); });
  document.querySelectorAll('[data-ring]').forEach((e) => {
    const c = +e.dataset.ring;
    e.setAttribute('stroke-dashoffset', t ? c * (1 - Math.max(0, left) / t.total) : c);
  });
  const clock = document.querySelector('[data-bind="clock"]');
  if (clock) clock.textContent = clockText();

  const m = state.media;
  if (m && m.duration > 0 && !dragging) {
    const pos = mediaPos();
    const bar = document.querySelector('[data-bind="mbar"]');
    if (bar) bar.style.width = (pos / m.duration) * 100 + '%';
    const p = document.querySelector('[data-bind="mpos"]'); if (p) p.textContent = fmtTrack(pos);
    const r = document.querySelector('[data-bind="mrem"]'); if (r) r.textContent = '−' + fmtTrack(m.duration - pos);
  }
  manageViz();
  document.querySelectorAll('[data-bind="agentElapsed"]').forEach((e) => { e.textContent = fmtDur(Date.now() - +e.dataset.since); });
  document.querySelectorAll('[data-bind="agentClock"]').forEach((e) => { e.textContent = fmtClock(Date.now() - +e.dataset.since); });
  // A paused song, or a finished agent, disappears from the island after a while.
  if (state.view === 'mediaCompact' && !mediaVisible()) render(baseView());
  // Safety net: an agent that has said nothing for 10 minutes has most likely stopped without telling us
  // (closed terminal, crash). Stop showing it as working; it comes back with its next step.
  const nowMs = Date.now();
  for (const a of state.agents.values()) {
    if ((a.status === 'working' || a.status === 'waiting') && nowMs - (a.updated || 0) > 10 * 60 * 1000) a.status = 'idle';
  }
  if (state.view === 'agentCompact' && !primaryAgent()) render(baseView());
}
setInterval(tick, 250);

/* ---------------- live sound bars (follow the real audio) ----------------
 * Listens to the PC's sound output (Windows "loopback"), splits it into 5 frequency bands
 * (bass on the left, treble on the right) and moves the bars with them. Runs only while
 * something is playing; if listening isn't possible, the bars fall back to a gentle animation. */
const viz = { stream: null, ctx: null, analyser: null, data: null, raf: 0, starting: false, failedAt: 0, quietSince: 0, lv: Array(7).fill(0), peak: Array(7).fill(1), prev: Array(7).fill(0), last: 0 };
// Seven bands from bass to treble, spaced like hearing (analyser bins are ~94 Hz each).
const BANDS = [[1, 2], [2, 4], [4, 7], [7, 12], [12, 22], [22, 45], [45, 110]];

async function startViz() {
  if (viz.stream || viz.starting || Date.now() - viz.failedAt < 60000 || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return;
  viz.starting = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1, frameRate: 1 } });
    stream.getVideoTracks().forEach((t) => t.stop()); // only the sound is used
    if (!stream.getAudioTracks().length) throw new Error('no audio track');
    viz.stream = stream;
    viz.ctx = new AudioContext();
    viz.analyser = viz.ctx.createAnalyser();
    viz.analyser.fftSize = 512;
    viz.analyser.smoothingTimeConstant = 0.25; // little smoothing: the bars follow the beat
    viz.ctx.createMediaStreamSource(stream).connect(viz.analyser);
    viz.data = new Uint8Array(viz.analyser.frequencyBinCount);
    document.body.classList.add('liveviz');
    vizLoop();
  } catch (e) {
    viz.failedAt = Date.now();
    post({ type: 'log', text: 'sound bars: ' + e.message });
  }
  viz.starting = false;
}

function stopViz() {
  cancelAnimationFrame(viz.raf);
  if (viz.stream) viz.stream.getTracks().forEach((t) => t.stop());
  if (viz.ctx) viz.ctx.close().catch(() => {});
  viz.stream = viz.ctx = viz.analyser = null;
  document.body.classList.remove('liveviz');
}

function vizLoop(t = 0) {
  viz.raf = requestAnimationFrame(vizLoop);
  viz.last = t;
  viz.analyser.getByteFrequencyData(viz.data);
  BANDS.forEach(([a, b], i) => {
    let sum = 0;
    for (let k = a; k < b; k++) sum += viz.data[k];
    const raw = sum / (b - a) / 255;
    // Auto-gain per band: compare with a slowly falling recent peak, so quiet and loud songs both move.
    viz.peak[i] = Math.max(raw, viz.peak[i] * 0.985, 0.06);
    let target = Math.min(1, raw / viz.peak[i]) * (raw > 0.015 ? 1 : 0);
    // A sudden rise (a beat, a drum hit) kicks the bar a little higher.
    target = Math.min(1, target + Math.max(0, raw - viz.prev[i]) * 3);
    viz.prev[i] = raw;
    // Snap up, fall back quickly: lively like a real meter.
    viz.lv[i] += (target - viz.lv[i]) * (target > viz.lv[i] ? 0.85 : 0.32);
  });
  const bars = document.querySelectorAll('.eq i');
  bars.forEach((el, j) => { el.style.transform = `scaleY(${(0.12 + 0.88 * viz.lv[j % 7]).toFixed(3)})`; });
}

/* Start listening while music plays; stop after it has been quiet for a while (saves CPU). */
function manageViz() {
  if (mediaPlaying() && document.querySelector('.eq:not(.off)')) { viz.quietSince = 0; startViz(); }
  else if (viz.stream) {
    viz.quietSince = viz.quietSince || Date.now();
    if (Date.now() - viz.quietSince > 15000) stopViz();
  }
}

/* ---------------- sound ---------------- */
let audio = null, chimeLoop = null;
function unlockAudio() {
  try { audio = audio || new AudioContext(); if (audio.state === 'suspended') audio.resume(); } catch { /* no audio */ }
}
function chime() {
  if (!prefs.chimes) return;
  unlockAudio();
  if (!audio) return;
  const t0 = audio.currentTime;
  [880, 1175, 1568].forEach((f, i) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + i * 0.14);
    g.gain.linearRampToValueAtTime(0.18, t0 + i * 0.14 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.14 + 0.5);
    o.connect(g).connect(audio.destination);
    o.start(t0 + i * 0.14); o.stop(t0 + i * 0.14 + 0.55);
  });
}

/* ---------------- timer ---------------- */
function startTimer(sec) {
  unlockAudio();
  state.timer = { total: sec, endAt: Date.now() + sec * 1000, pausedLeft: null, done: false };
  render(baseView());
}
function finishTimer() {
  state.timer.done = true;
  state.timer.pausedLeft = 0;
  if (!CLOSABLE.has(state.view) || state.view === 'timerExpanded') render('timerDone');
  else updateBubble();
  chime();
  let n = 0;
  clearInterval(chimeLoop);
  chimeLoop = setInterval(() => { if (++n > 30 || !state.timer || !state.timer.done) return clearInterval(chimeLoop); chime(); }, 2000);
}
function clearTimer() {
  clearInterval(chimeLoop);
  state.timer = null;
}

/* ---------------- media updates ---------------- */
let peekTimer = null;
/* Missing covers (browsers often send none, or just their own logo): look the song up online once and use that.
 * The found cover stays for this song even though the browser keeps sending its logo. */
state.found = null; // { key, from: what the app sent, url }
function findCover(m) {
  if (!host || prefs.findCovers === false || !m || !m.title || m.readOnly) return;
  const key = mediaKey(m);
  if (state.found && state.found.key === key) return;
  state.found = { key, from: m.art || null, url: null };
  host.invoke('cover', { title: m.title, artist: m.artist, album: m.album, duration: m.duration }).then((url) => {
    if (!url || !state.found || state.found.key !== key) return;
    state.found.url = url;
    if (state.media && mediaKey(state.media) === key) onMedia({ ...state.media, art: state.found.from }); // re-apply with the cover
  });
}
let mediaGoneTimer = null;
function onMedia(m) {
  // While the player is open, a moment of "nothing playing" (between songs) keeps showing the last song.
  if (!m.active && state.view === 'mediaExpanded' && state.media && state.media.active) {
    clearTimeout(mediaGoneTimer);
    const last = state.media;
    mediaGoneTimer = setTimeout(() => { if (state.media === last) { state.media = m; if (state.view === 'mediaExpanded') render(baseView()); } }, 3000);
    return;
  }
  if (state.found && state.found.url && state.found.key === mediaKey(m) && (m.art || null) === state.found.from) m = { ...m, art: state.found.url, foundArt: true };
  else if (m.active && !m.art) findCover(m);
  const prev = state.media;
  const newTrack = mediaKey(m) !== mediaKey(prev);
  if (m.active && m.status === 'Paused' && !(prev && prev.status === 'Paused' && !newTrack)) state.pausedSince = Date.now();
  if (m.art && (!prev || prev.art !== m.art)) { state.mediaArtOk = undefined; extractColor(m.art); }
  if (!m.art && newTrack) document.documentElement.style.setProperty('--mc', state.mediaColor = '255,138,92');
  const shown = (x) => (x ? JSON.stringify([x.active, x.source, x.title, x.artist, x.album, x.status, x.canNext, x.canPrev, x.canSeek,
    (x.art || '').length, (x.sessions || []).map((s) => s.id + s.status).join(), x.duration > 0]) : '');
  const sameLook = shown(m) === shown(prev);
  state.media = m;
  if (!sameLook) updateBubble(); // the music in the side bubble (new song, paused...)
  // Only the play position moved: the 250 ms tick already draws that, so don't re-render.
  if (sameLook) return;

  // New song while resting: announce it for 3 seconds (not over a full-screen app, not if you hid this one).
  if (newTrack && m.active && m.status === 'Playing' && m.title && prefs.mediaPeek && !(state.fullscreen && prefs.hideFullscreen) && mediaVisible()
      && RESTING.has(state.view) && state.view !== 'timerDone' && state.view !== 'agentAlert') {
    render('mediaPeek');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => { if (state.view === 'mediaPeek') render(baseView()); }, 3000);
    return;
  }
  if (state.view === 'mediaPeek') return;
  if (RESTING.has(state.view)) {
    const want = baseView();
    if (want !== state.view || want === 'mediaCompact') render(want);
  } else if (state.view === 'mediaExpanded') {
    // Skipping a song in a browser briefly reports "nothing playing": keep the player open, and close only if
    // nothing has started again 3 seconds later.
    clearTimeout(mediaGoneTimer);
    if (!m.active) mediaGoneTimer = setTimeout(() => { if (state.view === 'mediaExpanded' && !(state.media && state.media.active)) render(baseView()); }, 3000);
    else render('mediaExpanded');
  } else if (state.view === 'sheet') {
    render('sheet');
  }
}

/* ---------------- system pop-ups ---------------- */
let hudTimer = null;
function showHud(h) {
  if (CLOSABLE.has(state.view)) return; // never cover a panel you're using
  const sameBar = state.view === 'hud' && state.hud && state.hud.kind === h.kind
    && (h.kind === 'volume' || h.kind === 'brightness') && !!state.hud.muted === !!h.muted;
  state.hud = h;
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { state.hud = null; render(baseView()); }, HUD_MS);
  if (sameBar) {
    // Holding the volume key: just slide the bar, don't redraw the pop-up.
    const bar = document.querySelector('[data-bind="hudbar"]'); if (bar) bar.style.width = h.value + '%';
    const num = document.querySelector('[data-bind="hudnum"]'); if (num) num.textContent = h.value;
  } else {
    render('hud');
  }
}

function onSys(m) {
  const prev = state.sys;
  state.sys = m;
  if (!prev) return; // first reading: nothing changed yet
  if (m.volume >= 0 && (m.volume !== prev.volume || m.muted !== prev.muted)) { if (prefs.hudVolume) showHud({ kind: 'volume', value: m.volume, muted: m.muted }); }
  else if (m.brightness >= 0 && m.brightness !== prev.brightness) { if (prefs.hudBrightness) showHud({ kind: 'brightness', value: m.brightness }); }
  else if (m.caps !== prev.caps) { if (prefs.hudCaps) showHud({ kind: 'caps', on: m.caps }); }
}

function onBattery(b, prev) {
  if (prefs.hudBattery && prev && b.has && b.charging !== prev.charging) showHud({ kind: 'charge', charging: b.charging, percent: b.percent });
  if (!prefs.hudBattery || !b.has || b.charging) { state.lowBattery = false; state.lowBatteryShown = 0; }
  else if (b.percent <= 5 && state.lowBatteryShown !== 5) { state.lowBattery = true; state.lowBatteryShown = 5; alertChime(); }
  else if (b.percent <= 15 && b.percent > 5 && !state.lowBatteryShown) { state.lowBattery = true; state.lowBatteryShown = 15; alertChime(); }
  refreshResting();
}

/* ---------------- agent stages and the code being changed (for the expanded agent panel) ---------------- */
const STAGES = ['Read', 'Edit', 'Test', 'Done'];
const STAGE_TEXT = ['Looking around', 'Making changes', 'Testing', 'Done'];
function stageOf(tool) {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return 1;
  if (/^(Bash|PowerShell|BashOutput)$/.test(tool)) return 2;
  if (/^(Read|NotebookRead|Grep|Glob|LS|Task|Agent)$/.test(tool) || /^Web/.test(tool)) return 0;
  return -1;
}
// First lines of an edit: what was there and what replaces it.
function diffOf(tool, input = {}) {
  const file = input.file_path || input.notebook_path || input.path || '';
  let oldS = input.old_string, newS = input.new_string;
  if (Array.isArray(input.edits) && input.edits[0]) { oldS = input.edits[0].old_string; newS = input.edits[0].new_string; }
  if (/^Write$/.test(tool) && typeof input.content === 'string') { oldS = ''; newS = input.content; }
  if (typeof newS !== 'string' && typeof oldS !== 'string') return null;
  const lines = (s) => String(s || '').replace(/\r/g, '').split('\n').filter((l, i, arr) => l.trim() || (i > 0 && i < arr.length - 1));
  const o = lines(oldS), n = lines(newS);
  // Drop the lines both sides share at the start, so the change itself shows.
  let k = 0; while (k < o.length - 1 && k < n.length - 1 && o[k] === n[k]) k++;
  return { file: baseName(file), old: o.slice(k, k + 3), new: n.slice(k, k + 3), more: Math.max(o.length, n.length) - k > 3, isNew: /^Write$/.test(tool) };
}
function trackStage(a, ev) {
  const name = ev.hook_event_name;
  if (name === 'UserPromptSubmit') { a.stage = 0; a.stages = [0]; a.steps = 0; a.diff = null; return; }
  if (!a.stages) a.stages = [];
  if (/^(PreToolUse|PermissionRequest)$/.test(name) || (a.agent === 'cursor' && /^PostToolUse/.test(name))) {
    const s = stageOf(ev.tool_name);
    if (name !== 'PermissionRequest') a.steps = (a.steps || 0) + 1;
    if (s >= 0) { a.stage = s; if (!a.stages.includes(s)) a.stages.push(s); }
    const d = s === 1 ? diffOf(ev.tool_name, ev.tool_input) : null;
    if (d) { d.at = Date.now(); d.live = true; a.diff = d; }
  }
  if (/^PostToolUse/.test(name) && a.diff && a.diff.live && stageOf(ev.tool_name) === 1) a.diff.live = false;
  if (/^(Stop|TurnComplete|Notification)$/.test(name) && a.status === 'done') { a.stage = 3; a.stages = [0, 1, 2, 3]; if (a.diff) a.diff.live = false; }
}
const AGENT_COLORS = { 'claude-code': '217,119,87', codex: '16,163,127', gemini: '76,141,246', copilot: '163,113,247', cursor: '200,200,210' };
const agentRgb = (a) => AGENT_COLORS[a.agent] || (a.color ? hexToRgb(a.color) : '76,156,255');
function hexToRgb(h) { const m = String(h).match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)).join(',') : '76,156,255'; }
const LANG = { js: 'JS', mjs: 'JS', cjs: 'JS', ts: 'TS', tsx: 'TSX', jsx: 'JSX', py: 'PY', css: 'CSS', html: 'HTML', json: 'JSON', md: 'MD', ps1: 'PS', cs: 'C#', go: 'GO', rs: 'RS', java: 'JV', rb: 'RB', php: 'PHP', sh: 'SH', yml: 'YML', yaml: 'YML', toml: 'TOML', sql: 'SQL', c: 'C', cpp: 'C++', h: 'H', swift: 'SW', kt: 'KT' };
const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`; };

/* ---------------- agent updates ---------------- */
function onAgentEvent(ev, fromPermission) {
  if (!ev || !ev.session_id) return;
  const now = Date.now();
  let a = state.agents.get(ev.session_id);
  if (!a) {
    a = { id: ev.session_id, agent: ev.agent || 'claude-code', project: baseName(ev.cwd), title: '', status: 'idle', step: '', startedAt: now, doneAt: 0, feed: [], answer: '' };
    state.agents.set(ev.session_id, a);
  }
  a.updated = now;
  if (ev.cwd) a.project = baseName(ev.cwd);
  if (ev.session_title) a.title = ev.session_title;
  // Scripts and other programs name themselves (--name) and may pick a colour.
  if (ev.agent_name) a.agentName = String(ev.agent_name).slice(0, 40);
  if (ev.color && /^#?[\da-f]{6}$/i.test(ev.color)) a.color = ev.color.startsWith('#') ? ev.color : '#' + ev.color;
  const wasDone = a.status === 'done';

  switch (ev.hook_event_name) {
    case 'UserPromptSubmit':
      state.dismissedAgents.delete(a.id);
      a.status = 'working'; a.startedAt = now; a.doneAt = 0; a.feed = []; a.answer = ''; a.step = 'Thinking';
      if (!ev.session_title && ev.prompt) a.title = ev.prompt.split('\n')[0];
      break;
    case 'PreToolUse':
    case 'PermissionRequest':
      if (a.status !== 'working') { a.status = 'working'; if (wasDone || !a.startedAt) a.startedAt = now; }
      a.step = describeStep(ev.tool_name, ev.tool_input);
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (a.status !== 'working') { a.status = 'working'; if (wasDone || !a.startedAt) a.startedAt = now; }
      a.feed.push({ tool: ev.tool_name, text: feedText(ev.tool_name, ev.tool_input), failed: ev.hook_event_name === 'PostToolUseFailure' });
      if (a.feed.length > 30) a.feed.shift();
      // Cursor only reports a step after it's done, so show that step; others move on to "Thinking".
      a.step = a.agent === 'cursor' ? describeStep(ev.tool_name, ev.tool_input) : 'Thinking';
      break;
    case 'Step': // a script's own progress line (--event step --text ...)
      state.dismissedAgents.delete(a.id);
      if (a.status !== 'working') { a.status = 'working'; if (wasDone || !a.startedAt) a.startedAt = now; }
      a.step = ev.message || 'Working';
      a.feed.push({ tool: 'Step', text: a.step }); if (a.feed.length > 30) a.feed.shift();
      break;
    case 'Attention': // the agent is waiting for you in its own window (Gemini permission prompts)
      a.status = 'waiting'; a.step = ev.message || 'Waiting for you';
      if (!a.startedAt) a.startedAt = now;
      alertChime();
      break;
    case 'Stop':
      if (a.status === 'working' || a.status === 'waiting') { a.status = 'done'; a.doneAt = now; a.answer = ev.last_assistant_message || ''; doneChime(); }
      break;
    case 'StopFailure': // Claude Code stopped because of an error (API error, usage limit...)
      if (a.status === 'working' || a.status === 'waiting') {
        a.status = 'error'; a.doneAt = now;
        a.answer = ev.message || ev.last_assistant_message || 'Stopped because of an error.';
        alertChime();
      }
      break;
    case 'Notification': // Claude Code: "waiting for your next message" means this turn is over
      if (ev.notification_type === 'idle_prompt' && (a.status === 'working' || a.status === 'waiting')) {
        a.status = 'done'; a.doneAt = now;
      }
      break;
    case 'TurnComplete': // Codex only says when a turn has finished
      a.status = 'done'; a.startedAt = a.startedAt || now; a.doneAt = now;
      if (ev.prompt) a.title = String(ev.prompt).split('\n')[0];
      a.answer = ev.last_assistant_message || '';
      doneChime();
      break;
    case 'SessionEnd':
      state.agents.delete(ev.session_id);
      state.approvals = state.approvals.filter((r) => r.session !== ev.session_id);
      break;
  }
  trackStage(a, ev);
  if (fromPermission) return; // caller re-renders after queueing the approval
  if (state.view === 'agentExpanded') render('agentExpanded');
  else refreshResting();
}

/* Re-draw the resting island when what it should show has changed (never interrupts an open panel). */
function refreshResting() {
  if (!RESTING.has(state.view) || state.view === 'mediaPeek') return;
  const want = baseView();
  if (want !== state.view || want === 'agentCompact' || want === 'agentAlert') render(want);
}

function alertChime() {
  if (!prefs.chimes) return;
  unlockAudio();
  if (!audio) return;
  const t0 = audio.currentTime;
  [660, 880].forEach((f, i) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + i * 0.16);
    g.gain.linearRampToValueAtTime(0.16, t0 + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.16 + 0.4);
    o.connect(g).connect(audio.destination);
    o.start(t0 + i * 0.16); o.stop(t0 + i * 0.16 + 0.45);
  });
}
function doneChime() {
  if (!prefs.chimes) return;
  unlockAudio();
  if (!audio) return;
  const t0 = audio.currentTime;
  [1046, 1318].forEach((f, i) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + i * 0.12);
    g.gain.linearRampToValueAtTime(0.12, t0 + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.12 + 0.6);
    o.connect(g).connect(audio.destination);
    o.start(t0 + i * 0.12); o.stop(t0 + i * 0.12 + 0.65);
  });
}

/* ---------------- actions ---------------- */
const actions = {
  tile(id) {
    const t = TILES.find((x) => x.id === id);
    if (t.ready) { state.soon = ''; if (id === 'timer') render(state.timer ? 'timerExpanded' : 'timerSetup'); }
    else { state.soon = `${t.name} is coming in a later build.`; render('sheet'); }
  },
  go(name) { render(name); },
  preset(m) { state.setupSec = m * 60; render('timerSetup'); },
  adjust(d) { state.setupSec = Math.min(24 * 3600, Math.max(60, state.setupSec + +d)); render('timerSetup'); },
  start() { startTimer(state.setupSec); },
  pause() { state.timer.pausedLeft = timeLeft(); render('timerExpanded'); },
  resume() { const t = state.timer; t.endAt = Date.now() + t.pausedLeft * 1000; t.pausedLeft = null; render('timerExpanded'); },
  addmin() {
    const t = state.timer; t.total += 60;
    if (t.pausedLeft != null) t.pausedLeft += 60; else t.endAt += 60000;
    render('timerExpanded');
  },
  cancel() { clearTimer(); render(baseView()); },
  stop() { clearTimer(); render(baseView()); },
  repeat() { const total = state.timer.total; clearTimer(); startTimer(total); },
  media(cmd) {
    post({ type: 'media-cmd', cmd });
    // Show the new state right away; the helper confirms a moment later.
    if (cmd === 'toggle' && state.media) {
      const m = state.media;
      if (m.status === 'Playing') { m.position = mediaPos(); m.status = 'Paused'; state.pausedSince = Date.now(); }
      else { m.status = 'Playing'; m.updatedAt = Date.now(); }
      render(state.view);
    }
  },
  sources() { state.showSources = !state.showSources; render('mediaExpanded'); },
  review() { render('approvalExpanded'); },
  decide(decision) {
    const req = state.approvals.shift();
    if (req) post({ type: 'agent-decision', reqId: req.reqId, decision });
    render(state.approvals.length ? 'approvalExpanded' : baseView());
  },
  focusAgent(id) { state.focusAgent = id; render('agentExpanded'); },
  dismissLow() { state.lowBattery = false; render(baseView()); },
  hideMedia() { state.dismissedMedia = mediaKey(state.media); clearTimeout(peekTimer); render(baseView()); },
  hideAgent() {
    const a = state.agents.get(state.focusAgent) || primaryAgent();
    if (a) state.dismissedAgents.add(a.id);
    render(baseView());
  },
  select(id) { state.showSources = false; post({ type: 'media-cmd', cmd: 'select ' + id }); },
};

content.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) { e.stopPropagation(); if (!el.disabled) actions[el.dataset.act](el.dataset.arg); return; }
  if (e.target.closest('[data-seek]')) return;
  // Clicking a resting island opens it.
  if (state.view === 'timerCompact') render('timerExpanded');
  else if (state.view === 'agentCompact') { state.focusAgent = (primaryAgent() || {}).id; render('agentExpanded'); }
  else if (state.view === 'agentAlert') render('approvalExpanded');
  else if (state.view === 'mediaCompact' || state.view === 'mediaPeek') { clearTimeout(peekTimer); render('mediaExpanded'); }
});
bubble.addEventListener('click', () => render(bubble.dataset.kind === 'media' ? 'mediaExpanded' : 'timerExpanded'));

/* Right-click a resting island to hide it. */
island.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.view === 'mediaCompact' || state.view === 'mediaPeek') actions.hideMedia();
  else if (state.view === 'agentCompact') { state.focusAgent = (primaryAgent() || {}).id; actions.hideAgent(); }
});

/* Seeking: click or drag on the progress line. */
let dragging = false;
function seekAt(e, el, commit) {
  const m = state.media;
  if (!m || !m.canSeek || !(m.duration > 0)) return;
  const r = el.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const sec = frac * m.duration;
  const bar = el.querySelector('b'); if (bar) bar.style.width = frac * 100 + '%';
  const p = document.querySelector('[data-bind="mpos"]'); if (p) p.textContent = fmtTrack(sec);
  if (commit) {
    m.position = sec; m.updatedAt = Date.now();
    post({ type: 'media-cmd', cmd: 'seek ' + sec.toFixed(1) });
  }
}
content.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-seek]');
  if (!el) return;
  dragging = true;
  el.setPointerCapture(e.pointerId);
  seekAt(e, el, false);
  const move = (ev) => seekAt(ev, el, false);
  const up = (ev) => { dragging = false; seekAt(ev, el, true); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
});

/* Closing open panels.
 * A panel closes only when the pointer is clearly away from it (more than CLOSE_MARGIN px outside its edge)
 * for a moment, never just because it crossed the edge. Panels change size (the sheet is 720 px wide,
 * Settings 520 px), which can leave the pointer outside the new, narrower panel; so for a while after a
 * panel changes, it waits longer before closing, giving you time to move onto it. */
let leaveTimer = null; // kept for the edge messages below
const pointer = { x: -1, y: -1, moved: false };
document.addEventListener('mousemove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = true; }, true);
let viewChangedAt = 0;
let awaySince = 0;
const CLOSE_MARGIN = 56;       // px of slack around the panel
const CLOSE_DELAY = 450;       // ms the pointer must stay away
const CLOSE_DELAY_AFTER_CHANGE = 1600; // ms, just after the panel changed size or content
const CHANGE_WINDOW = 2000;    // ms counted as "just changed"
function isTyping() {
  const a = document.activeElement;
  return !!(a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && content.contains(a));
}
setInterval(() => {
  // (The drop screen closes itself when the drag stops; see tools.js.)
  if (!CLOSABLE.has(state.view) || state.view === 'dropZone' || dragging || isTyping() || !pointer.moved) { awaySince = 0; return; }
  const r = island.getBoundingClientRect();
  const dx = Math.max(r.left - SHOULDER - pointer.x, 0, pointer.x - (r.right + SHOULDER));
  const dy = Math.max(0, pointer.y - r.bottom);
  if (Math.hypot(dx, dy) <= CLOSE_MARGIN) { awaySince = 0; return; }
  const now = Date.now();
  awaySince = awaySince || now;
  const delay = now - viewChangedAt < CHANGE_WINDOW ? CLOSE_DELAY_AFTER_CHANGE : CLOSE_DELAY;
  if (now - awaySince >= delay) {
    awaySince = 0;
    state.soon = ''; state.showSources = false;
    render(baseView());
  }
}, 100);

/* ---------------- messages from the main process ---------------- */
if (host) {
  host.onMessage((m) => {
    switch (m.type) {
      case 'edge-enter':
        if (state.view === 'none') render('lip');
        break;
      case 'edge-open':
        clearTimeout(leaveTimer);
        if (!CLOSABLE.has(state.view) && state.view !== 'timerDone') render('sheet');
        break;
      case 'edge-exit':
        if (state.view === 'lip') render(baseView());
        break;
      case 'media':
        onMedia(m);
        break;
      case 'sys':
        onSys(m);
        break;
      case 'fullscreen':
        state.fullscreen = !!m.on;
        refreshResting();
        break;
      case 'agent':
        onAgentEvent(m.event);
        break;
      case 'agent-permission':
        onAgentEvent(m.event, true);
        state.approvals.push({ reqId: m.reqId, session: m.event.session_id, tool: m.event.tool_name, input: m.event.tool_input || {} });
        alertChime();
        refreshResting();
        break;
      case 'agent-permission-gone':
        state.approvals = state.approvals.filter((a) => a.reqId !== m.reqId);
        if (state.view === 'approvalExpanded') render(state.approvals.length ? 'approvalExpanded' : baseView());
        else refreshResting();
        break;
    }
  });
}

/* Battery straight from Chromium. */
if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    const update = () => {
      // A desktop with no battery reports "charging, 100%, never discharging".
      const has = !(b.charging && b.level === 1 && b.dischargingTime === Infinity && b.chargingTime === 0);
      const prev = state.battery;
      state.battery = { has, percent: Math.round(b.level * 100), charging: b.charging };
      if (state.view === 'sheet') render('sheet');
      onBattery(state.battery, prev);
    };
    ['levelchange', 'chargingchange'].forEach((ev) => b.addEventListener(ev, update));
    update();
  });
}

snapSize(LIP.w, LIP.h, LIP.r);
render('none');
post({ type: 'ready' });

/* Opened in a normal browser (no Electron)? Show the sheet so the UI can be checked. */
// Opened in a normal browser (no Electron)? ui/demo.js shows a sample screen.

// The side bubble sits beside the island: place it again whenever the island finishes changing size.
island.addEventListener('transitionend', (e) => { if (e.target === island && /width|height/.test(e.propertyName)) { positionBubble(); sendRects(); } });
