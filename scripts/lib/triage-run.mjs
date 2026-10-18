// Builds the ranked Triage list from reads passed in, so `ba triage` and the companion's
// snapshot run the same steps. Nothing here writes.
import { groupRead, ownerNamesFrom, ownerNamesIn, repliesBeyond } from './addressed.mjs';
import { participantTotal } from './beeper.mjs';
import { strangerKey } from './history.mjs';
import { rankRows } from './rank.mjs';
import { DEFAULT_WINDOW_DAYS, applyContext, buildTriage, capTriage, dismissalHolds, filterTriage, groupCandidates, htmlToText, isUnread, previewKind, senderLabel, trailingInbound, wantsHistory } from './triage.mjs';

const DAY = 86_400_000;
// At most this many read groups are read for whether they Addressed the Owner, newest first. Unread
// groups and ones that hold a Dropped item are always read.
export const MAX_READ_GROUPS = 100;

// reads: {
//   chatsSince(cutoffMs) -> { chats, truncated }
//   contacts() -> Contacts index
//   state() -> the skill's state, for dismissals
//   messages(chatID, limit) -> recent messages, newest last
//   history(chats) -> { stats: Map<chatID, counts and answer rate>, problems }, optional
//   strangers() -> Map<account key, { chats, answered }>, optional
//   pace(chatIDs) -> Map<chatID, { p90Ms, replied }>, optional: the Owner's reply pace with each
//     Person, for the Bands (ADR 0263). `ba triage` passes none, so every Chat slips on the floor.
//   dropped() -> Map<chatID, { kind, why, at }>, optional: Chats that hold a Dropped item
//     (ADR 0081), which the list keeps whoever spoke last and however old. The companion
//     passes them while its Preview is on; `ba triage` passes none.
//   chat(chatID) -> one Chat, optional: fetches a Chat dropped() names that is older than the window
//   message(chatID, messageID) -> one message or null, optional: whether a group's reply answers an
//     older message of the Owner's, beyond the page read
// }
// `judge(rows)` is optional: the companion passes a model's reads of the rows, as a Map from
// Chat id to { owed, want, urgent, urgentKind, expiresAt, gist }. `ownerNames`: more first names the
// Owner goes by, such as their Contacts card's (addressed.mjs meCardNames), for telling when a group
// names them. The names their networks show are read from the Chats. `mentioned`: the caller's memory
// of which message of a group's Burst a mention was counted with, by Chat id, read and updated here,
// so a mention still addresses the Owner after Beeper's counts clear (addressed.mjs groupRead). Kept
// across runs by the caller; without it each run sees only the counts.
/**
 * @param {any} reads
 * @param {{ now?: number, windowDays?: number, includeAutomated?: boolean, maxPeople?: number, maxGroups?: number,
 *   judge?: ((rows: any[]) => Promise<Map<string, any>>) | null, signal?: AbortSignal | null, ownerNames?: string[], mentioned?: Map<string, string> }} [options]
 */
