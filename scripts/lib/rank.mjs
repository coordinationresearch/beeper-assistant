// Ranks the Triage list. Pure functions, no I/O.
// Each row gets a class (urgent, waiting, unsure, nothing), a score inside its class, and a
// Reason built from what placed it. The ranking learns from what the Owner answers: how often
// they answer each Chat, and how often they answer strangers on each network. It never asks.
// Ranking orders the list; it never adds or removes a row.
import { htmlToText, looksLikeAck } from './triage.mjs';

export const CLASSES = ['urgent', 'waiting', 'unsure', 'nothing'];
export const WANTS = ['ask', 'plan', 'news', 'fyi', 'pleasantry', 'pitch'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- Closeness ----
// From counts of what the Owner and the Chat have written, read from files on this Mac.
// No counts is "unknown", never "new": a missing or partial file is not proof of a stranger.
export function closenessOf(row, stats) {
  if (row.pinned) return 'close';
  const recentOwner = row.ownerSpoke === true;
  if (!stats) {
    if (row.inContacts) return 'known';
    return recentOwner ? 'light' : 'unknown';
  }
  const { owner, theirs, owner90, ownerWeeks26 } = stats;
  if ((owner90 >= 20 && ownerWeeks26 >= 4) || (owner >= 150 && theirs >= 150)) return 'close';
  if ((owner >= 3 && theirs >= 3) || row.inContacts) return 'known';
  if (owner >= 1 || recentOwner) return 'light';
  return 'new';
}
const KNOWS = new Set(['close', 'known', 'light']);

// ---- What the latest messages want ----
const QUESTION = /\?(?!\S*\/)/; // a question mark, not one inside a link
const REQUEST = /\b(can|could|would|will) (you|u)\b|\bcan u\b|\blmk\b|\blet me know\b|\bplease\b|\bpls\b|\bany chance\b|\bwondering if\b|\bdo you (know|have|want|think)\b|\bthoughts\b|\bneed (you|your|a)\b|\bmind (if|sending|sharing)\b|\bsend (me|over)\b|\bintro(duce)? (me|us)\b/i;
const PLAN = /\b(lunch|dinner|coffee|drinks?|breakfast|brunch|hang|meet( up)?|call|catch ?up|gym|join|hosting|party|tonight|tomorrow|today|this (week|weekend|morning|afternoon|evening)|next (week|month)|(mon|tues|wednes|thurs|fri|satur|sun)day|noon|\d{1,2}(:\d\d)?\s?(am|pm|a|p)\b|\d{1,2}\/\d{1,2})\b/i;
// A thanks or sign-off with a few more words: "Sounds good, let's do the cafe!", "Yup that works!".
const CLOSER = /\b(thanks?|thank (you|u)|thx|ty|appreciate (it|you|that)|sounds (good|great|perfect)|that works|works for me|see (you|u|ya)|cya|talk soon|ttyl|will do|i'?ll be there|will follow up|looking forward|can'?t wait|love (it|that|this|to)|congrats|no worries|no problem|all good|have fun|enjoy|good luck|will hang|perfect|awesome|amazing|hilarious|haha+|lol+|lmao)\b/i;
const PITCH = /\b(thanks? (you )?for (connecting|the connection|accepting)|nice to (connect|be connected)|came across your (profile|work)|wanted to connect|reach(ing)? out (to|regarding|about)|would love to (connect|chat|show|share|hop)|our (team|company|platform|product|agency|clients?)|opportunit(y|ies)|partnership|collaborat|book a (call|demo)|demo\b|happy to share|we help|i help\b|i lead\b|invite you to|sign up|register\b|webinar|free trial|boost your|media opportunit|press|sponsor)/i;
// A day named in a plan. SKILL.md already puts anything due in the next three days first.
const SOON = /\b(today|tonight|tomorrow|tmrw|this (morning|afternoon|evening|week|weekend)|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
// Short hype with nothing to answer: "Ayyy / That's so sick".
const HYPE = /\b(ay+|yo+|sick|dope|lit|fire|nice|cool|wow|omg|insane|crazy|wild|legend|hell yeah|let'?s go+|so good|love (it|that|this))\b/i;
// Waiting costs something today. Distress and safety are left to a model, which can tell
// "in the hospital" from "had surgery five weeks ago".
const NOW_CUE = /\bnow\?|\b(asap|urgent(ly)?|emergency|right now|here now|i'?m (here|outside)|outside|(at|in) the (door|entrance|front|gate|lobby)|running late|locked out|today by|by (tonight|today|eod|end of (the )?day|noon)|in (an|one) hour|in \d+ ?(min|mins|minutes))\b/i;

// `texts` is the run of their messages since the Owner last wrote, oldest first.
export function wantOf(row, texts = []) {
  const all = texts.map((t) => htmlToText(t).trim()).filter(Boolean);
  const joined = all.join(' / ');
  if (['reaction', 'notice', 'empty', 'ack'].includes(row.kind)) return 'pleasantry';
  if (!joined) return row.kind === 'link' || row.kind === 'attachment' ? 'fyi' : 'pleasantry';
  const stranger = !KNOWS.has(row.closeness);
  const asks = all.some((t) => QUESTION.test(t)) || REQUEST.test(joined);
  // A stranger asking to be let in right now is not a pitch, whatever else they wrote.
  if (stranger && PITCH.test(joined) && !(asks && NOW_CUE.test(joined))) return 'pitch';
  if (asks) return PLAN.test(joined) ? 'plan' : 'ask';
  if (all.every((t) => looksLikeAck(t))) return 'pleasantry';
  if (joined.length <= 120 && CLOSER.test(joined)) return 'pleasantry';
  if (joined.length <= 40 && HYPE.test(joined)) return 'pleasantry';
  if (PLAN.test(joined)) return 'plan';
  if (row.kind === 'link' || row.kind === 'attachment') return 'fyi';
  if (joined.split(/\s+/).length >= 5) return KNOWS.has(row.closeness) ? 'news' : 'fyi';
  return 'fyi';
}

// Beeper reports most unread Chats as marked unread too. Only a mark with nothing unread is the Owner's.
export const markedByOwner = (r) => r.markedUnread === true && !(r.unreadCount > 0);

// ---- What the Owner's answers say ----
export const MIN_RUNS = 3;
export const answerShare = (s) => (s && s.runs >= MIN_RUNS ? s.answered / s.runs : null);
// Strangers' first messages on one network, e.g. { chats: 433, answered: 64 }.
export const MIN_STRANGERS = 10;
export const strangerShare = (x) => (x && x.chats >= MIN_STRANGERS ? x.answered / x.chats : null);

// ---- Class, score ----
const WANT_POINTS = { ask: 18, plan: 18, news: 8, fyi: 0, pleasantry: 0, pitch: 0 };
const CLOSE_POINTS = { close: 14, known: 10, light: 5, unknown: 3, new: 0 };

function baseClass(r) {
  const knows = KNOWS.has(r.closeness);
  if (r.type === 'group') {
    if (r.mentions > 0) return 'waiting';
    if (r.closeness === 'close' && (r.want === 'ask' || r.want === 'plan')) return 'unsure';
    return 'nothing';
  }
  if (markedByOwner(r)) return 'waiting';
  // The Owner answered after the unread mark: what is left is a stale flag.
  if (r.lastFrom === 'me') return 'nothing';
  if (r.want === 'pleasantry' || r.want === 'pitch') return 'nothing';
  if (knows && ['ask', 'plan', 'news'].includes(r.want)) return 'waiting';
  if (r.pinned) return 'waiting';
  if (r.want === 'ask' || r.want === 'plan') return 'unsure';
  if (r.closeness === 'unknown' || (knows && r.want === 'fyi')) return 'unsure';
  return 'nothing';
}

// A model's verdict, when the companion has one, outranks the rules on what is owed. It
// cannot make a stranger urgent, and an urgent verdict lapses at its expiry.
function judgedClass(r, j, now) {
  const knows = r.closeness === 'close' || r.closeness === 'known';
  if (r.lastFrom === 'me' && !markedByOwner(r)) return 'nothing';
  if (j.owed === 'no') return markedByOwner(r) ? 'waiting' : 'nothing';
  if (j.urgent && knows && r.type !== 'group' && !(j.expiresAt && Date.parse(j.expiresAt) <= now)) return 'urgent';
  if (j.owed === 'unsure') return 'unsure';
  if (j.owed === 'yes') return KNOWS.has(r.closeness) || r.pinned ? 'waiting' : 'unsure';
  return baseClass(r);
}

// Rows need `closeness`, `want`, and the cue flags set first. `stats` holds the Chat's counts
// and answer rate; `stranger` the answer rate for strangers on its network. `judgment` is a
// model's read of the row: { owed, want, urgent, urgentKind, expiresAt, gist }.
export function rankRow(r, { now = Date.now(), stats = null, stranger = null, judgment = null } = {}) {
  const factors = [];
  const add = (name, points) => { if (points) factors.push({ name, points }); };
  if (judgment && WANTS.includes(judgment.want)) r.want = judgment.want;
  let cls = judgment ? judgedClass(r, judgment, now) : baseClass(r);
  const knows = KNOWS.has(r.closeness);
  // Urgent from the rules needs someone the Owner knows well and a fresh time word.
  // A stranger saying "urgent" does not meet the bar.
  if (!judgment && cls === 'waiting' && r.type !== 'group' && (r.closeness === 'close' || r.closeness === 'known') && r.ageMs < 12 * HOUR && r.nowCue) cls = 'urgent';
  add(`want:${r.want}`, WANT_POINTS[r.want] || 0);
  if (r.soonCue && r.want === 'plan' && r.ageMs < 72 * HOUR) add('soon', 8);
  if (r.endsInQuestion && r.want !== 'pleasantry' && r.want !== 'pitch') add('question', 4);
  add(`closeness:${r.closeness}`, CLOSE_POINTS[r.closeness] || 0);
  // How often the Owner answers this Chat, from -20 to +30. A replay of eight weeks of the
  // Owner's mornings put it, with freshness below, level with newest-first on what got answered.
  const share = r.type === 'group' ? null : answerShare(stats);
  if (share !== null) add('answer-rate', Math.round((share - 0.4) * 50));
  if (!knows && r.type !== 'group') {
    const s = strangerShare(stranger);
    if (s !== null) add('stranger-rate', Math.max(-6, Math.min(6, Math.round((s - 0.3) * 20))));
  }
  if (markedByOwner(r)) add('marked-unread', 15);
  if (r.mentions) add('mentions', Math.min(10, 5 * r.mentions));
  // Fresh messages rank higher and fade over two days. A first version gave points for waiting
  // instead, and the replay showed the Owner answers fresh messages: it ranked worse than newest
  // first. The Reason still counts the wait from the first unanswered message. A stranger's
  // message fades faster.
  if (knows) add('fresh', Math.max(0, 12 - Math.floor(r.ageMs / HOUR / 4)));
  else add('stale', -Math.min(10, Math.floor(r.ageMs / DAY)));
  if ((r.messages || 0) >= 3) add('several', 2);
  if (r.hasDraft) add('draft', -3);
  // Someone the Owner seldom answers drops out of waiting. Never out of urgent.
  if (cls === 'waiting' && share !== null && share < 0.2 && stats.runs >= 5 && !markedByOwner(r)) cls = 'unsure';
  const score = Math.max(0, Math.min(100, factors.reduce((s, f) => s + f.points, 0)));
  r.rank = { class: cls, score, closeness: r.closeness, want: r.want, factors, judged: !!judgment };
  if (judgment && judgment.gist) r.rank.gist = String(judgment.gist).replace(/\s+/g, ' ').trim().slice(0, 90);
  if (cls === 'urgent' && judgment && judgment.urgentKind) r.rank.urgentKind = judgment.urgentKind;
  return r;
}

export function compareRanked(a, b) {
  return (CLASSES.indexOf(a.rank.class) - CLASSES.indexOf(b.rank.class)) || (b.rank.score - a.rank.score) || (a.ageMs - b.ageMs);
}

// ---- Reason ----
const WANT_WORDS = {
  ask: 'Asked you something', plan: 'Making plans', news: 'Shared news', fyi: 'Sent something to look at',
  pleasantry: 'A thanks or a sign-off', pitch: 'Cold outreach',
};
const URGENT_WORDS = { deadline: 'Has a deadline today', waiting: 'Waiting for you right now', distress: 'Someone close is in trouble', risk: 'Money, access, or safety at risk' };
const NETWORK_WORDS = { imessage: 'iMessage', linkedin: 'LinkedIn', twitter: 'X', instagramgo: 'Instagram', whatsapp: 'WhatsApp', signal: 'Signal', telegram: 'Telegram', facebookgo: 'Messenger' };

export function compactCount(n) {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

export function closenessWords(r, stats, now = Date.now()) {
  if (r.type === 'group') {
    if (!stats) return '';
    return stats.owner90 >= 10 ? 'a group you write in' : stats.owner > 0 ? 'a group you rarely write in' : 'a group you never write in';
  }
  if (r.closeness === 'unknown') return 'no history on this Mac';
  if (!stats) return r.closeness === 'light' ? 'you have written here' : r.closeness === 'known' ? 'in your Contacts' : '';
  if (stats.owner === 0 && r.closeness !== 'light') return 'you have never written here';
  if (r.closeness === 'light') return stats.owner ? `you've written ${stats.owner} ${stats.owner === 1 ? 'time' : 'times'}` : 'you have written here';
  const since = stats.first ? new Date(stats.first).getFullYear() : null;
  const often = stats.ownerWeeks26 >= 13 ? ', most weeks' : stats.ownerWeeks26 >= 4 ? ', often lately' : '';
  const yearNow = new Date(now).getFullYear();
  return `${compactCount(stats.messages)} messages${since && since < yearNow ? ` since ${since}` : ''}${often}`;
}

function answerWords(r, stats, stranger) {
  const f = r.rank.factors.find((x) => x.name === 'answer-rate');
  if (f && Math.abs(f.points) >= 5) {
    const share = stats.answered / stats.runs;
    const how = share >= 0.75 ? 'you usually answer' : share >= 0.5 ? 'you often answer' : share >= 0.25 ? 'you sometimes answer' : 'you rarely answer';
    return `${how} (${stats.answered} of ${stats.runs})`;
  }
  const g = r.rank.factors.find((x) => x.name === 'stranger-rate');
  if (g) {
    const pct = Math.round((100 * stranger.answered) / stranger.chats);
    const where = /^imsg##/.test(String(r.id)) ? 'iMessage' : NETWORK_WORDS[String(r.account).toLowerCase()] || r.network;
    return `you answer ${pct}% of strangers on ${where}`;
  }
  return '';
}

// For someone the Owner knows, from the first unanswered message. For a stranger, from the
// newest, since their wait is no obligation.
export function waitWords(r, now = Date.now()) {
  const since = KNOWS.has(r.closeness) ? Date.parse(r.waitingSince) : 0;
  const ms = since ? Math.max(0, now - since) : r.ageMs;
  const h = Math.floor(ms / HOUR);
  if (h < 1) return 'just now';
  if (h < 48) return `waiting ${h}h`;
  return `waiting ${Math.floor(h / 24)}d`;
}

// One line a person would agree explains the place: what they want, then why it sits here.
// The part that moved the row, such as the Owner's answer rate, is never the part dropped.
export function reasonFor(r, { stats = null, stranger = null, now = Date.now() } = {}) {
  const k = r.rank;
  const soon = k.factors.some((f) => f.name === 'soon');
  let lead = k.gist || (k.class === 'urgent' ? URGENT_WORDS[k.urgentKind] || 'Time-sensitive' : soon ? 'Making plans for the next few days' : WANT_WORDS[k.want] || 'New message');
  if (r.type === 'group' && r.mentions && !k.gist) lead = `Mentioned you${r.mentions > 1 ? ` ${r.mentions} times` : ''}`;
  if (r.lastFrom === 'me' && k.class === 'nothing') lead = 'You wrote last';
  const marked = markedByOwner(r) && k.class !== 'urgent' ? 'you marked it unread' : '';
  const answer = answerWords(r, stats, stranger);
  // With an answer rate in the line, the history needs no cadence.
  const who = closenessWords(r, stats, now).replace(answer ? /, (most weeks|often lately)$/ : /$^/, '');
  const wait = k.class === 'nothing' ? '' : waitWords(r, now);
  const parts = [lead, marked, who, answer, wait].filter(Boolean);
  let line = parts.join(' · ');
  if (line.length > 100) line = [lead, marked, answer || who, wait].filter(Boolean).join(' · ');
  return line;
}

// Sets each row's Closeness, want, and cues, then ranks and sorts the rows in place.
// `stats` maps Chat id to counts and answer rate; `strangers` maps an account key to the
// answer rate for strangers there; `judgments` maps Chat id to a model's read.
export function rankRows(rows, { now = Date.now(), stats = new Map(), strangers = new Map(), strangerKey = () => '', judgments = new Map() } = {}) {
  for (const r of rows) {
    const s = stats.get(r.id) || null;
    // With the Owner speaking last there is no run of theirs to read; the preview is the Owner's.
    const texts = r.lastFrom === 'me' ? [] : r.texts || [r.preview];
    r.closeness = closenessOf(r, s);
    r.want = wantOf(r, texts);
    r.nowCue = NOW_CUE.test(texts.join(' / '));
    r.soonCue = SOON.test(texts.join(' / '));
    r.endsInQuestion = QUESTION.test(htmlToText(texts[texts.length - 1] || ''));
    const stranger = strangers.get(strangerKey(r)) || null;
    rankRow(r, { now, stats: s, stranger, judgment: judgments.get(r.id) || null });
    r.rank.reason = reasonFor(r, { stats: s, stranger, now });
    if (s) r.history = { messages: s.messages, owner: s.owner, owner90: s.owner90, ownerWeeks26: s.ownerWeeks26, first: s.first, runs: s.runs, answered: s.answered, source: s.source };
  }
  return rows.sort(compareRanked);
}
