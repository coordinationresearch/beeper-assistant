// Older history, read from the files Beeper and Messages keep on this Mac.
// Beeper's API cannot page back through a chat, so the messages around an old one come from here.
// Everything is opened read-only. Writes always go through Beeper.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class HistoryError extends Error {}

export const beeperDB = () => process.env.BEEPER_ASSISTANT_INDEX_DB || join(homedir(), 'Library', 'Application Support', 'BeeperTexts', 'index.db');
export const messagesDB = () => process.env.BEEPER_ASSISTANT_CHAT_DB || join(homedir(), 'Library', 'Messages', 'chat.db');

// /usr/bin/sqlite3 on purpose: another sqlite3 earlier in PATH can be built for the wrong chip.
function query(file, sql) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-readonly', '-json', `file:${file}?mode=ro`, sql], { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n').pop()));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); } catch (e) { reject(e); }
    });
  });
}

const str = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function open(file, what, fix) {
  if (!existsSync(file)) throw new HistoryError(`${what} is not on this Mac, at ${file}.`);
  try { await query(file, 'select 1'); } catch (e) { throw new HistoryError(`${what} could not be read: ${e.message}. ${fix}`); }
}

// Beeper does not document this file, so check the columns before trusting them.
async function needColumns(file, table, cols, what) {
  const have = new Set((await query(file, `select name from pragma_table_info(${str(table)})`)).map((r) => r.name));
  const missing = cols.filter((c) => !have.has(c));
  if (missing.length) throw new HistoryError(`${what} changed its layout (${table} has no ${missing.join(', ')}). Older history cannot be read until the skill is updated.`);
  return have;
}

// ---- Beeper: every network except iMessage ----
// Each row holds the message as Beeper's API returns it. The API's message id is the row id,
// and its sort key is hsOrder.
const BEEPER_HIDDEN = ['HIDDEN', 'REACTION'];

export function beeperRowToMessage(row, chatID) {
  let m = {};
  try { m = JSON.parse(row.message); } catch { /* keep the columns */ }
  const ts = Number(m.timestamp);
  return {
    ...m,
    id: String(row.id),
    chatID,
    sortKey: String(row.hsOrder),
    timestamp: Number.isFinite(ts) ? new Date(ts).toISOString() : m.timestamp,
    isSender: m.isSender === true,
    isHidden: BEEPER_HIDDEN.includes(row.type),
  };
}

export async function aroundInBeeper(chatID, messageID, { before = 10, after = 10, file = beeperDB() } = {}) {
  if (!/^\d+$/.test(String(messageID))) throw new HistoryError(`Message ${messageID} is not the kind Beeper keeps in its history file.`);
  await open(file, "Beeper's history file", 'Open Beeper Desktop and try again.');
  await needColumns(file, 'mx_room_messages', ['id', 'roomID', 'hsOrder', 'type', 'eventID', 'isDeleted', 'message'], "Beeper's history file");
  const cols = 'id, hsOrder, type, eventID, message';
  const hidden = BEEPER_HIDDEN.map(str).join(', ');
  const sql = `with t as (select hsOrder h, id i from mx_room_messages where roomID = ${str(chatID)} and id = ${Number(messageID)})
select * from (select ${cols} from mx_room_messages, t where roomID = ${str(chatID)} and (id = i or (type not in (${hidden}) and (hsOrder < h or (hsOrder = h and id < i)))) order by hsOrder desc, id desc limit ${before + 1})
union all
select * from (select ${cols} from mx_room_messages, t where roomID = ${str(chatID)} and type not in (${hidden}) and (hsOrder > h or (hsOrder = h and id > i)) order by hsOrder asc, id asc limit ${after})`;
  const rows = await query(file, sql);
  if (!rows.some((r) => String(r.id) === String(messageID))) throw new HistoryError("That message is not in Beeper's history file on this Mac.");
  const msgs = unique(rows.map((r) => beeperRowToMessage(r, chatID)));
  // Reactions are rows of their own, pointing at the event id of the message they react to.
  const events = new Map(rows.filter((r) => r.eventID).map((r) => [r.eventID, String(r.id)]));
  if (events.size) {
    const found = await query(file, `select json_extract(message, '$.linkedMessageID') target, json_extract(message, '$.action.reactionKey') k, json_extract(message, '$.action.participantID') who, json_extract(message, '$.isSender') mine
from mx_room_messages where roomID = ${str(chatID)} and type = 'REACTION' and isDeleted = 0 and json_extract(message, '$.linkedMessageID') in (${[...events.keys()].map(str).join(', ')})`).catch(() => []);
    attachReactions(msgs, found.filter((x) => x.k).map((x) => ({ target: events.get(x.target), reactionKey: x.k, participantID: x.who, isSender: x.mine === 1 || x.mine === true })));
  }
  return msgs.sort(bySortKey);
}

