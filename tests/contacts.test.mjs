import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildIndex, contactDatabases, exactOwners, looksLikeEmail, looksLikePhone, nameFor, normalizePhone, ownersOf, searchPeople } from '../scripts/lib/contacts.mjs';
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

test('case-only duplicate names resolve for display while card ownership stays distinct', () => {
  const idx = buildIndex([
    { first: 'JD', last: 'Example', value: '+15550100008', kind: 'phone' },
    { first: 'Jd', last: 'Example', value: '+15550100008', kind: 'phone' },
    { first: 'JD', last: 'Example', value: 'jd@example.com', kind: 'email' },
    { first: 'Jd', last: 'Example', value: 'jd@example.com', kind: 'email' },
    ...CONTACT_ROWS,
  ]);
  assert.equal(nameFor(idx, '+15550100008'), 'JD Example');
  assert.equal(nameFor(idx, '+995550100008'), 'JD Example', 'last-ten-digit display lookup also ignores case');
  assert.equal(nameFor(idx, 'JD@example.com'), 'JD Example');
  assert.equal(nameFor(idx, '+15550100009'), null, 'different names stay ambiguous');
  assert.deepEqual(ownersOf(idx, '+15550100008'), ['JD Example', 'Jd Example']);
  assert.deepEqual(exactOwners(idx, 'jd@example.com'), [
    { name: 'JD Example', organizations: [] }, { name: 'Jd Example', organizations: [] },
  ]);
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

test('exact owners need the whole number or email, and carry the organization', () => {
  const idx = buildIndex([
    ...CONTACT_ROWS,
    { pk: 7, first: 'Mary', last: 'Somerville', nick: null, org: 'Example Observatory', value: '+15550100007', kind: 'phone' },
    { pk: 7, first: 'Mary', last: 'Somerville', nick: null, org: 'Example Observatory', value: 'mary@example.org', kind: 'email' },
    // Same last ten digits under another country code.
    { pk: 8, first: 'Tail', last: 'Only', nick: null, org: null, value: '+445550100008', kind: 'phone' },
  ]);
  assert.deepEqual(exactOwners(idx, '+1 (555) 010-0007'), [{ name: 'Mary Somerville', organizations: ['Example Observatory'] }]);
  assert.deepEqual(exactOwners(idx, 'MARY@example.org'), [{ name: 'Mary Somerville', organizations: ['Example Observatory'] }]);
  assert.deepEqual(exactOwners(idx, '+15550100009'), [{ name: 'Shared One', organizations: [] }, { name: 'Shared Two', organizations: [] }], 'two cards are both returned');
  assert.deepEqual(exactOwners(idx, '+15550100003'), [{ name: 'Pizza Place', organizations: [] }], 'an organization used as the name is not repeated');
  // ownersOf falls back to the last ten digits. exactOwners does not.
  assert.deepEqual(ownersOf(idx, '+995550100008'), ['Tail Only']);
  assert.deepEqual(exactOwners(idx, '+995550100008'), []);
  assert.deepEqual(exactOwners(idx, '0001'), []);
  assert.deepEqual(exactOwners(null, '+15550100007'), []);
});

test("BEEPER_ASSISTANT_ADDRESSBOOK points the lookup at another AddressBook folder, so a test never opens the Mac's own", t => {
  const root = mkdtempSync(join(tmpdir(), 'ba-addressbook-'));
  const prior = process.env.BEEPER_ASSISTANT_ADDRESSBOOK;
  t.after(() => { if (prior === undefined) delete process.env.BEEPER_ASSISTANT_ADDRESSBOOK; else process.env.BEEPER_ASSISTANT_ADDRESSBOOK = prior; rmSync(root, { recursive: true, force: true }); });
  process.env.BEEPER_ASSISTANT_ADDRESSBOOK = root;
  assert.deepEqual(contactDatabases(), [], 'an empty folder has none');
  mkdirSync(join(root, 'Sources', 'invented'), { recursive: true });
  for (const file of [join(root, 'AddressBook-v22.abcddb'), join(root, 'Sources', 'invented', 'AddressBook-v22.abcddb')]) writeFileSync(file, '');
  assert.deepEqual(contactDatabases(), [join(root, 'AddressBook-v22.abcddb'), join(root, 'Sources', 'invented', 'AddressBook-v22.abcddb')]);
});
