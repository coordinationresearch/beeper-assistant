// The Playbook and its Lessons (ADR 0109). The Playbook is the skill's references/playbook.md: one
// section per situation, distilled from books on people, the same for every Owner. A Lesson is one
// line an agent saved about how this Owner differs in one situation, kept in the state folder.
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './state.mjs';

export class PlaybookError extends Error {}

export const PLAYBOOK_FILE = fileURLToPath(new URL('../../references/playbook.md', import.meta.url));
// A Lesson for no one situation, shown with every one.
export const EVERYWHERE = 'Everywhere';
export const LESSON_CHARS = 300;

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

// The file's h2 sections, each with its When line. Text above the first one is the intro.
export function readPlaybook(file = PLAYBOOK_FILE) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const [intro, ...parts] = text.split(/^## /m);
  const situations = parts.map((part) => {
    const [name, ...body] = part.split('\n');
    const section = body.join('\n').trim();
    const when = section.match(/^When: (.+)$/m)?.[1] ?? '';
    return { name: name.trim(), when, text: section };
  });
  return { intro: intro.replace(/^# .*\n/, '').trim(), situations };
}

// The one situation these words name: an exact name, else the only name holding every word, else
// the only name and cues holding every word. A word counts when it starts one there.
export function findSituation(playbook, query) {
  const want = words(query);
  if (!want.length) throw new PlaybookError('Name a situation. Run playbook to see the list.');
  if (want.join(' ') === EVERYWHERE.toLowerCase()) return { name: EVERYWHERE, when: 'any situation', text: '' };
  const exact = playbook.situations.find((s) => words(s.name).join(' ') === want.join(' '));
  if (exact) return exact;
  const holds = (text) => { const have = words(text); return want.every((w) => have.some((h) => h.startsWith(w))); };
  const byName = playbook.situations.filter((s) => holds(s.name));
  const hits = byName.length ? byName : playbook.situations.filter((s) => holds(`${s.name} ${s.when}`));
  if (hits.length === 1) return hits[0];
  const names = (hits.length ? hits : playbook.situations).map((s) => s.name).join(', ');
  throw new PlaybookError(`${hits.length ? `"${query}" fits more than one situation` : `No situation matches "${query}"`}. Use one of: ${names}, or ${EVERYWHERE}.`);
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

// One appended line per Lesson. The same text for the same situation is saved once.
export function addLesson({ situation, text, why, by = 'agent' }, { dir = stateDir(), now = Date.now() } = {}) {
  const lesson = { situation, text: oneLine(text, 'the Lesson with --text'), why: oneLine(why, 'what showed it with --why'), by: oneLine(by, '--by') };
  const same = readLessons(dir).find((l) => l.situation === situation && l.text.toLowerCase() === lesson.text.toLowerCase());
  if (same) return { status: 'duplicate', lesson: same };
  const at = new Date(now).toISOString();
  const saved = { id: `l${createHash('sha256').update(`${situation}\n${lesson.text}\n${at}`).digest('hex').slice(0, 7)}`, ...lesson, at };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A file whose last line lacks its newline, hand-edited or cut off, would join this line onto it.
  let last = '';
  try { last = readFileSync(lessonsFile(dir), 'utf8').slice(-1); } catch { /* no file yet */ }
  appendFileSync(lessonsFile(dir), `${last && last !== '\n' ? '\n' : ''}${JSON.stringify(saved)}\n`, { mode: 0o600 });
  chmodSync(lessonsFile(dir), 0o600);
  return { status: 'added', lesson: saved };
}

export const lessonLine = (l) => `- ${l.text} (why: ${l.why}. ${l.by}, ${String(l.at).slice(0, 10)}, ${l.id})`;
