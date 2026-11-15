#!/usr/bin/env node
'use strict';
// Kept for the npm scripts (connect-claude, disconnect-claude, claude-status): Claude Code only.
// The full version for every agent is scripts/agent-hooks.js.
const { AGENTS } = require('./agent-hooks.js');
const cmd = process.argv[2];
const claude = AGENTS['claude-code'];
if (cmd === 'connect') { claude.connect(); console.log('Connected. Claude Code sessions report to Dynamic Isle.'); }
else if (cmd === 'disconnect') { claude.disconnect(); console.log('Disconnected. Dynamic Isle hooks removed from', claude.file); }
else if (cmd === 'status') console.log(claude.connected() ? 'Installed for Claude Code.' : 'Not installed.');
else { console.log('Usage: node scripts/claude-hooks.js connect | disconnect | status'); process.exitCode = 1; }
