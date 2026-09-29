import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex } from '../scripts/lib/contacts.mjs';
import { dismiss, isDismissed } from '../scripts/lib/state.mjs';
import { looksLikeAck } from '../scripts/lib/triage.mjs';
import { applyContext, buildTriage, chatName, draftText, finalizeTriage, handlesOf, htmlToText, isAutomated, isSelfChat, looksAutomatedText, looksLikeReaction, previewKind, previewText, selfHandles, selfNames, senderLabel, tidyLinks, trailingInbound, wantsContext } from '../scripts/lib/triage.mjs';
import { ME } from './fixtures.mjs';
import { CONTACT_ROWS, NOW, chat, person } from './fixtures.mjs';

const contacts = buildIndex(CONTACT_ROWS);
const build = (chats, o = {}) => buildTriage(chats, { now: NOW, contacts, ...o });
const names = (rows) => rows.map((r) => r.name);

test('an unread chat is listed', () => {
  const t = build([chat({ title: 'Ann', unread: 2 })]);
  assert.deepEqual(names(t.people), ['Ann']);
  assert.equal(t.people[0].state, 'unread');
});

test('a read chat whose last message is theirs is listed as READ', () => {
  const t = build([chat({ title: 'Ben', unread: 0, lastFrom: 'them' })]);
  assert.equal(t.people[0].state, 'read');
});

test('a read chat whose last message is mine is left out and counted', () => {
  const t = build([chat({ title: 'Cal', lastFrom: 'me' })]);
  assert.equal(t.people.length, 0);
  assert.equal(t.stats.waitingOnThem, 1);
});

test('an unread flag that survived my own reply is still listed and marked', () => {
  const t = build([chat({ title: 'Dee', unread: 1, lastFrom: 'me' })]);
  assert.equal(t.people.length, 1);
  assert.equal(t.people[0].lastFrom, 'me');
});

test('muted, archived and low-priority chats are left out', () => {
  const t = build([chat({ unread: 1, muted: true }), chat({ unread: 1, archived: true }), chat({ unread: 1, low: true })]);
  assert.equal(t.people.length, 0);
  assert.equal(t.stats.filtered, 3);
});

test('a pinned chat is kept and flagged, never suppressed', () => {
  const t = build([chat({ title: 'Eve', unread: 1, pinned: true })]);
  assert.equal(t.people[0].pinned, true);
});

test('chats older than the window are left out, and unread ones are counted', () => {
  const t = build([chat({ unread: 1, hoursAgo: 24 * 15 }), chat({ lastFrom: 'them', hoursAgo: 24 * 15 })]);
  assert.equal(t.people.length, 0);
  assert.equal(t.stats.olderUnread, 1);
});

test('the window is adjustable', () => {
  const t = build([chat({ title: 'Flo', unread: 1, hoursAgo: 24 * 15 })], { windowDays: 30 });
  assert.deepEqual(names(t.people), ['Flo']);
});

test('groups appear only when unread, in their own section', () => {
  const t = build([
    chat({ type: 'group', title: 'Crew', unread: 3, others: [person({ name: 'A' }), person({ name: 'B' })] }),
    chat({ type: 'group', title: 'Quiet', unread: 0, others: [person({ name: 'A' }), person({ name: 'B' })] }),
  ]);
  assert.deepEqual(names(t.groups), ['Crew']);
  assert.equal(t.people.length, 0);
  assert.equal(t.stats.quietGroups, 1);
});

test('groups with mentions sort first', () => {
  const t = build([
    chat({ type: 'group', title: 'NoMention', unread: 9, hoursAgo: 1, others: [person({ name: 'A' }), person({ name: 'B' })] }),
    chat({ type: 'group', title: 'Mention', unread: 1, mentions: 1, hoursAgo: 5, others: [person({ name: 'A' }), person({ name: 'B' })] }),
  ]);
  assert.deepEqual(names(t.groups), ['Mention', 'NoMention']);
});

