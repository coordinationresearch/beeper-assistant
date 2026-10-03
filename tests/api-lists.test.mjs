// The chat lists an app reads over Beeper's API once it sets its own login, instead of
// starting the CLI. Beeper is a fake; a CLI that would fail proves none is started.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';

process.env.BEEPER_BIN = '/nonexistent/beeper';

// 450 Chats, newest first, every seventh archived, every eleventh muted, every thirteenth low priority.
const chats = Array.from({ length: 450 }, (_, i) => ({ id: `chat-${i}`, lastActivity: new Date(Date.UTC(2026, 9, 2) - i * 60_000).toISOString(),
  isArchived: i % 7 === 3, isMuted: i % 11 === 5, isLowPriority: i % 13 === 7 }));
const seen = { tokens: [], paths: [] };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  seen.tokens.push(String(req.headers.authorization || ''));
  seen.paths.push(url.pathname);
  const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.headers.authorization !== 'Bearer app-token') return json(401, { code: 'unauthorized' });
  const page = (list) => {
    const limit = Number(url.searchParams.get('limit')), start = Number(url.searchParams.get('cursor') || 0);
    // Beeper repeats a Chat across pages now and then; one repeat here.
    const items = list.slice(Math.max(0, start - (start ? 1 : 0)), start + limit);
    const next = start + limit;
    json(200, { items, hasMore: next < list.length, oldestCursor: next < list.length ? String(next) : null });
  };
  if (url.pathname === '/v1/chats') return page(chats);
  if (url.pathname === '/v1/chats/search' && url.searchParams.get('inbox') === 'archive') return page(chats.filter((c) => c.isArchived));
  json(404, {});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const HERE = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections(); server.close(); });

const lib = await import('../scripts/lib/beeper.mjs');
const rejected = [];
lib.setLoginSource({ read: () => ({ baseURL: HERE, token: 'app-token' }), rejected: (login) => rejected.push(login.token) });

test('the filtered list drops archived, muted, and low-priority Chats before the limit, in order, once each', async () => {
  const want = chats.filter((c) => !c.isArchived && !c.isMuted && !c.isLowPriority).slice(0, 300).map((c) => c.id);
  const got = (await lib.listChats({ limit: 300 })).map((c) => c.id);
  assert.deepEqual(got, want);
  assert.ok(seen.tokens.every((t) => t === 'Bearer app-token'));
});

test('the unfiltered list keeps every Chat; listChatsSince pages on it', async () => {
  assert.deepEqual((await lib.listChats({ limit: 450, filtered: false })).map((c) => c.id), chats.map((c) => c.id));
  const cutoff = Date.parse(chats[99].lastActivity);
  const { chats: recent, truncated } = await lib.listChatsSince(cutoff, { start: 50, max: 800 });
  assert.equal(truncated, false);
  assert.ok(recent.some((c) => Date.parse(c.lastActivity) < cutoff));
});

test('archived Chats come from the archive inbox', async () => {
  const got = await lib.listArchivedChats({ limit: 400 });
  assert.deepEqual(got.map((c) => c.id), chats.filter((c) => c.isArchived).map((c) => c.id));
  assert.ok(seen.paths.includes('/v1/chats/search'));
});

test('a refused token reaches the source, and messages never fall back to the CLI', async () => {
  lib.setLoginSource({ read: () => ({ baseURL: HERE, token: 'stale' }), rejected: (login) => rejected.push(login.token) });
  await assert.rejects(lib.listMessagesFast('chat-1'), /Messages unavailable/);
  assert.ok(rejected.includes('stale'));
  lib.setLoginSource({ read: () => ({ baseURL: HERE, token: 'app-token' }) });
});

test('a login the app changes is read again on every request, so Disconnect takes effect at once', async () => {
  let current = { baseURL: HERE, token: 'app-token' };
  lib.setLoginSource({ read: () => { if (!current) throw new Error('not connected'); return current; } });
  assert.equal((await lib.apiOnce('GET', '/v1/chats?limit=1')).ok, true);
  current = null;
  await assert.rejects(lib.apiOnce('GET', '/v1/chats?limit=1'), /not connected/);
  lib.setLoginSource({ read: () => ({ baseURL: HERE, token: 'app-token' }) });
});
