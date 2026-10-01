// Two writers of the state file must not undo each other. Made-up ids only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.BEEPER_ASSISTANT_HOME = mkdtempSync(join(tmpdir(), 'ba-state-'));
const { dismiss, loadState, rememberChats, saveState, undismiss } = await import('../scripts/lib/state.mjs');
const onDisk = () => JSON.parse(readFileSync(join(process.env.BEEPER_ASSISTANT_HOME, 'state.json'), 'utf8'));
const chat = (id) => ({ id, preview: { id: `$last-${id}` } });

test('two processes that loaded the same file both keep their changes', () => {
  const seed = loadState();
  dismiss(seed, chat('!old'));
  saveState(seed);
  const a = loadState(), b = loadState();
  dismiss(a, chat('!a'));
  rememberChats(a, [{ id: '!seen-by-a' }]);
  saveState(a);
  dismiss(b, chat('!b'));
  undismiss(b, '!old');
  saveState(b);
  const s = onDisk();
  assert.deepEqual(Object.keys(s.dismissed).sort(), ['!a', '!b']);
  assert.equal(Object.values(s.aliases).some((v) => v.id === '!seen-by-a'), true);
});

test('a process that saves twice carries on from the merged file', () => {
  const a = loadState(), b = loadState();
  dismiss(b, chat('!c'));
  saveState(b);
  dismiss(a, chat('!d'));
  saveState(a);
  assert.ok(a.dismissed['!c'], 'the first save brought in the other writer’s change');
  undismiss(a, '!c');
  saveState(a);
  assert.equal(onDisk().dismissed['!c'], undefined);
  assert.ok(onDisk().dismissed['!d']);
});

test('a lock left by a dead process is taken over', () => {
  const lock = join(process.env.BEEPER_ASSISTANT_HOME, 'state.lock');
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const s = loadState();
  dismiss(s, chat('!e'));
  const t0 = Date.now();
  saveState(s);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(onDisk().dismissed['!e']);
});
