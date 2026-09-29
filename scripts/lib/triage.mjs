// Builds the Triage list from raw chats. Pure functions, no I/O.
import { participantsOf, participantTotal } from './beeper.mjs';
import { looksLikeEmail, looksLikePhone, nameFor, normalizeEmail, normalizePhone } from './contacts.mjs';
import { chatAlias, isDismissed, textHash } from './state.mjs';

export const DEFAULT_WINDOW_DAYS = 14;
const DAY = 86_400_000;

export const isUnread = (c) => (c.unreadCount || 0) > 0 || c.isMarkedUnread === true;
export const lastIsTheirs = (c) => !!c.preview && c.preview.isSender === false;
export const isGroup = (c) => c.type !== 'single';
export const counterparties = (c) => participantsOf(c).filter((p) => p.isSelf !== true);

export function isBotChat(c) {
  const cp = counterparties(c);
  return cp.length > 0 && cp.every((p) => p.isNetworkBot === true);
}

// iMessage tapbacks and similar arrive as plain text.
const REACTION = /^(?:(?:\{\{\s*sender\s*\}\}|\S+)\s+)?(?:(?:loved|liked|disliked|laughed at|emphasi[sz]ed|questioned)\s+|(?:\S+\s+){0,3}?reacted\s+(?:\S+\s+){0,2}?to\s+)(["'\u201c\u2018]|&quot;|an? (image|attachment|photo|video|audio|sticker|message))/i;
export const looksLikeReaction = (text) => REACTION.test(String(text || '').trim());

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
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}
export const draftText = (chat) => htmlToText(chat && chat.draft && chat.draft.text);

export function clip(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const ATTACHMENT_WORD = { img: 'photo', image: 'photo', video: 'video', audio: 'audio', voice: 'voice note', sticker: 'sticker', gif: 'gif' };
function attachmentWord(a) {
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
    reminder: chat.reminder || null,
  };
}

const NOTHING_OWED = new Set(['reaction', 'notice', 'empty', 'ack']);
const NOT_A_MESSAGE = new Set(['reaction', 'notice', 'empty']);
const isReal = (m) => !m.isHidden && !NOT_A_MESSAGE.has(previewKind(m));

// Who really spoke last, and everything they said since the Owner's last message.
// People send several short texts in a row, and the question is often not the last one.
export function trailingInbound(messages) {
  const real = messages.filter(isReal);
  const last = real[real.length - 1];
  if (!last) return { lastFrom: null, burst: [], more: false };
  if (last.isSender) return { lastFrom: 'me', burst: [], more: false };
  const burst = [];
  for (let i = real.length - 1; i >= 0 && !real[i].isSender; i--) burst.unshift(real[i]);
  // When every message fetched is theirs, the run may reach further back.
  return { lastFrom: 'them', burst, more: burst.length === real.length };
}

// Rows worth a closer look: a short or odd preview, or several unread messages.
export const wantsContext = (r) => r.type === 'single' && (r.kind !== 'text' || r.preview.length < 40 || r.unreadCount >= 2);
// Every one-to-one row gets a look, to learn whether the Owner ever wrote there.
export const wantsHistory = (r) => r.type === 'single';

export function applyContext(row, messages, { now = Date.now(), shown = 4 } = {}) {
  const { lastFrom, burst, more } = trailingInbound(messages);
  // No message from the Owner anywhere in what was read: a stranger, or a one-sided chat.
  row.ownerSpoke = messages.some((m) => m.isSender && isReal(m));
  if (lastFrom === null) return row;
  row.lastFrom = lastFrom;
  if (lastFrom === 'me') return row;
  const newest = burst[burst.length - 1];
  row.newestID = newest.id;
  row.newestHash = textHash(htmlToText(newest.text));
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

export function finalizeTriage(t, { maxPeople = 100, maxGroups = 10 } = {}) {
  const s = t.stats;
  const keep = [];
  const windowMs = (t.windowDays || DEFAULT_WINDOW_DAYS) * DAY;
  for (const r of t.people) {
    if (r.ageMs > windowMs) { if (r.state === 'unread') s.olderUnread++; else s.stale++; continue; }
    if (r.state === 'read' && r.lastFrom === 'me') { s.waitingOnThem++; continue; }
    if (r.state === 'read' && NOTHING_OWED.has(r.kind)) { s.nothingOwed++; continue; }
    keep.push(r);
  }
  const newest = (a, b) => a.ageMs - b.ageMs;
  keep.sort((a, b) => (a.state === b.state ? newest(a, b) : a.state === 'unread' ? -1 : 1));
  t.groups.sort((a, b) => (b.mentions - a.mentions) || newest(a, b));
  s.morePeople = Math.max(0, keep.length - maxPeople);
  s.moreGroups = Math.max(0, t.groups.length - maxGroups);
  t.people = keep.slice(0, maxPeople);
  t.groups = t.groups.slice(0, maxGroups);
  s.unresolvedNames = t.people.filter((r) => !r.nameResolved).length;
  return t;
}

export function buildTriage(chats, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, state = null, contacts = null, maxPeople = 100, maxGroups = 10, includeAutomated = false, finalize = true } = {}) {
  const cutoff = now - windowDays * DAY;
  const stats = { scanned: chats.length, filtered: 0, olderUnread: 0, bots: 0, readOnly: 0, self: 0, automated: 0, dismissed: 0, waitingOnThem: 0, nothingOwed: 0, stale: 0, quietGroups: 0, morePeople: 0, moreGroups: 0, unresolvedNames: 0 };
  const self = selfHandles(chats);
  const names = selfNames(chats);
  const people = [];
  const groups = [];
  for (const c of chats) {
    if (c.isArchived || c.isMuted || c.isLowPriority) { stats.filtered++; continue; }
    const unread = isUnread(c);
    if ((Date.parse(c.lastActivity) || 0) < cutoff) { if (unread) stats.olderUnread++; continue; }
    if (isBotChat(c)) { stats.bots++; continue; }
    if (c.isReadOnly) { stats.readOnly++; continue; }
    if (isGroup(c)) {
      if (unread) groups.push(toRow(c, { now, contacts })); else stats.quietGroups++;
      continue;
    }
    if (isSelfChat(c, self, names)) { stats.self++; continue; }
    if (!unread && !lastIsTheirs(c)) { stats.waitingOnThem++; continue; }
    const row = toRow(c, { now, contacts });
    if (!includeAutomated && (isAutomated(c) || (!row.nameResolved && looksAutomatedText(c.preview && c.preview.text)))) { stats.automated++; continue; }
    if (state && isDismissed(state, c)) { stats.dismissed++; continue; }
    people.push(row);
  }
  const t = { windowDays, generatedAt: new Date(now).toISOString(), people, groups, stats };
  return finalize ? finalizeTriage(t, { maxPeople, maxGroups }) : t;
}
