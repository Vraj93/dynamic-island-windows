'use strict';
/* Dynamic Island: Calendar.
 * Your Google / Outlook / linked calendars in the sheet, a heads-up in the island before each event (with a Join
 * button for Meet, Teams and Zoom), and reminders that stay in sync with Google Tasks or Microsoft To Do.
 * Accounts and syncing live in the main process (electron/calendar.js); this file only shows things.
 * Loaded after tools.js.
 */
I.cal = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/><circle cx="8.5" cy="14.5" r=".6" fill="currentColor"/><circle cx="12" cy="14.5" r=".6" fill="currentColor"/></svg>';
I.video = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="13" height="12" rx="3"/><path d="M15.5 10.5 21 7.5v9l-5.5-3"/></svg>';
I.sync = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M4 3v5h5M20 21v-5h-5"/></svg>';
I.pin = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';

const C = {
  events: [], tasks: [], accounts: [], taskAccounts: [], syncedAt: 0, syncing: false,
  alert: null,                              // { ev, phase: 'soon' | 'now' }
  alerted: new Set(store.get('calAlerted', [])),
  doneTasks: new Set(store.get('calDoneTasks', [])), // synced reminders finished here (don't bring them back)
  local: store.get('calEvents', []),        // events added in the island, kept on this PC: { id, title, start, end, allDay, color }
  edit: null,                               // event being added or edited
};
// Everything the island shows: events made here plus any synced accounts.
const allEvents = () => [...C.events, ...C.local.map((e) => ({ ...e, calendar: 'On this PC', location: e.location || '', join: e.join || '', local: true }))].sort((a, b) => a.start - b.start || a.end - b.end);
TILES.push({ id: 'calendar', name: 'Calendar', icon: I.cal, color: '255,95,87', ready: true });
const calTile = TILES.find((t) => t.id === 'calendar');

/* ---------------- helpers ---------------- */
const dayStart = (offset = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d.getTime(); };
const tm = (t) => { const d = new Date(t); return hhmm(d.getHours(), d.getMinutes()); };
function untilText(ms) {
  if (ms <= 0) return 'now';
  const m = Math.ceil(ms / 6e4);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return `in ${h} h${r ? ` ${r} min` : ''}`;
}
const eventsOn = (offset) => {
  const a = dayStart(offset), b = dayStart(offset + 1);
  return allEvents().filter((e) => e.start < b && e.end > a && (e.end > e.start || e.start >= a));
};
const nextEvent = () => { const now = Date.now(); return allEvents().find((e) => !e.allDay && e.end > now) || null; };
const joinLabel = (url) => (/meet\.google/.test(url) ? 'Join Meet' : /teams\./.test(url) ? 'Join Teams' : /zoom\.us/.test(url) ? 'Join Zoom' : /webex/.test(url) ? 'Join Webex' : 'Join');
const hasAccounts = () => C.accounts.length > 0;

Object.defineProperty(calTile, 'sub', {
  get() {
    const now = Date.now(), e = nextEvent();
    if (!e || e.start >= dayStart(1)) return eventsOn(0).length ? 'Nothing else today' : 'Nothing today';
    if (e.start <= now) return `Now · ${e.title}`;
    return e.start - now < 3 * 36e5 ? `${e.title} · ${untilText(e.start - now)}` : `${tm(e.start)} ${e.title}`;
  },
});
TILE_VIEW.calendar = 'calendar';

/* ---------------- the Calendar panel: a month you can move through, and the chosen day's events ---------------- */
const dayOf = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const monthOf = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const eventsIn = (day) => { const b = addDays(day, 1); return allEvents().filter((e) => e.start < b && (e.end > day || (e.end === e.start && e.start >= day))); };
C.sel = dayOf(Date.now());
C.month = monthOf(Date.now());

