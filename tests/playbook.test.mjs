// The Playbook and its Lessons. Every test uses a throwaway state folder and made-up Lessons.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EVERYWHERE, PLAYBOOK_FILE, PlaybookError, addLesson, findSituation, lessonsFile, readLessons, readPlaybook } from '../scripts/lib/playbook.mjs';

const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');
const fresh = () => mkdtempSync(join(tmpdir(), 'ba-playbook-'));
const run = (home, args, extra = {}) => spawnSync(process.execPath, [BA, ...args], { env: { ...process.env, BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: home, ...extra }, encoding: 'utf8' });

const FIXTURE = `# Playbook

How to use it.

## Hard news

When: they share a loss or a setback

- Acknowledge before offering anything. (Author, *Book*)

## Their good news

When: a promotion or a launch

- Ask about the part they seem proudest of. (Author, *Book*)

## Reconnecting after a long gap

When: months of silence with someone the Owner once knew well

- Open with what reminded you of them. (Author, *Book*)
`;

test('the shipped Playbook parses, and every situation has a When line and sourced moves', () => {
  const { situations } = readPlaybook(PLAYBOOK_FILE);
  assert.ok(situations.length >= 10, `only ${situations.length} situations`);
  for (const s of situations) {
    assert.ok(s.when, `${s.name} has no When line`);
    assert.match(s.text, /^- .+\(.+, \*.+\*\)$/m, `${s.name} has no sourced move`);
    assert.doesNotMatch(s.text, /—/, `${s.name} has an em dash`);
  }
  assert.equal(new Set(situations.map((s) => s.name)).size, situations.length, 'situation names are unique');
});

test('a situation is found by its name, by words in it, or by its cues', () => {
  const dir = fresh();
  const file = join(dir, 'playbook.md');
  writeFileSync(file, FIXTURE);
  const p = readPlaybook(file);
  assert.equal(p.intro, 'How to use it.');
  assert.equal(findSituation(p, 'Hard news').name, 'Hard news');
  assert.equal(findSituation(p, 'reconnect').name, 'Reconnecting after a long gap');
  assert.equal(findSituation(p, 'promotion').name, 'Their good news');
  assert.equal(findSituation(p, 'everywhere').name, EVERYWHERE);
  assert.throws(() => findSituation(p, 'wedding toast'), (e) => e instanceof PlaybookError && /No situation matches/.test(e.message) && /Hard news, Their good news/.test(e.message));
  assert.throws(() => findSituation(p, ''), PlaybookError);
});

test('a Lesson is saved once, private to the Owner, and read back', () => {
  const dir = fresh();
  const T0 = Date.parse('2026-10-11T12:00:00Z');
  const r = addLesson({ situation: 'Hard news', text: '  Offer one practical thing\nbefore any sympathy ', why: 'rewrote two drafts that opened with sorry', by: 'claude' }, { dir, now: T0 });
  assert.equal(r.status, 'added');
  assert.match(r.lesson.id, /^l[0-9a-f]{7}$/);
  assert.equal(r.lesson.text, 'Offer one practical thing before any sympathy');
  assert.equal(r.lesson.at, new Date(T0).toISOString());
  assert.equal(statSync(lessonsFile(dir)).mode & 0o777, 0o600);
  assert.equal(addLesson({ situation: 'Hard news', text: 'offer one practical thing before any sympathy', why: 'again', by: 'codex' }, { dir }).status, 'duplicate');
  assert.deepEqual(readLessons(dir).map((l) => l.text), ['Offer one practical thing before any sympathy']);
});

test('a damaged line never hides the other Lessons', () => {
  const dir = fresh();
  addLesson({ situation: 'Hard news', text: 'first', why: 'a' }, { dir });
  writeFileSync(lessonsFile(dir), `${readFileSync(lessonsFile(dir), 'utf8')}{not json\n`);
  addLesson({ situation: EVERYWHERE, text: 'second', why: 'b' }, { dir });
  assert.deepEqual(readLessons(dir).map((l) => l.text), ['first', 'second']);
});

