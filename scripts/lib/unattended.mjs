// Decisions for runs with no person in the turn. Pure functions, no I/O.
import { normalizeEmail, normalizePhone } from './contacts.mjs';
import { textHash, wasDraftedFor, wasSkippedFor } from './state.mjs';
import { counterparties, htmlToText, isGroup } from './triage.mjs';

const hashOf = (m) => textHash(htmlToText(m && m.text));

const HOUR = 3_600_000;
const ANSWERABLE = new Set(['text', 'link', 'attachment']);

// Which chats an unattended run may draft for, and why the rest were left out.
export function selectPending(rows, { state, max = 5 } = {}) {
  const counts = { strangers: 0, holdingDraft: 0, alreadyDrafted: 0, skippedEarlier: 0, ownerSpokeLast: 0, nothingToAnswer: 0 };
  const ok = [];
  for (const r of rows) {
    if (r.type !== 'single') continue;
    if (r.ownerSpoke !== true) { counts.strangers++; continue; }
    if (r.lastFrom !== 'them' || !r.newestID) { counts.ownerSpokeLast++; continue; }
    if (!ANSWERABLE.has(r.kind)) { counts.nothingToAnswer++; continue; }
    if (r.hasDraft) { counts.holdingDraft++; continue; }
    if (state && wasDraftedFor(state, r.id, r.newestID)) { counts.alreadyDrafted++; continue; }
    if (state && wasSkippedFor(state, r.id, r.newestID)) { counts.skippedEarlier++; continue; }
    ok.push(r);
  }
  const fresh = (r) => r.ageMs < 48 * HOUR;
  ok.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (fresh(a) !== fresh(b)) return fresh(a) ? -1 : 1;
    return fresh(a) ? a.ageMs - b.ageMs : b.ageMs - a.ageMs;
  });
  return { batch: ok.slice(0, max), waiting: ok.length, counts };
}

// What to do with a draft this skill saved earlier.
//   clear  - the conversation moved on, and the draft is still exactly ours
//   forget - the Owner sent it, removed it, or edited it, so it is theirs now
//   keep   - still waiting for the Owner
export function tidyDecision({ record, draftNow, newestReal }) {
  if (!draftNow) return 'forget';
  if (textHash(draftNow) !== record.textHash) return 'forget';
  if (!newestReal) return 'keep';
  if (newestReal.isSender) return 'clear';
  if (record.forMessage && newestReal.id !== record.forMessage) return 'clear';
  return 'keep';
}

// Chat ids differ between machines. A person's number or email does not.
export function handleKeys(chat) {
  const keys = [];
  for (const p of counterparties(chat)) {
    if (p.phoneNumber && !String(p.phoneNumber).includes('*')) keys.push(`p:${normalizePhone(p.phoneNumber)}`);
    if (p.email) keys.push(`e:${normalizeEmail(p.email)}`);
  }
  return [...new Set(keys)].sort();
}

export function outboxEntry(chat, { text, newest, name = '', now = Date.now() }) {
  const keys = handleKeys(chat);
  const chatKey = `${chat.network}|${keys.join(',')}`;
  return {
    id: textHash(`${chatKey}|${newest ? newest.id : ''}|${text}`),
    chatKey,
    network: chat.network,
    handles: keys,
    name,
    text,
    forHash: newest ? hashOf(newest) : null,
    forAt: newest ? newest.timestamp : null,
    createdAt: new Date(now).toISOString(),
  };
}

// The one local one-to-one chat an outbox entry is meant for, or the reason there is none.
export function matchChat(entry, chats) {
  if (!entry || !Array.isArray(entry.handles) || !entry.handles.length) return { chat: null, why: 'the entry names no number or email' };
  const want = new Set(entry.handles);
  const hits = chats.filter((c) => !isGroup(c) && c.network === entry.network && handleKeys(c).some((k) => want.has(k)));
  if (hits.length === 1) return { chat: hits[0], why: '' };
  return { chat: null, why: hits.length ? `${hits.length} chats match` : 'no chat with that person here' };
}

// Whether a queued draft still answers the latest message in the local chat.
export function stillCurrent(entry, newestReal) {
  if (!newestReal) return { ok: false, why: 'the chat has no messages here' };
  if (newestReal.isSender) return { ok: false, why: 'the Owner already replied' };
  if (entry.forHash && hashOf(newestReal) !== entry.forHash) return { ok: false, why: 'they wrote again after the draft was made' };
  return { ok: true, why: '' };
}
