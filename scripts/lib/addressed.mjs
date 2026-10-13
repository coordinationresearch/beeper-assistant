// Whether a group Chat Addressed the Owner (CONTEXT.md, Addressed), the one copy `ba triage` and
// Beeper Companion's Triage snapshot both use (ADR 0086, 0145). Read only from the group's own
// messages. Someone in their Burst addressed the Owner when Beeper counts an unread mention, someone
// replied to one of the Owner's messages, or someone wrote the Owner's first name. In a small group,
// any question counts too. A question to the whole room of a larger group doesn't (CONTEXT.md, Needs
// a reply). Beeper reports unreadMentionsCount only for bridged networks: no native iMessage Chat
// carries the field (checked 2026-10-10, 0 of 95 groups), and API messages carry no mention list. So
// the reply and the name are read from the messages, which iMessage's do carry (linkedMessageID).
import { execFile } from 'node:child_process';
import { participantsOf } from './beeper.mjs';
import { contactDatabases } from './contacts.mjs';
import { QUESTION } from './rank.mjs';
import { applyContext, htmlToText, selfNames, trailingInbound } from './triage.mjs';

// A group of the Owner and at most this many others is small: there, any question in their Burst is
// put to the Owner too (Owner, 2026-10-10, second heartbeat grill item 8).
export const SMALL_GROUP_OTHERS = 3;

