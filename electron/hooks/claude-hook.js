#!/usr/bin/env node
'use strict';
/*
 * Claude Code hook for Dynamic Island.
 * Claude Code runs this at each step and pipes the event as JSON on stdin. We forward a trimmed copy
 * to the island over 127.0.0.1. For permission requests we wait for your Allow / Deny in the island.
 *
 * Safe by design:
 *  - If the island isn't running, or anything goes wrong, we print nothing and exit 0, so Claude Code
 *    carries on exactly as if this hook didn't exist (you get the normal prompt in the terminal).
 *  - If you don't answer in the island within WAIT_MS, Claude Code falls back to its normal prompt.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const WAIT_MS = 55 * 1000;
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const infoFile = path.join(appData, 'dynamic-island', 'agent-server.json');

const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);
function trimInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = cut(v, k === 'command' ? 600 : 300);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function post(info, route, payload, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: info.port, path: route, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Island-Token': info.token },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let ev;
  try { ev = JSON.parse(raw.replace(/^﻿/, '')); } catch { return; } // some shells prepend a byte-order mark

  let info;
  try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return; } // island not running

  const payload = {
    agent: 'claude-code',
    hook_event_name: ev.hook_event_name,
    session_id: ev.session_id,
    cwd: ev.cwd,
    permission_mode: ev.permission_mode,
    tool_name: ev.tool_name,
    tool_input: trimInput(ev.tool_input),
    prompt: cut(ev.prompt, 300),
    session_title: cut(ev.session_title, 120),
    message: cut(ev.message, 300),
    notification_type: ev.notification_type,
    last_assistant_message: cut(ev.last_assistant_message, 1500),
    source: ev.source,
    reason: ev.reason,
    agent_type: ev.agent_type,
    at: Date.now(),
  };

  if (ev.hook_event_name === 'PermissionRequest') {
    const answer = await post(info, '/permission', payload, WAIT_MS);
    const decision = answer && answer.decision;
    if (decision === 'allow') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
    } else if (decision === 'deny') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from Dynamic Island.' } } }));
    }
    return; // no answer: print nothing, Claude Code shows its normal prompt
  }

  await post(info, '/event', payload, 1500);
}

main().catch(() => {}).finally(() => process.exit(0));
