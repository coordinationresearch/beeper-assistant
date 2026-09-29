// The blank marker: a lone underscore. Kept in step with the pattern in scripts/ba.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ba.mjs'), 'utf8');
const m = src.match(/^const GAP = (\/.*\/[a-z]*);$/m);
assert.ok(m, 'GAP pattern not found in ba.mjs');
const GAP = new Function(`return ${m[1]}`)();
const count = (s) => (s.match(GAP) || []).length;

test('a lone underscore is a blank', () => {
  assert.equal(count('I land _ and could do dinner after'), 1);
  assert.equal(count('_ works for me'), 1);
  assert.equal(count('see you at _'), 1);
  assert.equal(count('see you at _.'), 1);
  assert.equal(count('how about _?'), 1);
  assert.equal(count('_ at _, near _'), 3);
  assert.equal(count('I land ___ and leave'), 1);
});

test('underscores inside words are not blanks', () => {
  assert.equal(count('the file is my_notes_final.txt'), 0);
  assert.equal(count('that was _so_ good'), 0);
  assert.equal(count('use snake_case here'), 0);
  assert.equal(count('follow @some_user on there'), 0);
  assert.equal(count('plain message with no blank'), 0);
  assert.equal(count(''), 0);
});

test('the older bracket marker is still caught', () => {
  assert.equal(count('see you [[which day?]]'), 1);
});
