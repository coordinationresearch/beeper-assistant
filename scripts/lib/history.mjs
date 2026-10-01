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
    isDeleted: m.isDeleted === true || row.isDeleted === 1,
  };
}

export async function aroundInBeeper(chatID, messageID, { before = 10, after = 10, file = beeperDB() } = {}) {
  if (!/^\d+$/.test(String(messageID))) throw new HistoryError(`Message ${messageID} is not the kind Beeper keeps in its history file.`);
  await open(file, "Beeper's history file", 'Open Beeper Desktop and try again.');
  await needColumns(file, 'mx_room_messages', ['id', 'roomID', 'hsOrder', 'type', 'eventID', 'isDeleted', 'message'], "Beeper's history file");
  const cols = 'id, hsOrder, type, eventID, isDeleted, message';
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

// ---- How much the Owner and each Chat have written, and how often the Owner answers ----
// Counts only, never text, for ranking the Triage list. A few queries per file cover every
// Chat at once. iMessage Chats are found through messages the Chat already showed: Beeper's
// iMessage message id is the guid in the Messages database, and its Chat id names nothing there.
const DAY_MS = 86_400_000;
const WEEK_NS = 604_800_000_000_000n;
export const ANSWER_DAYS = 180; // how far back answer rates look
export const ANSWER_WITHIN_MS = 2 * DAY_MS; // the horizon earlier reply-pair work used for "answered"
const appleNs = (ms) => (BigInt(Math.floor(ms / 1000)) - BigInt(APPLE_EPOCH_S)) * 1_000_000_000n;
const msOf = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : null; };
const appleMs = (v) => (v ? Date.parse(appleDate(v)) : null);

function statsRow(x, source) {
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  return {
    messages: Number(x.n) || 0,
    owner: Number(x.mine) || 0,
    theirs: (Number(x.n) || 0) - (Number(x.mine) || 0),
    owner90: Number(x.mine90) || 0,
    ownerWeeks26: Number(x.weeks26) || 0,
    first: iso(x.first),
    ownerLast: iso(x.lastMine),
    source,
  };
}

// Runs of their messages and whether the Owner answered each within two days. A run starts at
// their message after the Owner's (or at the start) and ends at the Owner's next message.
// Runs too recent to have had that long are left out. `msgs` is [{ at, mine }] sorted by time.
export function answerRate(msgs, now = Date.now()) {
  let runs = 0, answered = 0;
  const waits = [];
  let start = null;
  for (const m of msgs) {
    if (!m.mine) { if (start === null) start = m.at; continue; }
    if (start !== null) {
      if (now - start >= ANSWER_WITHIN_MS) {
        runs++;
        if (m.at - start <= ANSWER_WITHIN_MS) { answered++; waits.push(m.at - start); }
      }
      start = null;
    }
  }
  if (start !== null && now - start >= ANSWER_WITHIN_MS) runs++;
  waits.sort((a, b) => a - b);
  return { runs, answered, medianAnswerMs: waits.length ? waits[Math.floor((waits.length - 1) / 2)] : null };
}

function groupRuns(rows, now) {
  const by = new Map();
  for (const r of rows) { if (!by.has(r.k)) by.set(r.k, []); by.get(r.k).push(r); }
  const out = new Map();
  for (const [k, list] of by) out.set(k, answerRate(list, now));
  return out;
}

