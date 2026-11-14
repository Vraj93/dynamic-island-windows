'use strict';
/*
 * Calendar and reminders sync for the island.
 *
 * Three kinds of account:
 *   google     Sign in with Google: Google Calendar (read) and Google Tasks (reminders, two-way).
 *   microsoft  Sign in with Microsoft (Outlook.com, Hotmail, Microsoft 365): Outlook calendar (read) and Microsoft To Do.
 *   ics        A calendar link (.ics / webcal://): Google's "secret address in iCal format", Outlook's published
 *              calendar, iCloud public calendars, school and work timetables... No sign-in needed, read only.
 *
 * Sign-in happens in your normal browser (OAuth with PKCE and a one-time local page on 127.0.0.1 that receives
 * the answer). The island never sees your password. Tokens and links are encrypted with Windows' own data
 * protection (Electron safeStorage) and kept in %APPDATA%\dynamic-island\accounts.json.
 *
 * Google and Microsoft sign-in need an app ID (OAuth client). The build's own IDs come from
 * electron/oauth-clients.json; anyone can also use their own from Settings › Calendar › Advanced.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { app, net, shell, safeStorage } = require('electron');

const SYNC_EVERY = 5 * 60e3;
const PAST = 12 * 3600e3, AHEAD = 21 * 864e5;

let log = () => {};
let onChange = () => {};
let getSettings = () => ({});

/* ---------------- storage ---------------- */
const file = (n) => path.join(app.getPath('userData'), n);
const enc = (s) => {
  try { if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(s).toString('base64'); } catch { /* fall through */ }
  return 'b64:' + Buffer.from(s, 'utf8').toString('base64');
};
const dec = (s) => {
  if (!s) return '';
  if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
  if (s.startsWith('b64:')) return Buffer.from(s.slice(4), 'base64').toString('utf8');
  return s;
};
let db = { accounts: [], clients: {} };
function load() {
  try { db = { accounts: [], clients: {}, ...JSON.parse(fs.readFileSync(file('accounts.json'), 'utf8')) }; } catch { /* first run */ }
  try { const c = JSON.parse(fs.readFileSync(file('calendar-cache.json'), 'utf8')); cache.events = c.events || []; cache.tasks = c.tasks || []; cache.syncedAt = c.syncedAt || 0; } catch { /* none yet */ }
}
function save() { try { fs.writeFileSync(file('accounts.json'), JSON.stringify(db, null, 2)); } catch (e) { log('accounts save: ' + e.message); } }
function saveCache() { try { fs.writeFileSync(file('calendar-cache.json'), JSON.stringify(cache)); } catch { /* ignore */ } }

/* App IDs for Google / Microsoft sign-in: yours (Settings) first, then the build's. */
function clients() {
  let built = {};
  try { built = JSON.parse(fs.readFileSync(path.join(__dirname, 'oauth-clients.json'), 'utf8')); } catch { /* none shipped */ }
  const pick = (p) => {
    const own = db.clients[p] || {};
    const env = p === 'google' ? { clientId: process.env.DI_GOOGLE_CLIENT_ID, clientSecret: process.env.DI_GOOGLE_CLIENT_SECRET } : { clientId: process.env.DI_MS_CLIENT_ID };
    for (const c of [own, env, built[p] || {}]) if (c && c.clientId) return { ...c, own: c === own };
    return {};
  };
  return { google: pick('google'), microsoft: pick('microsoft') };
}

const cache = { events: [], tasks: [], syncedAt: 0 };
const errors = {};      // account id -> last error text
let timer = null, syncing = null;

/* ---------------- HTTP ---------------- */
async function req(url, opts = {}) {
  const r = await net.fetch(url, opts);
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!r.ok) {
    const msg = (body && body.error && (body.error.message || body.error_description || body.error)) || body.error_description || `HTTP ${r.status}`;
    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); e.status = r.status; throw e;
  }
  return body;
}
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();

