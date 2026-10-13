// `ba send` and `ba react` inside a Companion run (docs/plans/one-agent.md, part 6 and slice 5):
// one request to a fake Companion, and the fixed lines the skill prints for each answer. No real
// app, Store, or Beeper is reached. Invented Chats and text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDiscoveryFile, deliverThroughApp, deliveryLines } from '../scripts/lib/app.mjs';

const CHAT = '!invented-chat:beeper.local';
const LABEL = 'Sam · WhatsApp', alias = (id) => `ref-${id}`;

async function fakeApp(t, { capabilities = ['status', 'send'], answer = () => [200, { ok: true, status: 'sent', messageID: 'sent-1' }], drop = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ba-app-send-'));
  const token = 'c'.repeat(64), requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push({ path: req.url, run: req.headers['x-companion-run'] ?? null, ...(raw ? { body: JSON.parse(raw) } : {}) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/metadata') { res.writeHead(200); res.end(JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, capabilities })); return; }
    if (drop) { req.socket.destroy(); return; }
    const [status, value] = answer(req.url, raw ? JSON.parse(raw) : undefined);
    res.writeHead(status); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(appDiscoveryFile(directory, directory), JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: directory, token, port: server.address().port }), { mode: 0o600 });
  return { requests, options: { directory, dataHome: directory, run: 'run-invented' } };
}

test('a send inside a run is one request to the app, naming the run', async t => {
  const app = await fakeApp(t);
  const outcome = await deliverThroughApp('send', { chatID: CHAT, text: 'See you at 6', after: 'm0' }, app.options);
  assert.deepEqual(outcome, { answer: { ok: true, status: 'sent', messageID: 'sent-1' } });
  assert.deepEqual(app.requests.filter(r => r.path !== '/metadata'), [{ path: '/send', run: 'run-invented', body: { chatID: CHAT, text: 'See you at 6', after: 'm0' } }]);
  assert.deepEqual(deliveryLines('send', outcome, { label: LABEL, alias }), { lines: ['Sent to Sam · WhatsApp. The message is in the chat as ref-sent-1. Delivery is not confirmed.'], exitCode: 0 });
});

test('no app, an older one, or a lost answer is never a send another way', async t => {
  const missing = await deliverThroughApp('send', { chatID: CHAT, text: 'Hi', after: 'none' }, { directory: mkdtempSync(join(tmpdir(), 'ba-no-app-')), dataHome: '/nowhere', run: 'run-invented' });
  assert.deepEqual(missing, { failure: 'unavailable' });
  const older = await fakeApp(t, { capabilities: ['status', 'auto'] });
  assert.deepEqual(await deliverThroughApp('send', { chatID: CHAT, text: 'Hi', after: 'none' }, older.options), { failure: 'unavailable' });
  assert.equal(older.requests.filter(r => r.path === '/send').length, 0);
  const dropped = await fakeApp(t, { drop: true });
  assert.deepEqual(await deliverThroughApp('send', { chatID: CHAT, text: 'Hi', after: 'none' }, dropped.options), { failure: 'uncertain' });
  for (const [failure, line] of [['unavailable', /^NOT SENT to Sam · WhatsApp\. .* never sent another way/], ['uncertain', /^NOT VERIFIED for Sam · WhatsApp\. .* Do not retry\./]]) {
    const { lines, exitCode } = deliveryLines('send', { failure }, { label: LABEL, alias });
    assert.match(lines[0], line); assert.equal(exitCode, 1);
  }
});

test('each answer the app gives prints its own fixed line', () => {
  const lines = (kind, answer, more = {}) => deliveryLines(kind, { answer }, { label: LABEL, alias, ...more });
  assert.deepEqual(lines('send', { ok: false, status: 'unverified', accepted: true }), { lines: ['NOT VERIFIED for Sam · WhatsApp. Beeper accepted the request. The message is not visible in the chat yet. Do not retry. Ask the Owner to look in Beeper first.'], exitCode: 1 });
  assert.match(lines('send', { ok: false, code: 'APP_CLI_STALE', newest: { id: 'm2', fromMe: false } }).lines[0], /^Not sent\. Sam · WhatsApp has changed since it was read: the newest message is now ref-m2, from them\./);
  assert.match(lines('send', { ok: false, code: 'APP_CLI_HELD' }).lines[0], /isn't confirmed yet, or a reply is still sending there/);
  assert.match(lines('send', { ok: false, code: 'APP_CLI_BUSY' }).lines[0], /Another run is writing in Sam · WhatsApp/);
  assert.match(lines('send', { ok: false, code: 'APP_CLI_RUN_ENDED' }).lines[0], /^Not sent\. APP_CLI_RUN_ENDED: /);
  assert.deepEqual(lines('send', { ok: false, code: 'APP_CLI_LOCKED' }), { lines: ["Not sent. The Mac is locked, so Beeper can't send iMessages from it, and nothing went out to Sam · WhatsApp. Tell the Owner: they can send it from their phone, or ask again once the Mac is unlocked."], exitCode: 1 });
  assert.match(lines('react', { ok: false, code: 'APP_CLI_LOCKED' }, { reaction: '👍', target: 'm0' }).lines[0], /^Not sent\. The Mac is locked/);
  assert.equal(lines('send', { ok: false, code: 'SOMETHING_NEW', message: 'text from the app' }).lines[0], 'Not sent. Beeper Companion refused it. Nothing went out.', 'never the app\'s own text');
  assert.deepEqual(lines('react', { ok: true, status: 'sent' }, { reaction: '👍', target: 'm0' }), { lines: ['Reacted 👍 to ref-m0 in Sam · WhatsApp.'], exitCode: 0 });
  assert.match(lines('react', { ok: true, status: 'already' }, { reaction: '👍', target: 'm0' }).lines[0], /already reacted 👍 to ref-m0/);
  assert.match(lines('react', { ok: false, code: 'APP_CLI_GONE' }, { reaction: '👍', target: 'm0' }).lines[0], /no longer in Sam · WhatsApp/);
});
