// The Playbook and its Lessons. Every test uses a throwaway state folder and made-up Lessons.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EVERYWHERE, PLAYBOOK_FILE, PlaybookError, addLesson, findMove, findSituation, lessonsFile, readLessons, readPlaybook, readRemovedLessons, removeLesson, sameMove, sectionParts } from '../scripts/lib/playbook.mjs';

const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');
const fresh = () => mkdtempSync(join(tmpdir(), 'ba-playbook-'));
const DAY = 86_400_000;
const run = (home, args, extra = {}) => spawnSync(process.execPath, [BA, ...args], { env: { ...process.env, BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: home, ...extra }, encoding: 'utf8' });

const FIXTURE = `# Playbook

How to use it.

## Hard news

When: they share a loss or a setback

- Acknowledge before offering anything.

Books: Author, *Book*.

## Their good news

When: a promotion or a launch

- Ask about the part they seem proudest of.

Books: Author, *Book*.

## Reconnecting after a long gap

When: months of silence with someone the Owner once knew well, or the Owner asks to check in

- Open with what reminded you of them.

Books: Author, *Book*.

## Following up when they went quiet

When: the Owner's message sat unanswered, or they say "she never replied"

- Keep the plan by name.

Books: Author, *Book*.

## Tension and repair

When: a thread went cold, or the Owner asks how to apologize or raise a grievance

- Name the impact, not the reason.

Books: Author, *Book*.
`;

// One section's parts, in the order the file gives them.
const parts = (text) => {
  const lines = text.split('\n').filter(Boolean);
  const avoid = lines.indexOf('Avoid:');
  return { moves: lines.slice(1, avoid).filter((l) => l.startsWith('- ')), avoid: avoid < 0 ? [] : lines.slice(avoid + 1).filter((l) => l.startsWith('- ')), example: lines.filter((l) => l.startsWith('Example: ')), books: lines.filter((l) => l.startsWith('Books: ')), last: lines.at(-1) };
};

test('the shipped Playbook parses, and every situation has cues, moves, an Avoid list, an example, and one line of books', () => {
  const { intro, situations } = readPlaybook(PLAYBOOK_FILE);
  assert.ok(situations.length >= 10, `only ${situations.length} situations`);
  assert.match(intro, /books it draws on/);
  for (const s of situations) {
    assert.ok(s.when, `${s.name} has no When line`);
    const p = parts(s.text);
    assert.ok(p.moves.length >= 5 && p.moves.length <= 7, `${s.name} has ${p.moves.length} moves`);
    assert.ok(p.avoid.length >= 2, `${s.name} has no Avoid list`);
    assert.equal(p.example.length, 1, `${s.name} needs one example`);
    assert.equal(p.books.length, 1, `${s.name} needs one Books line`);
    assert.equal(p.last, p.books[0], `${s.name}'s Books line comes last`);
    assert.match(p.books[0], /^Books: [^;]+, \*[^*]+\*(; [^;]+, \*[^*]+\*)*\.$/, `${s.name}'s Books line lists Author, *Title* pairs`);
    // Moves carry no per-move citation since 2026-10-18; the Books line names them once.
    for (const line of [...p.moves, ...p.avoid]) assert.doesNotMatch(line, /\*[^*]+\*\)?$|\([A-Z][a-z]+, \*/, `${s.name} still cites a book in: ${line.slice(0, 60)}`);
    assert.doesNotMatch(s.text, /—/, `${s.name} has an em dash`);
  }
  assert.equal(new Set(situations.map((s) => s.name)).size, situations.length, 'situation names are unique');
});