/* ---------------- OAuth ---------------- */
const PROVIDERS = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks',
    extra: { access_type: 'offline', prompt: 'consent' },
    host: '127.0.0.1',
  },
  microsoft: {
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access User.Read Calendars.Read Tasks.ReadWrite',
    extra: { prompt: 'select_account' },
    host: 'localhost',
  },
};
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const DONE_PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>Dynamic Island</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d16;color:#fff;font:15px 'Segoe UI Variable','Segoe UI',sans-serif">
<div style="text-align:center"><div style="width:64px;height:64px;margin:0 auto 18px;border-radius:32px;display:grid;place-items:center;background:${ok ? 'rgba(48,209,88,.16);color:#30d158' : 'rgba(255,69,58,.16);color:#ff453a'};font-size:30px">${ok ? '✓' : '!'}</div>
<div style="font-size:22px;font-weight:600;margin-bottom:8px">${ok ? 'Connected to Dynamic Island' : 'Sign-in didn\'t finish'}</div>
<div style="opacity:.6">${msg}</div></div></body>`;

let pendingLogin = null;
function login(provider) {
  const P = PROVIDERS[provider], C = clients()[provider];
  if (!P) return Promise.reject(new Error('Unknown account type.'));
  if (!C.clientId) { const e = new Error(`${provider === 'google' ? 'Google' : 'Microsoft'} sign-in isn't set up in this copy of the app yet. Add an app ID under Advanced, or use a calendar link.`); e.code = 'NO_CLIENT'; return Promise.reject(e); }
  if (pendingLogin) pendingLogin.cancel();
  return new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let redirect = '';
    let finished = false;
    const servers = [];
    const finish = (err, val) => {
      if (finished) return; finished = true; pendingLogin = null;
      clearTimeout(to); setTimeout(() => servers.forEach((s) => s.close()), 500);
      err ? reject(err) : resolve(val);
    };
    const handler = async (rq, rs) => {
      const u = new URL(rq.url, redirect);
      if (u.pathname !== '/' || (!u.searchParams.get('code') && !u.searchParams.get('error'))) { rs.writeHead(404); return rs.end(); }
      if (u.searchParams.get('state') !== state) { rs.writeHead(400); return rs.end('Wrong state'); }
      const code = u.searchParams.get('code');
      if (!code) {
        rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); rs.end(DONE_PAGE(false, 'You can close this tab and try again from the island.'));
        return finish(new Error(u.searchParams.get('error_description') || u.searchParams.get('error') || 'Sign-in was cancelled.'));
      }
      try {
        const tok = await req(P.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({ client_id: C.clientId, client_secret: C.clientSecret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }) });
        const acct = await addOAuthAccount(provider, tok, C);
        rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); rs.end(DONE_PAGE(true, `${acct.email} is connected. You can close this tab.`));
        finish(null, acct);
      } catch (e) {
        rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); rs.end(DONE_PAGE(false, 'You can close this tab and try again.'));
        finish(e);
      }
    };
    const to = setTimeout(() => finish(new Error('Sign-in timed out.')), 5 * 60e3);
    pendingLogin = { cancel: () => finish(new Error('Cancelled.')) };
    // One port on 127.0.0.1, and the same port on ::1 when the browser resolves "localhost" to IPv6.
    const s4 = http.createServer(handler);
    s4.on('error', (e) => finish(e));
    s4.listen(0, '127.0.0.1', () => {
      const port = s4.address().port;
      servers.push(s4);
      const s6 = http.createServer(handler); s6.on('error', () => {}); s6.listen(port, '::1', () => servers.push(s6));
      redirect = `http://${P.host}:${port}`;
      const url = `${P.auth}?${form({ client_id: C.clientId, response_type: 'code', redirect_uri: redirect, scope: P.scope, state,
        code_challenge: challenge, code_challenge_method: 'S256', ...P.extra })}`;
      shell.openExternal(url);
    });
  });
}

