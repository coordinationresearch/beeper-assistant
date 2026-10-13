// ba app runs (docs/plans/observability.md, slice 2, ADR 0240) against a fake Companion: a loopback
// server and a discovery file in a temporary folder. No real app, Store, or Beeper is reached.
// Invented names and text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appCommand, appDiscoveryFile, APP_USAGE } from '../scripts/lib/app.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const ANSWER = { paused: false, running: [], upNext: [{ kind: 'timed', id: 'timed:4', requestID: '00000000-0000-4000-9000-000000000004', chatID: '!sam-invented:beeper.local',
  title: 'Sam Example', at: '2026-10-13T16:00:00.000Z', text: 'Happy birthday, Sam!', why: 'at', left: 1, hold: 'paused' }],
  done: [{ id: 'item:3', kind: 'timed', chatID: '!dana-invented:beeper.local', title: 'Dana Example', at: '2026-10-13T13:40:00.000Z', result: "Didn't go", reason: 'Too late to send',
    failed: false, dueAt: '2026-10-13T13:00:00.000Z' }] };

async function fakeApp(t, { capabilities = ['status', 'runs'] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ba-app-runs-'));
  const token = 'f'.repeat(64), requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push({ method: req.method, path: req.url, ...(raw ? { body: JSON.parse(raw) } : {}) });
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(req.url === '/metadata' ? { protocol: 1, launch: 'fixture', dataHome: directory, capabilities } : ANSWER));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(appDiscoveryFile(directory, directory), JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, token, port: server.address().port }), { mode: 0o600 });
  const env = { ...process.env, BEEPER_ASSISTANT_HOME: directory, BEEPER_COMPANION_USER_DATA: directory, BEEPER_BIN: '/nonexistent/beeper', COMPANION_RUN: 'run-fixture-runs' };
  delete env.BEEPER_ASSISTANT_READONLY;
  delete env.BEEPER_ASSISTANT_MODE;
  return { requests, env };
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

test('ba app runs reads the Runs page, a week by default, and takes only --days 1 to 7 and --limit 1 to 1000', () => {
  // A cold read names the week's Chats from the Corpus, which may take 15 s, so it waits 30, not a plain read's 10.
  assert.deepEqual(appCommand(['runs']), { command: 'runs', capability: 'runs', path: '/runs', timeoutMs: 30_000 });
  assert.deepEqual(appCommand(['runs', '--days', '1', '--limit', '20']), { command: 'runs', capability: 'runs', path: '/runs?days=1&limit=20', timeoutMs: 30_000 });
  assert.deepEqual(appCommand(['runs', '--limit', '1000']).path, '/runs?limit=1000');
  for (const args of [['runs', '--days', '0'], ['runs', '--days', '8'], ['runs', '--days'], ['runs', '--limit', '1001'], ['runs', '--limit', '0'], ['runs', '--days', '1', '--days', '2'],
    ['runs', 'all'], ['runs', '--chat', '!dana-invented:beeper.local']])
    assert.throws(() => appCommand(args), undefined, args.join(' '));
  assert.match(APP_USAGE, /\n {2}ba app runs \[--days <1-7>\] \[--limit <1-1000>\]\n/);
});

test('it prints the app\'s JSON as it is, in drafts and full modes, a late run included; readonly makes no request', async t => {
  const app = await fakeApp(t);
  for (const mode of ['full', 'drafts']) {
    app.requests.length = 0;
    const r = await ba({ ...app.env, BEEPER_ASSISTANT_MODE: mode }, ['app', 'runs', '--days', '1']);
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), ANSWER);
    assert.deepEqual(app.requests.map(q => [q.method, q.path]), [['GET', '/metadata'], ['GET', '/runs?days=1']], mode);
  }
  app.requests.length = 0;
  const readonly = await ba({ ...app.env, BEEPER_ASSISTANT_MODE: 'readonly' }, ['app', 'runs']);
  assert.equal(readonly.status, 2);
  assert.match(readonly.stderr, /^usage: Read-only mode is on, so "app runs" did not run and nothing changed\./);
  assert.deepEqual(app.requests, []);
});

test('an older Companion without runs says it needs an update', async t => {
  const old = await fakeApp(t, { capabilities: ['status', 'later'] });
  const refused = await ba(old.env, ['app', 'runs']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /APP_CLI_UNSUPPORTED/);
  assert.deepEqual(old.requests.map(q => q.path), ['/metadata']);
});
