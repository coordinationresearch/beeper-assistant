// Runs the official Beeper CLI and returns parsed JSON.
// Reads run with BEEPER_READONLY=1 so a read can never change anything.
import { execFile } from 'node:child_process';

export class BeeperError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'BeeperError';
    this.detail = detail;
  }
}

const BIN = () => process.env.BEEPER_BIN || 'beeper';

function errorText(parsed, stderr, err) {
  if (!parsed) {
    // Failures often arrive as a JSON envelope on stderr.
    const m = String(stderr || '').match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* keep raw */ } }
  }
  const e = parsed && parsed.error;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object') return e.message || e.code || JSON.stringify(e);
  const s = (stderr || '').trim();
  if (s) return s.split('\n').slice(-3).join(' ');
  return (err && err.message) || 'unknown error';
}

export function runBeeper(args, { write = false, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (write) delete env.BEEPER_READONLY;
    else env.BEEPER_READONLY = '1';
    const full = [...args, '--json', '-q'];
    if (write) full.push('-y');
    execFile(BIN(), full, { env, timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        return reject(new BeeperError('Beeper CLI not found. Install it with: brew install beeper/tap/cli', { code: 'NO_CLI' }));
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }
      if (parsed && parsed.success === true) return resolve(parsed.data);
      reject(new BeeperError(errorText(parsed, stderr, err), { args, exit: err ? err.code : 0 }));
    });
  });
}

// The CLI returns a bare array today. Older builds wrapped lists as {items: [...]}.
export function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.chats)) return data.chats;
  if (data && Array.isArray(data.messages)) return data.messages;
  return [];
}

export function participantsOf(chat) {
  const p = chat && chat.participants;
  if (Array.isArray(p)) return p;
  if (p && Array.isArray(p.items)) return p.items;
  return [];
}

export function participantTotal(chat) {
  const p = chat && chat.participants;
  if (p && typeof p.total === 'number') return p.total;
  return participantsOf(chat).length;
}

const FILTER_FLAGS = ['--no-archived', '--no-muted', '--no-low-priority'];

export async function listChats({ limit = 200, unread = false, filtered = true } = {}) {
  const args = ['chats', 'list', '--limit', String(limit)];
  if (filtered) args.push(...FILTER_FLAGS);
  if (unread) args.push('--unread');
  return asList(await runBeeper(args));
}

// Fetch recent chats until the oldest one falls outside the window.
export async function listChatsSince(cutoffMs, { start = 800, max = 3200 } = {}) {
  let limit = start;
  for (;;) {
    const chats = await listChats({ limit });
    const oldest = chats.reduce((m, c) => Math.min(m, Date.parse(c.lastActivity) || Infinity), Infinity);
    const complete = chats.length < limit || oldest < cutoffMs || limit >= max;
    if (complete) return { chats, truncated: chats.length >= limit && oldest >= cutoffMs };
    limit *= 2;
  }
}

export async function showChat(selector) {
  return runBeeper(['chats', 'show', '--chat', selector, '--max-participants', '50']);
}

export async function listMessages(chatID, { limit = 20 } = {}) {
  const data = await runBeeper(['messages', 'list', '--chat', chatID, '--limit', String(limit)]);
  // Newest first from the CLI. Callers get oldest first.
  return asList(data).slice().sort((a, b) => String(a.sortKey || a.timestamp).localeCompare(String(b.sortKey || b.timestamp), 'en', { numeric: true }));
}

export async function searchChats(query, { limit = 20 } = {}) {
  return asList(await runBeeper(['chats', 'search', query, '--limit', String(limit)]));
}

// ---- single-attempt writes ----
// The CLI's bundled SDK repeats a request that fails with a server error. Beeper can
// report such an error after the action already happened, so a repeated send or create
// lands twice. Anything that must happen once goes through exactly one HTTP call,
// using the login the CLI already holds.
let target = null;
async function getTarget() {
  if (target) return target;
  const data = await runBeeper(['status']);
  const t = (data && data.target) || {};
  const token = t.auth && t.auth.accessToken;
  if (!t.baseURL || !token) throw new BeeperError('Could not read the Beeper login from the CLI. Run: beeper setup');
  target = { baseURL: String(t.baseURL).replace(/\/$/, ''), token };
  return target;
}

export async function apiOnce(method, path, body, { timeoutMs = 60_000 } = {}) {
  const { baseURL, token } = await getTarget();
  let res;
  try {
    res = await fetch(`${baseURL}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'no answer in time' : String(e.message || e) };
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.ok) return { ok: true, status: res.status, data };
  const msg = (data && (data.message || (data.error && (data.error.message || data.error)))) || text.slice(0, 200) || res.statusText;
  return { ok: false, status: res.status, error: `${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` };
}

// Reads that run many times in a row go straight to the local API. Starting the CLI
// for each one costs far more than the request itself. Falls back to the CLI on any trouble.
export async function listMessagesFast(chatID, { limit = 8 } = {}) {
  const res = await apiOnce('GET', `/v1/chats/${encodeURIComponent(chatID)}/messages`, undefined, { timeoutMs: 10_000 });
  if (!res.ok) return listMessages(chatID, { limit });
  const all = asList(res.data).slice().sort((a, b) => String(a.sortKey || a.timestamp).localeCompare(String(b.sortKey || b.timestamp), 'en', { numeric: true }));
  return all.slice(-limit);
}
