import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addNote, readNotes, notesFile, withLock } from '../scripts/lib/notes.mjs';
import { OWNER_INSTRUCTIONS_KEY, OWNER_PLAYBOOK_KEY, addInstruction, deleteInstruction, listInstructions, undoInstruction } from '../scripts/lib/instructions.mjs';
import * as older from './old-instructions.mjs';

const sign = fields => createHmac('sha256', 'synthetic-test-key').update(JSON.stringify(fields)).digest('hex');
const input = (text = 'Keep my original  spacing.\nAnd this line.', kind = 'chat', key = 'chat-A') => ({ text, scope: { kind, key }, source: { chatID: 'chat-A', turnID: 1 } });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-instructions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, sign, now: Date.parse('2026-10-09T12:00:00Z') };
}

test('exact original wording, scope, source, and signature survive with regular Notes', async t => {
  const opts = fixture(t);
  await addNote(OWNER_INSTRUCTIONS_KEY, { text: 'Regular Note', kind: 'owner', author: 'owner', source: { owner: true } }, opts);
  const added = await addInstruction(input(), opts);
  assert.equal(added.status, 'added');
  assert.equal(added.instruction.text, input().text);
  assert.deepEqual(added.instruction.source, input().source);
  assert.deepEqual(added.instruction.scope, input().scope);
  assert.deepEqual(await listInstructions(opts), [added.instruction]);
  await addNote(OWNER_INSTRUCTIONS_KEY, { text: 'Another Note', kind: 'owner', author: 'owner', source: { owner: true } }, opts);
  assert.equal((await readNotes(OWNER_INSTRUCTIONS_KEY, opts)).notes.length, 2);
  assert.deepEqual(await listInstructions(opts), [added.instruction], 'ordinary Notes writer preserves extension');
});

test('all scopes validate, and signed exact active duplicates are left untouched', async t => {
  const opts = fixture(t);
  for (const [kind, key] of [['reply', 'chat-A:context-1'], ['chat', 'chat-A'], ['person', 'person-A'], ['global', null]]) {
    const first = await addInstruction(input('Exact', kind, key), opts);
    const again = await addInstruction({ ...input('Exact', kind, key), source: { chatID: 'chat-B' } }, opts);
    assert.equal(again.status, 'duplicate');
    assert.deepEqual(again.instruction, first.instruction);
  }
  assert.equal((await addInstruction(input('exact'), opts)).status, 'added', 'case is not normalized');
  assert.equal((await addInstruction(input(' Exact '), opts)).status, 'added', 'whitespace is not normalized');
  const a = (await addInstruction(input('Old rule'), opts)).instruction;
  const b = (await addInstruction(input('Already active'), opts)).instruction;
  assert.equal((await addInstruction({ ...input('Already active'), supersedes: a.id }, opts)).status, 'stale', 'an exact duplicate cannot claim to replace a different active instruction');
  assert.equal((await addInstruction({ ...input('Already active'), supersedes: b.id }, opts)).status, 'duplicate', 'self replacement is an unchanged duplicate');
  assert.equal((await listInstructions(opts)).find(i => i.id === a.id).status, 'active', 'duplicate did not supersede another rule');
  assert.equal((await listInstructions(opts)).find(i => i.id === b.id).status, 'active');
});

test('explicit replacement and Undo preserve history and never reactivate a stale chain', async t => {
  const opts = fixture(t);
  const a = (await addInstruction(input('Original'), opts)).instruction;
  const b = (await addInstruction({ ...input('Correction'), supersedes: a.id }, opts)).instruction;
  const c = (await addInstruction({ ...input('Latest correction'), supersedes: b.id }, opts)).instruction;
  assert.equal((await undoInstruction(b.id, opts)).status, 'stale');
  let rows = await listInstructions(opts);
  assert.deepEqual(rows.map(i => i.status), ['superseded', 'superseded', 'active']);
  assert.equal((await undoInstruction(c.id, opts)).restored.id, b.id);
  assert.equal((await undoInstruction(c.id, opts)).status, 'already-undone');
  assert.equal((await undoInstruction(b.id, opts)).restored.id, a.id);
  const d = (await addInstruction({ ...input('New direction'), supersedes: a.id }, opts)).instruction;
  assert.equal((await undoInstruction(b.id, opts)).status, 'already-undone');
  rows = await listInstructions(opts);
  assert.deepEqual(rows.map(i => i.status), ['superseded', 'undone', 'undone', 'active']);
  assert.equal((await undoInstruction(d.id, opts)).restored.id, a.id);
  assert.equal((await undoInstruction(a.id, opts)).status, 'undone');
  assert.equal((await undoInstruction('missing', opts)).status, 'missing');
});

