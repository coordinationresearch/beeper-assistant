// Builds the ranked Triage list from reads passed in, so `ba triage` and the companion's
// snapshot run the same steps. Nothing here writes.
import { strangerKey } from './history.mjs';
import { rankRows } from './rank.mjs';
import { DEFAULT_WINDOW_DAYS, applyContext, buildTriage, capTriage, filterTriage, htmlToText, latestInboundAt, previewKind, wantsHistory } from './triage.mjs';

const DAY = 86_400_000;

// reads: {
//   chatsSince(cutoffMs) -> { chats, truncated }
//   contacts() -> Contacts index
//   state() -> the skill's state, for dismissals
//   messages(chatID, limit) -> recent messages, newest last
//   history(chats) -> { stats: Map<chatID, counts and answer rate>, problems }, optional
//   strangers() -> Map<account key, { chats, answered }>, optional
//   dropped() -> Map<chatID, { kind, why, at }>, optional: Chats that hold a Dropped item
//     (ADR 0081), which the list keeps whoever spoke last and however old. The companion
//     passes them while its Preview is on; `ba triage` passes none.
//   chat(chatID) -> one Chat, optional: fetches a Chat dropped() names that is older than the window
// }
// `judge(rows)` is optional: the companion passes a model's reads of the rows, as a Map from
// Chat id to { owed, want, urgent, urgentKind, expiresAt, gist }.
/**
 * @param {any} reads
 * @param {{ now?: number, windowDays?: number, includeAutomated?: boolean, maxPeople?: number, maxGroups?: number,
 *   judge?: ((rows: any[]) => Promise<Map<string, any>>) | null, signal?: AbortSignal | null }} [options]
 */
export async function collectTriage(reads, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, includeAutomated = false, maxPeople = 100, maxGroups = 10, judge = null, signal = null } = {}) {
  const [{ chats: listed, truncated }, contacts, held] = await Promise.all([reads.chatsSince(now - windowDays * DAY), reads.contacts(),
    reads.dropped ? Promise.resolve().then(() => reads.dropped()).then((m) => new Map(m), () => new Map()) : new Map()]);
  const chats = [...listed, ...await heldChats(reads, held, listed, signal)];
  const t = buildTriage(chats, { now, windowDays, state: reads.state(), contacts, includeAutomated, finalize: false, held });
  // Look inside one-to-one Chats, eight at a time, at most 150, those that hold a Dropped item first.
  const queue = [...t.people.filter((r) => r.held), ...t.people.filter((r) => !r.held)].filter(wantsHistory).slice(0, 150);
  t.stats.notInspected = Math.max(0, t.people.filter(wantsHistory).length - queue.length);
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let r = queue.shift(); r && !(signal && signal.aborted); r = queue.shift()) {
      try {
        const page = await reads.messages(r.id, 20);
        applyContext(r, page, { now });
        // A held row's newest message from either side, as read here, which a caller can bind
        // an action to. Kept out of JSON, like the run's text.
        if (r.held) Object.defineProperty(r, 'heldNewest', { value: newestShown(page), enumerable: false, writable: true, configurable: true });
      } catch { /* keep the preview */ }
    }
  }));
  // A group's preview can be a reaction, a notice, or the Owner's own message. Read back for
  // their newest real message, for the companion's count of what is new. Its rank is unchanged.
  const groups = t.groups.filter((r) => !r.lastInboundAt);
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let r = groups.shift(); r && !(signal && signal.aborted); r = groups.shift()) {
      try { r.lastInboundAt = latestInboundAt(await reads.messages(r.id, 20)); } catch { /* stays unknown */ }
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

// At most this many Chats outside the window are fetched one by one: Home holds one Dropped
// item per Person and checks at most 40 a run.
export const MAX_HELD_FETCH = 40;

// The Chats dropped() names that the window's list doesn't hold, read one at a time. Beeper's
// read of one Chat has no preview, which Dismiss and the first pass read, so its newest message
// stands in, as the list's preview is. A Chat that can't be read is left out this time.
async function heldChats(reads, held, listed, signal) {
  if (!held.size || !reads.chat) return [];
  const have = new Set(listed.map((c) => String(c.id)));
  const queue = [...held.keys()].filter((id) => !have.has(id)).slice(0, MAX_HELD_FETCH);
  const out = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let id = queue.shift(); id && !(signal && signal.aborted); id = queue.shift()) {
      try {
        const chat = await reads.chat(id);
        if (!chat || String(chat.id) !== id) continue;
        if (!chat.preview) chat.preview = (await reads.messages(id, 20)).at(-1) || null;
        out.push(chat);
      } catch { /* left out until the next look */ }
    }
  }));
  return out;
}

// The newest message in a page that a person would see: not hidden, deleted, a reaction, or a notice.
function newestShown(page) {
  const m = page.filter((x) => x && !x.isHidden && !x.isDeleted && !['reaction', 'notice'].includes(previewKind(x))).at(-1);
  return m ? { id: String(m.id), text: htmlToText(m.text || ''), fromOwner: m.isSender === true } : null;
}
