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
  if (loginSource && !unread) return listChatsOverApi({ limit, filtered });
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

// The CLI's chat lists, read from the API by an app that holds its own login. Both page
// GET /v1/chats newest first; filtered drops archived, muted, and low-priority Chats, as the
// CLI's flags do. Checked against the CLI on 2026-10-02: the same Chats in the same order.
const API_PAGE = 200; // Beeper refuses more than 200 per page
export async function listChatsOverApi({ limit = 200, filtered = true } = {}) {
  const chats = [];
  const seen = new Set();
  let cursor = null;
  while (chats.length < limit) {
    const q = new URLSearchParams({ limit: String(API_PAGE) });
    if (cursor) { q.set('cursor', cursor); q.set('direction', 'before'); }
    const res = await apiOnce('GET', `/v1/chats?${q}`, undefined, { timeoutMs: 30_000 });
    if (!res.ok) throw new BeeperError(`Chats unavailable: ${res.error}`);
    const page = asList(res.data).filter((c) => c && !seen.has(c.id) && seen.add(c.id));
    chats.push(...(filtered ? page.filter((c) => !c.isArchived && !c.isMuted && !c.isLowPriority) : page));
    if (!res.data.hasMore || !res.data.oldestCursor || !page.length) break;
    cursor = res.data.oldestCursor;
  }
  return chats.slice(0, limit);
}

// Archived Chats only, as `chats list --archived` gives them. The archive inbox of Beeper's
// chat search is the same list, read without paging through every Chat.
export async function listArchivedChats({ limit = 400 } = {}) {
  if (!loginSource) return asList(await runBeeper(['chats', 'list', '--limit', String(limit), '--archived']));
  const chats = [];
  let cursor = null;
  while (chats.length < limit) {
    const q = new URLSearchParams({ inbox: 'archive', limit: String(API_PAGE) });
    if (cursor) { q.set('cursor', cursor); q.set('direction', 'before'); }
    const res = await apiOnce('GET', `/v1/chats/search?${q}`, undefined, { timeoutMs: 30_000 });
    if (!res.ok) throw new BeeperError(`Archived chats unavailable: ${res.error}`);
    const page = asList(res.data);
    chats.push(...page);
    if (!res.data.hasMore || !res.data.oldestCursor || !page.length) break;
    cursor = res.data.oldestCursor;
  }
  return chats.slice(0, limit);
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
// lands twice. Anything that must happen once goes through our own HTTP call, using
// the login the CLI already holds.
//
// Each read of the login starts the CLI, so it is read once and kept. It goes stale when
// `beeper setup` saves a new token or address, as after Beeper's session changes or it
// moves port. Two failures prove Beeper did nothing with a request: a refused connection,
// and Beeper's token check, a 401 with code "unauthorized" that it answers before any route
// runs. Either one reads the login again, and only when it changed does the request go once
// more. Every other failure gets no second try, a 500 or another 401 included.
let login = null;
// An app that holds its own Beeper login sets this, and then nothing here starts the CLI:
// lists go to the API too. read() gives { baseURL, token } or throws. rejected(login) hears
// that Beeper refused that token, so the app can ask for a new approval.
let loginSource = null;
export function setLoginSource(source) {
  loginSource = source;
  login = null;
}
function readLogin() {
  // The app keeps its own login and changes it on Connect and Disconnect, so it is asked
  // every time: a kept copy could outlive a Disconnect.
  if (loginSource) return Promise.resolve().then(() => loginSource.read()).then((t) => {
    if (!t || !t.baseURL || !t.token) throw new BeeperError('Beeper Companion is not connected to Beeper');
    return { baseURL: String(t.baseURL).replace(/\/$/, ''), token: String(t.token) };
  });
  if (login) return login;
  // Bounded, since a send waits on it. The read takes about a second.
  const read = runBeeper(['status'], { timeoutMs: 15_000 }).then((data) => {
    const t = (data && data.target) || {};
    const token = t.auth && t.auth.accessToken;
    if (!t.baseURL || !token) throw new BeeperError('Could not read the Beeper login from the CLI. Run: beeper setup');
    return { baseURL: String(t.baseURL).replace(/\/$/, ''), token };
  });
  read.catch(() => { if (login === read) login = null; });
  login = read;
  return read;
}

// Returns the result, and `untouched` when Beeper provably did nothing: 'connection' or 'token'.
async function attempt({ baseURL, token }, method, path, body, timeoutMs) {
  let res;
  try {
    res = await fetch(`${baseURL}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A write that landed and then redirected to a closed port would look refused.
      redirect: method === 'GET' ? 'follow' : 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.cause && e.cause.code === 'ECONNREFUSED') return { result: { ok: false, status: 0, error: 'connection refused' }, untouched: 'connection' };
    return { result: { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'no answer in time' : String(e.message || e) } };
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.ok) return { result: { ok: true, status: res.status, data } };
  const msg = (data && (data.message || (data.error && (data.error.message || data.error)))) || text.slice(0, 200) || res.statusText;
  const result = { ok: false, status: res.status, error: `${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` };
  return { result, untouched: res.status === 401 && data && data.code === 'unauthorized' ? 'token' : null };
}

/** @returns {Promise<{ ok: boolean, status: number, data?: any, error?: string }>} */
export async function apiOnce(method, path, body, { timeoutMs = 60_000 } = {}) {
  const kept = readLogin();
  const used = await kept;
  let last = await attempt(used, method, path, body, timeoutMs);
  if (!last.untouched) return last.result;
  if (login === kept) login = null;
  if (last.untouched === 'token') loginSource?.rejected?.(used);
  const fresh = await readLogin().catch(() => null);
  if (fresh && (fresh.token !== used.token || fresh.baseURL !== used.baseURL)) last = await attempt(fresh, method, path, body, timeoutMs);
  // The CLI saves its login at setup and never reads Beeper's again, so only setup fixes a refused token.
  return last.untouched === 'token' && !loginSource ? { ...last.result, error: `${last.result.error}. Run: beeper setup` } : last.result;
}

// Reads that run many times in a row go straight to the local API. Starting the CLI
// for each one costs far more than the request itself. Falls back to the CLI on any trouble.
export async function listMessagesFast(chatID, { limit = 8 } = {}) {
  const res = await apiOnce('GET', `/v1/chats/${encodeURIComponent(chatID)}/messages`, undefined, { timeoutMs: 10_000 });
  if (!res.ok && loginSource) throw new BeeperError(`Messages unavailable: ${res.error}`);
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
