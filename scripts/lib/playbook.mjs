// The Playbook and its Lessons (ADR 0109). The Playbook is the skill's references/playbook.md: one
// section per situation, distilled from books on people, the same for every Owner. A Lesson is one
// line an agent saved about how this Owner differs in one situation, kept in the state folder.
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './state.mjs';

export class PlaybookError extends Error {}

// Null where this module has no URL of its own, as inside the Companion's bundle, which names its
// copy of the file instead.
export const PLAYBOOK_FILE = (() => { try { return fileURLToPath(new URL('../../references/playbook.md', import.meta.url)); } catch { return null; } })();
// A Lesson for no one situation, shown with every one.
export const EVERYWHERE = 'Everywhere';
export const LESSON_CHARS = 300;

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

// The file's h2 sections, each with its When line. Text above the first one is the intro.
// moves, example, and books: the section's parts (sectionParts), for the Playbook page and for
// placing the Owner's changes and Lessons under the move they change.
/** @typedef {{n: number, kind: 'move'|'avoid', text: string}} Move */
/** @typedef {{name: string, when: string, text: string, moves: Move[], example: string|null, books: string|null, other: string[]}} Situation */
/** @returns {{intro: string, situations: Situation[]}} */
export function readPlaybook(file = PLAYBOOK_FILE) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const [intro, ...parts] = text.split(/^## /m);
  const situations = parts.map((part) => {
    const [name, ...body] = part.split('\n');
    const section = body.join('\n').trim();
    const when = section.match(/^When: (.+)$/m)?.[1] ?? '';
    return { name: name.trim(), when, text: section, ...sectionParts(section) };
  });
  return { intro: intro.replace(/^# .*\n/, '').trim(), situations };
}

// A word without its -s, -ed, or -ing, when four letters stay, and with a last y as i when four
// letters come before it: "feelings" and "feel" meet at "feel", "reply" and "replied" at "repli".
const stem = (w) => w.replace(/(?:ings?|ed|s)$/, (end, at) => (at >= 4 ? '' : end)).replace(/(?<=.{4})y$/, 'i');
// A word fits one in the text when it starts it. Loosely, it also fits when its stem starts the
// other's, when their stems share five letters and three quarters of the word's ("followup" and
// "following", "apology" and "apologize", never "grief" and "grievance"), or when it runs on into
// the next word ("checkin").
const starts = (w, have) => have.some((h) => h.startsWith(w));
const loosely = (w, have) => have.some((h, i) => {
  const [a, b] = [stem(w), stem(h)];
  if (h.startsWith(w) || b.startsWith(a)) return true;
  let same = 0;
  while (same < a.length && a[same] === b[same]) same += 1;
  if (same >= Math.max(5, Math.ceil(a.length * 0.75))) return true;
  return w.length > h.length && w.startsWith(h) && loosely(w.slice(h.length), have.slice(i + 1, i + 2));
});

// A section's parts. A move is one "- " line: before the "Avoid:" line, something to do, and after
// it, something to leave out (kind avoid). n counts every move in the section from 1, as `ba app
// playbook` commands name one. The Example line and the Books line, when there are, and any other
// line, kept in order as text, so a new kind of line still shows.
/** @returns {{moves: Move[], example: string|null, books: string|null, other: string[]}} */
export function sectionParts(section) {
  /** @type {{moves: Move[], example: string|null, books: string|null, other: string[]}} */
  const parts = { moves: [], example: null, books: null, other: [] };
  let avoid = false;
  for (const raw of String(section).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('When: ')) continue;
    if (/^Avoid:$/.test(line)) { avoid = true; continue; }
    const move = line.match(/^- (.+)$/);
    if (move) parts.moves.push({ n: parts.moves.length + 1, kind: avoid ? 'avoid' : 'move', text: move[1].trim() });
    else if (line.startsWith('Example: ')) parts.example = line.slice('Example: '.length).trim();
    else if (line.startsWith('Books: ')) parts.books = line.slice('Books: '.length).trim();
    else parts.other.push(line);
  }
  return parts;
}

// How a saved change or Lesson finds its move again after an update rewrites the file: the same
// words, without a trailing book citation, case, or punctuation; else the only move that opens with
// the same first sentence. A move that matches neither is gone from the Playbook, and what was
// saved for it shows with the words it was saved for.
const CITATION = /\s*\([^()]*\*[^()*]+\*[^()]*\)\s*$/;
const plain = (text) => String(text).replace(CITATION, '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const opening = (text) => plain(String(text).replace(CITATION, '').split(/(?<=[.!?])\s+/)[0]);
export function findMove(moves, words) {
  if (typeof words !== 'string' || !words.trim()) return null;
  const same = moves.filter((m) => plain(m.text) === plain(words));
  if (same.length === 1) return same[0];
  const opens = moves.filter((m) => opening(m.text) === opening(words));
  return opens.length === 1 ? opens[0] : null;
}
// The same move, as findMove reads it: for a change that names the words the Owner saw.
export const sameMove = (a, b) => plain(a) === plain(b);

// The one situation these words name: an exact name, else the only name holding every word, else
// the only name and cues holding every word. A word counts when it starts one there, and only when
// that finds nothing, when it fits one loosely. Code never guesses past that (0134): words that fit no
// situation get the titles back, those whose names and cues share the most of the words first, and
// the agent names one.
export function findSituation(playbook, query) {
  const want = words(query);
  if (!want.length) throw new PlaybookError('Name a situation. Run playbook to see the list.');
  if (want.join(' ') === EVERYWHERE.toLowerCase()) return { name: EVERYWHERE, when: 'any situation', text: '' };
  const exact = playbook.situations.find((s) => words(s.name).join(' ') === want.join(' '));
  if (exact) return exact;
  for (const fit of [starts, loosely]) {
    const holds = (text) => { const have = words(text); return want.every((w) => fit(w, have)); };
    const byName = playbook.situations.filter((s) => holds(s.name));
    const hits = byName.length ? byName : playbook.situations.filter((s) => holds(`${s.name} ${s.when}`));
    if (hits.length === 1) return hits[0];
    if (hits.length) throw new PlaybookError(`"${query}" fits more than one situation. Use one of: ${hits.map((s) => s.name).join(', ')}, or ${EVERYWHERE}.`);
  }
  const shared = (s) => { const have = words(`${s.name} ${s.when}`); return want.filter((w) => w.length > 3 && loosely(w, have)).length; };
  const ranked = playbook.situations.map((s, i) => ({ s, i, n: shared(s) })).sort((a, b) => b.n - a.n || a.i - b.i);
  throw new PlaybookError(`No situation matches "${query}". Run it again with one of these titles, the closest first: ${ranked.map((r) => r.s.name).join(', ')}, or ${EVERYWHERE}.`);
}

export const lessonsFile = (dir = stateDir()) => join(dir, 'lessons.jsonl');

// Lines that don't parse are skipped, so one bad line never hides the rest.
export function readLessons(dir) {
  let text = '';
  try { text = readFileSync(lessonsFile(dir), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => { try { const l = JSON.parse(line); return l && l.id && l.situation && l.text ? [l] : []; } catch { return []; } });
}

const oneLine = (s, what) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) throw new PlaybookError(`Give ${what}.`);
  if (t.length > LESSON_CHARS) throw new PlaybookError(`Keep ${what} under ${LESSON_CHARS} characters. Nothing was saved.`);
  return t;
};

// Lessons the Owner removed on the Playbook page, one line each: the id, situation, and text, so no
// agent saves the same one again. Its own file, so an older skill copy reading lessons.jsonl never
// shows a removed Lesson.
export const removedLessonsFile = (dir = stateDir()) => join(dir, 'lessons-removed.jsonl');
// Saving and removing Lessons take one lock, a folder beside the file, so a removal's rename never
// drops a Lesson saved meanwhile. A holder that died leaves a lock older than LOCK_STALE_MS, which the
// next writer breaks. A skill copy from before removal appends without it; removal reads the file
// again before its rename for that case.
const LOCK_STALE_MS = 30_000, LOCK_WAIT_MS = 5_000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function withLessonsLock(dir, fn) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'lessons.lock');
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmdirSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) throw new PlaybookError('Another agent is saving a Lesson. Try again in a moment. Nothing was changed.');
      pause(20);
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch { /* already broken as stale */ } }
}

