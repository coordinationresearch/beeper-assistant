// The login apiOnce keeps, and when it reads it again. Beeper and its CLI are fakes, so nothing real is touched.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ba-login-'));
const LOGIN = join(dir, 'login.json');
const READS = join(dir, 'reads');

// A stand-in for the Beeper CLI. Its status prints whatever login the test saved, as
// `beeper setup` would have, and it counts each read.
const bin = join(dir, 'beeper');
writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== 'status') { console.error(JSON.stringify({ success: false, error: 'not in the fake' })); process.exit(1); }
fs.appendFileSync(${JSON.stringify(READS)}, 'x');
const { baseURL, token } = JSON.parse(fs.readFileSync(${JSON.stringify(LOGIN)}, 'utf8'));
console.log(JSON.stringify({ success: true, data: { target: { baseURL, auth: token ? { accessToken: token } : undefined } } }));
`);
chmodSync(bin, 0o755);
process.env.BEEPER_BIN = bin;

const saveLogin = (baseURL, token) => writeFileSync(LOGIN, JSON.stringify({ baseURL, token }));
const reads = () => (existsSync(READS) ? readFileSync(READS, 'utf8').length : 0);

// A stand-in for Beeper's local API. Like Beeper, it refuses a token it does not accept
// with a 401 whose code is "unauthorized", before acting. Beeper accepts only its current
// session's token; `accepts` holds two only where a test needs a second try to be possible.
// `afterActing` makes a send land and still answer with that status, as Beeper did with a 500
// on 2026-09-27. `redirectTo` makes a send land and answer with a redirect.
const beeper = { accepts: [], afterActing: null, redirectTo: null, requests: [], sent: [] };
const server = createServer((req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  beeper.requests.push({ method: req.method, token });
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
    if (!beeper.accepts.includes(token)) return reply(401, { message: 'Invalid token', code: 'unauthorized' });
    if (req.method === 'POST') beeper.sent.push(JSON.parse(body).text);
    if (beeper.redirectTo) return reply(303, {}, { location: beeper.redirectTo });
    if (beeper.afterActing) return reply(beeper.afterActing, { message: 'Network refused', code: 'UNKNOWN_ERROR' });
    reply(200, req.method === 'POST' ? { chatID: 'chat-1' } : { items: [] });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const HERE = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections(); server.close(); });

// An address where nothing listens, as after Beeper moved to another port.
const spare = createServer();
await new Promise((resolve) => spare.listen(0, '127.0.0.1', resolve));
const NOWHERE = `http://127.0.0.1:${spare.address().port}`;
await new Promise((resolve) => spare.close(resolve));

// Each test gets its own copy of the module, so no test inherits another's kept login.
let copies = 0;
const freshApi = async () => (await import(`../scripts/lib/beeper.mjs?copy=${++copies}`)).apiOnce;
const send = (apiOnce) => apiOnce('POST', '/v1/chats/chat-1/messages', { text: 'made-up reply' });

beforeEach(() => {
  writeFileSync(READS, '');
  Object.assign(beeper, { accepts: [], afterActing: null, redirectTo: null, requests: [], sent: [] });
});

test('the login is read once and kept while Beeper accepts it', async () => {
  const apiOnce = await freshApi();
  beeper.accepts = ['token-a'];
  saveLogin(HERE, 'token-a');
  for (let i = 0; i < 3; i++) assert.equal((await apiOnce('GET', '/v1/accounts')).ok, true);
  assert.equal(reads(), 1);
});

test('a refused token is read again, and the send goes through once with the new one', async () => {
  const apiOnce = await freshApi();
  beeper.accepts = ['token-a'];
  saveLogin(HERE, 'token-a');
  assert.equal((await apiOnce('GET', '/v1/accounts')).ok, true);
  // Beeper's session changes, and `beeper setup` saves the new token.
  beeper.accepts = ['token-b'];
  saveLogin(HERE, 'token-b');
  const res = await send(apiOnce);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(beeper.sent, ['made-up reply']);
  assert.deepEqual(beeper.requests.filter((r) => r.method === 'POST').map((r) => r.token), ['token-a', 'token-b']);
  assert.equal(reads(), 2);
});

