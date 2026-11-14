'use strict';
/*
 * Album covers for songs whose app sends none (often music in a browser): looked up once per song in
 * Apple's public iTunes Search API, then Deezer's public search, then MusicBrainz + Cover Art Archive. All free, no key.
 * Only the title and artist are sent. Returns the picture as a data: URL (the island only shows local pictures).
 */
const { net } = require('electron');

const cache = new Map();
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();
const firstArtist = (a) => String(a || '').split(/,|&| x | feat\.?| ft\.?/i)[0].trim();

// Like the lyrics lookup: tidy "Song (Official Video)" and "Artist - Song".
function clean(title, artist) {
  let t = String(title || '').replace(/\s*[([](official|lyrics?|audio|video|music video|hd|4k|visuali[sz]er)[^)\]]*[)\]]/gi, '').trim();
  let a = String(artist || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash && !a) { a = dash[1]; t = dash[2]; }
  return { t, a };
}

// A result counts only if its title matches and its artist overlaps, so we never show some other song's cover.
function good(t, a, rt, ra) {
  const T = norm(t), RT = norm(rt);
  if (!T || !RT || !(RT === T || RT.startsWith(T) || T.startsWith(RT))) return false;
  if (!a) return true;
  const A = norm(firstArtist(a)), RA = norm(ra);
  return !A || RA.includes(A) || A.includes(RA.split(' ')[0]);
}

async function json(url) {
  const r = await net.fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function itunes(t, a) {
  const q = new URLSearchParams({ term: `${firstArtist(a)} ${t}`.trim(), entity: 'song', limit: '10' });
  const r = await json(`https://itunes.apple.com/search?${q}`);
  const hit = (r.results || []).find((x) => good(t, a, x.trackName, x.artistName));
  return hit && hit.artworkUrl100 ? hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null;
}
async function deezer(t, a) {
  const q = new URLSearchParams({ q: a ? `artist:"${firstArtist(a)}" track:"${t}"` : t, limit: '10' });
  const r = await json(`https://api.deezer.com/search?${q}`);
  const hit = (r.data || []).find((x) => good(t, a, x.title, x.artist && x.artist.name));
  return hit && hit.album ? hit.album.cover_xl || hit.album.cover_big : null;
}

// MusicBrainz (open music database) + Cover Art Archive: catches independent and regional releases the stores miss.
async function musicbrainz(t, a) {
  const q = `recording:"${t.replace(/"/g, '')}"` + (a ? ` AND artist:"${firstArtist(a).replace(/"/g, '')}"` : '');
  const r = await net.fetch(`https://musicbrainz.org/ws/2/recording/?${new URLSearchParams({ query: q, fmt: 'json', limit: '5' })}`,
    { headers: { accept: 'application/json', 'user-agent': 'DynamicIslandForWindows/0.1 (cover lookup)' } });
  if (!r.ok) return null;
  const j = await r.json();
  for (const rec of j.recordings || []) {
    if (!good(t, a, rec.title, (rec['artist-credit'] || []).map((x) => x.name).join(' '))) continue;
    for (const rel of (rec.releases || []).slice(0, 3)) {
      const url = `https://coverartarchive.org/release/${rel.id}/front-500`;
      const head = await net.fetch(url, { method: 'HEAD' }).catch(() => null);
      if (head && head.ok) return url;
    }
  }
  return null;
}

async function toDataUrl(url) {
  const r = await net.fetch(url);
  if (!r.ok) return null;
  const type = r.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//.test(type)) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 3e6) return null;
  return `data:${type};base64,${buf.toString('base64')}`;
}

async function find(song) {
  const { t, a } = clean(song && song.title, song && song.artist);
  if (!t || !a) return null; // without an artist a title alone matches the wrong song too easily
  const key = `${t}|${a}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let found = null;
  for (const src of [itunes, deezer, musicbrainz]) {
    try { const url = await src(t, a); if (url) { found = await toDataUrl(url); if (found) break; } } catch { /* try the next */ }
  }
  cache.set(key, found);
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return found;
}

module.exports = { find, good };
