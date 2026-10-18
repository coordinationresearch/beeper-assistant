// ba app auto and ba app instruction against a fake Companion: a loopback server and a discovery
// file in a temporary folder. No real app, Store, or Beeper is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appCommand, appDiscoveryFile, runApp, APP_CLI_OFF } from '../scripts/lib/app.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const CHAT = '!invented-auto-chat:beeper.local';
const LINE = '!invented-line-chat:beeper.local';
const LINE_KEY = '9fbcac9058936869e611446079c7b3371e9b5ed230298dfdc22bebf2ea9980cd';

// answer(path, body, res) returns [status, value], or null after answering res itself.
async function fakeApp(t, { capabilities = ['status', 'replies', 'auto', 'instruction'], answer = () => [200, { ok: true }] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ba-app-auto-'));
  const token = 'c'.repeat(64), requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, run: req.headers['x-companion-run'] ?? null, ...(body === undefined ? {} : { body }) });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(JSON.stringify({ code: 'APP_CLI_AUTH' })); return; }
    const reply = req.url === '/metadata' && !answer.metadata ? [200, { protocol: 1, launch: 'fixture', dataHome: directory, capabilities }] : answer(req.url, body, res);
    if (!reply) return;
    res.writeHead(reply[0]); res.end(JSON.stringify(reply[1]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(appDiscoveryFile(directory, directory), JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, token, port: server.address().port }), { mode: 0o600 });
  return { directory, requests, options: { directory, dataHome: directory, run: '' } };
}

async function printed(action) {
  const output = [], prior = console.log;
  console.log = value => output.push(value);
  try { await action(); } finally { console.log = prior; }
  return output;
}

