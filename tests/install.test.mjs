// Runs the real installer against scratch folders. Nothing outside the temp folder is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..');
// BEEPER_BIN points nowhere, so the check at the end of an install can never reach a real account.
const sh = (script, ...args) => spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), BEEPER_BIN: '/nonexistent/beeper', BEEPER_ASSISTANT_HOME: mkdtempSync(join(tmpdir(), 'ba-st-')) } });
const writable = (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };

// A copy of the skill outside any git repo, the way a downloaded folder would be.
function download() {
  const dir = mkdtempSync(join(tmpdir(), 'ba-dl-'));
  for (const f of ['SKILL.md', 'LICENSE', 'install.sh', 'ba', 'references', 'scripts']) cpSync(join(SKILL, f), join(dir, 'beeper-assistant', f), { recursive: true });
  return join(dir, 'beeper-assistant');
}

test('the installer finishes from a folder that is not a git checkout', () => {
  const src = download();
  const target = mkdtempSync(join(tmpdir(), 'ba-to-'));
  const r = sh(join(src, 'install.sh'), '--to', target);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Copied .*read-only, revision not from git/);
  const dest = join(target, 'beeper-assistant');
  for (const f of ['SKILL.md', 'INSTALLED', 'ba', 'scripts/ba.mjs', 'scripts/ba-unattended.mjs', 'scripts/lib/triage.mjs', 'references/traps.md', 'references/unattended.md']) assert.ok(existsSync(join(dest, f)), f);
  assert.equal(writable(join(dest, 'SKILL.md')), false);
  assert.match(readFileSync(join(dest, 'INSTALLED'), 'utf8'), /revision: not from git/);
});

test('installing twice updates the copy, and remove takes it away', () => {
  const src = download();
  const target = mkdtempSync(join(tmpdir(), 'ba-to-'));
  assert.equal(sh(join(src, 'install.sh'), '--to', target).status, 0);
  assert.equal(sh(join(src, 'install.sh'), '--to', target).status, 0);
  const gone = sh(join(src, 'install.sh'), '--remove', '--to', target);
  assert.equal(gone.status, 0);
  assert.equal(existsSync(join(target, 'beeper-assistant')), false);
});

test('the installer leaves a different skill of the same name alone', () => {
  const src = download();
  const target = mkdtempSync(join(tmpdir(), 'ba-to-'));
  mkdirSync(join(target, 'beeper-assistant'));
  writeFileSync(join(target, 'beeper-assistant', 'SKILL.md'), '---\nname: something-else\n---\n');
  const r = sh(join(src, 'install.sh'), '--to', target);
  assert.match(r.stderr, /is not this skill\. Left alone/);
  assert.match(readFileSync(join(target, 'beeper-assistant', 'SKILL.md'), 'utf8'), /something-else/);
});

test('the installed copy runs', () => {
  const src = download();
  const target = mkdtempSync(join(tmpdir(), 'ba-to-'));
  sh(join(src, 'install.sh'), '--to', target);
  const r = spawnSync(process.execPath, [join(target, 'beeper-assistant', 'scripts', 'ba.mjs'), 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^beeper-assistant/);
});

test('the installer checks the setup and says plainly when it is not finished', () => {
  const src = download();
  const target = mkdtempSync(join(tmpdir(), 'ba-to-'));
  const r = sh(join(src, 'install.sh'), '--to', target);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Checking the setup:/);
  assert.match(r.stdout, /FAIL  Beeper command line tool is not installed/);
  assert.match(r.stdout, /brew install beeper\/tap\/cli/);
  assert.match(r.stdout, /Setup is not finished/);
  assert.match(r.stdout, /Check the setup any time:  ".*beeper-assistant\/ba" check/);
  const quiet = sh(join(src, 'install.sh'), '--to', target, '--no-check');
  assert.equal(quiet.stdout.includes('Checking the setup'), false);
});

test('with no agent on the machine, the installer says where it looked', () => {
  const src = download();
  const home = mkdtempSync(join(tmpdir(), 'ba-home-'));
  const r = spawnSync('/bin/bash', [join(src, 'install.sh')], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No agent found on this Mac/);
});

test('an agent whose skills folder does not exist yet still gets the skill', () => {
  const src = download();
  const home = mkdtempSync(join(tmpdir(), 'ba-home-'));
  mkdirSync(join(home, '.claude'));
  const r = spawnSync('/bin/bash', [join(src, 'install.sh'), '--no-check'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, '.claude', 'skills', 'beeper-assistant', 'SKILL.md')));
});
