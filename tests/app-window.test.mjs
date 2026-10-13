// Auto with an end time (ADR 0122; docs/plans/always-on.md, slice 3): `ba app auto on` and `goal`
// with --for, --until, and --text-first, the window in their answers, and the windows `ba app later
// list` prints. A fake Companion on loopback; no real app, Store, or Beeper is reached. Invented
// Chats only. Times print in the Mac's zone, pinned here.
process.env.TZ = 'America/Los_Angeles';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appCommand, appDiscoveryFile, laterLines, runApp } from '../scripts/lib/app.mjs';

const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');
const CHAT = '!invented-window-chat:beeper.local';
const REQUEST = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const UNTIL = '2026-10-12T23:00-07:00';

async function fakeApp(t, { capabilities = ['status', 'auto', 'later'], answer = () => [200, { ok: true }] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ba-app-window-'));
  const token = 'f'.repeat(64), requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, run: req.headers['x-companion-run'] ?? null, ...(body === undefined ? {} : { body }) });
    res.setHeader('Content-Type', 'application/json');
    const reply = req.url === '/metadata' ? [200, { protocol: 1, launch: 'fixture', dataHome: directory, capabilities }] : answer(req.url, body, res);
    if (!reply) return;
    res.writeHead(reply[0]); res.end(JSON.stringify(reply[1]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(appDiscoveryFile(directory, directory), JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, token, port: server.address().port }), { mode: 0o600 });
  return { directory, requests, options: { directory, dataHome: directory, run: 'run-invented-window' }, asked: () => requests.filter(r => r.path !== '/metadata') };
}

async function printed(action) {
  const output = [], prior = console.log;
  console.log = value => output.push(value);
  try { await action(); } finally { console.log = prior; }
  return output;
}

