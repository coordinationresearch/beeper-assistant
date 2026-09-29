// Local state: dismissed chats and the alias cache. One small JSON file.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function stateDir() {
  return process.env.BEEPER_ASSISTANT_HOME || join(homedir(), '.config', 'beeper-assistant');
}

const file = () => join(stateDir(), 'state.json');
const EMPTY = () => ({ version: 1, dismissed: {}, aliases: {}, drafted: {}, skipped: {}, placed: {} });

export function loadState() {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8'));
    const aliases = {};
    for (const [k, v] of Object.entries(s.aliases || {})) if (v && v.id) aliases[k] = { id: v.id };
    return { ...EMPTY(), ...s, dismissed: s.dismissed || {}, aliases, drafted: s.drafted || {}, skipped: s.skipped || {}, placed: s.placed || {} };
  } catch {
    return EMPTY();
  }
}

export function saveState(state) {
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, file());
}

// An alias is derived from the ID, so it can be missing from the cache but never wrong.
export function aliasFor(prefix, id) {
  return prefix + createHash('sha1').update(String(id)).digest('hex').slice(0, 8);
}
export const chatAlias = (id) => aliasFor('c', id);
export const messageAlias = (id) => aliasFor('m', id);

export const isChatAlias = (s) => /^c[0-9a-f]{8}$/.test(s);
export const isMessageAlias = (s) => /^m[0-9a-f]{8}$/.test(s);

// Only ids are stored. Names and titles stay in Beeper.
const MAX_ALIASES = 5000;
export function rememberChats(state, chats) {
  for (const c of chats) {
    if (!c || !c.id) continue;
    const a = chatAlias(c.id);
    delete state.aliases[a];
    state.aliases[a] = { id: c.id };
  }
  const keys = Object.keys(state.aliases);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ALIASES))) delete state.aliases[k];
  return state;
}

export function dismiss(state, chat, now = Date.now()) {
  state.dismissed[chat.id] = {
    messageID: (chat.preview && chat.preview.id) || null,
    sortKey: (chat.preview && chat.preview.sortKey) || null,
    at: new Date(now).toISOString(),
  };
  return state;
}

export function undismiss(state, chatID) {
  delete state.dismissed[chatID];
  return state;
}

// A dismissal holds only while the chat's latest message is the one that was dismissed.
export function isDismissed(state, chat) {
  const d = state.dismissed[chat.id];
  if (!d) return false;
  const current = (chat.preview && chat.preview.id) || null;
  return d.messageID !== null && d.messageID === current;
}

export function pruneDismissed(state, chats) {
  const byID = new Map(chats.map((c) => [c.id, c]));
  let removed = 0;
  for (const id of Object.keys(state.dismissed)) {
    const c = byID.get(id);
    if (c && !isDismissed(state, c)) { delete state.dismissed[id]; removed++; }
  }
  return removed;
}

// ---- unattended runs ----
// Records hold chat ids, message ids, and hashes. Never names or message text.

export const textHash = (s) => createHash('sha1').update(String(s || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

export function recordDraft(state, chatID, { forMessage = null, text, now = Date.now() }) {
  state.drafted[chatID] = { forMessage, textHash: textHash(text), at: new Date(now).toISOString() };
  delete state.skipped[chatID];
  return state;
}

export function recordSkip(state, chatID, { forMessage, reason = '', now = Date.now() }) {
  state.skipped[chatID] = { forMessage, reason: String(reason).slice(0, 80), at: new Date(now).toISOString() };
  return state;
}

export const wasDraftedFor = (state, chatID, messageID) => !!messageID && !!state.drafted[chatID] && state.drafted[chatID].forMessage === messageID;
export const wasSkippedFor = (state, chatID, messageID) => !!messageID && !!state.skipped[chatID] && state.skipped[chatID].forMessage === messageID;

// The outbox carries drafts to another machine, for chats whose drafts do not sync.
// It does hold the draft text, so it is kept short-lived.
const outboxFile = () => join(stateDir(), 'outbox.jsonl');
const OUTBOX_KEEP_MS = 48 * 3_600_000;

export function readOutbox({ now = Date.now() } = {}) {
  let raw = '';
  try { raw = readFileSync(outboxFile(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && e.id && now - Date.parse(e.createdAt) < OUTBOX_KEEP_MS) out.push(e); } catch { /* skip a bad line */ }
  }
  return out;
}

export function appendOutbox(entry, { now = Date.now() } = {}) {
  mkdirSync(stateDir(), { recursive: true });
  // Rewrite without expired entries, and replace an older entry for the same chat.
  const kept = readOutbox({ now }).filter((e) => e.id !== entry.id && e.chatKey !== entry.chatKey);
  kept.push(entry);
  const tmp = `${outboxFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  renameSync(tmp, outboxFile());
}

export function dropFromOutbox(chatKey, { now = Date.now() } = {}) {
  const kept = readOutbox({ now }).filter((e) => e.chatKey !== chatKey);
  try { writeFileSync(outboxFile(), kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 }); } catch { /* nothing to drop */ }
}
