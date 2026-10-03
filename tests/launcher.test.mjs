// The ba launcher. It never runs the real app here: BEEPER_COMPANION_APP points at a stub
// whose "binary" is a shell script that records how it was called.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BA = join(dirname(fileURLToPath(import.meta.url)), '..', 'ba');
const NODE_DIR = dirname(process.execPath);

function stubApp(exitCode) {
  const root = mkdtempSync(join(tmpdir(), 'ba-launcher-'));
  const app = join(root, 'Beeper Companion.app');
  mkdirSync(join(app, 'Contents', 'Resources', 'app'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Resources', 'app', 'skill-runtime'), 'beeper-assistant\n');
  const calls = join(root, 'calls');
  const bin = join(app, 'Contents', 'MacOS', 'Beeper Companion');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return { app, root, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []) };
}
const run = (env, args = ['check']) => spawnSync('/bin/sh', [BA, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } });

test('with HOME set to another folder, the app is never started, and the message says why', () => {
  const stub = stubApp(0);
  const r = run({ HOME: stub.root, BEEPER_COMPANION_APP: stub.app });
  assert.deepEqual(stub.calls(), [], 'no app, so no keychain and no dialog');
  assert.equal(r.status, 78);
  assert.match(r.stderr, /HOME set to .* which is not your home folder/);
});

test('with the real HOME, the app runs the command and its exit code comes back', () => {
  const stub = stubApp(5);
  const r = run({ HOME: userInfo().homedir, BEEPER_COMPANION_APP: stub.app }, ['triage', '--days', '3']);
  assert.deepEqual(stub.calls(), ['--beeper-assistant triage --days 3']);
  assert.equal(r.status, 5);
});

test('an app with the switch off answers 64, and the skill runs with Node instead', () => {
  const stub = stubApp(64);
  const r = run({ HOME: userInfo().homedir, BEEPER_COMPANION_APP: stub.app, PATH: `${NODE_DIR}:/usr/bin:/bin` }, ['help']);
  assert.equal(stub.calls().length, 1);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^beeper-assistant/);
});

test('an app without the skill-runtime file is never asked', () => {
  const stub = stubApp(0);
  const r = run({ HOME: userInfo().homedir, BEEPER_COMPANION_APP: join(stub.root, 'missing.app') });
  assert.deepEqual(stub.calls(), []);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /needs the Beeper Companion app, or Node 18/);
});

test('an empty HOME is not a home folder, and an unset one is the real home', () => {
  const empty = stubApp(0);
  assert.equal(run({ HOME: '', BEEPER_COMPANION_APP: empty.app }).status, 78);
  assert.deepEqual(empty.calls(), []);
  const unset = stubApp(0);
  const r = spawnSync('/bin/sh', [BA, 'check'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', BEEPER_COMPANION_APP: unset.app } });
  assert.equal(r.status, 0);
  assert.equal(unset.calls().length, 1);
});
