// ba who against a made-up corpus file, and the fallback when there is none.
// The tables are the subset of the Beeper Companion's corpus schema this skill reads.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decideSame, emailKey, findPeople, openCorpus, personProfile, phoneDigits } from '../scripts/lib/corpus.mjs';
import { renderWho } from '../scripts/lib/render.mjs';

const JO = emailKey('jopark@googlemail.com');
const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');
const NOW = Date.now();
const DAY = 86_400_000;

// Built with /usr/bin/sqlite3, the same tool the skill reads with, so the test needs no
// Node SQLite module.
function makeCorpus({ built = true } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'ba-corpus-')), 'corpus.db');
  const sql = [`
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES ('corpus-0003-review-fixes', '2026-09-30');
    CREATE TABLE corpus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE people (person_id TEXT PRIMARY KEY, display_name TEXT, name_source TEXT, state TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE person_members (member_key TEXT PRIMARY KEY, person_id TEXT NOT NULL);
    CREATE TABLE retired_people (person_id TEXT PRIMARY KEY, redirect_to TEXT, members TEXT, created_at TEXT, retired_at TEXT);
    CREATE TABLE handles (handle_key TEXT PRIMARY KEY, network TEXT, account TEXT, phone TEXT, email TEXT, username TEXT, display_name TEXT, is_owner INTEGER, seen_at TEXT);
    CREATE TABLE contact_cards (card_key TEXT PRIMARY KEY, source_db TEXT, name TEXT, organization TEXT, modified_at INTEGER, stale INTEGER);
    CREATE TABLE card_addresses (card_key TEXT, kind TEXT, value TEXT, raw TEXT);
    CREATE TABLE chats (chat_key TEXT PRIMARY KEY, source TEXT, network TEXT, account TEXT, kind TEXT, title TEXT, counterparty TEXT, merged_into TEXT, beeper_chat_id TEXT, seen_at TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, message_key TEXT, chat_key TEXT, sent_at INTEGER, from_owner INTEGER, retracted INTEGER DEFAULT 0, duplicate_of TEXT);
    CREATE TABLE person_stats (person_id TEXT PRIMARY KEY, single_chats INTEGER, networks TEXT, from_owner INTEGER, from_them INTEGER, group_from_them INTEGER,
      first_at INTEGER, first_from_owner INTEGER, last_at INTEGER, last_from_owner INTEGER, last_group_at INTEGER, groups_listed INTEGER, groups_active INTEGER,
      conversations INTEGER, owner_started INTEGER, them_started INTEGER, initiation_ratio REAL, owner_reply_first_median_s INTEGER, owner_reply_last_median_s INTEGER,
      owner_reply_first_p90_s INTEGER, owner_replied INTEGER, owner_unanswered INTEGER, their_reply_first_median_s INTEGER, their_reply_last_median_s INTEGER,
      their_reply_first_p90_s INTEGER, their_replied INTEGER, their_unanswered INTEGER, ball_in_court_chats INTEGER, ball_in_court_since INTEGER, by_network TEXT, generation INTEGER);
    CREATE TABLE identity_decisions (a TEXT NOT NULL, b TEXT NOT NULL, decision TEXT NOT NULL, decided_at TEXT NOT NULL, PRIMARY KEY (a, b));
    CREATE TABLE identity_conflicts (id INTEGER PRIMARY KEY, dedupe_key TEXT, reason TEXT, detail TEXT, first_seen TEXT, last_seen TEXT, resolved_at TEXT);
    CREATE TABLE identity_suggestions (a TEXT, b TEXT, reason TEXT);`];
  if (built) sql.push(`INSERT INTO corpus_meta VALUES ('built_at', '${new Date(NOW - 3_600_000).toISOString()}');`);
  const person = (id, name, members) => {
    sql.push(`INSERT INTO people VALUES ('${id}', '${name}', 'contacts', 'ok', '', '');`);
    for (const m of members) sql.push(`INSERT INTO person_members VALUES ('${m}', '${id}');`);
  };
  person('p_aa11', 'Sam Rivera', ['contacts:main:U1', 'imessage:+15550100132', 'beeper:whatsapp:@wa_sam']);
  person('p_bb22', 'Sam Okafor', ['beeper:linkedin:@li_okafor']);
  person('p_cc33', 'Jo Park', [`imessage:${JO}`]);
  sql.push(`INSERT INTO contact_cards VALUES ('contacts:main:U1', 'main', 'Sam Rivera', NULL, NULL, 0);
    INSERT INTO card_addresses VALUES ('contacts:main:U1', 'phone', '+15550100132', '(555) 010-0132');
    INSERT INTO handles (handle_key, network, phone, email, display_name) VALUES ('imessage:+15550100132', 'imessage', '+15550100132', NULL, NULL),
      ('beeper:whatsapp:@wa_sam', 'whatsapp', '+15550100132', NULL, 'Sam R'), ('beeper:linkedin:@li_okafor', 'linkedin', NULL, NULL, 'Sam Okafor'),
      ('imessage:${JO}', 'imessage', NULL, '${JO}', NULL);
    INSERT INTO chats (chat_key, network, kind, counterparty, beeper_chat_id) VALUES
      ('imessage:iMessage;-;+15550100132', 'imessage', 'single', 'imessage:+15550100132', 'imsg##thread:aaaa'),
      ('!wa:beeper.local', 'whatsapp', 'single', 'beeper:whatsapp:@wa_sam', NULL),
      ('imessage:iMessage;-;${JO}', 'imessage', 'single', 'imessage:${JO}', NULL);`);
  for (let i = 0; i < 5; i++) sql.push(`INSERT INTO messages (message_key, chat_key, sent_at, from_owner) VALUES ('k${i}', 'imessage:iMessage;-;+15550100132', ${NOW - i * DAY}, ${i % 2});`);
  sql.push(`INSERT INTO messages (message_key, chat_key, sent_at, from_owner) VALUES ('w1', '!wa:beeper.local', ${NOW - 10 * DAY}, 0);
    INSERT INTO person_stats VALUES ('p_aa11', 2, '["imessage","whatsapp"]', 2, 4, 3, ${NOW - 400 * DAY}, 0, ${NOW - DAY}, 0, ${NOW - 30 * DAY}, 2, 1, 4, 1, 3, 0.25,
      720, 300, 3600, 10, 2, 1500, 600, 7200, 9, 1, 1, ${NOW - DAY}, '{}', 3);
    INSERT INTO identity_suggestions VALUES ('beeper:linkedin:@li_okafor', 'contacts:main:U1', 'same_name_one_way');
    INSERT INTO identity_conflicts (dedupe_key, reason, detail, resolved_at) VALUES ('x', 'shared_address', '{"members":["imessage:${JO}","contacts:main:U9"]}', NULL);`);
  execFileSync('/usr/bin/sqlite3', [file], { input: sql.join('\n') });
  return file;
}

