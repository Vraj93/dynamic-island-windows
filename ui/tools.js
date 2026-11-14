'use strict';
/* Dynamic Island: the utility-sheet tools.
 * Alarm, Stopwatch, Focus (Pomodoro), Reminders, Note, Clipboard, Shelf, Convert and Settings.
 * Loaded after app.js and plugs into its views, actions, render() and baseView().
 * Alarms, reminders, the note, the shelf and settings are saved on this PC (Electron's local storage).
 */

/* ---------------- saving ---------------- */
const store = {
  get(key, fallback) { try { const v = localStorage.getItem('island.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('island.' + key, JSON.stringify(value)); } catch { /* storage full or blocked */ } },
};

const T = {
  alarms: store.get('alarms', []),          // { id, h, m, label, days: [0-6] (empty = once), on, lastFired }
  editAlarm: null,                          // alarm being edited
  ringing: null,                            // alarm going off right now
  snoozes: [],                              // { alarm, at }
  sw: { running: false, start: 0, acc: 0, laps: [] },
  focusCfg: store.get('focusCfg', { focus: 25, brk: 5, long: 15 }),
  focus: null,                              // { phase: 'focus'|'break', endAt, pausedLeft, total, session }
  shift: null,                              // short "Break time" / "Back to focus" pop-up
  reminders: store.get('reminders', []),    // { id, text, at }
  dueReminder: null,
  remDraft: '', remPreset: 10,
  note: store.get('note', ''),
  clip: [],
  shelf: store.get('shelf', []),            // { path, name, icon, size }
  convertFiles: [], convertTo: '', convertProgress: [], convertResults: null,
  settings: Object.assign({ liveBars: true, volumeKeys: true, clipboard: true, startWithWindows: false, chimes: true }, store.get('settings', {})),
  claudeStatus: '',
  dragging: false,
};
const uid = () => Math.random().toString(36).slice(2, 10);
const hhmm = (h, m) => `${pad2(h)}:${pad2(m)}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function daysText(days) {
  if (!days || !days.length) return 'Once';
  const s = [...days].sort().join();
  if (s === '1,2,3,4,5') return 'Weekdays';
  if (s === '0,6') return 'Weekends';
  if (days.length === 7) return 'Every day';
  return [...days].sort().map((d) => DAYS[d]).join(', ');
}
function nextAlarmText() {
  const now = new Date();
  let best = null;
  for (const a of T.alarms.filter((x) => x.on)) {
    for (let add = 0; add < 8; add++) {
      const d = new Date(now); d.setDate(d.getDate() + add); d.setHours(a.h, a.m, 0, 0);
      if (d <= now) continue;
      if (a.days.length && !a.days.includes(d.getDay())) continue;
      if (!best || d < best) best = d;
      break;
    }
  }
  if (!best) return 'No alarms on';
  const today = best.toDateString() === now.toDateString();
  return `${hhmm(best.getHours(), best.getMinutes())} ${today ? 'today' : best.toDateString() === new Date(Date.now() + 864e5).toDateString() ? 'tomorrow' : DAYS[best.getDay()]}`;
}
function swElapsed() { return T.sw.acc + (T.sw.running ? Date.now() - T.sw.start : 0); }
function fmtSw(ms) {
  const t = Math.floor(ms / 100), ds = t % 10, s = Math.floor(t / 10) % 60, m = Math.floor(t / 600) % 60, h = Math.floor(t / 36000);
  return (h ? `${h}:${pad2(m)}` : pad2(m)) + `:${pad2(s)}.${ds}`;
}
function focusLeft() { const f = T.focus; return !f ? 0 : f.pausedLeft != null ? f.pausedLeft : (f.endAt - Date.now()) / 1000; }
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const extOf = (p) => (String(p).match(/\.([^.\\/]+)$/) || [, ''])[1].toLowerCase();
const fileName = (p) => String(p).split(/[\\/]/).pop();
const IMG_EXT = /^(jpe?g|png|bmp|gif|tiff?|heic|heif|webp|ico|jxr)$/;
const MEDIA_EXT = /^(mp4|mov|m4v|mkv|avi|wmv|webm|mp3|wav|m4a|aac|flac|wma|ogg|3gp)$/;
const VIDEO_EXT = /^(mp4|mov|m4v|mkv|avi|wmv|webm|3gp)$/;

/* ---------------- tiles in the sheet ---------------- */
const tileSub = {
  alarm: () => nextAlarmText(),
  stopwatch: () => (T.sw.running || T.sw.acc ? fmtSw(swElapsed()) : 'Tap to start'),
  focus: () => (T.focus ? `${T.focus.phase === 'focus' ? 'Focus' : 'Break'} · ${fmt(focusLeft())}` : `${T.focusCfg.focus} min sessions`),
  reminder: () => { const n = T.reminders.length; return n ? `${n} upcoming` : 'Nothing set'; },
  note: () => (T.note.trim() ? T.note.trim().split('\n')[0].slice(0, 28) : 'Empty'),
  clipboard: () => (T.settings.clipboard ? `${T.clip.length} item${T.clip.length === 1 ? '' : 's'}` : 'Off'),
  shelf: () => (T.shelf.length ? `${T.shelf.length} file${T.shelf.length === 1 ? '' : 's'}` : 'Drop files here'),
  convert: () => 'Images, audio, video',
};
TILES.forEach((t) => {
  if (tileSub[t.id]) { t.ready = true; Object.defineProperty(t, 'sub', { get: tileSub[t.id] }); }
});
const TILE_VIEW = { alarm: 'alarmList', stopwatch: 'stopwatch', focus: 'focusView', reminder: 'reminders', note: 'note', clipboard: 'clipboard', shelf: 'shelf', convert: 'convert' };
actions.tile = (id) => {
  state.soon = '';
  if (id === 'timer') return render(state.timer ? 'timerExpanded' : 'timerSetup');
  if (id === 'convert' && !T.convertFiles.length) T.convertResults = null;
  render(TILE_VIEW[id]);
};

/* Settings button in the sheet header. */
const gearSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
// (The settings gear is part of the sheet's header in app.js.)

/* ---------------- shared bits ---------------- */
const backBtn = (to = 'sheet') => `<button class="ib" data-act="go" data-arg="${to}" aria-label="Back" style="width:36px;height:36px">${I.back}</button>`;
const head = (title, right = '', back = 'sheet') => `<div class="row">${backBtn(back)}<span class="f15 sp">${title}</span>${right}</div>`;
const toggle = (on, act, arg, label) => `<button class="tg${on ? ' on' : ''}" data-act="${act}" data-arg="${esc(arg)}" role="switch" aria-checked="${on}" aria-label="${esc(label)}"><i></i></button>`;
const panel = (html, width = 480, extra = {}) => ({ html: `<div class="v texp" style="width:${width}px;gap:14px">${html}</div>`, radius: 34, ...extra });

/* ---------------- alarm ---------------- */
views.alarmList = () => {
  const rows = T.alarms.length ? T.alarms.slice().sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m)).map((a) => `
    <div class="row" style="padding:6px 4px;${a.on ? '' : 'opacity:.5'}">
      <button class="plain sp" data-act="editAlarm" data-arg="${a.id}" style="text-align:left">
        <span class="big" style="font-size:32px;display:block">${hhmm(a.h, a.m)}</span>
        <span class="d f12">${esc(daysText(a.days))}${a.label ? ' · ' + esc(a.label) : ''}</span></button>
      ${toggle(a.on, 'toggleAlarm', a.id, 'Alarm on or off')}
    </div>`).join('<div class="hr"></div>') : '<div class="m f13" style="padding:10px 4px">No alarms yet.</div>';
  return panel(`${head('Alarms', '<button class="btn sm" data-act="newAlarm">Add</button>')}
    <div style="max-height:330px;overflow:auto">${rows}</div>
    <div class="d f12">Alarms ring while your PC is on and the island is running.</div>`);
};
views.alarmEdit = () => {
  const a = T.editAlarm;
  const presets = [['Once', []], ['Weekdays', [1, 2, 3, 4, 5]], ['Weekends', [0, 6]], ['Every day', [0, 1, 2, 3, 4, 5, 6]]];
  return panel(`${head(a.isNew ? 'New alarm' : 'Edit alarm', '', 'alarmList')}
    <div class="row" style="justify-content:center;gap:10px">
      <div class="col" style="align-items:center;gap:6px"><button class="ib" data-act="alarmStep" data-arg="h:1" aria-label="Hour up">${I.plus}</button>
        <span class="big" style="font-size:64px">${pad2(a.h)}</span><button class="ib" data-act="alarmStep" data-arg="h:-1" aria-label="Hour down">${I.minus}</button></div>
      <span class="big" style="font-size:56px;margin-top:-8px">:</span>
      <div class="col" style="align-items:center;gap:6px"><button class="ib" data-act="alarmStep" data-arg="m:5" aria-label="Five minutes later">${I.plus}</button>
        <span class="big" style="font-size:64px">${pad2(a.m)}</span><button class="ib" data-act="alarmStep" data-arg="m:-5" aria-label="Five minutes earlier">${I.minus}</button></div>
    </div>
    <div class="row" style="gap:6px;justify-content:center;flex-wrap:wrap">${presets.map(([n, d]) =>
      `<button class="chip${daysText(a.days) === daysText(d) ? ' on' : ''}" data-act="alarmDays" data-arg="${d.join(',')}">${n}</button>`).join('')}</div>
    <input class="field" id="alarmLabel" placeholder="Label (optional)" value="${esc(a.label || '')}" maxlength="40">
    <div class="row" style="gap:10px">${a.isNew ? '' : '<button class="btn f" data-act="deleteAlarm" style="color:#ff8a84">Delete</button>'}
      <button class="btn f w" data-act="saveAlarm">Save</button></div>`);
};
views.alarmRing = () => {
  const a = T.ringing;
  return {
    html: `<div class="v texp" style="width:440px;align-items:center;text-align:center;gap:14px">
      <span class="ic" style="background:rgba(255,105,97,.18);color:#ff6961;width:50px;height:50px;border-radius:25px">${I.alarm}</span>
      <div><div class="big" style="font-size:60px">${hhmm(a.h, a.m)}</div><div class="m f14" style="margin-top:8px">${esc(a.label || 'Alarm')}</div></div>
      <div class="row" style="gap:10px;width:100%"><button class="btn f" data-act="snoozeAlarm">Snooze 9 min</button>
        <button class="btn f" data-act="stopAlarm" style="background:#ff6961;color:#000">Stop</button></div></div>`,
    radius: 34,
    ring: { color: '#ff6961', rgb: '255,105,97' },
  };
};
Object.assign(actions, {
  newAlarm() { const n = new Date(Date.now() + 36e5); T.editAlarm = { id: uid(), h: n.getHours(), m: 0, label: '', days: [], on: true, isNew: true }; render('alarmEdit'); },
  editAlarm(id) { const a = T.alarms.find((x) => x.id === id); if (a) { T.editAlarm = { ...a, days: [...a.days] }; render('alarmEdit'); } },
  alarmStep(arg) {
    const [k, d] = arg.split(':'); const a = T.editAlarm; readAlarmLabel();
    if (k === 'h') a.h = (a.h + +d + 24) % 24; else a.m = (a.m + +d + 60) % 60;
    render('alarmEdit');
  },
  alarmDays(arg) { readAlarmLabel(); T.editAlarm.days = arg ? arg.split(',').map(Number) : []; render('alarmEdit'); },
  saveAlarm() {
    readAlarmLabel();
    const a = { ...T.editAlarm, on: true, lastFired: '' }; delete a.isNew;
    T.alarms = [...T.alarms.filter((x) => x.id !== a.id), a];
    store.set('alarms', T.alarms); render('alarmList');
  },
  deleteAlarm() { T.alarms = T.alarms.filter((x) => x.id !== T.editAlarm.id); store.set('alarms', T.alarms); render('alarmList'); },
  toggleAlarm(id) { const a = T.alarms.find((x) => x.id === id); if (a) { a.on = !a.on; store.set('alarms', T.alarms); render('alarmList'); } },
  snoozeAlarm() { T.snoozes.push({ alarm: T.ringing, at: Date.now() + 9 * 60e3 }); stopRinging(); },
  stopAlarm() { stopRinging(); },
});
function readAlarmLabel() { const el = document.querySelector('#content #alarmLabel'); if (el && T.editAlarm) T.editAlarm.label = el.value.trim(); }
let ringLoop = null;
function startRinging(alarm) {
  T.ringing = alarm;
  clearInterval(ringLoop);
  if (T.settings.chimes) { chime(); let n = 0; ringLoop = setInterval(() => { if (++n > 60 || !T.ringing) return clearInterval(ringLoop); chime(); }, 1500); }
  render('alarmRing');
}
function stopRinging() { T.ringing = null; clearInterval(ringLoop); render(baseView()); }
function checkAlarms() {
  const now = new Date();
  const key = `${now.toDateString()} ${now.getHours()}:${now.getMinutes()}`;
  for (const a of T.alarms) {
    if (!a.on || a.h !== now.getHours() || a.m !== now.getMinutes() || a.lastFired === key) continue;
    if (a.days.length && !a.days.includes(now.getDay())) continue;
    a.lastFired = key;
    if (!a.days.length) a.on = false; // one-time alarm switches itself off
    store.set('alarms', T.alarms);
    if (!T.ringing) startRinging(a);
  }
  const due = T.snoozes.find((s) => s.at <= Date.now());
  if (due && !T.ringing) { T.snoozes = T.snoozes.filter((s) => s !== due); startRinging(due.alarm); }
}

/* ---------------- stopwatch ---------------- */
views.stopwatch = () => {
  const laps = T.sw.laps.slice().reverse().map((l, i) => `<div class="row f13" style="padding:4px 2px"><span class="d sp">Lap ${T.sw.laps.length - i}</span><span class="tn">${fmtSw(l)}</span></div>`).join('');
  return panel(`<div class="row">${backBtn()}<span class="sp"></span>${modeSwitch('stopwatch')}<span class="sp"></span><span style="width:36px"></span></div>
    <div class="big" style="font-size:64px;text-align:center;color:#ffd60a;padding:4px 0" data-bind="sw">${fmtSw(swElapsed())}</div>
    <div class="row" style="gap:10px">
      <button class="btn f" data-act="${T.sw.running ? 'swLap' : 'swReset'}" ${!T.sw.running && !T.sw.acc ? 'disabled style="opacity:.4"' : ''}>${T.sw.running ? 'Lap' : 'Reset'}</button>
      <button class="btn f" data-act="swToggle" style="background:${T.sw.running ? '#ff6961' : '#ffd60a'};color:#000">${T.sw.running ? 'Stop' : T.sw.acc ? 'Resume' : 'Start'}</button></div>
    ${laps ? `<div style="max-height:150px;overflow:auto">${laps}</div>` : ''}`);
};
views.swCompact = () => ({
  html: `<div class="v compact"><span style="color:#ffd60a;display:flex">${I.stopwatch}</span>
    <span class="f14 tn" style="font-weight:600;color:#ffd60a" data-bind="sw">${fmtSw(swElapsed())}</span>
    ${T.sw.laps.length ? `<span class="d f12">Lap ${T.sw.laps.length + 1}</span>` : ''}</div>`,
  radius: 19,
});
Object.assign(actions, {
  swToggle() { const s = T.sw; if (s.running) { s.acc += Date.now() - s.start; s.running = false; } else { s.start = Date.now(); s.running = true; } render('stopwatch'); },
  swLap() { T.sw.laps.push(swElapsed() - T.sw.laps.reduce((a, b) => a + b, 0)); render('stopwatch'); },
  swReset() { T.sw = { running: false, start: 0, acc: 0, laps: [] }; render('stopwatch'); },
});

/* ---------------- focus (Pomodoro) ---------------- */
views.focusView = () => {
  const f = T.focus;
  if (!f) {
    const opt = (k, vals) => vals.map((v) => `<button class="chip${T.focusCfg[k] === v ? ' on' : ''}" data-act="focusCfg" data-arg="${k}:${v}">${v}m</button>`).join('');
    return panel(`${head('Focus')}
      <div class="big" style="font-size:64px;text-align:center;color:#d4bfff">${pad2(T.focusCfg.focus)}:00</div>
      <div class="row f13" style="gap:8px;justify-content:center"><span class="d" style="width:44px">Focus</span>${opt('focus', [15, 25, 45, 60])}</div>
      <div class="row f13" style="gap:8px;justify-content:center"><span class="d" style="width:44px">Break</span>${opt('brk', [5, 10, 15])}</div>
      <button class="btn" data-act="focusStart" style="width:100%;height:50px;background:#bf8cff;color:#14002e;font-size:15px">Start focusing</button>
      <div class="d f12" style="text-align:center">Four focus sessions, a short break after each, a longer ${T.focusCfg.long} min break after the fourth.</div>`);
  }
  const brk = f.phase === 'break', col = brk ? '48,209,88' : '191,140,255', left = focusLeft();
  return panel(`${head(brk ? 'Break' : 'Focus')}
    <div class="row"><span class="f12" style="color:rgb(${col});font-weight:700;letter-spacing:.14em">${brk ? 'BREAK' : 'FOCUS'}</span><span class="sp"></span>
      <span class="row" style="gap:6px">${[1, 2, 3, 4].map((i) => `<span class="dot" style="width:8px;height:8px;border-radius:50%;background:${i <= f.session ? `rgb(${col})` : 'rgba(255,255,255,.18)'}"></span>`).join('')}</span></div>
    <div class="big" style="font-size:64px;color:rgb(${col})" data-bind="focus">${fmt(left)}</div>
    <div class="line" style="color:rgb(${col})"><b data-bind="focusbar" style="width:${(1 - left / f.total) * 100}%"></b></div>
    <div class="row" style="gap:8px"><button class="btn f" data-act="${f.pausedLeft != null ? 'focusResume' : 'focusPause'}">${f.pausedLeft != null ? 'Resume' : 'Pause'}</button>
      <button class="btn f" data-act="focusSkip">${brk ? 'Skip break' : 'Skip to break'}</button>
      <button class="btn f" data-act="focusStop" style="color:#ff8a84">Stop</button></div>`);
};
views.focusCompact = () => {
  const f = T.focus, brk = f.phase === 'break', col = brk ? '48,209,88' : '191,140,255';
  return {
    html: `<div class="v compact">${ring(20, 3, focusLeft() / f.total, col)}
      <span class="f13" style="font-weight:600;color:rgb(${col})">${brk ? 'Break' : 'Focus'}</span>
      <span class="f14 tn" style="font-weight:600" data-bind="focus">${fmt(focusLeft())}</span></div>`,
    radius: 19,
  };
};
views.focusShift = () => ({
  html: `<div class="v hudv"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${T.shift.color}"></span><span class="f14" style="font-weight:600">${esc(T.shift.text)}</span></div>`,
  radius: 23,
});
function startPhase(phase, session) {
  const mins = phase === 'focus' ? T.focusCfg.focus : session >= 4 ? T.focusCfg.long : T.focusCfg.brk;
  T.focus = { phase, session, total: mins * 60, endAt: Date.now() + mins * 60e3, pausedLeft: null };
}
let shiftTimer = null;
function showShift(text, color) {
  T.shift = { text, color };
  if (T.settings.chimes) chime();
  clearTimeout(shiftTimer);
  shiftTimer = setTimeout(() => { T.shift = null; if (state.view === 'focusShift') render(baseView()); }, 3500);
  if (!CLOSABLE.has(state.view)) render('focusShift');
}
function checkFocus() {
  const f = T.focus;
  if (!f || f.pausedLeft != null || focusLeft() > 0) return;
  if (f.phase === 'focus') { startPhase('break', f.session); showShift(`Break time · ${Math.round(T.focus.total / 60)} min`, '#30d158'); }
  else { const next = f.session >= 4 ? 1 : f.session + 1; startPhase('focus', next); showShift(`Back to focus · session ${next} of 4`, '#bf8cff'); }
}
Object.assign(actions, {
  focusCfg(arg) { const [k, v] = arg.split(':'); T.focusCfg[k] = +v; store.set('focusCfg', T.focusCfg); render('focusView'); },
  focusStart() { unlockAudio(); startPhase('focus', 1); render('focusView'); },
  focusPause() { T.focus.pausedLeft = focusLeft(); render('focusView'); },
  focusResume() { const f = T.focus; f.endAt = Date.now() + f.pausedLeft * 1000; f.pausedLeft = null; render('focusView'); },
  focusSkip() { const f = T.focus; f.pausedLeft = null; f.endAt = Date.now(); checkFocus(); render('focusView'); },
  focusStop() { T.focus = null; render('focusView'); },
});

/* ---------------- reminders ---------------- */
// Reads a time out of the text ("in 20 min", "in 2 hours", "at 5pm", "at 17:30", "tomorrow").
// Returns at = null when the text has no time, so the chosen preset is used instead.
function parseReminder(text) {
  const t = text.trim();
  let at = null, clean = t;
  const rel = t.match(/\b(?:in\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\b/i);
  const abs = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (rel) {
    const n = parseFloat(rel[1]); at = Date.now() + n * (/^h/i.test(rel[2]) ? 36e5 : 6e4);
    clean = t.replace(rel[0], '');
  } else if (abs) {
    let h = +abs[1]; const m = +(abs[2] || 0);
    if (abs[3]) { if (/pm/i.test(abs[3]) && h < 12) h += 12; if (/am/i.test(abs[3]) && h === 12) h = 0; }
    const d = new Date(); d.setHours(h, m, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1);
    at = d.getTime(); clean = t.replace(abs[0], '');
  }
  if (/tomorrow/i.test(t) && at) { const d = new Date(at); if (d.toDateString() === new Date().toDateString()) d.setDate(d.getDate() + 1); at = d.getTime(); clean = clean.replace(/tomorrow/i, ''); }
  clean = clean.replace(/^\s*(remind me (to)?|to)\s+/i, '').replace(/\s+(in|at)\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
  return { at, text: clean || t };
}
function whenText(at) {
  const d = new Date(at), today = d.toDateString() === new Date().toDateString();
  return `${hhmm(d.getHours(), d.getMinutes())} ${today ? 'today' : d.toDateString() === new Date(Date.now() + 864e5).toDateString() ? 'tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`;
}
views.reminders = () => {
  const preview = parseReminder(T.remDraft);
  const list = T.reminders.slice().sort((a, b) => a.at - b.at).map((r) => `
    <div class="row f13" style="padding:6px 4px"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:#ff6fae"></span>
      <span class="sp ell">${esc(r.text)}</span><span class="d f12">${whenText(r.at)}</span>
      <button class="x" data-act="delReminder" data-arg="${r.id}" aria-label="Delete reminder" style="width:26px;height:26px">${I.close}</button></div>`).join('');
  const presets = [[10, 'In 10 min'], [30, 'In 30 min'], [60, 'In 1 hour'], [-1, 'Tonight 20:00'], [-2, 'Tomorrow 9:00']];
  return panel(`${head('Reminders')}
    <input class="field" id="remText" placeholder="e.g. call mom in 20 min" value="${esc(T.remDraft)}" maxlength="120">
    <div class="row" style="gap:6px;flex-wrap:wrap">${presets.map(([v, n]) => `<button class="chip${T.remPreset === v ? ' on' : ''}" data-act="remPreset" data-arg="${v}">${n}</button>`).join('')}</div>
    <div class="row f13" style="gap:8px;padding:0 4px;min-height:18px" data-bind="remPreview">${T.remDraft.trim() ? `<b>${esc(preview.text)}</b><span class="m">· ${whenText(presetAt(preview))}</span>` : '<span class="d">Type what to remember. Times like "in 20 min" or "at 5pm" work too.</span>'}</div>
    <button class="btn" data-act="addReminder" style="width:100%;height:46px;background:#ff6fae;color:#2a0016">Add reminder</button>
    ${list ? `<div style="max-height:170px;overflow:auto">${list}</div>` : ''}`, 500);
};
// A time typed in the text wins; otherwise the selected preset decides.
function presetAt(p) {
  if (p.at) return p.at;
  if (T.remPreset === -1) { const d = new Date(); d.setHours(20, 0, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return d.getTime(); }
  if (T.remPreset === -2) { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); }
  return Date.now() + T.remPreset * 6e4;
}
views.reminderDue = () => {
  const r = T.dueReminder;
  return {
    html: `<div class="v texp" style="width:440px;gap:14px">
      <div class="row"><span class="ic" style="background:rgba(255,111,174,.16);color:#ff6fae;border-radius:19px">${I.bell}</span>
        <div class="sp"><div class="f15" style="font-size:17px">${esc(r.text)}</div><div class="d f12">Reminder</div></div></div>
      <div class="row" style="gap:10px"><button class="btn f" data-act="snoozeReminder">Snooze 10 min</button>
        <button class="btn f" data-act="doneReminder" style="background:#ff6fae;color:#2a0016">Done</button></div></div>`,
    radius: 34,
    ring: { color: '#ff6fae', rgb: '255,111,174' },
  };
};
Object.assign(actions, {
  remPreset(v) { T.remDraft = readField('remText', T.remDraft); T.remPreset = +v; render('reminders'); },
  addReminder() {
    T.remDraft = readField('remText', T.remDraft);
    if (!T.remDraft.trim()) return;
    const p = parseReminder(T.remDraft);
    T.reminders.push({ id: uid(), text: p.text, at: presetAt(p) });
    store.set('reminders', T.reminders);
    T.remDraft = ''; render('reminders');
  },
  delReminder(id) { T.reminders = T.reminders.filter((r) => r.id !== id); store.set('reminders', T.reminders); render('reminders'); },
  snoozeReminder() { const r = T.dueReminder; T.reminders.push({ ...r, id: uid(), at: Date.now() + 10 * 6e4 }); store.set('reminders', T.reminders); T.dueReminder = null; clearInterval(ringLoop); render(baseView()); },
  doneReminder() { T.dueReminder = null; clearInterval(ringLoop); render(baseView()); },
});
function checkReminders() {
  if (T.dueReminder) return;
  const due = T.reminders.find((r) => r.at <= Date.now());
  if (!due) return;
  T.reminders = T.reminders.filter((r) => r !== due);
  store.set('reminders', T.reminders);
  T.dueReminder = due;
  if (T.settings.chimes) { alertChime(); let n = 0; clearInterval(ringLoop); ringLoop = setInterval(() => { if (++n > 20 || !T.dueReminder) return clearInterval(ringLoop); alertChime(); }, 3000); }
  if (!CLOSABLE.has(state.view)) render('reminderDue');
}
const readField = (id, fallback) => { const el = document.querySelector('#content #' + id); return el ? el.value : fallback; };

/* ---------------- note ---------------- */
views.note = () => panel(`${head('Note', '<span class="d f12" data-bind="noteSaved">Saved</span>')}
  <textarea id="noteText" class="field" style="height:220px;padding:14px 16px;line-height:1.6;resize:none;font-size:15px" placeholder="Anything you want to jot down…">${esc(T.note)}</textarea>
  <div class="row"><span class="d f12 sp">Saved on this PC as you type.</span><button class="btn sm" data-act="clearNote">Clear</button></div>`, 500);
let noteSaveTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.id === 'noteText') {
    T.note = e.target.value;
    const s = document.querySelector('[data-bind="noteSaved"]'); if (s) s.textContent = 'Saving…';
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => { store.set('note', T.note); const el = document.querySelector('[data-bind="noteSaved"]'); if (el) el.textContent = 'Saved'; }, 400);
  } else if (e.target.id === 'remText') {
    T.remDraft = e.target.value;
    const p = parseReminder(T.remDraft), el = document.querySelector('[data-bind="remPreview"]');
    if (el) el.innerHTML = T.remDraft.trim() ? `<b>${esc(p.text)}</b><span class="m">· ${whenText(presetAt(p))}</span>` : '<span class="d">Type what to remember.</span>';
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'remText') actions.addReminder();
  if (e.key === 'Enter' && e.target.id === 'alarmLabel') actions.saveAlarm();
  if (e.key === 'Escape' && CLOSABLE.has(state.view)) render(baseView());
});
actions.clearNote = () => { T.note = ''; store.set('note', ''); render('note'); };

