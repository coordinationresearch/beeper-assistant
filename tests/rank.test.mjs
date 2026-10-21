// Ranking the Triage list. Made-up rows and counts only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAUSES, CLASSES, bandOf, closenessOf, compareToday, compactCount, endOfLocalDay, rankRows, wantOf } from '../scripts/lib/rank.mjs';
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
  assert.equal(w(['Thanks, heading out for a bike ride!']), 'pleasantry');
  assert.equal(w(['Yooo', 'That’s wild']), 'pleasantry');
  assert.equal(w(['thanks!'], 'known', 'ack'), 'pleasantry');
  assert.equal(w(['Moved apartments a while back and still unpacking, it has been a long month']), 'news');
  assert.equal(w(['https://example.com/x'], 'known', 'link'), 'fyi');
  assert.notEqual(w(['Thanks for connecting! Our team helps founders boost your reach']), 'pitch', 'a known person is never a pitch');
  assert.equal(w(['Thanks for connecting! Our platform helps founders, would love to show you'], 'new'), 'pitch');
  assert.equal(w(['Can I still come in now?', 'security sent me back to the lobby', 'happy to share more about our team'], 'new'), 'ask', 'a stranger at the door is not a pitch');
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
  assert.equal(rows.find((r) => r.id === 'late').rank.band, 'should', 'urgent by the rules alone sits in Should until a Judgment');
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
  const rows = [row({ id: 'j', texts: ['Sprained my ankle', 'still can’t walk'] }), row({ id: 'k', texts: ['did you get my note?'] }), row({ id: 'u', texts: ['hmm'] })];
  const judgments = new Map([
    ['j', { owed: 'yes', want: 'news', urgent: true, urgentKind: 'distress', expiresAt: new Date(NOW + HOUR).toISOString(), gist: 'Healing from a sprained ankle and struggling' }],
    ['k', { owed: 'no', want: 'pleasantry', urgent: false }],
    ['u', { owed: 'unsure', want: 'fyi', urgent: false }],
  ]);
  rank(rows, { j: CLOSE, k: KNOWN, u: CLOSE }, { judgments });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(rows[0].id, 'j');
  assert.equal(by.j.rank.class, 'urgent');
  assert.match(by.j.rank.reason, /^Healing from a sprained ankle and struggling · /);
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

test('a judged row names what set its class when the judgment alone did not, and a rules row names nothing', () => {
  const ids = ['plain', 'no', 'hot', 'marked', 'seldom', 'stranger', 'lapsed', 'light', 'unsure-lapsed', 'unsure-light', 'odd', 'mine', 'mine-no', 'unjudged'];
  const rows = ids.map((id) => row({ id, markedUnread: id === 'marked', texts: id === 'marked' ? ['saw this'] : undefined }));
  for (const r of rows) if (r.id.startsWith('mine')) r.lastFrom = 'me';
  const yes = { owed: 'yes', want: 'ask', urgent: false };
  const past = new Date(NOW - HOUR).toISOString(), later = new Date(NOW + HOUR).toISOString();
  const judgments = new Map([['plain', yes], ['no', { owed: 'no', want: 'fyi', urgent: false }], ['hot', { ...yes, urgent: true, expiresAt: later }],
    ['marked', { owed: 'no', want: 'fyi', urgent: false }], ['seldom', yes], ['stranger', yes],
    ['lapsed', { ...yes, urgent: true, expiresAt: past }], ['light', { ...yes, urgent: true }],
    ['unsure-lapsed', { owed: 'unsure', want: 'ask', urgent: true, expiresAt: past }], ['unsure-light', { owed: 'unsure', want: 'ask', urgent: true }],
    ['odd', { owed: 'maybe', want: 'ask', urgent: false }], ['mine', yes], ['mine-no', { owed: 'no', want: 'fyi', urgent: false }]]);
  const stats = Object.fromEntries(ids.map((id) => [id, CLOSE]));
  Object.assign(stats, { seldom: counts({ owner: 12, theirs: 15, runs: 10, answered: 1 }), stranger: NEW, light: LIGHT, 'unsure-light': LIGHT });
  rank(rows, stats, { judgments });
  const by = Object.fromEntries(rows.map((r) => [r.id, [r.rank.class, r.rank.cause]]));
  assert.deepEqual(by, {
    plain: ['waiting', null],
    no: ['nothing', null],
    hot: ['urgent', null],
    marked: ['waiting', 'marked-unread'],
    seldom: ['unsure', 'low-answer-rate'],
    stranger: ['unsure', 'closeness'],
    lapsed: ['waiting', 'urgent-lapsed'],
    light: ['waiting', 'closeness'],
    'unsure-lapsed': ['unsure', 'urgent-lapsed'],
    'unsure-light': ['unsure', 'closeness'],
    odd: ['waiting', 'rules'],
    mine: ['nothing', 'owner-wrote-last'],
    'mine-no': ['nothing', null],
    unjudged: ['waiting', undefined],
  });
  for (const r of rows.filter((x) => x.id !== 'unjudged')) assert.ok('cause' in r.rank && (r.rank.cause === null || CAUSES.includes(r.rank.cause)), r.id);
  assert.equal('cause' in rows.find((r) => r.id === 'unjudged').rank, false, '`ba triage` passes no judge, so its rows are unchanged');
});