async function addOAuthAccount(provider, tok, C) {
  const access = tok.access_token;
  let email = '', name = '';
  if (provider === 'google') {
    const me = await req('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${access}` } });
    email = me.email; name = me.name || '';
  } else {
    const me = await req('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', { headers: { authorization: `Bearer ${access}` } });
    email = me.mail || me.userPrincipalName; name = me.displayName || '';
  }
  let a = db.accounts.find((x) => x.provider === provider && x.email === email);
  if (!a) { a = { id: crypto.randomBytes(6).toString('hex'), provider, email, name, calendars: [] }; db.accounts.push(a); }
  a.name = name;
  a.clientId = C.clientId;
  a.refresh = enc(tok.refresh_token || dec(a.refresh || ''));
  a.access = enc(access); a.expires = Date.now() + (tok.expires_in || 3600) * 1000 - 60e3;
  delete errors[a.id];
  save();
  syncSoon(0);
  return publicAccount(a);
}

async function token(a) {
  if (a.access && a.expires > Date.now()) return dec(a.access);
  const P = PROVIDERS[a.provider], C = clients()[a.provider];
  const cid = a.clientId || C.clientId;
  const secret = C.clientId === cid ? C.clientSecret : undefined;
  let tok;
  try {
    tok = await req(P.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: cid, client_secret: secret, refresh_token: dec(a.refresh), grant_type: 'refresh_token', ...(a.provider === 'microsoft' ? { scope: P.scope } : {}) }) });
  } catch (e) {
    if (e.status === 400 || e.status === 401) { a.needsSignIn = true; save(); e.message = 'Sign in again to keep this account in sync.'; }
    throw e;
  }
  a.access = enc(tok.access_token); a.expires = Date.now() + (tok.expires_in || 3600) * 1000 - 60e3;
  if (tok.refresh_token) a.refresh = enc(tok.refresh_token);
  a.needsSignIn = false;
  save();
  return tok.access_token;
}
const api = async (a, url, opts = {}) => req(url, { ...opts, headers: { authorization: `Bearer ${await token(a)}`, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });

/* ---------------- meeting links ---------------- */
const JOIN_RE = /https:\/\/(?:[\w-]+\.)?(?:meet\.google\.com\/[\w-]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+|teams\.live\.com\/meet\/[^\s"<>]+|zoom\.us\/(?:j|my|w)\/[^\s"<>]+|[\w-]+\.zoom\.us\/(?:j|my|w)\/[^\s"<>]+|[\w-]+\.webex\.com\/[^\s"<>]+|whereby\.com\/[^\s"<>]+|discord\.gg\/[^\s"<>]+)/i;
const findJoin = (...texts) => { for (const t of texts) { const m = t && String(t).match(JOIN_RE); if (m) return m[0].replace(/[).,;>]+$/, ''); } return ''; };

