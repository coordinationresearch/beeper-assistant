// Whether a group Addressed the Owner, and what that does to the Triage list (ADR 0145). Invented
// groups, names, and messages only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex } from '../scripts/lib/contacts.mjs';
import { SMALL_GROUP_OTHERS, groupRead } from '../scripts/lib/addressed.mjs';
import { renderTriage } from '../scripts/lib/render.mjs';
import { dismiss, pruneDismissed } from '../scripts/lib/state.mjs';
import { dismissalHolds, isGroup, isMessagePreview } from '../scripts/lib/triage.mjs';
import { MAX_READ_GROUPS, collectTriage } from '../scripts/lib/triage-run.mjs';
import { CONTACT_ROWS, NOW, chat, person } from './fixtures.mjs';

const contacts = buildIndex(CONTACT_ROWS);
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const mine = (id, minutes, text = 'who is bringing the grill?') => ({ id, isSender: true, senderName: 'Owner', text, timestamp: at(minutes), type: 'TEXT' });
const theirs = (id, minutes, text, who = 'Ana Example') => ({ id, isSender: false, senderName: who, text, timestamp: at(minutes), type: 'TEXT' });
const members = (n) => Array.from({ length: n }, (_, i) => person({ name: `Member${i} Example` }));
// A group the Owner wrote in, then someone asked something: read, so only its messages can keep it.
const asked = (id, others, text = 'are you around saturday?', o = {}) => ({
  chat: chat({ id, type: 'group', title: `Group ${id}`, others: members(others), lastFrom: 'them', text, previewID: `${id}-q`, hoursAgo: 1, ...o }),
  page: [mine(`${id}-o`, 120), theirs(`${id}-q`, 60, text, 'Member0 Example')],
});
const reads = (groups, extra = {}) => ({ chatsSince: async () => ({ chats: groups.map((g) => g.chat), truncated: false }), contacts: async () => contacts, state: () => null,
  messages: async (id) => structuredClone(groups.find((g) => g.chat.id === id).page), ...extra });

test('in a group of the Owner and at most three others, any question in their Burst addresses the Owner', () => {
  assert.equal(SMALL_GROUP_OTHERS, 3);
  const page = [mine('o1', 120), theirs('a', 60, 'lol'), theirs('b', 50, 'anyone up for tacos tonight?'), theirs('c', 40, 'or friday')];
  const small = groupRead(page, { others: 3, now: NOW });
  assert.deepEqual([small.addressed, small.addressedIn], ['question', 'b'], 'the newest question names the message');
  assert.equal(groupRead(page, { others: 4, now: NOW }).addressed, null, 'a larger room: a question to everyone is no question to the Owner');
  assert.equal(groupRead(page, { others: 0, now: NOW }).addressed, null, 'members unknown: no small-group rule');
  // A stronger sign wins: their name for the Owner over a question.
  const named = groupRead([mine('o1', 120), theirs('a', 60, 'anyone free?'), theirs('b', 50, 'sam you in?')], { others: 2, names: ['sam'], now: NOW });
  assert.deepEqual([named.addressed, named.addressedIn], ['name', 'b']);
  assert.deepEqual([groupRead([theirs('a', 60, 'sam?'), mine('o1', 10)], { others: 2, now: NOW }).addressed], [null], 'the Owner wrote last');
});

test('a small group Addressed by a question stays on the list after the Owner reads it, and a large group asking the room does not', async () => {
  const small = asked('!small', 2), large = asked('!large', 5);
  const t = await collectTriage(reads([small, large]), { now: NOW });
  assert.deepEqual(t.groups.map((r) => [r.id, r.state, r.addressed]), [['!small', 'read', 'question']]);
  assert.equal(t.stats.quietGroups, 1, 'the large group is quiet');
  const row = t.groups[0];
  assert.deepEqual([row.newestID, row.ownerSpoke, row.lastFrom], ['!small-q', true, 'them']);
  // Who wrote the Burst, and who asked, for the Judgment's group frame, kept out of JSON.
  assert.deepEqual([row.senders, row.addressedBy, row.texts], [['Member0 Example'], 'Member0 Example', ['are you around saturday?']]);
  assert.doesNotMatch(JSON.stringify(t), /senders|addressedBy|"texts"/);
  // By the rules alone it is one only the Owner can tell: the Judgment decides whether it is owed.
  assert.equal(row.rank.class, 'unsure');
});

