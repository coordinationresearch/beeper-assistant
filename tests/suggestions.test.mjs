// Reply suggestions a terminal agent posts for the sidebar. Every test uses a throwaway folder and made-up chats.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPLY_LIMITS, replyProblem } from '../scripts/lib/reply.mjs';
import { SUGGESTION_BYTES, agentLabel, readSuggestion, stepsFromAgent, suggestionFile, waitMs, writeSuggestion } from '../scripts/lib/suggestions.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ba-suggest-'));
const ids = { m1a2b3c4: 'msg-1' };
const resolve = async (ref) => { if (!ids[ref]) throw new Error(`No message matches ${ref}`); return ids[ref]; };

test('the agent is named from its environment, or by what it says it is', () => {
  assert.equal(agentLabel({ CLAUDECODE: '1' }), 'Claude Code');
  assert.equal(agentLabel({ CODEX_THREAD_ID: 'x' }), 'Codex');
  assert.equal(agentLabel({}), 'An agent');
  assert.equal(agentLabel({ CLAUDECODE: '1' }, '  Gemini\n CLI\u0007 '), 'Gemini CLI');
});

test('an agent\'s steps become messages and reactions with the wait before each', async () => {
  assert.deepEqual(await stepsFromAgent([{ react: 'm1a2b3c4', key: '❤️' }, { say: 'Yes!' }, { wait: '20s' }, { wait: 5 }, { say: 'See you at 7  ' }], resolve), [
    { kind: 'react', key: '❤️', messageID: 'msg-1', waitMs: 0 },
    { kind: 'message', text: 'Yes!', waitMs: 0 },
    { kind: 'message', text: 'See you at 7', waitMs: 25_000 },
  ]);
  assert.equal(waitMs('2m'), 120_000); assert.equal(waitMs('1.5 s'), 1500); assert.equal(waitMs('500ms'), 500); assert.ok(Number.isNaN(waitMs('soon')));
  await assert.rejects(stepsFromAgent([{ wait: '5s' }, { say: 'x' }], resolve), /Nothing waits before the first step/);
  await assert.rejects(stepsFromAgent([{ say: 'x' }, { wait: '5s' }], resolve), /not at the end/);
  await assert.rejects(stepsFromAgent([{ shout: 'x' }], resolve), /Each step is/);
  await assert.rejects(stepsFromAgent([{ react: 'm9999999', key: '👍' }], resolve), /No message matches/);
  await assert.rejects(stepsFromAgent('nope', resolve), /JSON list/);
});

test('the reply rules are the companion\'s rules', () => {
  const loaded = new Set(['msg-1']);
  assert.equal(replyProblem({ steps: [{ kind: 'message', text: 'Yes', waitMs: 0 }, { kind: 'message', text: 'Later', waitMs: 500 }] }, loaded), 'bad-wait');
  assert.equal(replyProblem({ steps: [{ kind: 'message', text: 'Yes', waitMs: 0 }, { kind: 'react', key: '❤️', messageID: 'other', waitMs: 1000 }] }, loaded), 'unknown-target');
  assert.equal(replyProblem({ steps: [{ kind: 'message', text: 'Yes', waitMs: 0 }, { kind: 'message', text: 'Later', waitMs: REPLY_LIMITS.waitMs }] }, loaded), null);
});

test('a suggestion is written atomically, readable only by the Owner, and the newest wins', () => {
  const chat = '!chat-1:beeper.local';
  const steps = [{ kind: 'message', text: 'Yes!', waitMs: 0 }];
  const first = writeSuggestion(chat, { steps, forMessageID: 'msg-1', author: 'Claude Code', dir, now: new Date('2026-10-02T12:00:00Z') });
  assert.equal(first.file, join(dir, 'suggestions', `${createHash('sha256').update(chat).digest('hex')}.json`));
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'suggestions')).mode & 0o777, 0o700);
  const second = writeSuggestion(chat, { steps: [{ kind: 'message', text: 'Actually yes', waitMs: 0 }], forMessageID: 'msg-2', author: 'Codex', dir });
  const read = readSuggestion(chat, { dir });
  assert.equal(read.id, second.id); assert.equal(read.author, 'Codex'); assert.equal(read.forMessageID, 'msg-2');
  assert.equal(readSuggestion('!other:beeper.local', { dir }), null);
});

test('a file another process damaged, renamed, or bloated reads as no suggestion', () => {
  const chat = '!chat-2:beeper.local', file = suggestionFile(chat, { dir });
  mkdirSync(join(dir, 'suggestions'), { recursive: true });
  const good = { version: 1, id: 'abcdef12-3456', chatKey: createHash('sha256').update(chat).digest('hex'), at: '2026-10-02T12:00:00Z', author: 'X', forMessageID: 'msg-1', steps: [] };
  for (const bad of ['not json', JSON.stringify({ ...good, version: 2 }), JSON.stringify({ ...good, chatKey: 'someone-else' }), JSON.stringify({ ...good, id: '../../x' }),
    JSON.stringify({ ...good, at: 'yesterday' }), JSON.stringify({ ...good, steps: 'x' }), JSON.stringify({ ...good, author: 'x'.repeat(10), pad: 'x'.repeat(SUGGESTION_BYTES) })]) {
    writeFileSync(file, bad);
    assert.equal(readSuggestion(chat, { dir }), null, bad.slice(0, 40));
  }
  writeFileSync(file, JSON.stringify({ ...good, author: '‮evil\nname that goes on and on and on and on forever' }));
  assert.equal(readSuggestion(chat, { dir }).author.length <= 40, true);
  assert.equal(readSuggestion(chat, { dir }).author.includes('‮'), false);
  assert.ok(readFileSync(file, 'utf8'));
});

test('a link or a FIFO in place of the file reads as no suggestion, without waiting', () => {
  const chat = '!chat-3:beeper.local', file = suggestionFile(chat, { dir });
  mkdirSync(join(dir, 'suggestions'), { recursive: true });
  const elsewhere = join(dir, 'elsewhere.json');
  writeSuggestion('!chat-4:beeper.local', { steps: [], forMessageID: 'm', author: 'x', dir });
  writeFileSync(elsewhere, readFileSync(suggestionFile('!chat-4:beeper.local', { dir })));
  rmSync(file, { force: true }); symlinkSync(elsewhere, file);
  assert.equal(readSuggestion(chat, { dir }), null, 'a link');
  rmSync(file, { force: true }); execFileSync('/usr/bin/mkfifo', [file]);
  assert.equal(readSuggestion(chat, { dir }), null, 'a FIFO, returned at once');
  rmSync(file, { force: true });
});