/* ---------------- clipboard ---------------- */
views.clipboard = () => {
  if (!T.settings.clipboard) return panel(`${head('Clipboard')}<div class="m f13">Clipboard history is off. Turn it on in Settings.</div>`);
  const items = T.clip.slice(0, 40).map((c, i) => {
    const t = c.text.trim(), kind = /^https?:\/\//i.test(t) ? 'LINK' : /[{};=<>]|\b(npm|git|const|function)\b/.test(t) ? 'CODE' : 'TEXT';
    return `<div class="clip${c.pin ? ' pinned' : ''}" data-act="clipCopy" data-arg="${i}" role="button" tabindex="0"><span class="ty">${kind}</span>
      <span class="sp ell" style="${kind === 'CODE' ? "font-family:Consolas,'Cascadia Mono',monospace;font-size:12px" : ''}${kind === 'LINK' ? ';color:#8ac4ff' : ''}">${esc(t.replace(/\s+/g, ' ').slice(0, 200))}</span>
      <span class="d f12">${c.pin ? '' : fmtAgo(c.at)}</span>
      <button class="cbtn${c.pin ? ' on' : ''}" data-act="clipPin" data-arg="${i}" aria-label="${c.pin ? 'Unpin' : 'Pin'}" title="${c.pin ? 'Unpin' : 'Pin: keep it for good'}">${I.pinClip}</button>
      <button class="cbtn" data-act="clipDelete" data-arg="${i}" aria-label="Delete" title="Delete">${I.close}</button></div>`;
  }).join('');
  const unpinned = T.clip.filter((c) => !c.pin).length;
  return panel(`${head('Clipboard', unpinned ? '<button class="btn sm" data-act="clipClear">Clear</button>' : '')}
    ${items ? `<div style="display:flex;flex-direction:column;gap:6px;max-height:360px;overflow:auto">${items}</div>` : '<div class="m f13" style="padding:6px 4px">Copy some text and it shows up here.</div>'}
    <div class="d f12">Click an item to copy it again. Pin one to keep it for good; Clear keeps pinned items. ${T.settings.clipKeep === false ? 'Forgotten when the island closes.' : 'Kept after a restart, encrypted for your Windows account.'} Copies from password managers are never kept.</div>`, 540);
};
function fmtAgo(at) { const s = Math.floor((Date.now() - at) / 1000); return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; }
Object.assign(actions, {
  clipCopy(i) { const c = T.clip[+i]; if (!c) return; post({ type: 'clip-copy', text: c.text }); render(baseView()); showHud({ kind: 'caps', on: true, label: 'Copied' }); },
  clipClear() { post({ type: 'clip-clear' }); },
  clipPin(i) { const c = T.clip[+i]; if (c) post({ type: 'clip-pin', text: c.text }); },
  clipDelete(i) { const c = T.clip[+i]; if (c) post({ type: 'clip-delete', text: c.text }); },
});
// The "Copied" pop-up reuses the small text pop-up.
const coreHud = views.hud;
views.hud = () => (state.hud && state.hud.label
  ? { html: `<div class="v hudv"><span style="color:#64d2ff;display:flex">${I.clip}</span><span class="f13" style="font-weight:600">${esc(state.hud.label)}</span></div>`, radius: 23 }
  : coreHud());

