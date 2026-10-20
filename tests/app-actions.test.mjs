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
  assert.deepEqual(plan(['uninstall']), ['uninstall', '/uninstall', {}]);
  assert.deepEqual(plan(['reply', 'stop', SAM]), ['reply stop', '/reply/stop', { chatID: SAM }]);
  assert.deepEqual(plan(['reply', 'leave', 'out', 'first', SAM]), ['reply leave out first', '/reply/leave-out-first', { chatID: SAM }]);
  assert.deepEqual(plan(['brief', SAM]), ['brief', '/brief', { chatID: SAM }]);
  // The wait on a later Step (ADR 0275): what the sidebar shows, then the wait to set, or the Owner's pace again.
  assert.deepEqual(plan(['reply', 'wait', SAM, 'options', 'g1:0', '0', '2', '8s', '30s']), ['reply wait', '/reply/wait', { chatID: SAM, source: 'options', id: 'g1:0', index: 0, step: 2, before: 8_000, ms: 30_000 }]);
  assert.deepEqual(plan(['reply', 'wait', SAM, 'draft', 'd1', '1', '1', '12', '2m']).at(-1), { chatID: SAM, source: 'draft', id: 'd1', index: 1, step: 1, before: 12_000, ms: 120_000 });
  assert.deepEqual(plan(['reply', 'wait', SAM, 'agent', 's1', '0', '1', '1.5m', 'pace']).at(-1), { chatID: SAM, source: 'agent', id: 's1', index: 0, step: 1, before: 90_000, ms: null });
  assert.deepEqual(plan(['reply', 'pace']), ['reply pace', '/reply/pace', {}]);
  assert.deepEqual(plan(['reply', 'pace', 'set', '1.5']), ['reply pace set', '/reply/pace/set', { choice: '1.5' }]);
  for (const args of [['reply', 'wait', SAM, 'options', 'g1:0', '0', '0', '8s', '30s'], ['reply', 'wait', SAM, 'box', 'g1:0', '0', '1', '8s', '30s'], ['reply', 'wait', SAM, 'options', 'g1:0', '0', '1', 'soon', '30s'],
    ['reply', 'wait', SAM, 'options', 'g1:0', '0', '1', '8s', 'later'], ['reply', 'wait', SAM, 'options', 'g1:0', '0', '1', '8s'], ['reply', 'pace', 'set', 'fast'], ['reply', 'pace', 'set'], ['reply', 'pace', 'now']])
    assert.throws(() => appCommand(args), /Usage:/, args.join(' '));
  assert.equal(appCommand(['brief', SAM]).timeoutMs, 10 * 60_000, 'a Brief is one agent call, which may run minutes');
  assert.deepEqual(plan(['sends']), ['sends', '/sends', {}]);
  assert.deepEqual(plan(['sends', SAM]), ['sends', '/sends', { chatID: SAM }]);
  assert.deepEqual(plan(['send', 'settle', SAM, '12', '--went', '--message', 'm-9']), ['send settle', '/send/settle', { chatID: SAM, sendID: 12, went: true, messageID: 'm-9' }]);
  assert.deepEqual(plan(['send', 'settle', SAM, '12', '--went', '--confirmed']), ['send settle', '/send/settle', { chatID: SAM, sendID: 12, went: true, confirmed: true }]);
  assert.deepEqual(plan(['send', 'settle', SAM, '12', '--didnt', '--confirmed']), ['send settle', '/send/settle', { chatID: SAM, sendID: 12, went: false, confirmed: true }]);
  for (const args of [['brief'], ['brief', 'Sam'], ['brief', SAM, SAM], ['pause', 'now'], ['pause', 'off', 'please'], ['check'], ['keep', 'drafting', 'today'], ['uninstall', 'now'], ['reply', 'stop'], ['reply', 'stop', 'Sam'], ['sends', 'Sam'],
    ['send', 'settle', SAM, '12'], ['send', 'settle', SAM, '12', '--went'], ['send', 'settle', SAM, '12', '--didnt'], ['send', 'settle', SAM, '12', '--didnt', '--message', 'm-9', '--confirmed'],
    ['send', 'settle', SAM, 'x12', '--went', '--confirmed'], ['send', 'settle', SAM, '12', '--went', '--didnt', '--confirmed'], ['send', 'settle', 'Sam', '12', '--went', '--confirmed']])
    assert.throws(() => appCommand(args), /Usage:/, args.join(' '));
  for (const action of ACTIONS) assert.ok(APP_USAGE.includes(action.usage), action.name);
});