export async function collectTriage(reads, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, includeAutomated = false, maxPeople = 100, maxGroups = 10, judge = null, signal = null, ownerNames = [], mentioned = new Map() } = {}) {
  const [{ chats: listed, truncated }, contacts, held] = await Promise.all([reads.chatsSince(now - windowDays * DAY), reads.contacts(),
    reads.dropped ? Promise.resolve().then(() => reads.dropped()).then((m) => new Map(m), () => new Map()) : new Map()]);
  const chats = [...listed, ...await heldChats(reads, held, listed, signal)];
  const state = reads.state();
  // Groups are read before the list is built, since only their messages say whether a read one
  // Addressed the Owner and stays (ADR 0145), and whether a Dismiss outlasted a Reaction.
  const { pages, skipped } = await readGroups(reads, chats, { now, windowDays, state, held, ownerNames, mentioned, signal });
  if (signal && signal.aborted) throw new Error('Interrupted');
  const t = buildTriage(chats, { now, windowDays, state, contacts, includeAutomated, finalize: false, held, groupReads: new Map([...pages].map(([id, g]) => [id, g.read])),
    dismissedGroups: new Set([...pages].filter(([, g]) => g.dismissed).map(([id]) => id)) });
  if (skipped) t.stats.groupsNotRead = skipped;
  // Each group row as the list reads a one-to-one Chat (applyContext), so the ranking, the Judgment,
  // and Agent Drafts see their Burst, plus how it Addressed the Owner and who did. Who wrote each
  // message of the Burst the Judgment sees, and who addressed the Owner, stay out of JSON.
  const byID = new Map(chats.map((c) => [String(c.id), c]));
  for (const r of t.groups) {
    const g = pages.get(r.id);
    if (!g) continue;
    applyContext(r, g.messages, { now });
    r.ownerSpoke = g.read.ownerSpoke;
    r.addressed = g.read.addressed;
    const chat = byID.get(String(r.id)), by = g.read.addressedIn ? g.messages.find((m) => String(m.id) === g.read.addressedIn) : null;
    hidden(r, 'senders', trailingInbound(g.messages).burst.slice(-6).map((m) => senderLabel(m, chat, contacts)));
    hidden(r, 'addressedBy', by ? senderLabel(by, chat, contacts) : null);
  }
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
  if (signal && signal.aborted) throw new Error('Interrupted');
  filterTriage(t);
  const rows = [...t.people, ...t.groups];
  t.history = { available: false, problems: [] };
  const [history, strangers, pace] = await Promise.all([
    reads.history ? reads.history(rows.map((r) => ({ id: r.id, messageIDs: [...new Set([r.lastMessageID, r.newestID, ...(r.runIDs || [])].filter(Boolean))] }))).catch((e) => ({ stats: new Map(), problems: [e && e.message ? e.message : String(e)] })) : null,
    reads.strangers ? reads.strangers().catch(() => new Map()) : new Map(),
    // The Owner's reply pace per Chat, for the Bands (ADR 0263). `ba triage` has no pace
    // reader, so it slips on the 48h floor alone; a failed read is no pace.
    reads.pace ? Promise.resolve().then(() => reads.pace(rows.map((r) => r.id))).then((m) => new Map(m), () => new Map()) : new Map(),
  ]);
  const stats = history ? history.stats : new Map();
  if (history) t.history = { available: true, problems: history.problems || [] };
  // A group's page may hold nothing of the Owner's though they write there: the Mac's history counts
  // it, so the group is no stranger's room (ADR 0086, never a stranger).
  for (const r of t.groups) if (Number(stats.get(r.id)?.owner) > 0) r.ownerSpoke = true;
  const opts = { now, stats, strangers, strangerKey, pace };
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

const hidden = (row, key, value) => Object.defineProperty(row, key, { value, enumerable: false, writable: true, configurable: true });

// Each group the list could keep (groupCandidates), its page and what it says (addressed.mjs
// groupRead), four at a time: unread groups and held ones, then read ones newest first, at most
// MAX_READ_GROUPS. A reply in their Burst to a message beyond the page is looked up by its ID, at
// most three per group. A group whose read fails is left as its preview says, so a read one is off
// the list. skipped counts the read groups past the cap. dismissed: its messages show its Dismiss
// still holds. mentioned (collectTriage) is updated for each group read, and forgets a group the
// list could no longer keep.
async function readGroups(reads, chats, { now, windowDays, state, held, ownerNames, mentioned, signal }) {
  const out = new Map();
  const candidates = groupCandidates(chats, { now, windowDays, state, held });
  const ids = new Set(candidates.map((c) => c.id));
  for (const id of [...mentioned.keys()]) if (!ids.has(id)) mentioned.delete(id);
  const always = candidates.filter((c) => isUnread(c) || held.has(c.id));
  const read = candidates.filter((c) => !isUnread(c) && !held.has(c.id)).sort((a, b) => (Date.parse(b.lastActivity) || 0) - (Date.parse(a.lastActivity) || 0));
  const skipped = Math.max(0, read.length - MAX_READ_GROUPS);
  if (!candidates.length) return { pages: out, skipped };
  const owner = [...new Set([...ownerNamesFrom(chats), ...ownerNames])];
  const queue = [...always, ...read.slice(0, MAX_READ_GROUPS)];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let c = queue.shift(); c && !(signal && signal.aborted); c = queue.shift()) {
      try {
        const messages = await reads.messages(c.id, 20);
        const owned = [];
        for (const id of reads.message ? repliesBeyond(messages).slice(0, 3) : []) {
          if (signal && signal.aborted) break;
          const target = await Promise.resolve().then(() => reads.message(c.id, id)).catch(() => null);
          if (target && target.isSender === true) owned.push(id);
        }
        const g = groupRead(messages, { mentions: Number(c.unreadMentionsCount) || 0, unread: Number(c.unreadCount) || 0,
          names: ownerNamesIn(c, messages, owner), owned, others: participantTotal(c) - 1, mentionedIn: mentioned.get(c.id) ?? null, now });
        if (g.mentionIn) mentioned.set(c.id, g.mentionIn); else mentioned.delete(c.id);
        out.set(c.id, { messages, read: g, dismissed: Boolean(state) && dismissalHolds(state, c, messages) });
      } catch { /* left as its preview says */ }
    }
  }));
  return { pages: out, skipped };
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