// A name's first word, lowercased, as people write it in a message: "Sam Example" is "sam".
export function firstName(name) {
  const word = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  return word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLocaleLowerCase();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// First names that are also words people text all the time, so "will you come?" never names a Will.
const COMMON_WORDS = new Set(['will', 'may', 'june', 'april', 'august', 'mark', 'bill', 'art', 'grant', 'hope', 'rich', 'joy', 'faith', 'grace', 'rose',
  'dawn', 'ray', 'pat', 'sue', 'guy', 'max', 'chase', 'chance', 'cash', 'frank', 'hunter', 'miles', 'rob', 'sky', 'summer', 'sunny', 'jack', 'don',
  'drew', 'sandy', 'penny', 'holly', 'ivy', 'lily', 'daisy', 'ruby', 'amber', 'autumn', 'river', 'ash', 'wade', 'dale', 'glen', 'lane', 'page',
  'reed', 'king', 'earl', 'duke', 'prince', 'mason', 'carter', 'bob', 'nick', 'gene', 'jean', 'kit', 'robin', 'stormy', 'harmony', 'destiny']);
const BEFORE = '(?:^|[^\\p{L}\\p{N}_])', AFTER = '(?=$|[^\\p{L}\\p{N}_])';
// Whether a message's text names the Owner: one of their first names as a whole word, with or without
// an @ in front, so "Sam's" and "@sam" count and "Samantha" doesn't. A name that is also a common word
// counts only as "@will" anywhere, or when the message opens by addressing them, "Will, ..." or "hey
// will": "ok will do" and "I will, if it rains" name nobody.
export function namesOwner(text, names) {
  return names.some((name) => {
    const n = escape(name);
    if (!COMMON_WORDS.has(name)) return new RegExp(`${BEFORE}@?${n}${AFTER}`, 'iu').test(text);
    return new RegExp(`${BEFORE}@${n}${AFTER}|^\\s*${n}\\s*[,!:]|^\\s*(?:hey|hi|yo)[,!]?\\s+${n}${AFTER}`, 'iu').test(text);
  });
}

// The Owner's first names to look for in one group: theirs, minus any another member shares, since
// "Sam, you in?" in a group with two Sams may be for the other one. Two letters at least.
export function ownerNamesIn(chat, messages, owner) {
  const others = new Set([
    ...participantsOf(chat ?? {}).filter((p) => p?.isSelf !== true).map((p) => firstName(p?.fullName)),
    ...messages.filter((m) => m?.isSender !== true).map((m) => firstName(m?.senderName)),
  ]);
  return [...new Set(owner.map(firstName))].filter((n) => n.length >= 2 && !others.has(n));
}

// The Owner's display names on the networks that give one (triage.mjs selfNames), as first names.
export function ownerNamesFrom(chats) {
  return [...selfNames(chats)].map(firstName).filter(Boolean);
}

// The messages in their Burst that reply to one outside what was read: Beeper's API gives one page,
// and the Owner's message they answer may be older. The caller looks these up (owned, below).
export function repliesBeyond(messages) {
  const { lastFrom, burst } = trailingInbound(messages);
  if (lastFrom !== 'them') return [];
  const read = new Set(messages.map((m) => String(m?.id)));
  return [...new Set(burst.map((m) => m.linkedMessageID).filter((id) => id != null && !read.has(String(id))).map(String))];
}

// A group's messages, oldest first, as Beeper's API gives them, read the way the Triage list reads a
// one-to-one Chat (applyContext): their newest real message when they wrote last, its time, hash, and
// kind, whether the Owner wrote in what was read, and how their Burst addressed the Owner, with the
// message that did it (addressedIn), which a mention never names. All are null unless they wrote last.
// mentions and unread: Beeper's unread mention and message counts for the Chat. The count says only
// that a mention is unread somewhere, so it counts only while every unread message is in their Burst:
// a mention before 8 quiet hours is an earlier Conversation's. names: the Owner's first names for this
// group (ownerNamesIn). owned: the IDs of older messages, beyond what was read, that are the Owner's
// (repliesBeyond). others: how many people besides the Owner are in the group, 0 when unknown.
// Beeper's counts clear once the Owner reads the group on any device, while the mention still
// addresses them, so a mention is kept by the message of their Burst it was counted with: mentionIn
// in what this returns, which the caller passes back as mentionedIn at the next read. It holds while
// that message is still in their Burst (second heartbeat grill item 4).
export function groupRead(messages, { mentions = 0, unread = 0, names = [], owned = [], others = 0, mentionedIn = null, now = Date.now() } = {}) {
  const row = { type: 'group', kind: null, lastFrom: null, lastActivity: null, lastInboundAt: null, preview: '' };
  applyContext(row, messages, { now });
  const theirs = row.lastFrom === 'them' && row.newestID != null, older = [...owned];
  // An older message looked up and found to be the Owner's shows they write here too.
  const read = { lastFrom: row.lastFrom ?? null, newestID: theirs ? String(row.newestID) : null, newestAt: theirs ? row.lastActivity ?? null : null,
    newestHash: theirs ? row.newestHash ?? null : null, kind: theirs ? row.kind ?? null : null, ownerSpoke: row.ownerSpoke === true || older.length > 0,
    addressed: null, addressedIn: null, mentionIn: null };
  if (!theirs) return read;
  // Their Burst: what they sent since the Owner last wrote, back to 8 quiet hours. A Reaction is not
  // in it, so someone's tapback on the Owner's message never counts as a reply.
  const { burst } = trailingInbound(messages);
  const own = new Set([...messages.filter((m) => m?.isSender === true).map((m) => String(m.id)), ...older]);
  const found = (how, m) => Object.assign(read, { addressed: how, addressedIn: m ? String(m.id) : null });
  if (mentions > 0 && unread > 0 && unread <= burst.length) { read.mentionIn = String(burst[burst.length - 1].id); return found('mention', null); }
  if (mentionedIn != null && burst.some((m) => String(m.id) === String(mentionedIn))) { read.mentionIn = String(mentionedIn); return found('mention', null); }
  const replied = burst.find((m) => m.linkedMessageID != null && own.has(String(m.linkedMessageID)));
  if (replied) return found('reply', replied);
  const named = names.length ? burst.find((m) => namesOwner(htmlToText(m.text), names)) : undefined;
  if (named) return found('name', named);
  // In a small group, their newest question.
  const asked = others > 0 && others <= SMALL_GROUP_OTHERS ? [...burst].reverse().find((m) => QUESTION.test(htmlToText(m.text))) : undefined;
  return asked ? found('question', asked) : read;
}

// The first name and nickname on the Contacts card macOS marks as the Owner's, for an Owner whose
// networks give no display name, as native iMessage doesn't. Read-only, as the Contacts index is.
const ME_NAMES_SQL = `select ZFIRSTNAME as first, ZNICKNAME as nick from ZABCDRECORD
 where ZCONTAINERWHERECONTACTISME is not null or Z_PK in (select ZME from ZABCDRECORD where ZME is not null);`;
export async function meCardNames(root) {
  const out = new Set();
  for (const db of contactDatabases(root)) {
    const rows = await new Promise((resolve) => execFile('/usr/bin/sqlite3', ['-readonly', '-json', db, ME_NAMES_SQL], { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => { try { resolve(error || !stdout.trim() ? [] : JSON.parse(stdout)); } catch { resolve([]); } }));
    for (const r of rows) for (const n of [r?.first, r?.nick]) { const name = firstName(n); if (name) out.add(name); }
  }
  return [...out];
}