const run = (corpus, ...args) => spawnSync(process.execPath, [BA, ...args], {
  env: { ...process.env, BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: mkdtempSync(join(tmpdir(), 'ba-test-')), BEEPER_ASSISTANT_CORPUS: corpus },
  encoding: 'utf8',
});

test('who reads one person from the corpus: chats with references, stats, and suggestions', () => {
  const r = run(makeCorpus(), 'who', 'sam', 'rivera');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^WHO · Sam Rivera/);
  assert.match(r.stdout, /^c[0-9a-f]+ {2}iMessage · 5 messages · last/m, 'the iMessage chat has a Beeper reference');
  assert.match(r.stdout, /^c[0-9a-f]+ {2}WhatsApp · 1 messages/m);
  assert.match(r.stdout, /4 from them, 2 from you, 3 from them in groups/);
  assert.match(r.stdout, /you started 25%\. Your reply time: median 12m \(10 answered, 2 not within 48h\)\. Theirs: 25m/);
  assert.match(r.stdout, /Ball in the Owner's court: 1 chat/);
  assert.match(r.stdout, /Maybe the same person: Sam Okafor \(p_bb22\)\. Not joined\. Ask the Owner\./);
  assert.match(r.stdout, /built 1h ago/);
});

test('who finds a person by number or by any spelling of a Gmail address', () => {
  assert.match(run(makeCorpus(), 'who', '(555) 010-0132').stdout, /^WHO · Sam Rivera/);
  assert.match(run(makeCorpus(), 'who', '+1 555 010 0132').stdout, /^WHO · Sam Rivera/);
  const jo = run(makeCorpus(), 'who', 'Jo.Park+news@googlemail.com').stdout;
  assert.match(jo, /^WHO · Jo Park/);
  assert.match(jo, /not linked to Beeper yet, use find/);
  assert.match(jo, /Identity conflict \(shared_address\)/);
  assert.match(jo, /No messages with this person/);
});

test('when several people match, who lists them and leaves the choice to the Owner', () => {
  const r = run(makeCorpus(), 'who', 'sam');
  assert.match(r.stdout, /^WHO «sam» · 2 people/);
  assert.match(r.stdout, /^p_aa11 {2}Sam Rivera · iMessage, WhatsApp · 9 messages/m);
  assert.match(r.stdout, /Never pick for them/);
  assert.match(run(makeCorpus(), 'who', 'p_bb22').stdout, /^WHO · Sam Okafor/);
});

