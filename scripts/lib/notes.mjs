// Notes: things worth remembering about a Chat, saved by the Owner or by an agent.
// One JSON file per Chat in the state folder, named by the full SHA-256 of the Chat ID,
// the same key the companion's Store uses. Every change runs under a per-Chat lock that
// covers the read, the checks, and the write, so two writers never lose each other's Notes.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDir } from './state.mjs';

export class NotesError extends Error {}

export const NOTE_LIMITS = Object.freeze({ maxNotes: 30, maxChars: 500, agentAdds: 3, agentWindowMs: 30 * 60_000, maxTombstones: 500 });
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;
const VERSION = 1;

export const notesKey = (chatID) => createHash('sha256').update(String(chatID)).digest('hex');
const notesDir = (dir) => join(dir || stateDir(), 'notes');
export const notesFile = (chatID, { dir } = {}) => join(notesDir(dir), `${notesKey(chatID)}.json`);

// Lowercase, no punctuation, single spaces. Two Notes that differ only in those are the same Note.
export const normalizeNoteText = (text) => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, '').replace(/\s+/g, ' ').trim();
const textHash = (text) => createHash('sha256').update(normalizeNoteText(text)).digest('hex');
const sourceIDs = (note) => (note && note.source && Array.isArray(note.source.messages) ? note.source.messages.map((m) => String(m.id)).sort() : []);
const sameSet = (a, b) => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

const EMPTY = () => ({ version: VERSION, notes: [], tombstones: [], ledger: [] });

function checkDoc(doc, file) {
  const ok = doc && typeof doc === 'object' && doc.version === VERSION && Array.isArray(doc.notes) && Array.isArray(doc.tombstones) && Array.isArray(doc.ledger)
    && doc.notes.every((n) => n && typeof n.id === 'string' && typeof n.text === 'string' && (n.kind === 'owner' || n.kind === 'agent'));
  if (!ok) throw new NotesError(`The Notes file for this chat is damaged or from another version, at ${file}. Nothing was changed. Move the file aside to start this chat's Notes over.`);
  return doc;
}

async function readDoc(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return EMPTY();
    throw e;
  }
  let doc;
  try { doc = JSON.parse(raw); } catch { doc = null; }
  return checkDoc(doc, file);
}

// ---- the lock ----
// A directory next to the file. mkdir either creates it or fails, so only one writer holds it.
// Inside sits the holder's pid, time, and a token. A lock older than 10 seconds, or held by a
// process that is gone, is stale and gets broken.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function lockInfo(lockDir) {
  try { return JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')); } catch { return null; }
}