export function readRemovedLessons(dir) {
  let text = '';
  try { text = readFileSync(removedLessonsFile(dir), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => { try { const l = JSON.parse(line); return l && l.id && l.situation && l.text ? [l] : []; } catch { return []; } });
}
const sameLesson = (a, b) => a.situation === b.situation && a.text.toLowerCase() === b.text.toLowerCase();

// ADR 0117's caps, for every writer together: an agent's `ba learn` and the Companion's weekly look
// at the Owner's edits share them. At most WEEK_CAP new Lessons in any seven days, and SITUATION_CAP
// kept for one situation. A Lesson counts for the week from when it was saved, kept or removed
// since, so removing one makes room in its situation but not in the week. A removal record from
// before 2026-10-19 without savedAt, an agent's Lesson then, counts for no week.
export const WEEK_CAP = 2, SITUATION_CAP = 3;
const WEEK_MS = 7 * 86_400_000;
export function lessonRoom(lessons, removed, now) {
  // By id, since a removal cut off before its rename leaves the Lesson in both files. One saved
  // after now, as by a clock set back, counts too.
  const savedAt = new Map([...removed.map((l) => [l.id, l.savedAt]), ...lessons.map((l) => [l.id, l.at])]);
  const week = [...savedAt.values()].map((t) => (typeof t === 'string' ? Date.parse(t) : NaN)).filter((t) => t > now - WEEK_MS).sort((a, b) => a - b);
  return {
    week: Math.max(0, WEEK_CAP - week.length),
    // While the week is full, when it next has room: once enough of its Lessons are a week old.
    weekOpens: week.length >= WEEK_CAP ? week[week.length - WEEK_CAP] + WEEK_MS : null,
    situation: (name) => Math.max(0, SITUATION_CAP - lessons.filter((l) => l.situation === name).length),
  };
}

// One appended line per Lesson. The same text for the same situation is saved once, and one the
// Owner removed isn't saved again. move: the move it changes, word for word as the Playbook has it
// (ADR 0117), so the Playbook page shows it under that move; absent, it shows under the situation.
// drafts: the Feedback suggestion IDs of the drafts whose edits showed it, which the Companion's
// weekly look at the Owner's edits records, so the same edits never back a second Lesson.
// Past either cap it saves nothing and says which (status full, cap situation or week, and opens:
// when the week next has room). Both are checked under the lock, so two writers can't both take the
// last place.
const DRAFT_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
/** @param {{situation: string, text: string, why: string, by?: string, move?: string, drafts?: string[]}} input @param {{dir?: string, now?: number}} [options] */
export function addLesson({ situation, text, why, by = 'agent', move, drafts }, { dir = stateDir(), now } = {}) {
  if (drafts !== undefined && (!Array.isArray(drafts) || drafts.length > 50 || !drafts.every((d) => typeof d === 'string' && DRAFT_ID.test(d)))) throw new PlaybookError('Name the drafts by their IDs. Nothing was saved.');
  const lesson = { situation, text: oneLine(text, 'the Lesson with --text'), why: oneLine(why, 'what showed it with --why'), by: oneLine(by, '--by'),
    ...(move === undefined ? {} : { move: String(move).replace(/\s+/g, ' ').trim().slice(0, 2000) }), ...(drafts === undefined ? {} : { drafts: [...new Set(drafts)] }) };
  // The clock is read under the lock, so a writer that waited for it counts the Lesson saved first.
  return withLessonsLock(dir, () => appendLesson(lesson, dir, now ?? Date.now()));
}
function appendLesson(lesson, dir, now) {
  const { situation } = lesson;
  const saved = readLessons(dir), gone = readRemovedLessons(dir);
  const same = saved.find((l) => sameLesson(l, lesson));
  if (same) return { status: 'duplicate', lesson: same };
  const removed = gone.find((l) => sameLesson(l, lesson));
  if (removed) return { status: 'removed', lesson: removed };
  // The situation first: waiting a week never makes room there.
  const room = lessonRoom(saved, gone, now);
  if (!room.situation(situation)) return { status: 'full', cap: 'situation' };
  if (!room.week) return { status: 'full', cap: 'week', opens: new Date(room.weekOpens).toISOString() };
  const at = new Date(now).toISOString();
  const row = { id: `l${createHash('sha256').update(`${situation}\n${lesson.text}\n${at}`).digest('hex').slice(0, 7)}`, ...lesson, at };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A file whose last line lacks its newline, hand-edited or cut off, would join this line onto it.
  let last = '';
  try { last = readFileSync(lessonsFile(dir), 'utf8').slice(-1); } catch { /* no file yet */ }
  appendFileSync(lessonsFile(dir), `${last && last !== '\n' ? '\n' : ''}${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(lessonsFile(dir), 0o600);
  return { status: 'added', lesson: row };
}

// The Owner removes a Lesson on the Playbook page (ADR 0117), by its id and the words the page
// showed: missing when no Lesson has that id, stale when its words changed since. The other lines
// stay byte for byte, damaged ones too, and the file is replaced whole, by rename. A Lesson
// appended meanwhile would be lost by the rename, so the file is read again just before it, and
// when it changed the removal starts over.
export function removeLesson(id, shown, { dir = stateDir(), now = Date.now() } = {}) {
  return withLessonsLock(dir, () => removeLocked(id, shown, dir, now));
}
function removeLocked(id, shown, dir, now) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let text = '';
    try { text = readFileSync(lessonsFile(dir), 'utf8'); } catch { return { status: 'missing' }; }
    const lines = text.split('\n');
    const parsed = lines.map((line) => { try { const l = JSON.parse(line); return l && l.id && l.situation && l.text ? l : null; } catch { return null; } });
    const lesson = parsed.find((l) => l?.id === id);
    if (!lesson) return { status: 'missing' };
    if (typeof shown === 'string' && shown !== lesson.text) return { status: 'stale', lesson };
    const tmp = `${lessonsFile(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, lines.filter((_, i) => parsed[i]?.id !== id).join('\n'), { mode: 0o600 });
    let again = null;
    try { again = readFileSync(lessonsFile(dir), 'utf8'); } catch { /* gone meanwhile */ }
    if (again !== text) { unlinkSync(tmp); continue; }
    // The tombstone before the rename: a removal cut off between them leaves the Lesson shown, and
    // never lets it be saved again once it's gone.
    if (!readRemovedLessons(dir).some((l) => l.id === id)) {
      let last = '';
      try { last = readFileSync(removedLessonsFile(dir), 'utf8').slice(-1); } catch { /* no file yet */ }
      // savedAt for every Lesson since 2026-10-19, so the week keeps counting it (lessonRoom).
      appendFileSync(removedLessonsFile(dir), `${last && last !== '\n' ? '\n' : ''}${JSON.stringify({ id, situation: lesson.situation, text: lesson.text, at: new Date(now).toISOString(),
        ...(Array.isArray(lesson.drafts) ? { drafts: lesson.drafts } : {}), ...(typeof lesson.at === 'string' ? { savedAt: lesson.at } : {}) })}\n`, { mode: 0o600 });
      chmodSync(removedLessonsFile(dir), 0o600);
    }
    renameSync(tmp, lessonsFile(dir));
    return { status: 'removed', lesson };
  }
  return { status: 'busy' };
}

export const lessonLine = (l) => `- ${l.text} (why: ${l.why}. ${l.by}, ${String(l.at).slice(0, 10)}, ${l.id})`;