test('who --json carries the stats and chat references', () => {
  const j = JSON.parse(run(makeCorpus(), 'who', 'Sam Rivera', '--json').stdout);
  assert.equal(j.person_id, 'p_aa11');
  assert.equal(j.stats.from_them, 4);
  assert.ok(j.chats.every((c) => typeof c.ref === 'string' && c.ref.startsWith('c')));
});

test('with no corpus, or one not built yet, who says so and falls back to live reads', () => {
  const missing = run('/nonexistent/corpus.db', 'who', 'sam');
  assert.match(missing.stderr, /No stats: no corpus on this Mac/);
  assert.match(missing.stderr, /brew install beeper\/tap\/cli/, 'then it ran find, which needs Beeper');
  const unbuilt = run(makeCorpus({ built: false }), 'who', 'sam');
  assert.match(unbuilt.stderr, /has not finished its first build/);
});

test('who is a read, so read-only mode allows it', () => {
  const r = spawnSync(process.execPath, [BA, 'who', 'Sam Rivera'], { env: { ...process.env, BEEPER_ASSISTANT_MODE: 'readonly', BEEPER_ASSISTANT_HOME: mkdtempSync(join(tmpdir(), 'ba-test-')), BEEPER_ASSISTANT_CORPUS: makeCorpus() }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the matching keys agree with the companion', async () => {
  assert.equal(emailKey('Jo.Park+news@GoogleMail.com'), JO);
  assert.equal(emailKey('Jo.Park+news@example.org'), 'jo.park+news@example.org');
  assert.equal(phoneDigits('+1 (555) 010-0132'), '5550100132');
  assert.equal(phoneDigits('12345'), null);
  const file = makeCorpus();
  assert.equal((await openCorpus(file)).ok, true);
  assert.deepEqual((await findPeople(file, "o'brien")), [], 'quotes in a name cannot break the query');
  const p = await personProfile(file, 'p_aa11');
  assert.match(renderWho(p, { now: NOW }), /Groups: 2 together, 1 where they wrote in the last year/);
});

test('same and different record the Owner\'s answer, only with --confirmed, never in an unattended run', () => {
  const file = makeCorpus();
  const no = run(file, 'same', 'p_aa11', 'p_bb22');
  assert.equal(no.status, 2);
  assert.match(no.stderr, /Only the Owner can say/);
  const drafts = spawnSync(process.execPath, [BA, 'same', 'p_aa11', 'p_bb22', '--confirmed'], { env: { ...process.env, BEEPER_ASSISTANT_MODE: 'drafts', BEEPER_ASSISTANT_HOME: mkdtempSync(join(tmpdir(), 'ba-test-')), BEEPER_ASSISTANT_CORPUS: file }, encoding: 'utf8' });
  assert.match(drafts.stderr, /Drafts-only mode is on/);
  const yes = run(file, 'different', 'p_aa11', 'p_bb22', '--confirmed');
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /Recorded: different people/);
  const rows = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-json', file, 'SELECT a, b, decision FROM identity_decisions'], { encoding: 'utf8' }));
  assert.deepEqual(rows, [{ a: 'beeper:linkedin:@li_okafor', b: 'beeper:whatsapp:@wa_sam', decision: 'different' }]);
  // The same write marks People to rebuild at the companion's next update.
  const dirty = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-json', file, "SELECT value FROM corpus_meta WHERE key = 'derived_dirty'"], { encoding: 'utf8' }));
  assert.deepEqual(dirty, [{ value: '1' }]);
  assert.match(run(file, 'same', 'p_aa11', 'p_aa11', '--confirmed').stderr, /already the same person/);
  assert.match(run(file, 'same', 'Sam', 'p_aa11', '--confirmed').stderr, /Usage: same/);
});

test('who reads a corpus in WAL mode whose -wal and -shm files are gone', async () => {
  const file = makeCorpus();
  // An ordinary open and close leaves the database in WAL mode with no sidecar files,
  // which macOS's sqlite3 cannot open read-only.
  execFileSync('/usr/bin/sqlite3', [file, 'PRAGMA journal_mode = WAL; SELECT count(*) FROM people;']);
  assert.match(run(file, 'who', 'Sam Rivera').stdout, /^WHO · Sam Rivera/);
});

test('a Corpus deleted from the menu bar is never created again by a read or an answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ba-deleted-'));
  const file = join(dir, 'corpus.db');
  await assert.rejects(findPeople(file, 'Sam Rivera'));
  await assert.rejects(decideSame(file, 'p_aa11', 'p_bb22', 'same'), /unable to open/);
  assert.ok(!existsSync(file));
  assert.deepEqual(readdirSync(dir), []);
});
