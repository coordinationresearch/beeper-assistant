// Scoped Owner instructions share the Notes document format and its atomic per-file lock.
// Reading validates structure, not authority. Consumers must verify each signature before
// treating a record as the Owner's words. Mutations verify every existing record with sign.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { NotesError, readNotes, withLock } from './notes.mjs';

export const OWNER_INSTRUCTIONS_KEY = '__companion_owner_instructions_v1__';
// The Owner's changes to the Playbook (ADR 0109): standing instructions whose scope is one Playbook
// situation, in a document of their own. Every reader of the first document, older skill copies
// included, rejects the whole file over a scope kind it doesn't know, so a situation kept there
// would hide every Chat's instructions from them. Kept apart, a damaged Playbook document never
// hides a Chat's instructions either.
export const OWNER_PLAYBOOK_KEY = '__companion_owner_playbook_v1__';
export const INSTRUCTION_MAX_CHARS = 2000;
// Each document's scope kinds. A situation's key is its title, as the Playbook heads it.
const KINDS = { [OWNER_INSTRUCTIONS_KEY]: ['reply', 'chat', 'person', 'global'], [OWNER_PLAYBOOK_KEY]: ['situation'] };
const kindsOf = doc => {
  if (!Object.hasOwn(KINDS, doc)) throw new NotesError('Choose a known instructions document. Nothing was changed.');
  return KINDS[doc];
};

/** @typedef {{kind: 'reply'|'chat'|'person'|'global', key: string|null}} InstructionScope */
// The Playbook document's one kind: its key is a situation's title.
/** @typedef {{kind: 'situation', key: string}} SituationScope */
/** @typedef {{chatID: string, turnID?: number}} InstructionSource */
// move and cut, in the Playbook document only. move: the shipped move the Owner changed, word for word
// as they saw it; absent for an instruction for the whole situation. cut: the Owner cut that move,
// with no words of their own, so text is empty.
/** @typedef {{id: string, text: string, scope: InstructionScope, source: InstructionSource, at: string, status: 'active'|'superseded'|'undone', supersedes?: string, move?: string, cut?: true, sig: string}} OwnerInstruction */
/** @typedef {{text: string, scope: InstructionScope, source: InstructionSource, supersedes?: string, move?: string, cut?: true}} InstructionInput */
/** @typedef {{dir?: string, doc?: string, now?: number, waitMs?: number, sign: (instruction: Omit<OwnerInstruction, 'sig'>) => string, shouldCommit?: () => boolean|Promise<boolean>, requires?: string}} InstructionOptions */
/** @typedef {{status: 'added'|'duplicate'|'stale', instruction?: OwnerInstruction}} AddInstructionResult */
/** @typedef {{status: 'undone'|'already-undone'|'missing'|'stale', instruction?: OwnerInstruction, restored?: OwnerInstruction}} UndoInstructionResult */
/** @typedef {{status: 'deleted'|'missing'|'replaced'|'stale', removed?: OwnerInstruction[]}} DeleteInstructionResult */
/** @typedef {AddInstructionResult | UndoInstructionResult | DeleteInstructionResult} InstructionResult */

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (value, required, optional = []) => object(value)
  && required.every(k => Object.hasOwn(value, k))
  && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
