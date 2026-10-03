// Reply suggestions a terminal agent posts for the companion's sidebar (ADR 0071). One JSON
// file per Chat in the state folder, named by the full SHA-256 of the Chat ID, the key Notes
// and the companion's Store use. The newest post wins. Any process running as the Owner can
// write here, so a file can only ever propose: the companion checks it again, shows the agent's
// name as a claim, and sends nothing from it without the Owner's Send all in the sidebar.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './state.mjs';

export const SUGGESTION_VERSION = 1;
export const SUGGESTION_BYTES = 64 * 1024;
export const suggestionKey = (chatID) => createHash('sha256').update(String(chatID)).digest('hex');
export const suggestionsDir = (dir) => join(dir || stateDir(), 'suggestions');
export const suggestionFile = (chatID, { dir } = {}) => join(suggestionsDir(dir), `${suggestionKey(chatID)}.json`);

const isTime = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
// A name to show, from the agent's own claim: printable, one line, short.
const label = (v) => typeof v === 'string' ? v.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';

/**
 * The agent running this command, from the environment it set, or the name it gave.
 * Codex's sandbox blocks `ps`, so process ancestry can't confirm it (checked 2026-10-02).
 * @param {Record<string, string | undefined>} env
 * @param {unknown} [given]
 */
export function agentLabel(env, given) {
  if (label(given)) return label(given);
  if (env.CLAUDECODE === '1') return 'Claude Code';
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'Codex';
  return 'An agent';
}

/**
 * "20s", "1.5 s", "2m", "500ms", or a number of seconds, as milliseconds; NaN when unreadable.
 * @param {unknown} value
 */
export function waitMs(value) {
  if (typeof value === 'number') return Math.round(value * 1000);
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?)?\s*$/i.exec(String(value ?? ''));
  if (!m) return NaN;
  const n = Number(m[1]), unit = (m[2] || 's').toLowerCase();
  return Math.round(unit === 'ms' ? n : unit.startsWith('m') ? n * 60_000 : n * 1000);
}

/**
 * The agent's list, [{say}, {react, key}, {wait}], as steps with the wait before each. A
 * reaction's message reference goes through resolve. Throws with what to fix.
 * @param {unknown} list
 * @param {(ref: string) => Promise<string>} resolve
 */
export async function stepsFromAgent(list, resolve) {
  if (!Array.isArray(list) || !list.length) throw new Error('Give the steps as a JSON list, such as [{"say":"Yes!"},{"wait":"20s"},{"say":"See you at 7"}].');
  const steps = [];
  let pending = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new Error('Each step is {"say": "…"}, {"react": "<message>", "key": "❤️"}, or {"wait": "20s"}.');
    if ('wait' in item) {
      const ms = waitMs(item.wait);
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`Can't read the wait "${item.wait}". Write it as "20s" or "2m".`);
      if (!steps.length) throw new Error('Nothing waits before the first step.');
      pending += ms;
    } else if ('say' in item) {
      steps.push({ kind: 'message', text: String(item.say ?? '').replace(/\s+$/, ''), waitMs: pending }); pending = 0;
    } else if ('react' in item) {
      steps.push({ kind: 'react', key: String(item.key ?? '').trim(), messageID: await resolve(String(item.react)), waitMs: pending }); pending = 0;
    } else throw new Error('Each step is {"say": "…"}, {"react": "<message>", "key": "❤️"}, or {"wait": "20s"}.');
  }
  if (pending) throw new Error('A wait must come before a step, not at the end.');
  return steps;
}

/**
 * Writes a Chat's suggestion in place of any earlier one. Atomic, readable only by the Owner.
 * @param {string} chatID
 * @param {{ steps: object[]; forMessageID: string; author: string; now?: Date; dir?: string }} input
 */
export function writeSuggestion(chatID, { steps, forMessageID, author, now = new Date(), dir }) {
  const file = suggestionFile(chatID, { dir }), id = randomUUID();
  mkdirSync(suggestionsDir(dir), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ version: SUGGESTION_VERSION, id, chatKey: suggestionKey(chatID), at: now.toISOString(), author: label(author) || 'An agent', forMessageID, steps });
  if (Buffer.byteLength(body) > SUGGESTION_BYTES) throw new Error('This reply is too long to post.');
  writeFileSync(`${file}.${id}.tmp`, body, { mode: 0o600 });
  renameSync(`${file}.${id}.tmp`, file);
  return { id, file };
}

/**
 * A Chat's suggestion as posted, or null when there is none or the file can't be trusted.
 * Checks the envelope only; the companion checks the steps against the Chat it shows.
 * @param {string} chatID
 * @param {{ dir?: string }} [options]
 * @returns {{ id: string; at: string; author: string; forMessageID: string; steps: unknown[] } | null}
 */
export function readSuggestion(chatID, { dir } = {}) {
  const file = suggestionFile(chatID, { dir });
  // A regular file only, never through a link, and never waiting on one, such as a FIFO
  // another process left in its place: the companion reads this on its main thread.
  let raw;
  let fd = -1;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > SUGGESTION_BYTES) return null;
    const buffer = Buffer.alloc(info.size);
    raw = buffer.subarray(0, readSync(fd, buffer, 0, info.size, 0)).toString('utf8');
  } catch { return null; } finally { if (fd >= 0) closeSync(fd); }
  let doc;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || doc.version !== SUGGESTION_VERSION || doc.chatKey !== suggestionKey(chatID)) return null;
  if (typeof doc.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(doc.id) || !isTime(doc.at) || typeof doc.forMessageID !== 'string' || !doc.forMessageID || doc.forMessageID.length > 300) return null;
  if (!Array.isArray(doc.steps)) return null;
  return { id: doc.id, at: doc.at, author: label(doc.author) || 'An agent', forMessageID: doc.forMessageID, steps: doc.steps };
}
