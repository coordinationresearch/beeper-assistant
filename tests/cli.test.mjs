// Loads the real entry point, so a missing function fails here and not in front of the Owner.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');
// A Beeper binary that does not exist, and a throwaway state folder. Nothing real is touched.
const env = { ...process.env, BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: mkdtempSync(join(tmpdir(), 'ba-test-')) };
const run = (...args) => spawnSync(process.execPath, [BA, ...args], { env, encoding: 'utf8' });

test('help lists every command', () => {
  const out = execFileSync(process.execPath, [BA, 'help'], { env, encoding: 'utf8' });
  for (const c of ['check', 'mode', 'triage', 'chat', 'find', 'search', 'media', 'dismiss', 'undismiss', 'draft', 'read', 'remind', 'unremind', 'send', 'react', 'edit', 'delete', 'group', 'start', 'contact']) {
    assert.match(out, new RegExp(`^  ${c}\\b`, 'm'), c);
  }
});

test('an unknown command is a usage error', () => {
  const r = run('launch');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown command/);
});

test('a name is never accepted where a chat reference is needed', () => {
  for (const cmd of ['chat', 'send', 'draft', 'read', 'dismiss', 'delete', 'react', 'edit', 'contact', 'media']) {
    const r = run(cmd, 'Ann', '--text', 'hi', '--first', 'A', '--confirmed');
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /not an exact reference/, cmd);
  }
});

test('a missing Beeper CLI gives the install command', () => {
  const r = run('triage');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /brew install beeper\/tap\/cli/);
});

test('search checks its input before it reaches Beeper', () => {
  assert.match(run('search').stderr, /Give words, or --media/);
  assert.match(run('search', 'x', '--media', 'photos').stderr, /--media takes any, image, video, file, link/);
  assert.match(run('search', 'x', '--from', 'ann').stderr, /--from takes me or them/);
  assert.match(run('search', 'x', '--max', '500').stderr, /--max must be between 1 and 100/);
  assert.match(run('search', 'x', '--chat', 'Ann').stderr, /not an exact reference/);
  for (const r of [run('search'), run('search', 'x', '--days', '0')]) assert.equal(r.status, 2);
});

test('group needs at least two source chats', () => {
  const r = run('group', '--from', 'c00000000', '--confirmed');
  assert.equal(r.status, 2);
});

test('help names the --after requirement for send', () => {
  const out = execFileSync(process.execPath, [BA, 'help'], { env, encoding: 'utf8' });
  assert.match(out, /send <chat> --text .* --after <message>/);
});

test('read-only mode blocks every command that writes', () => {
  const ro = { ...env, BEEPER_ASSISTANT_READONLY: '1' };
  for (const cmd of ['draft', 'send', 'read', 'react', 'remind', 'unremind', 'edit', 'delete', 'group', 'start', 'contact']) {
    const r = spawnSync(process.execPath, [BA, cmd, 'c00000000', '--text', 'hi', '--confirmed'], { env: ro, encoding: 'utf8' });
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /Read-only mode is on/, cmd);
  }
  // Reads still get as far as looking for Beeper.
  for (const args of [['triage'], ['search', 'dinner'], ['media', 'c00000000', 'm00000000']]) {
    const r = spawnSync(process.execPath, [BA, ...args], { env: ro, encoding: 'utf8' });
    assert.match(r.stderr, /brew install/, args[0]);
  }
});

test('check names each missing piece and its fix', () => {
  const r = run('check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ok    Node /m);
  assert.match(r.stdout, /^FAIL  Beeper command line tool is not installed$/m);
  assert.match(r.stdout, /Fix: brew install beeper\/tap\/cli/);
  assert.match(r.stdout, /Install Homebrew first, from https:\/\/brew\.sh/);
  assert.match(r.stdout, /^ok    Mode: full/m);
});

test('the mode command tightens and never loosens', () => {
  const home = mkdtempSync(join(tmpdir(), 'ba-mode-'));
  const go = (...args) => spawnSync(process.execPath, [BA, ...args], { env: { ...env, BEEPER_ASSISTANT_HOME: home }, encoding: 'utf8' });
  assert.match(go('mode').stdout, /Mode: full\. No mode file is set/);
  assert.match(go('mode', 'drafts').stdout, /Mode is now drafts/);
  assert.match(go('mode', 'readonly').stdout, /Mode is now readonly/);
  assert.match(go('mode', 'drafts').stderr, /only makes the mode stricter/);
  assert.match(go('mode', 'full').stderr, /only makes the mode stricter/);
  assert.match(go('mode').stdout, /Mode: readonly/);
  assert.match(go('draft', 'c00000000', '--text', 'x').stderr, /Read-only mode is on/);
  assert.match(go('mode', 'banana').stderr, /Usage: mode/);
});
