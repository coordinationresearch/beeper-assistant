// ba search --opens-group against a made-up corpus: the Owner's first message in each group they opened.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { groupOpeners } from '../scripts/lib/corpus.mjs';

const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T12:00:00Z');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The subset of the companion's corpus schema the reader touches.
function makeCorpus(groups) {
  const file = join(mkdtempSync(join(tmpdir(), 'ba-openers-')), 'corpus.db');
  const sql = [`
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES ('corpus-0003-review-fixes', '2026-09-30');
    CREATE TABLE corpus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO corpus_meta VALUES ('built_at', '2026-10-01T00:00:00Z');
    CREATE TABLE people (person_id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE person_members (member_key TEXT PRIMARY KEY, person_id TEXT NOT NULL);
    CREATE TABLE handles (handle_key TEXT PRIMARY KEY, network TEXT, display_name TEXT, is_owner INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE chats (chat_key TEXT PRIMARY KEY, network TEXT, kind TEXT, merged_into TEXT);
    CREATE TABLE chat_members (chat_key TEXT, handle_key TEXT, has_left INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_key, handle_key));
    CREATE TABLE messages (id INTEGER PRIMARY KEY, message_key TEXT, chat_key TEXT, from_owner INTEGER, sent_at INTEGER, kind TEXT, text TEXT,
      retracted INTEGER NOT NULL DEFAULT 0, duplicate_of TEXT, source_state TEXT NOT NULL DEFAULT 'present');
    INSERT INTO handles VALUES ('imessage:owner', 'imessage', 'Robin', 1);`];
  const named = new Set();
  let n = 0;
  for (const [i, g] of groups.entries()) {
    const chat = `group${i}`;
    sql.push(`INSERT INTO chats VALUES (${q(chat)}, 'imessage', ${q(g.kind ?? 'group')}, NULL);`);
    sql.push(`INSERT INTO chat_members VALUES (${q(chat)}, 'imessage:owner', 0);`);
    for (const name of g.members) {
      const handle = `imessage:${name.replace(/\W/g, '').toLowerCase()}`;
      if (!named.has(handle)) {
        named.add(handle);
        sql.push(`INSERT INTO handles VALUES (${q(handle)}, 'imessage', NULL, 0);`);
        sql.push(`INSERT INTO people VALUES (${q(`p_${handle}`)}, ${q(name)});`, `INSERT INTO person_members VALUES (${q(handle)}, ${q(`p_${handle}`)});`);
      }
      sql.push(`INSERT INTO chat_members VALUES (${q(chat)}, ${q(handle)}, 0);`);
    }
    for (const [j, m] of g.messages.entries()) {
      sql.push(`INSERT INTO messages (message_key, chat_key, from_owner, sent_at, kind, text, retracted, duplicate_of) VALUES (${q(`m${++n}`)}, ${q(chat)}, ${m.owner ? 1 : 0},
        ${T0 + i * DAY + j * 60_000}, ${q(m.kind ?? 'text')}, ${q(m.text)}, ${m.retracted ? 1 : 0}, ${m.twin ? q('m1') : 'NULL'});`);
    }
  }
  execFileSync('/usr/bin/sqlite3', [file], { input: sql.join('\n') });
  return file;
}

const env = (corpus, more = {}) => ({ ...process.env, BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: mkdtempSync(join(tmpdir(), 'ba-test-')), BEEPER_ASSISTANT_CORPUS: corpus, ...more });
const run = (corpus, ...args) => spawnSync(process.execPath, [BA, ...args], { env: env(corpus), encoding: 'utf8' });

const owner = (text, more = {}) => ({ owner: true, text, ...more });
const them = (text) => ({ owner: false, text });

