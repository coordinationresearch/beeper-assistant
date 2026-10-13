// `ba triage` from Beeper Companion's Catch up (ADR 0110): when the Companion is running, the
// Terminal answers "what needs my reply?" from the same list the Owner sees over Beeper. When it
// isn't, or its list hasn't checked yet, `ba triage` ranks on its own as it always has.
import { catchUpFromApp } from './app.mjs';
import { age, ago, plural, quote, UNTRUSTED_NOTE } from './render.mjs';
import { chatAlias, messageAlias } from './state.mjs';

// Fixed sentences, printed to stderr before ba's own ranking. Never text the app sent.
export const CATCH_UP_UNAVAILABLE = "Beeper Companion's Catch up wasn't available, so this list is ba's own ranking.";
export const CATCH_UP_NOT_READY = "Beeper Companion's Catch up hasn't finished its first check, so this list is ba's own ranking.";
// Flags only ba's own ranking understands. With any of them, the agent asked for that list.
export const OWN_RANKING_FLAGS = ['days', 'max', 'all', 'max-groups'];
// The Triage list's states that hold rows worth showing: a list, current or the last one.
const READY = new Set(['ok', 'stale', 'partial']);

// The shape every row must have before anything prints, section by section, so an answer from an
// older or newer Companion falls back to ba's own ranking instead of failing halfway.
const str = (v) => typeof v === 'string' && v.length > 0;
const maybe = (v) => v === null || v === undefined || typeof v === 'string';
const receipt = (r) => Boolean(r) && typeof r === 'object' && maybe(r.chatID) && maybe(r.messageID) && maybe(r.who) && typeof r.text === 'string' && typeof r.at === 'string';
const chatRow = (i) => str(i.chatID) && str(i.name) && typeof i.network === 'string' && typeof i.want === 'string' && typeof i.reason === 'string' && maybe(i.messageID) && maybe(i.waitingSince);
const ROW = {
  urgent: chatRow,
  waiting: chatRow,
  dropped: (i) => str(i.chatID) && str(i.name) && typeof i.network === 'string' && str(i.kind) && typeof i.why === 'string' && receipt(i.receipt) && maybe(i.suggestion),
  revive: (i) => str(i.chatID) && str(i.name) && typeof i.network === 'string' && typeof i.why === 'string' && typeof i.lastTalked === 'string' && receipt(i.now) && receipt(i.then) && maybe(i.suggestion),
  faded: (i) => maybe(i.chatID) && str(i.title) && typeof i.chat === 'string' && typeof i.since === 'string' && typeof i.span === 'string' && receipt(i.receipt) && maybe(i.suggestion),
  reminder: (i) => str(i.chatID) && str(i.name) && typeof i.network === 'string' && typeof i.at === 'string',
};
export const validCatchUp = (record) => Boolean(record) && typeof record === 'object' && Array.isArray(record.items) && Boolean(record.sections) && typeof record.sections === 'object'
  && record.items.every((i) => Boolean(i) && typeof i === 'object' && Object.hasOwn(ROW, i.section) && ROW[i.section](i));

// { record } to print, or { note } to say before ba's own ranking; a null note says nothing,
// as on a Mac where no Companion has run.
export async function catchUpForTriage(flags, read = catchUpFromApp) {
  if (OWN_RANKING_FLAGS.some((f) => flags[f] !== undefined)) return { note: null };
  const got = await read();
  if (got.record && !validCatchUp(got.record)) return { note: CATCH_UP_UNAVAILABLE };
  if (got.record) return READY.has(got.record.sections.triage?.status) ? { record: got.record } : { note: CATCH_UP_NOT_READY };
  return { note: got.failure === 'absent' ? null : CATCH_UP_UNAVAILABLE };
}

// Every Chat and message a row names, so `ba chat`, `ba draft`, and `ba send` take the c… and m…
// references printed here.
export function catchUpReferences(record) {
  const chats = [], messages = [];
  for (const item of record.items) {
    if (item.chatID) chats.push({ id: item.chatID });
    for (const r of [item.receipt, item.now, item.then]) {
      // A receipt may sit in another Chat, such as a Revive's hook, and its message resolves only there.
      if (r?.chatID) chats.push({ id: r.chatID });
      if (r?.messageID && (r.chatID || item.chatID)) messages.push({ id: r.messageID, chatID: r.chatID ?? item.chatID });
    }
    if (item.messageID && item.chatID) messages.push({ id: item.messageID, chatID: item.chatID });
  }
  return { chats, messages };
}

