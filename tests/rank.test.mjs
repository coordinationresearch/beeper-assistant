// Ranking the Triage list. Made-up rows and counts only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASSES, closenessOf, compactCount, rankRows, wantOf } from '../scripts/lib/rank.mjs';
import { answerRate } from '../scripts/lib/history.mjs';

const NOW = Date.parse('2026-09-27T20:00:00Z');
const HOUR = 3_600_000;
let n = 0;
// A Triage row as `toRow` and `applyContext` leave it.
function row(o = {}) {
  n += 1;
  const r = { id: o.id || `!chat${n}`, name: o.name || `Person ${n}`, type: o.type || 'single', network: o.network || 'TestNet', account: o.account || 'testnet', state: o.unread ? 'unread' : 'read',
    unreadCount: o.unread || 0, markedUnread: !!o.markedUnread, mentions: o.mentions || 0, pinned: !!o.pinned, ageMs: (o.hours === undefined ? 2 : o.hours) * HOUR,
    lastFrom: 'them', kind: o.kind || 'text', hasDraft: !!o.draft, inContacts: !!o.inContacts, ownerSpoke: o.ownerSpoke, messages: o.messages, preview: (o.texts || ['are you free friday?']).join(' / ') };
  if (o.waitingHours !== undefined) r.waitingSince = new Date(NOW - o.waitingHours * HOUR).toISOString();
  Object.defineProperty(r, 'texts', { value: o.texts || ['are you free friday?'], enumerable: false, writable: true });
  return r;
}
const counts = (o) => ({ messages: (o.owner || 0) + (o.theirs || 0), owner: 0, theirs: 0, owner90: 0, ownerWeeks26: 0, first: '2019-06-01T00:00:00Z', ownerLast: null, runs: 0, answered: 0, source: 'beeper-file', ...o });
const CLOSE = counts({ owner: 900, theirs: 800, owner90: 60, ownerWeeks26: 20 });
const KNOWN = counts({ owner: 12, theirs: 15 });
const LIGHT = counts({ owner: 1, theirs: 2 });
const NEW = counts({ owner: 0, theirs: 3 });
const rank = (rows, statsByID = {}, o = {}) => rankRows(rows, { now: NOW, stats: new Map(Object.entries(statsByID)), strangerKey: (r) => r.account, ...o });

test('Closeness comes from what the Owner has written, and missing counts are unknown, not new', () => {
  assert.equal(closenessOf(row(), CLOSE), 'close');
  assert.equal(closenessOf(row(), counts({ owner: 200, theirs: 180 })), 'close', 'a long history is close even when quiet lately');
  assert.equal(closenessOf(row(), KNOWN), 'known');
  assert.equal(closenessOf(row(), LIGHT), 'light');
  assert.equal(closenessOf(row(), NEW), 'new');
  assert.equal(closenessOf(row({ ownerSpoke: true }), NEW), 'light', "a partial file doesn't hide what the Owner just wrote");
  assert.equal(closenessOf(row({ inContacts: true }), NEW), 'known', 'a Contacts card is someone the Owner knows');
  assert.equal(closenessOf(row({ pinned: true }), NEW), 'close');
  assert.equal(closenessOf(row(), null), 'unknown');
  assert.equal(closenessOf(row({ ownerSpoke: true }), null), 'light');
  assert.equal(closenessOf(row({ inContacts: true }), null), 'known');
});

test('what the messages want', () => {
  const w = (texts, closeness = 'known', kind = 'text') => wantOf({ closeness, kind }, texts);
  assert.equal(w(['would 10a work?']), 'plan', 'a time is a plan');
  assert.equal(w(['did you see the game?']), 'ask');
  assert.equal(w(['can you send the deck']), 'ask');
  assert.equal(w(["I'm hosting dinner this Friday. Want to join?"]), 'plan');
  assert.equal(w(['lunch would be great', "let's do the noodle place thursday"]), 'plan');
  assert.equal(w(['Sounds good, let’s do the cafe!']), 'pleasantry');
  assert.equal(w(['Yup that works!']), 'pleasantry');
  assert.equal(w(['Thanks, gonna play a little kickball!']), 'pleasantry');
  assert.equal(w(['Ayyy', 'That’s so sick']), 'pleasantry');
  assert.equal(w(['thanks!'], 'known', 'ack'), 'pleasantry');
  assert.equal(w(['Had surgery a while back and still recovering, it has been a rough month']), 'news');
  assert.equal(w(['https://example.com/x'], 'known', 'link'), 'fyi');
  assert.notEqual(w(['Thanks for connecting! Our team helps founders boost your reach']), 'pitch', 'a known person is never a pitch');
  assert.equal(w(['Thanks for connecting! Our platform helps founders, would love to show you'], 'new'), 'pitch');
  assert.equal(w(['Is there a possibility I can still get in now?', 'they stopped me at the entrance', 'would love to collaborate'], 'new'), 'ask', 'a stranger at the door is not a pitch');
  assert.equal(w(['Hi, how are you doing?'], 'new'), 'ask');
  assert.equal(w(['thanks, can you send the deck?']), 'ask', 'a request with thanks is still a request');
});

