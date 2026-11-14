'use strict';
/* Dynamic Island: calls and privacy.
 *  - A call timer while any app is using the microphone, with a mute button.
 *  - Ctrl+Alt+M (changeable in Settings) mutes the microphone in Windows itself, so in every app at once.
 *  - Coloured dots while the microphone (orange), camera (green) or screen capture (blue) is in use.
 * Who is using what comes from Windows' own privacy records, read by electron/media.ps1. Loaded after calendar.js. */
I.mic = (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/></svg>`;
I.micOff = (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9.5V5.5a3 3 0 0 0-5.7-1.3M9 9v2.5a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3.5M3 3l18 18"/></svg>`;
I.cam = (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="13" height="12" rx="3"/><path d="M15.5 10.5 21 7.5v9l-5.5-3"/></svg>`;
I.screen = (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M8.5 20.5h7M12 16.5v4"/></svg>`;

Object.assign(prefs, { callTimer: true, privacyDots: true, micKey: 'Ctrl+Alt+M' });
state.priv = { mic: [], cam: [], screen: [], micMuted: -1 };
state.micHud = 0;
let callHidden = '';                     // a call you closed stays hidden until the next one

const CALL_MIN_MS = 3000;                // ignore quick blips (voice typing, a site checking the mic)
const PDOT = { mic: '#ff9f0a', cam: '#30d158', screen: '#4c9cff' };
function call() {
  const now = Date.now();
  const users = (state.priv.mic || []).filter((u) => now - u.since > CALL_MIN_MS);
  if (!users.length) return null;
  const first = users.reduce((a, b) => (b.since < a.since ? b : a));
  return { app: first.app, since: first.since, others: users.length - 1, key: users.map((u) => u.app + u.since).join() };
}
const inUse = () => ['mic', 'cam', 'screen'].filter((k) => (state.priv[k] || []).length);
const appsOf = (k) => [...new Set((state.priv[k] || []).map((u) => u.app))].join(', ');
const muted = () => state.priv.micMuted === 1;

views.callCompact = () => {
  const c = call();
  if (!c) return views.none();
  const m = muted();
  return {
    html: `<div class="v compact" style="gap:10px">
      <span class="callic${m ? ' off' : ''}">${m ? I.micOff(14) : I.mic(14)}</span>
      <span class="f13 ell" style="font-weight:600;max-width:150px">${esc(c.app)}${c.others ? ` +${c.others}` : ''}</span>
      <span class="f13 tn" style="font-weight:600;color:${m ? '#ff6b6b' : '#30d158'}" data-bind="callClock" data-since="${c.since}">${fmtClock(Date.now() - c.since)}</span>
      ${(state.priv.cam || []).length ? `<span style="color:${PDOT.cam};display:flex">${I.cam(14)}</span>` : ''}
      ${(state.priv.screen || []).length ? `<span style="color:${PDOT.screen};display:flex">${I.screen(14)}</span>` : ''}
      <button class="callmute${m ? ' on' : ''}" data-act="micToggle" aria-label="${m ? 'Unmute microphone' : 'Mute microphone'}" title="${m ? 'Unmute' : 'Mute'} (${esc(prefs.micKeyActive || prefs.micKey || '')})">${m ? I.micOff(14) : I.mic(14)}</button>
    </div>`,
    radius: 19,
  };
};
views.callExpanded = () => {
  const c = call();
  if (!c) return views.none();
  const m = muted();
  const row = (k, icon, label) => (state.priv[k] || []).length
    ? `<div class="row f13" style="gap:10px"><span style="color:${PDOT[k]};display:flex">${icon}</span><span class="sp">${label}</span><span class="d ell" style="max-width:220px">${esc(appsOf(k))}</span></div>` : '';
  return {
    html: `<div class="v texp" style="width:460px;gap:16px">
      <div class="row"><span class="callic big${m ? ' off' : ''}">${m ? I.micOff(20) : I.mic(20)}</span>
        <div class="sp"><div class="f15">On a call</div><div class="d f12 ell">${esc(appsOf('mic'))}</div></div>
        <button class="x" data-act="callHide" aria-label="Hide until the next call" title="Hide until the next call">${I.close}</button></div>
      <div class="aclock tn" style="font-size:60px" data-bind="callClock" data-since="${c.since}">${fmtClock(Date.now() - c.since)}</div>
      <div style="display:flex;flex-direction:column;gap:8px">${row('mic', I.mic(14), 'Microphone')}${row('cam', I.cam(14), 'Camera')}${row('screen', I.screen(14), 'Screen capture')}</div>
      <button class="btn${m ? ' w' : ''}" data-act="micToggle" style="width:100%;height:48px;${m ? '' : 'background:#ff453a;color:#fff'}">${m ? I.mic(16) + ' Unmute microphone' : I.micOff(16) + ' Mute microphone'}</button>
      <div class="d f12" style="text-align:center">${prefs.micKeyActive || prefs.micKey ? `${esc(prefs.micKeyActive || prefs.micKey)} mutes or unmutes your microphone in every app.` : 'Set a mute key in Settings › System pop-ups.'}</div>
    </div>`,
    radius: 34,
    ring: m ? null : { color: '#30d158', rgb: '48,209,88' },
  };
};
// Camera or screen capture in use with nothing else showing: a small pill with the dots and who it is.
views.privPill = () => {
  const ks = inUse().filter((k) => k !== 'mic' || !call());
  if (!ks.length) return views.none();
  const icon = { mic: I.mic(13), cam: I.cam(13), screen: I.screen(13) };
  return {
    html: `<div class="v compact" style="gap:12px">${ks.map((k) => `<span class="row" style="gap:6px;color:${PDOT[k]}">${icon[k]}<span class="f12 ell" style="font-weight:600;color:#fff;max-width:120px">${esc(appsOf(k))}</span></span>`).join('')}</div>`,
    radius: 19,
  };
};
views.micHud = () => {
  const m = muted();
  return {
    html: `<div class="v hudv"><span class="callic${m ? ' off' : ''}">${m ? I.micOff(15) : I.mic(15)}</span><span class="f14" style="font-weight:600">Microphone ${m ? 'muted' : 'on'}</span>
      <span class="d f12">in every app</span></div>`,
    radius: 23,
  };
};

Object.assign(actions, {
  micToggle() { post({ type: 'media-cmd', cmd: 'mic toggle' }); state.micHud = Date.now(); },
  callHide() { const c = call(); callHidden = c ? c.key : ''; render(baseView()); },
});

/* ---------------- the dots on the island ---------------- */
const pdots = document.createElement('div');
pdots.className = 'pdots';
island.appendChild(pdots);
function drawDots() {
  const ks = prefs.privacyDots ? inUse() : [];
  const hide = !ks.length || ['none', 'privPill', 'callCompact', 'callExpanded', 'micHud', 'hud'].includes(state.view);
  pdots.innerHTML = hide ? '' : ks.map((k) => `<i style="background:${PDOT[k]}" title="${k === 'mic' ? 'Microphone' : k === 'cam' ? 'Camera' : 'Screen capture'}: ${esc(appsOf(k))}"></i>`).join('');
}

/* ---------------- what the island shows ---------------- */
const privBaseView = baseView;
baseView = function () {
  const b = privBaseView();
  if (Date.now() - state.micHud < 1600 && !['hud', 'agentAlert', 'alarmRing', 'reminderDue', 'eventSoon', 'timerDone'].includes(b)) return 'micHud';
  const c = prefs.callTimer && call();
  // A call beats music, timers and agent status; alerts (approvals, alarms...) still come first.
  if (c && c.key !== callHidden && ['none', 'mediaCompact', 'timerCompact', 'agentCompact', 'focusCompact', 'swCompact', 'mediaPeek'].includes(b)) return 'callCompact';
  if (b === 'none' && prefs.privacyDots && inUse().filter((k) => k !== 'mic' || !call()).length) return 'privPill';
  return b;
};
['callCompact', 'privPill', 'micHud'].forEach((v) => RESTING.add(v));
CLOSABLE.add('callExpanded');
content.addEventListener('click', (e) => {
  if (e.target.closest('[data-act]')) return;
  if (state.view === 'callCompact') render('callExpanded');
});

const corePriv = render;
render = function (name, opts) { corePriv(name, opts); drawDots(); };

if (host) {
  host.onMessage((m) => {
    if (m.type === 'privacy') {
      const was = muted();
      const real = (l) => (Array.isArray(l) ? l : []).filter((u) => u && u.app && u.since > 0);
      state.priv = { mic: real(m.mic), cam: real(m.cam), screen: real(m.screen), micMuted: m.micMuted };
      if (!call()) callHidden = '';
      if (was !== muted() && state.micHud && Date.now() - state.micHud < 3000) state.micHud = Date.now(); // show the new state
      if (state.view === 'callExpanded') render(call() ? 'callExpanded' : baseView());
      else if (state.view === 'micHud' || state.view === 'callCompact') render(state.view);
      else refreshResting();
      drawDots();
    } else if (m.type === 'mic-key-active') {
      prefs.micKeyActive = m.key || '';
    } else if (m.type === 'mic-key') {
      state.micHud = Date.now();
    }
  });
}
setInterval(() => {
  document.querySelectorAll('[data-bind="callClock"]').forEach((e) => { e.textContent = fmtClock(Date.now() - +e.dataset.since); });
  // A call that has just passed the 3-second mark, or the mute pop-up ending.
  if (RESTING.has(state.view)) { const want = baseView(); if (want !== state.view) render(want); }
}, 1000);