test('each runs in its own modes, checked before anything connects: stopping in drafts too, reading in readonly too', async t => {
  const app = await fakeApp(t);
  const cases = [[['pause'], 'drafts', 0], [['pause', 'off'], 'drafts', 2], [['check', 'now'], 'drafts', 2], [['keep', 'drafting'], 'drafts', 2], [['uninstall'], 'drafts', 2], [['reply', 'stop', SAM], 'drafts', 0], [['brief', SAM], 'drafts', 0], [['brief', SAM], 'readonly', 2],
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

test('contact choices use exact Chats, and saving requires the Owner confirmation in full mode', async t => {
  const plan = args => { const p = appCommand(args); return [p.command, p.path, p.payload]; };
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(plan(['contact', 'matches', SAM, '--search', 'Sam Reed']), ['contact matches', '/contact/matches', { chatID: SAM, search: 'Sam Reed' }]);
  assert.deepEqual(plan(['contact', 'link', SAM, id, '--confirmed']), ['contact link', '/contact/link', { chatID: SAM, choiceID: id, confirmed: true }]);
  for (const args of [['contact', 'matches', 'Sam'], ['contact', 'matches', SAM, '--search'], ['contact', 'link', SAM, id], ['contact', 'link', SAM, 'Sam', '--confirmed']])
    assert.throws(() => appCommand(args), /Usage:/);
  const app = await fakeApp(t);
  for (const mode of ['drafts', 'readonly']) {
    app.requests.length = 0;
    const result = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: mode }), ['app', 'contact', 'link', SAM, id, '--confirmed']);
    assert.equal(result.status, 2); assert.deepEqual(app.requests, []);
  }
  const result = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: 'readonly' }), ['app', 'contact', 'matches', SAM]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(app.requests.at(-1).body, { chatID: SAM, search: '' });
});

test('contact name editing round-trips names, rejects malformed saves and stays out of readonly runs', async t => {
  const id = '11111111-1111-4111-8111-111111111111';
  const args = ['contact', 'rename', SAM, id, '--first', 'Maya', '--last', 'de la Cruz', '--confirmed'];
  assert.deepEqual(appCommand(args).payload, { chatID: SAM, editID: id, first: 'Maya', last: 'de la Cruz', confirmed: true });
  assert.deepEqual(appCommand(['contact', 'name', SAM]).payload, { chatID: SAM });
  for (const bad of [args.slice(0, -1), [...args.slice(0, 5), '\n', ...args.slice(6)], ['contact', 'name', 'Maya']]) assert.throws(() => appCommand(bad), /Usage:/);
  const app = await fakeApp(t);
  for (const mode of ['drafts', 'readonly']) {
    const r = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: mode }), ['app', ...args]); assert.equal(r.status, 2); assert.deepEqual(app.requests, []);
  }
  const r = await ba(envFor(app), ['app', ...args]); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(app.requests.at(-1).body, appCommand(args).payload);
});

test('contact additions preserve the old CLI and round-trip optional fields without accepting extra flags', async t => {
  const base = ['contact', 'rename', SAM, '11111111-1111-4111-8111-111111111111', '--first', 'Maya', '--last', 'Chen'];
  const args = [...base, '--phone', '+1 555 010 0123', '--email', 'Maya+tag@example.test', '--confirmed'];
  const payload = appCommand(args).payload;
  assert.equal(payload.phone, '+1 555 010 0123'); assert.equal(payload.email, 'Maya+tag@example.test');
  for (const tail of [['--phone', '--confirmed'], ['--email', 'a@example.test', '--email', 'b@example.test', '--confirmed'], ['--address', 'street', '--confirmed'], ['--phone', '123\n', '--confirmed']])
    assert.throws(() => appCommand([...base, ...tail]), /Usage:/);
  const app = await fakeApp(t), result = await ba(envFor(app), ['app', ...args]);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(app.requests.at(-1).body, payload);
});


