// `ba triage` from Beeper Companion's Catch up (ADR 0110). A fake Companion answers; Beeper is a
// path that doesn't exist, so a test that reaches it fails loudly. Invented Chats and text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDiscoveryFile } from '../scripts/lib/app.mjs';
import { CATCH_UP_NOT_READY, CATCH_UP_UNAVAILABLE, catchUpForTriage, catchUpJSON, renderCatchUp } from '../scripts/lib/catch-up.mjs';
import { chatAlias, loadState, messageAlias } from '../scripts/lib/state.mjs';

const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');
const NOW = Date.parse('2026-10-01T16:00:00Z');
const ANN = '!ann-invented:beeper.local', BO = '!bo-invented:beeper.local', CY = 'imsg##thread:cy-invented', DEE = '!dee-invented:beeper.local', OWN = '!own-invented:beeper.local';
const okState = { status: 'ok', checkedAt: '2026-10-01T15:58:00Z', notice: null };
const RECORD = {
  checkedAt: '2026-10-01T15:58:00Z', problem: null,
  sections: { triage: okState, dropped: okState, revive: { status: 'loading', checkedAt: null, notice: 'Checking…' }, faded: null, reminders: okState },
  items: [
    { section: 'urgent', chatID: ANN, messageID: '$ann-1', name: 'Ann Invented', network: 'iMessage', group: false, want: 'Deadline today', reason: 'Asks for the form by 5pm', waitingSince: '2026-10-01T14:00:00Z' },
    { section: 'dropped', chatID: BO, name: 'Bo Invented', network: 'WhatsApp', kind: 'promise', why: 'You said you would send the slides', judged: false,
      receipt: { chatID: BO, messageID: '$bo-1', who: 'You', fromOwner: true, text: "I'll send the slides «tomorrow»", at: '2026-09-28T16:00:00Z' }, suggestion: 'Here are the slides' },
    { section: 'revive', chatID: DEE, name: 'Dee Invented', network: 'Signal', why: 'You two used to run together', lastTalked: '2025-03-10T12:00:00Z',
      now: { chatID: OWN, messageID: '$own-1', who: 'You', fromOwner: true, text: 'Thinking about trail running', at: '2026-09-30T16:00:00Z' },
      then: { chatID: DEE, messageID: '$dee-1', who: 'Dee Invented', fromOwner: false, text: 'ridge loop sometime', at: '2025-03-01T12:00:00Z' }, suggestion: null },
    { section: 'waiting', chatID: CY, messageID: '$cy-1', name: 'Cy Group', network: 'iMessage', group: true, want: 'A question', reason: 'A question · you usually answer', waitingSince: null },
  ],
};

test('ba triage takes the Catch up only when it is ready, and says one fixed line when it falls back', async () => {
  const read = (got) => async () => got;
  assert.deepEqual(await catchUpForTriage({}, read({ record: RECORD })), { record: RECORD });
  const loading = { ...RECORD, sections: { ...RECORD.sections, triage: { status: 'loading', checkedAt: null, notice: 'Checking…' } } };
  assert.deepEqual(await catchUpForTriage({}, read({ record: loading })), { note: CATCH_UP_NOT_READY });
  assert.deepEqual(await catchUpForTriage({}, read({ failure: 'unavailable' })), { note: CATCH_UP_UNAVAILABLE });
  assert.deepEqual(await catchUpForTriage({}, read({ failure: 'absent' })), { note: null }, 'no Companion on this Mac: nothing to say');
  for (const flags of [{ days: '7' }, { max: '20' }, { all: true }, { 'max-groups': '3' }]) {
    assert.deepEqual(await catchUpForTriage(flags, () => assert.fail('asked the app')), { note: null }, 'ranking flags ask for ba\'s own list');
  }
});

