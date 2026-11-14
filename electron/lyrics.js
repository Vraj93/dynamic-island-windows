'use strict';
/*
 * Lyrics for the song that's playing, from LRCLIB (https://lrclib.net), a free community lyrics library.
 * Only asked when you open the lyrics drawer in the player: the song's title, artist, album and length are sent
 * once per song. Synced lyrics ([mm:ss.xx] lines) scroll with the music; plain ones are shown as text.
 */
const { net } = require('electron');

const cache = new Map(); // "title|artist" -> result
const API = 'https://lrclib.net/api';

function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const t of tags) lines.push({ t: +t[1] * 60 + +t[2], text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

async function getJson(url) {
  const r = await net.fetch(url, { headers: { accept: 'application/json' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Lyrics service answered ${r.status}`);
  return r.json();
}

function shape(rec) {
  if (!rec) return { status: 'none' };
  if (rec.instrumental) return { status: 'instrumental' };
  const synced = parseLrc(rec.syncedLyrics);
  if (synced.length) return { status: 'ok', synced: true, lines: synced };
  const plain = String(rec.plainLyrics || '').split(/\r?\n/).map((text) => ({ t: -1, text: text.trim() }));
  return plain.some((l) => l.text) ? { status: 'ok', synced: false, lines: plain } : { status: 'none' };
}

/* Songs from browsers often have extras in the title: "Song (Official Video)", "Artist - Song". */
function clean(title, artist) {
  let t = String(title || '').replace(/\s*[([](official|lyrics?|audio|video|music video|hd|4k|visuali[sz]er|remaster(ed)?[^)\]]*)[^)\]]*[)\]]/gi, '').trim();
  let a = String(artist || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash && (!a || dash[1].toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(dash[1].toLowerCase()))) { a = a || dash[1]; t = dash[2]; }
  return { t, a };
}

/* Fallbacks when LRCLIB has nothing. Both give plain (unsynced) lyrics.
 *  - lyrics.ovh: a free, open lyrics API.
 *  - Musixmatch: official API, only with your own key (Settings › Media). Free keys return part of each song. */
const plainResult = (text, source) => {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((x) => ({ t: -1, text: x.trim() }));
  return lines.some((l) => l.text) ? { status: 'ok', synced: false, lines, source } : null;
};
async function fromLyricsOvh(t, a) {
  if (!a) return null;
  const r = await getJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(a)}/${encodeURIComponent(t)}`).catch(() => null);
  return r && r.lyrics ? plainResult(r.lyrics.replace(/^Paroles de la chanson.*\n/i, ''), 'lyrics.ovh') : null;
}
async function fromMusixmatch(t, a, key) {
  if (!key) return null;
  const q = new URLSearchParams({ q_track: t, q_artist: a || '', apikey: key, format: 'json' });
  const r = await getJson(`https://api.musixmatch.com/ws/1.1/matcher.lyrics.get?${q}`).catch(() => null);
  const body = r && r.message && r.message.body && r.message.body.lyrics && r.message.body.lyrics.lyrics_body;
  if (!body) return null;
  // Free keys add a notice after the visible part; keep the lyrics and drop the notice.
  return plainResult(body.split(/\n\*{5,}/)[0], 'Musixmatch');
}

async function find(song, opts = {}) {
  const { t, a } = clean(song.title, song.artist);
  if (!t) return { status: 'none' };
  const key = `${t}|${a}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let res;
  try {
    const q = new URLSearchParams({ track_name: t, artist_name: a });
    if (song.album) q.set('album_name', song.album);
    if (song.duration > 0) q.set('duration', String(Math.round(song.duration)));
    res = shape(await getJson(`${API}/get?${q}`));
    if (res.status === 'none') {
      // Not an exact match: search, and take the closest length.
      const list = await getJson(`${API}/search?${new URLSearchParams({ track_name: t, ...(a ? { artist_name: a } : {}) })}`) || [];
      const pick = list.filter((x) => x.syncedLyrics || x.plainLyrics)
        .sort((x, y) => (Math.abs((x.duration || 0) - (song.duration || 0)) - Math.abs((y.duration || 0) - (song.duration || 0))) || (!!y.syncedLyrics - !!x.syncedLyrics))[0];
      res = shape(pick);
    }
    if (res.status === 'ok') res.source = 'LRCLIB';
  } catch (e) {
    res = { status: 'error', error: e.message };
  }
  // Nothing (or LRCLIB unreachable): try the other sources.
  if (res.status === 'none' || res.status === 'error') {
    const other = (await fromMusixmatch(t, a, opts.musixmatchKey)) || (await fromLyricsOvh(t, a));
    if (other) res = other;
  }
  if (res.status === 'error') return res; // not cached: try again next time
  cache.set(key, res);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return res;
}

module.exports = { find, parseLrc, clean };
