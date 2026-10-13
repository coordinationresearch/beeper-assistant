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