test('the four classes', () => {
  const rows = [
    row({ id: 'q', texts: ['did you get my note?'] }),
    row({ id: 'thanks', texts: ['Yup that works!'] }),
    row({ id: 'stranger', texts: ['Hi, how are you doing?'] }),
    row({ id: 'pitch', texts: ['Thanks for connecting! Our platform helps founders, would love to show you'] }),
    row({ id: 'nohistory', texts: ['saw this and thought of you'] }),
    row({ id: 'late', texts: ["I'm outside the door, are you coming down?"], hours: 0.2 }),
  ];
  rank(rows, { q: KNOWN, thanks: CLOSE, stranger: NEW, pitch: NEW, late: CLOSE });
  const cls = Object.fromEntries(rows.map((r) => [r.id, r.rank.class]));
  assert.deepEqual(cls, { q: 'waiting', thanks: 'nothing', stranger: 'unsure', pitch: 'nothing', nohistory: 'unsure', late: 'urgent' });
  assert.deepEqual(rows.map((r) => r.id).slice(0, 2), ['late', 'q']);
  assert.ok(rows.every((r, i) => i === 0 || CLASSES.indexOf(rows[i - 1].rank.class) <= CLASSES.indexOf(r.rank.class)));
});

test('a stranger or a light contact is never urgent from words alone', () => {
  const rows = [row({ id: 's', texts: ['URGENT reply asap, are you outside?'], hours: 0.1 }), row({ id: 'l', texts: ['running late, are you here?'], hours: 0.1 })];
  rank(rows, { s: NEW, l: LIGHT });
  assert.equal(rows.find((r) => r.id === 's').rank.class, 'unsure');
  assert.equal(rows.find((r) => r.id === 'l').rank.class, 'waiting');
});

test('a time word from someone known is urgent only while fresh', () => {
  const rows = [row({ id: 'old', texts: ["I'm outside, are you coming?"], hours: 20 })];
  rank(rows, { old: CLOSE });
  assert.equal(rows[0].rank.class, 'waiting');
});

test('only a mark the Owner made counts, since Beeper marks unread Chats too', () => {
  const rows = [row({ id: 'beeper', unread: 2, markedUnread: true, texts: ['haha'] }), row({ id: 'owner', markedUnread: true, texts: ['haha'] })];
  rank(rows, { beeper: KNOWN, owner: KNOWN });
  assert.equal(rows.find((r) => r.id === 'beeper').rank.class, 'nothing');
  const mine = rows.find((r) => r.id === 'owner');
  assert.equal(mine.rank.class, 'waiting');
  assert.match(mine.rank.reason, /you marked it unread/);
});

test('a concrete request from a light contact outranks a close friend’s news', () => {
  const rows = [row({ id: 'news', texts: ['we finally finished the renovation and the kitchen came out really well'] }), row({ id: 'ask', texts: ['can you send me the deck?'] })];
  rank(rows, { news: CLOSE, ask: LIGHT });
  assert.deepEqual(rows.map((r) => r.id), ['ask', 'news']);
});

test('inside a class, closer people rank higher', () => {
  const rows = [row({ id: 'light', texts: ['are you around?'] }), row({ id: 'close', texts: ['are you around?'] }), row({ id: 'known', texts: ['are you around?'] })];
  rank(rows, { light: LIGHT, close: CLOSE, known: KNOWN });
  assert.deepEqual(rows.map((r) => r.id), ['close', 'known', 'light']);
});

