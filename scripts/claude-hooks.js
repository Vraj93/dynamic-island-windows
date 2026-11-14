#!/usr/bin/env node
'use strict';
/*
 * Connect or disconnect Claude Code and Dynamic Island.
 *   node scripts/claude-hooks.js connect      add the island's hooks to ~/.claude/settings.json
 *   node scripts/claude-hooks.js disconnect   remove them again
 *   node scripts/claude-hooks.js status       show whether they're installed
 * A timestamped backup of settings.json is written before any change. Other hooks and settings are kept.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const hookScript = path.resolve(__dirname, '..', 'electron', 'hooks', 'claude-hook.js');
const MARK = 'dynamic-island'; // every handler we add carries this in its statusMessage, so we can find it again

// Status updates run in the background so they never slow Claude Code down.
// Permission requests wait (up to the hook's own 55 s) for your Allow / Deny in the island.
const EVENTS = {
  UserPromptSubmit: { async: true },
  PreToolUse: { async: true, matcher: '*' },
  PostToolUse: { async: true, matcher: '*' },
  PostToolUseFailure: { async: true, matcher: '*' },
  PermissionRequest: { async: false, matcher: '*', timeout: 60 },
  Stop: { async: true },
  SessionEnd: { async: true },
};

function load() {
  if (!fs.existsSync(settingsFile)) return {};
  const text = fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, '');
  return text.trim() ? JSON.parse(text) : {};
}

function save(settings) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  if (fs.existsSync(settingsFile)) {
    const backup = settingsFile.replace(/\.json$/, `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(settingsFile, backup);
    console.log('Backup saved:', backup);
  }
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

const isOurs = (h) => h && typeof h.statusMessage === 'string' && h.statusMessage.includes(MARK);

function strip(settings) {
  if (!settings.hooks) return settings;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function connect() {
  const settings = strip(load());
  settings.hooks = settings.hooks || {};
  for (const [event, opt] of Object.entries(EVENTS)) {
    const handler = {
      type: 'command',
      command: process.execPath,          // node.exe, run directly (no shell), as Claude Code's exec form
      args: [hookScript],
      statusMessage: `Updating ${MARK}`,
      ...(opt.async ? { async: true } : {}),
      ...(opt.timeout ? { timeout: opt.timeout } : {}),
    };
    const group = { hooks: [handler] };
    if (opt.matcher) group.matcher = opt.matcher;
    (settings.hooks[event] = settings.hooks[event] || []).push(group);
  }
  save(settings);
  console.log('Connected. Claude Code sessions started from now on will report to Dynamic Island.');
  console.log('Hook script:', hookScript);
}

function disconnect() {
  const before = JSON.stringify(load());
  const settings = strip(load());
  if (JSON.stringify(settings) === before) return console.log('Nothing to remove: Dynamic Island hooks are not installed.');
  save(settings);
  console.log('Disconnected. Dynamic Island hooks removed from', settingsFile);
}

function status() {
  const s = load();
  const found = Object.entries(s.hooks || {}).filter(([, gs]) => (gs || []).some((g) => (g.hooks || []).some(isOurs))).map(([e]) => e);
  console.log(found.length ? `Installed for: ${found.join(', ')}` : 'Not installed.');
}

const cmd = process.argv[2];
if (cmd === 'connect') connect();
else if (cmd === 'disconnect') disconnect();
else if (cmd === 'status') status();
else { console.log('Usage: node scripts/claude-hooks.js connect | disconnect | status'); process.exitCode = 1; }
