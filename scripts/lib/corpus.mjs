// The Beeper Companion's corpus, when this Mac has one: every message, the People behind
// them, and per-person stats, in one local file. Read-only, through /usr/bin/sqlite3, so the
// skill keeps no dependencies. Without the file every caller falls back to live reads.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const corpusPath = () => process.env.BEEPER_ASSISTANT_CORPUS || join(homedir(), 'Library', 'Application Support', 'Beeper Companion', 'corpus.db');

// The schema this reader was written against. A newer corpus that still has it works.
const NEEDS = 'corpus-0003-review-fixes';

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', args, { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n').pop()));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); } catch (e) { reject(e); }
    });
  });
}

// Read-only first. macOS's sqlite3 cannot open a WAL database read-only once its -wal and
// -shm files are gone, so a refused open is tried again as an ordinary one, which creates
// them, runs only this SELECT, and removes them.
async function query(file, sql, { write = false } = {}) {
  if (write) return run(['-json', '-cmd', '.timeout 5000', file, sql]);
  // Reads run side by side, and one may be recovering the file while another opens it, so
  // each waits for a lock instead of failing at once.
  try { return await run(['-readonly', '-json', '-cmd', '.timeout 5000', `file:${file}?mode=ro`, sql]); } catch (e) {
    if (!/unable to open database file/i.test(e.message)) throw e;
    return run(['-json', '-cmd', '.timeout 5000', file, sql]);
  }
}
const str = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Null when there is no usable corpus, with the reason, so the caller can say why it fell back.
export async function openCorpus(file = corpusPath()) {
  if (!existsSync(file)) return { ok: false, reason: 'no corpus on this Mac' };
  try {
    const rows = await query(file, `SELECT (SELECT count(*) FROM schema_migrations WHERE name = ${str(NEEDS)}) AS v, (SELECT value FROM corpus_meta WHERE key = 'built_at') AS built`);
    if (!rows[0] || !rows[0].v) return { ok: false, reason: 'the corpus is from a version this skill does not read' };
    if (!rows[0].built) return { ok: false, reason: 'the corpus has not finished its first build' };
    return { ok: true, file, builtAt: rows[0].built };
  } catch (e) {
    return { ok: false, reason: `the corpus could not be read: ${e.message}` };
  }
}