test('each app command is one exact request, worked out before anything connects', () => {
  const plans = {
    'auto list': [['auto', 'list'], '/auto', undefined],
    'auto on': [['auto', 'on', CHAT], '/auto/on', { chatID: CHAT }],
    'auto off': [['auto', 'off'], '/auto/off', {}],
    'auto off chat': [['auto', 'off', CHAT], '/auto/off', { chatID: CHAT }],
    'auto goal': [['auto', 'goal', CHAT, 'get', 'a', 'dinner date', 'on the calendar'], '/auto/goal', { chatID: CHAT, goal: 'get a dinner date on the calendar' }],
    'auto clear': [['auto', 'clear', CHAT], '/auto/clear', { chatID: CHAT }],
    'auto pick 1': [['auto', 'pick', CHAT, '1'], '/auto/pick', { chatID: CHAT, pick: 1 }],
    'auto pick 3': [['auto', 'pick', 'imsg##thread:invented', '3'], '/auto/pick', { chatID: 'imsg##thread:invented', pick: 3 }],
    'auto pick auto': [['auto', 'pick', CHAT, 'auto'], '/auto/pick', { chatID: CHAT, pick: 'auto' }],
    'auto go': [['auto', 'go', CHAT], '/auto/go', { chatID: CHAT }],
    'instruction chat': [['instruction', CHAT, 'chat'], '/instruction', { chatID: CHAT, scope: 'chat' }],
    'instruction person': [['instruction', CHAT, 'person'], '/instruction', { chatID: CHAT, scope: 'person' }],
    'instruction global': [['instruction', CHAT, 'global'], '/instruction', { chatID: CHAT, scope: 'global' }],
    'remember': [['remember', CHAT, 'who', 'Your', 'cousin'], '/remember', { chatID: CHAT, part: 'who', text: 'Your cousin' }],
    'forget': [['forget', CHAT, 'Your', 'cousin'], '/forget', { chatID: CHAT, text: 'Your cousin' }],
    'chat': [['chat', CHAT], '/chat', { chatID: CHAT }],
    'chat with no ID': [['chat'], '/chat', {}],
  };
  for (const [name, [args, path, payload]] of Object.entries(plans)) {
    const plan = appCommand(args);
    assert.equal(plan.path, path, name);
    assert.deepEqual(plan.payload, payload, name);
    assert.equal(plan.capability, args[0], name);
  }
  assert.deepEqual(appCommand(['status']), { command: 'status', capability: 'status', path: '/status' });
  assert.deepEqual(appCommand(['replies', '!fixture']), { command: 'replies', capability: 'replies', path: '/replies', payload: { chatID: '!fixture' } });
  for (const args of [[], ['auto'], ['auto', 'list', CHAT], ['auto', 'on'], ['auto', 'on', CHAT, CHAT], ['auto', 'off', CHAT, CHAT], ['auto', 'goal', CHAT],
    ['auto', 'goal', CHAT, '  '], ['auto', 'clear'], ['auto', 'pick', CHAT], ['auto', 'pick', CHAT, '0'], ['auto', 'pick', CHAT, '4'], ['auto', 'pick', CHAT, 'two'],
    ['auto', 'pick', CHAT, '1', '2'], ['auto', 'pick', CHAT, ' 1'], ['auto', 'start', CHAT], ['auto', 'go'], ['auto', 'go', CHAT, CHAT], ['instruction', CHAT], ['instruction', CHAT, 'reply'], ['instruction', CHAT, 'chat', 'extra'],
    ['status', 'extra'], ['replies'], ['replies', '--confirmed'], ['chat', CHAT, CHAT], ['chat', '--json']]) {
    assert.throws(() => appCommand(args), /^Error: Usage:/, args.join(' '));
  }
  // Only the Chat IDs Beeper's API uses: never a name, an alias, a local number, or a flag.
  for (const id of ['Jordan', 'c1a2b3c4d', '12345', '!two words', '!', 'imsg##', `!${'x'.repeat(2048)}`]) {
    for (const args of [['auto', 'on', id], ['auto', 'off', id], ['auto', 'goal', id, 'invented goal'], ['auto', 'clear', id], ['auto', 'pick', id, '2'], ['auto', 'go', id], ['instruction', id, 'person'], ['chat', id]]) {
      assert.throws(() => appCommand(args), /is not a Chat ID\. Use the exact ID that ba app auto list or ba find --json prints/, args.join(' '));
    }
  }
  // No flags: a stray --dry-run or --confirmed never becomes part of a goal or turns anything on.
  for (const args of [['auto', 'off', '--dry-run'], ['auto', 'list', '-h'], ['auto', 'pick', CHAT, '2', '--dry-run'], ['instruction', CHAT, 'person', '--dry-run']]) {
    assert.throws(() => appCommand(args), /^Error: -[-a-z]+ is not supported by ba app (auto|instruction)\. These commands take no flags, and nothing was sent\.$/, args.join(' '));
  }
  // on and goal take only an end time's flags (slice 3): any other is refused the same way.
  for (const args of [['auto', 'goal', CHAT, 'Arrange lunch', '--dry-run'], ['auto', 'goal', CHAT, '--help'], ['auto', 'on', CHAT, '--confirmed'], ['auto', 'on', '--confirmed']]) {
    assert.throws(() => appCommand(args), /^Error: -[-a-z]+ is not supported by ba app auto (on|goal)\. Only --for, --until, and --text-first go with it, and nothing was sent\.$/, args.join(' '));
  }
});

test('each Auto command and instruction posts its route once, with the run on every request', async t => {
  const app = await fakeApp(t, { answer: path => [200, path === '/auto' ? { chats: [{ chatID: CHAT, name: 'Jordan Invented', on: true }] } : { ok: true, chats: [] }] });
  const options = { ...app.options, run: 'run-fixture-1' };
  const cases = [
    [['auto', 'list'], { method: 'GET', path: '/auto' }],
    [['auto', 'on', CHAT], { method: 'POST', path: '/auto/on', body: { chatID: CHAT } }],
    [['auto', 'off'], { method: 'POST', path: '/auto/off', body: {} }],
    [['auto', 'off', CHAT], { method: 'POST', path: '/auto/off', body: { chatID: CHAT } }],
    [['auto', 'goal', CHAT, 'find', 'a', 'time', 'for', 'coffee'], { method: 'POST', path: '/auto/goal', body: { chatID: CHAT, goal: 'find a time for coffee' } }],
    [['auto', 'clear', CHAT], { method: 'POST', path: '/auto/clear', body: { chatID: CHAT } }],
    [['auto', 'pick', CHAT, '2'], { method: 'POST', path: '/auto/pick', body: { chatID: CHAT, pick: 2 } }],
    [['auto', 'pick', CHAT, 'auto'], { method: 'POST', path: '/auto/pick', body: { chatID: CHAT, pick: 'auto' } }],
    [['auto', 'go', CHAT], { method: 'POST', path: '/auto/go', body: { chatID: CHAT } }],
    [['instruction', CHAT, 'person'], { method: 'POST', path: '/instruction', body: { chatID: CHAT, scope: 'person' } }],
  ];
  for (const [args, expected] of cases) {
    app.requests.length = 0;
    const output = await printed(() => runApp(args, options));
    assert.deepEqual(app.requests, [{ method: 'GET', path: '/metadata', run: 'run-fixture-1' }, { ...expected, run: 'run-fixture-1' }], args.join(' '));
    assert.deepEqual(JSON.parse(output.join('\n')), expected.path === '/auto' ? { chats: [{ chatID: CHAT, name: 'Jordan Invented', on: true }] } : { ok: true, chats: [] });
  }
  // With no run in the environment there is no header, on the handshake or the command.
  app.requests.length = 0;
  await printed(() => runApp(['auto', 'list'], app.options));
  assert.deepEqual(app.requests.map(r => r.run), [null, null]);
  // Status and Replies carry it too, and keep their output.
  app.requests.length = 0;
  await printed(() => runApp(['status'], options));
  assert.deepEqual(app.requests, [{ method: 'GET', path: '/metadata', run: 'run-fixture-1' }, { method: 'GET', path: '/status', run: 'run-fixture-1' }]);
});