/* ---------------- shelf ---------------- */
function fileTile(f, i) {
  return `<div class="file" draggable="true" data-shelf="${i}" title="${esc(f.path)}">
    <button class="x fx" data-act="shelfRemove" data-arg="${i}" aria-label="Remove from shelf">${I.close}</button>
    ${f.icon ? `<img src="${f.icon}" alt="" width="40" height="40" draggable="false">` : `<span class="ftp">${esc(extOf(f.path).toUpperCase().slice(0, 4) || 'FILE')}</span>`}
    <span class="fn">${esc(f.name)}</span></div>`;
}
views.shelf = () => panel(`${head('Shelf', T.shelf.length ? `<span class="d f12">${T.shelf.length} file${T.shelf.length === 1 ? '' : 's'}</span><button class="btn sm" data-act="shelfConvert">Convert</button><button class="btn sm" data-act="shelfClear">Clear</button>` : '')}
  ${T.shelf.length ? `<div class="files">${T.shelf.map(fileTile).join('')}</div>` : ''}
  <div class="drop" style="height:${T.shelf.length ? 70 : 150}px"><span class="f14" style="font-weight:600">Drag files here to keep them</span>
    <span class="d f12">Drag them out again into any folder or app</span></div>`, 560);
views.dropZone = () => panel(`<div class="row" style="gap:12px;pointer-events:none">
    <div class="drop dz sp" data-drop="shelf" style="height:170px;border-color:rgba(48,209,88,.55)"><span class="ic" style="background:rgba(48,209,88,.16);color:#30d158;width:46px;height:46px;border-radius:23px">${I.shelf}</span>
      <div><div class="f15">Keep on shelf</div><div class="d f12">Hold it for later</div></div></div>
    <div class="drop dz sp" data-drop="convert" style="height:170px;border-color:rgba(64,200,224,.6)"><span class="ic" style="background:rgba(64,200,224,.18);color:#40c8e0;width:46px;height:46px;border-radius:23px">${I.convert}</span>
      <div><div class="f15">Convert</div><div class="d f12">Change the format</div></div></div></div>`, 520);
