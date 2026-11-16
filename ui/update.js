'use strict';
/* Dynamic Isle: "update ready". When a new version has downloaded in the background (electron/main.js), a small
 * island offers to restart into it. Shown once per version, only while nothing else is on; it also installs by
 * itself the next time the app closes. Loaded after privacy.js. */
state.update = null;        // { status, version, ... } from the main process
let updateHiddenFor = '';   // version whose pill you closed
I.upd = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

views.updateReady = () => ({
  html: `<div class="v compact" style="gap:10px;padding-right:8px">
    <span class="callic" style="background:rgba(48,209,88,.18);color:#30d158">${I.upd}</span>
    <span class="f13" style="font-weight:600">Dynamic Isle ${esc(state.update.version || '')} is ready</span>
    <button class="btn sm w" data-act="updateInstall" style="height:28px;padding:0 12px">Restart</button>
    <button class="callmute" data-act="updateLater" aria-label="Later" title="Later (it installs when the app closes)">${I.close}</button>
  </div>`,
  radius: 19,
});
Object.assign(actions, {
  updateInstall() { if (host) host.invoke('update-install'); },
  updateLater() { updateHiddenFor = (state.update && state.update.version) || ''; render(baseView()); },
});

const updBaseView = baseView;
baseView = function () {
  const b = updBaseView();
  const u = state.update;
  if (b === 'none' && u && u.status === 'ready' && u.version !== updateHiddenFor && !(state.fullscreen && prefs.hideFullscreen)) return 'updateReady';
  return b;
};
RESTING.add('updateReady');

if (host) {
  host.onMessage((m) => { if (m.type === 'update') { state.update = m; if (RESTING.has(state.view)) render(baseView()); } });
  host.invoke('update-state').then((u) => { if (u && u.status) state.update = u; });
}
