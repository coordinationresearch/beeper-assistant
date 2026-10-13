// ba app quiet (ADR 0142) against a fake Companion: a loopback server and a discovery file in a
// temporary folder. No real app, Store, or Beeper is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appCommand, appDiscoveryFile } from '../scripts/lib/app.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

async function fakeApp(t, capabilities = ['status', 'quiet']) {
  const directory = mkdtempSync(join(tmpdir(), 'ba-app-quiet-'));
  const token = 'e'.repeat(64), requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push({ method: req.method, path: req.url, run: req.headers['x-companion-run'] ?? null, ...(raw ? { body: JSON.parse(raw) } : {}) });
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(req.url === '/metadata' ? { protocol: 1, launch: 'fixture', dataHome: directory, capabilities } : { ok: true, mutedThrough: '2026-10-12' }));
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

test('ba app quiet mutes Urgent alerts until tomorrow, and off lifts it; nothing else is a quiet command', () => {
  assert.deepEqual(appCommand(['quiet']), { command: 'quiet', capability: 'quiet', path: '/quiet', payload: {} });
  assert.deepEqual(appCommand(['quiet', 'off']), { command: 'quiet off', capability: 'quiet', path: '/quiet', payload: { off: true } });
  for (const args of [['quiet', 'on'], ['quiet', 'off', 'now'], ['quiet', '--until', 'tomorrow']]) assert.throws(() => appCommand(args), /Usage:/, args.join(' '));
});

test('a late run (drafts) may mute or lift the mute; readonly may not, and makes no request', async t => {
  const app = await fakeApp(t);
  const env = { ...process.env, BEEPER_ASSISTANT_HOME: app.directory, BEEPER_COMPANION_USER_DATA: app.directory, BEEPER_BIN: '/nonexistent/beeper', COMPANION_RUN: 'run-fixture-late' };
  delete env.BEEPER_ASSISTANT_READONLY;
  for (const [args, body] of [[['quiet'], {}], [['quiet', 'off'], { off: true }]]) {
    app.requests.length = 0;
    const r = await ba({ ...env, BEEPER_ASSISTANT_MODE: 'drafts' }, ['app', ...args]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, mutedThrough: '2026-10-12' });
    assert.deepEqual(app.requests.map(q => [q.method, q.path, q.run, q.body]), [['GET', '/metadata', 'run-fixture-late', undefined], ['POST', '/quiet', 'run-fixture-late', body]]);
    app.requests.length = 0;
    const readonly = await ba({ ...env, BEEPER_ASSISTANT_MODE: 'readonly' }, ['app', ...args]);
    assert.equal(readonly.status, 2);
    assert.match(readonly.stderr, /^usage: Read-only mode is on, so "app quiet[a-z ]*" did not run and nothing changed\./);
    assert.deepEqual(app.requests, []);
  }
});

test('an older Companion without quiet says it needs an update, and nothing is sent', async t => {
  const app = await fakeApp(t, ['status']);
  const env = { ...process.env, BEEPER_ASSISTANT_HOME: app.directory, BEEPER_COMPANION_USER_DATA: app.directory, BEEPER_BIN: '/nonexistent/beeper', COMPANION_RUN: 'run-fixture' };
  delete env.BEEPER_ASSISTANT_READONLY;
  delete env.BEEPER_ASSISTANT_MODE;
  const r = await ba(env, ['app', 'quiet']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /APP_CLI_UNSUPPORTED/);
  assert.deepEqual(app.requests.map(q => q.path), ['/metadata']);
});