function monthGrid() {
  const first = new Date(C.month), today = dayOf(Date.now());
  const lead = (first.getDay() + 6) % 7;                 // weeks start on Monday
  let t = addDays(C.month, -lead);
  // Which days have events (one pass over everything).
  const marks = new Map();
  const gridEnd = addDays(t, 42);
  for (const e of allEvents()) {
    if (e.end < t || e.start >= gridEnd) continue;
    for (let d = Math.max(dayOf(e.start), t); d < Math.min(e.end > e.start ? e.end : e.start + 1, gridEnd); d = addDays(d, 1)) {
      const l = marks.get(d) || []; if (l.length < 3) l.push(e.color); marks.set(d, l);
    }
  }
  const head = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((w) => `<span class="cw">${w}</span>`).join('');
  let cells = '';
  for (let i = 0; i < 42; i++, t = addDays(t, 1)) {
    const d = new Date(t), out = d.getMonth() !== first.getMonth();
    const dots = (marks.get(t) || []).map((c) => `<i style="background:${esc(c)}"></i>`).join('');
    cells += `<button class="cm${out ? ' out' : ''}${t === today ? ' today' : ''}${t === C.sel ? ' on' : ''}${t < today ? ' was' : ''}" data-act="calPick" data-arg="${t}">
      <span>${d.getDate()}</span><span class="dots">${dots}</span></button>`;
  }
  return `<div class="cgrid">${head}${cells}</div>`;
}

