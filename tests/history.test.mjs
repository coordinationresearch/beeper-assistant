// Older history from the files on this Mac. Each test builds a tiny database with made-up rows.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HistoryError, appleDate, aroundInBeeper, aroundInMessages, textFromAttributedBody } from '../scripts/lib/history.mjs';
import { renderChat } from '../scripts/lib/render.mjs';
import { messageAlias } from '../scripts/lib/state.mjs';
import { buildIndex } from '../scripts/lib/contacts.mjs';
import { CONTACT_ROWS, NOW, chat } from './fixtures.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ba-history-'));
const makeDB = (name, sql) => { const f = join(dir, name); execFileSync('/usr/bin/sqlite3', [f], { input: sql }); return f; };

// ---- Beeper's file ----
const ROOM = '!room-a:beeper.local';
const row = (id, hs, type = 'TEXT', room = ROOM, text = `message ${id}`, extra = {}) =>
  `insert into mx_room_messages values (${id}, '${room}', ${hs}, '${type}', '$e${id}', ${extra.deleted ? 1 : 0}, '${JSON.stringify({ id, text, isSender: id % 2 === 0, senderID: '@ann:beeper.local', timestamp: Date.parse('2026-01-01T00:00:00Z') + hs * 60_000, ...extra.json })}');`;
const reaction = (id, hs, target, key, who, deleted = false) => row(id, hs, 'REACTION', ROOM, '', { deleted, json: { linkedMessageID: `$e${target}`, isSender: who === '@owner:beeper.local', action: { type: 'message_reaction_created', participantID: who, reactionKey: key } } });
const beeper = makeDB('index.db', [
  'create table mx_room_messages (id integer primary key, roomID text, hsOrder integer, type text, eventID text, isDeleted integer, message json);',
  ...Array.from({ length: 30 }, (_, i) => row(i + 1, (i + 1) * 10)),
  reaction(100, 155, 15, '❤️', '@ann:beeper.local'), reaction(102, 157, 15, '👍', '@owner:beeper.local'), reaction(103, 158, 14, '😂', '@ann:beeper.local', true),
  row(101, 156, 'HIDDEN'),
  row(200, 150, 'TEXT', '!other-room:beeper.local'),
].join('\n'));

test('the messages around one come from its own chat, in order, without reactions', async () => {
  const msgs = await aroundInBeeper(ROOM, '15', { before: 3, after: 3, file: beeper });
  assert.deepEqual(msgs.map((m) => m.id), ['12', '13', '14', '15', '16', '17', '18']);
  assert.equal(msgs[3].text, 'message 15');
  assert.equal(msgs[3].timestamp, new Date(Date.parse('2026-01-01T00:00:00Z') + 150 * 60_000).toISOString());
  assert.ok(msgs.every((m) => m.chatID === ROOM));
  assert.deepEqual(msgs[3].reactions, [{ reactionKey: '❤️', participantID: '@ann:beeper.local', isSender: false }, { reactionKey: '👍', participantID: '@owner:beeper.local', isSender: true }]);
  assert.equal(msgs[2].reactions, undefined, 'a removed reaction is not shown');
});

test('the window stops at either end of the chat', async () => {
  assert.deepEqual((await aroundInBeeper(ROOM, '2', { before: 5, after: 1, file: beeper })).map((m) => m.id), ['1', '2', '3']);
  assert.deepEqual((await aroundInBeeper(ROOM, '30', { before: 1, after: 5, file: beeper })).map((m) => m.id), ['29', '30']);
});

test('a message from another chat, or a missing file, is refused with a reason', async () => {
  await assert.rejects(aroundInBeeper(ROOM, '200', { file: beeper }), HistoryError);
  await assert.rejects(aroundInBeeper(ROOM, '$not-a-row', { file: beeper }), /not the kind Beeper keeps/);
  await assert.rejects(aroundInBeeper(ROOM, '15', { file: join(dir, 'missing.db') }), /not on this Mac/);
  const changed = makeDB('changed.db', 'create table mx_room_messages (id integer primary key, roomID text);');
  await assert.rejects(aroundInBeeper(ROOM, '15', { file: changed }), /changed its layout .*hsOrder, type, eventID, isDeleted, message/);
});

