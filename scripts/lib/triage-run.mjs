// Builds the ranked Triage list from reads passed in, so `ba triage` and the companion's
// snapshot run the same steps. Nothing here writes.
import { strangerKey } from './history.mjs';
import { rankRows } from './rank.mjs';
import { DEFAULT_WINDOW_DAYS, applyContext, buildTriage, capTriage, filterTriage, wantsHistory } from './triage.mjs';

const DAY = 86_400_000;

// reads: {
//   chatsSince(cutoffMs) -> { chats, truncated }
//   contacts() -> Contacts index
//   state() -> the skill's state, for dismissals
//   messages(chatID, limit) -> recent messages, newest last
//   history(chats) -> { stats: Map<chatID, counts and answer rate>, problems }, optional
//   strangers() -> Map<account key, { chats, answered }>, optional
// }
// `judge(rows)` is optional: the companion passes a model's reads of the rows, as a Map from
// Chat id to { owed, want, urgent, urgentKind, expiresAt, gist }.
/**
 * @param {any} reads
 * @param {{ now?: number, windowDays?: number, includeAutomated?: boolean, maxPeople?: number, maxGroups?: number,
 *   judge?: ((rows: any[]) => Promise<Map<string, any>>) | null, signal?: AbortSignal | null }} [options]
 */
export async function collectTriage(reads, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, includeAutomated = false, maxPeople = 100, maxGroups = 10, judge = null, signal = null } = {}) {
  const [{ chats, truncated }, contacts] = await Promise.all([reads.chatsSince(now - windowDays * DAY), reads.contacts()]);
  const t = buildTriage(chats, { now, windowDays, state: reads.state(), contacts, includeAutomated, finalize: false });
  // Look inside one-to-one Chats, eight at a time, at most 150.
  const queue = t.people.filter(wantsHistory).slice(0, 150);
  t.stats.notInspected = Math.max(0, t.people.filter(wantsHistory).length - queue.length);
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let r = queue.shift(); r && !(signal && signal.aborted); r = queue.shift()) {
      try { applyContext(r, await reads.messages(r.id, 20), { now }); } catch { /* keep the preview */ }
    }
  }));
  if (signal && signal.aborted) throw new Error('Interrupted');
  filterTriage(t);
  const rows = [...t.people, ...t.groups];
  t.history = { available: false, problems: [] };
  const [history, strangers] = await Promise.all([
    reads.history ? reads.history(rows.map((r) => ({ id: r.id, messageIDs: [...new Set([r.lastMessageID, r.newestID, ...(r.runIDs || [])].filter(Boolean))] }))).catch((e) => ({ stats: new Map(), problems: [e && e.message ? e.message : String(e)] })) : null,
    reads.strangers ? reads.strangers().catch(() => new Map()) : new Map(),
  ]);
  const stats = history ? history.stats : new Map();
  if (history) t.history = { available: true, problems: history.problems || [] };
  const opts = { now, stats, strangers, strangerKey };
  // A first pass by rules, so a judge sees each row's Closeness and want.
  rankRows(rows, opts);
  if (judge) {
    let judgments = new Map();
    try { judgments = await judge(rows); } catch { /* the rules stand */ }
    t.judged = judgments.size;
    rankRows(rows, { ...opts, judgments });
  }
  t.people.sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
  t.groups.sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
  t.truncated = truncated;
  t.contactsAvailable = contacts && contacts.available;
  return capTriage(t, { maxPeople, maxGroups });
}
