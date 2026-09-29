import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, looksLikeEmail, looksLikePhone, nameFor, normalizePhone, searchPeople } from '../scripts/lib/contacts.mjs';
import { CONTACT_ROWS } from './fixtures.mjs';

const index = buildIndex(CONTACT_ROWS);

test('phone numbers normalise across formats', () => {
  for (const raw of ['+1 (555) 010-0001', '1-555-010-0001', '555.010.0001', '5550100001', '0015550100001']) {
    assert.equal(normalizePhone(raw), '5550100001', raw);
  }
  assert.equal(normalizePhone('+44 5550 100004'), '445550100004');
});

test('a number finds its contact whatever the format', () => {
  assert.equal(nameFor(index, '+15550100001'), 'Ada Lovelace');
  assert.equal(nameFor(index, '(555) 010-0002'), 'Grace Hopper');
});

test('an email finds its contact, ignoring case', () => {
  assert.equal(nameFor(index, 'ADA@example.com'), 'Ada Lovelace');
});

test('a contact with only an organisation uses it as the name', () => {
  assert.equal(nameFor(index, '+15550100003'), 'Pizza Place');
});

test('ambiguous and unknown handles return nothing', () => {
  assert.equal(nameFor(index, '+15550100009'), null);
  assert.equal(nameFor(index, '+15559999999'), null);
  assert.equal(nameFor(index, ''), null);
  assert.equal(nameFor(null, '+15550100001'), null);
});

test('very short numbers never match by accident', () => {
  assert.equal(nameFor(index, '0001'), null);
});

test('people search matches word starts and needs every word', () => {
  assert.deepEqual(searchPeople(index, 'ada').map((p) => p.name), ['Ada Byron', 'Ada Lovelace']);
  assert.deepEqual(searchPeople(index, 'ada love').map((p) => p.name), ['Ada Lovelace']);
  assert.deepEqual(searchPeople(index, 'lace').map((p) => p.name), []);
  assert.deepEqual(searchPeople(index, '').map((p) => p.name), []);
});

test('handle detection', () => {
  assert.equal(looksLikePhone('+1 555-010-0001'), true);
  assert.equal(looksLikePhone('Ada Lovelace'), false);
  assert.equal(looksLikePhone('2026'), false);
  assert.equal(looksLikeEmail('ada@example.com'), true);
  assert.equal(looksLikeEmail('ada at example'), false);
});