function dayList(day) {
  const now = Date.now(), list = eventsIn(day);
  const allDay = list.filter((e) => e.allDay), timed = list.filter((e) => !e.allDay);
  const rows = timed.map((e) => {
    const live = e.start <= now && e.end > now, past = e.end <= now, soon = !past && e.start - now < 15 * 6e4;
    const sub = [e.location && !/^https?:\/\//.test(e.location) ? `${I.pin} ${esc(e.location)}` : '', esc(e.calendar)].filter(Boolean).join('<span class="d"> · </span>');
    const startTxt = e.start < day ? '…' : tm(e.start), endTxt = e.end > addDays(day, 1) ? '…' : tm(e.end);
    return `<div class="cev${e.local ? ' mine' : ''}${past ? ' past' : ''}${live ? ' live' : ''}" style="--c:${esc(e.color)}"${e.local ? ` data-act="calEdit" data-arg="${e.id}"` : ''}>
      <div class="ct"><span>${startTxt}</span><span class="d">${endTxt}</span></div>
      <div class="sp"><div class="f14 ell" style="font-weight:600">${esc(e.title)}</div><div class="d f12 ell">${live ? '<b class="nowtag">Now</b> ' : ''}${sub}</div></div>
      ${e.join && !past ? `<button class="btn sm${live || soon ? ' join' : ''}" data-act="calOpen" data-arg="${esc(e.join)}">${I.video}${live || soon ? joinLabel(e.join) : ''}</button>` : ''}
    </div>`;
  }).join('');
  const chips = allDay.map((e) => `<span class="callday" style="--c:${esc(e.color)}"${e.local ? ` data-act="calEdit" data-arg="${e.id}"` : ''}>${esc(e.title)}</span>`).join('');
  return { count: list.length, html: `${chips ? `<div class="row" style="gap:6px;flex-wrap:wrap">${chips}</div>` : ''}
    ${rows || `<div class="cempty"><span class="m f13">${allDay.length ? 'No timed events' : day < dayOf(now) ? 'Nothing happened' : 'Nothing planned'}</span>
      <button class="btn sm" data-act="calNew">${I.plus} Add event</button></div>`}` };
}

views.calendar = () => {
  const m = new Date(C.month), sel = new Date(C.sel), today = dayOf(Date.now());
  const rel = Math.round((C.sel - today) / 864e5);
  const label = rel === 0 ? 'Today' : rel === 1 ? 'Tomorrow' : rel === -1 ? 'Yesterday' : sel.toLocaleDateString([], { weekday: 'long' });
  const list = dayList(C.sel);
  const errs = C.accounts.filter((a) => a.error || a.needsSignIn);
  const thisMonth = C.month === monthOf(Date.now()) && C.sel === today;
  return panel(`<div class="row">${backBtn()}
      <span class="f15" style="min-width:150px">${m.toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
      <button class="x" data-act="calMonth" data-arg="-1" aria-label="Previous month">${I.back}</button>
      <button class="x" data-act="calMonth" data-arg="1" aria-label="Next month" style="transform:scaleX(-1)">${I.back}</button>
      ${thisMonth ? '' : '<button class="chip" data-act="calToday" style="height:30px">Today</button>'}
      <span class="sp"></span>
      <button class="btn sm" data-act="calNew" style="padding:0 14px 0 10px;gap:4px">${I.plus} Add</button>
      ${hasAccounts() ? `<button class="x${C.syncing ? ' spin' : ''}" data-act="calSync" aria-label="Sync now" title="${C.syncedAt ? 'Synced ' + tm(C.syncedAt) : 'Sync'}">${I.sync}</button>` : ''}
      <button class="x" data-act="calSettings" aria-label="Calendar settings" title="Calendar settings">${I.gear}</button></div>
    <div class="cbody">
      ${monthGrid()}
      <div class="cday-col">
        <div class="row"><span class="sp"><span class="f15">${label}</span><span class="d f13"> · ${sel.toLocaleDateString([], { day: 'numeric', month: 'long', ...(sel.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })}</span></span>
          <span class="d f12">${list.count ? `${list.count} event${list.count === 1 ? '' : 's'}` : ''}</span></div>
        <div class="clist">${list.html}</div>
      </div>
    </div>
    ${!hasAccounts() && !C.local.length ? '<div class="d f12" style="padding:0 4px">Events you add stay on this PC. To see Google or Outlook events here too, connect them in Settings (optional).</div>' : ''}
    ${errs.length ? `<div class="f12" style="color:#ff9f0a;padding:0 4px">${esc(errs[0].email || errs[0].name || 'A calendar')}: ${esc(errs[0].needsSignIn ? 'sign in again in Settings.' : errs[0].error)}</div>` : ''}`, 820);
};
Object.assign(actions, {
  calPick(t) { C.sel = +t; if (monthOf(C.sel) !== C.month) C.month = monthOf(C.sel); render('calendar'); },
  calMonth(d) {
    const m = new Date(C.month); m.setMonth(m.getMonth() + +d); C.month = m.getTime();
    // Keep the same day number in the new month where it exists.
    const s = new Date(C.sel), last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    C.sel = new Date(m.getFullYear(), m.getMonth(), Math.min(s.getDate(), last)).getTime();
    render('calendar');
  },
  calToday() { C.sel = dayOf(Date.now()); C.month = monthOf(C.sel); render('calendar'); },
});


/* ---------------- heads-up before an event ---------------- */
views.eventSoon = () => {
  const { ev, phase } = C.alert;
  const left = ev.start - Date.now();
  return {
    html: `<div class="v texp" style="width:460px;gap:14px">
      <div class="row"><span class="ic" style="background:color-mix(in srgb, ${ev.color} 22%, transparent);color:${ev.color};border-radius:19px">${I.cal}</span>
        <div class="sp"><div class="f15 ell" style="font-size:17px">${esc(ev.title)}</div>
          <div class="d f12 ell"><span data-bind="calIn">${phase === 'now' || left <= 0 ? 'Starting now' : 'Starts ' + untilText(left)}</span> · ${tm(ev.start)}–${tm(ev.end)}${ev.location && !/^https?:/.test(ev.location) ? ' · ' + esc(ev.location) : ''}</div></div></div>
      <div class="row" style="gap:10px"><button class="btn f" data-act="calDismiss">Dismiss</button>
        ${ev.join ? `<button class="btn f join" data-act="calJoin">${I.video} ${joinLabel(ev.join)}</button>` : `<button class="btn f w" data-act="calFromAlert">Open calendar</button>`}</div></div>`,
    radius: 34,
    ring: { color: ev.color, rgb: hexRgb(ev.color) },
  };
};
function hexRgb(h) { const m = String(h).match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i); return m ? `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}` : '255,95,87'; }

function checkEvents() {
  const lead = (T.settings.calAlert == null ? 5 : T.settings.calAlert) * 6e4;
  const now = Date.now();
  if (C.alert) {
    const e = C.alert.ev;
    if (now > e.start + 5 * 6e4 || !allEvents().some((x) => x.id === e.id)) { C.alert = null; if (state.view === 'eventSoon') render(baseView()); return; }
    if (C.alert.phase === 'soon' && now >= e.start) C.alert.phase = 'now';
    const el = document.querySelector('[data-bind="calIn"]'); if (el) el.textContent = now >= e.start ? 'Starting now' : 'Starts ' + untilText(e.start - now);
    return;
  }
  if (!lead) return;
  const e = allEvents().find((x) => !x.allDay && x.start - lead <= now && now < x.start + 60e3 && !C.alerted.has(x.id + '@' + x.start));
  if (!e) return;
  C.alerted.add(e.id + '@' + e.start);
  store.set('calAlerted', [...C.alerted].slice(-200));
  C.alert = { ev: e, phase: now >= e.start ? 'now' : 'soon' };
  if (T.settings.chimes) alertChime();
  if (!CLOSABLE.has(state.view)) render('eventSoon');
}