test('a file whose last line lost its newline keeps every Lesson', () => {
  const dir = fresh();
  addLesson({ situation: 'Hard news', text: 'first', why: 'a' }, { dir });
  writeFileSync(lessonsFile(dir), readFileSync(lessonsFile(dir), 'utf8').trimEnd());
  addLesson({ situation: 'Hard news', text: 'second', why: 'b' }, { dir });
  writeFileSync(lessonsFile(dir), `${readFileSync(lessonsFile(dir), 'utf8')}{"id":"cut`);
  addLesson({ situation: 'Hard news', text: 'third', why: 'c' }, { dir });
  assert.deepEqual(readLessons(dir).map((l) => l.text), ['first', 'second', 'third']);
});

test('ba learn reads the Lesson from stdin with --text -', () => {
  const home = fresh();
  const r = spawnSync(process.execPath, [BA, 'learn', 'everywhere', '--text', '-', '--why', 'shortened two drafts'], { env: { ...process.env, BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: home }, input: 'Keep replies to one line\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readLessons(home).map((l) => l.text), ['Keep replies to one line']);
});

test('a Lesson without text or a reason, or too long, is refused before anything is written', () => {
  const dir = fresh();
  assert.throws(() => addLesson({ situation: 'Hard news', text: ' ', why: 'x' }, { dir }), /--text/);
  assert.throws(() => addLesson({ situation: 'Hard news', text: 'x', why: '' }, { dir }), /--why/);
  assert.throws(() => addLesson({ situation: 'Hard news', text: 'x'.repeat(301), why: 'y' }, { dir }), /under 300/);
  assert.deepEqual(readLessons(dir), []);
});

test('ba learn saves a Lesson that ba playbook then prints with its situation', () => {
  const home = fresh();
  const situation = readPlaybook().situations[0].name;
  const saved = run(home, ['learn', situation, '--text', 'Keep it to one line', '--why', 'cut a long draft to one line', '--by', 'claude']);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, new RegExp(`Lesson l[0-9a-f]{7} saved for ${situation}`));
  const everywhere = run(home, ['learn', 'everywhere', '--text', 'No exclamation marks', '--why', 'removed them from three drafts']);
  assert.equal(everywhere.status, 0, everywhere.stderr);
  const shown = run(home, ['playbook', ...situation.split(' ')]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`^PLAYBOOK · ${situation}$`, 'm'));
  assert.match(shown.stdout, /LESSONS for this Owner · 2/);
  assert.match(shown.stdout, /- Keep it to one line \(why: cut a long draft to one line\. claude, \d{4}-\d\d-\d\d, l[0-9a-f]{7}\)/);
  const list = run(home, ['playbook']);
  assert.match(list.stdout, new RegExp(`^${situation} · 1 Lesson$`, 'm'));
  assert.match(list.stdout, /LESSONS for every situation · 1/);
  const json = JSON.parse(run(home, ['playbook', '--json']).stdout);
  assert.equal(json.situations.length, readPlaybook().situations.length);
});

test('ba learn refuses a reserved author, an unknown situation, and read-only mode', () => {
  const home = fresh();
  const reserved = run(home, ['learn', 'everywhere', '--text', 'x', '--why', 'y', '--by', 'owner']);
  assert.equal(reserved.status, 2);
  assert.match(reserved.stderr, /reserved/);
  const unknown = run(home, ['learn', 'wedding toast', '--text', 'x', '--why', 'y']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /No situation matches/);
  const readonly = run(home, ['learn', 'everywhere', '--text', 'x', '--why', 'y'], { BEEPER_ASSISTANT_MODE: 'readonly' });
  assert.equal(readonly.status, 2);
  assert.match(readonly.stderr, /Read-only mode is on/);
  assert.equal(run(home, ['playbook'], { BEEPER_ASSISTANT_MODE: 'readonly' }).status, 0);
  assert.equal(run(home, ['learn', 'everywhere', '--text', 'x', '--why', 'y'], { BEEPER_ASSISTANT_MODE: 'drafts' }).status, 0);
  assert.deepEqual(readLessons(home).map((l) => l.text), ['x']);
});