/* ---------------- Google ---------------- */
async function syncGoogle(a, from, to) {
  const list = await api(a, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader');
  mergeCalendars(a, (list.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor || '#4285f4', defaultOn: c.selected !== false })));
  const events = [];
  for (const c of a.calendars.filter((x) => x.on)) {
    let pageToken = '';
    do {
      const q = form({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250', pageToken: pageToken || undefined });
      const r = await api(a, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      for (const e of r.items || []) {
        if (e.status === 'cancelled') continue;
        const me = (e.attendees || []).find((x) => x.self);
        if (me && me.responseStatus === 'declined') continue;
        const allDay = !!(e.start && e.start.date);
        const start = allDay ? localDate(e.start.date) : Date.parse(e.start.dateTime);
        const end = allDay ? localDate(e.end.date) : Date.parse(e.end.dateTime);
        const video = e.hangoutLink || ((e.conferenceData && e.conferenceData.entryPoints) || []).filter((p) => p.entryPointType === 'video').map((p) => p.uri)[0];
        events.push({ id: `${a.id}:${e.id}`, account: a.id, calendar: c.name, color: c.color, title: e.summary || '(No title)', start, end, allDay,
          location: e.location || '', join: video || findJoin(e.location, e.description), link: e.htmlLink || '' });
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
  }
  return events;
}

/* ---------------- Microsoft ---------------- */
const MS_COLORS = { lightBlue: '#4f9dff', lightGreen: '#34c759', lightOrange: '#ff9f0a', lightGray: '#a0a0a8', lightYellow: '#ffd60a', lightTeal: '#40c8e0', lightPink: '#ff6fae', lightBrown: '#c4935a', lightRed: '#ff6961', maxColor: '#bf8cff', auto: '#4f9dff' };
async function syncMicrosoft(a, from, to) {
  const list = await api(a, 'https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,hexColor,color,isDefaultCalendar&$top=100');
  mergeCalendars(a, (list.value || []).map((c) => ({ id: c.id, name: c.name, color: c.hexColor || MS_COLORS[c.color] || '#4f9dff', defaultOn: true })));
  const events = [];
  for (const c of a.calendars.filter((x) => x.on)) {
    let url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(c.id)}/calendarView?${form({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(),
      $top: '250', $select: 'id,subject,start,end,isAllDay,isCancelled,location,onlineMeeting,onlineMeetingUrl,webLink,bodyPreview,responseStatus' })}`;
    while (url) {
      const r = await api(a, url, { headers: { Prefer: 'outlook.timezone="UTC"' } });
      for (const e of r.value || []) {
        if (e.isCancelled || (e.responseStatus && e.responseStatus.response === 'declined')) continue;
        const utc = (x) => Date.parse(x.dateTime.replace(/(\.\d+)?$/, '') + 'Z');
        const allDay = !!e.isAllDay;
        const start = allDay ? localDate(e.start.dateTime.slice(0, 10)) : utc(e.start);
        const end = allDay ? localDate(e.end.dateTime.slice(0, 10)) : utc(e.end);
        events.push({ id: `${a.id}:${e.id}`, account: a.id, calendar: c.name, color: c.color, title: e.subject || '(No title)', start, end, allDay,
          location: (e.location && e.location.displayName) || '', join: (e.onlineMeeting && e.onlineMeeting.joinUrl) || e.onlineMeetingUrl || findJoin(e.location && e.location.displayName, e.bodyPreview), link: e.webLink || '' });
      }
      url = r['@odata.nextLink'];
    }
  }
  return events;
}

function mergeCalendars(a, found) {
  const old = new Map((a.calendars || []).map((c) => [c.id, c]));
  a.calendars = found.map((c) => ({ id: c.id, name: c.name, color: c.color, on: old.has(c.id) ? old.get(c.id).on : c.defaultOn }));
}

/* ---------------- calendar links (.ics) ---------------- */
function unfold(text) { return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n'); }
function parseLine(line) {
  const m = line.match(/^([^:;]+)((?:;[^:;=]+=(?:"[^"]*"|[^:;]*))*):(.*)$/);
  if (!m) return null;
  const params = {};
  m[2].replace(/;([^:;=]+)=("[^"]*"|[^:;]*)/g, (_, k, v) => { params[k.toUpperCase()] = v.replace(/^"|"$/g, ''); });
  return { name: m[1].toUpperCase(), params, value: m[3] };
}
const icsText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/* Time zones: IANA names work directly; Outlook often writes Windows names, so map the common ones. */
const WIN_TZ = {
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest', 'Russian Standard Time': 'Europe/Moscow', 'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem', 'Arabian Standard Time': 'Asia/Dubai', 'Arab Standard Time': 'Asia/Riyadh',
  'Pakistan Standard Time': 'Asia/Karachi', 'India Standard Time': 'Asia/Kolkata', 'Nepal Standard Time': 'Asia/Kathmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka', 'SE Asia Standard Time': 'Asia/Bangkok', 'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore', 'Taipei Standard Time': 'Asia/Taipei', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'AUS Eastern Standard Time': 'Australia/Sydney', 'E. Australia Standard Time': 'Australia/Brisbane',
  'Cen. Australia Standard Time': 'Australia/Adelaide', 'W. Australia Standard Time': 'Australia/Perth', 'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Buenos_Aires', 'SA Pacific Standard Time': 'America/Bogota',
  'Central Standard Time (Mexico)': 'America/Mexico_City', 'South Africa Standard Time': 'Africa/Johannesburg', 'Egypt Standard Time': 'Africa/Cairo',
  'W. Central Africa Standard Time': 'Africa/Lagos', 'E. Africa Standard Time': 'Africa/Nairobi',
};
function zone(tz) {
  if (!tz) return null;
  tz = tz.replace(/^\/[^/]+\/[^/]+\//, ''); // "/mozilla.org/20050126_1/Europe/Berlin"
  const z = WIN_TZ[tz] || tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return null; }
}
const dtfCache = {};
function offsetAt(ts, tz) {
  const f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
/* wall: a wall-clock time stored as if it were UTC. Returns the real moment, for zone tz (null = this PC's zone). */
function toMoment(wall, tz) {
  if (tz === 'UTC') return wall;
  if (!tz) { const d = new Date(wall); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime(); }
  let t = wall - offsetAt(wall, tz);
  t = wall - offsetAt(t, tz);
  return t;
}
function localDate(ymd) { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
/* "20261114", "20261114T153000", "20261114T153000Z" -> { wall, utc, date } */
function icsDate(v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  return { wall: Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)), utc: !!m[7], date: !m[4] };
}
function durMs(v) {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+m[2] || 0) * 6048e5 + (+m[3] || 0) * 864e5 + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1e3);
}

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
/* Wall-clock times of a repeating event (RRULE), from its first one, up to `until` (wall). */
function* recur(startWall, rule, untilWall) {
  const r = Object.fromEntries(rule.split(';').map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  const freq = r.FREQ, iv = Math.max(1, +r.INTERVAL || 1), count = +r.COUNT || Infinity;
  const until = r.UNTIL ? Math.min(untilWall, icsDate(r.UNTIL).wall + (icsDate(r.UNTIL).date ? 864e5 - 1 : 0)) : untilWall;
  const byday = r.BYDAY ? r.BYDAY.split(',').map((d) => { const m = d.match(/^([+-]?\d+)?(\w\w)$/); return m && { n: m[1] ? +m[1] : 0, wd: WD[m[2]] }; }).filter(Boolean) : null;
  const bymd = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;
  const bymonth = r.BYMONTH ? r.BYMONTH.split(',').map((x) => +x - 1) : null;
  const s = new Date(startWall), tod = startWall % 864e5;
  const day = (y, mo, d) => Date.UTC(y, mo, d) + tod;
  let n = 0, guard = 0;
  const emit = function* (list) { for (const t of list.sort((a, b) => a - b)) { if (t < startWall) continue; if (t > until || n >= count) return true; n++; yield t; } return false; };
  const nthInMonth = (y, mo, wd, k) => {
    const days = []; const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    for (let d = 1; d <= last; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === wd) days.push(d);
    const d = k > 0 ? days[k - 1] : k < 0 ? days[days.length + k] : null;
    return k === 0 ? days : d ? [d] : [];
  };
  const monthDays = (y, mo) => {
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    let ds = [];
    if (byday) for (const b of byday) ds.push(...nthInMonth(y, mo, b.wd, b.n));
    if (bymd) { const md = bymd.map((d) => (d < 0 ? last + d + 1 : d)).filter((d) => d >= 1 && d <= last); ds = byday ? ds.filter((d) => md.includes(d)) : md; }
    if (!byday && !bymd) ds = s.getUTCDate() <= last ? [s.getUTCDate()] : [];
    return ds.map((d) => day(y, mo, d));
  };
  if (freq === 'DAILY') {
    for (let t = startWall; guard++ < 5000; t += iv * 864e5) {
      const d = new Date(t);
      if (byday && !byday.some((b) => b.wd === d.getUTCDay())) continue;
      if (bymonth && !bymonth.includes(d.getUTCMonth())) continue;
      if (yield* emit([t])) return;
      if (t > until) return;
    }
  } else if (freq === 'WEEKLY') {
    const wds = byday ? byday.map((b) => b.wd) : [s.getUTCDay()];
    const monday = startWall - ((s.getUTCDay() + 6) % 7) * 864e5;
    for (let w = monday; guard++ < 3000; w += iv * 7 * 864e5) {
      if (yield* emit(wds.map((wd) => w + ((wd + 6) % 7) * 864e5))) return;
      if (w > until) return;
    }
  } else if (freq === 'MONTHLY') {
    for (let k = 0; guard++ < 1200; k += iv) {
      const y = s.getUTCFullYear() + Math.floor((s.getUTCMonth() + k) / 12), mo = (s.getUTCMonth() + k) % 12;
      if (Date.UTC(y, mo, 1) > until) return;
      if (yield* emit(monthDays(y, mo))) return;
    }
  } else if (freq === 'YEARLY') {
    for (let k = 0; guard++ < 200; k += iv) {
      const y = s.getUTCFullYear() + k;
      if (Date.UTC(y, 0, 1) > until) return;
      const months = bymonth || [s.getUTCMonth()];
      const list = [];
      for (const mo of months) list.push(...(byday || bymd ? monthDays(y, mo) : (new Date(Date.UTC(y, mo, s.getUTCDate())).getUTCMonth() === mo ? [day(y, mo, s.getUTCDate())] : [])));
      if (yield* emit(list)) return;
    }
  } else {
    yield startWall;
  }
}

function parseIcs(text, from, to, meta) {
  const lines = unfold(text);
  const raw = [];
  let cur = null, calName = '', calColor = '';
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) raw.push(cur); cur = null; continue; }
    const p = parseLine(line);
    if (!p) continue;
    if (!cur) { if (p.name === 'X-WR-CALNAME') calName = icsText(p.value); if (p.name === 'X-APPLE-CALENDAR-COLOR' || p.name === 'COLOR') calColor = p.value; continue; }
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.title = icsText(p.value); break;
      case 'LOCATION': cur.location = icsText(p.value); break;
      case 'DESCRIPTION': cur.desc = icsText(p.value); break;
      case 'URL': cur.url = p.value; break;
      case 'STATUS': cur.status = p.value; break;
      case 'DTSTART': cur.start = icsDate(p.value); cur.tz = cur.start && cur.start.utc ? 'UTC' : zone(p.params.TZID); break;
      case 'DTEND': cur.end = icsDate(p.value); cur.endTz = cur.end && cur.end.utc ? 'UTC' : zone(p.params.TZID); break;
      case 'DURATION': cur.dur = durMs(p.value); break;
      case 'RRULE': cur.rrule = p.value; break;
      case 'EXDATE': for (const v of p.value.split(',')) { const d = icsDate(v); if (d) cur.exdates.push(d.date ? { day: d.wall } : toMoment(d.wall, d.utc ? 'UTC' : zone(p.params.TZID) || cur.tz)); } break;
      case 'RECURRENCE-ID': { const d = icsDate(p.value); if (d) cur.recId = d.date ? toMoment(d.wall, null) : toMoment(d.wall, d.utc ? 'UTC' : zone(p.params.TZID)); break; }
    }
  }
  const overrides = new Map();
  for (const e of raw) if (e.recId != null && e.uid) { if (!overrides.has(e.uid)) overrides.set(e.uid, new Set()); overrides.get(e.uid).add(e.recId); }
  const out = [];
  const fromWall = from - 2 * 864e5, toWall = to + 2 * 864e5;
  for (const e of raw) {
    if (!e.start || e.status === 'CANCELLED') continue;
    const allDay = e.start.date;
    const tz = allDay ? null : e.tz;
    const lenWall = e.end ? e.end.wall - e.start.wall : e.dur != null ? e.dur : allDay ? 864e5 : 0;
    const starts = e.rrule && e.recId == null ? recur(e.start.wall, e.rrule, toWall) : [e.start.wall];
    const skip = overrides.get(e.uid);
    for (const w of starts) {
      if (w + lenWall < fromWall) continue;
      const start = toMoment(w, tz);
      const end = e.end && !allDay && e.endTz && e.endTz !== tz ? toMoment(e.end.wall + (w - e.start.wall), e.endTz) : toMoment(w + lenWall, tz);
      if (end < from || start > to) continue;
      if (e.exdates.some((x) => (typeof x === 'object' ? x.day === w - (w % 864e5) : Math.abs(x - start) < 60e3))) continue;
      if (e.recId == null && skip && [...skip].some((x) => Math.abs(x - start) < 60e3)) continue;
      out.push({ id: `${meta.account}:${e.uid || out.length}:${start}`, account: meta.account, calendar: meta.name || calName || 'Calendar', color: meta.color || calColor || '#bf8cff',
        title: e.title || '(No title)', start, end: Math.max(end, start), allDay, location: e.location || '', join: findJoin(e.url, e.location, e.desc), link: '' });
    }
  }
  return { events: out, name: calName };
}

async function syncIcs(a, from, to) {
  const url = dec(a.url).replace(/^webcal:/i, 'https:');
  const r = await net.fetch(url, { headers: { accept: 'text/calendar, */*' } });
  if (!r.ok) throw new Error(`The calendar link answered ${r.status}.`);
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('That link isn\'t a calendar (.ics) file.');
  const res = parseIcs(text, from, to, { account: a.id, name: a.name, color: a.color });
  if (!a.name && res.name) { a.name = res.name; save(); }
  return res.events;
}

/* ---------------- reminders <-> Google Tasks / Microsoft To Do ---------------- */
const MARK = 'Dynamic Island reminder';
async function defaultList(a) {
  if (a.taskList) return a.taskList;
  if (a.provider === 'google') { const r = await api(a, 'https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20'); a.taskList = r.items && r.items[0] && r.items[0].id; }
  else { const r = await api(a, 'https://graph.microsoft.com/v1.0/me/todo/lists'); const l = (r.value || []).find((x) => x.wellknownListName === 'defaultList') || (r.value || [])[0]; a.taskList = l && l.id; }
  save();
  return a.taskList;
}
function googleDue(at) { const d = new Date(at); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString(); }
async function pullTasks(a) {
  const list = await defaultList(a);
  if (!list) return [];
  const out = [], now = Date.now(), horizon = now + 60 * 864e5;
  if (a.provider === 'google') {
    let pageToken = '';
    do {
      const r = await api(a, `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list)}/tasks?${form({ showCompleted: 'false', showHidden: 'false', maxResults: '100', pageToken: pageToken || undefined })}`);
      for (const t of r.items || []) {
        if (!t.due || !t.title) continue;
        const m = (t.notes || '').match(/@(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
        const at = m ? Date.parse(m[1]) : localDate(t.due.slice(0, 10)) + 9 * 36e5; // date only: 9:00
        if (at < now - 120e3 || at > horizon) continue;
        out.push({ account: a.id, list, task: t.id, text: t.title, at });
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
  } else {
    let url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list)}/tasks?${form({ $filter: "status ne 'completed'", $top: '100' })}`;
    while (url) {
      const r = await api(a, url);
      for (const t of r.value || []) {
        const when = t.isReminderOn && t.reminderDateTime ? t.reminderDateTime : t.dueDateTime;
        if (!when || !t.title) continue;
        const iso = when.dateTime.replace(/(\.\d+)?$/, '');
        const at = /^utc$/i.test(when.timeZone) ? Date.parse(iso + 'Z') : t.isReminderOn ? toMoment(Date.parse(iso + 'Z'), zone(when.timeZone)) : localDate(iso.slice(0, 10)) + 9 * 36e5;
        if (at < now - 120e3 || at > horizon) continue;
        out.push({ account: a.id, list, task: t.id, text: t.title, at });
      }
      url = r['@odata.nextLink'];
    }
  }
  return out;
}
async function taskAdd(text, at) {
  const a = db.accounts.find((x) => x.id === (getSettings().reminderSync || '') && x.provider !== 'ics');
  if (!a) return null;
  const list = await defaultList(a);
  let t;
  if (a.provider === 'google') {
    t = await api(a, `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list)}/tasks`, { method: 'POST',
      body: JSON.stringify({ title: text, due: googleDue(at), notes: `${MARK} at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} @${new Date(at).toISOString()}` }) });
  } else {
    const dt = { dateTime: new Date(at).toISOString().replace('Z', ''), timeZone: 'UTC' };
    t = await api(a, `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list)}/tasks`, { method: 'POST',
      body: JSON.stringify({ title: text, isReminderOn: true, reminderDateTime: dt, dueDateTime: dt }) });
  }
  return { account: a.id, list, task: t.id };
}
async function taskChange(remote, change) {
  const a = remote && db.accounts.find((x) => x.id === remote.account);
  if (!a) return false;
  const g = a.provider === 'google';
  const url = g ? `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(remote.list)}/tasks/${encodeURIComponent(remote.task)}`
    : `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(remote.list)}/tasks/${encodeURIComponent(remote.task)}`;
  if (change.delete) { await api(a, url, { method: 'DELETE' }); return true; }
  if (change.done) { await api(a, url, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) }); return true; }
  if (change.at) {
    const at = change.at;
    const body = g ? { due: googleDue(at), notes: `${MARK} at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} @${new Date(at).toISOString()}` }
      : (() => { const dt = { dateTime: new Date(at).toISOString().replace('Z', ''), timeZone: 'UTC' }; return { isReminderOn: true, reminderDateTime: dt, dueDateTime: dt }; })();
    await api(a, url, { method: 'PATCH', body: JSON.stringify(body) });
    return true;
  }
  return false;
}