test('a Chat the Owner marked unread is waiting whatever the Judgment and the Closeness, and a stranger is never urgent', () => {
  const later = new Date(NOW + HOUR).toISOString(), past = new Date(NOW - HOUR).toISOString();
  const verdicts = { no: { owed: 'no', want: 'fyi', urgent: false }, unsure: { owed: 'unsure', want: 'ask', urgent: false }, yes: { owed: 'yes', want: 'ask', urgent: false },
    urgent: { owed: 'yes', want: 'ask', urgent: true, expiresAt: later }, 'unsure-urgent': { owed: 'unsure', want: 'ask', urgent: true, expiresAt: later },
    lapsed: { owed: 'unsure', want: 'ask', urgent: true, expiresAt: past } };
  const people = { close: CLOSE, known: KNOWN, light: LIGHT, new: NEW, unknown: null };
  const rows = [], judgments = new Map(), stats = {};
  for (const [who, s] of Object.entries(people)) for (const [v, j] of Object.entries(verdicts)) {
    const id = `${who}-${v}`;
    rows.push(row({ id, markedUnread: true }));
    judgments.set(id, j);
    if (s) stats[id] = s;
  }
  rank(rows, stats, { judgments });
  const by = Object.fromEntries(rows.map((r) => [r.id, [r.rank.closeness, r.rank.class, r.rank.cause]]));
  const mark = (who) => [who, 'waiting', 'marked-unread'];
  const knows = (who) => ({ [`${who}-no`]: mark(who), [`${who}-unsure`]: mark(who), [`${who}-yes`]: [who, 'waiting', null],
    [`${who}-urgent`]: [who, 'urgent', null], [`${who}-unsure-urgent`]: [who, 'urgent', null], [`${who}-lapsed`]: mark(who) });
  const stranger = (who) => Object.fromEntries(Object.keys(verdicts).map((v) => [`${who}-${v}`, mark(who)]));
  assert.deepEqual(by, {
    ...knows('close'), ...knows('known'),
    'light-no': mark('light'), 'light-unsure': mark('light'), 'light-yes': ['light', 'waiting', null],
    'light-urgent': ['light', 'waiting', 'closeness'], 'light-unsure-urgent': mark('light'), 'light-lapsed': mark('light'),
    ...stranger('new'), ...stranger('unknown'),
  });
  for (const r of rows) assert.equal(/you marked it unread/.test(r.rank.reason), r.rank.class !== 'urgent', r.id);
});