test('an opener is the Owner writing first in a group, newest first, with its members', async () => {
  const file = makeCorpus([
    { members: ['Ana Reyes', 'Ben Cho'], messages: [owner('Ana Reyes 🤝 Ben Cho\n\nAna and I met at a pottery class!'), them('hi!')] },
    { members: ['Kim Ito', 'Max Ruiz'], messages: [them('Kim here'), owner('welcome')] },
    { members: ['Ana Reyes', 'Ben Cho', 'Dev Patel'], messages: [owner('dinner Friday?')] },
    { members: ['Lee Moss'], kind: 'single', messages: [owner('hey Lee')] },
  ]);
  const { items, more } = await groupOpeners(file);
  assert.equal(more, false);
  assert.deepEqual(items.map((o) => o.text.split('\n')[0]), ['dinner Friday?', 'Ana Reyes 🤝 Ben Cho']);
  assert.deepEqual(items[1].members, ['Ana Reyes', 'Ben Cho']);
  assert.equal(items[1].network, 'imessage');
  assert.equal(items[1].at, new Date(T0).toISOString());
  assert.deepEqual((await groupOpeners(file, { members: 2 })).items.map((o) => o.members.length), [2]);
  assert.deepEqual((await groupOpeners(file, { words: 'POTTERY ana' })).items.length, 1);
  assert.deepEqual((await groupOpeners(file, { sinceMs: T0 + DAY })).items.map((o) => o.text), ['dinner Friday?']);
});

test('the first counted message decides: a retracted or twin opener is skipped, one text in several groups counts once', async () => {
  const file = makeCorpus([
    { members: ['Ana Reyes', 'Ben Cho'], messages: [owner('connecting you!'), them('thanks')] },
    { members: ['Ana Reyes', 'Lee Moss'], messages: [owner('oops', { retracted: true }), them('Lee here')] },
    { members: ['Dev Patel', 'Ben Cho'], messages: [owner('twin copy', { twin: true }), owner('connecting you two')] },
    { members: ['Kim Ito', 'Max Ruiz'], messages: [owner('same words twice')] },
    { members: ['Kim Ito', 'Lee Moss'], messages: [owner('a group of its own')] },
    { members: ['Max Ruiz', 'Kim Ito'], messages: [owner('same words twice')] },
  ]);
  const { items } = await groupOpeners(file);
  // The newer copy of the repeated text stands for both.
  assert.deepEqual(items.map((o) => o.text), ['same words twice', 'a group of its own', 'connecting you two', 'connecting you!']);
  const capped = await groupOpeners(file, { max: 2 });
  assert.deepEqual([capped.items.length, capped.more], [2, true]);
});

test('ba search --opens-group prints each opener with its members, and checks its flags', () => {
  const groups = Array.from({ length: 12 }, (_, i) => ({ members: ['Ana Reyes', `Pat${String.fromCharCode(97 + i)} Doe`], messages: [owner(`Ana 🤝 Pat${String.fromCharCode(97 + i)}\nYou both love chess`)] }));
  const file = makeCorpus(groups);
  const r = run(file, 'search', '--opens-group', '--members', '2', '--max', '5');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^GROUP OPENERS · newest 5 with 2 other people\. The Owner's own first message/);
  assert.match(r.stdout, /^2026-09-12 · iMessage · Ana Reyes, Patl Doe\n {2}Ana 🤝 Patl\n {2}You both love chess$/m);
  assert.equal((r.stdout.match(/^2026-/gm) || []).length, 5);
  const json = JSON.parse(run(file, 'search', 'chess', '--opens-group', '--json').stdout);
  assert.deepEqual([json.query, json.openers.length, json.more], ['chess', 12, false]);
  assert.match(run(file, 'search', '--opens-group', '--members', '1').stderr, /--members counts the people besides the Owner/);
  assert.match(run(file, 'search', '--opens-group', '--from', 'me').stderr, /--opens-group takes words/);
  assert.match(run(file, 'search', '--opens-group', '--from', 'ann').stderr, /--opens-group takes words/);
  assert.match(run(file, 'search', '--opens-group', '--limit', '5').stderr, /--opens-group takes words/);
  assert.match(run(file, 'search', '--opens-group', '--max', '2.5').stderr, /--max must be between 1 and 100/);
  assert.match(run(file, 'search', 'chess', '--members', '2').stderr, /--members goes with --opens-group/);
  assert.match(run(file, 'search', '--opens-group', 'nothing-like-this').stdout, /GROUP OPENERS · none with "nothing-like-this"/);
});

test('with no corpus it says why, and read-only mode allows it', () => {
  const missing = run('/nonexistent/corpus.db', 'search', '--opens-group');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No group openers: no corpus on this Mac/);
  const file = makeCorpus([{ members: ['Ana Reyes', 'Ben Cho'], messages: [owner('Ana 🤝 Ben')] }]);
  const r = spawnSync(process.execPath, [BA, 'search', '--opens-group'], { env: env(file, { BEEPER_ASSISTANT_MODE: 'readonly' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Ana 🤝 Ben/);
});
