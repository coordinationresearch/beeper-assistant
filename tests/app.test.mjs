import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appClient, appDiscoveryFile } from '../scripts/lib/app.mjs';

test('discovery refuses public files and mismatched data homes before connecting', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ba-app-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = appDiscoveryFile(directory, '/invented');
  writeFileSync(file, JSON.stringify({ protocol: 1, port: 1, token: 'a'.repeat(64), launch: 'test', dataHome: '/invented' }), { mode: 0o644 });
  await assert.rejects(appClient({ directory, dataHome: '/invented' }), /APP_CLI_UNAVAILABLE/);
  chmodSync(file, 0o600);
  writeFileSync(appDiscoveryFile(directory, '/different'), readFileSync(file), { mode: 0o600 });
  await assert.rejects(appClient({ directory, dataHome: '/different' }), /APP_CLI_DISCOVERY/);
});

test('Replies CLI sends the exact ID and prints Directions without a standalone write', async t => {
  const { createServer } = await import('node:http');
  const { runApp } = await import('../scripts/lib/app.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'ba-app-'));
  const token = 'b'.repeat(64), requests = [], output = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/metadata') { res.end(JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, capabilities: ['replies'] })); return; }
    let body = ''; for await (const part of req) body += part;
    requests.push({ path: req.url, method: req.method, body: JSON.parse(body) });
    res.end(JSON.stringify({ chatID: '!fixture', contextVersion: 'fixture', suggestions: [{ intent: 'Agree', steps: [{ kind: 'message', text: 'seven works', waitMs: 0 }] }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(appDiscoveryFile(directory, directory), JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, token, port: server.address().port }), { mode: 0o600 });
  const prior = console.log; console.log = value => output.push(value);
  try { await runApp(['replies', '!fixture'], { directory, dataHome: directory }); } finally { console.log = prior; }
  assert.deepEqual(requests, [{ path: '/replies', method: 'POST', body: { chatID: '!fixture' } }]);
  assert.equal(JSON.parse(output[0]).suggestions[0].direction, 'Agree');
  assert.equal('intent' in JSON.parse(output[0]).suggestions[0], false);
});

test('menu CLI preserves separate Messages, old single-text requests, and Stop', async () => {
  const { ACTIONS } = await import('../scripts/lib/actions.mjs');
  const reply = ACTIONS.find(action => action.name === 'menu reply');
  const rowID = 'a'.repeat(16), version = 'b'.repeat(16);
  const single = reply.parse([rowID, version, 'Friday works', '--confirmed']);
  assert.deepEqual(single, { rowID, version, arg: 'Friday works', confirmed: true });
  assert.equal(reply.check(single), true);
  const multiple = reply.parse([rowID, version, 'Friday works', 'See you there\nAt seven', '--confirmed']);
  assert.deepEqual(multiple, { rowID, version, arg: ['Friday works', 'See you there\nAt seven'], confirmed: true });
  assert.equal(reply.check(multiple), true);
  for (const arg of [[], ['One', ''], ['One', 2], Array(11).fill('one'), ['x'.repeat(10_000), 'two']]) assert.equal(reply.check({ ...multiple, arg }), false);
  assert.throws(() => reply.parse([rowID, version, 'One', 'Two']), /usage/);
  const react = ACTIONS.find(action => action.name === 'menu react');
  assert.equal(react.check(multiple), false);
  const stop = ACTIONS.find(action => action.name === 'menu stop');
  assert.deepEqual(stop.parse([rowID]), { rowID });
  assert.equal(stop.check({ rowID }), true);
});
