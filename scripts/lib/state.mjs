// Local state: dismissed chats and the alias cache. One small JSON file.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

export function stateDir() {
  return process.env.BEEPER_ASSISTANT_HOME || join(homedir(), '.config', 'beeper-assistant');
}

const file = () => join(stateDir(), 'state.json');
const EMPTY = () => ({ version: 1, dismissed: {}, aliases: {}, drafted: {} });

// Several processes write this file: `ba` in each agent, and the companion. Each one loaded its
// own copy earlier, so a plain overwrite would drop what another wrote in between, such as a
// dismissal. Saving therefore takes a lock, reads the file again, and applies only the entries
// this process changed since it loaded.
const MAPS = ['dismissed', 'aliases', 'drafted'];
const BASE = Symbol('loaded');
const clone = (s) => Object.fromEntries(MAPS.map((m) => [m, JSON.parse(JSON.stringify(s[m] || {}))]));

function readState() {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8'));
    const aliases = {};
    for (const [k, v] of Object.entries(s.aliases || {})) if (v && v.id) aliases[k] = v.chat ? { id: v.id, chat: v.chat } : { id: v.id };
    return { ...EMPTY(), ...s, dismissed: s.dismissed || {}, aliases, drafted: s.drafted || {} };
  } catch {
    return EMPTY();
  }
}

export function loadState() {
  const s = readState();
  s[BASE] = clone(s);
  return s;
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A directory is created atomically or not at all, so it serves as the lock. A lock older than
// ten seconds belonged to a process that died. After three seconds of waiting, write anyway:
// the merge below still keeps what the other writer saved.
function withLock(action) {
  const lock = join(stateDir(), 'state.lock');
  const until = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try { mkdirSync(lock); held = true; } catch (e) {
      if (e.code !== 'EEXIST') break;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > until) break;
      pause(20);
    }
  }
  try { return action(); } finally { if (held) rmSync(lock, { recursive: true, force: true }); }
}

export function saveState(state) {
  mkdirSync(stateDir(), { recursive: true });
  withLock(() => {
    const disk = readState();
    const base = state[BASE] || clone(EMPTY());
    for (const m of MAPS) {
      const mine = state[m] || {};
      for (const [k, v] of Object.entries(mine)) {
        if (JSON.stringify(v) === JSON.stringify(base[m][k])) continue;
        delete disk[m][k]; // re-adding moves an alias to the newest end
        disk[m][k] = v;
      }
      for (const k of Object.keys(base[m])) if (!(k in mine)) delete disk[m][k];
    }
    trimAliases(disk);
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(disk, null, 1));
    renameSync(tmp, file());
    // Carry on from what is now on disk.
    for (const m of MAPS) state[m] = disk[m];
    state[BASE] = clone(disk);
  });
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
function remember(state, alias, entry) {
  delete state.aliases[alias];
  state.aliases[alias] = entry;
}
function trimAliases(state) {
  const keys = Object.keys(state.aliases);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ALIASES))) delete state.aliases[k];
  return state;
}

export function rememberChats(state, chats) {
  for (const c of chats) if (c && c.id) remember(state, chatAlias(c.id), { id: c.id });
  return trimAliases(state);
}

// Messages found by search can be older than any chat view reaches, so their references are kept.
// Each one is tied to its chat, and only resolves inside that chat.
export function rememberMessages(state, messages) {
  for (const m of messages) if (m && m.id && m.chatID) remember(state, messageAlias(m.id), { id: m.id, chat: m.chatID });
  return trimAliases(state);
}

export function savedMessage(state, chatID, ref) {
  const e = state.aliases[ref];
  return e && e.chat === chatID ? e.id : null;
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

// keep: a Chat whose Dismiss may still hold though its preview changed, such as a group whose preview
// is now a Reaction or a notice (triage.mjs dismissalHolds decides once its messages are read).
export function pruneDismissed(state, chats, keep = () => false) {
  const byID = new Map(chats.map((c) => [c.id, c]));
  let removed = 0;
  for (const id of Object.keys(state.dismissed)) {
    const c = byID.get(id);
    if (c && !isDismissed(state, c) && !keep(c)) { delete state.dismissed[id]; removed++; }
  }
  return removed;
}

// ---- the Line's own Chat ----
// The Companion writes line-chat.json, { "chatKey": sha256 of the Chat ID in hex }, for the Chat
// in Beeper between the Owner and their Line. A message written there would reach the Companion
// as the Owner's own text, so no command writes into it. A missing or unreadable file names no
// Chat, and then nothing is refused.
export const lineChatKey = (chatID) => createHash('sha256').update(String(chatID)).digest('hex');
export function isLineChat(chatID, dir = stateDir()) {
  let key;
  try { key = JSON.parse(readFileSync(join(dir, 'line-chat.json'), 'utf8')).chatKey; } catch { return false; }
  return typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) && key === lineChatKey(chatID);
}

// ---- drafts this skill saved ----
// Each record, under its chat id, holds a hash of the draft and when it was saved. Never names or
// message text.

export const textHash = (s) => createHash('sha1').update(String(s || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

export function recordDraft(state, chatID, { forMessage = null, text, now = Date.now() }) {
  state.drafted[chatID] = { forMessage, textHash: textHash(text), at: new Date(now).toISOString() };
  return state;
}

// ---- attachment copies ----
// Beeper's own copies have no file extension, and many readers need one to open a picture.
// Copies live in the state folder and are deleted after two days.
const mediaDir = () => join(stateDir(), 'media');
const MEDIA_KEEP_MS = 48 * 3_600_000;
const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heic',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/aac': 'aac',
};

export function extensionFor(att) {
  const fromName = extname(String((att && att.fileName) || '')).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  return EXT[String((att && att.mimeType) || '').toLowerCase()] || 'bin';
}

export function pruneMedia({ now = Date.now() } = {}) {
  let names = [];
  try { names = readdirSync(mediaDir()); } catch { return; }
  for (const n of names) {
    const f = join(mediaDir(), n);
    try { if (now - statSync(f).mtimeMs > MEDIA_KEEP_MS) unlinkSync(f); } catch { /* already gone */ }
  }
}

// Returns the copy's path. HEIC photos become JPEG, since few readers open HEIC.
export function copyMedia(src, att, name) {
  mkdirSync(mediaDir(), { recursive: true, mode: 0o700 });
  const ext = extensionFor(att);
  if (ext === 'heic' && process.platform === 'darwin') {
    const out = join(mediaDir(), `${name}.jpg`);
    try {
      execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', src, '--out', out], { stdio: 'ignore', timeout: 30_000 });
      chmodSync(out, 0o600);
      return out;
    } catch { /* fall back to a plain copy */ }
  }
  const out = join(mediaDir(), `${name}.${ext}`);
  copyFileSync(src, out);
  chmodSync(out, 0o600);
  return out;
}
