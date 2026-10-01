// Notes in the state folder. Every test uses a throwaway folder and made-up chats.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NotesError, addNote, deleteNote, listNotes, normalizeNoteText, notesFile, notesKey, readNotes } from '../scripts/lib/notes.mjs';

const home = mkdtempSync(join(tmpdir(), 'ba-notes-'));
const opts = { dir: home };
const T0 = Date.parse('2026-09-30T12:00:00Z');
const MIN = 60_000;
let n = 0;
const freshChat = () => `!chat-${++n}:beeper.local`;
const agent = (text, ids = [], extra = {}) => ({ text, kind: 'agent', author: 'test-agent', source: { messages: ids.map((id) => ({ id, at: null })) }, ...extra });
const owner = (text) => ({ text, kind: 'owner', author: 'owner', source: { owner: true } });

test('the file key is the full SHA-256 of the chat ID, as in the companion', () => {
  assert.equal(notesKey('!abc:beeper.local'), createHash('sha256').update('!abc:beeper.local').digest('hex'));
  assert.equal(notesFile('!abc:beeper.local', opts), join(home, 'notes', `${notesKey('!abc:beeper.local')}.json`));
});

test('a Note is saved with its author, source, and time, and listed back', async () => {
  const chat = freshChat();
  assert.deepEqual(await listNotes(chat, opts), [], 'a chat with no file has no Notes');
  const r = await addNote(chat, agent('  Moving to Lisbon in March  ', ['m1', 'm2'], { runID: 'run-1' }), { ...opts, now: T0 });
  assert.equal(r.status, 'added');
  assert.match(r.note.id, /^n[0-9a-f]{8}$/);
  assert.deepEqual(await listNotes(chat, opts), [{ id: r.note.id, text: 'Moving to Lisbon in March', kind: 'agent', author: 'test-agent', source: { messages: [{ id: 'm1', at: null }, { id: 'm2', at: null }] }, runID: 'run-1', at: new Date(T0).toISOString() }]);
  const file = notesFile(chat, opts);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  assert.equal(existsSync(`${file}.lock`), false, 'the lock is released');
});

test('bad input is refused before anything is written', async () => {
  const chat = freshChat();
  await assert.rejects(addNote(chat, agent(''), opts), NotesError);
  await assert.rejects(addNote(chat, agent('x'.repeat(501)), opts), /1 to 500 characters/);
  await assert.rejects(addNote(chat, { ...agent('hi'), kind: 'system' }, opts), NotesError);
  await assert.rejects(addNote(chat, { ...owner('hi'), source: { messages: [] } }, opts), NotesError, 'an Owner Note needs the Owner as its source');
  await assert.rejects(addNote(chat, { ...agent('hi'), author: '  ' }, opts), NotesError);
  assert.equal(existsSync(notesFile(chat, opts)), false);
});

test('the same text, ignoring case, spaces, and punctuation, is a duplicate', async () => {
  const chat = freshChat();
  const first = await addNote(chat, owner('Allergic to peanuts.'), { ...opts, now: T0 });
  const again = await addNote(chat, agent('allergic   to PEANUTS'), { ...opts, now: T0 + MIN });
  assert.equal(again.status, 'duplicate');
  assert.equal(again.note.id, first.note.id);
  assert.equal(normalizeNoteText(' Hello,  World! '), 'hello world');
  assert.equal((await listNotes(chat, opts)).length, 1);
});

test('a deleted Note leaves a tombstone that refuses the same text or the same messages from agents', async () => {
  const chat = freshChat();
  const a = await addNote(chat, agent('Prefers calls to texts', ['m7', 'm8']), { ...opts, now: T0 });
  assert.deepEqual(await deleteNote(chat, a.note.id, { ...opts, now: T0 + MIN }), { status: 'deleted', note: a.note });
  assert.deepEqual(await deleteNote(chat, a.note.id, opts), { status: 'missing' });
  assert.equal((await addNote(chat, agent('prefers calls to texts!', ['m1']), { ...opts, now: T0 + 2 * MIN })).status, 'tombstoned');
  assert.equal((await addNote(chat, agent('A different claim', ['m8', 'm7']), { ...opts, now: T0 + 2 * MIN })).status, 'tombstoned');
  assert.equal((await addNote(chat, agent('A different claim', ['m7']), { ...opts, now: T0 + 2 * MIN })).status, 'added', 'a different set of messages is fine');
  assert.equal((await addNote(chat, owner('Prefers calls to texts'), { ...opts, now: T0 + 3 * MIN })).status, 'added', 'the Owner can always say it again');
  const doc = await readNotes(chat, opts);
  assert.equal(doc.tombstones.length, 1);
  assert.equal(JSON.stringify(doc.tombstones).includes('calls'), false, 'a tombstone keeps a hash, not the text');
});