test('menu screening commands carry the issued row and version to their button handlers', async t => {
  const app = await fakeApp(t);
  for (const [words, path] of [[['mark', 'read'], '/menu/mark-read'], [['dismiss'], '/menu/dismiss']]) {
    const result = await ba(envFor(app), ['app', 'menu', ...words, 'a'.repeat(16), 'b'.repeat(16)]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(app.requests.at(-1).body, { rowID: 'a'.repeat(16), version: 'b'.repeat(16) });
    assert.equal(app.requests.at(-1).path, path);
    assert.throws(() => appCommand(['menu', ...words, 'invalid', 'b'.repeat(16)]));
  }
});

test('Diagnostics commands have specific mode authority, strict empty inputs, and no implicit retry', async t => {
  const app = await fakeApp(t);
  const cases = [
    ['view', 'readonly', 0], ['view', 'drafts', 0], ['view', 'full', 0],
    ['off', 'readonly', 2], ['off', 'drafts', 0], ['off', 'full', 0],
    ['on', 'readonly', 2], ['on', 'drafts', 2], ['on', 'full', 0],
    ['send', 'readonly', 2], ['send', 'drafts', 2], ['send', 'full', 0],
  ];
  assert.equal(appCommand(['diagnostics', 'send']).timeoutMs, 30_000);
  assert.equal(appCommand(['diagnostics', 'view']).read, true);
  for (const action of ['view', 'send', 'off', 'on']) {
    assert.deepEqual(appCommand(['diagnostics', action]).payload, {});
    assert.throws(() => appCommand(['diagnostics', action, '--settings', 'anything']), /Usage:/);
  }
  for (const run of [{}, { COMPANION_RUN: 'run-fixture' }]) for (const [action, mode, status] of cases) {
    app.requests.length = 0;
    const result = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: mode, ...run }), ['app', 'diagnostics', action]);
    assert.equal(result.status, status, `${action} in ${mode}: ${result.stderr}`);
    if (status) assert.deepEqual(app.requests, [], 'mode refusal happens before connecting');
    else assert.deepEqual(app.requests.map(r => [r.method, r.path]), [['GET', '/metadata'], ['POST', `/diagnostics/${action}`]], 'one request, never a retry');
  }
});

test('Incident link copying validates its ID and requires an Owner write-capable mode', async t => {
  const app = await fakeApp(t), id = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(appCommand(['incident', 'copy', id]).payload, { id });
  for (const args of [['incident', 'copy'], ['incident', 'copy', '../outside'], ['incident', 'copy', id, 'extra']])
    assert.throws(() => appCommand(args), /Usage:/);
  for (const mode of ['readonly', 'drafts', 'full']) {
    app.requests.length = 0;
    const result = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: mode }), ['app', 'incident', 'copy', id]);
    assert.equal(result.status, mode === 'readonly' ? 2 : 0, result.stderr);
    assert.deepEqual(app.requests.map(r => [r.method, r.path]), mode === 'readonly' ? [] : [['GET', '/metadata'], ['POST', '/incident/copy']]);
  }
});