// ---- Apple's Messages database ----
// A made-up archived string: the class name, then '+', a length, and the text.
const archived = (text) => {
  const body = Buffer.from(text, 'utf8');
  const len = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([body.length & 0xff, body.length >> 8])]);
  return Buffer.concat([Buffer.from('streamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+', 'latin1'), len, body, Buffer.from([0x86, 0x84])]).toString('hex');
};

test('text kept only in the archived form is read back', () => {
  assert.equal(textFromAttributedBody(archived('see you at 7')), 'see you at 7');
  const long = 'x'.repeat(300);
  assert.equal(textFromAttributedBody(archived(long)), long);
  assert.equal(textFromAttributedBody('00ff'), null);
  assert.equal(textFromAttributedBody(null), null);
});

test('Apple dates in seconds and in nanoseconds both convert', () => {
  assert.equal(appleDate(0), null);
  assert.equal(appleDate(700_000_000), new Date((700_000_000 + 978_307_200) * 1000).toISOString());
  assert.equal(appleDate(String(800_000_000n * 1_000_000_000n + 250_000_000n)), new Date((800_000_000.25 + 978_307_200) * 1000).toISOString());
});

// Dates past 2^53 differ by one nanosecond. Rounded as numbers they would collide.
const BASE = 800_000_000n * 1_000_000_000n + 900n;
const apple = makeDB('chat.db', [
  'create table message (ROWID integer primary key, guid text, date integer, is_from_me integer, text text, attributedBody blob, handle_id integer, associated_message_type integer, item_type integer, cache_has_attachments integer, date_edited integer, date_retracted integer, associated_message_guid text);',
  'create table chat_message_join (chat_id integer, message_id integer, message_date integer);',
  "create table handle (ROWID integer primary key, id text); insert into handle values (1, '+15550100001');",
  'create table message_attachment_join (message_id integer, attachment_id integer);',
  "create table attachment (ROWID integer primary key, mime_type text, transfer_name text); insert into attachment values (1, 'image/jpeg', 'IMG_1.jpg'); insert into message_attachment_join values (5, 1);",
  ...[1, 2, 3, 4, 5, 6, 7].map((i) => {
    const date = BASE + BigInt(i);
    const text = i === 4 ? 'null' : `'message ${i}'`;
    const body = i === 4 ? `x'${archived('￼from the archive')}'` : 'null';
    return `insert into message (ROWID, guid, date, is_from_me, text, attributedBody, handle_id, associated_message_type, item_type, cache_has_attachments, date_edited, date_retracted) values (${i}, 'G${i}', ${date}, ${i % 2}, ${text}, ${body}, 1, 0, 0, ${i === 5 ? 1 : 0}, 0, 0); insert into chat_message_join values (1, ${i}, ${date});`;
  }),
  // A tapback, a group event, and a message in another chat, all inside the window.
  `insert into message (ROWID, guid, date, is_from_me, text, attributedBody, handle_id, associated_message_type, item_type, cache_has_attachments, date_edited, date_retracted) values (20, 'G20', ${BASE + 3n}, 0, 'Loved "message 3"', null, 1, 2000, 0, 0, 0, 0); insert into chat_message_join values (1, 20, ${BASE + 3n});`,
  "update message set associated_message_guid = 'p:0/G3' where ROWID = 20;",
  // The Owner likes message 4, then takes it back. Someone laughs at message 5.
  `insert into message (ROWID, guid, date, is_from_me, text, attributedBody, handle_id, associated_message_type, item_type, cache_has_attachments, date_edited, date_retracted) values (23, 'G23', ${BASE + 8n}, 1, null, null, 0, 2001, 0, 0, 0, 0); insert into chat_message_join values (1, 23, ${BASE + 8n}); update message set associated_message_guid = 'p:0/G4' where ROWID = 23;`,
  `insert into message (ROWID, guid, date, is_from_me, text, attributedBody, handle_id, associated_message_type, item_type, cache_has_attachments, date_edited, date_retracted) values (24, 'G24', ${BASE + 9n}, 1, null, null, 0, 3001, 0, 0, 0, 0); insert into chat_message_join values (1, 24, ${BASE + 9n}); update message set associated_message_guid = 'p:0/G4' where ROWID = 24;`,
  `insert into message (ROWID, guid, date, is_from_me, text, attributedBody, handle_id, associated_message_type, item_type, cache_has_attachments, date_edited, date_retracted) values (25, 'G25', ${BASE + 9n}, 0, null, null, 1, 2003, 0, 0, 0, 0); insert into chat_message_join values (1, 25, ${BASE + 9n}); update message set associated_message_guid = 'bp:G5' where ROWID = 25;`,
  `insert into message (ROWID, guid, date, is_from_me, text, attributedBody, handle_id, associated_message_type, item_type, cache_has_attachments, date_edited, date_retracted) values (21, 'G21', ${BASE + 4n}, 0, null, null, 1, 0, 1, 0, 0, 0); insert into chat_message_join values (1, 21, ${BASE + 4n});`,
  `insert into message (ROWID, guid, date, is_from_me, text, attributedBody, handle_id, associated_message_type, item_type, cache_has_attachments, date_edited, date_retracted) values (22, 'G22', ${BASE + 4n}, 0, 'elsewhere', null, 1, 0, 0, 0, 0, 0); insert into chat_message_join values (2, 22, ${BASE + 4n});`,
].join('\n'));