Object.assign(actions, {
  shelfRemove(i) { T.shelf.splice(+i, 1); store.set('shelf', T.shelf); render('shelf'); },
  shelfClear() { T.shelf = []; store.set('shelf', T.shelf); render('shelf'); },
  shelfConvert() { T.convertFiles = T.shelf.map((f) => f.path); T.convertResults = null; T.convertTo = ''; render('convert'); },
});
async function addToShelf(paths) {
  for (const p of paths) {
    if (!p || T.shelf.some((f) => f.path === p)) continue;
    const info = host ? await host.invoke('file-info', p) : { ok: false };
    if (!info || !info.ok) continue;
    T.shelf.push({ path: p, name: fileName(p), icon: info.icon, size: info.size });
  }
  store.set('shelf', T.shelf);
}
// Drag a shelf file out: hand it to Windows so it can be dropped anywhere.
document.addEventListener('dragstart', (e) => {
  const el = e.target.closest && e.target.closest('[data-shelf]');
  if (!el) return;
  e.preventDefault();
  const f = T.shelf[+el.dataset.shelf];
  if (f && host) host.startDrag(f.path);
});
/* Dragging files onto the island.
 * Always the same screen: "Keep on shelf" on the left half, "Convert" on the right half, whatever the island
 * was showing before. The choice is made from which half the pointer is over (no gap, no guessing).
 * The screen stays while drag-over events keep arriving and goes back ~0.7 s after they stop
 * (drag cancelled or moved away). We don't rely on "dragleave": it also fires whenever the elements
 * under the pointer are swapped, which made the screen flicker back and forth. */