test('unread people sort above read people, newest first inside each', () => {
  const t = build([
    chat({ title: 'ReadNew', lastFrom: 'them', hoursAgo: 1 }),
    chat({ title: 'UnreadOld', unread: 1, hoursAgo: 48 }),
    chat({ title: 'UnreadNew', unread: 1, hoursAgo: 2 }),
    chat({ title: 'ReadOld', lastFrom: 'them', hoursAgo: 72 }),
  ]);
  assert.deepEqual(names(t.people), ['UnreadNew', 'UnreadOld', 'ReadNew', 'ReadOld']);
});

test('network bots and read-only chats are left out', () => {
  const t = build([chat({ title: 'Instagram', unread: 1, others: [person({ name: 'Instagram', bot: true })] }), chat({ title: 'Channel', unread: 1, readOnly: true })]);
  assert.equal(t.people.length, 0);
  assert.equal(t.stats.bots, 1);
  assert.equal(t.stats.readOnly, 1);
});

test('short codes and passcode texts are automated', () => {
  assert.equal(isAutomated(chat({ title: '24273', others: [person({ phone: '24273' })] })), true);
  assert.equal(isAutomated(chat({ title: 'Bank', text: 'Your verification code is 482910' })), true);
  assert.equal(isAutomated(chat({ title: 'Shop', text: 'Sale today. Reply STOP to opt out' })), true);
  assert.equal(isAutomated(chat({ title: 'Ann', text: 'what is the door code again?' })), false);
  assert.equal(isAutomated(chat({ title: 'Ann', text: 'are you free friday?' })), false);
});

test('automated chats are left out by default and kept on request', () => {
  const c = chat({ title: '24273', unread: 1, others: [person({ phone: '24273' })] });
  assert.equal(build([c]).people.length, 0);
  assert.equal(build([c]).stats.automated, 1);
  assert.equal(build([c], { includeAutomated: true }).people.length, 1);
});

test('a dismissed chat is hidden until a new message arrives', () => {
  const c = chat({ title: 'Gus', lastFrom: 'them', previewID: '$a' });
  const state = { dismissed: {}, aliases: {} };
  dismiss(state, c, NOW);
  assert.equal(build([c], { state }).people.length, 0);
  assert.equal(build([c], { state }).stats.dismissed, 1);
  const newer = { ...c, preview: { ...c.preview, id: '$b' } };
  assert.equal(isDismissed(state, newer), false);
  assert.equal(build([newer], { state }).people.length, 1);
});

test('the list is capped and the overflow is counted', () => {
  const many = Array.from({ length: 7 }, (_, i) => chat({ title: `P${i}`, unread: 1, hoursAgo: i + 1 }));
  const t = build(many, { maxPeople: 5 });
  assert.equal(t.people.length, 5);
  assert.equal(t.stats.morePeople, 2);
  assert.equal(build(Array.from({ length: 101 }, (_, i) => chat({ title: `Q${i}`, unread: 1 }))).people.length, 100);
});

test('a phone-number title resolves to a contact name', () => {
  const c = chat({ title: '+1 555-010-0001', others: [person({ phone: '+15550100001' })] });
  assert.deepEqual(chatName(c, contacts), { name: 'Ada Lovelace', resolved: true, handle: '+15550100001' });
});

test('an unknown number stays a number and is marked unresolved', () => {
  const c = chat({ title: '+1 555-010-7777', others: [person({ phone: '+15550107777' })] });
  const n = chatName(c, contacts);
  assert.equal(n.resolved, false);
  assert.equal(n.name, '+1 555-010-7777');
  assert.equal(build([{ ...c, unreadCount: 1 }]).stats.unresolvedNames, 1);
});

test('a number shared by two contacts does not resolve to either', () => {
  const c = chat({ title: '+15550100009', others: [person({ phone: '+15550100009' })] });
  assert.equal(chatName(c, contacts).resolved, false);
});

test('an untitled group is named after its members', () => {
  const c = chat({ type: 'group', title: '', unread: 1, others: [person({ phone: '+15550100001' }), person({ phone: '+15550100002' })] });
  assert.equal(chatName(c, contacts).name, 'Ada Lovelace, Grace Hopper');
});

