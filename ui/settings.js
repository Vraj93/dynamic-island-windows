'use strict';
/* Settings window. Every switch here maps to something the island really does;
 * values are saved by the main process (settings.json) and applied right away. */
// Opened in a normal browser (README screenshots): sample values instead of the app's.
const host = window.islandHost || {
  send() {}, onMessage() {},
  invoke: async (c) => (c === 'get-settings' ? { edgeTrigger: true, hoverDelay: 150, media: true, mediaPeek: true, liveBars: true, agents: true, volumeKeys: true,
    hudVolume: true, hudBrightness: true, hudCaps: true, hudBattery: true, clipboard: true, chimes: true, hideFullscreen: true, startWithWindows: true, calAlert: 5, reminderSync: 'g',
    tiles: ['calendar', 'timer', 'alarm', 'focus', 'reminder', 'note', 'clipboard', 'shelf', 'convert'] }
    : c === 'cal' ? { type: 'calendar', syncedAt: Date.now(), signIn: { google: true, microsoft: true }, ownClients: {}, accounts: [
      { id: 'g', provider: 'google', email: 'you@gmail.com', calendars: [{ id: '1', name: 'Personal', color: '#4285f4', on: true }, { id: '2', name: 'Holidays', color: '#30d158', on: false }] },
      { id: 'm', provider: 'microsoft', email: 'you@outlook.com', calendars: [{ id: '3', name: 'Calendar', color: '#ff9f0a', on: true }] },
      { id: 'i', provider: 'ics', name: 'Uni timetable', calendars: [] }] }
    : c === 'app-info' ? { version: '0.1.1' } : c === 'claude-hooks' ? 'Installed for: UserPromptSubmit, PreToolUse'
    : c === 'agent-hooks' ? { 'claude-code': { name: 'Claude Code', installed: true, connected: true }, copilot: { name: 'GitHub Copilot CLI', installed: false, connected: false },
      gemini: { name: 'Gemini CLI', installed: true, connected: true }, cursor: { name: 'Cursor', installed: false, connected: false }, codex: { name: 'Codex CLI', installed: true, connected: false } }
    : null),
};
let S = {};
let section = (location.hash.match(/sec=(\w+)/) || [, 'general'])[1];
let claude = '';
let info = {};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toggle = (key, label, disabled) => `<button class="tg${S[key] ? ' on' : ''}" data-key="${key}" role="switch" aria-checked="${!!S[key]}" aria-label="${esc(label)}" ${disabled ? 'disabled' : ''}><i></i></button>`;
const item = (key, name, sub, disabled) => `<div class="item"><div class="t"><div class="n">${name}</div><div class="s">${sub}</div></div>${toggle(key, name, disabled)}</div>`;