test('replacement cannot jump scope or replace an inactive or missing instruction', async t => {
  const opts = fixture(t);
  const first = (await addInstruction(input('Original'), opts)).instruction;
  assert.equal((await addInstruction({ ...input('Other', 'person', 'person-A'), supersedes: first.id }, opts)).status, 'stale');
  assert.equal((await addInstruction({ ...input('Other'), supersedes: 'missing' }, opts)).status, 'stale');
  await undoInstruction(first.id, opts);
  assert.equal((await addInstruction({ ...input('Other'), supersedes: first.id }, opts)).status, 'stale');
  assert.equal((await listInstructions(opts)).length, 1);
});

test('invalid input, unsigned writes, and malformed signatures never create instructions', async t => {
  const opts = fixture(t);
  for (const bad of [input(''), input('x'.repeat(2001)), input('A', 'global', 'not-null'), input('A', 'reply', null),
    { ...input(), source: { chatID: 'A', turnID: 0 } }, { ...input(), extra: true }, { ...input(), sig: 'forged' }]) {
    await assert.rejects(addInstruction(bad, opts));
  }
  await assert.rejects(addInstruction(input(), { dir: opts.dir }));
  await assert.rejects(addInstruction(input(), { ...opts, sign: () => 'unsigned' }));
  assert.deepEqual(await listInstructions(opts), []);
});

test('damaged or forged records block mutation without replacing the file', async t => {
  const opts = fixture(t);
  await addInstruction(input(), opts);
  const file = notesFile(OWNER_INSTRUCTIONS_KEY, opts);
  const original = JSON.parse(readFileSync(file, 'utf8'));
  for (const edit of [doc => { doc.instructions = {}; }, doc => { doc.instructions[0].scope.key = null; },
    doc => { delete doc.instructions[0].sig; }, doc => { doc.instructions[0].source.extra = true; },
    doc => { doc.instructions.push({ ...doc.instructions[0] }); }]) {
    const doc = structuredClone(original); edit(doc); const broken = JSON.stringify(doc); writeFileSync(file, broken);
    await assert.rejects(listInstructions(opts));
    await assert.rejects(addInstruction(input('New'), opts));
    assert.equal(readFileSync(file, 'utf8'), broken);
  }
  const forged = structuredClone(original); forged.instructions[0].text = 'Forged instruction';
  const broken = JSON.stringify(forged); writeFileSync(file, broken);
  await assert.rejects(addInstruction(input('New'), opts), /unverified/);
  await assert.rejects(undoInstruction(forged.instructions[0].id, opts), /unverified/);
  await assert.rejects(deleteInstruction(forged.instructions[0].id, opts), /unverified/);
  assert.equal(readFileSync(file, 'utf8'), broken);
});

test('ownership loss before or during atomic commit leaves adds and Undo unchanged', async t => {
  const opts = fixture(t);
  assert.deepEqual(await addInstruction(input(), { ...opts, shouldCommit: () => false }), { status: 'stale' });
  let checks = 0;
  assert.deepEqual(await addInstruction(input(), { ...opts, shouldCommit: () => ++checks === 1 }), { status: 'stale' });
  assert.deepEqual(await listInstructions(opts), []);
  const added = (await addInstruction(input(), opts)).instruction;
  checks = 0;
  assert.deepEqual(await undoInstruction(added.id, { ...opts, shouldCommit: () => ++checks === 1 }), { status: 'stale' });
  assert.deepEqual(await listInstructions(opts), [added]);
});

test('concurrent writers serialize without losing instructions or replacement history', async t => {
  const opts = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => addInstruction(input(`Rule ${i}`), opts)));
  assert.equal(results.filter(r => r.status === 'added').length, 8);
  assert.equal((await listInstructions(opts)).length, 8);
  const first = results[0].instruction;
  const replacements = await Promise.all(['A', 'B'].map(text => addInstruction({ ...input(text), supersedes: first.id }, opts)));
  assert.deepEqual(replacements.map(r => r.status).sort(), ['added', 'stale']);
  assert.equal((await listInstructions(opts)).filter(i => i.supersedes === first.id).length, 1);
});

test('Delete removes an active Instruction and every version it replaced, and the rest keep their signatures', async t => {
  const opts = fixture(t);
  const other = (await addInstruction(input('Unrelated rule'), opts)).instruction;
  const a = (await addInstruction(input('Original'), opts)).instruction;
  const tried = (await addInstruction({ ...input('First try'), supersedes: a.id }, opts)).instruction;
  await undoInstruction(tried.id, opts);
  const b = (await addInstruction({ ...input('Correction'), supersedes: a.id }, opts)).instruction;
  const c = (await addInstruction({ ...input('Latest correction'), supersedes: b.id }, opts)).instruction;
  const deleted = await deleteInstruction(c.id, opts);
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual(deleted.removed.map(i => i.id), [a.id, tried.id, b.id, c.id], 'the undone try names a removed version, so it goes too');
  assert.deepEqual(await listInstructions(opts), [other], 'nothing restored, and the remaining record is byte for byte the same');
  assert.equal((await addInstruction(input('Next rule'), opts)).status, 'added', 'a later write verifies every remaining signature');
});