test('the mark holds when the Owner wrote last, a group is never urgent, and a mark Beeper set changes nothing', () => {
  const rows = [row({ id: 'mine', markedUnread: true }), row({ id: 'group', type: 'group', markedUnread: true }),
    row({ id: 'beeper', unread: 2, markedUnread: true }), row({ id: 'plain' })];
  rows[0].lastFrom = 'me';
  const judgments = new Map([['mine', { owed: 'unsure', want: 'ask', urgent: false }], ['group', { owed: 'yes', want: 'ask', urgent: true, expiresAt: new Date(NOW + HOUR).toISOString() }],
    ['beeper', { owed: 'yes', want: 'ask', urgent: false }], ['plain', { owed: 'unsure', want: 'ask', urgent: false }]]);
  rank(rows, { mine: KNOWN, group: CLOSE, beeper: NEW, plain: KNOWN }, { judgments });
  const by = Object.fromEntries(rows.map((r) => [r.id, [r.rank.class, r.rank.cause]]));
  assert.deepEqual(by, { mine: ['waiting', 'marked-unread'], group: ['waiting', 'closeness'], beeper: ['unsure', 'closeness'], plain: ['unsure', null] });
});

test('the mark keeps a Chat waiting even when the Owner seldom answers it', () => {
  const seldom = counts({ owner: 12, theirs: 15, runs: 10, answered: 1 });
  const seldomStranger = counts({ owner: 0, theirs: 15, runs: 10, answered: 1 });
  const rows = [row({ id: 'u', markedUnread: true }), row({ id: 'n', markedUnread: true }), row({ id: 'y', markedUnread: true }), row({ id: 's', markedUnread: true })];
  const judgments = new Map([['u', { owed: 'unsure', want: 'ask', urgent: false }], ['n', { owed: 'no', want: 'fyi', urgent: false }],
    ['y', { owed: 'yes', want: 'ask', urgent: false }], ['s', { owed: 'yes', want: 'ask', urgent: false }]]);
  rank(rows, { u: seldom, n: seldom, y: seldom, s: seldomStranger }, { judgments });
  const by = Object.fromEntries(rows.map((r) => [r.id, [r.rank.class, r.rank.cause]]));
  assert.deepEqual(by, { u: ['waiting', 'marked-unread'], n: ['waiting', 'marked-unread'], y: ['waiting', null], s: ['waiting', 'marked-unread'] });
});

test('groups rank on mentions and how much the Owner writes there, and by rules alone a mention is Unsure', () => {
  // A mention addresses the Owner, and an Addressed group waits for the Judgment (ADR 0030, 0145).
  const rows = [row({ id: 'g1', type: 'group', mentions: 1, texts: ['@owner thoughts?'] }), row({ id: 'g2', type: 'group', texts: ['anyone up for dinner friday?'] })];
  rank(rows, { g1: counts({ owner: 2, theirs: 300 }), g2: counts({ owner: 40, theirs: 60, owner90: 30, ownerWeeks26: 8 }) });
  const [g1, g2] = ['g1', 'g2'].map((id) => rows.find((r) => r.id === id));
  assert.equal(g1.rank.class, 'unsure');
  assert.ok(g1.rank.factors.some((f) => f.name === 'mentions'), 'a mention still adds to its score');
  assert.match(g1.rank.reason, /^Mentioned you · a group you have written in/);
  assert.equal(g2.rank.class, 'unsure');
  // Read, its messages showed the mention outside their Burst: it addresses nobody.
  const stale = [Object.assign(row({ id: 'g3', type: 'group', mentions: 1, texts: ['nice'] }), { addressed: null })];
  rank(stale, { g3: counts({ owner: 2, theirs: 300 }) });
  assert.equal(stale[0].rank.class, 'nothing');
});

test('counts read short', () => {
  assert.deepEqual([12, 1234, 1000, 23_456].map(compactCount), ['12', '1.2k', '1k', '23k']);
});