test('an app without Auto or instructions refuses after the handshake and changes nothing', async t => {
  const app = await fakeApp(t, { capabilities: ['status', 'replies'] });
  for (const args of [['auto', 'list'], ['auto', 'on', CHAT], ['instruction', CHAT, 'chat']]) {
    app.requests.length = 0;
    await assert.rejects(runApp(args, app.options), { message: 'APP_CLI_UNSUPPORTED' });
    assert.deepEqual(app.requests.map(r => r.path), ['/metadata']);
  }
});

test('every refusal code prints its fixed sentence and never the app\'s own text', async t => {
  let code = '';
  const app = await fakeApp(t, { answer: () => [403, { code, message: 'Invented app text' }] });
  const expected = {
    APP_CLI_OFF,
    APP_CLI_LATE: 'APP_CLI_LATE: That came in late; text it again to do it now.',
    APP_CLI_AUTO_OFF: 'APP_CLI_AUTO_OFF: Auto mode is off in the Companion\'s Settings. Only the Owner turns it on there.',
    APP_CLI_LINE_CHAT: 'APP_CLI_LINE_CHAT: That is the Line\'s own Chat. Nothing runs there.',
    APP_CLI_ARGUMENTS: 'APP_CLI_ARGUMENTS: The Companion refused those arguments. Nothing changed.',
    APP_CLI_RUN_ENDED: 'APP_CLI_RUN_ENDED: The Companion run this command belongs to has ended, so it did not run. Nothing changed.',
    APP_CLI_NO_CHAT: 'APP_CLI_NO_CHAT: No Chat goes with this run. Give the Chat ID.',
    APP_CLI_NOT_ASK: 'APP_CLI_NOT_ASK: Only an Ask can do that. This run may read its own Chat\'s record. Nothing changed.',
    APP_CLI_BUSY: 'APP_CLI_BUSY', APP_CLI_CANCELLED: 'APP_CLI_CANCELLED',
    APP_CLI_AUTH: 'APP_CLI_REFUSED', APP_CLI_INVENTED: 'APP_CLI_REFUSED', toString: 'APP_CLI_REFUSED', '': 'APP_CLI_REFUSED',
  };
  for (const [sent, message] of Object.entries(expected)) {
    code = sent;
    app.requests.length = 0;
    await assert.rejects(runApp(['auto', 'on', CHAT], app.options), { message }, sent);
    assert.equal(app.requests.filter(r => r.path === '/auto/on').length, 1, sent);
  }
  // The handshake follows the same gate: a refused /metadata stops before any command.
  const off = await fakeApp(t, { answer: Object.assign(() => [403, { code: 'APP_CLI_OFF', message: 'Invented app text' }], { metadata: true }) });
  await assert.rejects(runApp(['auto', 'off'], off.options), { message: APP_CLI_OFF });
  assert.deepEqual(off.requests.map(r => r.path), ['/metadata']);
});

