// The blank marker: a lone underscore. One rule, in lib/gaps.mjs, for the skill and the companion.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gapsIn, hasGap } from '../scripts/lib/gaps.mjs';

const count = (s) => gapsIn(s).length;

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

test('hasGap gives the same answer however often it is asked', () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(hasGap('I land _ and could do dinner'), true);
    assert.equal(hasGap('see you [[which day?]]'), true);
    assert.equal(hasGap('use snake_case and _italics_ freely'), false);
    assert.equal(hasGap(''), false);
    assert.equal(hasGap(undefined), false);
  }
});

test('ba.mjs uses the shared rule instead of its own copy', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/ba.mjs', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/lib\/gaps\.mjs'/);
  assert.doesNotMatch(src, /^const GAP = /m);
});
