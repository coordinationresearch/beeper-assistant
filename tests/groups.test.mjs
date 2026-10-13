// The group rules `ba group` and Beeper Companion's Intros share (lib/groups.mjs, ADR 0096).
// Made-up people and 555 numbers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_MESSAGE_IN_CREATE, handleKey, holdsAll, holdsExactly, memberKey, olderIMessageGroup, pairOf, sameMember } from '../scripts/lib/groups.mjs';

const self = { id: 'me', isSelf: true };
const ana = { id: 'wa-ana', phoneNumber: '+1 555 555 0100', email: null };
const ben = { id: 'wa-ben', phoneNumber: null, email: 'Ben@Example.com' };
const cal = { id: 'tg-cal', phoneNumber: null, email: null };
const group = (...members) => ({ id: '!g:beeper.local', type: 'group', participants: { items: [self, ...members] } });

test('a member is matched by ID, phone number, or email, normalized', () => {
  assert.ok(sameMember(ana, { id: 'imsg-ana', phoneNumber: '+15555550100' }));
  assert.ok(sameMember(ben, { id: 'other', email: 'ben@example.com' }));
  assert.ok(sameMember(cal, { id: 'tg-cal' }));
  assert.ok(!sameMember(cal, { id: 'tg-other' }));
});

test('holdsExactly wants the same members and no one else; holdsAll lets others in', () => {
  assert.ok(holdsExactly(group(ana, ben), [ana, ben]));
  assert.ok(!holdsExactly(group(ana, ben, cal), [ana, ben]));
  assert.ok(holdsAll(group(ana, ben, cal), [ana, ben]));
  assert.ok(!holdsAll(group(ana, cal), [ana, ben]));
  const single = { id: '!s:beeper.local', type: 'single', participants: { items: [self, ana] } };
  assert.ok(!holdsExactly(single, [ana]) && !holdsAll(single, [ana]));
});

test('the pair is the Handles, normalized and sorted, so the same two match across networks and orders', () => {
  assert.equal(pairOf([ana, ben]), pairOf([ben, { id: 'imsg-ana', phoneNumber: '+15555550100' }]));
  assert.notEqual(pairOf([ana, ben]), pairOf([ana, cal]));
  assert.deepEqual([handleKey(ben), handleKey(cal)], ['mailto:ben@example.com', 'id:tg-cal']);
  assert.deepEqual([memberKey(ana), memberKey(cal)], ['+1 555 555 0100', 'tg-cal']);
  assert.ok(FIRST_MESSAGE_IN_CREATE.has('iMessage') && !FIRST_MESSAGE_IN_CREATE.has('WhatsApp'));
});

test('an older iMessage group counts only with exactly these Handles, and a database that can\'t be read throws', async () => {
  const read = async () => [['+15555550100', 'ben@example.com', '+15555550102'], ['+1 (555) 555-0100', 'BEN@example.com']];
  assert.equal(await olderIMessageGroup(['+15555550100', 'ben@example.com'], read), true);
  assert.equal(await olderIMessageGroup(['+15555550100', '+15555550103'], read), false);
  await assert.rejects(olderIMessageGroup(['+15555550100'], async () => { throw new Error('no access'); }), /no access/);
});