test('mentions lift only groups, and a Draft ready is a plus, not a minus (ADR 0263)', () => {
  const single = [row({ id: 's', mentions: 2, texts: ['@owner are you free?'] })];
  rank(single, { s: KNOWN });
  assert.ok(!single[0].rank.factors.some((f) => f.name === 'mentions'));
  const group = [row({ id: 'g', type: 'group', mentions: 2, texts: ['@owner are you free?'] })];
  rank(group, { g: KNOWN });
  assert.deepEqual(group[0].rank.factors.find((f) => f.name === 'mentions'), { name: 'mentions', points: 10 });
  const drafted = [row({ id: 'd', draft: true }), row({ id: 'p' })];
  rank(drafted, { d: KNOWN, p: KNOWN });
  assert.deepEqual(drafted.find((r) => r.id === 'd').rank.factors.find((f) => f.name === 'draft'), { name: 'draft', points: 3 });
});

test('endOfLocalDay is the end of the Mac\'s local day, whatever the zone', () => {
  // Built with local setters, so the test reads the same in any time zone.
  const at = (h, m = 0, day = 27) => { const d = new Date(0); d.setFullYear(2026, 8, day); d.setHours(h, m, 0, 0); return d.getTime(); };
  const end = at(0, 0, 28);
  assert.equal(endOfLocalDay(at(23, 59)), end, 'a minute before midnight still ends tonight');
  assert.equal(endOfLocalDay(at(0, 0)), end, 'midnight starts the day it ends');
  assert.equal(endOfLocalDay(at(12, 30)), end);
});

test('the Band a row takes in Today (ADR 0263)', () => {
  // A fixed local noon, built with local setters so the day bounds read the same in any zone.
  const noon = new Date(0); noon.setFullYear(2026, 8, 30); noon.setHours(12, 0, 0, 0);
  const now = noon.getTime();
  const local = (h, m = 0, days = 0) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.getTime(); };
  const wait = (o = {}) => ({ type: 'single', closeness: 'known', lastFrom: 'them', ageMs: HOUR, markedUnread: false, unreadCount: 0,
    waitingSince: new Date(now - (o.waitedMs ?? HOUR)).toISOString(), rank: { class: o.cls ?? 'waiting', judged: o.judged }, ...o });
  const band = (r, o = {}) => bandOf(r, { now, ...o });
  assert.equal(band(wait({ cls: 'urgent', judged: true })).band, 'must');
  assert.equal(band(wait({ cls: 'urgent' })).band, 'should', 'the rules alone land an urgent Chat in Should until a Judgment');
  assert.equal(band(wait({ cls: 'urgent', waitedMs: 7 * 24 * HOUR })).band, 'must', 'a rules-urgent Chat waiting seven days is still Must');
  assert.equal(band(wait(), { deadline: new Date(local(23, 59)).toISOString() }).band, 'must', 'due tonight');
  assert.equal(band(wait(), { deadline: new Date(local(0, 1, 1)).toISOString() }).band, 'should', 'due just after midnight');
  assert.equal(band(wait(), { deadline: new Date(local(12, 0, -1)).toISOString() }).band, 'must', 'a passed deadline stays must');
  assert.equal(band(wait(), { deadline: new Date(now + 5 * 24 * HOUR).toISOString() }).band, 'rest', 'five days out is on pace');
  assert.equal(band(wait({ waitedMs: 7 * 24 * HOUR })).band, 'must', 'seven days waiting');
  assert.equal(band(wait({ waitedMs: 3 * 24 * HOUR }), { pace: { p90Ms: 24 * HOUR, replied: 10 } }).band, 'should', 'past the Owner\'s pace with this Person');
  assert.equal(band(wait({ waitedMs: HOUR }), { pace: { p90Ms: 30 * 60_000, replied: 10 } }).band, 'rest', 'a fast pair slips at the 48h floor, not the pace');
  assert.equal(band(wait({ waitedMs: 3 * 24 * HOUR }), { pace: { p90Ms: HOUR, replied: 3 } }).band, 'should', 'thin history gets the floor');
  const grp = band({ ...wait({ waitedMs: 3 * 24 * HOUR }), type: 'group' }, { pace: { p90Ms: 365 * 24 * HOUR, replied: 50 } });
  assert.equal(grp.band, 'should', 'a group slips on the floor whatever the pace says');
  const mine = band(wait({ cls: 'waiting', lastFrom: 'me', markedUnread: true }));
  assert.deepEqual([mine.band, mine.slipping, mine.waitedMs], ['should', false, 0], 'marked unread with the Owner last has no wait');
  assert.equal(band(wait({ cls: 'unsure' })).band, null);
});

