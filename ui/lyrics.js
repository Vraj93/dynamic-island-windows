'use strict';
/* Dynamic Island: lyrics drawer in the expanded player.
 * Opens from the quote button. Lyrics come from LRCLIB through the main process (electron/lyrics.js), asked only
 * when the drawer is open. Synced lyrics scroll with the music, the line being sung lights up in the cover's colour,
 * and clicking a line jumps there. Loaded after app.js. */
I.lyrics = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11M4 11h11M4 16h7"/><circle cx="17.5" cy="17" r="2.5"/><path d="M20 17V6.5l-2.5 1"/></svg>';
state.lyricsOpen = (() => { try { return localStorage.getItem('island.lyricsOpen') === '1'; } catch { return false; } })();
state.lyrics = null; // { key, status: 'loading' | 'ok' | 'none' | 'instrumental' | 'error' | 'video', synced, lines: [{ t, text }] }

const songKey = (m) => (m ? `${m.title}|${m.artist}|${m.album}` : '');
// Videos (no artist, or very long) would put the lines out of time; music apps and music sites are fine.
const looksLikeVideo = (m) => isVideoMedia(m);

function loadLyrics() {
  const m = state.media;
  if (!m || !state.lyricsOpen) return;
  const key = songKey(m);
  if (state.lyrics && state.lyrics.key === key && state.lyrics.status !== 'error') return;
  if (looksLikeVideo(m)) { state.lyrics = { key, status: 'video' }; return; }
  state.lyrics = { key, status: 'loading' };
  if (!host) return;
  host.invoke('lyrics', { title: m.title, artist: m.artist, album: m.album, duration: m.duration }).then((r) => {
    if (!state.media || songKey(state.media) !== key) return; // the song changed meanwhile
    state.lyrics = { key, ...(r || { status: 'error' }) };
    if (state.view === 'mediaExpanded') render('mediaExpanded');
  });
}

function currentLine(lines) {
  const pos = mediaPos() + 0.25; // a hair early feels in time
  let i = -1;
  for (let k = 0; k < lines.length; k++) { if (lines[k].t <= pos) i = k; else break; }
  return i;
}

function lyricsDrawer() {
  loadLyrics();
  const L = state.lyrics || { status: 'loading' };
  const msg = (t) => `<div class="lyr msg"><span class="m f14">${t}</span></div>`;
  if (L.status === 'loading') return msg('Finding lyrics…');
  if (L.status === 'none') return msg('No lyrics found for this song.');
  if (L.status === 'instrumental') return msg('Instrumental ♪');
  if (L.status === 'video') return msg('Lyrics are for songs; this looks like a video.');
  if (L.status === 'off') return msg('Lyrics are off in Settings › Media.');
  if (L.status !== 'ok') return msg('Couldn\'t reach the lyrics service. <button class="btn sm" data-act="lyricsRetry" style="margin-left:8px">Try again</button>');
  const cur = L.synced ? currentLine(L.lines) : -1;
  const lines = L.lines.map((l, i) => l.text
    ? `<p class="${i === cur ? 'on' : i < cur ? 'was' : ''}"${L.synced ? ` data-lt="${l.t}" data-act="lyricsSeek" data-arg="${l.t}"` : ''}>${esc(l.text)}</p>`
    : '<p class="gap">♪</p>').join('');
  return `<div class="lyr${L.synced ? ' synced' : ''}">
    <div class="lyrbg" style="${artUsable() ? `background-image:url('${state.media.art}')` : `background:${tileColor()}`}"></div>
    <div class="lyrlist" data-lyrlist>${lines}</div>
    <div class="lyrsrc d f12">Lyrics: ${esc(L.source || 'LRCLIB')}</div></div>`;
}

Object.assign(actions, {
  lyrics() {
    state.lyricsOpen = !state.lyricsOpen;
    try { localStorage.setItem('island.lyricsOpen', state.lyricsOpen ? '1' : '0'); } catch { /* fine */ }
    render('mediaExpanded');
    requestAnimationFrame(() => followLyrics(true));
  },
  lyricsRetry() { state.lyrics = null; render('mediaExpanded'); },
  lyricsSeek(t) {
    const m = state.media; if (!m || !m.canSeek) return;
    m.position = +t; m.updatedAt = Date.now();
    post({ type: 'media-cmd', cmd: 'seek ' + (+t).toFixed(1) });
    followLyrics(true);
  },
});

/* Light up the line being sung and keep it in the middle (unless you're scrolling through them yourself). */
let userScrollUntil = 0;
document.addEventListener('wheel', (e) => { if (e.target.closest && e.target.closest('[data-lyrlist]')) userScrollUntil = Date.now() + 4000; }, { passive: true });
function followLyrics(jump) {
  const list = content.querySelector('[data-lyrlist]');
  const L = state.lyrics;
  if (!list || !L || !L.synced) return;
  const cur = currentLine(L.lines);
  const ps = list.querySelectorAll('p');
  let el = null;
  ps.forEach((p, i) => {
    p.classList.toggle('on', i === cur);
    p.classList.toggle('was', i < cur);
    if (i === cur) el = p;
  });
  if (el && (jump || Date.now() > userScrollUntil)) {
    const top = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
    if (Math.abs(list.scrollTop - top) > 2) list.scrollTo({ top, behavior: jump ? 'auto' : 'smooth' });
  }
}
setInterval(() => { if (state.view === 'mediaExpanded' && state.lyricsOpen) followLyrics(false); }, 250);
// When the player opens or redraws, go straight to the line being sung.
const lyrRender = render;
render = function (name, opts) {
  lyrRender(name, opts);
  if (name === 'mediaExpanded' && state.lyricsOpen) requestAnimationFrame(() => followLyrics(true));
};
// Tapping the song row in the sheet opens the full player (its buttons still do their own thing).
actions.openPlayer = () => render('mediaExpanded');