test('no move offers help the Owner never named', () => {
  // The Owner's rule of 2026-10-13: an offer of help is one the Owner named. A move that tells an
  // agent to offer help says so in the same line.
  for (const s of readPlaybook(PLAYBOOK_FILE).situations) {
    for (const move of parts(s.text).moves.filter((m) => /\boffer\b/i.test(m) && /struggling|need anything|hard news|setback|\bhelp\b/i.test(m))) {
      assert.match(move, /Owner named/, `${s.name}: ${move.slice(0, 70)}`);
    }
  }
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

test('a loose name finds its situation: run together, another ending, or another spelling', () => {
  const dir = fresh();
  const file = join(dir, 'playbook.md');
  writeFileSync(file, FIXTURE);
  const p = readPlaybook(file);
  for (const loose of ['followup', 'follow-up', 'follow up', 'never replied']) assert.equal(findSituation(p, loose).name, 'Following up when they went quiet', loose);
  for (const loose of ['apology', 'apologise', 'apologizing']) assert.equal(findSituation(p, loose).name, 'Tension and repair', loose);
  assert.equal(findSituation(p, 'checkin').name, 'Reconnecting after a long gap');
  assert.equal(findSituation(p, 'reconnecting').name, 'Reconnecting after a long gap');
  // Four shared letters aren't enough: grief is not a grievance.
  assert.throws(() => findSituation(p, 'grief'), /No situation matches "grief"/);
  assert.throws(() => findSituation(p, 'news'), /fits more than one situation/);
});

test('a word that starts one keeps its old match, and a loose fit is tried only when nothing starts', () => {
  const dir = fresh();
  const file = join(dir, 'playbook.md');
  // "replies" fits "replied" loosely, but "replied" starts a word in one situation only.
  writeFileSync(file, `${FIXTURE}\n## Reading how they feel\n\nWhen: replies get shorter\n\n- Read the change.\n\nBooks: Author, *Book*.\n`);
  const p = readPlaybook(file);
  assert.equal(findSituation(p, 'replied').name, 'Following up when they went quiet');
  assert.throws(() => findSituation(p, 'reply'), /fits more than one situation. Use one of: Following up when they went quiet, Reading how they feel,/);
});

test('words that fit no situation get every title back, the closest first, and never a guess', () => {
  const dir = fresh();
  const file = join(dir, 'playbook.md');
  writeFileSync(file, FIXTURE);
  const p = readPlaybook(file);
  assert.throws(() => findSituation(p, 'a loss and a setback'), (e) => e instanceof PlaybookError && /^No situation matches "a loss and a setback"\. Run it again with one of these titles, the closest first: Hard news, Their good news,/.test(e.message));
  // With nothing shared, the titles keep the file's order.
  assert.throws(() => findSituation(p, 'wedding toast'), /the closest first: Hard news, Their good news, Reconnecting after a long gap, Following up when they went quiet, Tension and repair, or Everywhere\.$/);
});

test('ba playbook finds a situation by a loose name, as agents type them', () => {
  const home = fresh();
  for (const loose of ['followup', 'intro', 'hard-news', 'congrats']) {
    const r = run(home, ['playbook', loose]);
    assert.equal(r.status, 0, `${loose}: ${r.stderr}`);
    assert.match(r.stdout, /^PLAYBOOK · .+$/m);
  }
  assert.match(run(home, ['playbook', 'followup']).stdout, /^PLAYBOOK · Following up when they went quiet$/m);
  // A description is the agent's to resolve: the titles come back with the closest first.
  const described = run(home, ['playbook', 'friend got laid off']);
  assert.equal(described.status, 2);
  assert.match(described.stderr, /No situation matches "friend got laid off"\. Run it again with one of these titles, the closest first: Hard news, /);
  const learned = run(home, ['learn', 'friend got laid off', '--text', 'x', '--why', 'y']);
  assert.equal(learned.status, 2);
  assert.match(learned.stderr, /No situation matches/);
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
  const dir = fresh(), T0 = Date.parse('2026-10-01T12:00:00Z');
  addLesson({ situation: 'Hard news', text: 'first', why: 'a' }, { dir, now: T0 });
  writeFileSync(lessonsFile(dir), readFileSync(lessonsFile(dir), 'utf8').trimEnd());
  addLesson({ situation: 'Hard news', text: 'second', why: 'b' }, { dir, now: T0 + 8 * DAY });
  writeFileSync(lessonsFile(dir), `${readFileSync(lessonsFile(dir), 'utf8')}{"id":"cut`);
  addLesson({ situation: 'Hard news', text: 'third', why: 'c' }, { dir, now: T0 + 16 * DAY });
  assert.deepEqual(readLessons(dir).map((l) => l.text), ['first', 'second', 'third']);
});

test('ba learn reads the Lesson from stdin with --text -', () => {
  const home = fresh();
  const r = spawnSync(process.execPath, [BA, 'learn', 'everywhere', '--text', '-', '--why', 'shortened two drafts'], { env: { ...process.env, BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: home }, input: 'Keep replies to one line\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readLessons(home).map((l) => l.text), ['Keep replies to one line']);
});

test('a Lesson keeps the drafts that showed it, and its removal keeps them and when it was saved', () => {
  const dir = fresh();
  const saved = addLesson({ situation: 'Hard news', text: 'End on a plan', why: 'three edits', drafts: ['s1', 's2', 's2', 's3'] }, { dir });
  assert.equal(saved.status, 'added');
  assert.deepEqual(saved.lesson.drafts, ['s1', 's2', 's3']);
  const agent = addLesson({ situation: 'Hard news', text: 'second', why: 'an agent' }, { dir }).lesson;
  assert.throws(() => addLesson({ situation: 'Hard news', text: 'x', why: 'y', drafts: ['bad id'] }, { dir }), /IDs/);
  assert.equal(removeLesson(saved.lesson.id, 'End on a plan', { dir }).status, 'removed');
  const [gone] = readRemovedLessons(dir);
  assert.deepEqual(gone.drafts, ['s1', 's2', 's3']);
  assert.equal(gone.savedAt, saved.lesson.at);
  removeLesson(agent.id, 'second', { dir });
  assert.ok(!('drafts' in readRemovedLessons(dir)[1]), "an agent's Lesson has no drafts to keep");
  assert.equal(readRemovedLessons(dir)[1].savedAt, agent.at, 'so the week still counts it');
});

// ADR 0117's caps, for agents' `ba learn` and the Companion's weekly look together.
test('every writer shares two Lessons a week, kept or removed since, and the week says when it opens', () => {
  const dir = fresh(), T0 = Date.parse('2026-10-11T12:00:00Z');
  const add = (situation, text, now, extra = {}) => addLesson({ situation, text, why: 'made-up', ...extra }, { dir, now });
  assert.equal(add('Hard news', 'one', T0).status, 'added');
  assert.equal(add(EVERYWHERE, 'two', T0 + DAY, { by: 'the weekly look at your edits', drafts: ['s1', 's2', 's3'] }).status, 'added');
  assert.deepEqual(add('Their good news', 'three', T0 + 2 * DAY), { status: 'full', cap: 'week', opens: new Date(T0 + 7 * DAY).toISOString() });
  assert.deepEqual(readLessons(dir).map((l) => l.text), ['one', 'two'], 'nothing written');
  assert.equal(add('Their good news', 'three', T0 + 7 * DAY).status, 'added', 'the first is a week old');
  const three = readLessons(dir).find((l) => l.text === 'three');
  assert.equal(removeLesson(three.id, 'three', { dir, now: T0 + 7 * DAY + 1 }).status, 'removed');
  assert.deepEqual(add('Their good news', 'four', T0 + 7 * DAY + 2), { status: 'full', cap: 'week', opens: new Date(T0 + 8 * DAY).toISOString() }, 'a removal makes no room in the week');
  // Answers that save nothing come first, so a full week never hides them.
  assert.equal(add(EVERYWHERE, 'TWO', T0 + 7 * DAY + 3).status, 'duplicate');
  assert.equal(add('Their good news', 'three', T0 + 7 * DAY + 3).status, 'removed');
});

test('a situation keeps three Lessons, named before a full week, and a removal there makes room', () => {
  const dir = fresh(), T0 = Date.parse('2026-09-01T12:00:00Z');
  const add = (text, now, situation = 'Hard news') => addLesson({ situation, text, why: 'made-up' }, { dir, now });
  for (let i = 0; i < 3; i++) assert.equal(add(`move ${i}`, T0 + i * 8 * DAY).status, 'added');
  const later = T0 + 30 * DAY;
  assert.deepEqual(add('move 3', later), { status: 'full', cap: 'situation' });
  assert.equal(add('move 3', later, EVERYWHERE).status, 'added', 'the cap counts its own situation');
  add('another', later + 1, 'Their good news');
  assert.deepEqual(add('move 3', later + 2), { status: 'full', cap: 'situation' }, 'the situation is named first: waiting never makes room there');
  removeLesson(readLessons(dir)[0].id, 'move 0', { dir, now: later + 3 });
  assert.deepEqual(add('move 3', later + 4), { status: 'full', cap: 'week', opens: new Date(later + 7 * DAY).toISOString() });
  assert.equal(add('move 3', later + 7 * DAY).status, 'added');
});

test('a removal recorded before removals kept savedAt counts for no week and still stays removed', () => {
  const dir = fresh(), now = Date.parse('2026-10-19T12:00:00Z');
  // As removeLesson wrote an agent's Lesson until 2026-10-19: no drafts and no savedAt.
  writeFileSync(join(dir, 'lessons-removed.jsonl'), `${JSON.stringify({ id: 'l1111111', situation: 'Hard news', text: 'Old removed one', at: new Date(now - DAY).toISOString() })}\n`);
  addLesson({ situation: 'Hard news', text: 'Kept one', why: 'made-up' }, { dir, now: now - DAY });
  assert.equal(addLesson({ situation: 'Hard news', text: 'old removed one', why: 'again' }, { dir, now }).status, 'removed');
  assert.equal(addLesson({ situation: EVERYWHERE, text: 'New one', why: 'made-up' }, { dir, now }).status, 'added');
});

test('writers racing for the last places in the week save no more than two', async () => {
  const dir = fresh();
  const lib = new URL('../scripts/lib/playbook.mjs', import.meta.url).href;
  const one = (i) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { addLesson } from ${JSON.stringify(lib)};
      process.stdout.write(addLesson({ situation: 'Hard news', text: 'Racing ${i}', why: 'made-up' }, { dir: ${JSON.stringify(dir)} }).status);`]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
  });
  const statuses = await Promise.all([1, 2, 3, 4, 5].map(one));
  assert.equal(statuses.filter((s) => s === 'added').length, 2, statuses.join(', '));
  assert.equal(statuses.filter((s) => s === 'full').length, 3, statuses.join(', '));
  assert.equal(readLessons(dir).length, 2);
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

test('ba learn refuses past either cap with what to do, and saves nothing', () => {
  const home = fresh();
  const s = readPlaybook().situations[0].name;
  // Oldest first, as writers save them.
  for (let i = 3; i >= 1; i--) addLesson({ situation: s, text: `made-up ${i}`, why: 'made-up' }, { dir: home, now: Date.now() - i * 10 * DAY });
  const situation = run(home, ['learn', s, '--text', 'One more', '--why', 'made-up', '--by', 'claude']);
  assert.equal(situation.status, 2);
  assert.ok(situation.stderr.includes(`usage: Not saved. ${s} already has 3 Lessons, the most one situation keeps. The Owner can remove one on the Playbook page to make room. Nothing changed.`), situation.stderr);
  addLesson({ situation: EVERYWHERE, text: 'From an agent', why: 'made-up' }, { dir: home, now: Date.now() - 2 * DAY });
  addLesson({ situation: EVERYWHERE, text: 'From the weekly look', why: 'made-up', drafts: ['s1', 's2', 's3'] }, { dir: home, now: Date.now() - DAY });
  const week = run(home, ['learn', 'everywhere', '--text', 'One more', '--why', 'made-up', '--by', 'claude']);
  assert.equal(week.status, 2);
  assert.match(week.stderr, /^usage: Not saved\. 2 Lessons were saved in the last 7 days, the most a week takes, counting the Beeper Companion's weekly look and any the Owner removed since\. The next can be saved after .+\. Nothing changed\.$/m);
  assert.equal(readLessons(home).length, 5);
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

// A section as it reads from 2026-10-18: no citation on a move, and one Books line at the end.
const BOOKS_FORMAT = `## Saying no

When: they ask for a favor the Owner can't do

- Say no in the first line. Burying it reads as a maybe.
- Give the reason as the Owner gave it.

Avoid:
- Offering help the Owner never offered.

Example: Rae asks for a ride on Sunday. Send "Can't Sunday, sorry, I'm away."
Books: Invented, *A Book*; Made Up, *Another Book*.
`;

test('a section splits into moves, Avoid lines, its Example, and its Books line, in either format', () => {
  const s = sectionParts(BOOKS_FORMAT.split('\n').slice(2).join('\n'));
  assert.deepEqual(s.moves, [
    { n: 1, kind: 'move', text: 'Say no in the first line. Burying it reads as a maybe.' },
    { n: 2, kind: 'move', text: 'Give the reason as the Owner gave it.' },
    { n: 3, kind: 'avoid', text: 'Offering help the Owner never offered.' }]);
  assert.match(s.example, /^Rae asks/);
  assert.equal(s.books, 'Invented, *A Book*; Made Up, *Another Book*.');
  assert.deepEqual(s.other, []);
  // The format before 2026-10-18, a citation on every move and no Books line.
  const old = sectionParts('When: they share a loss\n\n- Acknowledge before offering anything. (Author, *Book*)\n');
  assert.deepEqual(old.moves, [{ n: 1, kind: 'move', text: 'Acknowledge before offering anything. (Author, *Book*)' }]);
  assert.equal(old.books, null);
  const dir = fresh(), file = join(dir, 'playbook.md');
  writeFileSync(file, FIXTURE);
  const hard = readPlaybook(file).situations[0];
  assert.deepEqual(hard.moves, [{ n: 1, kind: 'move', text: 'Acknowledge before offering anything.' }]);
  assert.equal(hard.books, 'Author, *Book*.');
  for (const s of readPlaybook(PLAYBOOK_FILE).situations) assert.ok(s.moves.some((m) => m.kind === 'move'), `${s.name} parses no move`);
});

test('a change finds its move again without its citation, or by its first sentence, and never a second match', () => {
  const moves = [
    { n: 1, kind: 'move', text: 'Say no in the first line. Burying it reads as a maybe.' },
    { n: 2, kind: 'move', text: 'Give the reason as the Owner gave it.' },
  ];
  assert.equal(findMove(moves, 'Say no in the first line. Burying it reads as a maybe. (Invented, *A Book*)').n, 1);
  assert.equal(findMove(moves, 'Say no in the first line. A long why sentence that a trim removed.').n, 1);
  assert.equal(findMove(moves, 'give the reason as the owner gave it').n, 2);
  assert.equal(findMove(moves, 'A move an update took out.'), null);
  assert.equal(findMove([...moves, { n: 3, kind: 'avoid', text: 'Say no in the first line. Something else.' }], 'Say no in the first line. Different why.'), null);
  assert.ok(sameMove('Give the reason as the Owner gave it. (A, *B*)', 'give the reason as the Owner gave it'));
});

test('a removed Lesson leaves the others byte for byte, and no agent saves it again', () => {
  const dir = fresh();
  const keep = addLesson({ situation: 'Hard news', text: 'Keep it short', why: 'a' }, { dir, now: Date.now() - 20 * DAY }).lesson;
  const gone = addLesson({ situation: 'Hard news', text: 'Skip the check-in', why: 'b', move: 'Check in later.' }, { dir, now: Date.now() - 10 * DAY }).lesson;
  writeFileSync(lessonsFile(dir), `${readFileSync(lessonsFile(dir), 'utf8')}{damaged\n`);
  assert.equal(removeLesson(gone.id, 'Different words', { dir }).status, 'stale', 'words the page showed that changed since');
  assert.equal(removeLesson(gone.id, gone.text, { dir }).status, 'removed');
  assert.equal(readFileSync(lessonsFile(dir), 'utf8'), `${JSON.stringify(keep)}\n{damaged\n`);
  assert.equal(statSync(lessonsFile(dir)).mode & 0o777, 0o600);
  assert.equal(removeLesson(gone.id, gone.text, { dir }).status, 'missing');
  assert.equal(addLesson({ situation: 'Hard news', text: 'skip the check-in', why: 'again' }, { dir }).status, 'removed');
  assert.equal(addLesson({ situation: 'Their good news', text: 'Skip the check-in', why: 'another situation' }, { dir }).status, 'added');
  assert.deepEqual(readRemovedLessons(dir).map((l) => [l.id, l.situation]), [[gone.id, 'Hard news']]);
  assert.equal(readLessons(dir).find((l) => l.id === keep.id).move, undefined);
});

test("a removal waits for a Lesson another process is saving, so the rename never drops it, and a dead holder's lock is broken", async () => {
  const dir = fresh();
  const gone = addLesson({ situation: 'Hard news', text: 'Remove me', why: 'a' }, { dir, now: Date.now() - 10 * DAY }).lesson;
  const lib = new URL('../scripts/lib/playbook.mjs', import.meta.url).href;
  // Another process takes the lock, waits, then saves a Lesson, as an agent's ba learn would.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { withLessonsLock, addLesson } from ${JSON.stringify(lib)};
    withLessonsLock(${JSON.stringify(dir)}, () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); });
    addLesson({ situation: 'Hard news', text: 'Saved meanwhile', why: 'b' }, { dir: ${JSON.stringify(dir)} });`]);
  await new Promise((resolve) => child.stdout.once('data', resolve));
  assert.equal(removeLesson(gone.id, gone.text, { dir }).status, 'removed', 'waits for the lock, then removes');
  await new Promise((resolve) => child.on('close', resolve));
  assert.deepEqual(readLessons(dir).map((l) => l.text), ['Saved meanwhile']);
  mkdirSync(join(dir, 'lessons.lock'));
  utimesSync(join(dir, 'lessons.lock'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(addLesson({ situation: 'Hard news', text: 'After a dead holder', why: 'c' }, { dir }).status, 'added');
  assert.throws(() => statSync(join(dir, 'lessons.lock')), /ENOENT/);
});

test('ba learn --move saves the move a Lesson changes, and ba playbook says the Owner\'s changes went unread without the Companion', () => {
  const home = fresh();
  const s = readPlaybook().situations[0];
  const saved = run(home, ['learn', s.name, '--text', 'Shorter', '--why', 'cut three drafts', '--move', '1']);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(readLessons(home)[0].move, s.moves[0].text);
  assert.equal(run(home, ['learn', s.name, '--text', 'x', '--why', 'y', '--move', '99']).status, 2);
  const shown = run(home, ['playbook', s.name]);
  assert.match(shown.stdout, /^THE OWNER'S CHANGES · 0\nNot read: Beeper Companion didn't answer/m);
  const json = JSON.parse(run(home, ['playbook', s.name, '--json']).stdout);
  assert.deepEqual(json.changes, []);
  assert.equal(json.moves[0].n, 1);
});
