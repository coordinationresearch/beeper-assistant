// The Terminal's sends, Reactions, and Drafts (ADR 0110): where they go, the running Companion or
// the skill's own path, and what happens when the Companion isn't running. A fake Companion and a
// stub app only; nothing starts the real app, and no Beeper is reached. Invented Chats and text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { APP_CLI_OFF, appDiscoveryFile, deliverThroughApp, deliverWith, draftLines, findCompanionApp, launchEnvironment, startCompanion, terminalRoute } from '../scripts/lib/app.mjs';

const CHAT = '!invented-chat:beeper.local', LABEL = 'Sam · WhatsApp';

function folder(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ba-terminal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
// A Companion answering on loopback, which writes its discovery file as the app does.
async function companion(t, directory, { capabilities = ['status', 'send', 'terminal'], off = false, ended = false } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push({ path: req.url, run: req.headers['x-companion-run'] ?? null, ...(raw ? { body: JSON.parse(raw) } : {}) });
    res.setHeader('Content-Type', 'application/json');
    if (off) { res.writeHead(403); res.end(JSON.stringify({ code: 'APP_CLI_OFF', message: APP_CLI_OFF })); return; }
    if (ended) { res.writeHead(403); res.end(JSON.stringify({ code: 'APP_CLI_RUN_ENDED' })); return; }
    if (req.url === '/metadata') { res.writeHead(200); res.end(JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, capabilities })); return; }
    res.writeHead(200); res.end(JSON.stringify({ ok: true, status: 'saved' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  writeFileSync(appDiscoveryFile(directory, directory), JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, token: 'c'.repeat(64), port: server.address().port }), { mode: 0o600 });
  return { requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
// A clock the route's wait reads, moved by its sleep, so no test waits ten seconds.
const clock = () => { let at = 0; return { now: () => at, sleep: async ms => { at += ms; } }; };
const never = () => { throw Error('the Companion must not be started'); };

// A run that ended before its command reached the app hears that, not that the app may need updating.
test('a run\'s Draft after the run ended says so, from the app\'s refusal at the handshake', async t => {
  const directory = folder(t);
  await companion(t, directory, { ended: true });
  const outcome = await deliverThroughApp('draft', { chatID: CHAT, text: 'See you at 6' }, { directory, dataHome: directory, run: 'run-invented' });
  assert.equal(outcome.failure, 'refused');
  assert.match(draftLines(outcome, { label: LABEL }).lines[0], /^Not drafted\. APP_CLI_RUN_ENDED: The Companion run this command belongs to has ended/);
  const gone = await deliverThroughApp('draft', { chatID: CHAT, text: 'See you at 6' }, { directory: folder(t), dataHome: directory, run: 'run-invented' });
  assert.deepEqual(gone, { failure: 'unavailable' }, 'no app at all is still unavailable');
});

test('with no Companion here, or one gone from the Mac, the Terminal writes as the skill always has', async t => {
  const directory = folder(t);
  assert.deepEqual(await terminalRoute({ directory, dataHome: directory, findApp: () => '/Applications/Invented.app', start: never }), { standalone: true }, 'no discovery file: it never ran here');
  const app = await companion(t, directory);
  await app.close();
  assert.deepEqual(await terminalRoute({ directory, dataHome: directory, findApp: () => null, start: never }), { standalone: true }, 'a discovery file left by an app that is gone');
});

test('a running Companion takes the Terminal\'s Draft as one request with no run named', async t => {
  const directory = folder(t), app = await companion(t, directory);
  const route = await terminalRoute({ directory, dataHome: directory, findApp: () => '/Applications/Invented.app', start: never });
  assert.ok(route.client);
  const outcome = await deliverWith(route.client, 'draft', { chatID: CHAT, text: 'See you at 6', replacing: 'See you at _' });
  assert.deepEqual(outcome, { answer: { ok: true, status: 'saved' } });
  assert.deepEqual(app.requests.filter(r => r.path !== '/metadata'), [{ path: '/draft', run: null, body: { chatID: CHAT, text: 'See you at 6', replacing: 'See you at _' } }]);
});

test('a Companion the Owner closed to the Terminal leaves the skill its own path; one too old to take it refuses', async t => {
  const off = folder(t);
  await companion(t, off, { off: true });
  assert.deepEqual(await terminalRoute({ directory: off, dataHome: off, findApp: () => '/Applications/Invented.app', start: never }), { standalone: true });
  // An older Companion may hold the Chat for a send that may have gone out, so nothing goes around it.
  const older = folder(t);
  const app = await companion(t, older, { capabilities: ['status', 'send'] });
  assert.deepEqual(await terminalRoute({ directory: older, dataHome: older, findApp: () => '/Applications/Invented.app', start: never }), { failure: 'unavailable' });
  assert.deepEqual(app.requests.map(r => r.path), ['/metadata'], 'nothing but the handshake');
});

test('a Companion that isn\'t running is started once in the background and used once it answers', async t => {
  const directory = folder(t);
  await (await companion(t, directory)).close();
  const started = [], c = clock();
  let app;
  const route = await terminalRoute({ directory, dataHome: directory, findApp: () => '/Applications/Invented.app', ...c,
    start: async (path) => { started.push(path); app = await companion(t, directory); } });
  assert.ok(route.client);
  assert.deepEqual(started, ['/Applications/Invented.app']);
  await deliverWith(route.client, 'send', { chatID: CHAT, text: 'Hi', after: 'm0' });
  assert.deepEqual(app.requests.filter(r => r.path !== '/metadata').map(r => r.path), ['/send']);
});

test('a Companion that doesn\'t start, or doesn\'t answer within the wait, refuses: never a write another way', async t => {
  const directory = folder(t);
  await (await companion(t, directory)).close();
  const started = [], c = clock();
  assert.deepEqual(await terminalRoute({ directory, dataHome: directory, findApp: () => '/Applications/Invented.app', ...c, start: async (path) => { started.push(path); } }), { failure: 'not-started' });
  assert.equal(started.length, 1, 'started once, never again');
  assert.ok(c.now() >= 10_000, 'it waited the whole wait');
  assert.deepEqual(await terminalRoute({ directory, dataHome: directory, findApp: () => '/Applications/Invented.app', ...clock(), start: async () => { throw Error('open failed'); } }), { failure: 'not-started' });
});

test('the app to start is the one this runs inside, else the one named, and a named one that is missing is none', t => {
  const root = folder(t);
  const stub = (name) => { const app = join(root, name); mkdirSync(join(app, 'Contents', 'Resources', 'app'), { recursive: true }); writeFileSync(join(app, 'Contents', 'Resources', 'app', 'skill-runtime'), ''); return app; };
  const inside = stub('Inside.app'), named = stub('Named.app');
  assert.equal(findCompanionApp({ env: {}, execPath: join(inside, 'Contents', 'MacOS', 'Beeper Companion') }), inside);
  assert.equal(findCompanionApp({ env: { BEEPER_COMPANION_APP: named }, execPath: '/usr/local/bin/node' }), named);
  assert.equal(findCompanionApp({ env: { BEEPER_COMPANION_APP: join(root, 'Missing.app') }, execPath: '/usr/local/bin/node' }), null);
  assert.equal(findCompanionApp({ env: { BEEPER_COMPANION_APP: '' }, execPath: '/usr/local/bin/node' }), null);
});

test('the Companion starts with the environment it gets at login, never this command\'s', async () => {
  const user = { homedir: '/var/empty/invented', username: 'invented', shell: '/bin/zsh' };
  const env = launchEnvironment({ user, temp: () => '/var/folders/in/vented/T/' });
  assert.deepEqual(env, { HOME: '/var/empty/invented', USER: 'invented', LOGNAME: 'invented', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/var/folders/in/vented/T/' });
  assert.equal(launchEnvironment({ user, temp: () => '' }).TMPDIR, undefined);
  const real = launchEnvironment();
  assert.equal(real.HOME, userInfo().homedir, 'the real home, whatever HOME says');
  assert.equal(real.BEEPER_ASSISTANT_MODE, undefined);
  const calls = [];
  const exec = (file, args, options, done) => { calls.push([file, args, options]); done(null); };
  await startCompanion('/Applications/Invented.app', { execPath: '/usr/local/bin/node', env, exec });
  await startCompanion('/Applications/Invented.app', { execPath: '/Applications/Invented.app/Contents/MacOS/Beeper Companion', env, exec });
  assert.deepEqual(calls.map(([file, args, options]) => [file, args, options.env]), [['/usr/bin/open', ['-g', '/Applications/Invented.app'], env], ['/usr/bin/open', ['-n', '-g', '/Applications/Invented.app'], env]]);
});

test('each answer to a Draft prints its own fixed line, and only a saved one counts', () => {
  const line = (outcome) => draftLines(outcome, { label: LABEL });
  assert.deepEqual(line({ answer: { ok: true, status: 'saved' } }), { lines: [], exitCode: 0, ok: true });
  assert.match(line({ answer: { ok: false, code: 'APP_CLI_HELD' } }).lines[0], /^Not drafted\. A send in Sam · WhatsApp isn't confirmed yet/);
  assert.match(line({ answer: { ok: false, code: 'APP_CLI_CHANGED' } }).lines[0], /^Not drafted\. The box in Sam · WhatsApp changed since it was read\./);
  assert.match(line({ answer: { ok: false, status: 'unverified', accepted: true } }).lines[0], /^NOT VERIFIED for Sam · WhatsApp\. Beeper accepted the Draft, but the box doesn't show it\. Do not retry\./);
  assert.match(line({ failure: 'uncertain' }).lines[0], /^NOT VERIFIED for Sam · WhatsApp\. .* Do not retry\./);
  assert.match(line({ failure: 'not-started' }).lines[0], /^Not drafted in Sam · WhatsApp\. Beeper Companion isn't running and didn't start/);
  assert.match(line({ answer: { ok: false, code: 'APP_CLI_SOMETHING_NEW' } }).lines[0], /^Not drafted\. Beeper Companion refused it\./);
  for (const outcome of [{ failure: 'unavailable' }, { failure: 'refused', message: 'APP_CLI_REFUSED' }, { answer: { ok: false, code: 'APP_CLI_BLANK' } }]) assert.equal(line(outcome).ok, false);
});
