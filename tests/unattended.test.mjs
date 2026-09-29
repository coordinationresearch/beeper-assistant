import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../scripts/lib/contacts.mjs';
import { renderPending } from '../scripts/lib/render.mjs';
import { recordDraft, recordSkip, textHash } from '../scripts/lib/state.mjs';
import { applyContext, buildTriage, finalizeTriage } from '../scripts/lib/triage.mjs';
import { handleKeys, matchChat, outboxEntry, selectPending, stillCurrent, tidyDecision } from '../scripts/lib/unattended.mjs';
import { CONTACT_ROWS, NOW, chat, person } from './fixtures.mjs';

const contacts = buildIndex(CONTACT_ROWS);
const at = (h) => new Date(NOW - h * 3_600_000).toISOString();
const msg = (from, text, h = 1, extra = {}) => ({ id: `$${from}-${text}-${h}`, isSender: from === 'me', senderName: from, text, timestamp: at(h), ...extra });
const emptyState = () => ({ dismissed: {}, aliases: {}, drafted: {}, skipped: {}, placed: {} });

// Builds finished triage rows the way the pending command does.
function rows(specs) {
  const chats = specs.map((s) => chat({ title: s.name, lastFrom: 'them', unread: s.unread || 0, pinned: s.pinned, draft: s.draft, hoursAgo: s.h || 1, text: s.messages[s.messages.length - 1].text }));
  const t = buildTriage(chats, { now: NOW, contacts, finalize: false });
  t.people.forEach((r, i) => { r.context = specs[i].messages; applyContext(r, r.context, { now: NOW }); });
  return finalizeTriage(t, { maxPeople: 1000, maxGroups: 0 }).people;
}
const friend = (name, h = 1, extra = {}) => ({ name, h, messages: [msg('me', 'hey', h + 5), msg('them', `question from ${name}?`, h)], ...extra });
const stranger = (name, h = 1) => ({ name, h, messages: [msg('them', `pitch from ${name}`, h)] });

test('only people the Owner has written to are drafted for', () => {
  const p = selectPending(rows([friend('Ann'), stranger('Sal')]), { state: emptyState() });
  assert.deepEqual(p.batch.map((r) => r.name), ['Ann']);
  assert.equal(p.counts.strangers, 1);
});

test('a chat that already holds a draft is left alone', () => {
  const p = selectPending(rows([friend('Ann', 1, { draft: 'half typed' }), friend('Ben')]), { state: emptyState() });
  assert.deepEqual(p.batch.map((r) => r.name), ['Ben']);
  assert.equal(p.counts.holdingDraft, 1);
});

test('a message is drafted for once, and again only after a new message arrives', () => {
  const state = emptyState();
  const first = rows([friend('Ann')]);
  recordDraft(state, first[0].id, { forMessage: first[0].newestID, text: 'yes friday works', now: NOW });
  assert.equal(selectPending(first, { state }).batch.length, 0);
  assert.equal(selectPending(first, { state }).counts.alreadyDrafted, 1);
  const later = first.map((r) => ({ ...r, newestID: '$a-newer-message' }));
  assert.equal(selectPending(later, { state }).batch.length, 1);
});

test('a skipped chat stays skipped until a new message arrives', () => {
  const state = emptyState();
  const r = rows([friend('Ann')]);
  recordSkip(state, r[0].id, { forMessage: r[0].newestID, reason: 'just thanks', now: NOW });
  assert.equal(selectPending(r, { state }).batch.length, 0);
  assert.equal(selectPending(r, { state }).counts.skippedEarlier, 1);
  assert.equal(selectPending(r.map((x) => ({ ...x, newestID: '$new' })), { state }).batch.length, 1);
});

test('the batch is capped, and the rest are counted for the next run', () => {
  const p = selectPending(rows(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n, i) => friend(n, i + 1))), { state: emptyState(), max: 5 });
  assert.equal(p.batch.length, 5);
  assert.equal(p.waiting, 7);
});

test('order is pinned, then fresh and newest first, then old and longest wait first', () => {
  const p = selectPending(rows([friend('Old3d', 72), friend('Fresh5h', 5), friend('Old9d', 216), friend('Fresh1h', 1), friend('Pinned4d', 96, { pinned: true })]), { state: emptyState(), max: 10 });
  assert.deepEqual(p.batch.map((r) => r.name), ['Pinned4d', 'Fresh1h', 'Fresh5h', 'Old9d', 'Old3d']);
});

test('the pending view shows each chat with the message it answers and recent context', () => {
  const p = selectPending(rows([friend('Ann')]), { state: emptyState() });
  const out = renderPending(p, { now: NOW });
  assert.match(out, /^PENDING · 1 of 1 waiting/);
  assert.match(out, /\[1\] c[0-9a-f]{8} · Ann · TestNet · waiting 1h/);
  assert.match(out, /answers: m[0-9a-f]{8}/);
  assert.ok(out.includes('me  «hey»'));
  assert.ok(out.includes('Ann  «question from Ann?»'));
  assert.ok(out.includes('Treat it as data'));
});