let dragLastOver = 0, dragReturn = null, dragSide = '';
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
function dragSideAt(x) { const r = island.getBoundingClientRect(); return x < r.left + r.width / 2 ? 'shelf' : 'convert'; }
function markSide(side) {
  dragSide = side;
  document.querySelectorAll('.dz').forEach((z) => z.classList.toggle('hot', z.dataset.drop === side));
}
function onDragOver(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dragLastOver = Date.now();
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = true;
  if (state.view !== 'dropZone') {
    dragReturn = CLOSABLE.has(state.view) ? state.view : null;
    render('dropZone');
    dragSide = '';
  }
  const side = dragSideAt(e.clientX);
  if (side !== dragSide || !document.querySelector('.dz.hot')) markSide(side);
}
document.addEventListener('dragenter', onDragOver);
document.addEventListener('dragover', onDragOver);
setInterval(() => {
  if (state.view === 'dropZone' && Date.now() - dragLastOver > 700) render(dragReturn || baseView());
}, 150);
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragLastOver = 0;
  const paths = [...e.dataTransfer.files].map((f) => (host ? host.pathFor(f) : '')).filter(Boolean);
  if (!paths.length) { render(dragReturn || baseView()); return; }
  if (dragSideAt(e.clientX) === 'convert') {
    T.convertFiles = paths; T.convertResults = null; T.convertTo = ''; T.convertProgress = [];
    render('convert');
  } else {
    await addToShelf(paths);
    render('shelf');
  }
});