test('sender labels never show a raw network ID', () => {
  const c = chat({ type: 'group', title: 'Crew', others: [person({ name: 'A' }), person({ name: 'B' })] });
  assert.equal(senderLabel({ isSender: false, senderName: '@twitter_123:beeper.local', senderID: 'nope' }, c, contacts), 'someone');
  assert.equal(senderLabel({ isSender: true, senderName: 'x' }, c, contacts), 'me');
  assert.equal(senderLabel({ isSender: false, senderName: '+15550100002', senderID: 'nope' }, c, contacts), 'Grace Hopper');
});

test('tapback text is recognised as a reaction', () => {
  assert.equal(looksLikeReaction('Loved “see you then”'), true);
  assert.equal(looksLikeReaction('Laughed at "that joke"'), true);
  assert.equal(looksLikeReaction('Liked an image'), true);
  assert.equal(looksLikeReaction('You reacted to &quot;see you then&quot;'), true);
  assert.equal(looksLikeReaction('Ann reacted \u{1F44D} to \u201csee you then\u201d'), true);
  assert.equal(looksLikeReaction('I reacted badly to the news'), false);
  assert.equal(looksLikeReaction('Loved the show last night'), false);
  assert.equal(looksLikeReaction('Liked it a lot'), false);
});

test('long previews are clipped and whitespace is collapsed', () => {
  const t = build([chat({ title: 'Hal', unread: 1, text: `a\n\n  b ${'x'.repeat(400)}` })]);
  assert.equal(t.people[0].preview.length, 280);
  assert.ok(t.people[0].preview.startsWith('a b x'));
});

test('drafts come back from Beeper as HTML and are read as plain text', () => {
  assert.equal(htmlToText('<p>see you at 5 &amp; bring &lt;snacks&gt;</p>'), 'see you at 5 & bring <snacks>');
  assert.equal(htmlToText('<p>line one</p><p>line two</p>'), 'line one\nline two');
  assert.equal(htmlToText('one<br>two<br/>three'), 'one\ntwo\nthree');
  assert.equal(htmlToText('it&#39;s fine &#128077;'), "it's fine \u{1F44D}");
  // A shared post: caption in bold, then the link in its own paragraph.
  assert.equal(htmlToText('<strong>summer</strong><p><a href="https://example.com/p/1">https://example.com/p/1</a></p>'), 'summer\nhttps://example.com/p/1');
  assert.equal(htmlToText('plain text, 2 < 3'), 'plain text, 2 < 3');
  assert.equal(draftText({ draft: { text: '<p>hi</p>' } }), 'hi');
  assert.equal(draftText({ draft: null }), '');
});

test('the latest item in a chat is classified, because it is often not a message', () => {
  assert.equal(previewKind({ text: 'are you free friday?' }), 'text');
  assert.equal(previewKind({ text: 'Loved \u201cok\u201d' }), 'reaction');
  assert.equal(previewKind({ text: 'x', type: 'REACTION' }), 'reaction');
  assert.equal(previewKind({ text: '{{sender}} unsent a message' }), 'notice');
  assert.equal(previewKind({ text: 'anything', isHidden: true }), 'notice');
  assert.equal(previewKind({ text: 'Missed call' }), 'notice');
  assert.equal(previewKind({ text: '', attachments: [{ type: 'img' }] }), 'attachment');
  assert.equal(previewKind({ attachments: [] }), 'empty');
  assert.equal(previewKind({ text: 'https://example.com/a?b=1' }), 'link');
  assert.equal(previewKind({ text: 'see https://example.com' }), 'text');
  assert.equal(previewKind({ text: '<p>hello &amp; hi</p>' }), 'text');
});

test('previews fill templates and describe attachments', () => {
  assert.equal(previewText({ text: '{{sender}} unsent a message' }, 'Ann'), 'Ann unsent a message');
  assert.equal(previewText({ text: '', attachments: [{ type: 'img' }] }), '[photo]');
  assert.equal(previewText({ attachments: [{ type: 'video' }, { type: 'img' }] }), '[2 attachments]');
  assert.equal(previewText({ attachments: [{ type: 'img', isSticker: true }] }), '[sticker]');
  assert.equal(previewText({}), '');
});

