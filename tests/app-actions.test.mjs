// The Owner's actions as ba app commands (lib/actions.mjs, ADR 0185) against a fake Companion: a
// loopback server and a discovery file in a temporary folder. No real app, Store, or Beeper is
// reached. Invented Chat IDs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_USAGE, appCommand, appDiscoveryFile } from '../scripts/lib/app.mjs';
import { ACTIONS } from '../scripts/lib/actions.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const SAM = '!sam-invented:beeper.local';

async function fakeApp(t, { actions = ACTIONS.map(a => a.name), answer = { ok: true } } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ba-app-actions-'));
  const token = 'f'.repeat(64), requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push({ method: req.method, path: req.url, run: req.headers['x-companion-run'] ?? null, ...(raw ? { body: JSON.parse(raw) } : {}) });
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(req.url === '/metadata' ? { protocol: 1, launch: 'fixture', dataHome: directory, capabilities: ['status', 'actions'], actions } : answer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(appDiscoveryFile(directory, directory), JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, token, port: server.address().port }), { mode: 0o600 });
  return { directory, requests };
}
function ba(env, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(SCRIPTS, 'ba.mjs'), ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
const envFor = (app, more = {}) => {
  const env = { ...process.env, BEEPER_ASSISTANT_HOME: app.directory, BEEPER_COMPANION_USER_DATA: app.directory, BEEPER_BIN: '/nonexistent/beeper', ...more };
  delete env.BEEPER_ASSISTANT_READONLY;
  if (!('BEEPER_ASSISTANT_MODE' in more)) delete env.BEEPER_ASSISTANT_MODE;
  if (!('COMPANION_RUN' in more)) delete env.COMPANION_RUN;
  return env;
};

test('each action\'s words make exactly its request, and anything else is its usage', () => {
  const plan = (args) => { const p = appCommand(args); return [p.command, p.path, p.payload]; };
  assert.deepEqual(plan(['pause']), ['pause', '/pause', {}]);
  assert.deepEqual(plan(['pause', 'off']), ['pause off', '/pause/off', {}]);
  assert.deepEqual(plan(['check', 'now']), ['check now', '/check-now', {}]);
  assert.deepEqual(plan(['keep', 'drafting']), ['keep drafting', '/keep-drafting', {}]);
  assert.deepEqual(plan(['reply', 'stop', SAM]), ['reply stop', '/reply/stop', { chatID: SAM }]);
  assert.deepEqual(plan(['brief', SAM]), ['brief', '/brief', { chatID: SAM }]);
  assert.equal(appCommand(['brief', SAM]).timeoutMs, 10 * 60_000, 'a Brief is one agent call, which may run minutes');
  assert.deepEqual(plan(['sends']), ['sends', '/sends', {}]);
  assert.deepEqual(plan(['sends', SAM]), ['sends', '/sends', { chatID: SAM }]);
  assert.deepEqual(plan(['send', 'settle', SAM, '12', '--went', '--message', 'm-9']), ['send settle', '/send/settle', { chatID: SAM, sendID: 12, went: true, messageID: 'm-9' }]);
  assert.deepEqual(plan(['send', 'settle', SAM, '12', '--went', '--confirmed']), ['send settle', '/send/settle', { chatID: SAM, sendID: 12, went: true, confirmed: true }]);
  assert.deepEqual(plan(['send', 'settle', SAM, '12', '--didnt', '--confirmed']), ['send settle', '/send/settle', { chatID: SAM, sendID: 12, went: false, confirmed: true }]);
  for (const args of [['brief'], ['brief', 'Sam'], ['brief', SAM, SAM], ['pause', 'now'], ['pause', 'off', 'please'], ['check'], ['keep', 'drafting', 'today'], ['reply', 'stop'], ['reply', 'stop', 'Sam'], ['sends', 'Sam'],
    ['send', 'settle', SAM, '12'], ['send', 'settle', SAM, '12', '--went'], ['send', 'settle', SAM, '12', '--didnt'], ['send', 'settle', SAM, '12', '--didnt', '--message', 'm-9', '--confirmed'],
    ['send', 'settle', SAM, 'x12', '--went', '--confirmed'], ['send', 'settle', SAM, '12', '--went', '--didnt', '--confirmed'], ['send', 'settle', 'Sam', '12', '--went', '--confirmed']])
    assert.throws(() => appCommand(args), /Usage:/, args.join(' '));
  for (const action of ACTIONS) assert.ok(APP_USAGE.includes(action.usage), action.name);
});

test('each runs in its own modes, checked before anything connects: stopping in drafts too, reading in readonly too', async t => {
  const app = await fakeApp(t);
  const cases = [[['pause'], 'drafts', 0], [['pause', 'off'], 'drafts', 2], [['check', 'now'], 'drafts', 2], [['keep', 'drafting'], 'drafts', 2], [['reply', 'stop', SAM], 'drafts', 0], [['brief', SAM], 'drafts', 0], [['brief', SAM], 'readonly', 2],
    [['sends'], 'readonly', 0], [['pause'], 'readonly', 2], [['send', 'settle', SAM, '3', '--went', '--confirmed'], 'drafts', 2]];
  for (const run of [{}, { COMPANION_RUN: 'run-fixture' }]) for (const [args, mode, status] of cases) {
    app.requests.length = 0;
    const r = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: mode, ...run }), ['app', ...args]);
    assert.equal(r.status, status, `${args.join(' ')} in ${mode}: ${r.stderr}`);
    if (status) {
      assert.match(r.stderr, mode === 'readonly' ? /^usage: Read-only mode is on/ : /^usage: Drafts-only mode is on/);
      assert.deepEqual(app.requests, [], 'no request at all');
    } else assert.deepEqual(app.requests.at(-1).path, appCommand(args).path);
  }
});

test('the app\'s answer prints as JSON, and an answer that says no exits 1', async t => {
  const ok = await fakeApp(t, { answer: { ok: true, settled: 'sent' } });
  const r = await ba(envFor(ok, { COMPANION_RUN: 'run-fixture' }), ['app', 'send', 'settle', SAM, '3', '--went', '--message', 'm-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, settled: 'sent' });
  assert.deepEqual(ok.requests.map(q => [q.method, q.path, q.run, q.body]), [['GET', '/metadata', 'run-fixture', undefined],
    ['POST', '/send/settle', 'run-fixture', { chatID: SAM, sendID: 3, went: true, messageID: 'm-1' }]]);
  const no = await fakeApp(t, { answer: { ok: false, message: 'No reply is sending in that Chat.' } });
  const stopped = await ba(envFor(no), ['app', 'reply', 'stop', SAM]);
  assert.equal(stopped.status, 1);
  assert.deepEqual(JSON.parse(stopped.stdout), { ok: false, message: 'No reply is sending in that Chat.' });
});

test('an older Companion without the action says it needs an update, and asks nothing more', async t => {
  const app = await fakeApp(t, { actions: ['pause'] });
  const r = await ba(envFor(app), ['app', 'check', 'now']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /APP_CLI_UNSUPPORTED: This Beeper Companion is older than that command/);
  assert.deepEqual(app.requests.map(q => q.path), ['/metadata']);
});
