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
  day: 0,                                   // which day the Calendar panel shows (0 = today)
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

/* ---------------- the Calendar panel ---------------- */
views.calendar = () => {
  const now = Date.now();
  const strip = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(dayStart(i)), n = eventsOn(i).length;
    return `<button class="cday${C.day === i ? ' on' : ''}" data-act="calDay" data-arg="${i}" aria-label="${d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}">
      <span class="w">${i === 0 ? 'Today' : DAYS[d.getDay()]}</span><span class="n">${d.getDate()}</span><span class="dots">${'<i></i>'.repeat(Math.min(3, n))}</span></button>`;
  }).join('');
  const list = eventsOn(C.day);
  const allDay = list.filter((e) => e.allDay);
  const timed = list.filter((e) => !e.allDay);
  const rows = timed.map((e) => {
    const live = e.start <= now && e.end > now, past = e.end <= now;
    const soon = !past && e.start - now < 15 * 6e4;
    const sub = [e.location && !/^https?:\/\//.test(e.location) ? `${I.pin} ${esc(e.location)}` : '', esc(e.calendar)].filter(Boolean).join('<span class="d"> · </span>');
    return `<div class="cev${e.local ? ' mine' : ''}${past ? ' past' : ''}${live ? ' live' : ''}" style="--c:${esc(e.color)}"${e.local ? ` data-act="calEdit" data-arg="${e.id}"` : ''}>
      <div class="ct"><span>${tm(e.start)}</span><span class="d">${tm(e.end)}</span></div>
      <div class="sp"><div class="f14 ell" style="font-weight:600">${esc(e.title)}</div><div class="d f12 ell">${live ? '<b class="nowtag">Now</b> ' : ''}${sub}</div></div>
      ${e.join && !past ? `<button class="btn sm${live || soon ? ' join' : ''}" data-act="calOpen" data-arg="${esc(e.join)}">${I.video}${live || soon ? joinLabel(e.join) : ''}</button>` : ''}
    </div>`;
  }).join('');
  const d = new Date(dayStart(C.day));
  const label = C.day === 0 ? 'Today' : C.day === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long' });
  const errs = C.accounts.filter((a) => a.error || a.needsSignIn);
  return panel(`<div class="row">${backBtn()}<span class="f15 sp">${d.toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
      <button class="btn sm" data-act="calNew" style="padding:0 14px 0 10px;gap:4px">${I.plus} Add</button>
      ${hasAccounts() ? `<button class="x${C.syncing ? ' spin' : ''}" data-act="calSync" aria-label="Sync now" title="${C.syncedAt ? 'Synced ' + tm(C.syncedAt) : 'Sync'}">${I.sync}</button>` : ''}
      <button class="x" data-act="calSettings" aria-label="Calendar settings" title="Calendar settings">${I.gear}</button></div>
    <div class="cweek">${strip}</div>
    <div class="row" style="padding:0 4px"><span class="f13 sp" style="font-weight:600">${label}<span class="d" style="font-weight:400"> · ${d.toLocaleDateString([], { day: 'numeric', month: 'long' })}</span></span>
      <span class="d f12">${list.length ? `${list.length} event${list.length === 1 ? '' : 's'}` : ''}</span></div>
    ${allDay.length ? `<div class="row" style="gap:6px;flex-wrap:wrap">${allDay.map((e) => `<span class="callday" style="--c:${esc(e.color)}"${e.local ? ` data-act="calEdit" data-arg="${e.id}"` : ''}>${esc(e.title)}</span>`).join('')}</div>` : ''}
    <div class="clist">${rows || `<div class="m f13" style="padding:18px 4px;text-align:center">${allDay.length ? 'No meetings' : 'Nothing planned'} ${C.day === 0 ? 'today' : label === 'Tomorrow' ? 'tomorrow' : 'on ' + label}.</div>`}</div>
    ${!hasAccounts() && !C.local.length ? '<div class="d f12" style="padding:0 4px;text-align:center">Events you add stay on this PC. Want Google or Outlook events here too? Connect them in Settings (optional).</div>' : ''}
    ${errs.length ? `<div class="f12" style="color:#ff9f0a;padding:0 4px">${esc(errs[0].email || errs[0].name || 'A calendar')}: ${esc(errs[0].needsSignIn ? 'sign in again in Settings.' : errs[0].error)}</div>` : ''}`, 560);
};

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
  calDay(i) { C.day = +i; render('calendar'); },
  calSync() { if (!host) return; C.syncing = true; render('calendar'); host.invoke('cal', { op: 'sync' }).then(applyCal); },
  calSettings() { post({ type: 'open-settings', section: 'calendar' }); render(baseView()); },
  calOpen(url) { if (host) host.invoke('cal', { op: 'open', url }); },
  calJoin() { const e = C.alert && C.alert.ev; C.alert = null; if (e && host) host.invoke('cal', { op: 'open', url: e.join }); render(baseView()); },
  calDismiss() { C.alert = null; render(baseView()); },
  calFromAlert() { C.alert = null; C.day = 0; render('calendar'); },
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
const DURS = [[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 h'], [90, '1.5 h'], [120, '2 h'], [0, 'All day']];
views.calEdit = () => {
  const e = C.edit, start = e.day + e.h * 36e5 + e.m * 6e4;
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(dayStart(i));
    return `<button class="chip${e.day === dayStart(i) ? ' on' : ''}" data-act="calEDay" data-arg="${i}">${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `${DAYS[d.getDay()]} ${d.getDate()}`}</button>`;
  }).join('');
  return panel(`${head(e.id ? 'Edit event' : 'New event', '', 'calendar')}
    <input class="field" id="calTitle" placeholder="Event name" value="${esc(e.title)}" maxlength="80">
    <div class="row cdays" style="gap:6px;overflow-x:auto">${days}</div>
    ${e.dur ? `<div class="row" style="justify-content:center;gap:10px">
      <div class="col" style="align-items:center;gap:6px"><button class="ib" data-act="calStep" data-arg="h:1" aria-label="Hour later">${I.plus}</button>
        <span class="big" style="font-size:52px">${pad2(e.h)}</span><button class="ib" data-act="calStep" data-arg="h:-1" aria-label="Hour earlier">${I.minus}</button></div>
      <span class="big" style="font-size:46px;margin-top:-8px">:</span>
      <div class="col" style="align-items:center;gap:6px"><button class="ib" data-act="calStep" data-arg="m:5" aria-label="Five minutes later">${I.plus}</button>
        <span class="big" style="font-size:52px">${pad2(e.m)}</span><button class="ib" data-act="calStep" data-arg="m:-5" aria-label="Five minutes earlier">${I.minus}</button></div>
      <div class="col d f12" style="margin-left:18px;gap:4px"><span>Ends</span><b class="f15" style="color:#fff">${tm(start + e.dur * 6e4)}</b></div>
    </div>` : ''}
    <div class="row" style="gap:6px;flex-wrap:wrap">${DURS.map(([v, n]) => `<button class="chip${e.dur === v ? ' on' : ''}" data-act="calDur" data-arg="${v}">${n}</button>`).join('')}</div>
    <div class="row" style="gap:10px;padding:0 4px">${CAL_COLORS.map((c) => `<button class="cdot${e.color === c ? ' on' : ''}" data-act="calColor" data-arg="${c}" style="background:${c}" aria-label="Colour"></button>`).join('')}</div>
    <div class="row" style="gap:10px">${e.id ? '<button class="btn f" data-act="calDelete" style="color:#ff8a84">Delete</button>' : ''}
      <button class="btn f w" data-act="calSave">Save</button></div>`, 540);
};
const keepTitle = () => { if (C.edit) C.edit.title = readField('calTitle', C.edit.title); };
Object.assign(actions, {
  calNew() {
    const n = new Date(), next = Math.ceil((n.getHours() * 60 + n.getMinutes() + 1) / 30) * 30;
    const mins = C.day === 0 ? Math.min(next, 23 * 60 + 30) : 9 * 60;
    C.edit = { id: '', title: '', day: dayStart(C.day), h: Math.floor(mins / 60), m: mins % 60, dur: 60, color: CAL_COLORS[4] };
    render('calEdit');
  },
  calEdit(id) {
    const e = C.local.find((x) => x.id === id); if (!e) return;
    const s = new Date(e.start), day = new Date(s); day.setHours(0, 0, 0, 0);
    C.edit = { id, title: e.title, day: day.getTime(), h: s.getHours(), m: s.getMinutes(), dur: e.allDay ? 0 : Math.round((e.end - e.start) / 6e4), color: e.color };
    render('calEdit');
  },
  calEDay(i) { keepTitle(); C.edit.day = dayStart(+i); render('calEdit'); },
  calStep(arg) {
    keepTitle(); const [k, d] = arg.split(':'); const e = C.edit;
    if (k === 'h') e.h = (e.h + +d + 24) % 24; else e.m = (e.m + +d + 60) % 60;
    render('calEdit');
  },
  calDur(v) { keepTitle(); C.edit.dur = +v; render('calEdit'); },
  calColor(c) { keepTitle(); C.edit.color = c; render('calEdit'); },
  calSave() {
    keepTitle(); const e = C.edit;
    if (!e.title.trim()) { const f = document.querySelector('#calTitle'); if (f) f.focus(); return; }
    const allDay = e.dur === 0;
    const start = allDay ? e.day : e.day + e.h * 36e5 + e.m * 6e4;
    const end = allDay ? e.day + 864e5 : start + e.dur * 6e4;
    const ev = { id: e.id || 'local-' + uid(), title: e.title.trim(), start, end, allDay, color: e.color };
    C.local = [...C.local.filter((x) => x.id !== ev.id), ev];
    store.set('calEvents', C.local);
    C.day = Math.max(0, Math.min(6, Math.round((e.day - dayStart(0)) / 864e5)));
    C.edit = null; render('calendar');
  },
  calDelete() { C.local = C.local.filter((x) => x.id !== C.edit.id); store.set('calEvents', C.local); C.edit = null; render('calendar'); },
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'calTitle') actions.calSave(); });
// Events that ended over a month ago are tidied away.
C.local = C.local.filter((e) => e.end > Date.now() - 30 * 864e5);
CLOSABLE.add('calEdit');
TYPING.add('calEdit');