test('a read chat that ends in a reaction or system event is dropped and counted', () => {
  const t = build([
    chat({ title: 'Ann', lastFrom: 'them', text: 'Liked \u201csee you\u201d' }),
    chat({ title: 'Cy', lastFrom: 'them', text: '{{sender}} loved \u201cok\u201d' }),
    chat({ title: 'Di', lastFrom: 'them', text: '{{sender}} unsent a message' }),
    chat({ title: 'Ben', lastFrom: 'them', text: 'https://example.com/x' }),
  ]);
  assert.deepEqual(names(t.people), ['Ben']);
  assert.equal(t.people[0].kind, 'link');
  assert.equal(t.stats.nothingOwed, 3);
});

test('an unread chat that ends in a reaction is kept and flagged', () => {
  const t = build([chat({ title: 'Ann', unread: 1, text: 'Liked \u201csee you\u201d' })]);
  assert.equal(t.people[0].kind, 'reaction');
});

test('a reaction with a template or a name in front is still a reaction', () => {
  assert.equal(looksLikeReaction('{{sender}} loved \u201cok\u201d'), true);
  assert.equal(looksLikeReaction('{{sender}} reacted \u{1F44D} to \u201cok\u201d'), true);
  assert.equal(looksLikeReaction('Ann laughed at \u201cthat\u201d'), true);
  assert.equal(looksLikeReaction('Ann loved the show'), false);
});

const msg = (from, text, extra = {}) => ({ id: `$${Math.random()}`, isSender: from === 'me', senderName: from, text, timestamp: new Date(NOW - 3_600_000).toISOString(), ...extra });

test('the trailing run of their messages is found, skipping reactions and hidden events', () => {
  const r = trailingInbound([msg('me', 'ok'), msg('them', 'are you around friday?'), msg('them', 'or sat'), msg('them', 'Loved \u201cok\u201d'), msg('them', 'x', { isHidden: true })]);
  assert.equal(r.lastFrom, 'them');
  assert.deepEqual(r.burst.map((m) => m.text), ['are you around friday?', 'or sat']);
});

test('when the Owner really spoke last, the chat is not in their court', () => {
  assert.equal(trailingInbound([msg('them', 'q?'), msg('me', 'yes'), msg('them', 'Liked \u201cyes\u201d')]).lastFrom, 'me');
  assert.equal(trailingInbound([msg('them', 'x', { isHidden: true })]).lastFrom, null);
  const long = trailingInbound([msg('me', 'a'), msg('them', '1'), msg('them', '2'), msg('them', '3'), msg('them', '4'), msg('them', '5')]);
  assert.equal(long.burst.length, 5);
  assert.equal(long.more, false);
  assert.equal(trailingInbound([msg('them', '1'), msg('them', '2')]).more, true);
});

test('context replaces a fragment preview with the whole run', () => {
  const t = build([chat({ title: 'Ann', lastFrom: 'them', text: 'or sat' })], { finalize: false });
  const row = t.people[0];
  assert.equal(wantsContext(row), true);
  applyContext(row, [msg('me', 'ok'), msg('them', 'are you around friday?'), msg('them', 'or sat')]);
  assert.equal(row.preview, 'are you around friday? / or sat');
  assert.equal(row.messages, 2);
  assert.deepEqual(names(finalizeTriage(t).people), ['Ann']);
});

test('context drops a read chat where the Owner answered and they only reacted', () => {
  const t = build([chat({ title: 'Ann', lastFrom: 'them', text: 'Liked \u201cyes\u201d' })], { finalize: false });
  applyContext(t.people[0], [msg('them', 'q?'), msg('me', 'yes'), msg('them', 'Liked \u201cyes\u201d')]);
  finalizeTriage(t);
  assert.equal(t.people.length, 0);
  assert.equal(t.stats.waitingOnThem, 1);
});

