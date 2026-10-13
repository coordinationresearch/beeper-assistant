// `ba people` and `ba trends` (ADR 0107): Home's People and Trends, read from the running Beeper
// Companion, which holds the only implementation (ADR 0103, 0110). ADR 0100's limits hold: the
// past year's list stops at 25th, a search prints no rank, and nothing counts unanswered messages
// or streaks. Names come from other people's accounts and topics from a model, so both print
// inside «…» on one line.
import { homePageFromApp } from './app.mjs';
import { networkName } from './network-names.mjs';
import { quote, span, UNTRUSTED_NOTE } from './render.mjs';

// Fixed sentences, printed when there is nothing to show. Never text the app sent.
export const COMPANION_NOT_RUNNING = 'Beeper Companion must be running on this Mac for this command. Ask the Owner to open it, then try again.';
export const COMPANION_TOO_OLD = 'Beeper Companion on this Mac is too old for this command. Ask the Owner to update it.';
export const COMPANION_FAILED = "Beeper Companion couldn't read this just now. Try again in a moment.";
export const COMPANION_UNREADABLE = "Beeper Companion answered in a shape this skill can't read. Ask the Owner to update Beeper Companion.";
export const PEOPLE_NOT_READY = "Beeper Companion hasn't built its Corpus on this Mac yet, so it has no People list.";
export const TRENDS_NOT_READY = "Beeper Companion's Trends appear once its Corpus is ready on this Mac. It isn't yet.";
export const TRENDS_OFF = "Trends are off while the Owner's message history is turned off in Beeper Companion.";
export const PEOPLE_RANKED = 25;
export const SEARCH_MAX = 200;

// The shape every field must have before anything prints.
const obj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string';
const count = (v) => Number.isInteger(v) && v >= 0;
const amount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const instant = (v) => v === null || (str(v) && Number.isFinite(Date.parse(v)));
const month = (v) => str(v) && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const zone = (v) => { try { return str(v) && Boolean(new Intl.DateTimeFormat('en-US', { timeZone: v })); } catch { return false; } };
const seconds = (v) => v === null || amount(v);
const personRow = (r, ranked) => obj(r) && str(r.name) && Array.isArray(r.networks) && r.networks.every(str) && instant(r.lastAt) && count(r.year)
  && (r.reply === null || (obj(r.reply) && seconds(r.reply.owner) && seconds(r.reply.them) && instant(r.reply.since)))
  && (ranked ? Number.isInteger(r.rank) && r.rank >= 1 && r.rank <= PEOPLE_RANKED : r.rank === undefined);
// search: what was asked, so a list answer never prints as a search's or the other way round.
export const validPeople = (v, search = null) => obj(v) && typeof v.ready === 'boolean' && (search === null ? v.search === null : str(v.search))
  && typeof v.limited === 'boolean' && Array.isArray(v.rows) && v.rows.every((r) => personRow(r, search === null));
// talked arrives once the Trends join carries what the two talked about; until then it is absent.
const change = (c) => obj(c) && str(c.name) && ['faded', 'rose', 'new'].includes(c.kind) && amount(c.earlierMonthly) && amount(c.recentMonthly) && instant(c.lastAt)
  && (c.talked === undefined || c.talked === null || (Array.isArray(c.talked) && c.talked.every(str)));
const history = (h) => obj(h) && count(h.messages) && count(h.peopleWrittenTo) && count(h.networks) && (h.firstYear === null || count(h.firstYear))
  && Array.isArray(h.years) && h.years.every((y) => obj(y) && count(y.year) && Array.isArray(y.networks) && y.networks.every((n) => obj(n) && str(n.network) && count(n.messages)));
export const validTrends = (v) => obj(v) && (v.status === 'off' || v.status === 'unavailable'
  || (v.status === 'ready' && obj(v.windows) && zone(v.windows.zone) && month(v.windows.earlierStart) && month(v.windows.recentStart) && month(v.windows.end)
    && Array.isArray(v.changes) && v.changes.every(change) && history(v.history)));

async function page(read, capability, path, valid) {
  const got = await read(capability, path);
  if (got.failure === 'refused') throw new Error(got.message);
  if (got.failure) throw new Error(got.failure === 'not-running' ? COMPANION_NOT_RUNNING : got.failure === 'old' ? COMPANION_TOO_OLD : COMPANION_FAILED);
  if (!valid(got.value)) throw new Error(COMPANION_UNREADABLE);
  return got.value;
}
// The past year's list, or a search's matches. Throws a fixed sentence when there is none to print.
export async function peopleFromApp(search, read = homePageFromApp) {
  const record = await page(read, 'people', search === null ? '/people' : `/people?${new URLSearchParams({ q: search })}`, (v) => validPeople(v, search));
  if (!record.ready) throw new Error(PEOPLE_NOT_READY);
  return record;
}
export async function trendsFromApp(read = homePageFromApp) {
  const record = await page(read, 'trends', '/trends', validTrends);
  if (record.status !== 'ready') throw new Error(record.status === 'off' ? TRENDS_OFF : TRENDS_NOT_READY);
  return record;
}