// The same canonical forms the companion stores: E.164 phones, lowercased emails with
// Gmail's dots and +tags dropped. Phones match on their trailing digits, so a number typed
// without its country code still finds the person.
const GMAIL = /^g(oogle)?(mail\.com)$/;
export function emailKey(raw) {
  const e = String(raw || '').trim().toLowerCase().replace(/^mailto:/, '');
  const at = e.lastIndexOf('@');
  if (at < 1) return null;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  // Gmail and Googlemail are one mailbox, which ignores dots and +tags.
  if (GMAIL.test(domain)) { local = local.split('+')[0].replace(/\./g, ''); domain = domain.replace(GMAIL, 'g$2'); }
  return `${local}@${domain}`;
}
export function phoneDigits(raw) {
  let d = String(raw || '').replace(/\D+/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length >= 7 ? d : null;
}

// People matching a name, number, email, or person id, most-talked-to first.
export async function findPeople(file, q) {
  const text = String(q || '').trim();
  if (!text) return [];
  let where;
  if (/^p_[0-9a-f]+$/.test(text)) {
    where = `p.person_id = (SELECT coalesce((SELECT person_id FROM people WHERE person_id = ${str(text)}), (SELECT redirect_to FROM retired_people WHERE person_id = ${str(text)})))`;
  } else if (text.includes('@')) {
    const e = emailKey(text);
    if (!e) return [];
    where = `p.person_id IN (SELECT pm.person_id FROM person_members pm WHERE pm.member_key IN (SELECT handle_key FROM handles WHERE email = ${str(e)} UNION SELECT card_key FROM card_addresses WHERE kind = 'email' AND value = ${str(e)}))`;
  } else if (phoneDigits(text) && /^[+()\d\s.\-]+$/.test(text)) {
    // Canonical numbers can end in ;ext=, so a number also finds the desk lines behind it.
    const digits = phoneDigits(text);
    const has = (col) => `(${col} LIKE ${str(`%${digits}`)} OR ${col} LIKE ${str(`%${digits};ext=%`)})`;
    where = `p.person_id IN (SELECT pm.person_id FROM person_members pm WHERE pm.member_key IN (SELECT handle_key FROM handles WHERE ${has('phone')} UNION SELECT card_key FROM card_addresses WHERE kind = 'phone' AND ${has('value')}))`;
  } else {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (col) => words.map((w) => `(' ' || lower(${col}) || ' ') LIKE ${str(`% ${w.replace(/[%_]/g, '')}%`)}`).join(' AND ');
    where = `p.person_id IN (
      SELECT person_id FROM people WHERE ${match('display_name')}
      UNION SELECT pm.person_id FROM contact_cards cc JOIN person_members pm ON pm.member_key = cc.card_key WHERE ${match('cc.name')}
      UNION SELECT pm.person_id FROM handles h JOIN person_members pm ON pm.member_key = h.handle_key WHERE ${match('h.display_name')} OR ${match('h.username')})`;
  }
  return query(file, `SELECT p.person_id, p.display_name, p.state, coalesce(s.from_owner + s.from_them + s.group_from_them, 0) AS messages, s.networks
    FROM people p LEFT JOIN person_stats s ON s.person_id = p.person_id WHERE ${where}
    ORDER BY messages DESC, p.person_id LIMIT 12`);
}

// One Person: Chats on every network, stats, open conflicts, and suggested matches.
export async function personProfile(file, id) {
  const pid = str(id);
  const members = `(SELECT member_key FROM person_members WHERE person_id = ${pid})`;
  const [people, chats, stats, conflicts, suggestions] = await Promise.all([
    query(file, `SELECT person_id, display_name, name_source, state FROM people WHERE person_id = ${pid}`),
    query(file, `SELECT c.chat_key, c.beeper_chat_id, c.network, c.title,
        (SELECT max(sent_at) FROM messages m WHERE m.chat_key = c.chat_key AND m.duplicate_of IS NULL) AS last_at,
        (SELECT count(*) FROM messages m WHERE m.chat_key = c.chat_key AND m.duplicate_of IS NULL AND m.retracted = 0) AS messages
      FROM chats c WHERE c.counterparty IN ${members} AND c.kind = 'single' ORDER BY last_at DESC`),
    query(file, `SELECT * FROM person_stats WHERE person_id = ${pid}`),
    query(file, `SELECT reason FROM identity_conflicts WHERE resolved_at IS NULL AND EXISTS (SELECT 1 FROM json_each(json_extract(detail, '$.members')) j WHERE j.value IN ${members})`),
    query(file, `SELECT pm.person_id AS other, p.display_name AS other_name, s.reason FROM identity_suggestions s
        JOIN person_members pm ON pm.member_key = CASE WHEN s.a IN ${members} THEN s.b ELSE s.a END JOIN people p ON p.person_id = pm.person_id
      WHERE s.a IN ${members} OR s.b IN ${members}`),
  ]);
  if (!people[0]) return null;
  return { ...people[0], chats, stats: stats[0] || null, conflicts: conflicts.map((c) => c.reason), suggestions };
}

// The Owner's answer about whether two People are one person. Stored on one member of each,
// as the companion stores it, so it survives any change of id. It takes effect at the
// corpus's next rebuild.
export async function decideSame(file, a, b, decision) {
  if (decision !== 'same' && decision !== 'different') throw new Error('decision must be same or different');
  const rep = async (id) => {
    const rows = await query(file, `SELECT member_key FROM person_members WHERE person_id = coalesce((SELECT person_id FROM people WHERE person_id = ${str(id)}),
      (SELECT redirect_to FROM retired_people WHERE person_id = ${str(id)})) ORDER BY member_key LIMIT 1`);
    return rows[0] ? rows[0].member_key : null;
  };
  const [x, y] = [await rep(a), await rep(b)];
  if (!x || !y) return { ok: false, reason: 'One of those people is not in the corpus.' };
  if (x === y) return { ok: false, reason: 'Those are already the same person.' };
  const [lo, hi] = x < y ? [x, y] : [y, x];
  await query(file, `INSERT INTO identity_decisions (a, b, decision, decided_at) VALUES (${str(lo)}, ${str(hi)}, ${str(decision)}, ${str(new Date().toISOString())})
    ON CONFLICT (a, b) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`, { write: true });
  return { ok: true };
}