test('an older debt, quiet two weeks, is still owed but never Must for its wait, and comes last in its Band (ADR 0279)', () => {
  const noon = new Date(0); noon.setFullYear(2026, 8, 30); noon.setHours(12, 0, 0, 0);
  const now = noon.getTime(), DAY = 24 * HOUR;
  const tonight = new Date(now); tonight.setHours(23, 0, 0, 0);
  const old = (o = {}) => ({ type: 'single', closeness: 'known', lastFrom: 'them', ageMs: 40 * DAY, markedUnread: false, unreadCount: 0,
    waitingSince: new Date(now - 40 * DAY).toISOString(), rank: { class: o.cls ?? 'waiting', judged: o.judged }, ...o });
  const band = (r, o = {}) => bandOf(r, { now, ...o }).band;
  assert.equal(band(old()), 'should', 'waiting 40 days, past the line, but no longer Must');
  assert.equal(band(old({ ageMs: 13 * DAY })), 'must', 'their newest message under two weeks old: the seven-day rule holds');
  assert.equal(band(old(), { deadline: new Date(now - 20 * DAY).toISOString() }), 'should', 'a deadline long passed makes no Must');
  assert.equal(band(old(), { deadline: tonight.toISOString() }), 'must', 'a deadline still ahead today does');
  assert.equal(band(old({ cls: 'urgent', judged: true })), 'must', 'a Judgment\'s Urgent does');
  assert.equal(band(old(), { pace: { p90Ms: 50 * DAY, replied: 10 } }), 'rest', 'on the Owner\'s own slow pace it rests');
  assert.equal(band(old({ ageMs: 14 * DAY })), 'should', 'two weeks to the millisecond is old');
  const earlier = new Date(now); earlier.setHours(9, 0, 0, 0);
  assert.equal(band(old(), { deadline: earlier.toISOString() }), 'should', 'nor a deadline that passed this morning');
  assert.equal(band(old({ ageMs: 13 * DAY }), { deadline: earlier.toISOString() }), 'must', 'which still makes a newer Chat Must');
  assert.deepEqual([bandOf(old(), { now }).old, bandOf(old({ ageMs: DAY }), { now }).old, bandOf(old({ cls: 'nothing' }), { now }).old], [true, false, true]);
  // The Band's own mark decides the sort, so a wrapped row whose age reads differently sorts as it banded.
  const marked = [{ ageMs: 30 * DAY, rank: { band: 'should', class: 'waiting', deadline: null, waitedMs: 0, lineMs: 2 * DAY, old: false } },
    { ageMs: HOUR, rank: { band: 'should', class: 'waiting', deadline: null, waitedMs: 3 * DAY, lineMs: 2 * DAY, old: true } }];
  assert.deepEqual([...marked].sort(compareToday).map((r) => r.rank.old), [false, true]);
  const at = (band, ageMs, waitedMs, lineMs = 2 * DAY) => ({ ageMs, rank: { band, class: 'waiting', deadline: null, waitedMs, lineMs } });
  const should = [at('should', 50 * DAY, 50 * DAY), at('should', 3 * DAY, 3 * DAY), at('should', 20 * DAY, 20 * DAY), at('should', HOUR, 2.5 * DAY)];
  assert.deepEqual([...should].sort(compareToday).map((r) => r.ageMs / DAY), [3, HOUR / DAY, 20, 50], 'newer Chats by how far past the line, then older debts newest first');
  const rest = [at('rest', 30 * DAY, 30 * DAY, 60 * DAY), at('rest', HOUR, 20 * HOUR)];
  assert.deepEqual([...rest].sort(compareToday).map((r) => r.ageMs), [HOUR, 30 * DAY], 'the rest too');
});

