// Each CLI call ba makes, sent to the API instead when an app supplies the login. Beeper is
// a fake that records every request; no CLI exists, so starting one would fail the test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, beforeEach, test } from 'node:test';

process.env.BEEPER_BIN = '/nonexistent/beeper';

const seen = [];
const messages = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, sortKey: String(1000 + i), text: `synthetic ${i}` }));
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : undefined });
    const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer app-token') return json(401, { code: 'unauthorized' });
    if (url.pathname === '/v1/chats/c1/messages' && req.method === 'GET') {
      // Newest first, 20 a page, as Beeper pages.
      const newest = [...messages].reverse(), start = Number(url.searchParams.get('cursor') || 0), page = newest.slice(start, start + 20);
      return json(200, { items: page, hasMore: start + 20 < newest.length, oldestCursor: String(start + 20) });
    }
    if (url.pathname === '/v1/chats/start') return json(200, { chatID: 'c-new' });
    if (url.pathname.startsWith('/v1/chats/fail')) return json(500, { message: 'Network refused', code: 'UNKNOWN_ERROR' });
    json(200, { id: 'c1', items: [] });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const HERE = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections(); server.close(); });

const lib = await import('../scripts/lib/beeper.mjs');
lib.setLoginSource({ read: () => ({ baseURL: HERE, token: 'app-token' }) });
beforeEach(() => { seen.length = 0; });
const last = () => seen.at(-1);

test('writes go to their endpoint once, with the body the CLI would have sent', async () => {
  const cases = [
    [['chats', 'draft', '--chat', 'c1', '--text', 'Synthetic draft'], 'PATCH', '/v1/chats/c1', { draft: { text: 'Synthetic draft' } }],
    [['chats', 'draft', '--chat', 'c1', '--clear'], 'PATCH', '/v1/chats/c1', { draft: null }],
    [['chats', 'mark-read', '--chat', 'c1'], 'POST', '/v1/chats/c1/read', {}],
    [['send', 'react', '--to', 'c1', '--id', 'm3', '--reaction', '👍'], 'POST', '/v1/chats/c1/messages/m3/reactions', { reactionKey: '👍' }],
    [['chats', 'remind', '--chat', 'c1', '--when', '2026-10-04T09:00:00.000Z', '--dismiss-on-message'], 'POST', '/v1/chats/c1/reminders', { reminder: { remindAt: '2026-10-04T09:00:00.000Z', dismissOnIncomingMessage: true } }],
    [['chats', 'unremind', '--chat', 'c1'], 'DELETE', '/v1/chats/c1/reminders', undefined],
    [['messages', 'edit', '--chat', 'c1', '--id', 'm3', '--message', 'Fixed'], 'PUT', '/v1/chats/c1/messages/m3', { text: 'Fixed' }],
    [['chats', 'rename', '--chat', 'c1', '--title', 'Synthetic group'], 'PATCH', '/v1/chats/c1', { title: 'Synthetic group' }],
    [['chats', 'start', '+1 (555) 010-2030', '--account', 'whatsapp'], 'POST', '/v1/chats/start', { accountID: 'whatsapp', user: { phoneNumber: '+15550102030' } }],
  ];
  for (const [args, method, path, body] of cases) {
    seen.length = 0;
    await lib.runBeeper(args, { write: true });
    assert.equal(seen.length, 1, args.join(' '));
    assert.deepEqual([last().method, last().path, last().body], [method, path, body], args.join(' '));
  }
});

test('delete is for everyone only when asked, though Beeper defaults the other way', async () => {
  await lib.runBeeper(['messages', 'delete', '--chat', 'c1', '--id', 'm3'], { write: true });
  assert.equal(last().query.forEveryone, 'false');
  await lib.runBeeper(['messages', 'delete', '--chat', 'c1', '--id', 'm3', '--for-everyone'], { write: true });
  assert.equal(last().query.forEveryone, 'true');
});

test('a failed write is never tried again, and says why', async () => {
  await assert.rejects(lib.runBeeper(['chats', 'mark-read', '--chat', 'fail'], { write: true }), /500/);
  await assert.rejects(lib.runBeeper(['chats', 'draft', '--chat', 'fail', '--text', 'x'], { write: true }));
  assert.equal(seen.filter((r) => r.path.startsWith('/v1/chats/fail')).length, 2, 'one request each');
});

test('messages list pages back to the limit and comes newest first, as from the CLI', async () => {
  const got = await lib.runBeeper(['messages', 'list', '--chat', 'c1', '--limit', '30']);
  assert.deepEqual(got.map((m) => m.id), messages.slice(15).reverse().map((m) => m.id));
  assert.equal(seen.length, 2);
});

test('a call ba does not make, or a read sent as a write, fails plainly', async () => {
  await assert.rejects(lib.runBeeper(['accounts', 'list']), /not available without the Beeper CLI/);
  await assert.rejects(lib.runBeeper(['chats', 'draft', '--chat', 'c1', '--text', 'x']), /not available without the Beeper CLI/, 'a write must say it is one');
  await assert.rejects(lib.runBeeper(['chats', 'show', '--chat', 'c1'], { write: true }), /not available without the Beeper CLI/);
  assert.equal(seen.length, 0);
});

test('draft text that looks like a flag stays text; unknown flags and missing Chats fail before any request', async () => {
  await lib.runBeeper(['chats', 'draft', '--chat', 'c1', '--text', '--clear'], { write: true });
  assert.deepEqual(last().body, { draft: { text: '--clear' } });
  await lib.runBeeper(['messages', 'edit', '--chat', 'c1', '--id', 'm3', '--message', '--oops'], { write: true });
  assert.deepEqual(last().body, { text: '--oops' });
  seen.length = 0;
  await assert.rejects(lib.runBeeper(['chats', 'draft', '--chat', 'c1', '--text'], { write: true }), /--text: not available/);
  await assert.rejects(lib.runBeeper(['chats', 'draft', '--chat', 'c1', '--surprise', 'x'], { write: true }), /--surprise: not available/);
  await assert.rejects(lib.runBeeper(['chats', 'mark-read'], { write: true }), /no Chat given/);
  await assert.rejects(lib.runBeeper(['send', 'react', '--to', 'c1', '--reaction', '👍'], { write: true }), /no message given/);
  assert.equal(seen.length, 0);
});
