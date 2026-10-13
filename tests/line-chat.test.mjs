// The Line's own Chat, named by the Companion in <state dir>/line-chat.json as sha256 of its Chat ID.
// Made-up IDs, a temporary state folder, and a fake Beeper CLI that logs every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLineChat, lineChatKey } from '../scripts/lib/state.mjs';

const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs');
const LINE = '!invented-line-chat:beeper.local';
// Computed outside this code, with: printf '%s' '!invented-line-chat:beeper.local' | shasum -a 256
const LINE_KEY = '9fbcac9058936869e611446079c7b3371e9b5ed230298dfdc22bebf2ea9980cd';
const OTHER = '!invented-other-chat:beeper.local';

test('the key is sha256 of the Chat ID in hex, as the Companion writes it', () => {
  assert.equal(lineChatKey(LINE), LINE_KEY);
  assert.notEqual(lineChatKey(OTHER), LINE_KEY);
});

test('only a readable file with a 64-hex key names the Line\'s Chat; anything else refuses nothing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ba-line-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'line-chat.json');
  assert.equal(isLineChat(LINE, dir), false, 'no file');
  writeFileSync(file, JSON.stringify({ chatKey: LINE_KEY }), { mode: 0o600 });
  assert.equal(isLineChat(LINE, dir), true);
  assert.equal(isLineChat(OTHER, dir), false);
  for (const content of ['not json', '{}', JSON.stringify({ chatKey: LINE_KEY.toUpperCase() }), JSON.stringify({ chatKey: LINE_KEY.slice(1) }), JSON.stringify({ chatKey: LINE }), 'null']) {
    writeFileSync(file, content);
    assert.equal(isLineChat(LINE, dir), false, content);
  }
  writeFileSync(file, JSON.stringify({ chatKey: LINE_KEY }));
  chmodSync(file, 0o000);
  if (process.getuid() !== 0) assert.equal(isLineChat(LINE, dir), false, 'unreadable');
  rmSync(file, { force: true });
  mkdirSync(file);
  assert.equal(isLineChat(LINE, dir), false, 'a folder in its place');
});

// A Beeper CLI that shows any Chat and its one message, logs each call, and refuses everything else.
function fakeBeeper(dir) {
  const bin = join(dir, 'beeper');
  writeFileSync(bin, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, a.slice(0, 2).join(' ') + '\\n');
const chat = a[a.indexOf('--chat') + 1];
let data;
if (a[0] === 'chats' && a[1] === 'show') data = { id: chat, accountID: 'testnet', network: 'iMessage', type: 'single', title: 'Invented Person', participants: { items: [{ id: 'p-' + chat, phoneNumber: '+15550104040' }] } };
else if (a[0] === 'messages' && a[1] === 'list') data = [{ id: 'msg-1', chatID: chat, sortKey: '1', timestamp: '2026-10-10T10:00:00.000Z', text: 'made-up', isSender: false }];
else { console.error(JSON.stringify({ success: false, error: 'not in the fake' })); process.exit(1); }
console.log(JSON.stringify({ success: true, data }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

test('ba refuses every write into the Line\'s Chat before it touches Beeper, from the state folder\'s file', t => {
  const home = mkdtempSync(join(tmpdir(), 'ba-line-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, BEEPER_ASSISTANT_HOME: home, BEEPER_BIN: fakeBeeper(home), BEEPER_API_URL: 'http://127.0.0.1:9' };
  delete env.BEEPER_ASSISTANT_MODE; delete env.BEEPER_ASSISTANT_READONLY;
  const go = (...args) => spawnSync(process.execPath, [BA, ...args], { env, encoding: 'utf8' });
  const calls = () => { try { return readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n'); } catch { return []; } };
  const writes = (chat) => ({
    send: ['send', chat, '--text', 'invented text', '--after', 'msg-1', '--confirmed'],
    draft: ['draft', chat, '--text', 'invented text'],
    suggest: ['suggest', chat, '--text', 'invented text', '--agent', 'Test', '--after', 'msg-1'],
    react: ['react', chat, 'msg-1', '👍', '--confirmed'],
    edit: ['edit', chat, 'msg-1', '--text', 'invented text', '--confirmed'],
    delete: ['delete', chat, 'msg-1', '--confirmed'],
    group: ['group', '--from', chat, '--from', '!invented-third-chat:beeper.local', '--confirmed'],
  });

  writeFileSync(join(home, 'line-chat.json'), JSON.stringify({ chatKey: LINE_KEY }), { mode: 0o600 });
  for (const [name, args] of Object.entries(writes(LINE))) {
    rmSync(join(home, 'calls.log'), { force: true });
    const r = go(...args);
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /^usage: LINE_CHAT: This is the Line's own Chat/, name);
    assert.equal(r.stdout, '', name);
    assert.deepEqual(calls().filter((c) => c !== 'chats show'), [], `${name} reached Beeper beyond reading the Chat`);
  }
  // Another Chat gets past the check, to the fake's own refusal or further.
  rmSync(join(home, 'calls.log'), { force: true });
  const other = go(...writes(OTHER).draft);
  assert.doesNotMatch(other.stderr, /LINE_CHAT/);
  assert.ok(calls().includes('chats draft'), other.stderr);
  // Without the file, the Line's Chat is an ordinary Chat.
  rmSync(join(home, 'line-chat.json'));
  rmSync(join(home, 'calls.log'), { force: true });
  assert.doesNotMatch(go(...writes(LINE).draft).stderr, /LINE_CHAT/);
  assert.ok(calls().includes('chats draft'));
});