async function isStale(lockDir, info, now) {
  if (info && Number.isInteger(info.pid) && !alive(info.pid)) return true;
  const at = info && Date.parse(info.at);
  if (Number.isFinite(at)) return now - at > LOCK_STALE_MS;
  // No owner file yet: the holder may be between mkdir and writing it, so go by the folder's age.
  try { return now - (await stat(lockDir)).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}

// Moves the stale lock aside first, so two waiters can't both break it and then each take it.
async function breakLock(lockDir, seen) {
  const aside = `${lockDir}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try { await rename(lockDir, aside); } catch { return; }
  const moved = await lockInfo(aside);
  if ((moved && moved.token) !== (seen && seen.token)) {
    // Someone took the lock between the check and the move. Give it back if nothing replaced it.
    try { await rename(aside, lockDir); return; } catch { /* the holder finds out before it writes */ }
  }
  await rm(aside, { recursive: true, force: true });
}

async function acquire(file, { waitMs = LOCK_WAIT_MS } = {}) {
  const lockDir = `${file}.lock`;
  const token = randomBytes(8).toString('hex');
  const started = Date.now();
  let delay = 10;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }), { mode: 0o600 });
      return { lockDir, token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const seen = await lockInfo(lockDir);
    if (await isStale(lockDir, seen, Date.now())) { await breakLock(lockDir, seen); continue; }
    if (Date.now() - started > waitMs) throw new NotesError('Another writer is holding this chat\'s Notes. Nothing was changed. Try again in a few seconds.');
    await sleep(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, 200);
  }
}

async function held(lock) {
  const info = await lockInfo(lock.lockDir);
  return !!info && info.token === lock.token;
}

async function release(lock) {
  if (await held(lock)) await rm(lock.lockDir, { recursive: true, force: true });
}

async function writeDoc(file, doc, lock) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 1), { mode: 0o600 });
  // A writer whose lock was broken must not overwrite whoever holds it now.
  if (!(await held(lock))) {
    await rm(tmp, { force: true });
    throw new NotesError('Lost the lock on this chat\'s Notes while writing. Nothing was changed. Try again.');
  }
  await rename(tmp, file);
}

// Runs fn(doc, save) under the Chat's lock. save(doc) writes it back.
export async function withLock(chatID, fn, { dir, waitMs } = {}) {
  const file = notesFile(chatID, { dir });
  const lock = await acquire(file, { waitMs });
  try {
    const doc = await readDoc(file);
    return await fn(doc, (next) => writeDoc(file, next, lock));
  } finally {
    await release(lock);
  }
}

// ---- reading ----

export async function readNotes(chatID, { dir } = {}) {
  return readDoc(notesFile(chatID, { dir }));
}

export async function listNotes(chatID, opts = {}) {
  return (await readNotes(chatID, opts)).notes;
}

// ---- writing ----

function cleanNote({ text, kind, author, source, runID }) {
  const t = String(text ?? '').trim();
  if (!t || t.length > NOTE_LIMITS.maxChars) throw new NotesError(`A Note holds 1 to ${NOTE_LIMITS.maxChars} characters. This one has ${t.length}.`);
  if (kind !== 'owner' && kind !== 'agent') throw new NotesError('A Note is either the Owner\'s or an agent\'s.');
  const who = String(author ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  if (!who) throw new NotesError('A Note needs an author.');
  let src;
  if (kind === 'owner') {
    if (!source || source.owner !== true) throw new NotesError('An Owner Note comes from the Owner\'s own words.');
    src = { owner: true };
  } else {
    const msgs = source && Array.isArray(source.messages) ? source.messages : null;
    if (!msgs) throw new NotesError('An agent Note lists the messages it came from, even if there are none.');
    const seen = new Map();
    for (const m of msgs) if (m && m.id != null && !seen.has(String(m.id))) seen.set(String(m.id), { id: String(m.id), at: m.at ? String(m.at) : null });
    src = { messages: [...seen.values()].slice(0, 20) };
  }
  const note = { text: t, kind, author: who, source: src };
  if (runID != null && String(runID)) note.runID = String(runID).slice(0, 100);
  return note;
}

function newID(notes) {
  const taken = new Set(notes.map((n) => n.id));
  for (;;) { const id = `n${randomBytes(4).toString('hex')}`; if (!taken.has(id)) return id; }
}

// Returns { status, note? }. status is added, duplicate, tombstoned, rate-limited, full, or stale.
// shouldCommit runs inside the lock just before the write. False means the caller no longer
// owns this work, such as a Brief for a Chat the Owner already left, and nothing is written.
/** @param {{ now?: number, shouldCommit?: () => boolean | Promise<boolean>, dir?: string, waitMs?: number }} [options] */
export async function addNote(chatID, input, options = {}) {
  const { now = Date.now(), shouldCommit, dir, waitMs } = options;
  const clean = cleanNote(input);
  return withLock(chatID, async (doc, save) => {
    const norm = normalizeNoteText(clean.text);
    const same = doc.notes.find((n) => normalizeNoteText(n.text) === norm);
    if (same) return { status: 'duplicate', note: same };

    const agent = clean.kind === 'agent';
    if (agent) {
      const hash = textHash(clean.text);
      const ids = sourceIDs(clean);
      if (doc.tombstones.some((t) => t.textHash === hash || sameSet(ids, [...(t.sources || [])].map(String).sort()))) return { status: 'tombstoned' };
    }

    const ledger = doc.ledger.filter((at) => now - Date.parse(at) < NOTE_LIMITS.agentWindowMs);
    if (agent && ledger.length >= NOTE_LIMITS.agentAdds) return { status: 'rate-limited' };

    const notes = [...doc.notes];
    if (notes.length >= NOTE_LIMITS.maxNotes) {
      const oldestAgent = notes.filter((n) => n.kind === 'agent').sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
      if (!oldestAgent) return { status: 'full' };
      notes.splice(notes.indexOf(oldestAgent), 1);
    }

    if (shouldCommit && !(await shouldCommit())) return { status: 'stale' };

    const at = new Date(now).toISOString();
    const note = { id: newID(doc.notes), ...clean, at };
    notes.push(note);
    if (agent) ledger.push(at);
    await save({ ...doc, notes, ledger });
    return { status: 'added', note };
  }, { dir, waitMs });
}

// Removes a Note and leaves a tombstone, so no automatic writer saves the same text or
// a Note from the same messages again.
export async function deleteNote(chatID, id, { now = Date.now(), dir, waitMs } = {}) {
  return withLock(chatID, async (doc, save) => {
    const note = doc.notes.find((n) => n.id === id);
    if (!note) return { status: 'missing' };
    const tombstone = { textHash: textHash(note.text), sources: sourceIDs(note), at: new Date(now).toISOString() };
    await save({ ...doc, notes: doc.notes.filter((n) => n !== note), tombstones: [...doc.tombstones, tombstone].slice(-NOTE_LIMITS.maxTombstones) });
    return { status: 'deleted', note };
  }, { dir, waitMs });
}