test('an Addressed group the Judgment says is owed ranks Waiting, and one it says is not ranks Nothing owed', async () => {
  const groups = [asked('!owed', 2), asked('!no', 2)];
  const judged = [];
  const judge = async (rows) => { judged.push(...rows.filter((r) => r.type === 'group').map((r) => r.id)); return new Map([['!owed', { owed: 'yes', want: 'plan', urgent: false, gist: 'Saturday plans' }], ['!no', { owed: 'no', want: 'fyi', urgent: false }]]); };
  const t = await collectTriage(reads(groups), { now: NOW, judge });
  const by = (id) => t.groups.find((r) => r.id === id);
  assert.deepEqual(judged.sort(), ['!no', '!owed']);
  assert.deepEqual([by('!owed').rank.class, by('!owed').rank.gist], ['waiting', 'Saturday plans']);
  assert.equal(by('!no').rank.class, 'nothing');
});

test('a Dismiss on a group holds until its next message, read or unread', async () => {
  const quiet = asked('!g', 2), loud = asked('!u', 6, 'party at mine friday', { unread: 3 });
  const state = { dismissed: {}, aliases: {} };
  dismiss(state, quiet.chat, NOW); dismiss(state, loud.chat, NOW);
  let read = [];
  const t = await collectTriage(reads([quiet, loud], { state: () => state, messages: async (id) => { read.push(id); return structuredClone([quiet, loud].find((g) => g.chat.id === id).page); } }), { now: NOW });
  assert.deepEqual([t.groups.length, t.stats.dismissed, read], [0, 2, []], 'off the list, and not even read');
  // Their next message moves the preview: the Dismiss no longer holds.
  const next = { chat: { ...quiet.chat, preview: { ...quiet.chat.preview, id: '!g-next', text: 'still on for saturday?' } }, page: [...quiet.page, theirs('!g-next', 5, 'still on for saturday?', 'Member1 Example')] };
  read = [];
  const after = await collectTriage(reads([next, loud], { state: () => state }), { now: NOW });
  assert.deepEqual(after.groups.map((r) => [r.id, r.addressed]), [['!g', 'question']]);
  assert.equal(after.stats.dismissed, 1);
});

test('a reply to an older message of the Owner\'s is looked up, and a name from the Owner\'s Contacts card counts', async () => {
  const replied = { chat: chat({ id: '!r', type: 'group', title: 'Trip', others: members(6), lastFrom: 'them', text: 'yes!', previewID: 'r1' }),
    page: [theirs('x', 90, 'hi all'), { ...theirs('r1', 30, 'yes!'), linkedMessageID: 'old-mine' }] };
  const named = { chat: chat({ id: '!n', type: 'group', title: 'Book club', others: members(6), lastFrom: 'them', text: 'jordan can you host?', previewID: 'n1' }),
    page: [mine('n0', 200), theirs('n1', 30, 'jordan can you host?')] };
  const lookups = [];
  const t = await collectTriage(reads([replied, named], { message: async (chatID, id) => { lookups.push([chatID, id]); return { id, isSender: true }; } }), { now: NOW, ownerNames: ['Jordan'] });
  assert.deepEqual(t.groups.map((r) => [r.id, r.addressed, r.ownerSpoke]).sort(), [['!n', 'name', true], ['!r', 'reply', true]]);
  assert.deepEqual(lookups, [['!r', 'old-mine']]);
});

test('read groups past the cap are counted and say so, newest first', async () => {
  const groups = Array.from({ length: MAX_READ_GROUPS + 2 }, (_, i) => asked(`!g${i}`, 2, 'are you around saturday?', { hoursAgo: 1 + i / 100 }));
  const read = new Set();
  const t = await collectTriage(reads(groups, { messages: async (id) => { read.add(id); return structuredClone(groups.find((g) => g.chat.id === id).page); } }), { now: NOW, maxGroups: Infinity });
  assert.equal(read.size, MAX_READ_GROUPS);
  assert.equal(read.has(`!g${MAX_READ_GROUPS + 1}`), false, 'the oldest is left');
  assert.equal(t.stats.groupsNotRead, 2);
  assert.match(renderTriage(t), /2 read groups were not checked for whether they addressed you, past the 100 the command reads\./);
});