/* ---------------- convert ---------------- */
function convertKind(files) {
  const exts = files.map(extOf);
  if (exts.length && exts.every((x) => IMG_EXT.test(x))) return 'image';
  if (exts.length && exts.every((x) => MEDIA_EXT.test(x))) return exts.some((x) => VIDEO_EXT.test(x)) ? 'video' : 'audio';
  return exts.length ? 'mixed' : 'none';
}
views.convert = () => {
  if (T.convertResults) return views.convertDone();
  if (T.convertProgress.length) return views.converting();
  const files = T.convertFiles, kind = convertKind(files);
  if (!files.length) {
    return panel(`${head('Convert')}
      <div class="drop" style="height:120px"><div class="f14" style="font-weight:600">Drop files here</div>
        <button class="btn sm" data-act="pickFiles" style="background:rgba(64,200,224,.18);color:#9be8f5">Choose files</button></div>
      <div class="d f12">Images: JPG, PNG, BMP, TIFF, GIF, PDF (HEIC needs the free HEIF Image Extensions). Audio: MP3, M4A, WAV. Video: MP4, or just the sound as MP3. Everything stays on your PC.</div>`, 520);
  }
  const formats = kind === 'image' ? ['jpg', 'png', 'pdf', 'bmp', 'tiff', 'gif'] : kind === 'video' ? ['mp4', 'mp3', 'm4a', 'wav'] : kind === 'audio' ? ['mp3', 'm4a', 'wav'] : [];
  if (!formats.includes(T.convertTo)) T.convertTo = formats[0] || '';
  const first = files[0];
  return panel(`${head('Convert', `<button class="x" data-act="convertClear" aria-label="Clear files">${I.close}</button>`)}
    <div class="row"><span class="ftp">${esc(extOf(first).toUpperCase().slice(0, 4))}</span>
      <div class="sp"><div class="f15 ell">${esc(fileName(first))}</div><div class="d f12">${files.length > 1 ? `and ${files.length - 1} more` : 'One file'}</div></div></div>
    ${formats.length ? `<div class="d f12" style="font-weight:600;letter-spacing:.1em;text-transform:uppercase">Convert to</div>
      <div class="fmts">${formats.map((f) => `<button class="fmt${T.convertTo === f ? ' on' : ''}" data-act="convertTo" data-arg="${f}">${f === 'pdf' && files.length > 1 ? 'PDF (1 file)' : f.toUpperCase()}</button>`).join('')}</div>
      <button class="btn" data-act="convertGo" style="width:100%;height:48px;background:#40c8e0;color:#001a20;font-size:15px">Convert ${files.length} file${files.length === 1 ? '' : 's'}</button>
      <div class="d f12">New files are saved next to the originals. Nothing is uploaded.</div>`
      : '<div class="f13" style="color:#ff8a84">These files can\'t be converted together. Use only images, or only audio/video.</div>'}`, 520);
};
views.converting = () => panel(`<div class="row">${spinner(20)}<span class="f15 sp">Converting to ${T.convertTo.toUpperCase()}</span>
    <span class="d f12">${T.convertProgress.filter((p) => p.state !== 'working').length} of ${T.convertProgress.length}</span></div>
  ${T.convertProgress.map((p) => `<div class="row f13"><span class="sp ell">${esc(fileName(p.file || T.convertFiles[0]))}</span>
    ${p.state === 'done' ? check(16) : p.state === 'failed' ? '<span style="color:#ff6b6b" class="f12">failed</span>' : p.state === 'working' ? spinner(14) : '<span class="d f12">waiting</span>'}</div>`).join('')}
  <div class="d f12">Video can take a while. You can keep working; the island shows when it's done.</div>`, 500);
