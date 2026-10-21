import { preparedActionBody, actionID } from './prepared-action.mjs';
// The Owner's actions as `ba app` commands (ADR 0185): one entry per action, held once for the skill
// and the app. ba.mjs reads each entry's modes before anything connects; the app's CLI (app-cli.ts)
// reads its callers, its lateness, and its check of the request body. The words after `ba app` are
// stable, since the phone and the skill show them. The app runs each action through the same function
// its button calls. Plain data and small checks only: no judgment lives here (ADR 0103).
//
// modes: the skill modes it runs in, from a terminal and inside a Companion run (COMPANION_RUN).
// callers: who the app lets in: the Terminal, an Ask (from the sidebar or the Line).
// late: whether a run that read the Owner's text late may do it.
// read: it changes nothing, so a lost answer is not uncertain.
// parse(rest): the request body from the words after the action's own, or a usage error.
// check(body): the app's own check of exactly the body's keys and shapes.
// chats(body): the Chat IDs it names, which the Line's own Chat refuses.

// The Chat ID Beeper's API uses, as ba find --json and ba app auto list print it.
export const exactChatID = (s) => typeof s === 'string' && s.length <= 2048 && !/[\x00-\x20\x7f]/.test(s) && /^(!|imsg##)./.test(s);
const sendID = (s) => /^[1-9]\d{0,15}$/.test(s ?? '') && Number.isSafeInteger(Number(s));
const messageID = (s) => typeof s === 'string' && s.length > 0 && s.length <= 2048 && !/[\x00-\x20\x7f]/.test(s);
const keys = (body, required, optional = []) => Boolean(body) && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).every((k) => required.includes(k) || optional.includes(k)) && required.every((k) => k in body);

const ALL = ['full', 'drafts', 'readonly'];
const NOT_READONLY = ['full', 'drafts'];
const FULL = ['full'];
const both = (modes) => ({ terminal: modes, run: modes });
const OWNER = ['terminal', 'ask'];
const none = (rest) => { if (rest.length) throw new Error('usage'); return {}; };
const empty = (body) => keys(body, []);
const oneChat = (rest) => { if (rest.length !== 1 || !exactChatID(rest[0])) throw new Error('usage'); return { chatID: rest[0] }; };
const chatBody = (body) => keys(body, ['chatID']) && exactChatID(body.chatID);
// An Intro's ID, as `ba group` and `ba app intros` print it (lib/app.mjs INTRO_ID).
const INTRO_ID = /^i[0-9a-f]{8}$/;
// The networks whose downloads the Corpus reads (src/corpus/imports.ts IMPORT_NETWORKS).
const historyNetwork = (value) => value === 'linkedin';
const absolutePath = (value) => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const choiceID = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
// Settings → Agent's Model and Effort rows (ADR 0271): pick, own, or a model ID as a Harness takes it on
// its command line (model-choice.ts modelName). The app checks the value is one the row offers.
const modelChoice = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/.test(value);
const EFFORT_CHOICES = ['pick', 'own', 'low', 'medium', 'high', 'xhigh', 'max'];
// Where a Reply on show comes from, as the sidebar keys it: its own options, an Agent Draft's, a terminal agent's.
const REPLY_SOURCES = ['options', 'draft', 'agent'];
// Settings' Waits between messages (step-pace.ts PACE_CHOICES): learned, or a fixed factor on the Owner's pace.
export const PACE_CHOICES = ['learned', '0.5', '1', '1.5', '2', '3'];
// A wait as seconds, "20s", "1.5 s", or "2m", in whole milliseconds, or null.
const waitMsOf = (value) => {
  const m = /^(\d+(?:\.\d+)?)(s|m)?$/.exec(String(value ?? '').replace(/\s+/g, ''));
  const ms = m ? Math.round(Number(m[1]) * (m[2] === 'm' ? 60_000 : 1000)) : NaN;
  return Number.isSafeInteger(ms) && ms >= 0 && ms <= 3_600_000 ? ms : null;
};

