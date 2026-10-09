import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addNote, readNotes, notesFile } from '../scripts/lib/notes.mjs';
import { OWNER_INSTRUCTIONS_KEY, addInstruction, listInstructions, undoInstruction } from '../scripts/lib/instructions.mjs';

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