test('`ba triage` shows an Addressed group under its heading with a flag, and its JSON row keeps its old keys plus what was read', async () => {
  const t = await collectTriage(reads([asked('!small', 2)]), { now: NOW });
  const out = renderTriage(t);
  assert.match(out, /^GROUPS, unread or addressing you$/m);
  assert.match(out, /READ {8}Group !small \(3\) · TestNet · 1h \[ADDRESSED\]  Member0 Example: «are you around saturday\?»\n {11}why: .* \[UNSURE\]$/m);
  // The keys every group row had, then the ones a read adds, as a one-to-one row has them.
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(t)).groups[0]), ['ref', 'id', 'name', 'nameResolved', 'network', 'type', 'members', 'state', 'unreadCount',
    'markedUnread', 'mentions', 'pinned', 'lastActivity', 'ageMs', 'lastFrom', 'lastSender', 'preview', 'kind', 'reaction', 'hasDraft', 'draftKind', 'reminder', 'account',
    'inContacts', 'lastMessageID', 'lastInboundAt', 'ownerSpoke', 'newestID', 'newestHash', 'runIDs', 'waitingSince', 'addressed', 'closeness', 'want', 'nowCue', 'soonCue',
    'endsInQuestion', 'rank']);
});

// Codex review of slice 3a, P2 1: in a large bridged group an @handle mention can be all that
// addressed the Owner, and Beeper's counts clear once they read the group anywhere.
test('a mention keeps addressing the Owner after they read the group elsewhere, while the message it came with is in their Burst', async () => {
  const unreadPage = [mine('o1', 120), theirs('m1', 30, '@jdoe555 can you send the slides?', 'Member0 Example')];
  const group = (o, page = unreadPage) => ({ chat: chat({ id: '!crew', type: 'group', title: 'Crew', others: members(8), lastFrom: 'them', text: page.at(-1).text, previewID: page.at(-1).id, hoursAgo: 0.5, ...o }), page });
  const mentioned = new Map();
  const first = await collectTriage(reads([group({ unread: 1, mentions: 1 })]), { now: NOW, mentioned });
  assert.deepEqual(first.groups.map((r) => [r.state, r.addressed]), [['unread', 'mention']]);
  assert.deepEqual([...mentioned], [['!crew', 'm1']], 'kept by the newest message of their Burst');
  // Read on the phone: no unread count, no mention count, the same Burst.
  const read = await collectTriage(reads([group({})]), { now: NOW, mentioned });
  assert.deepEqual(read.groups.map((r) => [r.state, r.addressed, r.newestID]), [['read', 'mention', 'm1']]);
  assert.equal((await collectTriage(reads([group({})]), { now: NOW })).groups.length, 0, 'without the memory, the counts alone lose it');
  // Someone adds to the Burst: the mention is still in it.
  const longer = [...unreadPage, theirs('m2', 10, 'no rush', 'Member1 Example')];
  assert.deepEqual((await collectTriage(reads([group({}, longer)]), { now: NOW, mentioned })).groups.map((r) => r.addressed), ['mention']);
  // The Owner answers from the phone: a new Burst after it, and the mention is forgotten.
  const answered = [...longer, mine('o2', 5, 'sending now'), theirs('m3', 1, 'thanks', 'Member0 Example')];
  assert.equal((await collectTriage(reads([group({}, answered)]), { now: NOW, mentioned })).groups.length, 0);
  assert.equal(mentioned.size, 0);
  // groupRead itself: a remembered message outside their Burst addresses nobody.
  assert.equal(groupRead(answered, { others: 8, mentionedIn: 'm1', now: NOW }).addressed, null);
  assert.deepEqual(['addressed', 'mentionIn'].map((k) => groupRead(unreadPage, { others: 8, mentionedIn: 'm1', now: NOW })[k]), ['mention', 'm1']);
});

