#!/usr/bin/env node
'use strict';
/*
 * One hook for every AI agent that reports to Dynamic Island.
 *   node agent-hook.js --agent <claude-code|copilot|gemini|cursor|codex> [--event <name>]
 * Each agent calls it in its own way (JSON on stdin, or JSON as the last argument for Codex).
 * We translate the agent's event into the island's format and send it over 127.0.0.1.
 *
 * Safe by design: if the island isn't running or anything fails, we print the agent's "no opinion"
 * answer and exit 0, so the agent carries on exactly as it would without us. Only Claude Code and
 * GitHub Copilot wait for an Allow / Deny from the island (up to WAIT_MS); for every other agent and
 * event we never block, approve or deny anything.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const WAIT_MS = 55 * 1000;
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const infoFile = path.join(appData, 'dynamic-island', 'agent-server.json');

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const AGENT = arg('agent') || 'claude-code';
const EVENT_ARG = arg('event');

const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);
function parseMaybe(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }

/* Tool names differ per agent; map them onto the names the island knows (Read, Edit, Bash, Grep, Web...). */
function normTool(name) {
  const n = String(name || '');
  const l = n.toLowerCase();
  if (/^(read|edit|multiedit|write|bash|powershell|grep|glob|ls|webfetch|websearch|task|agent|todowrite|notebookedit)$/i.test(n) && /^[A-Z]/.test(n)) return n; // already Claude-style
  if (/shell|bash|powershell|terminal|command|exec/.test(l)) return 'Bash';
  if (/^(view|read|read_file|read_many_files|cat)$|read_file|readfile/.test(l)) return 'Read';
  if (/edit|replace|write|create|patch|str_replace|apply/.test(l)) return 'Edit';
  if (/grep|search_file|search|glob|find|list_dir|list_directory|ls/.test(l)) return 'Grep';
  if (/web|fetch|url|browse/.test(l)) return 'WebFetch';
  if (/task|agent|subagent/.test(l)) return 'Task';
  return n || 'Tool';
}
function normInput(input) {
  input = parseMaybe(input);
  if (!input || typeof input !== 'object') return {};
  const out = {};
  const pick = (...keys) => keys.map((k) => input[k]).find((v) => typeof v === 'string');
  const file = pick('file_path', 'filePath', 'path', 'absolute_path', 'target_file', 'notebook_path');
  const command = pick('command', 'cmd', 'commandLine', 'script');
  if (file) out.file_path = cut(file, 300);
  if (command) out.command = cut(command, 600);
  for (const k of ['description', 'pattern', 'url', 'query']) if (typeof input[k] === 'string') out[k] = cut(input[k], 300);
  return out;
}