test('a long clear preview needs no extra look', () => {
  const t = build([chat({ title: 'Ann', lastFrom: 'them', text: 'are you free for dinner on friday around seven?' })]);
  assert.equal(wantsContext(t.people[0]), false);
});

test('soft signs of automation only count for senders outside Contacts', () => {
  assert.equal(looksAutomatedText('Your driver is arriving now'), true);
  assert.equal(looksAutomatedText('Security alert: new sign-in attempt'), true);
  assert.equal(looksAutomatedText('Msg & data rates may apply'), true);
  assert.equal(looksAutomatedText('dinner friday?'), false);
  const known = chat({ title: '+15550100001', unread: 1, text: 'your order came to my house lol', others: [person({ phone: '+15550100001' })] });
  const unknown = chat({ title: '+15550107777', unread: 1, text: 'Your order has shipped', others: [person({ phone: '+15550107777' })] });
  const t = build([known, unknown]);
  assert.deepEqual(names(t.people), ['Ada Lovelace']);
  assert.equal(t.stats.automated, 1);
});

test('chats with yourself are left out', () => {
  const own = chat({ title: 'Me', unread: 1, others: [person({ phone: ME.phoneNumber })] });
  const other = chat({ title: 'Ann', unread: 1 });
  assert.equal(isSelfChat(own, selfHandles([own, other])), true);
  assert.equal(isSelfChat(other, selfHandles([own, other])), false);
  const t = build([own, other]);
  assert.deepEqual(names(t.people), ['Ann']);
  assert.equal(t.stats.self, 1);
});

test('links in previews keep the site and drop the rest', () => {
  assert.equal(tidyLinks('[https://example.com/a/b?c=1](https://example.com/a/b?c=1)', { shorten: true }), 'example.com/…');
  assert.equal(tidyLinks('see [the doc](https://example.com/x)', { shorten: false }), 'see the doc (https://example.com/x)');
  assert.equal(tidyLinks('look https://www.example.com/reel/abc123 wow', { shorten: true }), 'look example.com/… wow');
  assert.equal(tidyLinks('https://example.com', { shorten: true }), 'example.com');
});

test('a masked member number falls back to the number in the title', () => {
  const c = chat({ title: '+1 555-010-0001', others: [person({ phone: '+155****0001' })] });
  assert.deepEqual(handlesOf(c), ['+1 555-010-0001']);
  assert.equal(chatName(c, contacts).name, 'Ada Lovelace');
});

test('a long run shows its true count and its last four messages', () => {
  const t = build([chat({ title: 'Ann', unread: 6, text: 'six' })], { finalize: false });
  const row = applyContext(t.people[0], [msg('me', 'ok'), msg('them', 'one'), msg('them', 'two'), msg('them', 'three'), msg('them', 'four'), msg('them', 'five'), msg('them', 'six')], { now: NOW });
  assert.equal(row.messages, 6);
  assert.equal(row.messagesMore, false);
  assert.equal(row.preview, '… / three / four / five / six');
});

test('the age comes from the last real message, so an unsend cannot make an old chat look new', () => {
  const c = chat({ title: 'Ann', lastFrom: 'them', text: '{{sender}} unsent a message', hoursAgo: 24 * 9 });
  const t = build([c], { finalize: false });
  const old = msg('them', 'can you intro me?', { timestamp: new Date(NOW - 210 * 86_400_000).toISOString() });
  applyContext(t.people[0], [old, msg('them', '{{sender}} unsent a message')], { now: NOW });
  assert.equal(Math.round(t.people[0].ageMs / 86_400_000), 210);
  finalizeTriage(t);
  assert.equal(t.people.length, 0);
  assert.equal(t.stats.stale, 1);
});

test('more signs of automation from senders outside Contacts', () => {
  for (const s of ['did you just sign in from a new location? If this was not you, contact support', 'Hi from the ride app! New message from your driver', 'Sam is here - look for the black car. Wait time fees apply after 2 min.']) {
    assert.equal(looksAutomatedText(s), true, s);
  }
  assert.equal(looksAutomatedText('oh my hands are way too close'), false);
});