test('fresh messages rank higher, while the Reason counts the wait from the first unanswered message', () => {
  const at = (o) => { const r = [row({ texts: ['are you around?'], ...o })]; rank(r, { [r[0].id]: KNOWN }); return r[0]; };
  assert.ok(at({ hours: 1 }).rank.score > at({ hours: 30 }).rank.score);
  assert.ok(at({ hours: 30 }).rank.score > at({ hours: 9 * 24 }).rank.score);
  const nudged = at({ hours: 1, waitingHours: 30 });
  assert.match(nudged.rank.reason, /waiting 30h$/);
});

test('answer rates come from runs of their messages and the Owner’s next message', () => {
  const D = 86_400_000, t0 = NOW - 100 * D;
  const msgs = [
    { at: t0, mine: false }, { at: t0 + 1000, mine: false }, { at: t0 + 3_600_000, mine: true }, // answered in an hour
    { at: t0 + 2 * D, mine: false }, { at: t0 + 6 * D, mine: true }, // answered after four days
    { at: t0 + 10 * D, mine: false }, { at: t0 + 11 * D, mine: true }, // answered a day later
    { at: t0 + 11 * D + 1, mine: true }, { at: t0 + 12 * D, mine: true }, // the Owner writing on is no run
    { at: NOW - 3_600_000, mine: false }, // too recent to judge
  ];
  assert.deepEqual(answerRate(msgs, NOW), { runs: 3, answered: 2, medianAnswerMs: 3_600_000 });
  assert.deepEqual(answerRate([], NOW), { runs: 0, answered: 0, medianAnswerMs: null });
});

test('the ranking learns from what the Owner answers, and says so', () => {
  const rows = [row({ id: 'often', texts: ['are you around?'] }), row({ id: 'seldom', texts: ['are you around?'] }), row({ id: 'few', texts: ['are you around?'] })];
  rank(rows, {
    often: counts({ owner: 40, theirs: 40, runs: 10, answered: 9 }),
    seldom: counts({ owner: 40, theirs: 40, runs: 12, answered: 1 }),
    few: counts({ owner: 40, theirs: 40, runs: 2, answered: 0 }),
  });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(rows[0].id, 'often');
  assert.ok(by.often.rank.score - by.few.rank.score >= 20, 'the answer rate moves a row a long way');
  assert.match(by.often.rank.reason, /you usually answer \(9 of 10\)/);
  assert.equal(by.seldom.rank.class, 'unsure', 'someone the Owner seldom answers leaves waiting');
  assert.match(by.seldom.rank.reason, /you rarely answer \(1 of 12\)/);
  assert.equal(by.few.rank.class, 'waiting', 'two runs are too few to judge');
  assert.doesNotMatch(by.few.rank.reason, /answer/);
});

test('strangers start where the Owner’s answers to strangers on that network put them', () => {
  const rows = [row({ id: 'li', account: 'linkedin', texts: ['hi, quick question?'] }), row({ id: 'imsg##thread:im', account: 'imessage_x', texts: ['hi, quick question?'] })];
  const strangers = new Map([['linkedin', { chats: 400, answered: 40 }], ['imessage', { chats: 100, answered: 60 }]]);
  rank(rows, { li: NEW, 'imsg##thread:im': NEW }, { strangers, strangerKey: (r) => (r.id.startsWith('imsg##') ? 'imessage' : r.account) });
  assert.deepEqual(rows.map((r) => r.id), ['imsg##thread:im', 'li']);
  assert.match(rows[1].rank.reason, /you answer 10% of strangers on LinkedIn/);
  assert.match(rows[0].rank.reason, /you answer 60% of strangers on iMessage/);
  const few = [row({ id: 'x', account: 'signal', texts: ['hi?'] })];
  rank(few, { x: NEW }, { strangers: new Map([['signal', { chats: 2, answered: 0 }]]) });
  assert.doesNotMatch(few[0].rank.reason, /strangers/, 'two strangers are too few to judge');
});