test('Auto\'s own no prints the app\'s answer and exits 1', async t => {
  const app = await fakeApp(t, { answer: () => [200, { ok: false, message: 'Auto mode works in one-to-one Chats only.' }] });
  const prior = process.exitCode;
  t.after(() => { process.exitCode = prior; });
  const output = await printed(() => runApp(['auto', 'on', CHAT], app.options));
  assert.deepEqual(JSON.parse(output.join('\n')), { ok: false, message: 'Auto mode works in one-to-one Chats only.' });
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  await printed(() => runApp(['auto', 'list'], app.options));
  assert.equal(process.exitCode, 1, 'a list answer with ok: false also reports it');
});

test('the Line\'s own Chat is refused before anything connects', async t => {
  const app = await fakeApp(t);
  writeFileSync(join(app.directory, 'line-chat.json'), JSON.stringify({ chatKey: LINE_KEY }), { mode: 0o600 });
  for (const args of [['auto', 'on', LINE], ['auto', 'off', LINE], ['auto', 'goal', LINE, 'invented goal'], ['auto', 'clear', LINE], ['auto', 'pick', LINE, '1'], ['instruction', LINE, 'chat']]) {
    await assert.rejects(runApp(args, app.options), { message: 'APP_CLI_LINE_CHAT: That is the Line\'s own Chat. Nothing runs there.' }, args.join(' '));
  }
  assert.deepEqual(app.requests, []);
  // Other Chats, and commands that name no Chat, still go.
  await printed(async () => { await runApp(['auto', 'on', CHAT], app.options); await runApp(['auto', 'off'], app.options); await runApp(['auto', 'list'], app.options); });
  assert.deepEqual(app.requests.filter(r => r.path !== '/metadata').map(r => r.path), ['/auto/on', '/auto/off', '/auto']);
});

test('a change the app may have received is reported uncertain and never sent again', async t => {
  const app = await fakeApp(t, { answer: (path, body, res) => { res.socket.destroy(); return null; } });
  await assert.rejects(runApp(['auto', 'on', CHAT], app.options), /^Error: APP_CLI_UNCERTAIN: The Companion did not answer, so the change may have happened\./);
  assert.deepEqual(app.requests.map(r => r.path), ['/metadata', '/auto/on']);
  app.requests.length = 0;
  await assert.rejects(runApp(['auto', 'list'], app.options), { message: 'APP_CLI_UNAVAILABLE' });
  assert.deepEqual(app.requests.map(r => r.path), ['/metadata', '/auto']);
});

test('an answer that breaks off after the app took the change is uncertain too', async t => {
  const app = await fakeApp(t, { answer: (path, body, res) => { res.writeHead(200); res.write('{"ok":tr'); setTimeout(() => res.socket.destroy(), 20); return null; } });
  for (const args of [['auto', 'off'], ['auto', 'goal', CHAT, 'invented goal'], ['instruction', CHAT, 'chat']]) {
    app.requests.length = 0;
    await assert.rejects(runApp(args, app.options), /^Error: APP_CLI_UNCERTAIN: /, args.join(' '));
    assert.equal(app.requests.length, 2, args.join(' '));
  }
  // A read that breaks off is not a change, and says nothing about one.
  await assert.rejects(runApp(['auto', 'list'], app.options), error => !/UNCERTAIN/.test(error.message));
});

test('a malformed COMPANION_RUN sends nothing', async t => {
  const app = await fakeApp(t);
  for (const run of ['two words', 'line\nbreak', 'x'.repeat(257)]) {
    await assert.rejects(runApp(['auto', 'list'], { ...app.options, run }), { message: 'APP_CLI_RUN: COMPANION_RUN is not a run ID. Nothing was sent.' });
  }
  assert.deepEqual(app.requests, []);
});