// The nine tools of the utility sheet. Shown ones come first, in their sheet order; hidden ones after.
const TOOLS = {
  calendar: ['Calendar', '255,95,87'], timer: ['Timer', '255,159,10'], alarm: ['Alarm', '255,105,97'], stopwatch: ['Stopwatch (also inside Timer)', '255,214,10'],
  focus: ['Focus', '191,140,255'], reminder: ['Reminder', '255,111,174'], note: ['Note', '99,230,190'],
  clipboard: ['Clipboard', '100,210,255'], shelf: ['Shelf', '48,209,88'], convert: ['Convert', '64,200,224'],
};
const arrow = (d) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
function toolRows() {
  const shown = (S.tiles || []).filter((id) => TOOLS[id]);
  const hidden = Object.keys(TOOLS).filter((id) => !shown.includes(id));
  return [...shown, ...hidden].map((id) => {
    const on = shown.includes(id), i = shown.indexOf(id);
    const [name, rgb] = TOOLS[id];
    return `<div class="item tool${on ? '' : ' off'}">
      <span class="pos">${on ? i + 1 : ''}</span>
      <span class="sw" style="background:rgb(${rgb})"></span>
      <div class="t"><div class="n">${name}</div></div>
      <button class="mv" data-move="${id}:-1" aria-label="Move ${name} up" title="Move up" ${on && i > 0 ? '' : 'disabled'}>${arrow('M6 15l6-6 6 6')}</button>
      <button class="mv" data-move="${id}:1" aria-label="Move ${name} down" title="Move down" ${on && i < shown.length - 1 ? '' : 'disabled'}>${arrow('M6 9l6 6 6-6')}</button>
      <button class="tg${on ? ' on' : ''}" data-tool="${id}" role="switch" aria-checked="${on}" aria-label="Show ${name} in the sheet"><i></i></button>
    </div>`;
  }).join('');
}
const delayText = (ms) => (ms === 0 ? 'Instant' : ms < 1000 ? `${ms} ms` : `${+(ms / 1000).toFixed(2)} s`);
// Hover delay slider: the label follows while you drag; the value is saved when you let go.
document.addEventListener('input', (e) => {
  if (e.target.id !== 'delay') return;
  const v = Number(e.target.value);
  e.target.style.setProperty('--fill', `${(v / 1500) * 100}%`);
  document.getElementById('delayVal').textContent = delayText(v);
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'delay') return;
  S.hoverDelay = Number(e.target.value);
  host.send({ type: 'set-setting', key: 'hoverDelay', value: S.hoverDelay });
});
function setTiles(list) { host.send({ type: 'set-setting', key: 'tiles', value: list }); S.tiles = list; draw(); }

