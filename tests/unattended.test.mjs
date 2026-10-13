import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../scripts/lib/contacts.mjs';
import { applyContext, buildTriage, finalizeTriage } from '../scripts/lib/triage.mjs';
import { selectPending } from '../scripts/lib/unattended.mjs';
import { CONTACT_ROWS, NOW, chat } from './fixtures.mjs';

const contacts = buildIndex(CONTACT_ROWS);
const at = (h) => new Date(NOW - h * 3_600_000).toISOString();
const msg = (from, text, h = 1, extra = {}) => ({ id: `$${from}-${text}-${h}`, isSender: from === 'me', senderName: from, text, timestamp: at(h), ...extra });

// Builds finished triage rows to pass to selectPending.
function rows(specs) {
  const chats = specs.map((s) => chat({ title: s.name, lastFrom: 'them', unread: s.unread || 0, pinned: s.pinned, draft: s.draft, hoursAgo: s.h || 1, text: s.messages[s.messages.length - 1].text }));
  const t = buildTriage(chats, { now: NOW, contacts, finalize: false });
  t.people.forEach((r, i) => { r.context = specs[i].messages; applyContext(r, r.context, { now: NOW }); });
  return finalizeTriage(t, { maxPeople: 1000, maxGroups: 0 }).people;
}
const friend = (name, h = 1, extra = {}) => ({ name, h, messages: [msg('me', 'hey', h + 5), msg('them', `question from ${name}?`, h)], ...extra });
const stranger = (name, h = 1) => ({ name, h, messages: [msg('them', `pitch from ${name}`, h)] });

test('only people the Owner has written to are drafted for', () => {
  const p = selectPending(rows([friend('Ann'), stranger('Sal')]));
  assert.deepEqual(p.batch.map((r) => r.name), ['Ann']);
  assert.equal(p.counts.strangers, 1);
});

test('a chat that already holds a draft is left alone', () => {
  const p = selectPending(rows([friend('Ann', 1, { draft: 'half typed' }), friend('Ben')]));
  assert.deepEqual(p.batch.map((r) => r.name), ['Ben']);
  assert.equal(p.counts.holdingDraft, 1);
});

test('the batch is capped, and the rest are counted', () => {
  const p = selectPending(rows(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n, i) => friend(n, i + 1))), { max: 5 });
  assert.equal(p.batch.length, 5);
  assert.equal(p.waiting, 7);
});

test('order is pinned, then fresh and newest first, then old and longest wait first', () => {
  const p = selectPending(rows([friend('Old3d', 72), friend('Fresh5h', 5), friend('Old9d', 216), friend('Fresh1h', 1), friend('Pinned4d', 96, { pinned: true })]), { max: 10 });
  assert.deepEqual(p.batch.map((r) => r.name), ['Pinned4d', 'Fresh1h', 'Fresh5h', 'Old9d', 'Old3d']);
});

// ---- the mode guard, through the real entry point ----
const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');
const base = { ...process.env, BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: mkdtempSync(join(tmpdir(), 'ba-test-')) };
delete base.BEEPER_ASSISTANT_READONLY; delete base.BEEPER_ASSISTANT_MODE;
const run = (env, ...args) => spawnSync(process.execPath, [BA, ...args], { env: { ...base, ...env }, encoding: 'utf8', input: '' });

test('drafts-only mode blocks everything another person could see, and mark as read', () => {
  for (const cmd of ['send', 'react', 'edit', 'delete', 'group', 'start', 'contact', 'read', 'remind', 'unremind', 'dismiss', 'undismiss']) {
    const r = run({ BEEPER_ASSISTANT_MODE: 'drafts' }, cmd, 'c00000000', '--text', 'hi', '--confirmed', '--after', 'none');
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /Drafts-only mode is on/, cmd);
  }
});