test('agent Notes with no sources are not tombstoned by an empty source set', async () => {
  const chat = freshChat();
  const a = await addNote(chat, agent('First claim'), { ...opts, now: T0 });
  await deleteNote(chat, a.note.id, opts);
  assert.equal((await addNote(chat, agent('Second claim'), { ...opts, now: T0 + MIN })).status, 'added');
});

test('agents together add at most 3 Notes in 30 minutes, and deleting does not reset the count', async () => {
  const chat = freshChat();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await addNote(chat, { ...agent(`claim ${i}`), author: `agent-${i}` }, { ...opts, now: T0 + i * MIN });
    assert.equal(r.status, 'added');
    ids.push(r.note.id);
  }
  assert.equal((await addNote(chat, { ...agent('claim 3'), author: 'someone-new' }, { ...opts, now: T0 + 5 * MIN })).status, 'rate-limited', 'a new name gets no new bucket');
  for (const id of ids) await deleteNote(chat, id, opts);
  assert.equal((await addNote(chat, agent('claim 4'), { ...opts, now: T0 + 6 * MIN })).status, 'rate-limited', 'deleting does not reset it');
  assert.equal((await addNote(chat, owner('the Owner is never limited'), { ...opts, now: T0 + 6 * MIN })).status, 'added');
  assert.equal((await addNote(chat, agent('claim 5'), { ...opts, now: T0 + 30 * MIN })).status, 'added', 'the first entry has aged out');
  assert.equal((await readNotes(chat, opts)).ledger.length, 3, 'old entries are pruned');
});

test('at 30 Notes the oldest agent Note gives way, and Owner Notes stay', async () => {
  const chat = freshChat();
  let t = T0;
  // Spread agent adds so the rate limit never bites here.
  for (let i = 0; i < 27; i++) await addNote(chat, owner(`owner ${i}`), { ...opts, now: (t += MIN) });
  for (let i = 0; i < 3; i++) await addNote(chat, agent(`agent ${i}`), { ...opts, now: (t += 31 * MIN) });
  assert.equal((await listNotes(chat, opts)).length, 30);
  assert.equal((await addNote(chat, agent('agent 3'), { ...opts, now: (t += 31 * MIN) })).status, 'added');
  let texts = (await listNotes(chat, opts)).map((x) => x.text);
  assert.equal(texts.length, 30);
  assert.equal(texts.includes('agent 0'), false, 'the oldest agent Note went');
  assert.equal(texts.filter((x) => x.startsWith('owner')).length, 27);
  assert.equal((await readNotes(chat, opts)).tombstones.length, 0, 'an eviction leaves no tombstone');
  assert.equal((await addNote(chat, owner('owner 27'), { ...opts, now: (t += MIN) })).status, 'added', 'an Owner Note also pushes out an agent Note');
  texts = (await listNotes(chat, opts)).map((x) => x.text);
  assert.equal(texts.includes('agent 1'), false);
  assert.equal(texts.length, 30);
});

test('30 Owner Notes refuse any new Note', async () => {
  const chat = freshChat();
  for (let i = 0; i < 30; i++) await addNote(chat, owner(`owner ${i}`), { ...opts, now: T0 + i * MIN });
  assert.equal((await addNote(chat, agent('one more'), { ...opts, now: T0 + 40 * MIN })).status, 'full');
  assert.equal((await addNote(chat, owner('one more'), { ...opts, now: T0 + 40 * MIN })).status, 'full');
  assert.equal((await listNotes(chat, opts)).length, 30);
});