// The real entry point, in a child process, with the run and mode in its environment.
function ba(script, env, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(SCRIPTS, script), ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('modes: list and status run in every mode, off in drafts and full, every other change in full only', async t => {
  const app = await fakeApp(t, { capabilities: ['status', 'replies', 'auto', 'instruction', 'remember', 'forget', 'chat', 'voice', 'timeline'], answer: path => [200, path === '/replies' ? { chatID: CHAT, suggestions: [] } : path === '/status' ? { version: '0.0.0' } : path === '/auto' ? { chats: [] } : { ok: true }] });
  const env = { ...process.env, BEEPER_ASSISTANT_HOME: app.directory, BEEPER_COMPANION_USER_DATA: app.directory, BEEPER_BIN: '/nonexistent/beeper', COMPANION_RUN: 'run-fixture-2' };
  delete env.BEEPER_ASSISTANT_READONLY;
  const commands = {
    status: [['status'], '/status'], replies: [['replies', CHAT], '/replies'], 'auto list': [['auto', 'list'], '/auto'],
    'auto off': [['auto', 'off'], '/auto/off'], 'auto off chat': [['auto', 'off', CHAT], '/auto/off'],
    'auto on': [['auto', 'on', CHAT], '/auto/on'], 'auto goal': [['auto', 'goal', CHAT, 'invented', 'goal'], '/auto/goal'],
    'auto clear': [['auto', 'clear', CHAT], '/auto/clear'], 'auto pick': [['auto', 'pick', CHAT, '2'], '/auto/pick'], 'auto go': [['auto', 'go', CHAT], '/auto/go'],
    instruction: [['instruction', CHAT, 'person'], '/instruction'], remember: [['remember', CHAT, 'now', 'Moving', 'in', 'June'], '/remember'], forget: [['forget', CHAT, 'Moving', 'in', 'June'], '/forget'],
    chat: [['chat', CHAT], '/chat'], voice: [['voice', CHAT], '/voice'], timeline: [['timeline', CHAT], '/timeline'],
  };
  // Inside a Companion run, readonly may read a Chat's record: the app answers with the run's own
  // Chat, cut for what it writes (docs/plans/one-agent.md, slice 4). Without a run it can't (below).
  const allowed = {
    readonly: ['status', 'replies', 'auto list', 'chat', 'voice'],
    drafts: ['status', 'replies', 'auto list', 'auto off', 'auto off chat', 'chat', 'voice', 'timeline'],
    full: Object.keys(commands),
  };
  for (const [mode, names] of Object.entries(allowed)) {
    for (const [name, [args, path]] of Object.entries(commands)) {
      app.requests.length = 0;
      const r = await ba('ba.mjs', { ...env, BEEPER_ASSISTANT_MODE: mode }, ['app', ...args]);
      if (names.includes(name)) {
        assert.equal(r.status, 0, `${mode} ${name}: ${r.stderr}`);
        assert.deepEqual(app.requests.map(q => [q.path, q.run]), [['/metadata', 'run-fixture-2'], [path, 'run-fixture-2']], `${mode} ${name}`);
      } else {
        assert.equal(r.status, 2, `${mode} ${name}`);
        assert.match(r.stderr, mode === 'readonly' ? /^usage: Read-only mode is on, so "app [a-z ]+" did not run and nothing changed\./ : /^usage: Drafts-only mode is on, so "app [a-z ]+" did not run and nothing changed\./, `${mode} ${name}`);
        assert.deepEqual(app.requests, [], `${mode} ${name} made a request`);
      }
    }
  }
  // Readonly outside a Companion run still can't read a Chat's record, which holds the Owner's Asks.
  app.requests.length = 0;
  const outside = { ...env, BEEPER_ASSISTANT_MODE: 'readonly' };
  delete outside.COMPANION_RUN;
  const refused = await ba('ba.mjs', outside, ['app', 'chat', CHAT]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^usage: Read-only mode is on, so "app chat" did not run and nothing changed\./);
  assert.deepEqual(app.requests, []);
  // A late Line run hears that turning Auto off still works.
  assert.match((await ba('ba.mjs', { ...env, BEEPER_ASSISTANT_MODE: 'drafts' }, ['app', 'auto', 'on', CHAT])).stderr, /and turn Auto off with app auto off\./);
  // A usage error never connects.
  app.requests.length = 0;
  const bad = await ba('ba.mjs', env, ['app', 'auto', 'on', 'Jordan']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^usage: "Jordan" is not a Chat ID\./);
  const dry = await ba('ba.mjs', env, ['app', 'auto', 'goal', CHAT, 'Arrange', 'lunch', '--dry-run']);
  assert.equal(dry.status, 2);
  assert.match(dry.stderr, /^usage: --dry-run is not supported by ba app auto goal\. Only --for, --until, and --text-first go with it/);
  assert.deepEqual(app.requests, []);
});

test("ba app line reads the Line's own texts in every mode, a late run included, paging with --before", async t => {
  const texts = { texts: [{ id: 'm1', at: '2026-10-10T20:00:00Z', from: 'owner', text: 'text Sam running 10 late' }] };
  const app = await fakeApp(t, { capabilities: ['status', 'auto', 'line'], answer: path => path.startsWith('/line') ? [200, texts] : [404, { code: 'APP_CLI_REFUSED' }] });
  assert.deepEqual(appCommand(['line']).path, '/line');
  assert.deepEqual(appCommand(['line', '--before', 'm9', '--limit', '50']).path, '/line?before=m9&limit=50');
  for (const bad of [['line', '--limit', '0'], ['line', '--limit', '101'], ['line', '--before'], ['line', '--sideways', 'x'], ['line', '--limit', '5', '--limit', '6']]) assert.throws(() => appCommand(bad), /Usage/, bad.join(' '));
  const env = { ...process.env, BEEPER_ASSISTANT_HOME: app.directory, BEEPER_COMPANION_USER_DATA: app.directory, BEEPER_BIN: '/nonexistent/beeper', COMPANION_RUN: 'run-fixture-3' };
  delete env.BEEPER_ASSISTANT_READONLY;
  for (const mode of ['readonly', 'drafts', 'full']) {
    app.requests.length = 0;
    const r = await ba('ba.mjs', { ...env, BEEPER_ASSISTANT_MODE: mode }, ['app', 'line', '--before', 'm9']);
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), texts);
    assert.deepEqual(app.requests.map(q => [q.method, q.path, q.run]), [['GET', '/metadata', 'run-fixture-3'], ['GET', '/line?before=m9', 'run-fixture-3']]);
  }
});

