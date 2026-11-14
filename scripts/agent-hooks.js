#!/usr/bin/env node
'use strict';
/*
 * Connect AI agents to Dynamic Island, or disconnect them.
 *   node scripts/agent-hooks.js status                 JSON: each agent, installed?, connected?
 *   node scripts/agent-hooks.js connect <agent>        agent = claude-code | copilot | gemini | cursor | codex
 *   node scripts/agent-hooks.js disconnect <agent>
 * Each agent's own config gets a few hook entries that run electron/hooks/agent-hook.js. A timestamped backup
 * is made before any file is changed, and only our own entries are ever added or removed.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const HOOK = path.resolve(__dirname, '..', 'electron', 'hooks', 'agent-hook.js');
const NODE = process.versions.electron ? findNode() : process.execPath; // the hook needs a real Node.js
const MARK = 'dynamic-island';

function findNode() {
  try { return execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { return 'node'; }
}
function onPath(cmd) {
  try { execFileSync('where', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

/* ---------- JSON files ---------- */
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const t = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return t.trim() ? JSON.parse(t) : {};
}
function backup(file) {
  if (!fs.existsSync(file)) return;
  const b = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, b);
}
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, text);
}
const writeJson = (file, obj) => writeFile(file, JSON.stringify(obj, null, 2) + '\n');
const mentionsUs = (o) => JSON.stringify(o || {}).includes('agent-hook.js') || JSON.stringify(o || {}).includes('claude-hook.js') || JSON.stringify(o || {}).includes(MARK);

/* Remove our entries from a "hooks" object shaped { Event: [ group, ... ] } where a group may hold "hooks": [...]. */
function stripHooks(hooks) {
  if (!hooks || typeof hooks !== 'object') return hooks;
  for (const [ev, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !mentionsUs(h)) } : g))
      .filter((g) => g && !(Array.isArray(g.hooks) && !g.hooks.length) && !(g.command && mentionsUs(g)) && !(g.exec && mentionsUs(g)));
    if (kept.length) hooks[ev] = kept; else delete hooks[ev];
  }
  return hooks;
}