test('compareToday orders each Band and the Bands against each other', () => {
  // Must rows with no deadline that are not urgent (the seven-day waiters) sort after the
  // dated ones, longest wait first.
  const at = (rank, ageMs = HOUR) => ({ rank, ageMs });
  const must = [
    at({ band: 'must', class: 'waiting', deadline: null, waitedMs: 8 * 24 * HOUR, lineMs: 0 }),
    at({ band: 'must', class: 'urgent', deadline: null, waitedMs: HOUR, lineMs: 0 }),
    at({ band: 'must', class: 'waiting', deadline: new Date(NOW + 2 * HOUR).toISOString(), waitedMs: HOUR, lineMs: 0 }),
    at({ band: 'must', class: 'waiting', deadline: new Date(NOW + 5 * HOUR).toISOString(), waitedMs: 9 * 24 * HOUR, lineMs: 0 }),
    at({ band: 'must', class: 'waiting', deadline: null, waitedMs: 10 * 24 * HOUR, lineMs: 0 }),
  ];
  assert.deepEqual([...must].sort(compareToday).map((r) => r.rank.waitedMs), [HOUR, HOUR, 9 * 24 * HOUR, 10 * 24 * HOUR, 8 * 24 * HOUR]);
  const should = [
    at({ band: 'should', class: 'waiting', deadline: null, waitedMs: 24 * HOUR, lineMs: 48 * HOUR }),
    at({ band: 'should', class: 'waiting', deadline: null, waitedMs: 4 * 24 * HOUR, lineMs: 48 * HOUR }),
  ];
  assert.deepEqual([...should].sort(compareToday).map((r) => r.rank.waitedMs), [4 * 24 * HOUR, 24 * HOUR], 'deepest past the line first');
  const rest = [
    at({ band: 'rest', class: 'waiting', deadline: null, waitedMs: 2 * HOUR, lineMs: 48 * HOUR }),
    at({ band: 'rest', class: 'waiting', deadline: null, waitedMs: 20 * HOUR, lineMs: 48 * HOUR }),
    at({ band: 'rest', class: 'waiting', deadline: null, waitedMs: 20 * HOUR, lineMs: 48 * HOUR }, 3 * HOUR),
  ];
  assert.deepEqual([...rest].sort(compareToday).map((r) => r.ageMs), [HOUR, 3 * HOUR, HOUR], 'longest wait first, then newest');
  const mixed = [rest[0], must[1], should[0], at({ band: null, class: 'unsure', deadline: null, waitedMs: 0, lineMs: 0 })];
  assert.deepEqual([...mixed].sort(compareToday).map((r) => r.rank.band), ['must', 'should', 'rest', null]);
});

test('a Chat where the Owner wrote last owes nothing, whatever the unread count says', () => {
  const rows = [row({ id: 'mine', unread: 1, texts: ['could meet you around 9:15 tomorrow?'] })];
  rows[0].lastFrom = 'me';
  rank(rows, { mine: CLOSE }, { judgments: new Map() });
  assert.equal(rows[0].rank.class, 'nothing');
  assert.match(rows[0].rank.reason, /^You wrote last/);
  const reacted = [row({ id: 'tap', unread: 1 })];
  Object.assign(reacted[0], { lastFrom: 'me', ownerReacted: true });
  rank(reacted, { tap: CLOSE }, { judgments: new Map() });
  assert.equal(reacted[0].rank.class, 'nothing');
  assert.match(reacted[0].rank.reason, /^You reacted last/);
  const judged = [row({ id: 'mine2', unread: 1 })];
  judged[0].lastFrom = 'me';
  rank(judged, { mine2: CLOSE }, { judgments: new Map([['mine2', { owed: 'yes', want: 'plan', urgent: true }]]) });
  assert.equal(judged[0].rank.class, 'nothing');
});