/* ---------------- sync ---------------- */
function publicAccount(a) {
  return { id: a.id, provider: a.provider, email: a.email || '', name: a.name || '', color: a.color || '', needsSignIn: !!a.needsSignIn,
    calendars: (a.calendars || []).map((c) => ({ id: c.id, name: c.name, color: c.color, on: c.on })), error: errors[a.id] || '' };
}
function snapshot() {
  const c = clients();
  return { type: 'calendar', events: cache.events, tasks: cache.tasks, syncedAt: cache.syncedAt, syncing: !!syncing,
    taskAccounts: db.accounts.filter((a) => a.provider !== 'ics' && !errors[a.id]).map((a) => a.id),
    accounts: db.accounts.map(publicAccount), signIn: { google: !!c.google.clientId, microsoft: !!c.microsoft.clientId },
    ownClients: { google: (db.clients.google || {}).clientId || '', microsoft: (db.clients.microsoft || {}).clientId || '' } };
}
function syncSoon(ms = 1500) { clearTimeout(timer); timer = setTimeout(syncAll, ms); }
async function syncAll() {
  clearTimeout(timer);
  if (syncing) return syncing;
  syncing = (async () => {
    onChange(snapshot());
    const from = Date.now() - PAST, to = Date.now() + AHEAD;
    const events = [], tasks = [];
    const prev = cache.events;
    for (const a of db.accounts) {
      try {
        const ev = a.provider === 'google' ? await syncGoogle(a, from, to) : a.provider === 'microsoft' ? await syncMicrosoft(a, from, to) : await syncIcs(a, from, to);
        events.push(...ev);
        if (a.provider !== 'ics') { try { tasks.push(...await pullTasks(a)); } catch (e) { log(`tasks ${a.provider}: ${e.message}`); } }
        delete errors[a.id];
      } catch (e) {
        errors[a.id] = e.message || String(e);
        log(`calendar ${a.provider}: ${errors[a.id]}`);
        events.push(...prev.filter((x) => x.account === a.id)); // keep what we had
      }
    }
    save();
    events.sort((x, y) => x.start - y.start || x.end - y.end);
    cache.events = events; cache.tasks = tasks; cache.syncedAt = Date.now();
    saveCache();
  })();
  try { await syncing; } finally { syncing = null; timer = setTimeout(syncAll, SYNC_EVERY); onChange(snapshot()); }
}