// The --json shape: the record as the app sent it, each row with its c… reference.
export function catchUpJSON(record) {
  return { source: 'beeper-companion', checkedAt: record.checkedAt ?? null, problem: record.problem ?? null, sections: record.sections,
    items: record.items.map((item) => ({ ref: item.chatID ? chatAlias(item.chatID) : null, ...item })) };
}

const TITLES = {
  urgent: 'URGENT: waiting costs something today',
  dropped: 'YOU DROPPED: something the Owner said they would do, or left hanging',
  revive: 'REVIVE: someone worth writing to again',
  faded: 'FADED INTEREST: something the Owner used to talk about',
  waiting: 'WAITING ON YOU',
  reminder: 'REMINDERS',
};
const SECTION_NAMES = { triage: 'Triage list', dropped: 'You dropped', revive: 'Revive', faded: 'Faded Interests', reminders: 'Reminders' };
const INDENT = ' '.repeat(11);

// "3h ago" for a time, or the value as it came when it isn't one.
function since(iso, now) {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? ago(Math.max(0, now - t)) : String(iso ?? '');
}
// "Mar 2025" for a day long past, or the value as it came.
const month = (iso) => Number.isFinite(Date.parse(iso ?? '')) ? new Date(iso).toLocaleString('en-US', { month: 'short', year: 'numeric' }) : String(iso ?? '');
// A receipt in another Chat names that Chat too, so ba chat <that chat> --around <message> finds it.
const receiptLine = (label, r, item, now) => `${INDENT}${label}${r.messageID ? ` ${messageAlias(r.messageID)}` : ''}${r.chatID && r.chatID !== item.chatID ? ` in ${chatAlias(r.chatID)}` : ''} ${r.who ?? 'You'}, ${since(r.at, now)}: ${quote(r.text)}`;

function rowLines(item, now) {
  const ref = item.chatID ? chatAlias(item.chatID) : '(no chat)'.padEnd(9);
  if (item.section === 'urgent' || item.section === 'waiting') {
    const waited = item.waitingSince ? ` · waiting ${age(Math.max(0, now - Date.parse(item.waitingSince)))}` : '';
    return [`${ref}  ${item.name}${item.group ? ' (group)' : ''} · ${item.network}${waited}  ${item.want}`, `${INDENT}why: ${item.reason}`];
  }
  if (item.section === 'dropped') {
    const marks = [item.kind.toUpperCase(), ...(item.judged ? [] : ['UNCHECKED']), ...(item.suggestion ? ['REPLY WRITTEN'] : [])];
    return [`${ref}  ${item.name} · ${item.network} [${marks.join(' ')}]`, `${INDENT}why: ${item.why}`, receiptLine('from', item.receipt, item, now)];
  }
  if (item.section === 'revive') {
    return [`${ref}  ${item.name} · ${item.network} · last talked ${month(item.lastTalked)}${item.suggestion ? ' [REPLY WRITTEN]' : ''}`, `${INDENT}why: ${item.why}`,
      receiptLine('now', item.now, item, now), receiptLine('then', item.then, item, now)];
  }
  if (item.section === 'faded') {
    return [`${ref}  ${item.title} · ${item.chat} · last came up ${item.since} (${item.span})${item.suggestion ? ' [REPLY WRITTEN]' : ''}`,
      receiptLine('from', { ...item.receipt, who: 'You' }, item, now)];
  }
  return [`${ref}  ${item.name} · ${item.network} · ${item.due ? `due ${since(item.at, now)}` : `set for ${new Date(item.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}`];
}

export function renderCatchUp(record, now = Date.now()) {
  const items = record.items;
  const out = [`CATCH UP · from Beeper Companion${record.checkedAt ? ` · checked ${since(record.checkedAt, now)}` : ''} · ${plural(items.length, 'item')} · already ranked, in the Owner's order`, UNTRUSTED_NOTE];
  for (const section of Object.keys(TITLES)) {
    const rows = items.filter((item) => item.section === section);
    if (!rows.length) continue;
    out.push('', `${TITLES[section]} (${rows.length})`);
    for (const item of rows) out.push(...rowLines(item, now));
  }
  if (!items.length) out.push('', 'Nothing waiting.');
  const notices = Object.entries(record.sections ?? {}).filter(([, s]) => s && s.status !== 'ok' && s.notice).map(([key, s]) => `${SECTION_NAMES[key] ?? key}: ${s.notice}`);
  out.push('');
  if (record.problem) out.push(`Couldn't check everything: ${record.problem}`);
  if (notices.length) out.push(`Not current: ${notices.join(' · ')}`);
  out.push('For a ranking over a window instead, run ba triage --days N.');
  return out.join('\n');
}