test("a Person's File commands name a Person, a line, a loop, or an Undo by the ids person file gives, and the Owner's words need his word", async t => {
  const plan = args => { const p = appCommand(args); return [p.command, p.path, p.payload]; };
  assert.deepEqual(plan(['person', 'file', 'p_robin']), ['person file', '/person/file', { personID: 'p_robin' }]);
  assert.deepEqual(plan(['person', 'line', 'edit', 'p_robin', 'f12', 'A neighbor', 'My cousin', '--confirmed']),
    ['person line edit', '/person/line/edit', { personID: 'p_robin', lineID: 'f12', shown: 'A neighbor', text: 'My cousin', confirmed: true }]);
  assert.deepEqual(plan(['person', 'line', 'remove', 'p_robin', 'f12', 'A neighbor', '--confirmed']), ['person line remove', '/person/line/remove', { personID: 'p_robin', lineID: 'f12', shown: 'A neighbor', confirmed: true }]);
  assert.deepEqual(plan(['person', 'line', 'add', 'p_robin', 'who', 'My cousin', '--confirmed']), ['person line add', '/person/line/add', { personID: 'p_robin', part: 'who', text: 'My cousin', confirmed: true }]);
  assert.deepEqual(plan(['person', 'line', 'undo', 'p_robin', 'u0123456789abcdef']), ['person line undo', '/person/line/undo', { personID: 'p_robin', undoID: 'u0123456789abcdef' }]);
  assert.deepEqual(plan(['person', 'loop', 'done', 'p_robin', 'l_0123456789ab']), ['person loop done', '/person/loop/done', { personID: 'p_robin', loopID: 'l_0123456789ab' }]);
  assert.deepEqual(plan(['person', 'write', 'p_robin']), ['person write', '/person/write', { personID: 'p_robin' }]);
  assert.equal(appCommand(['person', 'write', 'p_robin']).timeoutMs, 10 * 60_000, 'a first build is one agent call, which may run minutes');
  assert.deepEqual(plan(['note', 'delete', SAM, 'n0a0b0c0d']), ['note delete', '/note/delete', { chatID: SAM, noteID: 'n0a0b0c0d' }]);
  for (const args of [['person', 'file'], ['person', 'file', 'p robin'], ['person', 'line', 'edit', 'p_robin', '12', 'A', 'B', '--confirmed'], ['person', 'line', 'edit', 'p_robin', 'f12', 'A', 'B'],
    ['person', 'line', 'edit', 'p_robin', 'f12', 'A', '   ', '--confirmed'], ['person', 'line', 'edit', 'p_robin', 'f12', 'A', 'x'.repeat(501), '--confirmed'],
    ['person', 'line', 'add', 'p_robin', 'feelings', 'x', '--confirmed'], ['person', 'line', 'remove', 'p_robin', 'f12', 'A'], ['person', 'loop', 'done', 'p_robin', 'f12'],
    ['person', 'line', 'undo', 'p_robin', 'u1'], ['note', 'delete', 'Sam', 'n0a0b0c0d'], ['instruction', 'delete', 'i1'], ['instruction', 'edit', 'i1', 'new words']])
    assert.throws(() => appCommand(args), /Usage:/, args.join(' '));
  const app = await fakeApp(t);
  const edit = ['person', 'line', 'edit', 'p_robin', 'f12', 'A neighbor', 'My cousin', '--confirmed'];
  for (const mode of ['drafts', 'readonly']) {
    app.requests.length = 0;
    const r = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: mode }), ['app', ...edit]);
    assert.equal(r.status, 2); assert.deepEqual(app.requests, [], 'his words in his File are full mode only');
  }
  const read = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: 'readonly' }), ['app', 'person', 'file', 'p_robin']);
  assert.equal(read.status, 0, read.stderr);
  const write = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: 'drafts' }), ['app', 'person', 'write', 'p_robin']);
  assert.equal(write.status, 0, write.stderr);
  assert.deepEqual(app.requests.at(-1).body, { personID: 'p_robin' });
});

test('an instruction by its ID goes through the table, and the older save keeps its words and its refusal of flags', () => {
  assert.deepEqual([appCommand(['instruction', 'edit', 'i0']).path, appCommand(['instruction', 'edit', 'i0']).payload], ['/instruction/edit', { id: 'i0' }]);
  assert.deepEqual(appCommand(['instruction', 'undo', 'i0']).payload, { id: 'i0' });
  assert.deepEqual(appCommand(['instruction', 'delete', 'i0', '--confirmed']).payload, { id: 'i0', confirmed: true });
  assert.deepEqual([appCommand(['instruction', 'widen', 'i0', 'global']).path, appCommand(['instruction', 'widen', 'i0', 'global']).payload], ['/instruction/widen', { id: 'i0', scope: 'global' }]);
  for (const args of [['instruction', 'widen', 'i0'], ['instruction', 'widen', 'i0', 'reply'], ['instruction', 'widen', 'i0', 'global', 'extra'], ['instruction', 'widen', 'i 0', 'global']])
    assert.throws(() => appCommand(args), /Usage:/, args.join(' '));
  assert.deepEqual(appCommand(['instruction', SAM, 'person']).payload, { chatID: SAM, scope: 'person' });
  assert.throws(() => appCommand(['instruction', SAM, '--person']), /takes no flags|not supported/);
});

