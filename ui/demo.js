'use strict';
/* Demo mode, for README screenshots: open ui/index.html#demo=<scene> in a normal browser (not the app).
 * Shows one island screen with sample data on a desktop wallpaper. Does nothing inside the real app.
 * scripts/screenshots.ps1 uses it to capture every scene. */
(() => {
  if (window.islandHost) return;
  const scene = (location.hash.match(/demo=([\w-]+)/) || [, 'sheet'])[1];
  document.body.classList.add('demo');
  // Optional: &tiles=note,timer,convert shows only those tools, in that order.
  const tl = location.hash.match(/tiles=([\w,]+)/);
  if (tl) prefs.tiles = tl[1].split(',');

  const cover = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#ff8a4c"/><stop offset=".55" stop-color="#e23b6a"/><stop offset="1" stop-color="#4a1670"/></linearGradient></defs>
    <rect width="300" height="300" fill="url(#g)"/><circle cx="200" cy="105" r="48" fill="#ffe08a"/>
    <path d="M0 230 L70 165 L120 210 L190 140 L300 215 L300 300 L0 300Z" fill="#2a0b45"/></svg>`);
  const now = Date.now();
  state.battery = { has: true, percent: 76, charging: true };
  const music = () => {
    state.media = { active: true, source: 'Spotify.exe', title: 'Midnight Drive', artist: 'Lo-Fi Collective', album: 'Night Shift',
      status: 'Playing', canNext: true, canPrev: true, canSeek: true, position: 84, duration: 221, updatedAt: now, art: cover,
      sessions: [{ id: 'Spotify.exe', status: 'Playing' }] };
    state.mediaColor = '255,110,95';
    document.documentElement.style.setProperty('--mc', state.mediaColor);
  };
  const agent = (status) => state.agents.set('demo', {
    id: 'demo', project: 'DynamicIsland', title: 'Add media controls to the island', status,
    step: 'Running Typecheck the project', startedAt: now - 68000, doneAt: status === 'done' ? now : 0, updated: now,
    feed: [{ tool: 'Read', text: 'Island.tsx' }, { tool: 'Edit', text: 'Media.tsx' }, { tool: 'Bash', text: 'npm run typecheck' }],
    answer: 'Added play/pause, next and previous to the expanded player and connected them to Windows media controls. Typecheck passes.',
  });
  const timer = (leftSec) => { state.timer = { total: 600, endAt: now + leftSec * 1000, pausedLeft: null, done: false }; };

  const scenes = {
    sheet() { music(); render('sheet'); },
    netflix() {
      music();
      Object.assign(state.media, { source: 'Chrome', title: 'Netflix', artist: '', album: '', art: null, duration: 0 });
      render('sheet');
    },
    player() { music(); render('mediaExpanded'); },
    compact() { music(); timer(272); render('mediaCompact'); },
    agent() { agent('working'); render('agentCompact'); },
    approval() { agent('working'); state.approvals.push({ reqId: 'x', session: 'demo', tool: 'Bash', input: { command: 'npm install electron --save-dev' } }); render('approvalExpanded'); },
    finished() { agent('done'); state.focusAgent = 'demo'; render('agentExpanded'); },
    timer() { timer(272); render('timerExpanded'); },
    timersetup() { render('timerSetup'); },
    stopwatch() { T.sw = { running: true, start: now - 72400, acc: 0, laps: [31200, 28900] }; render('stopwatch'); },
    timesup() { state.timer = { total: 600, endAt: now, pausedLeft: 0, done: true }; render('timerDone'); },
    volume() { state.hud = { kind: 'volume', value: 62, muted: false }; render('hud'); },
    focus() { T.focus = { phase: 'focus', session: 2, total: 1500, endAt: now + 1100000, pausedLeft: null }; render('focusView'); },
    reminders() {
      T.reminders = [{ id: 'a', text: 'Call mom', at: now + 20 * 6e4 }, { id: 'b', text: 'Stretch break', at: now + 75 * 6e4 }];
      T.remDraft = 'team standup at 10am'; render('reminders');
    },
    alarm() {
      T.alarms = [{ id: '1', h: 7, m: 0, label: 'Wake up', days: [1, 2, 3, 4, 5], on: true }, { id: '2', h: 8, m: 30, label: '', days: [0, 6], on: true },
        { id: '3', h: 16, m: 0, label: 'Pick up parcel', days: [], on: false }];
      render('alarmList');
    },
    drop() { render('dropZone'); dragLastOver = now + 1e9; markSide('convert'); },
    shelf() { T.shelf = ['Resume_2026.pdf', 'island-mock.png', 'assets.zip'].map((n) => ({ path: 'C:\\Users\\you\\' + n, name: n })); render('shelf'); },
    convert() { T.convertFiles = ['IMG_2041.HEIC', 'IMG_2042.HEIC', 'IMG_2043.HEIC'].map((n) => 'C:\\Users\\you\\' + n); T.convertTo = 'jpg'; render('convert'); },
    clipboard() {
      T.clip = [{ text: 'https://github.com/Vraj93/dynamic-island-windows', at: now - 6e4 }, { text: 'npm run dev -- --port 5173', at: now - 20 * 6e4 },
        { text: 'Meeting moved to 4 pm, same room', at: now - 2 * 36e5 }];
      render('clipboard');
    },
  };
  setTimeout(() => (scenes[scene] || scenes.sheet)(), 50);
})();