test('a damaged or wrong-version file is an error, never an empty list', async () => {
  const chat = freshChat();
  const file = notesFile(chat, opts);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{ not json');
  await assert.rejects(listNotes(chat, opts), /damaged/);
  await assert.rejects(addNote(chat, agent('x'), opts), /damaged/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'nothing overwrote it');
  writeFileSync(file, JSON.stringify({ version: 2, notes: [], tombstones: [], ledger: [] }));
  await assert.rejects(listNotes(chat, opts), NotesError);
});

test('when the caller no longer owns the work, nothing is written', async () => {
  const chat = freshChat();
  let asked = 0;
  const r = await addNote(chat, agent('late claim'), { ...opts, now: T0, shouldCommit: async () => { asked++; return false; } });
  assert.deepEqual(r, { status: 'stale' });
  assert.equal(asked, 1);
  assert.equal(existsSync(notesFile(chat, opts)), false);
  assert.equal((await addNote(chat, agent('late claim'), { ...opts, now: T0, shouldCommit: () => true })).status, 'added');
  assert.equal((await readNotes(chat, opts)).ledger.length, 1, 'a stale add used no rate budget');
});

// Two processes, each adding Notes to the same chat as fast as they can.
const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'notes.mjs');
function writer(chat, tag, count) {
  const code = `import { addNote } from ${JSON.stringify(LIB)};
for (let i = 0; i < ${count}; i++) {
  const r = await addNote(${JSON.stringify(chat)}, { text: '${tag} ' + i, kind: 'owner', author: 'owner', source: { owner: true } }, { dir: ${JSON.stringify(home)}, waitMs: 20000 });
  if (r.status !== 'added') { console.error(r.status); process.exit(1); }
}`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (status) => resolve({ status, err }));
  });
}

test('two processes writing at once both land, with no lost update', async () => {
  const chat = freshChat();
  const [a, b] = await Promise.all([writer(chat, 'left', 12), writer(chat, 'right', 12)]);
  assert.equal(a.status, 0, a.err);
  assert.equal(b.status, 0, b.err);
  const texts = (await listNotes(chat, opts)).map((x) => x.text);
  assert.equal(texts.length, 24);
  for (let i = 0; i < 12; i++) assert.ok(texts.includes(`left ${i}`) && texts.includes(`right ${i}`), String(i));
});

const lockOf = (chat) => `${notesFile(chat, opts)}.lock`;
function plantLock(chat, info) {
  const dir = lockOf(chat);
  mkdirSync(dir, { recursive: true });
  if (info) writeFileSync(join(dir, 'owner.json'), JSON.stringify(info));
  return dir;
}

test('a lock left by a process that is gone is broken', async () => {
  const chat = freshChat();
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  plantLock(chat, { pid: gone, at: new Date().toISOString(), token: 'old' });
  assert.equal((await addNote(chat, agent('after a crash'), { ...opts, waitMs: 1000 })).status, 'added');
  assert.equal(existsSync(lockOf(chat)), false);
});

test('a lock older than 10 seconds is broken, even if its process lives', async () => {
  const chat = freshChat();
  plantLock(chat, { pid: process.pid, at: new Date(Date.now() - 11_000).toISOString(), token: 'old' });
  assert.equal((await addNote(chat, agent('after a hang'), { ...opts, waitMs: 1000 })).status, 'added');
});

test('a lock with no owner file goes by the folder age', async () => {
  const chat = freshChat();
  const dir = plantLock(chat, null);
  const old = new Date(Date.now() - 11_000);
  utimesSync(dir, old, old);
  assert.equal((await addNote(chat, agent('after an early crash'), { ...opts, waitMs: 1000 })).status, 'added');
});

test('a live lock is waited on, then refused with nothing written', async () => {
  const chat = freshChat();
  plantLock(chat, { pid: process.pid, at: new Date().toISOString(), token: 'live' });
  await assert.rejects(addNote(chat, agent('blocked'), { ...opts, waitMs: 300 }), /Another writer is holding/);
  assert.equal(existsSync(notesFile(chat, opts)), false);
  assert.equal(existsSync(lockOf(chat)), true, 'a live lock is left alone');
});