const identifier = (v, max = 1000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
const validText = v => typeof v === 'string' && v.trim().length > 0 && v.length <= INSTRUCTION_MAX_CHARS;
const validScope = (s, kinds) => keys(s, ['kind', 'key']) && kinds.includes(s.kind)
  && (s.kind === 'global' ? s.key === null : identifier(s.key));
const validSource = s => keys(s, ['chatID'], ['turnID']) && identifier(s.chatID)
  && (!Object.hasOwn(s, 'turnID') || Number.isSafeInteger(s.turnID) && s.turnID > 0);
const sameScope = (a, b) => a.kind === b.kind && a.key === b.key;
const validTime = at => typeof at === 'string' && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at;
const validSignature = sig => typeof sig === 'string' && /^[a-f0-9]{64}$/.test(sig);
const fail = () => { throw new NotesError('The Owner instructions are damaged or unverified. Nothing was changed.'); };
// The Playbook document's own fields, and its words: a cut has none.
const playbookDoc = kinds => kinds.includes('situation');
const optional = kinds => playbookDoc(kinds) ? ['supersedes', 'move', 'cut'] : ['supersedes'];
const validWords = (r, kinds) => {
  if (!playbookDoc(kinds)) return validText(r.text);
  if (Object.hasOwn(r, 'move') && !identifier(r.move, INSTRUCTION_MAX_CHARS)) return false;
  return Object.hasOwn(r, 'cut') ? r.cut === true && Object.hasOwn(r, 'move') && r.text === '' : validText(r.text);
};
// A replacement changes the same move, or the same whole situation.
const sameMove = (a, b) => (a.move ?? null) === (b.move ?? null);

function records(doc, kinds) {
  if (doc.instructions === undefined) return [];
  if (!Array.isArray(doc.instructions)) return fail();
  const seen = new Map();
  for (const record of doc.instructions) {
    if (!keys(record, ['id', 'text', 'scope', 'source', 'at', 'status', 'sig'], optional(kinds))
      || !identifier(record.id, 128) || !validWords(record, kinds) || !validScope(record.scope, kinds) || !validSource(record.source)
      || !validTime(record.at) || !['active', 'superseded', 'undone'].includes(record.status) || !validSignature(record.sig)
      || seen.has(record.id)) return fail();
    if (Object.hasOwn(record, 'supersedes')) {
      const previous = seen.get(record.supersedes);
      if (!identifier(record.supersedes, 128) || !previous || !sameScope(record.scope, previous.scope) || !sameMove(record, previous)) return fail();
    }
    seen.set(record.id, record);
  }
  return doc.instructions;
}
function unsigned(record) { const { sig: _sig, ...fields } = record; return fields; }
function signature(fields, sign) {
  const sig = sign(structuredClone(fields));
  if (!validSignature(sig)) throw new NotesError('An Owner instruction needs a valid companion signature. Nothing was changed.');
  return sig;
}
function verifiedRecords(doc, sign, kinds) {
  if (typeof sign !== 'function') throw new NotesError('Only the companion can sign an Owner instruction. Nothing was changed.');
  const items = records(doc, kinds);
  for (const item of items) {
    const expected = Buffer.from(signature(unsigned(item), sign), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(item.sig, 'hex'))) fail();
  }
  return items;
}
const resign = (record, status, sign) => {
  const fields = { ...unsigned(record), status };
  return { ...fields, sig: signature(fields, sign) };
};
function cleanInput(input, kinds) {
  if (!keys(input, ['text', 'scope', 'source'], optional(kinds)) || !validWords(input, kinds) || !validScope(input.scope, kinds) || !validSource(input.source)
    || Object.hasOwn(input, 'supersedes') && !identifier(input.supersedes, 128))
    throw new NotesError('An Owner instruction needs the original text, a valid scope, and its source. Nothing was changed.');
  return structuredClone(input);
}
// Uses the existing Notes writer's second ownership check immediately before its rename.
async function commit(save, doc, shouldCommit) {
  let withdrawn = false;
  const wanted = shouldCommit ? async () => { const ok = await shouldCommit(); withdrawn = !ok; return ok; } : undefined;
  try { await save(doc, wanted); return true; } catch (error) { if (withdrawn) return false; throw error; }
}

/** Returns all history, not just active records. Verify signatures before using their text.
 * doc: which document, the Chat scopes' (the default) or the Playbook's (OWNER_PLAYBOOK_KEY).
 * @param {{dir?: string, doc?: string}} [options]
 * @returns {Promise<OwnerInstruction[]>}
 */
export async function listInstructions({ dir, doc = OWNER_INSTRUCTIONS_KEY } = {}) {
  const kinds = kindsOf(doc);
  return structuredClone(records(await readNotes(doc, { dir }), kinds));
}

/** No normalization: the Owner's exact wording and whitespace are retained.
 * Replacement is explicit, names an active predecessor, and cannot change its scope, or its move.
 * requires: a record that must still be active, such as the one a wider copy is saved from.
 * @param {InstructionInput} input
 * @param {InstructionOptions} options
 * @returns {Promise<AddInstructionResult>}
 */
export async function addInstruction(input, { dir, doc: key = OWNER_INSTRUCTIONS_KEY, sign, shouldCommit, requires, now = Date.now(), waitMs } = {}) {
  const kinds = kindsOf(key);
  const clean = cleanInput(input, kinds);
  return withLock(key, async (doc, save) => {
    const items = verifiedRecords(doc, sign, kinds);
    if (shouldCommit && !await shouldCommit()) return { status: 'stale' };
    if (requires !== undefined && !items.some(i => i.id === requires && i.status === 'active')) return { status: 'stale' };
    const duplicate = items.find(i => i.status === 'active' && i.text === clean.text && sameScope(i.scope, clean.scope) && sameMove(i, clean) && Boolean(i.cut) === Boolean(clean.cut));
    if (duplicate) {
      // An exact duplicate is a no-op, so it cannot also claim to replace a different rule.
      if (clean.supersedes && clean.supersedes !== duplicate.id) return { status: 'stale' };
      return { status: 'duplicate', instruction: structuredClone(duplicate) };
    }
    const previous = clean.supersedes ? items.find(i => i.id === clean.supersedes) : undefined;
    if (clean.supersedes && (!previous || previous.status !== 'active' || !sameScope(previous.scope, clean.scope) || !sameMove(previous, clean))) return { status: 'stale' };
    const fields = { id: `i${randomUUID()}`, ...clean, at: new Date(now).toISOString(), status: /** @type {const} */ ('active') };
    const instruction = { ...fields, sig: signature(fields, sign) };
    const next = items.map(i => i === previous ? resign(i, 'superseded', sign) : i);
    next.push(instruction);
    if (!await commit(save, { ...doc, instructions: next }, shouldCommit)) return { status: 'stale' };
    return { status: 'added', instruction };
  }, { dir, waitMs });
}

