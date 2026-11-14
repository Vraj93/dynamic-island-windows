'use strict';
/* Settings window. Every switch here maps to something the island really does;
 * values are saved by the main process (settings.json) and applied right away. */
const host = window.islandHost;
let S = {};
let section = 'general';
let claude = '';
let info = {};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toggle = (key, label, disabled) => `<button class="tg${S[key] ? ' on' : ''}" data-key="${key}" role="switch" aria-checked="${!!S[key]}" aria-label="${esc(label)}" ${disabled ? 'disabled' : ''}><i></i></button>`;
const item = (key, name, sub, disabled) => `<div class="item"><div class="t"><div class="n">${name}</div><div class="s">${sub}</div></div>${toggle(key, name, disabled)}</div>`;

const SECTIONS = {
  general: () => `<h1>General</h1><p class="lead">How the island behaves day to day.</p>
    <div class="card">
      ${item('hideFullscreen', 'Step aside for full-screen apps', 'While a video, game or slideshow is full screen, only alerts show (approvals, alarms, timers, reminders).')}
      ${item('chimes', 'Sounds', 'Chimes for timers, alarms, reminders, Focus and Claude Code.')}
      ${item('clipboard', 'Clipboard history', 'Remembers the last 25 pieces of text you copy. Kept in memory only, never saved to disk.')}
      ${item('startWithWindows', 'Start with Windows', 'Open the island when you sign in.')}
    </div>`,

  sheet: () => `<h1>Utility sheet</h1><p class="lead">The panel with the clock, battery and tools that drops down from the top edge.</p>
    <div class="card">
      ${item('edgeTrigger', 'Open when the mouse reaches the top edge', 'Rest the pointer at the top-centre of the main screen. The tray icon › Open utility sheet always works too.')}
      <div class="item"><div class="t"><div class="n">Hover delay</div><div class="s">How long the pointer rests on the edge before the sheet opens. Longer means fewer accidental openings.</div></div>
        <div class="seg">${[0, 150, 400].map((v) => `<button data-delay="${v}" class="${S.hoverDelay === v ? 'on' : ''}" ${S.edgeTrigger ? '' : 'disabled'}>${v ? v + ' ms' : 'None'}</button>`).join('')}</div></div>
    </div>`,

  media: () => `<h1>Media</h1><p class="lead">Spotify, YouTube in a browser, VLC and anything else Windows knows is playing.</p>
    <div class="card">
      ${item('media', 'Show what\'s playing', 'Cover and sound bars in the island while music or video plays. Right-click the island to hide the current song.')}
      ${item('mediaPeek', 'Announce new songs', 'A short "Now playing" pop-up with the bigger cover when the track changes.', !S.media)}
      ${item('liveBars', 'Sound bars follow the music', 'Listens to your PC\'s sound output (it stays on your PC) to move the bars. Off: a gentle animation instead.', !S.media)}
    </div>`,

  agents: () => {
    const on = /Installed/.test(claude);
    return `<h1>AI agents</h1><p class="lead">See what Claude Code is doing and answer its permission requests from the island.</p>
    <div class="card">
      ${item('agents', 'Show Claude Code in the island', 'Live step, approvals with Allow / Deny, and a "finished" summary. Off: Claude Code asks in its own window as usual.')}
      <div class="item"><div class="t"><div class="n">Connection</div>
        <div class="s"><span class="status"><span class="dot" style="background:${on ? '#30d158' : 'rgba(255,255,255,.3)'}"></span>${claude ? (on ? 'Connected: Claude Code sessions report to the island' : 'Not connected') : 'Checking…'}</span></div>
        <div class="s">Adds small hooks to your Claude Code settings (a backup is made first). Needs Node.js. If the island isn't running or you don't answer within 55 seconds, Claude Code shows its normal prompt.</div></div>
        <button class="btn ${on ? '' : 'primary'}" data-claude="${on ? 'disconnect' : 'connect'}">${on ? 'Disconnect' : 'Connect'}</button></div>
    </div>`;
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
        <ul class="plain"><li>Windows notifications in the island</li><li>Calendar (Google / Outlook)</li><li>Bluetooth and Wi-Fi pop-ups</li><li>Keyboard shortcut for the sheet, and showing on all screens</li></ul></div></div>
    </div>`,
};

function draw() {
  document.getElementById('main').innerHTML = SECTIONS[section]();
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.sec === section));
}

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-sec]');
  if (nav) { section = nav.dataset.sec; draw(); if (section === 'agents') refreshClaude(); return; }
  const tg = e.target.closest('.tg[data-key]');
  if (tg && !tg.disabled) { host.send({ type: 'set-setting', key: tg.dataset.key, value: !S[tg.dataset.key] }); return; }
  const d = e.target.closest('[data-delay]');
  if (d && !d.disabled) { host.send({ type: 'set-setting', key: 'hoverDelay', value: Number(d.dataset.delay) }); return; }
  const c = e.target.closest('[data-claude]');
  if (c) { c.disabled = true; c.textContent = 'Working…'; await host.invoke('claude-hooks', c.dataset.claude); await refreshClaude(); return; }
  const o = e.target.closest('[data-open]');
  if (o) host.send({ type: o.dataset.open === 'repo' ? 'open-repo' : 'open-data-folder' });
});

async function refreshClaude() { claude = await host.invoke('claude-hooks', 'status'); if (section === 'agents') draw(); }

host.onMessage((m) => { if (m.type === 'settings') { S = m.settings; draw(); } });
(async () => {
  S = await host.invoke('get-settings');
  info = await host.invoke('app-info');
  draw();
  refreshClaude();
})();