Object.assign(actions, {
  calSync() { if (!host) return; C.syncing = true; render('calendar'); host.invoke('cal', { op: 'sync' }).then(applyCal); },
  calSettings() { post({ type: 'open-settings', section: 'calendar' }); render(baseView()); },
  calOpen(url) { if (host) host.invoke('cal', { op: 'open', url }); },
  calJoin() { const e = C.alert && C.alert.ev; C.alert = null; if (e && host) host.invoke('cal', { op: 'open', url: e.join }); render(baseView()); },
  calDismiss() { C.alert = null; render(baseView()); },
  calFromAlert() { C.alert = null; actions.calToday(); },
});

/* ---------------- reminders <-> Google Tasks / Microsoft To Do ---------------- */
const syncOn = () => !!(host && T.settings.reminderSync);
const taskChange = (remote, change) => { if (host && remote) host.invoke('cal', { op: 'task-change', remote, ...change }); };
const saveRem = () => store.set('reminders', T.reminders);

const coreAdd = actions.addReminder;
actions.addReminder = function () {
  const before = new Set(T.reminders.map((r) => r.id));
  coreAdd();
  const r = T.reminders.find((x) => !before.has(x.id));
  if (r && syncOn()) host.invoke('cal', { op: 'task-add', text: r.text, at: r.at }).then((remote) => { if (remote) { r.remote = remote; saveRem(); } });
};
const coreDel = actions.delReminder;
actions.delReminder = function (id) {
  const r = T.reminders.find((x) => x.id === id);
  coreDel(id);
  if (r && r.remote) { C.doneTasks.add(r.remote.task); store.set('calDoneTasks', [...C.doneTasks].slice(-300)); taskChange(r.remote, { delete: true }); }
};
const coreSnooze = actions.snoozeReminder;
actions.snoozeReminder = function () {
  const r = T.dueReminder;
  coreSnooze();
  const again = r && r.remote && T.reminders.find((x) => x.remote && x.remote.task === r.remote.task);
  if (again) taskChange(again.remote, { at: again.at });
};
const coreDone = actions.doneReminder;
actions.doneReminder = function () {
  const r = T.dueReminder;
  coreDone();
  if (r && r.remote) { C.doneTasks.add(r.remote.task); store.set('calDoneTasks', [...C.doneTasks].slice(-300)); taskChange(r.remote, { done: true }); }
};

/* Bring in tasks added on the phone / web, and drop ones finished there. */
function mergeTasks(tasks, accounts) {
  let changed = false;
  const now = Date.now();
  const live = new Set(tasks.map((t) => t.task));
  for (const t of tasks) {
    if (C.doneTasks.has(t.task)) continue;
    if (T.dueReminder && T.dueReminder.remote && T.dueReminder.remote.task === t.task) continue;
    const mine = T.reminders.find((r) => r.remote && r.remote.task === t.task);
    if (mine) { if (mine.text !== t.text || Math.abs(mine.at - t.at) > 60e3) { mine.text = t.text; mine.at = t.at; changed = true; } continue; }
    // Just added here and still being uploaded: link instead of adding it twice.
    const twin = T.reminders.find((r) => !r.remote && r.text === t.text && Math.abs(r.at - t.at) < 120e3);
    if (twin) { twin.remote = { account: t.account, list: t.list, task: t.task }; changed = true; continue; }
    T.reminders.push({ id: uid(), text: t.text, at: t.at, remote: { account: t.account, list: t.list, task: t.task } });
    changed = true;
  }
  const keep = T.reminders.filter((r) => !(r.remote && accounts.includes(r.remote.account) && !live.has(r.remote.task) && r.at > now + 60e3));
  if (keep.length !== T.reminders.length) { T.reminders = keep; changed = true; }
  if (changed) { saveRem(); if (state.view === 'reminders') render('reminders'); }
}