test("ba playbook prints the Owner's changes the Companion vouches for, above the Lessons, and in a read-only run too", async t => {
  const changes = [
    { id: 'i-moved', situation: 'Hard news', move: 'Check in later without being asked.', n: 6, cut: false, text: 'Check in on the hard date only.', at: '2026-10-18T12:00:00.000Z' },
    { id: 'i-cut', situation: 'Hard news', move: 'Joining the outrage at the boss.', n: 9, cut: true, text: '', at: '2026-10-18T12:00:00.000Z' },
    { id: 'i-whole', situation: 'Hard news', move: null, n: null, cut: false, text: 'Never send a link.', at: '2026-10-18T12:00:00.000Z' },
  ];
  const app = await fakeApp(t, { answer: { ok: true, changes } });
  const shown = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: 'readonly', COMPANION_RUN: 'run-invented' }), ['playbook', 'hard', 'news']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(app.requests.at(-1), { method: 'POST', path: '/playbook', run: 'run-invented', body: { situation: 'Hard news' } });
  assert.match(shown.stdout, /THE OWNER'S CHANGES · 3\nThe Owner's own words for this situation/);
  assert.match(shown.stdout, /^- Instead of the move "Check in later without being asked\.": "Check in on the hard date only\." \(the Owner, 2026-10-18, i-moved\)$/m);
  assert.match(shown.stdout, /^- Cut the move "Joining the outrage at the boss\."\. Don't use it\./m);
  assert.match(shown.stdout, /^- For this whole situation: "Never send a link\."/m);
  assert.ok(shown.stdout.indexOf("THE OWNER'S CHANGES") < shown.stdout.indexOf('LESSONS for this Owner'));
  const json = JSON.parse((await ba(envFor(app), ['playbook', 'Hard news', '--json'])).stdout);
  assert.deepEqual(json.changes, changes);
  const unreadable = await fakeApp(t, { answer: { ok: true, changes: [{ id: 'x' }] } });
  assert.match((await ba(envFor(unreadable), ['playbook', 'Hard news'])).stdout, /Not read: Beeper Companion gave an answer ba can't read/);
  const old = await fakeApp(t, { actions: ['pause'], answer: { ok: true, changes } });
  assert.match((await ba(envFor(old), ['playbook', 'Hard news'])).stdout, /Not read: this Beeper Companion is older/);
});

test('the Playbook page commands make exactly their requests', async t => {
  const app = await fakeApp(t);
  const change = await ba(envFor(app), ['app', 'playbook', 'change', 'Hard', 'news', '3']);
  assert.equal(change.status, 0, change.stderr);
  assert.deepEqual(app.requests.at(-1).body, { situation: 'Hard news', move: 3 });
  assert.equal((await ba(envFor(app), ['app', 'playbook', 'cut', 'Hard news', '3', '--confirmed'])).status, 0);
  assert.deepEqual(app.requests.at(-1), { method: 'POST', path: '/playbook/cut', run: null, body: { situation: 'Hard news', move: 3, confirmed: true } });
  assert.deepEqual(appCommand(['playbook', 'lesson', 'remove', 'l1234abc', '--confirmed']).payload, { id: 'l1234abc', confirmed: true });
  assert.deepEqual(appCommand(['playbook', 'remove', 'i-whole', '--confirmed']).path, '/playbook/remove');
  assert.equal((await ba(envFor(app, { BEEPER_ASSISTANT_MODE: 'drafts' }), ['app', 'playbook', 'cut', 'Hard news', '3', '--confirmed'])).status, 2, 'only full mode changes the Playbook');
});

test('the Model and Effort rows\' commands: the read runs anywhere, a choice only in full mode', async t => {
  const plan = args => { const p = appCommand(args); return [p.command, p.path, p.payload]; };
  assert.deepEqual(plan(['model']), ['model', '/model', {}]);
  assert.deepEqual(plan(['model', 'set', 'gpt-6.1-sol']), ['model set', '/model/set', { model: 'gpt-6.1-sol' }]);
  assert.deepEqual(plan(['effort', 'set', 'pick']), ['effort set', '/effort/set', { effort: 'pick' }]);
  for (const args of [['model', 'opus'], ['model', 'set'], ['model', 'set', 'opus', 'now'], ['effort', 'set', 'ultra'], ['effort']]) assert.throws(() => appCommand(args), /Usage:/, args.join(' '));
  const app = await fakeApp(t);
  for (const [args, mode, status] of [[['model'], 'readonly', 0], [['model', 'set', 'opus'], 'drafts', 2], [['effort', 'set', 'high'], 'readonly', 2], [['model', 'set', 'own'], 'full', 0]]) {
    app.requests.length = 0;
    const r = await ba(envFor(app, { BEEPER_ASSISTANT_MODE: mode }), ['app', ...args]);
    assert.equal(r.status, status, `${args.join(' ')} in ${mode}: ${r.stderr}`);
    if (status) assert.deepEqual(app.requests, []);
    else assert.deepEqual(app.requests.at(-1).body, appCommand(args).payload);
  }
});
