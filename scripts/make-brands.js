// Builds ui/brands.js from Simple Icons (CC0): only the brands the island uses.
const fs = require('fs'), path = require('path');
const pkg = process.argv[2], out = process.argv[3];
const data = JSON.parse(fs.readFileSync(path.join(pkg, '_data', 'simple-icons.json'), 'utf8'));
const list = Array.isArray(data) ? data : data.icons;
const slugOf = (t) => t.toLowerCase().replace(/\+/g, 'plus').replace(/\./g, 'dot').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
// id: [slug, display name, how to recognise it (source app id or text in title / artist / album)]
const WANT = {
  netflix: ['netflix', 'Netflix', /netflix/i], youtubemusic: ['youtubemusic', 'YouTube Music', /youtube music/i], youtube: ['youtube', 'YouTube', /youtube/i],
  spotify: ['spotify', 'Spotify', /spotify/i], applemusic: ['applemusic', 'Apple Music', /apple ?music|AppleInc\.AppleMusic/i], itunes: ['itunes', 'iTunes', /itunes/i],
  primevideo: ['primevideo', 'Prime Video', /prime video|primevideo/i], amazonmusic: ['amazonmusic', 'Amazon Music', /amazon ?music/i],
  twitch: ['twitch', 'Twitch', /twitch/i], soundcloud: ['soundcloud', 'SoundCloud', /soundcloud/i], tidal: ['tidal', 'TIDAL', /tidal/i],
  crunchyroll: ['crunchyroll', 'Crunchyroll', /crunchyroll/i], plex: ['plex', 'Plex', /plex/i], kodi: ['kodi', 'Kodi', /kodi/i],
  vlc: ['vlcmediaplayer', 'VLC', /^vlc$|vlc media player|VideoLAN/i], winamp: ['winamp', 'Winamp', /winamp/i], foobar2000: ['foobar2000', 'foobar2000', /foobar2000/i], mpv: ['mpv', 'mpv', /^mpv/i],
  claude: ['claude', 'Claude', /^claude/i], openai: ['openai', 'OpenAI', /^(codex|openai|chatgpt)/i], gemini: ['googlegemini', 'Gemini', /^gemini/i], copilot: ['githubcopilot', 'GitHub Copilot', /copilot/i],
  zoom: ['zoom', 'Zoom', /zoom/i], discord: ['discord', 'Discord', /discord/i], meet: ['googlemeet', 'Google Meet', /google meet|meet\.google/i],
  chrome: ['googlechrome', 'Chrome', /chrome/i], firefox: ['firefoxbrowser', 'Firefox', /firefox/i], brave: ['brave', 'Brave', /brave/i], opera: ['opera', 'Opera', /opera/i], vivaldi: ['vivaldi', 'Vivaldi', /vivaldi/i],
};
const res = {};
for (const [id, [slug, name, re]] of Object.entries(WANT)) {
  const svg = fs.readFileSync(path.join(pkg, 'icons', slug + '.svg'), 'utf8');
  const d = (svg.match(/ d="([^"]+)"/) || [])[1];
  const meta = list.find((x) => (x.slug || slugOf(x.title)) === slug);
  if (!d || !meta) { console.log('skip', id); continue; }
  res[id] = { name, hex: '#' + meta.hex, re: re.source, flags: re.flags, d };
}
const body = `'use strict';
/* Brand icons for well-known apps, streaming services and AI agents, shown when an app or site sends no artwork
 * (Netflix in Chrome, VLC...) and for agents. Shapes and colours from Simple Icons (https://simpleicons.org),
 * released under CC0 1.0 (public domain). Brand names and logos belong to their owners; they're shown only to
 * say which app or service is playing. Made by scripts (see README); not edited by hand. */
const BRANDS = ${JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { name: v.name, hex: v.hex, d: v.d }])))};
const BRAND_MATCH = [${Object.entries(res).map(([k, v]) => `['${k}', /${v.re}/${v.flags}]`).join(', ')}];
// Which brand something is: checks each text (site text first, then the app) against the list.
function brandOf(...texts) {
  for (const t of texts) { if (!t) continue; for (const [id, re] of BRAND_MATCH) if (re.test(String(t))) return id; }
  return '';
}
// The brand's logo as an SVG, in white (or a colour) on transparent.
const brandSvg = (id, size = '62%', fill = '#fff') => (BRANDS[id] ? \`<svg viewBox="0 0 24 24" width="\${size}" height="\${size}" aria-hidden="true"><path fill="\${fill}" d="\${BRANDS[id].d}"/></svg>\` : '');
// Dark logos (black brands) read better as white on their own tile; very light brand colours get a dark tile.
function brandTile(id) {
  const b = BRANDS[id]; if (!b) return null;
  const n = parseInt(b.hex.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.12 ? { bg: '#1c1c22', fg: '#fff' } : lum > 0.85 ? { bg: '#1c1c22', fg: b.hex } : { bg: b.hex, fg: '#fff' };
}
`;
fs.writeFileSync(out, body);
console.log('wrote', Object.keys(res).length, 'brands', Math.round(body.length / 1024) + ' KB');
