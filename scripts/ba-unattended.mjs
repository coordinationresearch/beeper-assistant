#!/usr/bin/env node
// The entry point for runs with no person in the turn. It is `ba` with drafts-only mode
// switched on before anything else happens, so a scheduler needs no environment setup.
// A stricter setting in the environment or the mode file still wins.
const asked = String(process.env.BEEPER_ASSISTANT_MODE || '').trim().toLowerCase();
if (asked !== 'readonly') process.env.BEEPER_ASSISTANT_MODE = 'drafts';
await import('./ba.mjs');