test('the Catch up rows print with references the other commands take, and message text inside «…»', () => {
  const text = renderCatchUp(RECORD, NOW);
  const lines = text.split('\n');
  assert.match(lines[0], /^CATCH UP · from Beeper Companion · checked 2m ago · 4 items/);
  assert.match(text, new RegExp(`^${chatAlias(ANN)}  Ann Invented · iMessage · waiting 2h  Deadline today$`, 'm'));
  assert.match(text, new RegExp(`^${chatAlias(BO)}  Bo Invented · WhatsApp \\[PROMISE UNCHECKED REPLY WRITTEN\\]$`, 'm'));
  assert.ok(lines.includes(`           from ${messageAlias('$bo-1')} You, 3d ago: «I'll send the slides ‹tomorrow›»`), 'quotes inside the text cannot close the quote');
  assert.match(text, new RegExp(`^${chatAlias(CY)}  Cy Group \\(group\\) · iMessage  A question$`, 'm'));
  assert.ok(lines.indexOf('URGENT: waiting costs something today (1)') < lines.findIndex(l => l.startsWith('YOU DROPPED')), 'Catch up order');
  assert.ok(lines.includes('Not current: Revive: Checking…'));
  assert.ok(lines.includes(`           now ${messageAlias('$own-1')} in ${chatAlias(OWN)} You, 1d ago: «Thinking about trail running»`), 'a hook in another Chat names that Chat');
  assert.ok(lines.includes(`           then ${messageAlias('$dee-1')} Dee Invented, 82w ago: «ridge loop sometime»`), "one in the row's own Chat does not");
  const json = catchUpJSON(RECORD);
  assert.equal(json.source, 'beeper-companion');
  assert.deepEqual(json.items.map(i => [i.ref, i.chatID]), [[chatAlias(ANN), ANN], [chatAlias(BO), BO], [chatAlias(DEE), DEE], [chatAlias(CY), CY]]);
});

// A record from a Companion with the Triage Views: triage rows carry band and unsure, and print
// under MUST, SHOULD, ALSO OWED, and UNSURE instead of URGENT and WAITING ON YOU (ADR 0263).
const BANDED = {
  ...RECORD,
  items: [
    { ...RECORD.items[0], band: 'must', unsure: false },
    RECORD.items[1], RECORD.items[2],
    { ...RECORD.items[3], band: 'rest', unsure: false },
    { ...RECORD.items[3], chatID: 'imsg##thread:hal-invented', messageID: '$hal-1', name: 'Hal Invented', band: 'should', unsure: false },
    { ...RECORD.items[3], chatID: '!str-invented:beeper.local', messageID: '$str-1', name: 'Stranger Invented', band: null, unsure: true },
  ],
};

test('a record whose rows carry Bands prints under Today\'s four headings, Unsure on its own', () => {
  const text = renderCatchUp(BANDED, NOW);
  const lines = text.split('\n');
  const at = (s) => lines.findIndex((l) => l.startsWith(s));
  assert.ok(at('MUST: get to today (1)') > -1 && at('SHOULD: slipping or due soon (1)') > at('MUST')
    && at('ALSO OWED (1)') > at('SHOULD') && at('UNSURE: only you can tell (1)') > at('ALSO OWED'), text);
  assert.ok(at('MUST') < at('YOU DROPPED'), 'the owed rows still lead');
  assert.equal(at('URGENT'), -1, 'the old headings give way');
  const unsureLine = lines.findIndex((l) => l.includes('Stranger Invented'));
  assert.ok(unsureLine > at('UNSURE'), 'a stranger never sits under a heading that says owed');
  const json = catchUpJSON(BANDED);
  assert.equal(json.items[0].band, 'must', 'the new fields pass --json through unchanged');
});

test('an answer whose rows are not the shape ba expects falls back instead of failing halfway', async () => {
  const read = (record) => async () => ({ record });
  for (const items of [[null], [{ section: 'urgent' }], [{ section: 'dropped', chatID: BO, name: 'Bo', network: 'x', why: 'y', receipt: RECORD.items[1].receipt }],
    [{ ...RECORD.items[2], now: null }], [{ section: 'mystery', chatID: BO }]]) {
    assert.deepEqual(await catchUpForTriage({}, read({ checkedAt: null, problem: null, sections: RECORD.sections, items })), { note: CATCH_UP_UNAVAILABLE }, JSON.stringify(items));
  }
  assert.deepEqual(await catchUpForTriage({}, read({ items: [] })), { note: CATCH_UP_UNAVAILABLE }, 'no sections');
  assert.deepEqual(await catchUpForTriage({}, read(RECORD)), { record: RECORD });
});