// ---- iMessage: Apple's Messages database ----
// Beeper's message id for iMessage is the message guid there.
const APPLE_EPOCH_S = 978_307_200;

export function appleDate(v) {
  const n = Number(v);
  if (!n) return null;
  const s = n > 1e12 ? n / 1e9 : n; // nanoseconds since macOS 10.13, seconds before
  return new Date((s + APPLE_EPOCH_S) * 1000).toISOString();
}

// Newer messages keep their text only inside attributedBody, an archived NSAttributedString.
// The text follows the NSString class name, after a '+' and a length.
export function textFromAttributedBody(hex) {
  if (!hex) return null;
  const b = Buffer.from(hex, 'hex');
  const at = b.indexOf('NSString');
  if (at < 0) return null;
  let i = b.indexOf(0x2b, at + 8);
  if (i < 0 || i > at + 20) return null;
  i++;
  let len = b[i++];
  if (len === 0x81) { len = b.readUInt16LE(i); i += 2; } else if (len === 0x82) { len = b.readUInt32LE(i); i += 4; }
  if (!(len >= 0) || i + len > b.length) return null;
  return b.subarray(i, i + len).toString('utf8');
}

const KIND = (mime) => (/^image\//.test(mime) ? 'img' : /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : 'unknown');

export function appleRowToMessage(row, chatID, attachments = []) {
  // U+FFFC marks where an attachment sat in the text.
  const raw = row.text != null ? row.text : textFromAttributedBody(row.body);
  const text = String(raw || '').replace(/￼/g, '').trim();
  return {
    id: row.guid,
    chatID,
    sortKey: String(row.date),
    timestamp: appleDate(row.date),
    isSender: row.is_from_me === 1,
    senderName: row.is_from_me === 1 ? 'me' : (row.handle || ''),
    text,
    attachments: attachments.map((a) => ({ type: KIND(String(a.mime_type || '')), mimeType: a.mime_type || undefined, fileName: a.transfer_name || undefined })),
    isDeleted: Number(row.date_retracted) > 0,
    editedTimestamp: Number(row.date_edited) > 0 ? appleDate(row.date_edited) : undefined,
    isHidden: false,
  };
}

export async function aroundInMessages(chatID, guid, { before = 10, after = 10, file = messagesDB() } = {}) {
  await open(file, 'The Messages database', 'The app your agent runs in needs Full Disk Access, in System Settings, Privacy & Security.');
  const have = await needColumns(file, 'message', ['ROWID', 'guid', 'date', 'is_from_me', 'text', 'handle_id', 'associated_message_type', 'item_type'], 'The Messages database');
  await needColumns(file, 'chat_message_join', ['chat_id', 'message_id', 'message_date'], 'The Messages database');
  const opt = (c) => (have.has(c) ? `m.${c}` : `null as ${c}`);
  const target = await query(file, `select m.ROWID r, j.chat_id c, cast(j.message_date as text) d from message m join chat_message_join j on j.message_id = m.ROWID where m.guid = ${str(guid)} limit 1`);
  if (!target.length) throw new HistoryError('That message is not in the Messages database on this Mac.');
  // Dates are nanoseconds, past the integers JavaScript holds exactly, so they stay text.
  const { r, c, d } = target[0];
  if (!/^\d+$/.test(String(d))) throw new HistoryError('The Messages database gave an unexpected date for that message.');
  // Tapbacks and group events are left out, as in the chat view.
  const cols = `m.ROWID rowid, m.guid, cast(j.message_date as text) date, m.is_from_me, m.text, hex(m.attributedBody) body, h.id handle, ${opt('cache_has_attachments')}, ${opt('date_edited')}, ${opt('date_retracted')}`;
  const from = 'chat_message_join j join message m on m.ROWID = j.message_id left join handle h on h.ROWID = m.handle_id';
  const real = 'm.associated_message_type = 0 and m.item_type = 0';
  const sql = `select * from (select ${cols} from ${from} where j.chat_id = ${Number(c)} and (m.ROWID = ${Number(r)} or (${real} and (j.message_date < ${d} or (j.message_date = ${d} and m.ROWID < ${Number(r)})))) order by j.message_date desc, m.ROWID desc limit ${before + 1})
union all
select * from (select ${cols} from ${from} where j.chat_id = ${Number(c)} and ${real} and (j.message_date > ${d} or (j.message_date = ${d} and m.ROWID > ${Number(r)})) order by j.message_date asc, m.ROWID asc limit ${after})`;
  const rows = await query(file, sql);
  const withFiles = rows.filter((x) => Number(x.cache_has_attachments) > 0).map((x) => Number(x.rowid));
  const files = new Map();
  if (withFiles.length) {
    const found = await query(file, `select j.message_id id, a.mime_type, a.transfer_name from message_attachment_join j join attachment a on a.ROWID = j.attachment_id where j.message_id in (${withFiles.join(',')})`).catch(() => []);
    for (const f of found) { if (!files.has(f.id)) files.set(f.id, []); files.get(f.id).push(f); }
  }
  const msgs = unique(rows.map((x) => appleRowToMessage(x, chatID, files.get(Number(x.rowid)) || [])));
  // Tapbacks are messages of their own that point at the guid they react to.
  const emoji = have.has('associated_message_emoji') ? 'm.associated_message_emoji' : 'null';
  const taps = await query(file, `select m.associated_message_guid g, m.associated_message_type t, ${emoji} e, m.is_from_me me, h.id handle
from chat_message_join j join message m on m.ROWID = j.message_id left join handle h on h.ROWID = m.handle_id
where j.chat_id = ${Number(c)} and m.associated_message_type between 2000 and 3006 order by j.message_date, m.ROWID`).catch(() => []);
  attachReactions(msgs, tapbacks(taps));
  return msgs.sort(bySortKey);
}

const TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓'];

// Adds and removals in date order leave each person's current tapback on each message.
export function tapbacks(rows) {
  const now = new Map();
  for (const x of rows) {
    const target = String(x.g || '').replace(/^(p:\d+\/|bp:)/, '');
    const t = Number(x.t);
    const who = x.me === 1 ? 'me' : String(x.handle || '');
    const slot = `${target} ${who} ${t % 1000}`;
    if (t >= 3000) { now.delete(slot); continue; }
    const key = t === 2006 ? x.e : TAPBACKS[t - 2000];
    if (key) now.set(slot, { target, reactionKey: key, participantName: who === 'me' ? '' : who, isSender: who === 'me' });
  }
  return [...now.values()];
}

function attachReactions(msgs, reactions) {
  const byID = new Map(msgs.map((m) => [String(m.id), m]));
  for (const r of reactions) {
    const m = byID.get(String(r.target));
    if (!m) continue;
    const { target, ...rest } = r;
    (m.reactions ||= []).push(rest);
  }
}

const unique = (msgs) => [...new Map(msgs.map((m) => [m.id, m])).values()];

function bySortKey(a, b) {
  return String(a.sortKey).localeCompare(String(b.sortKey), 'en', { numeric: true });
}

export const isIMessageChat = (chat) => /^imsg##/.test(String((chat && chat.id) || ''));

export function messagesAround(chat, messageID, opts) {
  return isIMessageChat(chat) ? aroundInMessages(chat.id, messageID, opts) : aroundInBeeper(chat.id, messageID, opts);
}

// For the setup check. Returns one line per source.
export async function historyStatus() {
  const lines = [];
  for (const [what, file, table, cols, fix] of [
    ["Beeper's history file", beeperDB(), 'mx_room_messages', ['id', 'roomID', 'hsOrder', 'type', 'message'], 'Older messages on other networks cannot be shown.'],
    ['The Messages database', messagesDB(), 'message', ['guid', 'date', 'text'], 'Older iMessages cannot be shown. The fix is the same Full Disk Access that Contacts needs.'],
  ]) {
    try { await open(file, what, ''); await needColumns(file, table, cols, what); lines.push({ ok: true, text: `${what} readable, for older messages` }); } catch (e) { lines.push({ ok: false, text: `${e.message.replace(/\s+$/, '')} ${fix}` }); }
  }
  return lines;
}