// P2 2: a notice is no Message, so the Owner renaming the group answers nothing.
test('a group whose newest item is the Owner\'s notice is still read, and its unanswered question keeps it on the list', async () => {
  const renamed = { chat: chat({ id: '!trip', type: 'group', title: 'Trip', others: members(2), lastFrom: 'me', text: '{{sender}} named the group Trip', previewID: 'n1', hoursAgo: 0.2 }),
    page: [mine('o1', 120), theirs('q1', 60, 'can you bring the tent?', 'Member0 Example'), { ...mine('n1', 12, '{{sender}} named the group Trip'), type: 'NOTICE', isHidden: true }] };
  const answered = { chat: chat({ id: '!camp', type: 'group', title: 'Camp', others: members(2), lastFrom: 'me', text: 'yes I have one', previewID: 'o2', hoursAgo: 0.2 }),
    page: [mine('o1', 120), theirs('q1', 60, 'can you bring the tent?', 'Member0 Example'), mine('o2', 12, 'yes I have one')] };
  const read = [];
  const t = await collectTriage(reads([renamed, answered], { messages: async (id) => { read.push(id); return structuredClone([renamed, answered].find((g) => g.chat.id === id).page); } }), { now: NOW });
  assert.deepEqual(t.groups.map((r) => [r.id, r.addressed, r.lastFrom]), [['!trip', 'question', 'them']]);
  assert.deepEqual(read, ['!trip'], 'the Owner\'s own Message as the newest item still needs no read');
});

// P2 3: a Dismiss holds until a new Message, so a Reaction or a notice after it ends nothing.
test('a Reaction after a group\'s Dismiss leaves it Dismissed, and their next Message brings it back', async () => {
  const g = asked('!g', 2);
  const state = { dismissed: {}, aliases: {} };
  dismiss(state, g.chat, NOW);
  const tapback = { chat: { ...g.chat, preview: { ...g.chat.preview, id: 'r1', text: '', type: 'REACTION', isHidden: true } },
    page: [...g.page, { ...theirs('r1', 20, '', 'Member1 Example'), type: 'REACTION', isHidden: true, linkedMessageID: '!g-q' }] };
  const t = await collectTriage(reads([tapback], { state: () => state }), { now: NOW });
  assert.deepEqual([t.groups.length, t.stats.dismissed], [0, 1]);
  // `ba triage` prunes Dismisses the preview no longer matches; a group's outlasts a Reaction or a notice.
  const keep = (c) => isGroup(c) && !isMessagePreview(c.preview);
  assert.equal(pruneDismissed(state, [tapback.chat], keep), 0);
  assert.ok(state.dismissed['!g']);
  const next = { chat: { ...g.chat, preview: { ...g.chat.preview, id: 'q2', text: 'still on?' } }, page: [...tapback.page, theirs('q2', 5, 'still on?', 'Member1 Example')] };
  assert.deepEqual((await collectTriage(reads([next], { state: () => state }), { now: NOW })).groups.map((r) => [r.id, r.addressed]), [['!g', 'question']]);
  assert.equal(pruneDismissed(state, [next.chat], keep), 1, 'a new Message ends it');
  assert.equal(dismissalHolds({ dismissed: { '!g': { messageID: 'gone' } } }, g.chat, g.page), false, 'a dismissed item no longer in the page holds nothing');
});

// P2 4: Addressed, a mention included, is Unsure until judged (ADR 0030).
test('on a list ranked by rules alone, a mentioned group is Unsure and counts in no Waiting number; judged owed, it is Waiting', async () => {
  const g = { chat: chat({ id: '!m', type: 'group', title: 'Crew', others: members(8), lastFrom: 'them', text: '@jdoe555 thoughts?', previewID: 'm1', hoursAgo: 0.5, unread: 1, mentions: 1 }),
    page: [mine('o1', 120), theirs('m1', 30, '@jdoe555 thoughts?', 'Member0 Example')] };
  const rules = await collectTriage(reads([g]), { now: NOW });
  assert.deepEqual(rules.groups.map((r) => [r.addressed, r.rank.class]), [['mention', 'unsure']]);
  const judged = await collectTriage(reads([g]), { now: NOW, judge: async () => new Map([['!m', { owed: 'yes', want: 'ask', urgent: false }]]) });
  assert.equal(judged.groups[0].rank.class, 'waiting');
  // Two unread and one in their Burst: the mention may be the earlier Conversation's, so it addresses
  // nobody and the group ranks on the rules.
  const old = { chat: { ...g.chat, unreadCount: 2 }, page: [theirs('m0', 13 * 60, '@jdoe555 earlier?', 'Member0 Example'), theirs('m1', 30, 'anyone?', 'Member1 Example')] };
  const stale = await collectTriage(reads([old]), { now: NOW });
  assert.deepEqual(stale.groups.map((r) => [r.addressed, r.rank.class]), [[null, 'nothing']]);
});