test('drafts-only mode lets reads and drafts through to Beeper', () => {
  assert.match(run({ BEEPER_ASSISTANT_MODE: 'drafts' }, 'triage').stderr, /brew install/);
  assert.match(run({ BEEPER_ASSISTANT_MODE: 'drafts' }, 'search', 'dinner').stderr, /brew install/);
  assert.match(run({ BEEPER_ASSISTANT_MODE: 'drafts' }, 'media', 'c00000000', 'm00000000').stderr, /brew install/);
  const d = run({ BEEPER_ASSISTANT_MODE: 'drafts' }, 'draft', 'Ann', '--text', 'hi');
  assert.match(d.stderr, /not an exact reference/);
});

// A Beeper CLI for one made-up iMessage Chat where the Owner spoke last. It keeps the Chat's draft in a
// file, since each call is its own process.
function draftingBeeper(dir) {
  const bin = join(dir, 'beeper'), draft = JSON.stringify(join(dir, 'draft.txt'));
  writeFileSync(bin, `#!${process.execPath}
const { existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const a = process.argv.slice(2);
const chat = a[a.indexOf('--chat') + 1];
let data;
if (a[0] === 'chats' && a[1] === 'show') data = { id: chat, network: 'iMessage', type: 'single', title: 'Invented Person', participants: { items: [] }, draft: existsSync(${draft}) ? { text: readFileSync(${draft}, 'utf8') } : null };
else if (a[0] === 'chats' && a[1] === 'draft') { if (a.includes('--clear')) rmSync(${draft}, { force: true }); else writeFileSync(${draft}, a[a.indexOf('--text') + 1]); data = {}; }
else if (a[0] === 'messages' && a[1] === 'list') data = [{ id: 'msg-1', chatID: chat, sortKey: '1', timestamp: '2026-10-10T10:00:00.000Z', text: 'made-up', isSender: true }];
else { console.error(JSON.stringify({ success: false, error: 'not in the fake' })); process.exit(1); }
console.log(JSON.stringify({ success: true, data }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

// A Companion Ask that read the Owner's text late runs in drafts mode too (docs/plans/line.md), and
// references/line.md tells it to save Drafts as usual. Outside a Companion run, drafts mode drafts as
// any Terminal draft does: no --for, the usual --replace rule, and no queue for another Mac (ADR 0183).
test('a late Companion Ask drafts as an attended run does; a drafts-mode Terminal draft needs no --for and is not queued', () => {
  const home = mkdtempSync(join(tmpdir(), 'ba-late-draft-'));
  const CHAT = 'imsg##thread:invented-late';
  const env = { BEEPER_ASSISTANT_HOME: home, BEEPER_BIN: draftingBeeper(home), BEEPER_ASSISTANT_ADDRESSBOOK: home, BEEPER_ASSISTANT_MODE: 'drafts' };
  const late = { ...env, COMPANION_RUN: 'run-invented-late' };
  // It goes to the Companion's one draft writer (ADR 0110). No Companion answers here, so nothing is
  // written, and it never writes to Beeper itself instead.
  const saved = run(late, 'draft', CHAT, '--text', 'running 10 late');
  assert.equal(saved.status, 1, saved.stderr);
  assert.match(saved.stdout, /^Not drafted in Invented Person · iMessage\. Beeper Companion couldn't take this Draft, so nothing was written\./);
  assert.equal(existsSync(join(home, 'draft.txt')), false, 'never written to Beeper straight from the skill');
  assert.equal(existsSync(join(home, 'outbox.jsonl')), false, 'nothing is queued for another Mac');
  // Its other limits stand: it replaces no draft unasked, and sends nothing.
  writeFileSync(join(home, 'draft.txt'), 'on my way');
  assert.match(run(late, 'draft', CHAT, '--text', 'running 10 late').stderr, /already holds a draft/);
  assert.match(run(late, 'send', CHAT, '--text', 'on my way', '--after', 'msg-1', '--confirmed').stderr, /Drafts-only mode is on, so "send" did not run/);
  // From the Terminal, with no Companion on this Mac, it writes to Beeper itself, as in full mode. The
  // Owner spoke last here, which no longer matters, and an iMessage draft is not queued.
  const terminal = { ...env, COMPANION_RUN: '' };
  assert.match(run(terminal, 'draft', CHAT, '--text', 'running 10 late', '--for', 'msg-1').stderr, /--for is not supported by draft/);
  const kept = run(terminal, 'draft', CHAT, '--text', 'running 10 late');
  assert.equal(kept.status, 2);
  assert.match(kept.stderr, /This chat already holds a draft: «on my way»\. It may be the Owner's own\. Ask before replacing it, then run again with --replace\./);
  const replaced = run(terminal, 'draft', CHAT, '--text', 'running 10 late', '--replace');
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(replaced.stdout, 'Draft saved in Invented Person · iMessage. Nothing was sent. The Owner can review and send it in Beeper.\n');
  assert.equal(readFileSync(join(home, 'draft.txt'), 'utf8'), 'running 10 late');
  assert.equal(existsSync(join(home, 'outbox.jsonl')), false, 'nothing is queued for another Mac');
});

test('read-only wins over drafts-only, and an unknown mode is refused', () => {
  const r = run({ BEEPER_ASSISTANT_MODE: 'drafts', BEEPER_ASSISTANT_READONLY: '1' }, 'draft', 'c00000000', '--text', 'hi');
  assert.match(r.stderr, /Read-only mode is on/);
  const bad = run({ BEEPER_ASSISTANT_MODE: 'yolo' }, 'triage');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Use full, drafts, or readonly/);
});

test('a mode file pins the mode, and the stricter of file and environment wins', () => {
  const home = mkdtempSync(join(tmpdir(), 'ba-mode-'));
  writeFileSync(join(home, 'mode'), 'drafts\n');
  const env = { BEEPER_ASSISTANT_HOME: home };
  assert.match(run({ ...env }, 'send', 'c00000000', '--text', 'x').stderr, /Drafts-only mode is on/);
  assert.match(run({ ...env, BEEPER_ASSISTANT_MODE: 'full' }, 'send', 'c00000000', '--text', 'x').stderr, /Drafts-only mode is on/);
  assert.match(run({ ...env, BEEPER_ASSISTANT_MODE: 'readonly' }, 'draft', 'c00000000', '--text', 'x').stderr, /Read-only mode is on/);
  writeFileSync(join(home, 'mode'), 'banana');
  assert.match(run({ ...env }, 'triage').stderr, /mode file .* says "banana"/);
});

test('an unattended run is never handed a chat that only says thanks', () => {
  const thanks = { name: 'Thanker', h: 1, messages: [msg('me', 'sent it over', 3), msg('them', 'thanks so much!', 1)] };
  const p = selectPending(rows([thanks, friend('Ann', 2)]));
  assert.deepEqual(p.batch.map((r) => r.name), ['Ann']);
});

test("a Chat whose newest Message the Owner answered with a Reaction is not Pending", () => {
  const reacted = friend('Ann', 1);
  reacted.messages = [...reacted.messages, { id: '$r', isSender: true, type: 'REACTION', isHidden: true, linkedMessageID: reacted.messages[1].id, text: '', timestamp: at(0.5) }];
  const earlier = friend('Ben', 1);
  earlier.messages = [msg('me', 'hey', 6), msg('them', 'first', 1.5), msg('them', 'second?', 1), { id: '$r2', isSender: true, type: 'REACTION', isHidden: true, linkedMessageID: '$them-first-1.5', text: '', timestamp: at(0.5) }];
  const p = selectPending(rows([{ ...reacted, unread: 1 }, earlier]));
  assert.deepEqual(p.batch.map((r) => r.name), ['Ben'], 'a Reaction to an earlier Message leaves Ben owed');
  assert.equal(p.counts.ownerSpokeLast, 1);
});