views.convertDone = () => {
  const ok = T.convertResults.filter((r) => r.ok), bad = T.convertResults.filter((r) => !r.ok);
  return panel(`<div class="row">${ok.length ? check(20) : ''}<span class="f15 sp">${ok.length ? `${ok.length} file${ok.length === 1 ? '' : 's'} converted` : 'Conversion failed'}</span>
      <button class="x" data-act="convertClear" aria-label="Close">${I.close}</button></div>
    ${ok.map((r) => `<div class="row f13"><span class="sp ell">${esc(fileName(r.out))}</span></div>`).join('')}
    ${bad.map((r) => `<div class="f12" style="color:#ff8a84">${esc(fileName(r.input || ''))}: ${esc(r.error)}</div>`).join('')}
    ${ok.length ? `<div class="row" style="gap:10px"><button class="btn f" data-act="convertShelf">Keep on shelf</button><button class="btn f w" data-act="convertShow">Show in folder</button></div>` : ''}`, 500);
};
Object.assign(actions, {
  async pickFiles() { if (!host) return; const files = await host.invoke('pick-files'); if (files.length) { T.convertFiles = files; T.convertResults = null; } render('convert'); },
  convertTo(f) { T.convertTo = f; render('convert'); },
  convertClear() { T.convertFiles = []; T.convertResults = null; T.convertProgress = []; render('convert'); },
  async convertGo() {
    const files = T.convertTo === 'pdf' ? T.convertFiles : T.convertFiles;
    T.convertProgress = (T.convertTo === 'pdf' ? [files[0]] : files).map((f) => ({ file: f, state: 'waiting' }));
    render('convert');
    const results = host ? await host.invoke('convert', { files, to: T.convertTo, quality: 90 }) : [];
    T.convertProgress = []; T.convertResults = results;
    if (T.settings.chimes) doneChime();
    if (state.view === 'convert' || state.view === 'converting') render('convert');
    else { render(baseView()); showHud({ kind: 'caps', label: `${results.filter((r) => r.ok).length} file(s) converted` }); }
  },
  async convertShelf() { await addToShelf(T.convertResults.filter((r) => r.ok).map((r) => r.out)); T.convertResults = null; T.convertFiles = []; render('shelf'); },
  convertShow() { const r = T.convertResults.find((x) => x.ok); if (r) post({ type: 'open-path', path: r.out }); },
});