const contactField = (value, max) => value === undefined || (typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value));
const namePart = value => typeof value === 'string' && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
const menuText = (value, multiple) => {
  const messages = typeof value === 'string' ? [value] : multiple && Array.isArray(value) ? value : [];
  return messages.length > 0 && messages.length <= 10 && messages.every(text => typeof text === 'string' && text.trim() && !text.includes('\0'))
    && messages.reduce((sum, text) => sum + text.length, 0) <= 10_000;
};
// A Person's ID, as ba who and ba people print it, and the ids `person file` gives a File's lines,
// Open loops, and an Undo. Instructions and Notes by the IDs ba app chat and ba notes print.
const personID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
// An offer of a Reply's rest: Enter's (enter-continue.ts) or one their message left (reply-runner.ts).
const restOfferID = value => typeof value === 'string' && /^(?:resume:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
// The Owner's changes to that rest before the press, by each Step's place from 0 (rest-edits.ts checks them against the offer).
const restPlace = (n) => Number.isSafeInteger(n) && n >= 0 && n < 64;
const restChanges = (e) => keys(e, ['drop', 'texts']) && Array.isArray(e.drop) && e.drop.length <= 64 && e.drop.every(restPlace) && Array.isArray(e.texts) && e.texts.length <= 64
  && e.texts.every((t) => keys(t, ['at', 'text']) && restPlace(t.at) && typeof t.text === 'string' && t.text.length <= 20_000);
const LINE_ID = /^f[1-9]\d{0,15}$/, LOOP_ID = /^l_[0-9a-f]{12}$/, UNDO_ID = /^u[0-9a-f]{16}$/;
const PARTS = ['who', 'now', 'you', 'talk', 'history', 'others'];
const shownText = value => typeof value === 'string' && value.length <= 4000 && !value.includes('\0');
const lineText = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 500 && !value.includes('\0');
const WIDER = ['chat', 'person', 'global'];
const instructionID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const noteID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
// A Playbook situation in words, a move's number in it, and a Lesson's id (lib/playbook.mjs).
const situationWords = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const MOVE = /^[1-9]\d?$/;
const moveNumber = value => Number.isSafeInteger(value) && value >= 1 && value <= 99;
const LESSON_ID = /^l[0-9a-f]{7}$/;
// A Mind map card's or Interest's title as `ba mind` prints it, a new title, or a topic's name.
const mindName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const mindNames = value => Array.isArray(value) && value.length <= 100 && value.every(mindName);
const mindTwo = (a, b) => (rest) => { if (rest.length !== 2 || !rest.every(mindName)) throw new Error('usage'); return { [a]: rest[0], [b]: rest[1] }; };
// split's words: the card, the new Area's title, then --interest and --topic, each as often as needed.
const mindSplit = (rest) => {
  const [area, title, ...flags] = rest, body = { area, title, interests: [], topics: [] };
  if (!mindName(area) || !mindName(title)) throw new Error('usage');
  for (let i = 0; i < flags.length; i += 2) {
    const list = flags[i] === '--interest' ? body.interests : flags[i] === '--topic' ? body.topics : null;
    if (!list || !mindName(flags[i + 1])) throw new Error('usage');
    list.push(flags[i + 1]);
  }
  if (!body.interests.length && !body.topics.length) throw new Error('usage');
  return body;
};
const personBody = b => keys(b, ['personID']) && personID(b.personID);
const incidentID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const incidentSelection = value => {
  if (!keys(value, ['window', 'runIds', 'categories'], ['backgroundCallIds']) || !keys(value.categories, ['prompts', 'outputs', 'feedback', 'tools'])
    || !Object.values(value.categories).every(v => typeof v === 'boolean') || !Array.isArray(value.runIds) || value.runIds.length > 10
    || !value.runIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\x00-\x1f]/.test(id)) || new Set(value.runIds).size !== value.runIds.length
    || (Object.values(value.categories).some(Boolean) && !value.runIds.length)) return false;
  if (value.backgroundCallIds !== undefined && (!Array.isArray(value.backgroundCallIds) || value.backgroundCallIds.length > 40 || !value.backgroundCallIds.every(id => Number.isSafeInteger(id) && id > 0) || new Set(value.backgroundCallIds).size !== value.backgroundCallIds.length)) return false;
  if (value.window === null) return true;
  const instant = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
  return keys(value.window, ['since', 'until']) && instant(value.window.since) && instant(value.window.until)
    && Date.parse(value.window.until) > Date.parse(value.window.since) && Date.parse(value.window.until) - Date.parse(value.window.since) <= 7 * 86400000;
};
const incidentInstant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const incidentQuery = value => {
  if (!keys(value, ['window'], ['feature', 'outcome', 'search', 'cursor', 'limit']) || !keys(value.window, ['since', 'until'])
    || !incidentInstant(value.window.since) || !incidentInstant(value.window.until)) return false;
  const span = Date.parse(value.window.until) - Date.parse(value.window.since);
  if (span <= 0 || span > 7 * 86400000) return false;
  if (value.feature !== undefined && !['triage', 'brief', 'brief-ahead'].includes(value.feature)) return false;
  if (value.outcome !== undefined && !['running', 'ok', 'invalid', 'failed', 'cancelled', 'timeout', 'interrupted', 'other'].includes(value.outcome)) return false;
  if (value.search !== undefined && (typeof value.search !== 'string' || value.search.length > 128 || /[\x00-\x1f\x7f]/.test(value.search))) return false;
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)) return false;
  return value.cursor === undefined || (keys(value.cursor, ['priority', 'startedAt', 'id', 'revision']) && [0, 1].includes(value.cursor.priority)
    && incidentInstant(value.cursor.startedAt) && Number.isSafeInteger(value.cursor.id) && value.cursor.id > 0
    && typeof value.cursor.revision === 'string' && /^[a-f0-9]{64}$/.test(value.cursor.revision));
};
export const ACTIONS = [
  { name: 'detail list', route: '/detail/list', usage: 'ba app detail list <chatID>', modes: both(ALL), callers: OWNER, late: false, read: true, parse: oneChat, check: chatBody, chats: body => [body.chatID] },
  ...['use', 'dismiss', 'source'].map(action => ({ name: `detail ${action}`, route: `/detail/${action}`,
    usage: `ba app detail ${action} <chatID> <id>`, modes: both(action === 'source' ? ALL : NOT_READONLY), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 2 || !exactChatID(rest[0]) || !/^[a-f0-9]{24}$/.test(rest[1])) throw Error('usage'); return { chatID: rest[0], id: rest[1] }; },
    check: body => keys(body, ['chatID', 'id']) && exactChatID(body.chatID) && typeof body.id === 'string' && /^[a-f0-9]{24}$/.test(body.id), chats: body => [body.chatID] })),
  { name: 'draft saved', route: '/draft/saved', usage: 'ba app draft saved <chatID>', modes: both(ALL), callers: OWNER, late: false, read: true,
    parse: oneChat, check: chatBody, chats: b => [b.chatID] },
  { name: 'draft restore', route: '/draft/restore', usage: 'ba app draft restore <chatID> <backupID>', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 2 || !exactChatID(rest[0]) || !/^[1-9]\d*$/.test(rest[1])) throw Error('usage'); return { chatID: rest[0], id: Number(rest[1]) }; },
    check: b => keys(b, ['chatID', 'id']) && exactChatID(b.chatID) && Number.isSafeInteger(b.id) && b.id > 0, chats: b => [b.chatID] },
  { name: 'draft clear', route: '/draft/clear', usage: 'ba app draft clear <chatID>', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: oneChat, check: chatBody, chats: b => [b.chatID] },
  { name: 'menu choose', route: '/menu/choose', usage: 'ba app menu choose <rowID> <version> <text>', modes: both(NOT_READONLY), callers: ['terminal'], late: false,
    parse: rest => { if (rest.length !== 3) throw Error('usage'); return { rowID: rest[0], version: rest[1], text: rest[2] }; },
    check: b => keys(b, ['rowID', 'version', 'text']) && typeof b.rowID === 'string' && /^[a-f0-9]{16}$/.test(b.rowID)
      && typeof b.version === 'string' && /^[a-f0-9]{16}$/.test(b.version) && menuText(b.text, false), chats: () => [] },
  { name: 'work list', route: '/work/list', usage: 'ba app work list <chatID>', modes: both(ALL), callers: [...OWNER, 'app'], late: true, read: true,
    parse: oneChat, check: chatBody, chats: b => [b.chatID] },
  ...['publish', 'edit', 'draft'].map(operation => ({ name: `work ${operation}`, route: `/work/${operation}`, usage: `ba app work ${operation} '<JSON>'`,
    modes: both(operation === 'publish' ? ALL : NOT_READONLY), callers: operation === 'publish' ? [...OWNER, 'app'] : OWNER, late: operation === 'publish',
    parse: rest => { if (rest.length !== 1) throw Error('usage'); const body = JSON.parse(rest[0]); if (!body || typeof body !== 'object' || !exactChatID(body.chatID)) throw Error('usage'); return body; },
    check: b => Boolean(b) && typeof b === 'object' && !Array.isArray(b) && exactChatID(b.chatID), chats: b => [b.chatID] })),
  ...['adjust', 'dismiss', 'expand'].map(operation => ({ name: `work ${operation}`, route: `/work/${operation}`,
    usage: `ba app work ${operation} <chatID> <workID> ${operation === 'expand' ? '<open|close>' : '<revision>'}${operation === 'adjust' ? ' <instruction>' : ''}`,
    modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: rest => {
      if (rest.length !== (operation === 'adjust' ? 4 : 3) || !exactChatID(rest[0]) || !/^w[0-9a-f]{16}$/.test(rest[1])) throw Error('usage');
      if (operation === 'expand') { if (!['open', 'close'].includes(rest[2])) throw Error('usage'); return { chatID: rest[0], id: rest[1], open: rest[2] === 'open' }; }
      if (!/^[1-9]\d*$/.test(rest[2]) || !Number.isSafeInteger(Number(rest[2]))) throw Error('usage');
      return { chatID: rest[0], id: rest[1], revision: Number(rest[2]), ...(operation === 'adjust' ? { instruction: rest[3] } : {}) };
    },
    check: b => keys(b, operation === 'expand' ? ['chatID', 'id', 'open'] : operation === 'adjust' ? ['chatID', 'id', 'revision', 'instruction'] : ['chatID', 'id', 'revision'])
      && exactChatID(b.chatID) && typeof b.id === 'string' && /^w[0-9a-f]{16}$/.test(b.id)
      && (operation === 'expand' ? typeof b.open === 'boolean' : Number.isSafeInteger(b.revision) && b.revision > 0)
      && (operation !== 'adjust' || typeof b.instruction === 'string' && b.instruction.trim().length > 0 && b.instruction.length <= 2000), chats: b => [b.chatID] })),

  { name: 'ask files', route: '/ask/files', usage: `ba app ask files <chatID> '<JSON request>'`, modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 2) throw Error('usage'); return { chatID: rest[0], request: JSON.parse(rest[1]) }; },
    check: b => keys(b, ['chatID', 'request']) && (exactChatID(b.chatID) || b.chatID === 'no-chat') && b.request && ['add', 'remove'].includes(b.request.operation), chats: b => exactChatID(b.chatID) ? [b.chatID] : [] },
  { name: 'action prepare', route: '/action/prepare', usage: "ba app action prepare '<JSON specification>'", modes: both(ALL), callers: [...OWNER, 'app'], late: true,
    parse: rest => { if (rest.length !== 1) throw Error('usage'); const body = preparedActionBody(JSON.parse(rest[0])); if (!body) throw Error('usage'); return body; },
    check: body => Boolean(preparedActionBody(body)), chats: body => [body.chatID] },
  { name: 'actions', route: '/actions', usage: 'ba app actions <chatID>', modes: both(ALL), callers: [...OWNER, 'app'], late: true, read: true,
    parse: oneChat, check: chatBody, chats: body => [body.chatID] },
  ...['make', 'pass'].map(operation => ({ name: `action ${operation}`, route: `/action/${operation}`, usage: `ba app action ${operation} <chatID> <actionID> --confirmed`,
    modes: both(NOT_READONLY), callers: OWNER, late: operation === 'pass',
    parse: rest => { if (rest.length !== 3 || !exactChatID(rest[0]) || !actionID(rest[1]) || rest[2] !== '--confirmed') throw Error('usage'); return { chatID: rest[0], id: rest[1], confirmed: true }; },
    check: body => keys(body, ['chatID', 'id', 'confirmed']) && exactChatID(body.chatID) && actionID(body.id) && body.confirmed === true,
    chats: body => [body.chatID] })),
  { name: 'action finish', route: '/action/finish', usage: 'ba app action finish <chatID> <actionID> <made|not-made|uncertain> <receipt>', modes: both(NOT_READONLY), callers: ['ask'], late: false,
    parse: rest => { if (rest.length !== 4 || !exactChatID(rest[0]) || !actionID(rest[1]) || !['made', 'not-made', 'uncertain'].includes(rest[2]) || !rest[3].trim() || rest[3].length > 2000) throw Error('usage'); return { chatID: rest[0], id: rest[1], state: rest[2], receipt: rest[3] }; },
    check: body => keys(body, ['chatID', 'id', 'state', 'receipt']) && exactChatID(body.chatID) && actionID(body.id) && ['made', 'not-made', 'uncertain'].includes(body.state) && typeof body.receipt === 'string' && Boolean(body.receipt.trim()) && body.receipt.length <= 2000,
    chats: body => [body.chatID] },
  { name: 'action resolve', route: '/action/resolve', usage: 'ba app action resolve <chatID> <actionID> <made|not-made> --confirmed', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 4 || !exactChatID(rest[0]) || !actionID(rest[1]) || !['made', 'not-made'].includes(rest[2]) || rest[3] !== '--confirmed') throw Error('usage'); return { chatID: rest[0], id: rest[1], made: rest[2] === 'made', confirmed: true }; },
    check: body => keys(body, ['chatID', 'id', 'made', 'confirmed']) && exactChatID(body.chatID) && actionID(body.id) && typeof body.made === 'boolean' && body.confirmed === true,
    chats: body => [body.chatID] },
  // Not now on an Intro card (the sidebar, ADR 0096): the card goes, and nothing is made. On a made
  // card it is the ×, which closes the card and leaves the Intro made. Its Send is `ba app intro make`,
  // outside this table. Passing only stops, so a late run may.
  { name: 'intro pass', route: '/intro/pass', usage: 'ba app intro pass <introID> --confirmed', modes: both(NOT_READONLY), callers: OWNER, late: true,
    parse: rest => { if (rest.length !== 2 || !INTRO_ID.test(rest[0]) || rest[1] !== '--confirmed') throw Error('usage'); return { id: rest[0], confirmed: true }; },
    check: body => keys(body, ['id', 'confirmed']) && typeof body.id === 'string' && INTRO_ID.test(body.id) && body.confirmed === true,
    chats: () => [] },
  { name: 'menu photo', route: '/menu/photo', usage: 'ba app menu photo <rowID> <messageID> <index> | close', modes: both(ALL), callers: ['terminal'], late: false,
    parse: rest => {
      if (rest.length === 1 && rest[0] === 'close') return { rowID: null };
      if (rest.length !== 3 || !/^[a-f0-9]{16}$/.test(rest[0]) || !rest[1] || rest[1].length > 200 || !/^\d{1,2}$/.test(rest[2])) throw Error('usage');
      return { rowID: rest[0], messageID: rest[1], index: Number(rest[2]) };
    },
    check: b => keys(b, ['rowID']) && b.rowID === null || keys(b, ['rowID', 'messageID', 'index']) && typeof b.rowID === 'string' && /^[a-f0-9]{16}$/.test(b.rowID)
      && typeof b.messageID === 'string' && b.messageID.length > 0 && b.messageID.length <= 200 && Number.isInteger(b.index) && b.index >= 0 && b.index < 100,
    chats: () => [] },
  { name: 'menu view', route: '/menu/view', usage: 'ba app menu view', modes: both(ALL), callers: ['terminal'], late: false, read: true,
    parse: none, check: empty, chats: () => [] },
  { name: 'menu stop', route: '/menu/stop', usage: 'ba app menu stop <rowID>', modes: both(ALL), callers: ['terminal'], late: true,
    parse: rest => { if (rest.length !== 1 || !/^[a-f0-9]{16}$/.test(rest[0])) throw Error('usage'); return { rowID: rest[0] }; },
    check: b => keys(b, ['rowID']) && typeof b.rowID === 'string' && /^[a-f0-9]{16}$/.test(b.rowID), chats: () => [] },
  ...['mark read', 'dismiss'].map(kind => ({ name: `menu ${kind}`, route: `/menu/${kind.replace(' ', '-')}`,
    usage: `ba app menu ${kind} <rowID> <version>`, modes: both(FULL), callers: ['terminal'], late: false,
    parse: rest => {
      if (rest.length !== 2 || !rest.every(value => /^[a-f0-9]{16}$/.test(value))) throw Error('usage');
      return { rowID: rest[0], version: rest[1] };
    },
    check: b => keys(b, ['rowID', 'version']) && [b.rowID, b.version].every(value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value)),
    chats: () => [],
  })),
  ...['reply', 'react'].map(kind => ({ name: `menu ${kind}`, route: `/menu/${kind}`,
    usage: `ba app menu ${kind} <rowID> <version> ${kind === 'reply' ? '<text> [text ...]' : '<token>'} --confirmed`,
    modes: both(FULL), callers: ['terminal'], late: false,
    parse: rest => {
      if (rest.length < 4 || rest.at(-1) !== '--confirmed' || !/^[a-f0-9]{16}$/.test(rest[0]) || !/^[a-f0-9]{16}$/.test(rest[1])) throw Error('usage');
      const messages = rest.slice(2, -1), arg = messages.length === 1 ? messages[0] : messages;
      if (!menuText(arg, kind === 'reply')) throw Error('usage');
      return { rowID: rest[0], version: rest[1], arg, confirmed: true };
    },
    check: b => keys(b, ['rowID', 'version', 'arg', 'confirmed']) && typeof b.rowID === 'string' && /^[a-f0-9]{16}$/.test(b.rowID)
      && typeof b.version === 'string' && /^[a-f0-9]{16}$/.test(b.version) && menuText(b.arg, kind === 'reply') && b.confirmed === true,
    chats: () => [],
  })),
  { name: 'contact name', route: '/contact/name', usage: 'ba app contact name <chatID>', timeoutMs: 120_000, modes: both(ALL), callers: OWNER, late: false, read: true,
    parse: oneChat, check: chatBody, chats: b => [b.chatID] },
  { name: 'contact rename', route: '/contact/rename', usage: 'ba app contact rename <chatID> <editID> --first <name> --last <name> [--phone <number>] [--email <address>] --confirmed', modes: both(FULL), callers: OWNER, late: false, timeoutMs: 120_000,
    parse: rest => {
      if (rest.length < 7 || !exactChatID(rest[0]) || !choiceID(rest[1]) || rest[2] !== '--first' || rest[4] !== '--last' || rest.at(-1) !== '--confirmed'
        || !namePart(rest[3]) || !namePart(rest[5]) || !(rest[3] + rest[5]).trim()) throw Error('usage');
      const fields = {};
      for (let i = 6; i < rest.length - 1; i += 2) {
        const key = rest[i] === '--phone' ? 'phone' : rest[i] === '--email' ? 'email' : null;
        if (!key || key in fields || i + 1 >= rest.length - 1 || !contactField(rest[i + 1], key === 'phone' ? 100 : 254)) throw Error('usage');
        fields[key] = rest[i + 1];
      }
      return { chatID: rest[0], editID: rest[1], first: rest[3], last: rest[5], ...fields, confirmed: true };
    },
    check: b => keys(b, ['chatID', 'editID', 'first', 'last', 'confirmed'], ['phone', 'email']) && exactChatID(b.chatID) && choiceID(b.editID)
      && namePart(b.first) && namePart(b.last) && Boolean((b.first + b.last).trim()) && b.confirmed === true
      && contactField(b.phone, 100) && contactField(b.email, 254),
    chats: b => [b.chatID] },
  { name: 'contact matches', route: '/contact/matches', usage: 'ba app contact matches <chatID> [--search <name>]', modes: both(ALL), callers: OWNER, late: false, read: true,
    parse: (rest) => {
      if (!exactChatID(rest[0]) || !(rest.length === 1 || (rest.length === 3 && rest[1] === '--search' && rest[2].length <= 100))) throw new Error('usage');
      return { chatID: rest[0], search: rest[2] ?? '' };
    },
    check: (b) => keys(b, ['chatID', 'search']) && exactChatID(b.chatID) && typeof b.search === 'string' && b.search.length <= 100,
    chats: b => [b.chatID] },
  { name: 'contact link', route: '/contact/link', usage: 'ba app contact link <chatID> <choiceID> --confirmed', modes: both(FULL), callers: OWNER, late: false, timeoutMs: 120_000,
    parse: (rest) => {
      if (rest.length !== 3 || !exactChatID(rest[0]) || !choiceID(rest[1]) || rest[2] !== '--confirmed') throw new Error('usage');
      return { chatID: rest[0], choiceID: rest[1], confirmed: true };
    },
    check: (b) => keys(b, ['chatID', 'choiceID', 'confirmed']) && exactChatID(b.chatID) && choiceID(b.choiceID) && b.confirmed === true,
    chats: b => [b.chatID] },
  // A card Companion saved on its own from a number handoff (ADR 0251): read it, undo it (delete the
  // card it made), or keep it (hide the sidebar's card). The number for Undo and Keep is the card's
  // id from contact saved.
  { name: 'contact saved', route: '/contact/saved', usage: 'ba app contact saved <chatID>', modes: both(ALL), callers: OWNER, late: false, read: true,
    parse: oneChat, check: chatBody, chats: b => [b.chatID] },
  { name: 'contact undo', route: '/contact/undo', usage: 'ba app contact undo <chatID> <id> --confirmed', modes: both(FULL), callers: OWNER, late: false, timeoutMs: 120_000,
    parse: (rest) => {
      if (rest.length !== 3 || !exactChatID(rest[0]) || !sendID(rest[1]) || rest[2] !== '--confirmed') throw new Error('usage');
      return { chatID: rest[0], id: Number(rest[1]), confirmed: true };
    },
    check: (b) => keys(b, ['chatID', 'id', 'confirmed']) && exactChatID(b.chatID) && Number.isSafeInteger(b.id) && b.id > 0 && b.confirmed === true,
    chats: b => [b.chatID] },
  { name: 'contact keep', route: '/contact/keep', usage: 'ba app contact keep <chatID> <id>', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: (rest) => {
      if (rest.length !== 2 || !exactChatID(rest[0]) || !sendID(rest[1])) throw new Error('usage');
      return { chatID: rest[0], id: Number(rest[1]) };
    },
    check: (b) => keys(b, ['chatID', 'id']) && exactChatID(b.chatID) && Number.isSafeInteger(b.id) && b.id > 0,
    chats: b => [b.chatID] },
  // A Person's File as their page shows it (ADR 0267): each line and Open loop with the id the
  // commands below take, and whether Write it now is offered. It only reads.
  { name: 'person file', route: '/person/file', usage: 'ba app person file <personID>', modes: both(ALL), callers: OWNER, late: true, read: true,
    parse: rest => { if (rest.length !== 1 || !personID(rest[0])) throw Error('usage'); return { personID: rest[0] }; }, check: personBody, chats: () => [] },
  // The Owner's corrections, as his page makes them: an edited line becomes his, word for word, and a
  // removed one comes back only when a newer message says it again. They write his own words, so
  // the app takes them from a terminal, on his word, never from a Companion run; an Ask keeps
  // remember and forget, which check his words in the Ask. A terminal agent can edit the Markdown
  // file as well, so this adds a record, not a lock. shownText: the line as person file printed it,
  // so a line changed since is refused.
  { name: 'person line edit', route: '/person/line/edit', usage: 'ba app person line edit <personID> <lineID> <shownText> <newText> --confirmed', modes: both(FULL), callers: ['terminal'], late: false,
    parse: rest => {
      if (rest.length !== 5 || !personID(rest[0]) || !LINE_ID.test(rest[1]) || !shownText(rest[2]) || !lineText(rest[3]) || rest[4] !== '--confirmed') throw Error('usage');
      return { personID: rest[0], lineID: rest[1], shown: rest[2], text: rest[3], confirmed: true };
    },
    check: b => keys(b, ['personID', 'lineID', 'shown', 'text', 'confirmed']) && personID(b.personID) && typeof b.lineID === 'string' && LINE_ID.test(b.lineID)
      && shownText(b.shown) && lineText(b.text) && b.confirmed === true, chats: () => [] },
  { name: 'person line remove', route: '/person/line/remove', usage: 'ba app person line remove <personID> <lineID> <shownText> --confirmed', modes: both(FULL), callers: ['terminal'], late: false,
    parse: rest => {
      if (rest.length !== 4 || !personID(rest[0]) || !LINE_ID.test(rest[1]) || !shownText(rest[2]) || rest[3] !== '--confirmed') throw Error('usage');
      return { personID: rest[0], lineID: rest[1], shown: rest[2], confirmed: true };
    },
    check: b => keys(b, ['personID', 'lineID', 'shown', 'confirmed']) && personID(b.personID) && typeof b.lineID === 'string' && LINE_ID.test(b.lineID) && shownText(b.shown) && b.confirmed === true,
    chats: () => [] },
  { name: 'person line add', route: '/person/line/add', usage: 'ba app person line add <personID> <who|now|you|talk|history|others> <text> --confirmed', modes: both(FULL), callers: ['terminal'], late: false,
    parse: rest => {
      if (rest.length !== 4 || !personID(rest[0]) || !PARTS.includes(rest[1]) || !lineText(rest[2]) || rest[3] !== '--confirmed') throw Error('usage');
      return { personID: rest[0], part: rest[1], text: rest[2], confirmed: true };
    },
    check: b => keys(b, ['personID', 'part', 'text', 'confirmed']) && personID(b.personID) && PARTS.includes(b.part) && lineText(b.text) && b.confirmed === true, chats: () => [] },
  // Takes back one correction by the undo id its answer gave, for ten minutes and while nothing has changed those lines.
  { name: 'person line undo', route: '/person/line/undo', usage: 'ba app person line undo <personID> <undoID>', modes: both(FULL), callers: ['terminal'], late: false,
    parse: rest => { if (rest.length !== 2 || !personID(rest[0]) || !UNDO_ID.test(rest[1])) throw Error('usage'); return { personID: rest[0], undoID: rest[1] }; },
    check: b => keys(b, ['personID', 'undoID']) && personID(b.personID) && typeof b.undoID === 'string' && UNDO_ID.test(b.undoID), chats: () => [] },
  // Marks an Open loop with them done, as the ✕ on a Found item closes one.
  { name: 'person loop done', route: '/person/loop/done', usage: 'ba app person loop done <personID> <loopID>', modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 2 || !personID(rest[0]) || !LOOP_ID.test(rest[1])) throw Error('usage'); return { personID: rest[0], loopID: rest[1] }; },
    check: b => keys(b, ['personID', 'loopID']) && personID(b.personID) && typeof b.loopID === 'string' && LOOP_ID.test(b.loopID), chats: () => [] },
  // Write it now: one first build of their File at once, on the Daily budget, for someone the Owner
  // has written to one-to-one. It writes nothing to Beeper, so a late run may, as with brief, and the
  // app spends a late run's as background work, which Pause stops.
  { name: 'person write', route: '/person/write', usage: 'ba app person write <personID>', modes: both(NOT_READONLY), callers: OWNER, late: true, timeoutMs: 10 * 60_000,
    parse: rest => { if (rest.length !== 1 || !personID(rest[0])) throw Error('usage'); return { personID: rest[0] }; }, check: personBody, chats: () => [] },
  // A standing instruction by its ID (the sidebar's and a Person page's Undo and Delete). An edit takes
  // the Owner's own words in the Ask you are in, as ba app instruction does, so only an Ask makes one.
  { name: 'instruction edit', route: '/instruction/edit', usage: 'ba app instruction edit <instructionID>', modes: both(FULL), callers: ['ask'], late: false,
    parse: rest => { if (rest.length !== 1 || !instructionID(rest[0])) throw Error('usage'); return { id: rest[0] }; },
    check: b => keys(b, ['id']) && instructionID(b.id), chats: () => [] },
  { name: 'instruction undo', route: '/instruction/undo', usage: 'ba app instruction undo <instructionID>', modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 1 || !instructionID(rest[0])) throw Error('usage'); return { id: rest[0] }; },
    check: b => keys(b, ['id']) && instructionID(b.id), chats: () => [] },
  // Use everywhere: the same words saved again for a wider scope, keeping the narrower one. An Ask may
  // only on the Owner's words there naming that scope, which the app checks (ADR 0077).
  { name: 'instruction widen', route: '/instruction/widen', usage: 'ba app instruction widen <instructionID> <chat|person|global>', modes: both(FULL), callers: ['ask'], late: false,
    parse: rest => { if (rest.length !== 2 || !instructionID(rest[0]) || !WIDER.includes(rest[1])) throw Error('usage'); return { id: rest[0], scope: rest[1] }; },
    check: b => keys(b, ['id', 'scope']) && instructionID(b.id) && WIDER.includes(b.scope), chats: () => [] },
  { name: 'instruction delete', route: '/instruction/delete', usage: 'ba app instruction delete <instructionID> --confirmed', modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 2 || !instructionID(rest[0]) || rest[1] !== '--confirmed') throw Error('usage'); return { id: rest[0], confirmed: true }; },
    check: b => keys(b, ['id', 'confirmed']) && instructionID(b.id) && b.confirmed === true, chats: () => [] },
  // A Note, as a Person's page deletes one: it leaves a tombstone, so no agent saves it again.
  { name: 'note delete', route: '/note/delete', usage: 'ba app note delete <chatID> <noteID>', modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 2 || !exactChatID(rest[0]) || !noteID(rest[1])) throw Error('usage'); return { chatID: rest[0], noteID: rest[1] }; },
    check: b => keys(b, ['chatID', 'noteID']) && exactChatID(b.chatID) && noteID(b.noteID), chats: b => [b.chatID] },
  // Home's Playbook page (ADR 0109). The Owner's change to a move is a standing instruction
  // whose scope is its situation, and outranks the move and the Lessons. <situation> is a title, or
  // words that name one, as ba playbook takes them; <move> a move's number there, as ba playbook
  // <situation> --json numbers them. The read is what every run gets with ba playbook <situation>,
  // so the app's own runs read it too, late or not.
  { name: 'playbook', route: '/playbook', usage: 'ba app playbook [<situation>]', modes: both(ALL), callers: [...OWNER, 'app', 'woken'], late: true, read: true,
    parse: rest => { const words = rest.join(' ').trim(); if (words && !situationWords(words)) throw Error('usage'); return words ? { situation: words } : {}; },
    check: b => keys(b, [], ['situation']) && (b.situation === undefined || situationWords(b.situation)), chats: () => [] },
  // A change saves the Owner's own words in the Ask you are in, as ba app instruction does: in place
  // of that move, or with add, for the whole situation. Only an Ask makes one.
  { name: 'playbook change', route: '/playbook/change', usage: 'ba app playbook change <situation> <move>', modes: both(FULL), callers: ['ask'], late: false,
    parse: rest => { const n = rest.at(-1), words = rest.slice(0, -1).join(' ').trim(); if (!situationWords(words) || !MOVE.test(n ?? '')) throw Error('usage'); return { situation: words, move: Number(n) }; },
    check: b => keys(b, ['situation', 'move']) && situationWords(b.situation) && moveNumber(b.move), chats: () => [] },
  { name: 'playbook add', route: '/playbook/add', usage: 'ba app playbook add <situation>', modes: both(FULL), callers: ['ask'], late: false,
    parse: rest => { const words = rest.join(' ').trim(); if (!situationWords(words)) throw Error('usage'); return { situation: words }; },
    check: b => keys(b, ['situation']) && situationWords(b.situation), chats: () => [] },
  { name: 'playbook cut', route: '/playbook/cut', usage: 'ba app playbook cut <situation> <move> --confirmed', modes: both(FULL), callers: OWNER, late: false,
    parse: rest => {
      if (rest.at(-1) !== '--confirmed') throw Error('usage');
      const n = rest.at(-2), words = rest.slice(0, -2).join(' ').trim();
      if (!situationWords(words) || !MOVE.test(n ?? '')) throw Error('usage');
      return { situation: words, move: Number(n), confirmed: true };
    },
    check: b => keys(b, ['situation', 'move', 'confirmed']) && situationWords(b.situation) && moveNumber(b.move) && b.confirmed === true, chats: () => [] },
  // The Owner's change by the id ba app playbook prints: Undo gives back the one it replaced, and
  // remove takes it off, so the shipped move applies again.
  { name: 'playbook undo', route: '/playbook/undo', usage: 'ba app playbook undo <instructionID>', modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 1 || !instructionID(rest[0])) throw Error('usage'); return { id: rest[0] }; },
    check: b => keys(b, ['id']) && instructionID(b.id), chats: () => [] },
  { name: 'playbook remove', route: '/playbook/remove', usage: 'ba app playbook remove <instructionID> --confirmed', modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 2 || !instructionID(rest[0]) || rest[1] !== '--confirmed') throw Error('usage'); return { id: rest[0], confirmed: true }; },
    check: b => keys(b, ['id', 'confirmed']) && instructionID(b.id) && b.confirmed === true, chats: () => [] },
  // A Lesson by the id ba playbook prints (ADR 0117). Removed, no agent saves it again.
  { name: 'playbook lesson remove', route: '/playbook/lesson/remove', usage: 'ba app playbook lesson remove <lessonID> --confirmed', modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 2 || !LESSON_ID.test(rest[0]) || rest[1] !== '--confirmed') throw Error('usage'); return { id: rest[0], confirmed: true }; },
    check: b => keys(b, ['id', 'confirmed']) && typeof b.id === 'string' && LESSON_ID.test(b.id) && b.confirmed === true, chats: () => [] },
  // Pause Background Work (the menu bar's right-click menu, Settings): stops what spends tokens on its
  // own. Stopping only stops, so a late run and a drafts-only run may.
  { name: 'pause', route: '/pause', usage: 'ba app pause', modes: both(NOT_READONLY), callers: OWNER, late: true, parse: none, check: empty, chats: () => [] },
  // Turning it back on starts spending again: only a run in full mode, never late.
  { name: 'pause off', route: '/pause/off', usage: 'ba app pause off', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Check Now (the right-click menu): reads every Chat again for the list, now.
  { name: 'check now', route: '/check-now', usage: 'ba app check now', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Keep Drafting Today (the Menu bar panel): Agent Drafts go on past the daily budget until midnight.
  { name: 'release notes dismiss', route: '/release-notes/dismiss', usage: 'ba app release notes dismiss', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Dismiss on the Menu bar panel's once-only line after Setup about where the sidebar shows.
  { name: 'sidebar tip dismiss', route: '/sidebar-tip/dismiss', usage: 'ba app sidebar tip dismiss', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  { name: 'keep drafting', route: '/keep-drafting', usage: 'ba app keep drafting', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Settings → Background's Agent Drafts switch, also a row on Setup's last screen (ADR 0284). Off
  // only stops, so a late run and a drafts-only run may; on starts spending again.
  { name: 'agent drafts off', route: '/agent-drafts/off', usage: 'ba app agent drafts off', modes: both(NOT_READONLY), callers: OWNER, late: true, parse: none, check: empty, chats: () => [] },
  { name: 'agent drafts on', route: '/agent-drafts/on', usage: 'ba app agent drafts on', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Settings → This Mac's Open at Login switch, also on Setup's last screen. Only the copy in Applications has it.
  { name: 'open at login on', route: '/open-at-login/on', usage: 'ba app open at login on', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  { name: 'open at login off', route: '/open-at-login/off', usage: 'ba app open at login off', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Remove on Settings → Troubleshooting's skill row and Setup's last screen. It closes the app to the
  // Terminal (ADR 0110), so it is the last command a terminal runs until the Owner clicks Install.
  { name: 'skill remove', route: '/skill/remove', usage: 'ba app skill remove', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // The × on the first message of the sidebar's placed Reply (ADR 0130): the Reply becomes the Steps
  // it keeps, and Beeper's box the next message. It writes a Draft only, so a drafts-only run may.
  { name: 'reply choose', route: '/reply/choose', usage: 'ba app reply choose <chatID> <source> <replyID> <index>', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: rest => {
      if (rest.length !== 4 || !exactChatID(rest[0]) || !['options', 'draft', 'agent'].includes(rest[1]) || !/^\d+$/.test(rest[3])) throw Error('usage');
      return { chatID: rest[0], source: rest[1], id: rest[2], index: Number(rest[3]) };
    },
    check: b => keys(b, ['chatID', 'source', 'id', 'index']) && exactChatID(b.chatID) && ['options', 'draft', 'agent'].includes(b.source)
      && typeof b.id === 'string' && b.id.length > 0 && b.id.length <= 2048 && Number.isSafeInteger(b.index) && b.index >= 0,
    chats: b => [b.chatID] },
  { name: 'reply edit', route: '/reply/edit', usage: 'ba app reply edit <chatID> <source> <replyID> <index> <step> <shownText> <newText>', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: rest => {
      if (rest.length !== 7 || !exactChatID(rest[0]) || !['options', 'draft', 'agent'].includes(rest[1]) || !/^\d+$/.test(rest[3]) || !/^\d+$/.test(rest[4])) throw Error('usage');
      return { chatID: rest[0], source: rest[1], id: rest[2], index: Number(rest[3]), step: Number(rest[4]), before: rest[5], text: rest[6] };
    },
    check: b => keys(b, ['chatID', 'source', 'id', 'index', 'step', 'before', 'text']) && exactChatID(b.chatID) && ['options', 'draft', 'agent'].includes(b.source)
      && typeof b.id === 'string' && b.id.length > 0 && b.id.length <= 2048 && Number.isSafeInteger(b.index) && b.index >= 0 && Number.isSafeInteger(b.step) && b.step >= 0
      && typeof b.before === 'string' && b.before.length <= 20_000 && typeof b.text === 'string' && b.text.trim().length > 0 && b.text.length <= 20_000 && !b.text.includes('\0'),
    chats: b => [b.chatID] },
  { name: 'reply fill', route: '/reply/fill', usage: 'ba app reply fill <chatID> <replyID> <shownText> <answer>', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: rest => {
      if (rest.length !== 4 || !exactChatID(rest[0])) throw Error('usage');
      return { chatID: rest[0], id: rest[1], text: rest[2], answer: rest[3] };
    },
    check: b => keys(b, ['chatID', 'id', 'text', 'answer']) && exactChatID(b.chatID) && typeof b.id === 'string' && b.id.length > 0 && b.id.length <= 2048
      && typeof b.text === 'string' && b.text.length <= 20_000 && typeof b.answer === 'string' && b.answer.trim().length > 0 && b.answer.length <= 80,
    chats: b => [b.chatID] },
  { name: 'reply leave out first', route: '/reply/leave-out-first', usage: 'ba app reply leave out first <chatID>', modes: both(NOT_READONLY), callers: OWNER, late: false, parse: oneChat, check: chatBody, chats: (b) => [b.chatID] },
  // The wait before one later Step of a Reply on show (ADR 0275): <shown> is the wait the sidebar shows
  // now, and <wait> the one to set, each as seconds, "20s", or "2m", or pace for the Owner's own pace
  // again. It changes the Reply only, never Beeper's box, so a drafts-only run may.
  { name: 'reply wait', route: '/reply/wait', usage: 'ba app reply wait <chatID> <source> <replyID> <index> <step> <shown> <wait|pace>', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: rest => {
      if (rest.length !== 7 || !exactChatID(rest[0]) || !REPLY_SOURCES.includes(rest[1]) || !/^\d+$/.test(rest[3]) || !/^[1-9]\d*$/.test(rest[4])) throw Error('usage');
      const before = waitMsOf(rest[5]), ms = rest[6] === 'pace' ? null : waitMsOf(rest[6]);
      if (before === null || (rest[6] !== 'pace' && ms === null)) throw Error('usage');
      return { chatID: rest[0], source: rest[1], id: rest[2], index: Number(rest[3]), step: Number(rest[4]), before, ms };
    },
    check: b => keys(b, ['chatID', 'source', 'id', 'index', 'step', 'before', 'ms']) && exactChatID(b.chatID) && REPLY_SOURCES.includes(b.source)
      && typeof b.id === 'string' && b.id.length > 0 && b.id.length <= 2048 && Number.isSafeInteger(b.index) && b.index >= 0 && Number.isSafeInteger(b.step) && b.step >= 1
      && Number.isSafeInteger(b.before) && b.before >= 0 && (b.ms === null || (Number.isSafeInteger(b.ms) && b.ms > 0)),
    chats: b => [b.chatID] },
  // Settings' Waits between messages (ADR 0275): how later Steps wait now, and the choice of learned
  // from the Owner's changes or a fixed factor on their pace.
  { name: 'reply pace', route: '/reply/pace', usage: 'ba app reply pace', modes: both(ALL), callers: OWNER, late: true, read: true, parse: none, check: empty, chats: () => [] },
  { name: 'reply pace set', route: '/reply/pace/set', usage: `ba app reply pace set <${PACE_CHOICES.join('|')}>`, modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 1 || !PACE_CHOICES.includes(rest[0])) throw Error('usage'); return { choice: rest[0] }; },
    check: b => keys(b, ['choice']) && PACE_CHOICES.includes(b.choice), chats: () => [] },
  // Stop on a Reply that is sending (the sidebar): its waiting Steps are cancelled. Stopping only stops.
  // The rest of a Reply offered in one press, the sidebar's Send the rest: after their message
  // stopped it (ADR 0277), or after Enter sent only its first message (ADR 0130). `reply rest`
  // shows the offer and its ID; `reply rest send` presses it, for exactly that offer.
  { name: 'reply rest', route: '/reply/rest', usage: 'ba app reply rest <chatID>', modes: both(ALL), callers: OWNER, late: true, read: true, parse: oneChat, check: chatBody, chats: (b) => [b.chatID] },
  // --drop <n> leaves out the nth Step `reply rest` listed, from 1, and --text <n> <words> rewords
  // the nth when it is a message, as the sidebar's × and a click on its words do (rest-edits.ts).
  { name: 'reply rest send', route: '/reply/rest/send', usage: 'ba app reply rest send <chatID> <offerID> [--drop <n>]... [--text <n> <words>]... --confirmed', modes: both(FULL), callers: OWNER, late: false,
    parse: (rest) => {
      if (rest.length < 3 || !exactChatID(rest[0]) || !restOfferID(rest[1]) || rest.at(-1) !== '--confirmed') throw new Error('usage');
      const drop = [], texts = [];
      for (let i = 2; i < rest.length - 1;) {
        const at = /^[1-9]\d?$/.test(rest[i + 1] ?? '') ? Number(rest[i + 1]) - 1 : -1;
        if (rest[i] === '--drop' && at >= 0) { drop.push(at); i += 2; } else if (rest[i] === '--text' && at >= 0 && i + 2 < rest.length - 1) { texts.push({ at, text: rest[i + 2] }); i += 3; } else throw new Error('usage');
      }
      return { chatID: rest[0], id: rest[1], confirmed: true, ...(drop.length || texts.length ? { edits: { drop, texts } } : {}) };
    },
    check: (b) => keys(b, ['chatID', 'id', 'confirmed'], ['edits']) && exactChatID(b.chatID) && restOfferID(b.id) && b.confirmed === true && (b.edits === undefined || restChanges(b.edits)), chats: (b) => [b.chatID] },
  { name: 'reply stop', route: '/reply/stop', usage: 'ba app reply stop <chatID>', modes: both(NOT_READONLY), callers: OWNER, late: true, parse: oneChat, check: chatBody, chats: (b) => [b.chatID] },
  // A Chat's Wrapped (ADR 0290): what its slides say, as the share icon's preview reads it. It only reads.
  { name: 'wrapped', route: '/wrapped', usage: 'ba app wrapped <chatID>', modes: both(ALL), callers: OWNER, late: true, read: true, parse: oneChat, check: chatBody, chats: (b) => [b.chatID] },
  // Brief now (the sidebar): a Chat's Brief written now, or the saved one when it already read the
  // newest message. It writes nothing to Beeper, so a late run may; a read-only run spends nothing.
  // timeoutMs: a Brief is one agent call, which may run minutes.
  { name: 'brief', route: '/brief', usage: 'ba app brief <chatID>', modes: both(NOT_READONLY), callers: OWNER, late: true, timeoutMs: 10 * 60_000, parse: oneChat, check: chatBody, chats: (b) => [b.chatID] },
  // The sends that may have gone out and hold their Chats (ADR 0184), every Chat's or one Chat's.
  { name: 'sends', route: '/sends', usage: 'ba app sends [<chatID>]', modes: both(ALL), callers: OWNER, late: true, read: true,
    parse: (rest) => { if (rest.length > 1 || (rest.length && !exactChatID(rest[0]))) throw new Error('usage'); return rest.length ? { chatID: rest[0] } : {}; },
    check: (b) => keys(b, [], ['chatID']) && (b.chatID === undefined || exactChatID(b.chatID)), chats: (b) => b.chatID ? [b.chatID] : [] },
  // Settling one (ADR 0184): it went, on a message the agent read in the Chat (--message) or on the
  // Owner's word (--confirmed); it didn't, only on the Owner's explicit word (--didnt --confirmed).
  { name: 'send settle', route: '/send/settle', usage: 'ba app send settle <chatID> <sendID> (--went --message <messageID> | --went --confirmed | --didnt --confirmed)',
    modes: both(FULL), callers: OWNER, late: false,
    parse: (rest) => {
      const [chatID, id, ...flags] = rest;
      if (!exactChatID(chatID) || !sendID(id)) throw new Error('usage');
      const body = { chatID, sendID: Number(id) };
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        if ((f === '--went' || f === '--didnt') && body.went === undefined) body.went = f === '--went';
        else if (f === '--confirmed' && !body.confirmed) body.confirmed = true;
        else if (f === '--message' && body.messageID === undefined && messageID(flags[i + 1])) body.messageID = flags[++i];
        else throw new Error('usage');
      }
      if (body.went === undefined || (!body.messageID && !body.confirmed) || (body.went === false && (!body.confirmed || body.messageID))) throw new Error('usage');
      return body;
    },
    check: (b) => keys(b, ['chatID', 'sendID', 'went'], ['messageID', 'confirmed']) && exactChatID(b.chatID) && Number.isSafeInteger(b.sendID) && b.sendID > 0
      && typeof b.went === 'boolean' && (b.messageID === undefined || messageID(b.messageID)) && (b.confirmed === undefined || b.confirmed === true)
      && (b.messageID !== undefined || b.confirmed === true) && (b.went || (b.confirmed === true && b.messageID === undefined)),
    chats: (b) => [b.chatID] },
  // Diagnostics reads fixed operational states or performs the Owner's specific reporting choice.
  // Turning automatic reports off is allowed late; enabling or sending is full mode only.
  { name: 'diagnostics view', route: '/diagnostics/view', usage: 'ba app diagnostics view', modes: both(ALL), callers: OWNER, late: true, read: true,
    parse: none, check: empty, chats: () => [] },
  { name: 'diagnostics send', route: '/diagnostics/send', usage: 'ba app diagnostics send', modes: both(FULL), callers: OWNER, late: false, timeoutMs: 30_000,
    parse: none, check: empty, chats: () => [] },
  { name: 'diagnostics off', route: '/diagnostics/off', usage: 'ba app diagnostics off', modes: both(NOT_READONLY), callers: OWNER, late: true,
    parse: none, check: empty, chats: () => [] },
  { name: 'diagnostics on', route: '/diagnostics/on', usage: 'ba app diagnostics on', modes: both(FULL), callers: OWNER, late: false,
    parse: none, check: empty, chats: () => [] },
  // The Mind map tab's start, as Build my Mind map, Resume, and Try again do: the map on and its build
  // started now. The first build spends about 3M tokens of the agent's usage once (ADR 0061).
  { name: 'mind start', route: '/mind/start', usage: 'ba app mind start', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: none, check: empty, chats: () => [] },
  // The tab's rename, merge, and split of an Area (ADR 0280), naming each by its title as `ba mind` prints
  // it. parts lists what a split can move: the Area's Interests and its own topics, with claims on each.
  // A merge takes the first Area's lines and Interests into the second, and its name goes. undo puts back
  // the map from before the last of them, when nothing has changed it since.
  { name: 'mind parts', route: '/mind/parts', usage: "ba app mind parts '<Area>'", modes: both(ALL), callers: OWNER, late: true, read: true,
    parse: (rest) => { if (rest.length !== 1 || !mindName(rest[0])) throw new Error('usage'); return { area: rest[0] }; },
    check: (b) => keys(b, ['area']) && mindName(b.area), chats: () => [] },
  { name: 'mind rename', route: '/mind/rename', usage: "ba app mind rename '<Area>' '<new title>'", modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: mindTwo('area', 'title'), check: (b) => keys(b, ['area', 'title']) && mindName(b.area) && mindName(b.title), chats: () => [] },
  { name: 'mind merge', route: '/mind/merge', usage: "ba app mind merge '<Area>' '<into Area>'", modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: mindTwo('area', 'into'), check: (b) => keys(b, ['area', 'into']) && mindName(b.area) && mindName(b.into), chats: () => [] },
  { name: 'mind split', route: '/mind/split', usage: "ba app mind split '<Area>' '<new Area title>' [--interest '<Interest>']... [--topic '<topic>']...", modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: mindSplit, check: (b) => keys(b, ['area', 'title', 'interests', 'topics']) && mindName(b.area) && mindName(b.title) && mindNames(b.interests) && mindNames(b.topics)
      && b.interests.length + b.topics.length > 0, chats: () => [] },
  { name: 'mind undo', route: '/mind/undo', usage: 'ba app mind undo', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: none, check: empty, chats: () => [] },
  // A network's own data download into the Message Corpus (docs/plans/history-import.md), as the
  // LinkedIn history row in Settings does: how each stands, a download to bring in (its .zip, the
  // folder it unpacked to, or its messages file, by absolute path), or its history taken back out.
  { name: 'history view', route: '/history/view', usage: 'ba app history view', modes: both(ALL), callers: OWNER, late: false, read: true,
    parse: none, check: empty, chats: () => [] },
  { name: 'history import', route: '/history/import', usage: 'ba app history import <linkedin> <absolute path>', modes: both(NOT_READONLY), callers: OWNER, late: false, timeoutMs: 600_000,
    parse: (rest) => { if (rest.length !== 2 || !historyNetwork(rest[0]) || !absolutePath(rest[1])) throw new Error('usage'); return { network: rest[0], path: rest[1] }; },
    check: (b) => keys(b, ['network', 'path']) && historyNetwork(b.network) && absolutePath(b.path), chats: () => [] },
  { name: 'history remove', route: '/history/remove', usage: 'ba app history remove <linkedin> --confirmed', modes: both(NOT_READONLY), callers: OWNER, late: false, timeoutMs: 600_000,
    parse: (rest) => { if (rest.length !== 2 || !historyNetwork(rest[0]) || rest[1] !== '--confirmed') throw new Error('usage'); return { network: rest[0], confirmed: true }; },
    check: (b) => keys(b, ['network', 'confirmed']) && historyNetwork(b.network) && b.confirmed === true, chats: () => [] },
  { name: 'incident open', route: '/incident/open', usage: 'ba app incident open', modes: both(ALL), callers: OWNER, late: true,
    parse: none, check: empty, chats: () => [] },
  { name: 'incident list', route: '/incident/list', usage: 'ba app incident list', modes: both(ALL), callers: OWNER, late: true, read: true,
    parse: none, check: empty, chats: () => [] },
  { name: 'incident calls', route: '/incident/calls', usage: "ba app incident calls '<JSON query>'", modes: both(ALL), callers: OWNER, late: true, read: true,
    parse: rest => { if (rest.length !== 1) throw Error('usage'); const query = JSON.parse(rest[0]); if (!incidentQuery(query)) throw Error('usage'); return { query }; },
    check: body => keys(body, ['query']) && incidentQuery(body.query), chats: () => [] },
  { name: 'incident preview', route: '/incident/preview', usage: "ba app incident preview '<JSON selection>'", modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 1) throw Error('usage'); const selection = JSON.parse(rest[0]); if (!incidentSelection(selection)) throw Error('usage'); return { selection }; },
    check: body => keys(body, ['selection']) && incidentSelection(body.selection), chats: () => [] },
  ...['view', 'status', 'delete'].map(operation => ({ name: `incident ${operation}`, route: `/incident/${operation}`, usage: `ba app incident ${operation} <bundleID>`,
    modes: both(operation === 'delete' ? NOT_READONLY : ALL), callers: OWNER, late: operation !== 'delete', read: operation !== 'delete', timeoutMs: 45_000,
    parse: rest => { if (rest.length !== 1 || !incidentID(rest[0])) throw Error('usage'); return { id: rest[0] }; },
    check: body => keys(body, ['id']) && incidentID(body.id), chats: () => [] })),
  { name: 'incident share', route: '/incident/share', usage: 'ba app incident share <bundleID> <previewSHA256>', modes: both(FULL), callers: OWNER, late: false, timeoutMs: 150_000,
    parse: rest => { if (rest.length !== 2 || !incidentID(rest[0]) || !/^[0-9a-f]{64}$/.test(rest[1])) throw Error('usage'); return { id: rest[0], digest: rest[1] }; },
    check: body => keys(body, ['id', 'digest']) && incidentID(body.id) && typeof body.digest === 'string' && /^[0-9a-f]{64}$/.test(body.digest), chats: () => [] },
  { name: 'incident copy', route: '/incident/copy', usage: 'ba app incident copy <bundleID>', modes: both(NOT_READONLY), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 1 || !incidentID(rest[0])) throw Error('usage'); return { id: rest[0] }; },
    check: body => keys(body, ['id']) && incidentID(body.id), chats: () => [] },
  // Uninstall (Settings → Data): the app asks the Owner on the Mac, as its button does, and only
  // their click there removes anything. An agent can start it, never finish it.
  { name: 'uninstall', route: '/uninstall', usage: 'ba app uninstall', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Settings → Agent's Model and Effort rows (ADR 0271), for the Harness in use: the rows as the Owner
  // sees them, and a choice of what they offer. A choice can raise what every call costs, so only a
  // run in full mode makes one, never late.
  { name: 'model', route: '/model', usage: 'ba app model', modes: both(ALL), callers: OWNER, late: true, read: true, parse: none, check: empty, chats: () => [] },
  { name: 'model set', route: '/model/set', usage: 'ba app model set <pick|own|model>', modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 1 || !modelChoice(rest[0])) throw Error('usage'); return { model: rest[0] }; },
    check: b => keys(b, ['model']) && modelChoice(b.model), chats: () => [] },
  { name: 'effort set', route: '/effort/set', usage: `ba app effort set <${EFFORT_CHOICES.join('|')}>`, modes: both(FULL), callers: OWNER, late: false,
    parse: rest => { if (rest.length !== 1 || !EFFORT_CHOICES.includes(rest[0])) throw Error('usage'); return { effort: rest[0] }; },
    check: b => keys(b, ['effort']) && EFFORT_CHOICES.includes(b.effort), chats: () => [] },
];

// The action these words name, longest name first, with the words after it, or null.
export function actionFor(args) {
  for (const action of [...ACTIONS].sort((a, b) => b.name.split(' ').length - a.name.split(' ').length)) {
    const words = action.name.split(' ');
    if (words.every((w, i) => args[i] === w)) return { action, rest: args.slice(words.length) };
  }
  return null;
}
// The action at an app CLI route, as `METHOD /path`, or undefined.
export const actionAt = (route) => ACTIONS.find((a) => `POST ${a.route}` === route);