test('Delete of an undone Instruction leaves the version Undo gave back in use', async t => {
  const opts = fixture(t);
  const a = (await addInstruction(input('Original'), opts)).instruction;
  const b = (await addInstruction({ ...input('Correction'), supersedes: a.id }, opts)).instruction;
  const c = (await addInstruction({ ...input('Latest correction'), supersedes: b.id }, opts)).instruction;
  await undoInstruction(c.id, opts);
  await undoInstruction(b.id, opts);
  const deleted = await deleteInstruction(b.id, opts);
  assert.deepEqual(deleted.removed.map(i => [i.id, i.status]), [[b.id, 'undone'], [c.id, 'undone']]);
  assert.deepEqual(await listInstructions(opts), [a], 'the restored original keeps its record and signature');
  const lone = (await addInstruction(input('Lone rule'), opts)).instruction;
  await undoInstruction(lone.id, opts);
  assert.deepEqual((await deleteInstruction(lone.id, opts)).removed.map(i => i.id), [lone.id]);
  assert.deepEqual(await listInstructions(opts), [a]);
});

test('Delete is refused for a version a still-active one replaced, and changes nothing', async t => {
  const opts = fixture(t);
  const a = (await addInstruction(input('Original'), opts)).instruction;
  await addInstruction({ ...input('Correction'), supersedes: a.id }, opts);
  const file = notesFile(OWNER_INSTRUCTIONS_KEY, opts), before = readFileSync(file, 'utf8');
  assert.deepEqual(await deleteInstruction(a.id, opts), { status: 'replaced' });
  assert.deepEqual(await deleteInstruction('missing', opts), { status: 'missing' });
  await assert.rejects(deleteInstruction('', opts), /valid Owner instruction/);
  await assert.rejects(deleteInstruction(a.id, { dir: opts.dir }), /Only the companion/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('Delete keeps Undo\'s ownership checks and waits out a lock held elsewhere', async t => {
  const opts = fixture(t);
  const added = (await addInstruction(input(), opts)).instruction;
  assert.deepEqual(await deleteInstruction(added.id, { ...opts, shouldCommit: () => false }), { status: 'stale' });
  let checks = 0;
  assert.deepEqual(await deleteInstruction(added.id, { ...opts, shouldCommit: () => ++checks === 1 }), { status: 'stale' }, 'withdrawn right before the rename');
  await withLock(OWNER_INSTRUCTIONS_KEY, async () => {
    await assert.rejects(deleteInstruction(added.id, { ...opts, waitMs: 30 }), /Another writer/);
  }, { dir: opts.dir });
  assert.deepEqual(await listInstructions(opts), [added]);
});

test('a skill copy from before Delete reads, verifies, and writes the file Delete leaves', async t => {
  const opts = fixture(t);
  const keep = (await addInstruction(input('Kept rule'), opts)).instruction;
  const a = (await addInstruction(input('Original'), opts)).instruction;
  const b = (await addInstruction({ ...input('Correction'), supersedes: a.id }, opts)).instruction;
  const c = (await addInstruction({ ...input('Latest correction'), supersedes: b.id }, opts)).instruction;
  await undoInstruction(c.id, opts);
  const file = notesFile(OWNER_INSTRUCTIONS_KEY, opts);
  // Removing the middle record by hand leaves c naming nothing, and the old reader rejects the whole file.
  const dangling = JSON.parse(readFileSync(file, 'utf8'));
  dangling.instructions = dangling.instructions.filter(i => i.id !== b.id);
  const intact = readFileSync(file, 'utf8'); writeFileSync(file, JSON.stringify(dangling));
  await assert.rejects(older.listInstructions(opts), /damaged/);
  writeFileSync(file, intact);
  assert.deepEqual((await deleteInstruction(b.id, opts)).removed.map(i => i.id), [a.id, b.id, c.id]);
  assert.deepEqual(await older.listInstructions(opts), await listInstructions(opts));
  assert.deepEqual((await older.listInstructions(opts)).map(i => [i.id, i.status]), [[keep.id, 'active']]);
  const next = await older.addInstruction({ ...input('Older copy rule'), supersedes: keep.id }, opts);
  assert.equal(next.status, 'added', 'the older copy verifies every remaining signature before it writes');
  assert.equal((await older.undoInstruction(next.instruction.id, opts)).restored.id, keep.id);
  assert.deepEqual((await deleteInstruction(next.instruction.id, opts)).removed.map(i => i.id), [next.instruction.id]);
  assert.deepEqual((await older.listInstructions(opts)).map(i => [i.text, i.status]), [['Kept rule', 'active']]);
});

test('a wider copy saved with requires commits only while its source is active, and older readers still read the file', async t => {
  const opts = fixture(t);
  const chat = (await addInstruction(input('Short replies'), opts)).instruction;
  const wide = await addInstruction(input('Short replies', 'global', null), { ...opts, requires: chat.id });
  assert.equal(wide.status, 'added');
  assert.equal(wide.instruction.supersedes, undefined, 'unlinked: a replacement may not change scope');
  await undoInstruction(chat.id, opts);
  assert.equal((await addInstruction(input('Short replies', 'person', 'p1'), { ...opts, requires: chat.id })).status, 'stale');
  assert.equal((await older.listInstructions({ dir: opts.dir })).length, 2, 'an older skill copy reads both records');
});

// The Owner's changes to the Playbook (ADR 0109), in their own document.
const situation = (text, more = {}) => ({ text, scope: { kind: 'situation', key: 'Hard news' }, source: { chatID: 'home' }, ...more });
const MOVE = 'Check in later without being asked.';

test('a situation scope lives only in the Playbook document, which takes a move and a cut', async t => {
  const opts = fixture(t), playbook = { ...opts, doc: OWNER_PLAYBOOK_KEY };
  await assert.rejects(addInstruction(situation('Two lines at most'), opts), /valid scope/, 'the Chat document refuses a fifth kind');
  await assert.rejects(addInstruction(input('Short'), playbook), /valid scope/, 'the Playbook document holds only situations');
  await assert.rejects(addInstruction(situation('Words', { move: MOVE }), opts), /valid scope/);
  const reworded = (await addInstruction(situation('Check in on the hard date only.', { move: MOVE }), playbook)).instruction;
  assert.equal(reworded.move, MOVE);
  await assert.rejects(addInstruction(situation('', { move: MOVE }), playbook), /original text/, 'only a cut has no words');
  await assert.rejects(addInstruction(situation('Words', { cut: true }), playbook), /original text/, 'a cut names its move and has no words');
  const cut = (await addInstruction(situation('', { move: MOVE, cut: true, supersedes: reworded.id }), playbook)).instruction;
  assert.equal(cut.cut, true);
  assert.equal((await addInstruction(situation('', { move: MOVE, cut: true }), playbook)).status, 'duplicate');
  assert.equal((await addInstruction(situation('Other words', { move: 'Another move.', supersedes: cut.id }), playbook)).status, 'stale', 'a replacement keeps its move');
  const whole = (await addInstruction(situation('Never send a link.'), playbook)).instruction;
  assert.equal(whole.move, undefined);
  assert.deepEqual((await listInstructions(playbook)).map(i => [i.status, i.cut ?? false]), [['superseded', false], ['active', true], ['active', false]]);
  assert.equal((await undoInstruction(cut.id, playbook)).restored.id, reworded.id, 'Undo of a cut gives the words back');
  assert.deepEqual((await deleteInstruction(reworded.id, playbook)).removed.map(i => i.id), [reworded.id, cut.id]);
  assert.deepEqual(await listInstructions(opts), [], 'the Chat document never saw any of it');
});

test('older skill copies never read the Playbook document, and a damaged one hides no Chat instruction', async t => {
  const opts = fixture(t), playbook = { ...opts, doc: OWNER_PLAYBOOK_KEY };
  const chat = (await addInstruction(input('Short replies'), opts)).instruction;
  await addInstruction(situation('Two lines at most.'), playbook);
  assert.deepEqual(await older.listInstructions(opts), [chat], 'an older copy reads the Chat document as before');
  assert.equal((await older.addInstruction(input('From an older copy'), opts)).status, 'added');
  writeFileSync(notesFile(OWNER_PLAYBOOK_KEY, opts), '{"instructions": "damaged"}');
  await assert.rejects(listInstructions(playbook), /damaged/);
  assert.equal((await listInstructions(opts)).length, 2);
  await assert.rejects(listInstructions({ ...opts, doc: 'somewhere else' }), /known instructions document/);
});

test('a Playbook record whose move or cut was changed by hand fails its signature', async t => {
  const opts = fixture(t), playbook = { ...opts, doc: OWNER_PLAYBOOK_KEY };
  await addInstruction(situation('Check in on the hard date only.', { move: MOVE }), playbook);
  const file = notesFile(OWNER_PLAYBOOK_KEY, opts);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.instructions[0].move = 'Another move.';
  writeFileSync(file, JSON.stringify(doc));
  await assert.rejects(addInstruction(situation('More words'), playbook), /damaged or unverified/, 'every write verifies every record, move included');
});