test('iMessage history keeps nanosecond order and shows the target once', async () => {
  const msgs = await aroundInMessages('imsg##thread:test', 'G4', { before: 2, after: 2, file: apple });
  assert.deepEqual(msgs.map((m) => m.id), ['G2', 'G3', 'G4', 'G5', 'G6']);
  assert.equal(msgs[2].text, 'from the archive');
  assert.equal(msgs[1].isSender, true);
  assert.equal(msgs[0].senderName, '+15550100001');
  assert.deepEqual(msgs[3].attachments, [{ type: 'img', mimeType: 'image/jpeg', fileName: 'IMG_1.jpg' }]);
  assert.deepEqual(msgs[1].reactions, [{ reactionKey: '❤️', participantName: '+15550100001', isSender: false }]);
  assert.equal(msgs[2].reactions, undefined, 'a tapback taken back is not shown');
  assert.deepEqual(msgs[3].reactions, [{ reactionKey: '😂', participantName: '+15550100001', isSender: false }]);
  await assert.rejects(aroundInMessages('imsg##thread:test', 'G99', { file: apple }), /not in the Messages database/);
});

test('the older-history view marks the message and never offers a newest reference', () => {
  const c = chat({ id: '!room-a', title: 'Ann' });
  const msgs = ['a', 'b', 'c'].map((t, i) => ({ id: `$${i}`, isSender: i === 1, senderName: 'Ann', text: t, timestamp: new Date(NOW - (3 - i) * 3_600_000).toISOString() }));
  const out = renderChat(c, msgs, { now: NOW, around: '$1' });
  assert.match(out, /OLDER HISTORY around m[0-9a-f]{8}, marked >>\. This is not the end of the chat/);
  assert.match(out, new RegExp(`^>> .*${messageAlias('$1')}  «b»$`, 'm'));
  assert.doesNotMatch(out, /newest message:/);
  assert.doesNotMatch(out, /Last message is from/);
});

test('reactions name who reacted, and iMessage words become emoji', () => {
  const c = chat({ id: '!room-a', title: 'Ann' });
  const ann = c.participants.items[0].id;
  const msgs = [{ id: '$1', isSender: true, text: 'see you there', timestamp: new Date(NOW - 3_600_000).toISOString(), reactions: [{ reactionKey: 'love', participantID: ann }, { reactionKey: '👍', isSender: true }] }];
  assert.match(renderChat(c, msgs, { now: NOW }), /\[reactions ❤️ Ann · 👍 me\]  «see you there»/);
  // A tapback read from the Messages database carries only the sender's number.
  const tap = [{ ...msgs[0], reactions: [{ reactionKey: '😂', participantName: '+15550100001', isSender: false }] }];
  assert.match(renderChat(c, tap, { now: NOW, contacts: buildIndex(CONTACT_ROWS) }), /\[reactions 😂 Ada Lovelace\]/);
  assert.match(renderChat(c, tap, { now: NOW }), /\[reactions 😂 \+15550100001\]/, 'a number with no contact still shows');
});