const SECTIONS = {
  general: () => `<h1>General</h1><p class="lead">How the island behaves day to day.</p>
    <div class="card">
      ${item('hideFullscreen', 'Step aside for full-screen apps', 'While a video, game or slideshow is full screen, only alerts show (approvals, alarms, timers, reminders).')}
      ${item('chimes', 'Sounds', 'Chimes for timers, alarms, reminders, Focus and Claude Code.')}
      ${item('clipboard', 'Clipboard history', 'Remembers the last 25 pieces of text you copy. Kept in memory only, never saved to disk.')}
      ${item('startWithWindows', 'Start with Windows', 'Open the island when you sign in.')}
    </div>`,

  sheet: () => `<h1>Utility sheet</h1><p class="lead">The panel with the clock, battery and tools that drops down from the top edge.</p>
    <div class="sec">Tools in the sheet</div>
    <div class="card">${toolRows()}</div>
    <div class="sec">Opening</div>
    <div class="card">
      ${item('edgeTrigger', 'Open when the mouse reaches the top edge', 'Rest the pointer at the top-centre of the main screen. The tray icon › Open utility sheet always works too.')}
      <div class="item"><div class="t"><div class="n">Hover delay</div><div class="s">How long the pointer rests on the edge before the sheet opens. Longer means fewer accidental openings.</div></div>
        <div class="slider"><input type="range" id="delay" min="0" max="1500" step="50" value="${S.hoverDelay}" aria-label="Hover delay"
          ${S.edgeTrigger ? '' : 'disabled'} style="--fill:${(S.hoverDelay / 1500) * 100}%"><span class="val" id="delayVal">${delayText(S.hoverDelay)}</span></div></div>
    </div>`,

  calendar: () => {
    const c = cal || { accounts: [], signIn: {}, ownClients: {} };
    const PROV = {
      google: ['Google', '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#ea4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.8 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285f4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.5 5.8c4.4-4 6.8-10 6.8-17.1z"/><path fill="#fbbc05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.8-6.1z"/><path fill="#34a853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6.1C6.6 42.6 14.6 48 24 48z"/></svg>'],
      microsoft: ['Microsoft', '<svg width="16" height="16" viewBox="0 0 23 23"><path fill="#f35325" d="M1 1h10v10H1z"/><path fill="#81bc06" d="M12 1h10v10H12z"/><path fill="#05a6f0" d="M1 12h10v10H1z"/><path fill="#ffba08" d="M12 12h10v10H12z"/></svg>'],
      ics: ['Calendar link', '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#bf8cff" stroke-width="2.2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>'],
    };
    const accts = c.accounts.map((a) => {
      const [kind, logo] = PROV[a.provider];
      const status = a.needsSignIn ? '<span style="color:#ff9f0a">Sign in again to keep syncing</span>' : a.error ? `<span style="color:#ff8a84">${esc(a.error)}</span>`
        : `<span class="status"><span class="dot" style="background:#30d158"></span>${c.syncedAt ? 'Synced ' + new Date(c.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Syncing…'}</span>`;
      const cals = a.provider === 'ics' ? '' : a.calendars.map((k) => `<div class="item sub"><span class="sw" style="background:${esc(k.color)}"></span><div class="t"><div class="n" style="font-weight:500">${esc(k.name)}</div></div>
        <button class="tg${k.on ? ' on' : ''}" data-cal="${a.id}" data-calid="${esc(k.id)}" role="switch" aria-checked="${k.on}" aria-label="Show ${esc(k.name)}"><i></i></button></div>`).join('');
      return `<div class="item"><span class="logo">${logo}</span><div class="t"><div class="n">${esc(a.email || a.name || kind)}</div><div class="s">${kind}${a.provider === 'ics' ? '' : a.provider === 'google' ? ' Calendar · Tasks' : ' Outlook · To Do'} · ${status}</div></div>
        ${a.needsSignIn ? `<button class="btn primary" data-login="${a.provider}">Sign in</button>` : ''}<button class="btn" data-remove="${a.id}">Remove</button></div>${cals}`;
    }).join('');
    const pending = calBusy ? `<div class="item"><div class="t"><div class="n">${esc(calBusy)}</div><div class="s">Finish signing in in the browser window that opened. The island never sees your password.</div></div><button class="btn" data-cancel-login>Cancel</button></div>` : '';
    const lead = S.calAlert == null ? 5 : S.calAlert;
    const syncTo = c.accounts.filter((a) => a.provider !== 'ics');
    return `<h1>Calendar</h1><p class="lead">The calendar works on its own: add events from the island's Calendar tool and they stay on this PC, with a heads-up before each one. Connecting an account is optional. It adds your Google or Outlook events (with a Join button for Meet, Teams and Zoom), and can sync reminders with Google Tasks or Microsoft To Do so they reach your phone.</p>
    <div class="sec">Accounts (optional)</div>
    <div class="card">${accts || '<div class="item"><div class="t"><div class="s">No calendars connected yet.</div></div></div>'}${pending}</div>
    <div class="row-btns">
      <button class="btn big" data-login="google">${PROV.google[1]} Sign in with Google</button>
      <button class="btn big" data-login="microsoft">${PROV.microsoft[1]} Sign in with Microsoft</button>
      <button class="btn big" data-addlink>${PROV.ics[1]} Add calendar link</button>
    </div>
    ${calError ? `<p class="lead" style="color:#ff8a84;margin:12px 0 0">${esc(calError)}</p>` : ''}
    ${linkOpen ? `<div class="card" style="margin-top:12px"><div class="item" style="flex-wrap:wrap;gap:10px">
      <input class="input" id="icsUrl" placeholder="https://… or webcal://… (.ics)" style="flex:1 1 340px">
      <input class="input" id="icsName" placeholder="Name (optional)" style="width:170px" maxlength="40">
      <button class="btn primary" data-savelink>Add</button></div>
      <div class="item"><div class="t"><div class="s">Google Calendar: Settings › your calendar › <b>Secret address in iCal format</b>. Outlook: Settings › Calendar › Shared calendars › <b>Publish a calendar</b> › ICS. Apple iCloud: share the calendar as a <b>Public Calendar</b>. Links are read-only and refresh every 5 minutes.</div></div></div></div>` : ''}
    <div class="sec">Options</div>
    <div class="card">
      <div class="item"><div class="t"><div class="n">Heads-up before events</div><div class="s">The island shows the event, with Join for online meetings.</div></div>
        <div class="seg">${[[0, 'Off'], [1, '1 min'], [5, '5 min'], [10, '10 min'], [15, '15 min']].map(([v, n]) => `<button class="${lead === v ? 'on' : ''}" data-calalert="${v}">${n}</button>`).join('')}</div></div>
      <div class="item"><div class="t"><div class="n">Sync reminders with</div><div class="s">Reminders you add in the island appear in that account's tasks, and tasks with a time from your phone show up here. Finishing one on either side finishes it everywhere.</div></div>
        <select class="input" id="remSync" style="width:240px" ${syncTo.length ? '' : 'disabled'}>
          <option value="">This PC only</option>${syncTo.map((a) => `<option value="${a.id}" ${S.reminderSync === a.id ? 'selected' : ''}>${esc(a.email)} (${a.provider === 'google' ? 'Google Tasks' : 'To Do'})</option>`).join('')}</select></div>
    </div>
    <details class="adv"${advOpen ? ' open' : ''}><summary>Advanced: your own sign-in app IDs</summary>
      <p class="lead" style="margin:10px 0 12px">Google and Microsoft sign-in use the app IDs built into this copy${c.signIn.google && c.signIn.microsoft ? '' : ' (not all are set in this build)'}. You can use your own instead: see "Calendar sign-in" in the README on GitHub for the 5-minute setup.</p>
      <div class="card">
        <div class="item" style="flex-wrap:wrap;gap:10px"><div class="t" style="flex-basis:100%"><div class="n">Google ${c.signIn.google ? '<span class="d">· ready</span>' : '<span style="color:#ff9f0a">· not set</span>'}</div></div>
          <input class="input" id="gId" placeholder="Client ID (….apps.googleusercontent.com)" value="${esc(c.ownClients.google)}" style="flex:1 1 300px">
          <input class="input" id="gSecret" placeholder="Client secret" type="password" style="width:200px">
          <button class="btn" data-client="google">Save</button></div>
        <div class="item" style="flex-wrap:wrap;gap:10px"><div class="t" style="flex-basis:100%"><div class="n">Microsoft ${c.signIn.microsoft ? '<span class="d">· ready</span>' : '<span style="color:#ff9f0a">· not set</span>'}</div></div>
          <input class="input" id="mId" placeholder="Application (client) ID" value="${esc(c.ownClients.microsoft)}" style="flex:1 1 300px">
          <button class="btn" data-client="microsoft">Save</button></div>
      </div></details>`;
  },

  media: () => `<h1>Media</h1><p class="lead">Spotify, YouTube in a browser, VLC and anything else Windows knows is playing.</p>
    <div class="card">
      ${item('media', 'Show what\'s playing', 'Cover and sound bars in the island while music or video plays. Right-click the island to hide the current song.')}
      ${item('mediaPeek', 'Announce new songs', 'A short "Now playing" pop-up with the bigger cover when the track changes.', !S.media)}
      ${item('liveBars', 'Sound bars follow the music', 'Listens to your PC\'s sound output (it stays on your PC) to move the bars. Off: a gentle animation instead.', !S.media)}
    </div>`,

  agents: () => {
    // What each agent can do with the island (from what its hooks support).
    const CAN = {
      'claude-code': 'Live steps, Allow / Deny from the island, finished summary.',
      copilot: 'Live steps, Allow / Deny from the island, finished.',
      gemini: 'Live steps, finished, and a "needs you" alert (answer in Gemini).',
      cursor: 'Steps as they finish, and finished.',
      codex: 'Tells you when a turn has finished, with its answer.',
    };
    const rows = agentStatus ? Object.entries(agentStatus).map(([id, a]) => `
      <div class="item"><div class="t"><div class="n">${esc(a.name)}</div>
        <div class="s"><span class="status"><span class="dot" style="background:${a.connected ? '#30d158' : 'rgba(255,255,255,.3)'}"></span>${a.connected ? 'Connected' : a.installed ? 'Installed, not connected' : 'Not found on this PC'}</span> · ${CAN[id]}</div>
        ${agentError[id] ? `<div class="s" style="color:#ff8a84">${esc(agentError[id])}</div>` : ''}</div>
        <button class="btn ${a.connected ? '' : 'primary'}" data-agent="${id}" data-cmd="${a.connected ? 'disconnect' : 'connect'}" ${a.installed || a.connected ? '' : 'disabled style="opacity:.4"'}>${a.connected ? 'Disconnect' : 'Connect'}</button></div>`).join('')
      : '<div class="item"><div class="t"><div class="s">Checking which agents are on this PC…</div></div></div>';
    return `<h1>AI agents</h1><p class="lead">See what your coding agents are doing, and answer permission requests from the island.</p>
    <div class="card">${item('agents', 'Show AI agents in the island', 'Off: agents ask in their own windows as usual.')}</div>
    <div class="sec">Agents</div>
    <div class="card">${rows}</div>
    <p class="lead" style="margin-top:14px">Connecting adds small hooks to that agent's own settings (a backup is made first); nothing else needs installing. They never slow the agent down, and if the island isn't running, or you don't answer within 55 seconds, the agent asks you as usual.</p>`;
  },

  popups: () => `<h1>System pop-ups</h1><p class="lead">Short pop-ups in the island for system changes. Each shows for about two seconds.</p>
    <div class="card">
      ${item('volumeKeys', 'Island handles the volume keys', 'Changes the volume itself so Windows\' own volume pop-up doesn\'t appear as well. Off: Windows handles the keys.')}
      ${item('hudVolume', 'Volume', 'Level bar when the volume changes or you mute.')}
      ${item('hudBrightness', 'Brightness', 'Level bar when a laptop screen\'s brightness changes.')}
      ${item('hudCaps', 'Caps Lock', 'Shows when Caps Lock turns on or off.')}
      ${item('hudBattery', 'Charger and low battery', 'Charging / on battery when you plug in or unplug, and a warning at 15% and 5%.')}
    </div>`,

  about: () => `<h1>About</h1><p class="lead">Dynamic Island for Windows${info.version ? ' · version ' + esc(info.version) : ''}.</p>
    <div class="card">
      <div class="item"><div class="t"><div class="n">License</div><div class="s">MIT: free to use, change and share.</div></div><button class="btn" data-open="repo">GitHub page</button></div>
      <div class="item"><div class="t"><div class="n">Your data</div><div class="s">Settings, alarms, reminders, your note and the shelf list are stored on this PC only.</div></div><button class="btn" data-open="data">Open folder</button></div>
      <div class="item"><div class="t"><div class="n">Not built yet</div>
        <ul class="plain"><li>Windows notifications in the island</li><li>Bluetooth and Wi-Fi pop-ups</li><li>Keyboard shortcut for the sheet, and showing on all screens</li></ul></div></div>
    </div>`,
};