export async function statsInBeeper(chatIDs, { now = Date.now(), file = beeperDB() } = {}) {
  const out = new Map();
  if (!chatIDs.length) return out;
  await open(file, "Beeper's history file", '');
  const have = await needColumns(file, 'mx_room_messages', ['roomID', 'type', 'isDeleted', 'message'], "Beeper's history file");
  // Newer layouts keep the sender and time in columns. Older ones only inside the JSON.
  const mine = have.has('isSentByMe') ? 'isSentByMe = 1' : "json_extract(message, '$.isSender') = 1";
  const rawTs = have.has('timestamp') ? 'timestamp' : "json_extract(message, '$.timestamp')";
  // A few rows store seconds, the rest milliseconds.
  const ts = `(case when ${rawTs} < 100000000000 then ${rawTs} * 1000 else ${rawTs} end)`;
  const since90 = now - 90 * DAY_MS, since26w = now - 182 * DAY_MS, sinceAnswer = now - ANSWER_DAYS * DAY_MS;
  const real = `isDeleted = 0 and type not in (${BEEPER_HIDDEN.map(str).join(', ')}) and roomID in (${chatIDs.map(str).join(', ')}) and ${ts} <= ${now}`;
  const [rows, timeline] = await Promise.all([
    query(file, `select roomID id, count(*) n, sum(${mine}) mine, min(${ts}) first, max(case when ${mine} then ${ts} end) lastMine,
 sum(${mine} and ${ts} > ${since90}) mine90, count(distinct case when ${mine} and ${ts} > ${since26w} then ${ts} / ${7 * DAY_MS} end) weeks26
from mx_room_messages where ${real} group by roomID`),
    query(file, `select roomID k, ${ts} at, (${mine}) mine from mx_room_messages where ${real} and ${ts} > ${sinceAnswer} order by roomID, ${ts}`),
  ]);
  const rates = groupRuns(timeline.map((x) => ({ k: String(x.k), at: Number(x.at), mine: Number(x.mine) === 1 })), now);
  for (const x of rows) out.set(String(x.id), { ...statsRow({ ...x, first: msOf(x.first), lastMine: msOf(x.lastMine) }, 'beeper-file'), ...(rates.get(String(x.id)) || answerRate([], now)) });
  return out;
}

// `idsByChat` maps a Chat id to the guids of messages it showed. The guids must all lead to
// the same Messages chat, or the Chat gets no counts: one wrong match would borrow a
// stranger's history.
export async function statsInMessages(idsByChat, { now = Date.now(), file = messagesDB() } = {}) {
  const out = new Map();
  const guids = [...new Set([...idsByChat.values()].flat().map(String))];
  if (!guids.length) return out;
  await open(file, 'The Messages database', 'The app your agent runs in needs Full Disk Access, in System Settings, Privacy & Security.');
  const have = await needColumns(file, 'message', ['ROWID', 'guid', 'is_from_me', 'associated_message_type', 'item_type'], 'The Messages database');
  await needColumns(file, 'chat_message_join', ['chat_id', 'message_id', 'message_date'], 'The Messages database');
  const links = await query(file, `select m.guid g, j.chat_id c from message m join chat_message_join j on j.message_id = m.ROWID where m.guid in (${guids.map(str).join(', ')})`);
  const chatsOf = new Map();
  for (const l of links) { const g = String(l.g); if (!chatsOf.has(g)) chatsOf.set(g, new Set()); chatsOf.get(g).add(Number(l.c)); }
  const appleChat = new Map();
  for (const [id, ids] of idsByChat) {
    const found = new Set(ids.flatMap((g) => [...(chatsOf.get(String(g)) || [])]));
    if (found.size === 1) appleChat.set(id, [...found][0]);
  }
  if (!appleChat.size) return out;
  // Dates are nanoseconds, past what JavaScript holds exactly, so limits and results stay text.
  const nowNs = appleNs(now), since90 = appleNs(now - 90 * DAY_MS), since26w = appleNs(now - 182 * DAY_MS), sinceAnswer = appleNs(now - ANSWER_DAYS * DAY_MS);
  const retracted = have.has('date_retracted') ? 'and coalesce(m.date_retracted, 0) = 0' : '';
  const real = `j.chat_id in (${[...new Set(appleChat.values())].join(', ')}) and m.associated_message_type = 0 and m.item_type = 0 ${retracted} and j.message_date <= ${nowNs}`;
  const from = 'chat_message_join j join message m on m.ROWID = j.message_id';
  const [rows, timeline] = await Promise.all([
    query(file, `select j.chat_id c, count(*) n, sum(m.is_from_me) mine, cast(min(j.message_date) as text) first, cast(max(case when m.is_from_me = 1 then j.message_date end) as text) lastMine,
 sum(m.is_from_me = 1 and j.message_date > ${since90}) mine90, count(distinct case when m.is_from_me = 1 and j.message_date > ${since26w} then j.message_date / ${WEEK_NS} end) weeks26
from ${from} where ${real} group by j.chat_id`),
    query(file, `select j.chat_id k, cast(j.message_date as text) at, m.is_from_me mine from ${from} where ${real} and j.message_date > ${sinceAnswer} order by j.chat_id, j.message_date`),
  ]);
  const rates = groupRuns(timeline.map((x) => ({ k: Number(x.k), at: appleMs(x.at), mine: Number(x.mine) === 1 })), now);
  const byApple = new Map(rows.map((x) => [Number(x.c), x]));
  for (const [id, c] of appleChat) {
    const x = byApple.get(c);
    if (x) out.set(id, { ...statsRow({ ...x, first: appleMs(x.first), lastMine: appleMs(x.lastMine) }, 'messages-file'), ...(rates.get(c) || answerRate([], now)) });
  }
  return out;
}