const field = (value) => quote(String(value ?? '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200));
const number = (n) => n.toLocaleString('en-US');
const many = (n, one, more = `${one}s`) => `${number(n)} ${n === 1 ? one : more}`;
// A message's day, in the Mac's own zone unless timeZone names another. Trends' windows stay in the
// Corpus's zone; the days messages were sent are the Mac's, as in People.
const date = (iso, timeZone) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone });

function personLine(r, timeZone) {
  const reply = !r.reply ? 'Reply time: too few answers to measure'
    : `Reply time${r.reply.since ? `, all time since ${date(r.reply.since, timeZone)}` : ''}: you ${span(r.reply.owner)}, them ${span(r.reply.them)}`;
  return [field(r.name), r.networks.map(networkName).join(', ') || 'no one-to-one chats', r.lastAt ? `last message ${date(r.lastAt, timeZone)}` : 'no messages',
    `${many(r.year, 'message')} in the past year`, reply].join(' · ');
}

export function renderPeople(record, { timeZone } = {}) {
  const out = [];
  if (record.search === null) {
    out.push(`PEOPLE · the past year's top ${PEOPLE_RANKED}, by one-to-one messages both ways · from Beeper Companion`, UNTRUSTED_NOTE);
    for (const r of record.rows) out.push(`${String(r.rank).padStart(2)}. ${personLine(r, timeZone)}`);
    if (!record.rows.length) out.push('No one-to-one messages in the past year.');
    out.push('Reply times are medians. For anyone else, run ba people --search "<name, number, or email>".');
  } else {
    out.push(`PEOPLE matching ${quote(record.search)} · ${record.rows.length}${record.limited ? '+' : ''} ${record.rows.length === 1 ? 'match' : 'matches'}, in People's order · from Beeper Companion`, UNTRUSTED_NOTE);
    for (const r of record.rows) out.push(personLine(r, timeZone));
    if (!record.rows.length) out.push(`No one matches ${quote(record.search)}.`);
    else out.push(`Reply times are medians.${record.limited ? ` Only the first ${record.rows.length} matches. Search with more of the name to narrow it.` : ''}`);
  }
  out.push('For one person\'s chats and stats, run ba who "<name>".');
  return out.join('\n');
}

// "Jul 2026" for a month in the Corpus's zone, as Trends labels its windows.
const monthLabel = (m) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const before = (m) => { const d = new Date(`${m}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const average = (v) => v > 0 && v < 1 ? 'less than 1' : number(Math.round(v));
const about = (v) => v > 0 && v < 1 ? 'Less than 1' : `About ${average(v)}`;
const KINDS = { faded: 'FADED', rose: 'ROSE', new: 'NEW' };
// Trends' own wording for each kind of change (renderer/trends-view.ts).
const changeText = (c) => c.kind === 'new' ? `First talked recently. ${about(c.recentMonthly)} messages a month.`
  : c.kind === 'rose' && c.earlierMonthly === 0 ? `New to your top ${PEOPLE_RANKED}. ${about(c.recentMonthly)} messages a month.`
    : `${about(c.earlierMonthly)} messages a month before, ${average(c.recentMonthly)} recently.`;
const together = (items) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

export function renderTrends(record, { timeZone } = {}) {
  const w = record.windows, h = record.history;
  const out = [`TRENDS · ${monthLabel(w.recentStart)} to ${monthLabel(before(w.end))}, compared with ${monthLabel(w.earlierStart)} to ${monthLabel(before(w.recentStart))} · from Beeper Companion`,
    UNTRUSTED_NOTE, 'What changed: messages from both of you, averaged over complete months.'];
  for (const c of record.changes.slice(0, 4)) {
    out.push(`${KINDS[c.kind].padEnd(6)} ${field(c.name)}: ${changeText(c)} ${c.lastAt ? `Last message ${date(c.lastAt, timeZone)}.` : 'Last message date unavailable.'}`);
    if (c.talked?.length) out.push(`${' '.repeat(7)}You talked about ${together(c.talked.map(field))}.`);
  }
  if (!record.changes.length) out.push('No changes stand out in these months.');
  out.push('', `HISTORY · ${many(h.messages, 'message')}${h.firstYear !== null ? ` since ${h.firstYear}` : ''} · ${many(h.peopleWrittenTo, 'person', 'people')} written to · ${many(h.networks, 'network')}`);
  for (const y of [...h.years].reverse()) {
    const total = y.networks.reduce((n, x) => n + x.messages, 0);
    const split = [...y.networks].sort((a, b) => b.messages - a.messages || a.network.localeCompare(b.network)).map((x) => `${networkName(x.network)} ${number(x.messages)}`);
    out.push(`  ${y.year}  ${many(total, 'message')}${split.length ? `: ${split.join(' · ')}` : ''}`);
  }
  return out.join('\n');
}