function ba(env, args, { input } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BA, ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

test('on and goal take a window: --for or --until, and --text-first, in any order after the Chat', () => {
  const plan = (args) => { const p = appCommand(args); return [p.command, p.path, p.payload]; };
  assert.deepEqual(plan(['auto', 'on', CHAT, '--for', '20m', '--text-first']), ['auto on', '/auto/on', { chatID: CHAT, for: '20m', textFirst: true }]);
  assert.deepEqual(plan(['auto', 'on', CHAT, '--until', UNTIL]), ['auto on', '/auto/on', { chatID: CHAT, until: UNTIL }]);
  assert.deepEqual(plan(['auto', 'on', CHAT, '--for=12h']), ['auto on', '/auto/on', { chatID: CHAT, for: '12h' }]);
  assert.deepEqual(plan(['auto', 'goal', CHAT, 'settle', '--for', '2h', "Saturday's", 'plan', '--text-first']),
    ['auto goal', '/auto/goal', { chatID: CHAT, goal: "settle Saturday's plan", for: '2h', textFirst: true }]);
  assert.deepEqual(plan(['auto', 'goal', CHAT, 'plan', 'dinner']), ['auto goal', '/auto/goal', { chatID: CHAT, goal: 'plan dinner' }], 'without flags, as before');
  assert.deepEqual(plan(['auto', 'on', CHAT]), ['auto on', '/auto/on', { chatID: CHAT }], 'without flags, as before');
});

test('a malformed window is refused before anything connects, with a fixed sentence', () => {
  const refusals = [
    [['auto', 'on', CHAT, '--for', '20m', '--until', UNTIL], /^Give --for or --until, not both\. Nothing was sent\.$/],
    [['auto', 'on', CHAT, '--for', '0m'], /^Give --for between 1m and 12h, such as 20m or 2h\. Nothing was sent\.$/],
    [['auto', 'on', CHAT, '--for', '13h'], /^Give --for between 1m and 12h/],
    [['auto', 'on', CHAT, '--for', '721m'], /^Give --for between 1m and 12h/],
    [['auto', 'on', CHAT, '--for', '1d'], /^Give --for between 1m and 12h/],
    [['auto', 'on', CHAT, '--for', 'a while'], /^Give --for between 1m and 12h/],
    [['auto', 'on', CHAT, '--until', 'tonight'], /^Give --until as an ISO time with its zone, between a minute and 12 hours from now\. Nothing was sent\.$/],
    [['auto', 'on', CHAT, '--until', '2026-10-12T23:00'], /^Give --until as an ISO time with its zone/],
    [['auto', 'on', CHAT, '--text-first'], /^--text-first goes with --for or --until\. Nothing was sent\.$/],
    [['auto', 'goal', CHAT, 'plan', 'dinner', '--text-first'], /^--text-first goes with --for or --until\./],
    [['auto', 'on', CHAT, '--for', '20m', '--for', '30m'], /^--for may be given only once\./],
    [['auto', 'on', CHAT, '--text-first=yes', '--for', '20m'], /^--text-first takes no value\./],
    [['auto', 'on', CHAT, '--for'], /^--for needs a value\./],
    [['auto', 'on', CHAT, '--for', '--text-first'], /^--for needs a value\./],
    [['auto', 'on', CHAT, '--every', '1m'], /^--every is not supported by ba app auto on\. Only --for, --until, and --text-first go with it, and nothing was sent\.$/],
    [['auto', 'goal', CHAT, 'plan', '-x'], /^-x is not supported by ba app auto goal\./],
  ];
  for (const [args, message] of refusals) assert.throws(() => appCommand(args), { message }, args.join(' '));
  // Other Auto commands still take no flags at all.
  assert.throws(() => appCommand(['auto', 'go', CHAT, '--for', '20m']), /^Error: --for is not supported by ba app auto\. These commands take no flags/);
  assert.throws(() => appCommand(['auto', 'off', CHAT, '--until', UNTIL]), /^Error: --until is not supported by ba app auto\./);
  // on takes no words after the Chat; goal needs some.
  assert.throws(() => appCommand(['auto', 'on', CHAT, 'extra', '--for', '20m']), /^Error: Usage:/);
  assert.throws(() => appCommand(['auto', 'goal', CHAT, '--for', '20m']), /^Error: Usage:/);
  assert.throws(() => appCommand(['auto', 'on', 'Jordan', '--for', '20m']), /is not a Chat ID/);
});

test('the answer prints as JSON, with the window end in the Mac zone and the rest as the app sent it', async t => {
  const window = { requestID: REQUEST, until: '2026-10-13T06:00:00.000Z', textFirst: true, wasOn: false };
  const row = { chatID: CHAT, name: 'Dinner Crew', on: true, status: 'listening', since: '2026-10-13T05:40:00.000Z', offAt: null, until: '2026-10-13T06:00:00.000Z', windowRequest: REQUEST };
  const app = await fakeApp(t, { answer: path => [200, path === '/auto' ? { chats: [row, { ...row, chatID: '!other:beeper.local', until: null, windowRequest: null }] } : { ok: true, chats: [row], window }] });
  const on = JSON.parse((await printed(() => runApp(['auto', 'on', CHAT, '--for', '20m', '--text-first'], app.options))).join('\n'));
  assert.deepEqual(app.asked().map(r => [r.path, r.body]), [['/auto/on', { chatID: CHAT, for: '20m', textFirst: true }]]);
  assert.deepEqual(on.window, { ...window, until: '2026-10-12T23:00-07:00 (Mon)' });
  assert.equal(on.chats[0].until, '2026-10-12T23:00-07:00 (Mon)');
  assert.equal(on.chats[0].since, row.since, 'only the window end is converted');
  const list = JSON.parse((await printed(() => runApp(['auto', 'list'], app.options))).join('\n'));
  assert.deepEqual(list.chats.map(c => c.until), ['2026-10-12T23:00-07:00 (Mon)', null]);
  assert.deepEqual(list.chats.map(c => c.windowRequest), [REQUEST, null]);
  // A refusal is the app's own sentence, and exits 1 as any Auto refusal does.
  const refusing = await fakeApp(t, { answer: () => [200, { ok: false, message: 'Give --for between 1m and 12h, such as 20m or 2h.' }] });
  const prior = process.exitCode;
  const out = JSON.parse((await printed(() => runApp(['auto', 'on', CHAT, '--for', '20m'], refusing.options))).join('\n'));
  assert.equal(out.message, 'Give --for between 1m and 12h, such as 20m or 2h.');
  assert.equal(process.exitCode, 1);
  process.exitCode = prior;
});

test('ba app later list prints each Auto window under its request', () => {
  const plan = { command: 'later list' };
  const listed = laterLines(plan, { requests: [{ requestID: REQUEST, origin: 'line', instruction: 'keep the group going for 20 minutes', maySend: true, endsAt: '2026-10-13T06:00:00.000Z',
    wakes: 0, sends: 0, items: [], timed: [], windows: [
      { itemID: 7, chatID: CHAT, endsAt: '2026-10-13T06:00:00.000Z', textFirst: true, wasOn: false, state: 'waiting' },
      { itemID: 8, chatID: 'imsg##thread:invented', endsAt: '2026-10-13T07:30:00.000Z', textFirst: false, wasOn: true, state: 'waiting' },
      { itemID: 9, chatID: 'Not an ID', endsAt: 'soon', textFirst: 'yes', state: 'odd' },
    ] }] });
  assert.equal(listed.exitCode, 0);
  assert.deepEqual(listed.lines.slice(2), [
    `  ${CHAT} · Auto until 2026-10-12T23:00-07:00 (Mon) · texts first when it goes quiet · waiting`,
    '  imsg##thread:invented · Auto until 2026-10-13T00:30-07:00 (Tue) · answering only · Auto stays on after · waiting',
    "  a Chat ba can't name · Auto until an unknown time · answering only · state unknown",
  ]);
  assert.deepEqual(laterLines(plan, { requests: [] }).lines, ['No Look-agains, Timed sends, or Auto windows are waiting.']);
});

test('a window is a change: drafts and readonly modes refuse it before anything connects', async t => {
  const app = await fakeApp(t);
  const env = { ...process.env, BEEPER_ASSISTANT_HOME: app.directory, BEEPER_COMPANION_USER_DATA: app.directory, BEEPER_BIN: '/nonexistent/beeper', COMPANION_RUN: 'run-invented-window' };
  delete env.BEEPER_ASSISTANT_READONLY;
  for (const mode of ['drafts', 'readonly']) {
    for (const args of [['app', 'auto', 'on', CHAT, '--for', '20m', '--text-first'], ['app', 'auto', 'goal', CHAT, 'plan', 'dinner', '--until', UNTIL]]) {
      app.requests.length = 0;
      const r = await ba({ ...env, BEEPER_ASSISTANT_MODE: mode }, args);
      assert.equal(r.status, 2, `${mode} ${args.join(' ')}`);
      assert.match(r.stderr, /mode is on, so "app auto (on|goal)" did not run and nothing changed\./);
      assert.deepEqual(app.requests, [], 'nothing connected');
    }
  }
  // In full mode the same command reaches the app once, with the window.
  const r = await ba({ ...env, BEEPER_ASSISTANT_MODE: 'full' }, ['app', 'auto', 'on', CHAT, '--for', '20m', '--text-first']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(app.asked().map(q => [q.path, q.body, q.run]), [['/auto/on', { chatID: CHAT, for: '20m', textFirst: true }, 'run-invented-window']]);
  // A malformed window is a usage error, before anything connects.
  app.requests.length = 0;
  const bad = await ba({ ...env, BEEPER_ASSISTANT_MODE: 'full' }, ['app', 'auto', 'on', CHAT, '--for', '20m', '--until', UNTIL]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^usage: Give --for or --until, not both\. Nothing was sent\./);
  assert.deepEqual(app.requests, []);
});