test("ba app chat posts one read, never reported uncertain, and prints the record as the app sent it", async t => {
  const record = { chatID: CHAT, name: 'Jordan Invented', cut: 'owner', autoMode: true, auto: { on: true, goal: 'find a time for coffee' }, work: [], instructions: [], brief: null, asks: [] };
  const app = await fakeApp(t, { capabilities: ['status', 'replies', 'auto', 'instruction', 'chat'], answer: path => path === '/chat' ? [200, record] : [404, {}] });
  const options = { ...app.options, run: 'run-fixture-3' };
  const output = await printed(() => runApp(['chat', CHAT], options));
  assert.deepEqual(JSON.parse(output.join('\n')), record);
  assert.deepEqual(app.requests, [{ method: 'GET', path: '/metadata', run: 'run-fixture-3' }, { method: 'POST', path: '/chat', run: 'run-fixture-3', body: { chatID: CHAT } }]);
  app.requests.length = 0;
  await printed(() => runApp(['chat'], options));
  assert.deepEqual(app.requests.at(-1), { method: 'POST', path: '/chat', run: 'run-fixture-3', body: {} }, 'no ID: the app picks the Chat');
  // An app older than the command says so after the handshake.
  const old = await fakeApp(t);
  await assert.rejects(runApp(['chat', CHAT], old.options), { message: 'APP_CLI_UNSUPPORTED' });
  // A read that breaks off is a plain failure: nothing changed, so it is never "uncertain".
  const broken = await fakeApp(t, { capabilities: ['chat'], answer: (path, body, res) => { res.destroy(); return null; } });
  await assert.rejects(runApp(['chat', CHAT], broken.options), error => !/UNCERTAIN/.test(error.message));
});

test('ba app remember takes a part and the fact, and refuses a bad part, no fact, a long one, or a flag', () => {
  for (const args of [['remember', CHAT, 'others', 'Your cousin'], ['remember', CHAT, 'who'], ['remember', CHAT], ['remember', CHAT, 'who', 'x'.repeat(241)]])
    assert.throws(() => appCommand(args), /Usage/, args.slice(0, 3).join(' '));
  assert.throws(() => appCommand(['remember', CHAT, 'who', 'Your', 'cousin', '--dry-run']), /^Error: --dry-run is not supported by ba app remember\./);
  assert.throws(() => appCommand(['remember', 'Sam', 'who', 'Your cousin']), /is not a Chat ID/);
});

test('ba app forget takes the fact, and refuses no fact, a long one, or a flag', () => {
  for (const args of [['forget', CHAT], ['forget', CHAT, 'x'.repeat(241)]]) assert.throws(() => appCommand(args), /Usage/, args.slice(0, 2).join(' '));
  assert.throws(() => appCommand(['forget', CHAT, 'Your', 'cousin', '--dry-run']), /^Error: --dry-run is not supported by ba app forget\./);
  assert.throws(() => appCommand(['forget', 'Sam', 'Your cousin']), /is not a Chat ID/);
});