function draw() {
  document.getElementById('main').innerHTML = SECTIONS[section]();
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.sec === section));
}

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-sec]');
  if (nav) { section = nav.dataset.sec; draw(); if (section === 'agents') refreshClaude(); return; }
  const tool = e.target.closest('[data-tool]');
  if (tool) {
    const id = tool.dataset.tool, list = (S.tiles || []).slice();
    setTiles(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]); // turning one on adds it at the end
    return;
  }
  const mv = e.target.closest('[data-move]');
  if (mv && !mv.disabled) {
    const [id, d] = mv.dataset.move.split(':'), list = (S.tiles || []).slice(), i = list.indexOf(id), j = i + Number(d);
    if (i >= 0 && j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; setTiles(list); }
    return;
  }
  const tg = e.target.closest('.tg[data-key]');
  if (tg && !tg.disabled) { host.send({ type: 'set-setting', key: tg.dataset.key, value: !S[tg.dataset.key] }); return; }
  const ag = e.target.closest('[data-agent]');
  if (ag && !ag.disabled) {
    ag.disabled = true; ag.textContent = 'Working…';
    const r = await host.invoke('agent-hooks', { cmd: ag.dataset.cmd, agent: ag.dataset.agent });
    agentError[ag.dataset.agent] = r && r.ok === false ? r.error : '';
    await refreshClaude();
    return;
  }
  // ----- calendar -----
  const lg = e.target.closest('[data-login]');
  if (lg && !calBusy) {
    const p = lg.dataset.login;
    calError = ''; calBusy = `Waiting for ${p === 'google' ? 'Google' : 'Microsoft'} sign-in…`; draw();
    const r = await host.invoke('cal', { op: 'login', provider: p });
    calBusy = '';
    if (r) { cal = r; if (r.ok === false) { calError = r.error; if (r.code === 'NO_CLIENT') advOpen = true; } }
    draw();
    return;
  }
  if (e.target.closest('[data-cancel-login]')) { await host.invoke('cal', { op: 'cancel-login' }); return; }
  if (e.target.closest('[data-addlink]')) { linkOpen = !linkOpen; calError = ''; draw(); if (linkOpen) document.getElementById('icsUrl').focus(); return; }
  const sl = e.target.closest('[data-savelink]');
  if (sl) {
    sl.disabled = true; sl.textContent = 'Checking…';
    const r = await host.invoke('cal', { op: 'add-link', url: document.getElementById('icsUrl').value, name: document.getElementById('icsName').value });
    if (r) { cal = r; calError = r.ok === false ? r.error : ''; if (r.ok) linkOpen = false; }
    draw();
    return;
  }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const a = cal && cal.accounts.find((x) => x.id === rm.dataset.remove);
    if (a && confirm(`Remove ${a.email || a.name || 'this calendar'} from the island?`)) {
      if (S.reminderSync === a.id) host.send({ type: 'set-setting', key: 'reminderSync', value: '' });
      cal = await host.invoke('cal', { op: 'remove', id: a.id }); draw();
    }
    return;
  }
  const ct = e.target.closest('[data-cal]');
  if (ct) { ct.classList.toggle('on'); cal = await host.invoke('cal', { op: 'toggle-calendar', id: ct.dataset.cal, calendar: ct.dataset.calid }); draw(); return; }
  const ca = e.target.closest('[data-calalert]');
  if (ca) { host.send({ type: 'set-setting', key: 'calAlert', value: Number(ca.dataset.calalert) }); return; }
  const cl = e.target.closest('[data-client]');
  if (cl) {
    const p = cl.dataset.client;
    cal = await host.invoke('cal', { op: 'set-client', provider: p, clientId: document.getElementById(p === 'google' ? 'gId' : 'mId').value,
      clientSecret: p === 'google' ? document.getElementById('gSecret').value : '' });
    calError = ''; advOpen = true; draw();
    return;
  }
  const o = e.target.closest('[data-open]');
  if (o) host.send({ type: o.dataset.open === 'repo' ? 'open-repo' : 'open-data-folder' });
});

