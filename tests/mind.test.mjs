// ba mind against a made-up corpus and Mind map file. Nothing here is real.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');

function setup({ map = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ba-mind-'));
  const file = join(dir, 'corpus.db');
  execFileSync('/usr/bin/sqlite3', [file, `
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES ('corpus-0003-review-fixes', '2026-09-30');
    CREATE TABLE corpus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO corpus_meta VALUES ('built_at', '2026-10-01T00:00:00Z');
    CREATE TABLE chats (chat_key TEXT PRIMARY KEY, source TEXT, network TEXT, account TEXT, kind TEXT, title TEXT, counterparty TEXT, merged_into TEXT, beeper_chat_id TEXT, seen_at TEXT);
    CREATE TABLE person_members (member_key TEXT PRIMARY KEY, person_id TEXT NOT NULL);
    CREATE TABLE people (person_id TEXT PRIMARY KEY, display_name TEXT, name_source TEXT, state TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE messages (message_key TEXT PRIMARY KEY, chat_key TEXT, sender TEXT, from_owner INTEGER, sent_at INTEGER, kind TEXT, text TEXT, retracted INTEGER DEFAULT 0, duplicate_of TEXT, source_state TEXT DEFAULT 'present');
    INSERT INTO chats VALUES ('!dana:beeper.local', 'beeper', 'whatsapp', 'x', 'single', 'Dana Example', 'beeper:wa:@dana', NULL, NULL, '');
    INSERT INTO person_members VALUES ('beeper:wa:@dana', 'p_dana');
    INSERT INTO people VALUES ('p_dana', 'Dana Example', 'contacts', 'ok', '', '');
    INSERT INTO messages VALUES ('beeper:$m1', '!dana:beeper.local', NULL, 1, ${Date.parse('2026-09-12T18:00:00Z')}, 'text', 'fired the new kiln twice this week', 0, NULL, 'present');
    INSERT INTO messages VALUES ('beeper:$m2', '!dana:beeper.local', NULL, 1, ${Date.parse('2026-09-13T18:00:00Z')}, 'text', 'oops', 1, NULL, 'present');
    INSERT INTO messages VALUES ('beeper:$m3', '!dana:beeper.local', NULL, 1, ${Date.parse('2026-09-14T18:00:00Z')}, 'text', 'a twin', 0, 'beeper:$m1', 'present');
    INSERT INTO messages VALUES ('beeper:$m4', '!dana:beeper.local', NULL, 1, ${Date.parse('2026-09-15T18:00:00Z')}, 'text', 'gone at the source', 0, NULL, 'gone');
  `]);
  if (map) writeFileSync(join(dir, 'mind-map.md'), '# Mind map\n\n## Pottery · 100% lately · 1 claim\n- 2026-09-12 · did · Fired the new kiln twice this week · beeper:$m1\n');
  const run = (...args) => spawnSync(process.execPath, [BA, 'mind', ...args], { encoding: 'utf8', env: { ...process.env, BEEPER_ASSISTANT_CORPUS: file, BEEPER_ASSISTANT_MODE: 'readonly' } });
  return { dir, run };
}

test('mind prints the file the Beeper Companion wrote, and where it is', () => {
  const { dir, run } = setup();
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Mind map: ${join(dir, 'mind-map.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r.stdout, /Fired the new kiln twice this week · beeper:\$m1/);
});

test('mind says so when there is no Mind map yet', () => {
  const r = setup({ map: false }).run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no Mind map on this Mac yet/);
});

test('--receipt reads the message a claim cites, as data', () => {
  const { run } = setup();
  const r = run('--receipt', 'beeper:$m1');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /The Owner wrote this in a chat with Dana Example on WhatsApp/);
  assert.match(r.stdout, /«fired the new kiln twice this week»/);
  const j = JSON.parse(run('--receipt', 'beeper:$m1', '--json').stdout);
  assert.deepEqual([j.fromOwner, j.text], [true, 'fired the new kiln twice this week']);
});

test('--receipt refuses a message that is gone or retracted', () => {
  const { run } = setup();
  for (const key of ['beeper:$m2', 'beeper:$m3', 'beeper:$m4', 'beeper:$nope']) {
    const r = run('--receipt', key);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no longer has that message/);
  }
});