test('the Reason names what they want, who they are, and the wait', () => {
  const rows = [row({ id: 'a', texts: ['did you get my note?'], hours: 21, waitingHours: 21 }), row({ id: 'b', texts: ['hi, quick question?'] })];
  rank(rows, { a: counts({ owner: 900, theirs: 800, owner90: 60, ownerWeeks26: 20, first: '2014-06-01T00:00:00Z' }), b: NEW });
  assert.equal(rows[0].rank.reason, 'Asked you something · 1.7k messages since 2014, most weeks · waiting 21h');
  assert.equal(rows[1].rank.reason, 'Asked you something · you have never written here · waiting 2h');
  const none = [row({ id: 'c', texts: ['saw this'] })];
  rank(none, {});
  assert.match(none[0].rank.reason, /no history on this Mac/);
});

test('Reasons hold no message text, so they are safe to show anywhere', () => {
  const rows = [row({ id: 'x', texts: ['the secret code is 4417, can you call?'] })];
  rank(rows, { x: KNOWN });
  assert.doesNotMatch(rows[0].rank.reason, /secret|4417/);
});

test('a model judgment decides what is owed and what is urgent', () => {
  const rows = [row({ id: 'j', texts: ['Had surgery', 'still can’t walk'] }), row({ id: 'k', texts: ['did you get my note?'] }), row({ id: 'u', texts: ['hmm'] })];
  const judgments = new Map([
    ['j', { owed: 'yes', want: 'news', urgent: true, urgentKind: 'distress', expiresAt: new Date(NOW + HOUR).toISOString(), gist: 'Recovering from surgery and struggling' }],
    ['k', { owed: 'no', want: 'pleasantry', urgent: false }],
    ['u', { owed: 'unsure', want: 'fyi', urgent: false }],
  ]);
  rank(rows, { j: CLOSE, k: KNOWN, u: CLOSE }, { judgments });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(rows[0].id, 'j');
  assert.equal(by.j.rank.class, 'urgent');
  assert.match(by.j.rank.reason, /^Recovering from surgery and struggling · /);
  assert.equal(by.k.rank.class, 'nothing');
  assert.equal(by.u.rank.class, 'unsure');
});

test('an urgent judgment lapses at its expiry, and never makes a stranger urgent', () => {
  const rows = [row({ id: 'late', texts: ['call me?'] }), row({ id: 's', texts: ['please help now'] })];
  const judgments = new Map([
    ['late', { owed: 'yes', want: 'ask', urgent: true, expiresAt: new Date(NOW - HOUR).toISOString() }],
    ['s', { owed: 'yes', want: 'ask', urgent: true }],
  ]);
  rank(rows, { late: CLOSE, s: NEW }, { judgments });
  assert.equal(rows.find((r) => r.id === 'late').rank.class, 'waiting');
  assert.equal(rows.find((r) => r.id === 's').rank.class, 'unsure');
});

test('groups rank on mentions and how much the Owner writes there', () => {
  const rows = [row({ id: 'g1', type: 'group', mentions: 1, texts: ['@owner thoughts?'] }), row({ id: 'g2', type: 'group', texts: ['anyone up for dinner friday?'] })];
  rank(rows, { g1: counts({ owner: 2, theirs: 300 }), g2: counts({ owner: 40, theirs: 60, owner90: 30, ownerWeeks26: 8 }) });
  assert.equal(rows[0].id, 'g1');
  assert.equal(rows[0].rank.class, 'waiting');
  assert.match(rows[0].rank.reason, /^Mentioned you · a group you rarely write in/);
  assert.equal(rows[1].rank.class, 'unsure');
});

test('counts read short', () => {
  assert.deepEqual([12, 1234, 1000, 23_456].map(compactCount), ['12', '1.2k', '1k', '23k']);
});

test('a Chat where the Owner wrote last owes nothing, whatever the unread mark says', () => {
  const rows = [row({ id: 'mine', unread: 1, texts: ['could meet you around 9:15 tomorrow?'] })];
  rows[0].lastFrom = 'me';
  rank(rows, { mine: CLOSE }, { judgments: new Map() });
  assert.equal(rows[0].rank.class, 'nothing');
  assert.match(rows[0].rank.reason, /^You wrote last/);
  const judged = [row({ id: 'mine2', unread: 1 })];
  judged[0].lastFrom = 'me';
  rank(judged, { mine2: CLOSE }, { judgments: new Map([['mine2', { owed: 'yes', want: 'plan', urgent: true }]]) });
  assert.equal(judged[0].rank.class, 'nothing');
});