/* ---------------- updates from the main process ---------------- */
function applyCal(m) {
  if (!m || m.type !== 'calendar') return;
  C.events = m.events || []; C.accounts = m.accounts || []; C.syncedAt = m.syncedAt || 0; C.syncing = !!m.syncing;
  if (!m.syncing && Array.isArray(m.tasks) && T.settings.reminderSync) mergeTasks(m.tasks, (m.taskAccounts || []).filter((a) => a === T.settings.reminderSync));
  if (state.view === 'calendar') render('calendar');
  else if (state.view === 'sheet') render('sheet');
}
if (host) {
  host.onMessage((m) => { if (m.type === 'calendar') applyCal(m); });
  host.invoke('cal', { op: 'state' }).then(applyCal);
}

/* ---------------- plug into the island ---------------- */
const calBaseView = baseView;
baseView = function () {
  const b = calBaseView();
  if (C.alert && ['none', 'mediaCompact', 'timerCompact', 'agentCompact', 'focusCompact', 'swCompact', 'mediaPeek'].includes(b)) return 'eventSoon';
  return b;
};
RESTING.add('eventSoon');
CLOSABLE.add('calendar');
setInterval(checkEvents, 1000);
// Keep "in 12 min" and the Now marker fresh while the panel is open.
setInterval(() => { if (state.view === 'calendar' && !document.querySelector('#content :hover')) render('calendar'); }, 60e3);