/* Turn each agent's event into the island's (Claude-style) event, or null to ignore it. */
function normalize(raw) {
  const base = { agent: AGENT, at: Date.now() };
  switch (AGENT) {
    case 'claude-code':
      return { ...base, hook_event_name: raw.hook_event_name, session_id: raw.session_id, cwd: raw.cwd, tool_name: raw.tool_name,
        tool_input: normInput(raw.tool_input), prompt: cut(raw.prompt, 300), session_title: cut(raw.session_title, 120),
        last_assistant_message: cut(raw.last_assistant_message, 1500), message: cut(raw.message || raw.error, 300),
        notification_type: raw.notification_type };

    case 'copilot': { // camelCase payload; the event name comes from --event
      const ev = EVENT_ARG || raw.hook_event_name;
      const common = { ...base, session_id: raw.sessionId || raw.session_id, cwd: raw.cwd };
      const tool = { tool_name: normTool(raw.toolName || raw.tool_name), tool_input: normInput(raw.toolArgs || raw.tool_input) };
      if (ev === 'userPromptSubmitted') return { ...common, hook_event_name: 'UserPromptSubmit', prompt: cut(raw.prompt, 300) };
      if (ev === 'preToolUse') return { ...common, ...tool, hook_event_name: 'PreToolUse' };
      if (ev === 'postToolUse') return { ...common, ...tool, hook_event_name: 'PostToolUse' };
      if (ev === 'postToolUseFailure') return { ...common, ...tool, hook_event_name: 'PostToolUseFailure' };
      if (ev === 'permissionRequest') return { ...common, ...tool, hook_event_name: 'PermissionRequest' };
      if (ev === 'agentStop') return { ...common, hook_event_name: 'Stop' };
      if (ev === 'sessionEnd') return { ...common, hook_event_name: 'SessionEnd' };
      return null;
    }

    case 'gemini': {
      const common = { ...base, session_id: raw.session_id, cwd: raw.cwd };
      const tool = { tool_name: normTool(raw.tool_name), tool_input: normInput(raw.tool_input) };
      const ev = raw.hook_event_name;
      if (ev === 'BeforeAgent') return { ...common, hook_event_name: 'UserPromptSubmit', prompt: cut(raw.prompt, 300) };
      if (ev === 'BeforeTool') return { ...common, ...tool, hook_event_name: 'PreToolUse' };
      if (ev === 'AfterTool') return { ...common, ...tool, hook_event_name: raw.tool_response && raw.tool_response.error ? 'PostToolUseFailure' : 'PostToolUse' };
      if (ev === 'AfterAgent') return { ...common, hook_event_name: 'Stop', last_assistant_message: cut(raw.prompt_response, 1500) };
      if (ev === 'Notification') return { ...common, hook_event_name: 'Attention', message: cut(raw.message || 'Needs your permission', 200) };
      if (ev === 'SessionEnd') return { ...common, hook_event_name: 'SessionEnd' };
      return null;
    }

    case 'cursor': {
      const common = { ...base, session_id: raw.conversation_id || raw.session_id, cwd: (raw.workspace_roots || [])[0] || raw.cwd };
      const ev = raw.hook_event_name;
      if (ev === 'beforeSubmitPrompt') return { ...common, hook_event_name: 'UserPromptSubmit', prompt: cut(raw.prompt, 300) };
      if (ev === 'postToolUse') return { ...common, hook_event_name: 'PostToolUse', tool_name: normTool(raw.tool_name), tool_input: normInput(raw.tool_input) };
      if (ev === 'postToolUseFailure') return { ...common, hook_event_name: 'PostToolUseFailure', tool_name: normTool(raw.tool_name), tool_input: normInput(raw.tool_input) };
      if (ev === 'afterFileEdit') return { ...common, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: raw.file_path } };
      if (ev === 'afterShellExecution') return { ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cut(raw.command, 600) } };
      if (ev === 'stop') return { ...common, hook_event_name: 'Stop' };
      if (ev === 'sessionEnd') return { ...common, hook_event_name: 'SessionEnd' };
      return null;
    }

    case 'codex': { // notify: one JSON argument per finished turn
      if (raw.type !== 'agent-turn-complete') return null;
      const prompts = Array.isArray(raw['input-messages']) ? raw['input-messages'] : [];
      return { ...base, hook_event_name: 'TurnComplete', session_id: raw['thread-id'] || 'codex', cwd: raw.cwd,
        prompt: cut(prompts[prompts.length - 1], 300), last_assistant_message: cut(raw['last-assistant-message'], 1500) };
    }
  }
  return null;
}

/* What each agent should read on stdout when we have no opinion (never approve or deny on our own). */
function neutral() {
  if (AGENT === 'gemini') return '{}';
  if (AGENT === 'cursor') return '{"continue":true}';
  return '';
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

async function readInput() {
  if (AGENT === 'codex') return parseMaybe(process.argv[process.argv.length - 1]); // Codex passes JSON as an argument
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return parseMaybe(raw.replace(/^﻿/, '')); // some shells prepend a byte-order mark
}

async function main() {
  const raw = await readInput();
  if (!raw || typeof raw !== 'object') return;
  const ev = normalize(raw);
  if (!ev || !ev.hook_event_name) return;
  let info;
  try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return; } // island not running

  if (ev.hook_event_name === 'PermissionRequest' && (AGENT === 'claude-code' || AGENT === 'copilot')) {
    const answer = await post(info, '/permission', ev, WAIT_MS);
    const decision = answer && answer.decision;
    if (decision !== 'allow' && decision !== 'deny') return; // no answer: the agent asks you as usual
    answered = true;
    if (AGENT === 'claude-code') {
      const d = decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Dynamic Island.' };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } }));
    } else {
      process.stdout.write(JSON.stringify(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Dynamic Island.' }));
    }
    await new Promise((r) => process.stdout.write('', r)); // make sure the answer is flushed before exiting
    return;
  }
  await post(info, '/event', ev, 1500);
}

let answered = false;
main().catch(() => {}).finally(() => {
  const done = () => process.exit(0);
  const n = answered ? '' : neutral();
  if (n) process.stdout.write(n, done); else done();
});
