// Which group holds whom, the one copy `ba group` and Beeper Companion's Intros both use (ADR 0096).
import { looksLikeEmail, normalizeEmail, normalizePhone } from './contacts.mjs';
import { counterparties, isGroup } from './triage.mjs';

// iMessage makes a group only by sending into it. Beeper's create there fails at once without a first
// message and makes nothing (platform-imessage.log "no message", 2026-10-11), so the first message goes
// in the one create request as messageText (ADR 0001).
export const FIRST_MESSAGE_IN_CREATE = new Set(['iMessage']);

// What Beeper's create takes for a member: the phone number or email, else the network's ID.
export const memberKey = (m) => m.phoneNumber || m.email || m.id;

// A member as the pair holds it: phone numbers and emails normalized, so the same person matches
// across networks, otherwise the network's participant ID. The same person on a Handle the pair
// doesn't hold is someone else here.
export const handleKey = (m) => m.phoneNumber ? `tel:${normalizePhone(m.phoneNumber)}`
  : m.email ? `mailto:${normalizeEmail(m.email)}` : `id:${m.id}`;

// The two People's Handles, sorted: what a newer Intro for the same two replaces.
export const pairOf = (members) => members.map(handleKey).sort().join('\n');

// Whether a participant is this member, by ID, phone number, or email.
export const sameMember = (m, p) => p.id === m.id
  || Boolean(m.phoneNumber && p.phoneNumber && normalizePhone(p.phoneNumber) === normalizePhone(m.phoneNumber))
  || Boolean(m.email && p.email && normalizeEmail(p.email) === normalizeEmail(m.email));

// A group with exactly these members besides the Owner.
export function holdsExactly(chat, members) {
  const others = counterparties(chat);
  return isGroup(chat) && others.length === members.length && members.every((m) => others.some((p) => sameMember(m, p)));
}

// A group that holds all of these members, and maybe others.
export function holdsAll(chat, members) {
  const others = counterparties(chat);
  return isGroup(chat) && members.every((m) => others.some((p) => sameMember(m, p)));
}

// Whether the Messages database holds a group with exactly these Handles. read gives each group's
// Handles (history.mjs iMessageGroupMembers) and throws when the database can't be read.
export async function olderIMessageGroup(handles, read) {
  const key = (h) => (looksLikeEmail(h) ? normalizeEmail(h) : normalizePhone(h));
  const wanted = new Set(handles.map(key));
  return (await read()).some((g) => { const have = new Set(g.map(key)); return have.size === wanted.size && [...wanted].every((h) => have.has(h)); });
}