/* ---------------- what Settings and the island ask for ---------------- */
async function handle(req) {
  req = req || {};
  switch (req.op) {
    case 'state': return snapshot();
    case 'sync': await syncAll(); return snapshot();
    case 'login': {
      try { await login(req.provider); return { ok: true, ...snapshot() }; } catch (e) { return { ok: false, code: e.code || '', error: e.message, ...snapshot() }; }
    }
    case 'cancel-login': if (pendingLogin) pendingLogin.cancel(); return snapshot();
    case 'add-link': {
      let url = String(req.url || '').trim();
      if (!/^(https?|webcal):\/\//i.test(url)) return { ok: false, error: 'Paste a link that starts with https:// or webcal://', ...snapshot() };
      const a = { id: crypto.randomBytes(6).toString('hex'), provider: 'ics', name: String(req.name || '').trim().slice(0, 40), color: ['#bf8cff', '#ff9f0a', '#40c8e0', '#ff6fae', '#30d158'][db.accounts.length % 5], url: enc(url), calendars: [] };
      try { await syncIcs(a, Date.now() - PAST, Date.now() + AHEAD); } catch (e) { return { ok: false, error: e.message, ...snapshot() }; }
      db.accounts.push(a); save(); await syncAll();
      return { ok: true, ...snapshot() };
    }
    case 'remove': {
      const a = db.accounts.find((x) => x.id === req.id);
      if (a && a.provider === 'google' && a.refresh) { try { await net.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(dec(a.refresh))}`, { method: 'POST' }); } catch { /* offline: just forget it */ } }
      db.accounts = db.accounts.filter((x) => x.id !== req.id);
      cache.events = cache.events.filter((x) => x.account !== req.id); cache.tasks = cache.tasks.filter((x) => x.account !== req.id);
      delete errors[req.id];
      save(); saveCache(); onChange(snapshot());
      return snapshot();
    }
    case 'toggle-calendar': {
      const a = db.accounts.find((x) => x.id === req.id); const c = a && a.calendars.find((x) => x.id === req.calendar);
      if (c) { c.on = !c.on; save(); await syncAll(); }
      return snapshot();
    }
    case 'set-client': {
      const p = req.provider;
      if (p !== 'google' && p !== 'microsoft') return snapshot();
      const id = String(req.clientId || '').trim(), secret = String(req.clientSecret || '').trim();
      if (id) db.clients[p] = { clientId: id, ...(secret ? { clientSecret: secret } : {}) }; else delete db.clients[p];
      save();
      return snapshot();
    }
    case 'task-add': try { return await taskAdd(String(req.text || ''), +req.at); } catch (e) { log('task add: ' + e.message); return null; }
    case 'task-change': try { return await taskChange(req.remote, req); } catch (e) { log('task change: ' + e.message); return false; }
    case 'open': if (/^https:\/\//.test(req.url || '')) shell.openExternal(req.url); return true;
  }
  return null;
}

function start(opts) {
  log = opts.log || log; onChange = opts.onChange || onChange; getSettings = opts.getSettings || getSettings;
  load();
  syncSoon(db.accounts.length ? 3000 : SYNC_EVERY);
}
// After the PC wakes up or comes back online.
function nudge() { if (db.accounts.length && Date.now() - cache.syncedAt > 60e3) syncSoon(2000); }

module.exports = { start, handle, snapshot, nudge, parseIcs };