test('a token Beeper still refuses after a new read is not tried again, and the error says how to fix it', async () => {
  const apiOnce = await freshApi();
  // Beeper's session changed, and `beeper setup` has not run since.
  beeper.accepts = ['token-b'];
  saveLogin(HERE, 'token-a');
  const res = await send(apiOnce);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.error, '401 Invalid token. Run: beeper setup');
  assert.equal(beeper.requests.length, 1);
  assert.deepEqual(beeper.sent, []);
  assert.equal(reads(), 2);
});

test('an error after Beeper acted is returned as is, and the send is never repeated', async () => {
  const apiOnce = await freshApi();
  beeper.accepts = ['token-a'];
  beeper.afterActing = 500;
  saveLogin(HERE, 'token-a');
  const res = await send(apiOnce);
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
  assert.deepEqual(beeper.sent, ['made-up reply']);
  assert.equal(beeper.requests.length, 1);
  assert.equal(reads(), 1);
});

// Each case below arms a second try: Beeper accepts both tokens, and the CLI holds the new one.
// Only Beeper's own token check, or a connection that never opened, may use it.
async function armed() {
  const apiOnce = await freshApi();
  beeper.accepts = ['token-a', 'token-b'];
  saveLogin(HERE, 'token-a');
  assert.equal((await apiOnce('GET', '/v1/accounts')).ok, true);
  saveLogin(HERE, 'token-b');
  beeper.requests = [];
  return apiOnce;
}

test('a 401 from a route that already acted is not tried again, and does not blame the login', async () => {
  const apiOnce = await armed();
  beeper.afterActing = 401;
  const res = await send(apiOnce);
  assert.deepEqual(beeper.sent, ['made-up reply']);
  assert.equal(res.ok, false);
  assert.equal(res.error, '401 Network refused');
  assert.equal(beeper.requests.length, 1);
  assert.equal(reads(), 1);
});

test('a send that landed and redirected to a closed port is not tried again', async () => {
  const apiOnce = await armed();
  beeper.redirectTo = `${NOWHERE}/v1/elsewhere`;
  const res = await send(apiOnce);
  assert.deepEqual(beeper.sent, ['made-up reply']);
  assert.equal(res.ok, false);
  assert.equal(res.status, 303);
  assert.equal(beeper.requests.length, 1);
  assert.equal(reads(), 1);
});

test('when nothing answers, the login is read again, and a new address gets the request once', async () => {
  const apiOnce = await freshApi();
  beeper.accepts = ['token-a'];
  saveLogin(NOWHERE, 'token-a');
  const down = await send(apiOnce);
  assert.equal(down.ok, false);
  assert.equal(down.status, 0);
  assert.equal(down.error, 'connection refused');
  assert.equal(reads(), 2);
  // Beeper comes back on another port, and `beeper setup` saves it.
  saveLogin(HERE, 'token-a');
  const res = await send(apiOnce);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(beeper.sent, ['made-up reply']);
  assert.equal(reads(), 3);
});

test('calls refused at the same time share one new read', async () => {
  const apiOnce = await freshApi();
  beeper.accepts = ['token-a'];
  saveLogin(HERE, 'token-a');
  assert.equal((await apiOnce('GET', '/v1/accounts')).ok, true);
  beeper.accepts = ['token-b'];
  saveLogin(HERE, 'token-b');
  const all = await Promise.all([1, 2, 3].map(() => apiOnce('GET', '/v1/accounts')));
  assert.deepEqual(all.map((r) => r.ok), [true, true, true]);
  assert.equal(reads(), 2);
});

test('a login that cannot be read is not kept, so the next call reads again', async () => {
  const apiOnce = await freshApi();
  beeper.accepts = ['token-a'];
  saveLogin(HERE, null);
  await assert.rejects(apiOnce('GET', '/v1/accounts'), /Could not read the Beeper login from the CLI\. Run: beeper setup/);
  saveLogin(HERE, 'token-a');
  assert.equal((await apiOnce('GET', '/v1/accounts')).ok, true);
  assert.equal(reads(), 2);
});
