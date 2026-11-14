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
    stage: status === 'done' ? 3 : 1, stages: [0, 1], steps: 7,
    diff: { file: 'checkout.ts', old: ['const total = 0'], new: ['const total = sum(items)'], more: false, live: status !== 'done' },
    answer: 'Added play/pause, next and previous to the expanded player and connected them to Windows media controls. Typecheck passes.',
  });
  const timer = (leftSec) => { state.timer = { total: 600, endAt: now + leftSec * 1000, pausedLeft: null, done: false }; };

  const calendar = () => {
    const at = (dayOff, h, m) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOff); d.setHours(h, m); return d.getTime(); };
    const n = new Date(), h = n.getHours(), m = n.getMinutes();
    C.accounts = [{ id: 'g', provider: 'google', email: 'you@gmail.com', calendars: [] }];
    const ev = (id, title, s, e, color, extra = {}) => ({ id, account: 'g', calendar: extra.cal || 'Work', color, title, start: s, end: e, allDay: false, location: '', join: '', ...extra });
    C.events = [
      { ...ev('h', 'Thanksgiving week', at(0, 0, 0), at(1, 0, 0), '#30d158', { cal: 'Holidays' }), allDay: true },
      ev('a', 'Design review', at(0, h - 2, 0), at(0, h - 1, 0), '#4f9dff', { location: 'Room 4B' }),
      ev('b', 'Team standup', at(0, h, m - 10), at(0, h, m + 20), '#4f9dff', { join: 'https://meet.google.com/abc-defg-hij' }),
      ev('c', 'Lunch with Sam', at(0, h + 1, 30), at(0, h + 2, 30), '#ff9f0a', { cal: 'Personal', location: 'Blue Door Café' }),
      ev('d', '1:1 with Priya', at(0, h + 3, 0), at(0, h + 3, 30), '#bf8cff', { join: 'https://teams.microsoft.com/l/meetup-join/x', cal: 'Outlook' }),
      ev('e', 'Gym', at(1, 7, 0), at(1, 8, 0), '#ff6fae', { cal: 'Personal' }),
      ev('f', 'Sprint planning', at(2, 10, 0), at(2, 11, 30), '#4f9dff', { join: 'https://zoom.us/j/123' }),
      ev('g', 'Dentist', at(3, 16, 0), at(3, 16, 45), '#ff9f0a', { cal: 'Personal' }),
    ];
    C.syncedAt = now;
  };

  const scenes = {
    sheet() { music(); calendar(); render('sheet'); },
    sheetagent() { music(); agent('working'); state.agents.get('demo').agent = 'claude-code'; render('sheet'); },
    calendar() { calendar(); render('calendar'); },
    calempty() { render('calendar'); },
    calnew() { C.local = []; actions.calNew(); document.querySelector('#calTitle').value = 'Dinner with Maya'; document.querySelector('#calEnd').value = '19:20'; document.querySelector('#calEnd').dispatchEvent(new Event('input', { bubbles: true })); },
    callocal() {
      const type = (t) => { document.querySelector('#calTitle').value = t; };
      C.local = []; actions.calNew(); type('Dentist'); actions.calSave();
      actions.calNew(); type('Mom\'s birthday'); actions.calAllDay(); actions.calColor('#ff6fae'); actions.calSave();
      actions.calEdit(C.local[0].id); actions.calLen(50); actions.calSave(); // editing keeps the same event
      render('calendar');
    },
    event() { calendar(); C.alert = { ev: C.events.find((e) => e.id === 'd'), phase: 'soon' }; C.alert.ev.start = now + 4.2 * 6e4; render('eventSoon'); },
    netflix() {
      music();
      Object.assign(state.media, { source: 'Chrome', title: 'Netflix', artist: '', album: '', art: null, duration: 0 });
      render('sheet');
    },
    player() { music(); render('mediaExpanded'); },
    call() { music(); state.priv = { mic: [{ app: 'Teams', since: now - 754000 }], cam: [{ app: 'Teams', since: now - 700000 }], screen: [], micMuted: 0 }; render('callCompact'); },
    callmuted() { state.priv = { mic: [{ app: 'Zoom', since: now - 1912000 }], cam: [], screen: [{ app: 'Zoom', since: now - 60000 }], micMuted: 1 }; render('callExpanded'); },
    camdot() { music(); state.priv = { mic: [], cam: [{ app: 'WindowsCamera', since: now - 9000 }], screen: [], micMuted: 0 }; render('mediaCompact'); },
    lyrics() {
      music(); state.lyricsOpen = true;
      const words = ['City lights are fading slow', 'Engine humming soft and low', 'Every mile a quiet song', 'We were never lost for long',
        '', 'Hold the wheel and close your eyes', 'Midnight drive beneath the skies', 'Radio plays our favourite tune', 'Chasing shadows of the moon'];
      state.lyrics = { key: songKey(state.media), status: 'ok', synced: true, lines: words.map((text, i) => ({ t: 66 + i * 5, text })) };
      render('mediaExpanded');
    },
    compact() { music(); timer(272); render('mediaCompact'); },
    agent() { agent('working'); render('agentCompact'); },
    finishedlong() { agent('done'); state.agents.get('demo').answer = Array.from({ length: 14 }, (_, i) => 'Line ' + (i + 1) + ' of a long answer from the agent, so the box has to scroll.').join(String.fromCharCode(10)); state.focusAgent = 'demo'; render('agentExpanded'); },
    agentlive() { agent('working'); state.focusAgent = 'demo'; render('agentExpanded'); },
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
