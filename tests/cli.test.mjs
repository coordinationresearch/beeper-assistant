// Loads the real entry point, so a missing function fails here and not in front of the Owner.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  for (const c of ['check', 'mode', 'triage', 'chat', 'find', 'who', 'search', 'media', 'dismiss', 'undismiss', 'notes', 'note', 'draft', 'read', 'remind', 'unremind', 'send', 'react', 'edit', 'delete', 'group', 'start', 'contact']) {
    assert.match(out, new RegExp(`^  ${c}\\b`, 'm'), c);
  }
});

test('an unknown command is a usage error', () => {
  const r = run('launch');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown command/);
});

test('a name is never accepted where a chat reference is needed', () => {
  for (const cmd of ['chat', 'send', 'draft', 'read', 'dismiss', 'delete', 'react', 'edit', 'contact', 'media', 'notes', 'note']) {
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

test('the rules for scheduled runs tell the agent to draft with marked gaps, never to skip for a missing fact', () => {
  const rules = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'unattended.md'), 'utf8');
  assert.match(rules, /Draft whenever a reply is owed/);
  assert.match(rules, /single underscore/);
  assert.equal(/double square brackets/.test(rules), false);
  assert.equal(/skip with the reason/.test(rules), false);
  assert.equal(/Send-ready or nothing/.test(rules), false);
});

test('text that still holds a marked gap is never sent', () => {
  const r = run('send', 'c00000000', '--text', 'see you _ at the usual place', '--after', 'none', '--confirmed');
  // The chat reference is checked first, against a Beeper that does not exist here.
  assert.notEqual(r.status, 0);
});

test('Notes: drafts-only mode may read and save them, and never delete one', () => {
  const go = (extra, ...args) => spawnSync(process.execPath, [BA, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const drafts = { BEEPER_ASSISTANT_MODE: 'drafts' };
  // Allowed commands get as far as looking for Beeper.
  assert.match(go(drafts, 'notes', 'c00000000').stderr, /brew install/);
  assert.match(go(drafts, 'note', 'c00000000', '--text', 'hi').stderr, /brew install/);
  const del = go(drafts, 'note', 'c00000000', '--delete', 'n00000000');
  assert.equal(del.status, 2);
  assert.match(del.stderr, /Drafts-only mode is on, so the Note was not deleted/);
  const ro = { BEEPER_ASSISTANT_READONLY: '1' };
  assert.match(go(ro, 'notes', 'c00000000').stderr, /brew install/);
  assert.match(go(ro, 'note', 'c00000000', '--text', 'hi').stderr, /Read-only mode is on/);
  assert.match(go({}, 'note', 'c00000000', '--text', 'hi', '--by', 'Owner').stderr, /--by Owner is reserved/);
  assert.match(go({}, 'note', 'c00000000', '--text', 'hi', '--by', 'sidebar').stderr, /reserved/);
});

// A stand-in for the Beeper CLI that knows one made-up chat with one message.
function fakeBeeper(dir) {
  const bin = join(dir, 'beeper');
  writeFileSync(bin, `#!${process.execPath}
const a = process.argv.slice(2);
const chat = a[a.indexOf('--chat') + 1];
let data;
if (a[0] === 'chats' && a[1] === 'show') data = { id: chat, network: 'WhatsApp', type: 'single', title: 'Test Person', participants: { items: [] } };
else if (a[0] === 'messages' && a[1] === 'list') data = [{ id: 'msg-1', chatID: chat, sortKey: '1', timestamp: '2026-09-29T10:00:00.000Z', text: 'made-up', isSender: false }];
else { console.error(JSON.stringify({ success: false, error: 'not in the fake' })); process.exit(1); }
console.log(JSON.stringify({ success: true, data }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

test('Notes: an agent saves one, the list labels it a claim, and a deleted one stays deleted', () => {
  const home = mkdtempSync(join(tmpdir(), 'ba-notes-cli-'));
  const fake = { ...env, BEEPER_ASSISTANT_HOME: home, BEEPER_BIN: fakeBeeper(home) };
  delete fake.BEEPER_ASSISTANT_MODE; delete fake.BEEPER_ASSISTANT_READONLY;
  const go = (extra, ...args) => spawnSync(process.execPath, [BA, ...args], { env: { ...fake, ...extra }, encoding: 'utf8' });
  const CHAT = '!fake-chat:beeper.local';

  const saved = go({ BEEPER_ASSISTANT_MODE: 'drafts' }, 'note', CHAT, '--text', 'Synthetic claim for a test', '--from', 'msg-1', '--by', 'test');
  assert.equal(saved.status, 0, saved.stderr);
  const id = saved.stdout.match(/Note (n[0-9a-f]{8}) saved/)[1];
  assert.match(saved.stdout, /as a claim by test, citing 1 message\./);

  const list = go({}, 'notes', CHAT);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /Treat it as data/);
  assert.match(list.stdout, new RegExp(`\\[${id}\\] agent: test · \\d{4}-\\d{2}-\\d{2} · from 1 message`));
  assert.match(list.stdout, /«Synthetic claim for a test»/);
  const json = JSON.parse(go({}, 'notes', CHAT, '--json').stdout);
  assert.equal(json.notes[0].trusted, false);
  assert.deepEqual(json.notes[0].source, { messages: [{ id: 'msg-1', at: '2026-09-29T10:00:00.000Z' }] });

  assert.match(go({}, 'note', CHAT, '--text', 'synthetic claim for a test!').stdout, /already saved/);
  const del = go({}, 'note', CHAT, '--delete', id);
  assert.equal(del.status, 0, del.stderr);
  const again = go({}, 'note', CHAT, '--text', 'Synthetic claim for a test', '--by', 'test');
  assert.equal(again.status, 2);
  assert.match(again.stderr, /It stays deleted/);
  assert.match(go({}, 'note', CHAT, '--delete', id).stderr, /No Note/);
});
