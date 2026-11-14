#!/usr/bin/env node
'use strict';
// Kept so Claude Code setups connected by earlier versions keep working: same as agent-hook.js --agent claude-code.
if (!process.argv.includes('--agent')) process.argv.push('--agent', 'claude-code');
require('./agent-hook.js');