function descendsFrom(record, ancestorID, byID) {
  for (let current = record; current?.supersedes; current = byID.get(current.supersedes)) {
    if (current.supersedes === ancestorID) return true;
  }
  return false;
}

/** Undo only the still-active change named by the Owner. A stale Undo never changes history.
 * @param {string} id
 * @param {InstructionOptions} options
 * @returns {Promise<UndoInstructionResult>}
 */
export async function undoInstruction(id, { dir, doc: key = OWNER_INSTRUCTIONS_KEY, sign, shouldCommit, waitMs } = {}) {
  if (!identifier(id, 128)) throw new NotesError('Choose a valid Owner instruction to undo. Nothing was changed.');
  const kinds = kindsOf(key);
  return withLock(key, async (doc, save) => {
    const items = verifiedRecords(doc, sign, kinds);
    if (shouldCommit && !await shouldCommit()) return { status: 'stale' };
    const target = items.find(i => i.id === id);
    if (!target) return { status: 'missing' };
    if (target.status === 'undone') return { status: 'already-undone', instruction: structuredClone(target) };
    const byID = new Map(items.map(i => [i.id, i]));
    if (target.status !== 'active' || items.some(i => i.status === 'active' && descendsFrom(i, id, byID))) return { status: 'stale' };
    const instruction = resign(target, 'undone', sign);
    const previous = target.supersedes ? byID.get(target.supersedes) : undefined;
    const restore = previous?.status === 'superseded' && !items.some(i => i !== target && i.status === 'active' && descendsFrom(i, previous.id, byID));
    const restored = restore ? resign(previous, 'active', sign) : undefined;
    const next = items.map(i => i === target ? instruction : restored && i === previous ? restored : i);
    if (!await commit(save, { ...doc, instructions: next }, shouldCommit)) return { status: 'stale' };
    return { status: 'undone', instruction, ...(restored ? { restored } : {}) };
  }, { dir, waitMs });
}

/** Delete removes records rather than marking them, because every reader, older skill copies
 * included, rejects the whole file over a status it doesn't know. It takes the named record and,
 * when that record is in use, the versions it replaced. Nothing is restored. Any record left
 * naming a removed one in supersedes, such as an undone later version, goes too: a reader also
 * rejects a supersedes that names nothing. Each signature covers only its own record, so the rest
 * keep theirs. Refused for a record a still-active version replaced; delete that version instead.
 * @param {string} id
 * @param {InstructionOptions} options
 * @returns {Promise<DeleteInstructionResult>}
 */
export async function deleteInstruction(id, { dir, doc: key = OWNER_INSTRUCTIONS_KEY, sign, shouldCommit, waitMs } = {}) {
  if (!identifier(id, 128)) throw new NotesError('Choose a valid Owner instruction to delete. Nothing was changed.');
  const kinds = kindsOf(key);
  return withLock(key, async (doc, save) => {
    const items = verifiedRecords(doc, sign, kinds);
    if (shouldCommit && !await shouldCommit()) return { status: 'stale' };
    const target = items.find(i => i.id === id);
    if (!target) return { status: 'missing' };
    const byID = new Map(items.map(i => [i.id, i]));
    if (items.some(i => i.status === 'active' && descendsFrom(i, id, byID))) return { status: 'replaced' };
    const gone = new Set([id]);
    // An undone record replaced nothing still out of use: Undo gave its predecessor back.
    if (target.status !== 'undone') {
      for (let previous = byID.get(target.supersedes); previous?.status === 'superseded'; previous = byID.get(previous.supersedes)) gone.add(previous.id);
    }
    // A record names only an earlier one, so one pass in file order finds every later record that
    // still names a removed one.
    for (const item of items) if (item.supersedes && gone.has(item.supersedes)) gone.add(item.id);
    if (items.some(i => i !== target && gone.has(i.id) && i.status === 'active')) return { status: 'stale' };
    const removed = items.filter(i => gone.has(i.id));
    if (!await commit(save, { ...doc, instructions: items.filter(i => !gone.has(i.id)) }, shouldCommit)) return { status: 'stale' };
    return { status: 'deleted', removed };
  }, { dir, waitMs });
}