/* ---------- each agent ---------- */
const AGENTS = {
  'claude-code': {
    name: 'Claude Code',
    file: path.join(HOME, '.claude', 'settings.json'),
    installed() { return fs.existsSync(path.join(HOME, '.claude')) || onPath('claude'); },
    connected() { return mentionsUs(readJson(this.file).hooks); },
    connect() {
      const s = readJson(this.file);
      s.hooks = stripHooks(s.hooks || {});
      // Status events run in the background (never slow Claude down); permission requests wait for your answer.
      const events = { UserPromptSubmit: {}, PreToolUse: { matcher: '*' }, PostToolUse: { matcher: '*' }, PostToolUseFailure: { matcher: '*' },
        PermissionRequest: { matcher: '*', wait: true }, Stop: {}, StopFailure: {}, Notification: { matcher: 'idle_prompt' }, SessionEnd: {} };
      for (const [ev, o] of Object.entries(events)) {
        const h = { type: 'command', command: NODE, args: [HOOK, '--agent', 'claude-code'], statusMessage: `Updating ${MARK}`, ...(o.wait ? { timeout: 60 } : { async: true }) };
        (s.hooks[ev] = s.hooks[ev] || []).push({ ...(o.matcher ? { matcher: o.matcher } : {}), hooks: [h] });
      }
      writeJson(this.file, s);
    },
    disconnect() { const s = readJson(this.file); s.hooks = stripHooks(s.hooks || {}); if (!Object.keys(s.hooks).length) delete s.hooks; writeJson(this.file, s); },
  },

  copilot: {
    name: 'GitHub Copilot CLI',
    // Copilot reads every file in this folder, so the island has its own file: easy to add and remove.
    file: path.join(process.env.COPILOT_HOME || path.join(HOME, '.copilot'), 'hooks', 'dynamic-island.json'),
    installed() { return fs.existsSync(path.dirname(path.dirname(this.file))) || onPath('copilot'); },
    connected() { return fs.existsSync(this.file); },
    connect() {
      const hooks = {};
      for (const ev of ['userPromptSubmitted', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'permissionRequest', 'agentStop', 'sessionEnd']) {
        hooks[ev] = [{ type: 'command', exec: NODE, args: [HOOK, '--agent', 'copilot', '--event', ev], timeoutSec: ev === 'permissionRequest' ? 60 : 5 }];
      }
      writeJson(this.file, { version: 1, hooks });
    },
    disconnect() { if (fs.existsSync(this.file)) { backup(this.file); fs.unlinkSync(this.file); } },
  },

  gemini: {
    name: 'Gemini CLI',
    file: path.join(HOME, '.gemini', 'settings.json'),
    installed() { return fs.existsSync(path.join(HOME, '.gemini')) || onPath('gemini'); },
    connected() { return mentionsUs(readJson(this.file).hooks); },
    connect() {
      const s = readJson(this.file);
      s.hooks = stripHooks(s.hooks || {});
      const cmd = `"${NODE}" "${HOOK}" --agent gemini`;
      for (const ev of ['BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'Notification', 'SessionEnd']) {
        (s.hooks[ev] = s.hooks[ev] || []).push({ matcher: ev.endsWith('Tool') ? '.*' : '', hooks: [{ type: 'command', name: MARK, command: cmd, timeout: 5000 }] });
      }
      writeJson(this.file, s);
    },
    disconnect() { const s = readJson(this.file); s.hooks = stripHooks(s.hooks || {}); if (!Object.keys(s.hooks).length) delete s.hooks; writeJson(this.file, s); },
  },

  cursor: {
    name: 'Cursor',
    file: path.join(HOME, '.cursor', 'hooks.json'),
    installed() { return fs.existsSync(path.join(HOME, '.cursor')) || onPath('cursor') || onPath('cursor-agent'); },
    connected() { return mentionsUs(readJson(this.file).hooks); },
    connect() {
      const s = readJson(this.file);
      s.version = s.version || 1;
      s.hooks = stripHooks(s.hooks || {});
      // Cursor runs hook commands through PowerShell on Windows; "&" runs the quoted node.exe path.
      const cmd = `& "${NODE}" "${HOOK}" --agent cursor`;
      // Only events that report what happened: none of these can approve or block anything.
      for (const ev of ['beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'afterFileEdit', 'afterShellExecution', 'stop', 'sessionEnd']) {
        (s.hooks[ev] = s.hooks[ev] || []).push({ command: cmd, timeout: 5 });
      }
      writeJson(this.file, s);
    },
    disconnect() { const s = readJson(this.file); s.hooks = stripHooks(s.hooks || {}); writeJson(this.file, s); },
  },

  codex: {
    name: 'Codex CLI',
    file: path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml'),
    installed() { return fs.existsSync(path.dirname(this.file)) || onPath('codex'); },
    connected() { return fs.existsSync(this.file) && fs.readFileSync(this.file, 'utf8').includes(`# ${MARK}`); },
    connect() {
      const text = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '';
      if (text.includes(`# ${MARK}`)) return;
      // Codex allows a single "notify" program; don't replace one you already have.
      if (/^\s*notify\s*=/m.test(text)) throw new Error('Codex already has a "notify" program set in config.toml; leaving it as it is.');
      const line = `# ${MARK}: tell Dynamic Island when a turn finishes\nnotify = ['${NODE}', '${HOOK}', '--agent', 'codex']\n`;
      // Top-level keys must come before the first [table] in TOML.
      const i = text.search(/^\s*\[/m);
      writeFile(this.file, i < 0 ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}` : `${text.slice(0, i)}${line}\n${text.slice(i)}`);
    },
    disconnect() {
      if (!fs.existsSync(this.file)) return;
      const text = fs.readFileSync(this.file, 'utf8');
      writeFile(this.file, text.replace(new RegExp(`# ${MARK}[^\\n]*\\nnotify = [^\\n]*\\n\\n?`), ''));
    },
  },
};

function status() {
  const out = {};
  for (const [id, a] of Object.entries(AGENTS)) {
    let installed = false, connected = false;
    try { installed = a.installed(); } catch { /* ignore */ }
    try { connected = a.connected(); } catch { /* ignore */ }
    out[id] = { name: a.name, installed, connected, file: a.file };
  }
  return out;
}

if (require.main === module) {
  const [cmd, id] = process.argv.slice(2);
  try {
    if (cmd === 'status') console.log(JSON.stringify(status()));
    else if ((cmd === 'connect' || cmd === 'disconnect') && AGENTS[id]) { AGENTS[id][cmd](); console.log(JSON.stringify({ ok: true, ...status()[id] })); }
    else { console.log('Usage: node scripts/agent-hooks.js status | connect <agent> | disconnect <agent>'); process.exitCode = 1; }
  } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; }
}
module.exports = { AGENTS, status };
