// Names for phone numbers and emails, read from the Mac's Contacts database.
// Read-only. If access is denied the lookup returns nothing and the caller shows raw handles.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SQL = `
select r.Z_PK as pk, r.ZFIRSTNAME as first, r.ZLASTNAME as last, r.ZNICKNAME as nick,
       r.ZORGANIZATION as org, p.ZFULLNUMBER as value, 'phone' as kind
  from ZABCDPHONENUMBER p join ZABCDRECORD r on r.Z_PK = p.ZOWNER
 where p.ZFULLNUMBER is not null
union all
select r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION, e.ZADDRESS, 'email'
  from ZABCDEMAILADDRESS e join ZABCDRECORD r on r.Z_PK = e.ZOWNER
 where e.ZADDRESS is not null;`;

export function contactDatabases(root = join(homedir(), 'Library', 'Application Support', 'AddressBook')) {
  const out = [];
  const name = 'AddressBook-v22.abcddb';
  try {
    if (existsSync(join(root, name))) out.push(join(root, name));
    const sources = join(root, 'Sources');
    for (const d of readdirSync(sources)) {
      const p = join(sources, d, name);
      if (existsSync(p)) out.push(p);
    }
  } catch { /* no access or no Contacts */ }
  return out;
}

function query(db) {
  return new Promise((resolve) => {
    execFile('/usr/bin/sqlite3', ['-readonly', '-json', db, SQL], { maxBuffer: 256 * 1024 * 1024, timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve({ rows: [], error: String(err.message || err).split('\n')[0] });
      try { resolve({ rows: stdout.trim() ? JSON.parse(stdout) : [] }); } catch { resolve({ rows: [], error: 'unreadable output' }); }
    });
  });
}

// Digits only. A leading 1 on an 11-digit number is the US country code.
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D+/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

export const normalizeEmail = (raw) => String(raw || '').trim().toLowerCase();

export function looksLikePhone(s) {
  const t = String(s || '').trim();
  return /^[+()\d\s.\-]{7,}$/.test(t) && normalizePhone(t).length >= 7;
}
export const looksLikeEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());

export function displayName(row) {
  const full = [row.first, row.last].filter(Boolean).join(' ').trim();
  return full || (row.nick || '').trim() || (row.org || '').trim() || '';
}

function add(map, key, name) {
  if (!key || !name) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(name);
}

export function buildIndex(rows) {
  const phones = new Map();
  const tails = new Map();
  const emails = new Map();
  const people = new Map(); // name -> {phones:Set, emails:Set}
  for (const r of rows) {
    const name = displayName(r);
    if (!name) continue;
    if (!people.has(name)) people.set(name, { phones: new Set(), emails: new Set() });
    if (r.kind === 'phone') {
      const n = normalizePhone(r.value);
      if (n.length < 7) continue;
      add(phones, n, name);
      add(tails, n.slice(-10), name);
      people.get(name).phones.add(n);
    } else {
      const e = normalizeEmail(r.value);
      add(emails, e, name);
      people.get(name).emails.add(e);
    }
  }
  return { phones, tails, emails, people, size: rows.length };
}

const only = (set) => (set && set.size === 1 ? [...set][0] : null);

// Returns a name only when exactly one contact owns the handle.
export function nameFor(index, handle) {
  if (!index || !handle) return null;
  if (looksLikeEmail(handle)) return only(index.emails.get(normalizeEmail(handle)));
  const n = normalizePhone(handle);
  if (n.length < 7) return null;
  return only(index.phones.get(n)) || (n.length >= 10 ? only(index.tails.get(n.slice(-10))) : null);
}

export function searchPeople(index, text) {
  const tokens = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!index || !tokens.length) return [];
  const out = [];
  for (const [name, v] of index.people) {
    const words = name.toLowerCase().split(/\s+/);
    const hit = tokens.every((t) => words.some((w) => w.startsWith(t)));
    if (hit) out.push({ name, phones: [...v.phones], emails: [...v.emails] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

let cached = null;
export const resetContacts = () => { cached = null; };

// Every contact name that owns this handle. More than one means the handle is ambiguous.
export function ownersOf(index, handle) {
  if (!index || !handle) return [];
  if (looksLikeEmail(handle)) return [...(index.emails.get(normalizeEmail(handle)) || [])];
  const n = normalizePhone(handle);
  if (n.length < 7) return [];
  const exact = index.phones.get(n);
  if (exact && exact.size) return [...exact];
  return n.length >= 10 ? [...(index.tails.get(n.slice(-10)) || [])] : [];
}
export async function loadContacts({ root } = {}) {
  if (cached && !root) return cached;
  const dbs = contactDatabases(root);
  const rows = [];
  const errors = [];
  for (const db of dbs) {
    const r = await query(db);
    rows.push(...r.rows);
    if (r.error) errors.push(r.error);
  }
  const index = buildIndex(rows);
  index.databases = dbs.length;
  index.errors = errors;
  index.available = dbs.length > 0 && rows.length > 0;
  if (!root) cached = index;
  return index;
}
