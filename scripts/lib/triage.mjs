// Builds the Triage list from raw chats. Pure functions, no I/O.
import { participantsOf, participantTotal } from './beeper.mjs';
import { looksLikeEmail, looksLikePhone, nameFor, normalizeEmail, normalizePhone } from './contacts.mjs';
import { chatAlias, isDismissed, textHash } from './state.mjs';

export const DEFAULT_WINDOW_DAYS = 14;
const DAY = 86_400_000;

export const isUnread = (c) => (c.unreadCount || 0) > 0 || c.isMarkedUnread === true;
export const lastIsTheirs = (c) => !!c.preview && c.preview.isSender === false;
// The Owner's Reaction is the latest item. Only reading the Chat tells whether it answered their
// newest Message or an earlier one.
const ownerReactedLast = (c) => !!c.preview && c.preview.isSender === true && previewKind(c.preview) === 'reaction';
export const isGroup = (c) => c.type !== 'single';
export const counterparties = (c) => participantsOf(c).filter((p) => p.isSelf !== true);

export function isBotChat(c) {
  const cp = counterparties(c);
  return cp.length > 0 && cp.every((p) => p.isNetworkBot === true);
}

// iMessage tapbacks and similar arrive as plain text.
const REACTION = /^(?:(?:\{\{\s*sender\s*\}\}|\S+)\s+)?(?:(?:loved|liked|disliked|laughed at|emphasi[sz]ed|questioned)\s+|(?:\S+\s+){0,3}?reacted\s+(?:\S+\s+){0,2}?to\s+)(["'\u201c\u2018]|&quot;|an? (image|attachment|photo|video|audio|sticker|message))/i;
// The same with a phone number or a whole name in front, as readers write it once {{sender}} is
// filled in: '+1 555-201-0100 emphasized "see you there"'. A longer lead could be someone's own
// sentence, so it must be a number or capitalized words, with a name's lowercase particles such
// as "de" or "van" between them, and the text must end with the quote.
// No i flag: with it, \p{Lu} matches lowercase too.
const NAMED_REACTION = /^(?:\+?[\d(][\d\s().-]{5,}\d|\p{Lu}\S*(?:\s+(?:(?:al|bin|da|de|del|della|den|der|di|dos|du|ibn|la|le|st\.?|ter|van|von)\s+)?\p{Lu}\S*){1,3})\s+(?:(?:[Ll]oved|[Ll]iked|[Dd]isliked|[Ll]aughed at|[Ee]mphasi[sz]ed|[Qq]uestioned)\s+|[Rr]eacted\s+(?:\S+\s+){0,2}?to\s+)(?:(?:["'\u201c\u2018]|&quot;)[\s\S]*(?:["'\u201d\u2019]|&quot;)|[Aa]n? (?:image|attachment|photo|video|audio|sticker|message))$/u;
export const looksLikeReaction = (text) => {
  const t = String(text || '').trim();
  return REACTION.test(t) || NAMED_REACTION.test(t);
};

const handleLike = (s) => looksLikePhone(s) || looksLikeEmail(s);

// Short codes and one-time passcodes are machines, not people.
const CODE_TEXT = /\b(verification|security|login|sign[- ]?in|one[- ]time|auth(entication)?)\s+(code|pin)\b|\bOTP\b|\bis your\b.{0,40}\bcode\b|\bcode\b.{0,12}\b\d{4,8}\b|\breply STOP\b|\btxt STOP\b/i;
// Softer signs of a business or a machine. Only trusted for senders who are not in Contacts.
const SOFT_AUTOMATED = /\bif this was(n't| not) you\b|\bcontact support\b|\bsign(ed)? in from\b|\b(from )?your driver\b|\bis here\b.{0,20}\blook for\b|\b(fees?|charges?|rates?) (may )?apply\b|\b(do not reply|no-?reply|msg ?(&|and) ?data rates|text STOP|reply HELP|unsubscribe|opt[- ]out)\b|\b(security alert|sign-?in attempt|new (login|sign-?in)|password reset|suspicious activity)\b|\byour (driver|ride|order|package|delivery|appointment|reservation|table|receipt|payment|statement|bill)\b|\b(has|have) (shipped|been delivered)\b/i;
export const looksAutomatedText = (text) => SOFT_AUTOMATED.test(String(text || ''));

const handleKey = (p) => (p && p.phoneNumber ? `p:${normalizePhone(p.phoneNumber)}` : p && p.email ? `e:${normalizeEmail(p.email)}` : null);

// The Owner's own numbers and emails, gathered from every chat.
export function selfHandles(chats) {
  const out = new Set();
  for (const c of chats) for (const p of participantsOf(c)) if (p.isSelf === true) { const k = handleKey(p); if (k) out.add(k); }
  return out;
}

// The Owner's own display names, from networks that give one.
export function selfNames(chats) {
  const out = new Set();
  for (const c of chats) for (const p of participantsOf(c)) {
    const n = String((p.isSelf === true && p.fullName) || '').trim().toLowerCase();
    if (n && !handleLike(n)) out.add(n);
  }
  return out;
}

// A note to self, or a chat between two of the Owner's own accounts.
export function isSelfChat(c, self, names = null) {
  if (isGroup(c)) return false;
  const cp = counterparties(c);
  if (!cp.length) return true;
  const k = handleKey(cp[0]);
  if (k && self && self.has(k)) return true;
  const n = String(cp[0].fullName || c.title || '').trim().toLowerCase();
  return !!n && !!names && names.has(n);
}

export function isAutomated(c) {
  if (isGroup(c)) return false;
  const cp = counterparties(c)[0] || {};
  const raw = String(cp.phoneNumber || (looksLikePhone(c.title) ? c.title : '') || '');
  const digits = raw.replace(/\D+/g, '');
  if (raw && digits.length >= 3 && digits.length <= 6) return true;
  if (/^\d{3,6}$/.test(String(c.title || '').trim())) return true;
  return CODE_TEXT.test(String((c.preview && c.preview.text) || ''));
}

export function personName(p, contacts) {
  const full = String((p && p.fullName) || '').trim();
  if (full && !handleLike(full)) return full;
  const handle = (p && (p.phoneNumber || p.email)) || full;
  return nameFor(contacts, handle) || full || (p && (p.phoneNumber || p.email || p.username || p.id)) || '(unknown)';
}

// Handles to try for a one-to-one chat, best first. Some builds mask the member's number
// and keep the full one in the title.
export function handlesOf(chat) {
  const cp = counterparties(chat)[0] || {};
  const title = String(chat.title || '').trim();
  const usable = (h) => h && !String(h).includes('*') && (looksLikeEmail(h) || looksLikePhone(h));
  return [cp.phoneNumber, cp.email, title].filter(usable);
}

export function chatName(chat, contacts) {
  const title = String(chat.title || '').trim();
  if (isGroup(chat)) {
    if (title && !handleLike(title)) return { name: title, resolved: true };
    const names = counterparties(chat).slice(0, 4).map((p) => personName(p, contacts));
    const extra = participantTotal(chat) - 1 - names.length;
    return { name: names.join(', ') + (extra > 0 ? ` +${extra}` : '') || '(group)', resolved: true };
  }
  if (title && !handleLike(title)) return { name: title, resolved: true };
  const cp = counterparties(chat)[0] || {};
  const handles = handlesOf(chat);
  for (const h of handles) {
    const found = nameFor(contacts, h);
    if (found) return { name: found, resolved: true, handle: h };
  }
  if (cp.fullName && !handleLike(cp.fullName)) return { name: cp.fullName, resolved: true, handle: handles[0] };
  return { name: title || handles[0] || cp.phoneNumber || '(unknown)', resolved: false, handle: handles[0] };
}

export function senderLabel(msg, chat, contacts) {
  if (msg.isSender) return 'me';
  const raw = String(msg.senderName || '').trim();
  const isID = /^@\S+:\S+$/.test(raw) || /^imsg##/.test(raw);
  if (raw && !handleLike(raw) && !isID) return raw;
  const p = participantsOf(chat || {}).find((x) => x.id === msg.senderID);
  if (p) {
    const n = personName(p, contacts);
    if (n && !/^@\S+:\S+$/.test(n) && !/^imsg##/.test(n)) return n;
  }
  return nameFor(contacts, raw) || (isID || !raw ? 'someone' : raw);
}

// Beeper returns drafts, and some messages, as HTML.
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
export function htmlToText(html) {
  const s = String(html || '');
  if (!/[<&]/.test(s)) return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|h[1-6])>\s*<(p|div|li|blockquote|h[1-6])[^>]*>/gi, '\n')
    // A block that opens after other content starts a new line, as in a shared post's caption and link.
    .replace(/<(p|div|li|blockquote|h[1-6])\b[^>]*>/gi, (m, tag, at) => (at === 0 ? '' : '\n'))
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}
export const draftText = (chat) => htmlToText(chat && chat.draft && chat.draft.text);
// What the compose box holds: 'attachments' when it holds any, else 'text', else null. Beeper
// keys a draft's attachments in an object, which can be empty.
export const draftKind = (chat) => (Object.keys((chat && chat.draft && chat.draft.attachments) || {}).length ? 'attachments' : draftText(chat) ? 'text' : null);

export function clip(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const ATTACHMENT_WORD = { img: 'photo', image: 'photo', video: 'video', audio: 'audio', voice: 'voice note', sticker: 'sticker', gif: 'gif' };
export function attachmentWord(a) {
  if (a && a.isSticker) return 'sticker';
  const k = String((a && a.type) || '').toLowerCase();
  return ATTACHMENT_WORD[k] || 'file';
}

const NOTICE = /\{\{\s*sender\s*\}\}|\bunsent a message\b|\b(joined|left) the (chat|group|conversation)\b|\b(named|renamed) the (chat|group|conversation)\b|\bmissed (a )?(voice |video )?call\b/i;
const BARE_LINK = /^https?:\/\/\S+$/i;

// A whole message that only acknowledges: "thanks!", "ok sounds good", "haha". Nothing is owed.
// "yes" and "no" are left out on purpose, since they usually answer a question and move a plan along.
const ACK_PHRASE = "(?:thanks?(?: you| u)?(?: so much| a lot| again)?|thx|ty(?:sm|vm)?|ok(?:ay)?|k+|sounds? (?:good|great|perfect)|sg|got it|gotcha|will do|perfect|great|awesome|cool|nice|sweet|love (?:it|this|that)|amazing|lol+|haha+(?:ha)*|hehe+|lmao+|no (?:problem|worries|prob)|np|you too|u too|see (?:you|ya|u)(?: then| soon| there| tomorrow| later)?|appreciate (?:it|you|that)|of course|for sure|congrats|congratulations)";
const ACK = new RegExp(`^${ACK_PHRASE}(?:[\\s,.!]+${ACK_PHRASE})*$`, 'i');
const stripDecoration = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, ' ').replace(/[!.,~*_:;()<>"'\u2019\u201c\u201d-]+/g, ' ').replace(/\s+/g, ' ').trim();
export function looksLikeAck(text) {
  const raw = htmlToText(text).trim();
  if (!raw || raw.length > 60 || raw.includes('?')) return false;
  const bare = stripDecoration(raw);
  if (!bare) return true; // emoji only
  return ACK.test(bare);
}

// What the latest item in a chat really is. Beeper's "last message" is often not a message.
export function previewKind(pv) {
  const text = htmlToText(pv && pv.text).trim();
  const type = String((pv && pv.type) || '').toUpperCase();
  if (type === 'REACTION' || looksLikeReaction(text)) return 'reaction';
  if ((pv && pv.isHidden) || (type && type !== 'TEXT') || NOTICE.test(text)) return 'notice';
  if (!text) return Array.isArray(pv && pv.attachments) && pv.attachments.length ? 'attachment' : 'empty';
  if (BARE_LINK.test(text)) return 'link';
  if (looksLikeAck(text)) return 'ack';
  return 'text';
}

// Links cost tokens and say little. Keep the site, drop the rest.
export function tidyLinks(text, { shorten = false } = {}) {
  let s = String(text || '').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => (/^https?:\/\//i.test(label.trim()) ? url : `${label} (${url})`));
  if (shorten) s = s.replace(/https?:\/\/(?:www\.)?([^\/\s?#]+)([^\s]*)/gi, (m, host, rest) => (rest && rest.length > 1 ? `${host}/…` : host));
  return s;
}

export function previewText(pv, who, max = 280) {
  const text = tidyLinks(htmlToText(pv && pv.text).trim().replace(/\{\{\s*sender\s*\}\}/g, who || 'They'), { shorten: true });
  if (text) return clip(text, max);
  const a = (pv && pv.attachments) || [];
  if (a.length) return `[${a.length > 1 ? `${a.length} attachments` : attachmentWord(a[0])}]`;
  return '';
}

export function toRow(chat, { now, contacts }) {
  const last = Date.parse(chat.lastActivity) || 0;
  const pv = chat.preview || {};
  const { name, resolved, handle } = chatName(chat, contacts);
  const group = isGroup(chat);
  const kind = previewKind(pv);
  const who = pv.isSender ? 'I' : group ? senderLabel(pv, chat, contacts) : name;
  return {
    ref: chatAlias(chat.id),
    id: chat.id,
    name,
    nameResolved: resolved,
    handle: resolved ? undefined : handle,
    network: chat.network || '',
    type: group ? 'group' : 'single',
    members: group ? participantTotal(chat) : undefined,
    state: isUnread(chat) ? 'unread' : 'read',
    unreadCount: chat.unreadCount || 0,
    markedUnread: chat.isMarkedUnread === true,
    mentions: chat.unreadMentionsCount || 0,
    pinned: chat.isPinned === true,
    lastActivity: chat.lastActivity || null,
    ageMs: Math.max(0, now - last),
    lastFrom: pv.isSender ? 'me' : 'them',
    lastSender: group ? senderLabel(pv, chat, contacts) : undefined,
    preview: previewText(pv, who),
    kind,
    reaction: kind === 'reaction',
    hasDraft: !!(chat.draft && (draftText(chat) || chat.draft.attachments)),
    draftKind: draftKind(chat),
    reminder: chat.reminder || null,
    account: chat.accountID || '',
    inContacts: !group && handlesOf(chat).some((h) => !!nameFor(contacts, h)),
    lastMessageID: pv.id || null,
    // When their newest message arrived, or null when the newest is the Owner's, a reaction, or
    // a notice. applyContext reads further back in one-to-one Chats.
    lastInboundAt: !pv.isSender && !pv.isHidden && !NOT_A_MESSAGE.has(kind) ? pv.timestamp || chat.lastActivity || null : null,
  };
}

const NOTHING_OWED = new Set(['reaction', 'notice', 'empty', 'ack']);
const NOT_A_MESSAGE = new Set(['reaction', 'notice', 'empty']);
const isReal = (m) => !m.isHidden && !NOT_A_MESSAGE.has(previewKind(m));

// A Conversation ends after 8 quiet hours, and a Burst with it (CONTEXT.md).
export const CONVERSATION_GAP_MS = 8 * 3_600_000;

// A Reaction, not a Message: Beeper's REACTION items, and tapbacks a network delivers as text.
// Who sent it, and the id of the Message it reacts to when Beeper names one (linkedMessageID;
// a tapback an SMS phone sends as text names none). Null for anything else.
export function reactionOf(m) {
  if (!m || previewKind(m) !== 'reaction') return null;
  return { fromOwner: m.isSender === true, to: m.linkedMessageID == null ? null : String(m.linkedMessageID) };
}

// Whether the Owner's Reaction stands on this Message: a Reaction of the Owner's that names it and
// was not taken back, or the Owner among the Reactions Beeper lists on it. Beeper names the Owner
// there by the participant ID the Owner's own items carry.
function ownerReacted(messages, target) {
  const id = String(target.id);
  if (messages.some((m) => { const r = !m.isDeleted && reactionOf(m); return Boolean(r && r.fromOwner && r.to === id); })) return true;
  const self = new Set(messages.filter((m) => m.isSender === true && m.senderID).map((m) => String(m.senderID)));
  return Array.isArray(target.reactions) && target.reactions.some((r) => r && (r.isSender === true || self.has(String(r.participantID))));
}

// A Message as CONTEXT.md has it, for which one a Reaction names: photos, videos, voice notes,
// files, and stickers count, though the rest of Triage reads only a bridged network's text.
const MEDIA = new Set(['IMAGE', 'VIDEO', 'VOICE', 'AUDIO', 'FILE', 'STICKER']);
const isMessage = (m) => !m.isHidden && !m.isDeleted && (isReal(m) || MEDIA.has(String(m.type || '').toUpperCase()));

const quietBetween = (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) >= CONVERSATION_GAP_MS;

// Who really spoke last, and their Burst: everything they said since the Owner's last message,
// back to 8 quiet hours. People send several short texts in a row, and the question is often
// not the last one. The Owner's Reaction to their newest Message answers it: the Owner is last,
// `reacted` says how, and `burst` is the Burst it answered. One on an earlier Message answers nothing.
export function trailingInbound(messages) {
  const real = messages.filter(isReal);
  const last = real[real.length - 1];
  if (!last) return { lastFrom: null, burst: [], more: false, reacted: false };
  if (last.isSender) return { lastFrom: 'me', burst: [], more: false, reacted: false };
  const burst = [last];
  let i = real.length - 2;
  for (; i >= 0 && !real[i].isSender && !quietBetween(real[i], burst[0]); i--) burst.unshift(real[i]);
  // When every message fetched is theirs, the Burst may reach further back.
  const newest = messages.filter(isMessage).at(-1);
  const reacted = !!newest && !newest.isSender && ownerReacted(messages, newest);
  return { lastFrom: reacted ? 'me' : 'them', burst, more: i < 0, reacted };
}

// When their newest real message arrived, even one the Owner has answered since, or null.
export function latestInboundAt(messages) {
  const inbound = messages.filter((m) => !m.isSender && isReal(m)).at(-1);
  return inbound && Date.parse(inbound.timestamp) ? inbound.timestamp : null;
}

// Rows worth a closer look: a short or odd preview, or several unread messages.
export const wantsContext = (r) => r.type === 'single' && (r.kind !== 'text' || r.preview.length < 40 || r.unreadCount >= 2);
// Every one-to-one row gets a look, to learn whether the Owner ever wrote there.
export const wantsHistory = (r) => r.type === 'single';

export function applyContext(row, messages, { now = Date.now(), shown = 4 } = {}) {
  const { lastFrom, burst, more, reacted } = trailingInbound(messages);
  // No message from the Owner anywhere in what was read: a stranger, or a one-sided chat.
  row.ownerSpoke = messages.some((m) => m.isSender && isReal(m));
  row.lastInboundAt = latestInboundAt(messages) || row.lastInboundAt;
  if (lastFrom === null) return row;
  row.lastFrom = lastFrom;
  // The Owner answered their newest Message with a Reaction, not words.
  if (reacted) row.ownerReacted = true;
  if (lastFrom === 'me') return row;
  const newest = burst[burst.length - 1];
  row.newestID = newest.id;
  row.newestHash = textHash(htmlToText(newest.text));
  // For ranking: the run's text, and the Owner's message before it, which says whether the
  // run answers the Owner rather than asks. Kept out of JSON output and snapshots.
  const real = messages.filter(isReal);
  const before = real[real.length - burst.length - 1];
  const hidden = (k, v) => Object.defineProperty(row, k, { value: v, enumerable: false, writable: true, configurable: true });
  hidden('texts', burst.slice(-6).map((m) => htmlToText(m.text)));
  if (burst.some(m => m.mediaContext)) hidden('mediaContext', burst.slice(-6).map(m => m.mediaContext || ''));
  hidden('ownerBefore', before && before.isSender ? { id: before.id, text: htmlToText(before.text) } : null);
  row.runIDs = burst.map((m) => m.id);
  // How long the Owner has left them, from the first message not yet answered.
  if (Date.parse(burst[0].timestamp)) row.waitingSince = burst[0].timestamp;
  // "can you send it? / thanks!" still asks for something. Only a run made of nothing but
  // acknowledgments counts as one.
  const kinds = burst.map(previewKind);
  const substantive = kinds.filter((k) => k !== 'ack');
  row.kind = substantive.length ? substantive[substantive.length - 1] : 'ack';
  row.reaction = false;
  const at = Date.parse(newest.timestamp);
  // Beeper's activity time also moves for reactions and unsends. Use the real message.
  if (at) { row.lastActivity = newest.timestamp; row.ageMs = Math.max(0, now - at); }
  if (!wantsContext(row) && row.kind !== 'ack') return row;
  row.messages = burst.length;
  row.messagesMore = more;
  const tail = burst.slice(-shown);
  row.preview = clip((burst.length > tail.length ? '… / ' : '') + tail.map((m) => previewText(m, row.name, 280)).filter(Boolean).join(' / '), 480);
  return row;
}

// Drops rows that left the list since they were read: outside the window, answered, or
// ending in nothing owed. Counts what it drops. A row that holds a Dropped item stays,
// whoever spoke last and however old its last message (ADR 0081).
export function filterTriage(t) {
  const s = t.stats;
  const keep = [];
  const windowMs = (t.windowDays || DEFAULT_WINDOW_DAYS) * DAY;
  for (const r of t.people) {
    // A held row stays. One the rules below would drop is there only for its Dropped item.
    if (r.held) {
      if (r.ageMs > windowMs || (r.state === 'read' && (r.lastFrom === 'me' || NOTHING_OWED.has(r.kind)))) r.heldOnly = true;
      keep.push(r);
      continue;
    }
    if (r.ageMs > windowMs) { if (r.state === 'unread') s.olderUnread++; else s.stale++; continue; }
    if (r.state === 'read' && r.lastFrom === 'me') { s.waitingOnThem++; continue; }
    if (r.state === 'read' && NOTHING_OWED.has(r.kind)) { s.nothingOwed++; continue; }
    keep.push(r);
  }
  t.people = keep;
  return t;
}

// Unread first, then newest. Ranking replaces this when it runs.
export function sortByState(t) {
  const newest = (a, b) => a.ageMs - b.ageMs;
  t.people.sort((a, b) => (a.state === b.state ? newest(a, b) : a.state === 'unread' ? -1 : 1));
  t.groups.sort((a, b) => (b.mentions - a.mentions) || newest(a, b));
  return t;
}

export function capTriage(t, { maxPeople = 100, maxGroups = 10 } = {}) {
  const s = t.stats;
  s.morePeople = Math.max(0, t.people.length - maxPeople);
  s.moreGroups = Math.max(0, t.groups.length - maxGroups);
  t.people = t.people.slice(0, maxPeople);
  t.groups = t.groups.slice(0, maxGroups);
  s.unresolvedNames = t.people.filter((r) => !r.nameResolved).length;
  return t;
}

export function finalizeTriage(t, opts = {}) {
  return capTriage(sortByState(filterTriage(t)), opts);
}

// A group read stays on the list when it Addressed the Owner and their Burst is last (ADR 0145): the
// Owner may have read it on another device and still owe the answer.
const addressedLast = (read) => Boolean(read && read.lastFrom === 'them' && read.addressed);

// The groups whose messages are read before the list is built: every one it could keep. An unread
// group, or one that holds a Dropped item, stays whatever its messages say. A read one stays only
// when it Addressed the Owner with their Burst last, which only its messages tell, so one whose
// newest item is the Owner's own Message isn't read. A Reaction or a notice of the Owner's, such as
// renaming the group, is no Message, so their question before it may still be unanswered. The same
// filters as buildTriage's, Dismissed included.
export function groupCandidates(chats, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, state = null, held = null } = {}) {
  const cutoff = now - windowDays * DAY;
  return chats.filter((c) => {
    if (!isGroup(c) || c.isArchived || c.isMuted || c.isLowPriority || isBotChat(c) || c.isReadOnly) return false;
    const h = held ? held.get(c.id) : undefined;
    if (!h && (Date.parse(c.lastActivity) || 0) < cutoff) return false;
    if (state && isDismissed(state, c)) return false;
    return isUnread(c) || Boolean(h) || !(c.preview && c.preview.isSender === true && isMessage(c.preview));
  });
}

// Whether a Dismiss still holds by the Chat's messages, oldest first: the item dismissed is among
// them and no Message came after it (CONTEXT.md, Dismissed, holds until a new message arrives). A
// Reaction or a notice after it, such as someone's tapback on the question dismissed, ends nothing.
// isDismissed reads only the preview, which such an item replaces.
export function dismissalHolds(state, chat, messages) {
  const d = state && state.dismissed && state.dismissed[chat.id];
  if (!d || d.messageID == null) return false;
  const at = messages.findIndex((m) => String(m && m.id) === String(d.messageID));
  return at >= 0 && !messages.slice(at + 1).some(isMessage);
}
// Whether a Chat's preview is a Message rather than a Reaction or a notice, for keeping a group's
// Dismiss past items that don't end it (state.mjs pruneDismissed).
export const isMessagePreview = (pv) => Boolean(pv) && isMessage(pv);

// held: Chats the caller says hold a Dropped item (ADR 0081), as a Map from Chat id to
// { kind, why, at }. Such a Chat stays whoever spoke last and however long ago, and the row
// carries it as `held`, kept out of JSON. What the Owner said about the Chat still counts:
// archived, muted, low priority, or Dismissed leaves it out. `ba triage` passes none.
// groupReads: what each group's own messages say (addressed.mjs groupRead), as a Map from Chat id,
// for the groups the caller read (groupCandidates). A read group stays only when one says it
// Addressed the Owner with their Burst last. A Dismissed group stays off until its next Message:
// dismissedGroups names the groups whose messages show their Dismiss still holds (dismissalHolds),
// though a Reaction or a notice since changed their preview.
export function buildTriage(chats, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, state = null, contacts = null, maxPeople = 100, maxGroups = 10, includeAutomated = false, finalize = true, held = null, groupReads = null, dismissedGroups = null } = {}) {
  const cutoff = now - windowDays * DAY;
  const stats = { scanned: chats.length, filtered: 0, olderUnread: 0, bots: 0, readOnly: 0, self: 0, automated: 0, dismissed: 0, waitingOnThem: 0, nothingOwed: 0, stale: 0, quietGroups: 0, morePeople: 0, moreGroups: 0, unresolvedNames: 0 };
  if (held && held.size) stats.held = 0;
  const self = selfHandles(chats);
  const names = selfNames(chats);
  const people = [];
  const groups = [];
  // heldOnly: the Chat is on the list only for its Dropped item, past a rule that would have
  // left it out. filterTriage may set it too, once the Chat's messages are read.
  const hold = (row, h, only) => {
    Object.defineProperty(row, 'held', { value: h, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(row, 'heldOnly', { value: only, enumerable: false, writable: true, configurable: true });
    stats.held++;
    return row;
  };
  for (const c of chats) {
    if (c.isArchived || c.isMuted || c.isLowPriority) { stats.filtered++; continue; }
    const unread = isUnread(c);
    const h = held ? held.get(c.id) : undefined;
    const old = (Date.parse(c.lastActivity) || 0) < cutoff;
    if (!h && old) { if (unread) stats.olderUnread++; continue; }
    if (isBotChat(c)) { stats.bots++; continue; }
    if (c.isReadOnly) { stats.readOnly++; continue; }
    if (isGroup(c)) {
      if ((state && isDismissed(state, c)) || (dismissedGroups && dismissedGroups.has(c.id))) { stats.dismissed++; continue; }
      const kept = unread || addressedLast(groupReads ? groupReads.get(c.id) : undefined);
      if (kept || h) groups.push(h ? hold(toRow(c, { now, contacts }), h, old || !kept) : toRow(c, { now, contacts })); else stats.quietGroups++;
      continue;
    }
    if (isSelfChat(c, self, names)) { stats.self++; continue; }
    const theirs = unread || lastIsTheirs(c) || ownerReactedLast(c);
    if (!h && !theirs) { stats.waitingOnThem++; continue; }
    const row = toRow(c, { now, contacts });
    // A model checked a held Chat's item, about someone the Owner has talked with: no guess about machines applies.
    if (!h && !includeAutomated && (isAutomated(c) || (!row.nameResolved && looksAutomatedText(c.preview && c.preview.text)))) { stats.automated++; continue; }
    if (state && isDismissed(state, c)) { stats.dismissed++; continue; }
    people.push(h ? hold(row, h, old || !theirs) : row);
  }
  const t = { windowDays, generatedAt: new Date(now).toISOString(), people, groups, stats };
  return finalize ? finalizeTriage(t, { maxPeople, maxGroups }) : t;
}
