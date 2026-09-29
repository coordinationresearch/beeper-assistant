// Runs the official Beeper CLI and returns parsed JSON.
// Reads run with BEEPER_READONLY=1 so a read can never change anything.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

// ---- message search ----
// Goes straight to the local API. The CLI drops the chats that come with each page,
// and its --chat flag matches loosely.
export const SEARCH_MEDIA = ['any', 'image', 'video', 'file', 'link'];
const SEARCH_PAGE = 20; // Beeper refuses more than 20 per page

export function searchPath({ query = '', chatID = null, sender = null, media = [], cursor = null } = {}) {
  const p = new URLSearchParams();
  if (query) p.set('query', query);
  if (chatID) p.append('chatIDs', chatID);
  if (sender) p.set('sender', sender);
  for (const m of media) p.append('mediaTypes', m); // one parameter per value, never comma-joined
  p.set('limit', String(SEARCH_PAGE));
  if (cursor) { p.set('cursor', cursor); p.set('direction', 'before'); }
  return `/v1/messages/search?${p}`;
}

// Beeper's search needs help in three places, all seen on 2026-09-29:
// - It ignores its own date filters, so the cutoff is applied here.
// - Across chats, a page is several date-ordered runs joined together, not one order. So an old
//   message does not mean the rest are old. Paging stops when a whole page is past the cutoff.
// - sender=others still returns the Owner's own messages, so the sender is checked here too.
// Pages also stop when one brings nothing new, since paging has repeated before.
// `keep` drops hits that are not real messages, such as tapbacks that quote the words searched for.
export async function searchMessages(opts, { max = 20, sinceMs = 0, keep = () => true, api = apiOnce } = {}) {
  const items = [];
  let dropped = 0;
  const chats = {};
  const seen = new Set();
  const wanted = (m) => (opts.sender === 'me' ? m.isSender === true : opts.sender === 'others' ? m.isSender !== true : true);
  let cursor = null;
  let more = false;
  const pages = Math.ceil(max / SEARCH_PAGE) * 2 + 3;
  for (let page = 0; page < pages; page++) {
    const res = await api('GET', searchPath({ ...opts, cursor }), undefined, { timeoutMs: 30_000 });
    if (!res.ok) throw new BeeperError(`Search failed: ${res.error}`);
    const d = res.data || {};
    Object.assign(chats, d.chats || {});
    let fresh = 0;
    let recent = 0;
    for (const m of d.items || []) {
      if (!m || !m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      fresh++;
      if (sinceMs && Date.parse(m.timestamp) < sinceMs) continue;
      recent++;
      if (!wanted(m)) continue;
      if (!keep(m)) { dropped++; continue; }
      items.push(m);
    }
    const last = !d.hasMore || !fresh || !d.oldestCursor || (sinceMs && !recent);
    if (items.length >= max) { more = items.length > max || !last; break; }
    if (last) break;
    if (page === pages - 1) more = true;
    cursor = d.oldestCursor;
  }
  // By time, since sort keys from different networks are not comparable.
  items.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  return { items: items.slice(0, max), chats, more, dropped };
}

// ---- attachments ----
const localPath = (u) => { try { return String(u || '').startsWith('file://') ? fileURLToPath(u) : null; } catch { return null; } };

// Returns { path } for a file on this Mac, or { error }. Beeper answers 200 even when a
// download fails, with the reason in an error field.
export async function attachmentFile(att, { api = apiOnce } = {}) {
  const here = localPath(att && att.srcURL);
  if (here && existsSync(here)) return { path: here };
  const url = [att && att.id, att && att.srcURL].find((u) => /^(local)?mxc:\/\//.test(String(u || '')));
  if (!url) return { error: 'Beeper gave no address for this file' };
  const res = await api('POST', '/v1/assets/download', { url }, { timeoutMs: 120_000 });
  if (!res.ok) return { error: res.error };
  const d = res.data || {};
  // "Failed to download asset: Transfer failed for <address>: …: <reason>". Only the reason helps.
  if (d.error) return { error: String(d.error).split(': ').pop() };
  const path = localPath(d.srcURL);
  if (!path || !existsSync(path)) return { error: 'Beeper said the download worked, but no file is there' };
  return { path };
}