/* ---------------- settings ---------------- */
views.settings = () => {
  const s = T.settings;
  const row = (key, title, sub) => `<div class="row" style="padding:8px 4px"><div class="sp"><div class="f14" style="font-weight:600">${title}</div><div class="d f12">${sub}</div></div>${toggle(s[key], 'setToggle', key, title)}</div>`;
  const connected = /Installed/.test(T.claudeStatus);
  return panel(`${head('Settings')}
    <div style="max-height:420px;overflow:auto;display:flex;flex-direction:column">
    ${row('liveBars', 'Sound bars follow the music', 'Listens to your PC\'s sound output to move the bars')}
    ${row('volumeKeys', 'Island handles volume keys', 'Hides Windows\' own volume pop-up')}
    ${row('clipboard', 'Clipboard history', 'Remembers text you copy, in memory only')}
    ${row('chimes', 'Sounds', 'Chimes for timers, alarms, reminders and agents')}
    ${row('startWithWindows', 'Start with Windows', 'Open the island when you sign in')}
    <div class="row" style="padding:8px 4px"><div class="sp"><div class="f14" style="font-weight:600">Claude Code</div>
      <div class="d f12">${T.claudeStatus ? (connected ? 'Connected: sessions report here' : 'Not connected') : 'Checking…'}</div></div>
      <button class="btn sm" data-act="claudeHooks" data-arg="${connected ? 'disconnect' : 'connect'}">${connected ? 'Disconnect' : 'Connect'}</button></div>
    </div>
    <div class="row"><span class="d f12 sp">Tip: right-click the island to hide it. Esc closes a panel.</span><button class="btn sm" data-act="quitIsland" style="color:#ff8a84">Quit island</button></div>`, 520);
};
Object.assign(actions, {
  setToggle(key) { T.settings[key] = !T.settings[key]; saveSettings(); render('settings'); },
  async claudeHooks(cmd) { if (!host) return; await host.invoke('claude-hooks', cmd); T.claudeStatus = await host.invoke('claude-hooks', 'status'); render('settings'); },
  quitIsland() { post({ type: 'quit' }); },
  // Settings open in their own window in the middle of the screen.
  openSettings() { post({ type: 'open-settings' }); render(baseView()); },
});
function saveSettings() {
  store.set('settings', T.settings);
  post({ type: 'settings', settings: T.settings });
  if (!T.settings.liveBars) stopViz();
}
// Settings coming from the Settings window (via the main process).
function applyPrefs(s) {
  T.settings = { ...T.settings, ...s };
  store.set('settings', T.settings);
  Object.keys(prefs).forEach((k) => { if (k in s) prefs[k] = s[k]; });
  if (!T.settings.liveBars || !T.settings.media) stopViz();
  if (state.view === 'sheet') render('sheet'); // tools added, removed or reordered
  else if (RESTING.has(state.view) && state.view !== 'hud') render(baseView());
}
const coreManageViz = manageViz;
manageViz = () => (T.settings.liveBars ? coreManageViz() : (viz.stream && stopViz()));

/* ---------------- what the island shows ---------------- */
const coreBaseView = baseView;
baseView = function () {
  if (state.hud) return 'hud';
  if (T.ringing) return 'alarmRing';
  if (T.dueReminder) return 'reminderDue';
  if (T.shift) return 'focusShift';
  const b = coreBaseView();
  if (b !== 'none' || (state.fullscreen && prefs.hideFullscreen)) return b;
  if (T.focus) return 'focusCompact';
  if (T.sw.running) return 'swCompact';
  return 'none';
};
['alarmRing', 'reminderDue', 'focusShift', 'focusCompact', 'swCompact'].forEach((v) => RESTING.add(v));
['alarmList', 'alarmEdit', 'stopwatch', 'focusView', 'reminders', 'note', 'clipboard', 'shelf', 'dropZone', 'convert', 'converting', 'convertDone', 'settings'].forEach((v) => CLOSABLE.add(v));

// Views with text boxes need the keyboard; everything else leaves your focus where it is.
const TYPING = new Set(['note', 'reminders', 'alarmEdit']);
const coreRender = render;
let hadFocus = false;
render = function (name, opts) {
  coreRender(name, opts);
  const want = TYPING.has(name);
  if (want !== hadFocus) { hadFocus = want; post({ type: 'focus', on: want }); }
  if (want) setTimeout(() => { const el = document.querySelector('#content textarea, #content input'); if (el && document.activeElement !== el) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); } }, 60);
};

// Clicking a resting tool island opens it.
content.addEventListener('click', (e) => {
  if (e.target.closest('[data-act]')) return;
  if (state.view === 'swCompact') render('stopwatch');
  else if (state.view === 'focusCompact') render('focusView');
});

/* ---------------- ticking ---------------- */
setInterval(() => {
  checkAlarms();
  checkReminders();
  checkFocus();
  if (state.view === 'focusCompact' && !T.focus) render(baseView());
  if (state.view === 'swCompact' && !T.sw.running) render(baseView());
  const left = focusLeft();
  document.querySelectorAll('[data-bind="focus"]').forEach((e) => { e.textContent = fmt(left); });
  const fb = document.querySelector('[data-bind="focusbar"]'); if (fb && T.focus) fb.style.width = (1 - left / T.focus.total) * 100 + '%';
  document.querySelectorAll('[data-ring]').forEach((e) => {
    if (state.view === 'focusCompact' && T.focus) e.setAttribute('stroke-dashoffset', +e.dataset.ring * (1 - Math.max(0, left) / T.focus.total));
  });
}, 500);
setInterval(() => { const t = fmtSw(swElapsed()); document.querySelectorAll('[data-bind="sw"]').forEach((e) => { e.textContent = t; }); }, 100);

/* ---------------- messages and start-up ---------------- */
if (host) {
  host.onMessage((m) => {
    if (m.type === 'settings') applyPrefs(m.settings || {});
    else if (m.type === 'clip') { T.clip = m.items || []; if (state.view === 'clipboard') render('clipboard'); }
    else if (m.type === 'convert-progress') {
      if (m.index < T.convertProgress.length) T.convertProgress[m.index].state = m.state;
      if (state.view === 'convert') render('convert');
    }
  });
  post({ type: 'settings', settings: T.settings });
  post({ type: 'clip-list' }); // the saved clipboard history (arrives as a 'clip' message)
  host.invoke('claude-hooks', 'status').then((s) => { T.claudeStatus = s; });
}
// Files on the shelf that were moved or deleted drop off.
(async () => {
  if (!host || !T.shelf.length) return;
  const kept = [];
  for (const f of T.shelf) { const i = await host.invoke('file-info', f.path); if (i && i.ok) kept.push({ ...f, icon: i.icon }); }
  T.shelf = kept; store.set('shelf', kept);
})();
I.pinClip = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z"/></svg>';