let agentStatus = null;
const agentError = {};
async function refreshClaude() { agentStatus = await host.invoke('agent-hooks', { cmd: 'status' }); if (section === 'agents') draw(); }

document.addEventListener('change', (e) => {
  if (e.target.id === 'remSync') host.send({ type: 'set-setting', key: 'reminderSync', value: e.target.value });
});
document.addEventListener('toggle', (e) => { if (e.target.classList && e.target.classList.contains('adv')) advOpen = e.target.open; }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target.id === 'icsUrl' || e.target.id === 'icsName')) document.querySelector('[data-savelink]').click(); });

let cal = null, calBusy = '', calError = '', linkOpen = false, advOpen = false;
// Don't redraw under the user's typing (calendar links, app IDs).
const typing = () => document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
host.onMessage((m) => {
  if (m.type === 'settings') { S = m.settings; if (!typing()) draw(); }
  else if (m.type === 'calendar') { cal = m; if (section === 'calendar' && !typing()) draw(); }
  else if (m.type === 'section' && SECTIONS[m.section]) { section = m.section; draw(); }
});
(async () => {
  S = await host.invoke('get-settings');
  info = await host.invoke('app-info');
  cal = await host.invoke('cal', { op: 'state' });
  if (!SECTIONS[section]) section = 'general';
  draw();
  refreshClaude();
})();