// Each chat: { id, messageIDs: [ids of messages it showed] }.
// Returns the counts found, and one line per file that could not be read.
export async function chatStats(chats, { now = Date.now(), beeperFile = beeperDB(), messagesFile = messagesDB() } = {}) {
  const stats = new Map();
  const problems = [];
  const others = chats.filter((c) => !isIMessageChat(c)).map((c) => c.id);
  const idsByChat = new Map(chats.filter(isIMessageChat).map((c) => [c.id, (c.messageIDs || []).filter(Boolean)]).filter(([, ids]) => ids.length));
  const [b, a] = await Promise.allSettled([statsInBeeper(others, { now, file: beeperFile }), statsInMessages(idsByChat, { now, file: messagesFile })]);
  for (const r of [b, a]) {
    if (r.status === 'fulfilled') for (const [k, v] of r.value) stats.set(k, v);
    else problems.push(r.reason && r.reason.message ? r.reason.message : String(r.reason));
  }
  return { stats, problems };
}

// How often the Owner answers a stranger's first message, per account: one-to-one Chats that
// began with their message in the last 180 days, answered within a week. iMessage is keyed
// 'imessage', every other network by its Beeper account id.
export async function strangerRates({ now = Date.now(), beeperFile = beeperDB(), messagesFile = messagesDB() } = {}) {
  const rates = new Map();
  const week = 7 * DAY_MS;
  const jobs = [
    (async () => {
      await open(beeperFile, "Beeper's history file", '');
      const have = await needColumns(beeperFile, 'mx_room_messages', ['roomID', 'type', 'isDeleted', 'isSentByMe', 'timestamp'], "Beeper's history file");
      await needColumns(beeperFile, 'threads', ['threadID', 'accountID', 'thread'], "Beeper's history file");
      const ts = '(case when timestamp < 100000000000 then timestamp * 1000 else timestamp end)';
      const rows = await query(beeperFile, `select t.accountID k, count(*) chats, sum(firstMine is not null and firstMine - first <= ${week}) answered from
 (select roomID, min(${ts}) first, min(case when isSentByMe = 1 then ${ts} end) firstMine from mx_room_messages where isDeleted = 0 and type not in (${BEEPER_HIDDEN.map(str).join(', ')}) and ${ts} <= ${now} group by roomID) r
 join threads t on t.threadID = r.roomID where json_extract(t.thread, '$.type') = 'single' and first > ${now - ANSWER_DAYS * DAY_MS} and first <= ${now - week} and (firstMine is null or firstMine > first) group by t.accountID`);
      for (const x of rows) rates.set(String(x.k), { chats: Number(x.chats), answered: Number(x.answered) });
    })(),
    (async () => {
      await open(messagesFile, 'The Messages database', '');
      await needColumns(messagesFile, 'chat', ['ROWID', 'style'], 'The Messages database');
      const since = appleNs(now - ANSWER_DAYS * DAY_MS), until = appleNs(now - week), weekNs = BigInt(week) * 1_000_000n;
      const rows = await query(messagesFile, `select count(*) chats, sum(firstMine is not null and firstMine - first <= ${weekNs}) answered from
 (select j.chat_id, min(j.message_date) first, min(case when m.is_from_me = 1 then j.message_date end) firstMine from chat_message_join j join message m on m.ROWID = j.message_id join chat c on c.ROWID = j.chat_id
  where c.style = 45 and m.associated_message_type = 0 and m.item_type = 0 group by j.chat_id) t
 where first > ${since} and first <= ${until} and (firstMine is null or firstMine > first)`);
      if (rows[0] && Number(rows[0].chats)) rates.set('imessage', { chats: Number(rows[0].chats), answered: Number(rows[0].answered) });
    })(),
  ];
  await Promise.allSettled(jobs);
  return rates;
}

export const strangerKey = (row) => (/^imsg##/.test(String(row.id || '')) ? 'imessage' : String(row.account || ''));

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