/* ---------------- adding and editing events on this PC (no account needed) ---------------- */
const CAL_COLORS = ['#ff5f57', '#ff9f0a', '#ffd60a', '#30d158', '#4f9dff', '#bf8cff', '#ff6fae'];
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fromYmd = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const mins = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const hm = (n) => `${pad2(Math.floor(n / 60) % 24)}:${pad2(n % 60)}`;
function lenText(n) { const h = Math.floor(n / 60), m = n % 60; return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`; }
// What the editor holds: date "YYYY-MM-DD", start/end "HH:MM" (any minute), all day, colour, place.
function readEdit() {
  const e = C.edit; if (!e) return;
  const v = (id) => { const el = document.querySelector('#content #' + id); return el ? el.value : null; };
  e.title = v('calTitle') ?? e.title; e.where = v('calWhere') ?? e.where;
  const d = v('calDate'); if (d) e.date = d;
  const s = v('calStart'); if (s) e.start = s;
  const en = v('calEnd'); if (en) e.end = en;
}
const endsNextDay = (e) => mins(e.end) <= mins(e.start);
views.calEdit = () => {
  const e = C.edit;
  const len = (mins(e.end) - mins(e.start) + 1440) % 1440 || 1440;
  return panel(`${head(e.id ? 'Edit event' : 'New event', '', 'calendar')}
    <input class="field" id="calTitle" placeholder="Event name" value="${esc(e.title)}" maxlength="80">
    <div class="cform">
      <label>Date</label>
      <div class="row" style="gap:8px">
        <button class="x" data-act="calShift" data-arg="-1" aria-label="Day before">${I.back}</button>
        <input class="field cin" type="date" id="calDate" value="${e.date}">
        <button class="x" data-act="calShift" data-arg="1" aria-label="Day after" style="transform:scaleX(-1)">${I.back}</button>
        <span class="sp"></span>
        <span class="f13 m">All day</span>${toggle(e.allDay, 'calAllDay', '', 'All day')}
      </div>
      ${e.allDay ? '' : `<label>Time</label>
      <div class="row" style="gap:10px">
        <input class="field cin" type="time" id="calStart" value="${e.start}" aria-label="Starts">
        <span class="d">to</span>
        <input class="field cin" type="time" id="calEnd" value="${e.end}" aria-label="Ends">
        <span class="d f13" data-bind="calLen">${lenText(len)}${endsNextDay(e) ? ' · ends next day' : ''}</span>
      </div>
      <label></label>
      <div class="row" style="gap:6px;flex-wrap:wrap">${[15, 30, 45, 60, 90, 120, 180].map((n) => `<button class="chip sm${len === n ? ' on' : ''}" data-act="calLen" data-arg="${n}">${n < 60 ? n + ' min' : lenText(n)}</button>`).join('')}</div>`}
      <label>Place</label>
      <input class="field cin" id="calWhere" placeholder="Optional: a room, an address or a meeting link" value="${esc(e.where || '')}" maxlength="200" style="width:100%">
      <label>Colour</label>
      <div class="row" style="gap:10px">${CAL_COLORS.map((c) => `<button class="cdot${e.color === c ? ' on' : ''}" data-act="calColor" data-arg="${c}" style="background:${c}" aria-label="Colour"></button>`).join('')}</div>
    </div>
    <div class="row" style="gap:10px">${e.id ? '<button class="btn f" data-act="calDelete" style="color:#ff8a84">Delete</button>' : ''}
      <button class="btn f w" data-act="calSave">Save</button></div>`, 600);
};
Object.assign(actions, {
  calNew() {
    const n = new Date(), today = dayOf(Date.now());
    const start = C.sel === today ? Math.min(Math.ceil((n.getHours() * 60 + n.getMinutes() + 1) / 15) * 15, 23 * 60) : 9 * 60;
    C.edit = { id: '', title: '', date: ymd(C.sel), start: hm(start), end: hm(Math.min(start + 60, 23 * 60 + 59)), allDay: false, color: CAL_COLORS[4], where: '' };
    render('calEdit');
  },
  calEdit(id) {
    const e = C.local.find((x) => x.id === id); if (!e) return;
    const s = new Date(e.start), en = new Date(e.end);
    C.edit = { id, title: e.title, date: ymd(e.start), start: hm(s.getHours() * 60 + s.getMinutes()), end: hm(en.getHours() * 60 + en.getMinutes()), allDay: !!e.allDay,
      allDays: e.allDay ? Math.max(1, Math.round((e.end - e.start) / 864e5)) : 1, color: e.color, where: e.location || '' };
    render('calEdit');
  },
  calShift(d) { readEdit(); C.edit.date = ymd(addDays(fromYmd(C.edit.date), +d)); render('calEdit'); },
  calAllDay() { readEdit(); C.edit.allDay = !C.edit.allDay; render('calEdit'); },
  calLen(n) { readEdit(); C.edit.end = hm((mins(C.edit.start) + +n) % 1440); render('calEdit'); },
  calColor(c) { readEdit(); C.edit.color = c; render('calEdit'); },
  calSave() {
    readEdit(); const e = C.edit;
    if (!e.title.trim()) { const f = document.querySelector('#calTitle'); if (f) f.focus(); return; }
    const day = fromYmd(e.date);
    if (!day) return;
    let start, end;
    if (e.allDay) { start = day; end = addDays(day, e.allDays || 1); }
    else {
      start = day + mins(e.start) * 6e4;
      end = (endsNextDay(e) ? addDays(day, 1) : day) + mins(e.end) * 6e4;
    }
    const where = (e.where || '').trim();
    const ev = { id: e.id || 'local-' + uid(), title: e.title.trim(), start, end, allDay: !!e.allDay, color: e.color,
      location: /^https?:\/\//.test(where) ? '' : where, join: /^https?:\/\//.test(where) ? where : '' };
    C.local = [...C.local.filter((x) => x.id !== ev.id), ev];
    store.set('calEvents', C.local);
    C.sel = day; C.month = monthOf(day);
    C.edit = null; render('calendar');
  },
  calDelete() { C.local = C.local.filter((x) => x.id !== C.edit.id); store.set('calEvents', C.local); C.edit = null; render('calendar'); },
});
// Live "1 h 25 min" while the times are changed; Enter saves.
document.addEventListener('input', (ev) => {
  if (!C.edit || !/^cal(Start|End)$/.test(ev.target.id)) return;
  readEdit();
  const el = document.querySelector('[data-bind="calLen"]');
  const len = (mins(C.edit.end) - mins(C.edit.start) + 1440) % 1440 || 1440;
  if (el) el.textContent = lenText(len) + (endsNextDay(C.edit) ? ' · ends next day' : '');
  document.querySelectorAll('[data-act="calLen"]').forEach((b) => b.classList.toggle('on', +b.dataset.arg === len));
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && /^cal(Title|Where)$/.test(ev.target.id)) actions.calSave(); });
CLOSABLE.add('calEdit');
TYPING.add('calEdit');