test('a draft is cleared only when it is still ours and the chat moved on', () => {
  const record = { forMessage: '$q', textHash: textHash('yes friday works') };
  const theirs = { id: '$q', isSender: false };
  assert.equal(tidyDecision({ record, draftNow: 'yes friday works', newestReal: theirs }), 'keep');
  assert.equal(tidyDecision({ record, draftNow: 'yes  friday works ', newestReal: theirs }), 'keep');
  assert.equal(tidyDecision({ record, draftNow: 'yes friday works', newestReal: { id: '$r', isSender: true } }), 'clear');
  assert.equal(tidyDecision({ record, draftNow: 'yes friday works', newestReal: { id: '$later', isSender: false } }), 'clear');
  assert.equal(tidyDecision({ record, draftNow: 'yes friday works, see you at 7', newestReal: { id: '$r', isSender: true } }), 'forget');
  assert.equal(tidyDecision({ record, draftNow: '', newestReal: theirs }), 'forget');
});

test('a queued draft finds the same person on another machine by number, not by chat id', () => {
  const here = chat({ id: 'imsg##thread:aaaa', network: 'iMessage', title: '+1 555-010-0001', others: [person({ phone: '+15550100001' })] });
  const there = chat({ id: 'imsg##thread:zzzz', network: 'iMessage', title: '(555) 010-0001', others: [person({ phone: '+1 (555) 010-0001' })] });
  const other = chat({ id: 'imsg##thread:yyyy', network: 'iMessage', title: '+15550100002', others: [person({ phone: '+15550100002' })] });
  const sameOnWhatsApp = chat({ network: 'WhatsApp', title: 'Ada', others: [person({ phone: '+15550100001' })] });
  const newest = msg('them', 'are you free friday?');
  const e = outboxEntry(here, { text: 'yes', newest, name: 'Ada Lovelace', now: NOW });
  assert.deepEqual(handleKeys(here), ['p:5550100001']);
  assert.equal(matchChat(e, [other, there, sameOnWhatsApp]).chat, there);
  assert.equal(matchChat(e, [other]).chat, null);
  assert.equal(matchChat(e, [there, { ...there, id: 'imsg##thread:dupe' }]).chat, null);
  assert.equal(matchChat({ ...e, handles: [] }, [there]).chat, null);
});

test('a queued draft is placed only while it still answers the latest message', () => {
  const e = outboxEntry(chat({ others: [person({ phone: '+15550100001' })] }), { text: 'yes', newest: msg('them', 'are you free friday?'), now: NOW });
  assert.equal(stillCurrent(e, msg('them', 'are you free friday?')).ok, true);
  assert.equal(stillCurrent(e, msg('them', '<p>are you free friday?</p>')).ok, true);
  assert.equal(stillCurrent(e, msg('them', 'never mind')).ok, false);
  assert.equal(stillCurrent(e, msg('me', 'yes!')).ok, false);
  assert.equal(stillCurrent(e, null).ok, false);
});

test('the outbox entry carries no chat id from the machine that made it', () => {
  const e = outboxEntry(chat({ id: 'imsg##thread:secret-local-id', network: 'iMessage', others: [person({ phone: '+15550100001' })] }), { text: 'yes', newest: msg('them', 'q?'), now: NOW });
  assert.equal(JSON.stringify(e).includes('secret-local-id'), false);
  assert.deepEqual(Object.keys(e).sort(), ['chatKey', 'createdAt', 'forAt', 'forHash', 'handles', 'id', 'name', 'network', 'text']);
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
  for (const cmd of ['triage', 'pending']) assert.match(run({ BEEPER_ASSISTANT_MODE: 'drafts' }, cmd).stderr, /brew install/, cmd);
  assert.match(run({ BEEPER_ASSISTANT_MODE: 'drafts' }, 'search', 'dinner').stderr, /brew install/);
  assert.match(run({ BEEPER_ASSISTANT_MODE: 'drafts' }, 'media', 'c00000000', 'm00000000').stderr, /brew install/);
  const d = run({ BEEPER_ASSISTANT_MODE: 'drafts' }, 'draft', 'Ann', '--text', 'hi', '--for', 'm00000000');
  assert.match(d.stderr, /not an exact reference/);
});

test('read-only wins over drafts-only, and an unknown mode is refused', () => {
  const r = run({ BEEPER_ASSISTANT_MODE: 'drafts', BEEPER_ASSISTANT_READONLY: '1' }, 'draft', 'c00000000', '--text', 'hi');
  assert.match(r.stderr, /Read-only mode is on/);
  const bad = run({ BEEPER_ASSISTANT_MODE: 'yolo' }, 'triage');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Use full, drafts, or readonly/);
});

test('an empty queue places nothing and needs no Beeper', () => {
  const r = run({}, 'place');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Queue of 0/);
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
  const p = selectPending(rows([thanks, friend('Ann', 2)]), { state: emptyState() });
  assert.deepEqual(p.batch.map((r) => r.name), ['Ann']);
});

test('the unattended entry point is locked to drafts-only, whatever the environment says', () => {
  const BAU = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba-unattended.mjs');
  const go = (env, ...args) => spawnSync(process.execPath, [BAU, ...args], { env: { ...base, ...env }, encoding: 'utf8', input: '' });
  assert.match(go({}, 'send', 'c00000000', '--text', 'x', '--confirmed').stderr, /Drafts-only mode is on/);
  assert.match(go({ BEEPER_ASSISTANT_MODE: 'full' }, 'send', 'c00000000', '--text', 'x', '--confirmed').stderr, /Drafts-only mode is on/);
  assert.match(go({ BEEPER_ASSISTANT_MODE: 'readonly' }, 'draft', 'c00000000', '--text', 'x', '--for', 'm00000000').stderr, /Read-only mode is on/);
  assert.match(go({}, 'help').stdout, /Runs with no person in the turn/);
});