test('a chat with the Owner\'s own account on another network is a chat with yourself', () => {
  const me = person({ name: 'Owner Name', self: true });
  const mine = { ...chat({ title: 'Owner Name', unread: 1, others: [person({ name: 'Owner Name' })] }) };
  mine.participants.items = [mine.participants.items[0], me];
  const family = chat({ title: 'Other Name', unread: 1, others: [person({ name: 'Other Name' })] });
  assert.equal(selfNames([mine, family]).has('owner name'), true);
  assert.equal(selfNames([mine, family]).has('other name'), false);
  const t = build([mine, family]);
  assert.deepEqual(names(t.people), ['Other Name']);
  assert.equal(t.stats.self, 1);
});

test('a chat where the Owner never wrote is marked as new', () => {
  const t = build([chat({ title: 'Stranger', lastFrom: 'them', text: 'I would love fifteen minutes of your time to talk about our product' }), chat({ title: 'Friend', lastFrom: 'them', text: 'are you free for dinner on friday around seven?' })], { finalize: false });
  const [stranger, friend] = t.people;
  applyContext(stranger, [msg('them', 'hello there'), msg('them', 'I would love fifteen minutes of your time to talk about our product')], { now: NOW });
  applyContext(friend, [msg('me', 'long time'), msg('them', 'are you free for dinner on friday around seven?')], { now: NOW });
  assert.equal(stranger.ownerSpoke, false);
  assert.equal(friend.ownerSpoke, true);
  // A clear preview is kept as it was.
  assert.equal(friend.preview, 'are you free for dinner on friday around seven?');
  assert.equal(friend.messages, undefined);
});

test('a message that only acknowledges is recognised', () => {
  for (const s of ['thanks!', 'Thank you so much', 'thx', 'ok', 'Okay, sounds good!', 'got it', 'will do', 'perfect', 'haha', 'lol nice', 'no worries', 'you too!', 'see you then', '\u{1F44D}', '\u2764\ufe0f\u{1F64F}', 'Thanks!! \u{1F64F}', 'appreciate it', 'congrats!']) {
    assert.equal(looksLikeAck(s), true, s);
  }
});

test('a message that asks, answers, or says something is not an acknowledgment', () => {
  for (const s of ['thanks, can you send the deck?', 'ok but what time', 'yes', 'no', 'sounds good, thursday at 6 then', 'ok so I talked to her and she is in', 'haha did you see this', 'great news, I got the job', 'thanks for the intro, we are meeting friday and I would love your take beforehand on what to ask']) {
    assert.equal(looksLikeAck(s), false, s);
  }
});

test('a read chat that ends in a bare acknowledgment is dropped, and an unread one is flagged', () => {
  const t = build([chat({ title: 'Ann', lastFrom: 'them', text: 'thanks!' }), chat({ title: 'Ben', unread: 1, text: 'ok sounds good' }), chat({ title: 'Cy', lastFrom: 'them', text: 'thanks, what time?' })]);
  assert.deepEqual(names(t.people).sort(), ['Ben', 'Cy']);
  assert.equal(t.people.find((r) => r.name === 'Ben').kind, 'ack');
  assert.equal(t.stats.nothingOwed, 1);
});

test('a request followed by thanks still counts as a request', () => {
  const t = build([chat({ title: 'Ann', lastFrom: 'them', text: 'thanks!' })], { finalize: false });
  applyContext(t.people[0], [msg('me', 'hi'), msg('them', 'can you send me the deck before friday?'), msg('them', 'thanks!')], { now: NOW });
  assert.equal(t.people[0].kind, 'text');
  assert.equal(finalizeTriage(t).people.length, 1);
  assert.ok(t.people[0].preview.includes('can you send me the deck'));
  const only = build([chat({ title: 'Ben', lastFrom: 'them', text: 'ok' })], { finalize: false });
  applyContext(only.people[0], [msg('me', 'see you at 6'), msg('them', 'perfect'), msg('them', 'ok')], { now: NOW });
  assert.equal(only.people[0].kind, 'ack');
  assert.equal(finalizeTriage(only).people.length, 0);
});