// A fake Companion and a throwaway state folder. Beeper is a path that doesn't exist.
async function rig(t, first) {
  // answer.value, once set, replaces what the fake Companion says from then on.
  const answer = { value: null }, reply = (url) => answer.value ?? first(url);
  const home = mkdtempSync(join(tmpdir(), 'ba-catchup-')), data = mkdtempSync(join(tmpdir(), 'ba-catchup-data-'));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/metadata') { res.end(JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: data, capabilities: ['status', 'catchup'] })); return; }
    const [status, value] = reply(req.url);
    res.writeHead(status); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });
  const env = { ...process.env, BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: home, BEEPER_COMPANION_USER_DATA: data };
  delete env.COMPANION_RUN; delete env.BEEPER_ASSISTANT_READONLY;
  const discover = (port = server.address().port) => writeFileSync(appDiscoveryFile(home, data), JSON.stringify({ protocol: 1, launch: 'fixture', dataHome: data, token: 'd'.repeat(64), port }), { mode: 0o600 });
  const ba = (...args) => new Promise(resolve => execFile(process.execPath, [BA, ...args], { env, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })));
  return { home, requests, discover, ba, answer };
}

test('with the Companion running, ba triage prints its Catch up and never reaches Beeper', async t => {
  const app = await rig(t, () => [200, RECORD]);
  app.discover();
  const r = await app.ba('triage');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^CATCH UP · from Beeper Companion/);
  assert.equal(r.stderr, '');
  assert.deepEqual(app.requests, ['/metadata', '/catchup']);
  process.env.BEEPER_ASSISTANT_HOME = app.home;
  try {
    const aliases = loadState().aliases;
    assert.equal(aliases[chatAlias(BO)]?.id, BO, 'ba chat takes the printed reference');
    assert.deepEqual(aliases[messageAlias('$bo-1')], { id: '$bo-1', chat: BO }, 'and ba chat --around the printed message');
    assert.equal(aliases[chatAlias(OWN)]?.id, OWN, "a receipt's own Chat too");
    assert.deepEqual(aliases[messageAlias('$own-1')], { id: '$own-1', chat: OWN });
  } finally { delete process.env.BEEPER_ASSISTANT_HOME; }
  const json = JSON.parse((await app.ba('triage', '--json')).stdout);
  assert.equal(json.items[0].ref, chatAlias(ANN));
});

test("when the Companion can't answer, ba triage is today's triage plus one line, and ranking flags never ask it", async t => {
  const app = await rig(t, () => [200, { ...RECORD, sections: { ...RECORD.sections, triage: { status: 'loading', checkedAt: null, notice: 'Checking…' } } }]);
  // Baseline: no Companion has run here. Beeper's CLI is missing, so today's triage stops with its fix.
  const before = await app.ba('triage');
  assert.equal(before.status, 1);
  assert.match(before.stderr, /brew install beeper\/tap\/cli/);
  assert.deepEqual(app.requests, []);
  // A Companion whose list hasn't checked yet.
  app.discover();
  const notReady = await app.ba('triage');
  assert.deepEqual([notReady.status, notReady.stdout], [before.status, before.stdout]);
  assert.equal(notReady.stderr, `${CATCH_UP_NOT_READY}\n${before.stderr}`);
  // A Companion that quit and left its discovery file behind.
  const closed = createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port; await new Promise(resolve => closed.close(resolve));
  app.discover(port);
  const gone = await app.ba('triage');
  assert.deepEqual([gone.status, gone.stdout], [before.status, before.stdout]);
  assert.equal(gone.stderr, `${CATCH_UP_UNAVAILABLE}\n${before.stderr}`);
  // A Companion whose answer ba can't read.
  app.answer.value = [200, { ...RECORD, items: [null] }];
  const garbled = await app.ba('triage');
  assert.deepEqual([garbled.status, garbled.stdout], [before.status, before.stdout]);
  assert.equal(garbled.stderr, `${CATCH_UP_UNAVAILABLE}\n${before.stderr}`);
  // Ranking flags give ba's own list without a request.
  app.discover();
  const asked = app.requests.length;
  const own = await app.ba('triage', '--days', '7');
  assert.equal(own.stderr, before.stderr);
  assert.equal(app.requests.length, asked);
});
