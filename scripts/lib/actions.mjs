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

export const ACTIONS = [
  // Pause Background Work (the menu bar's right-click menu, Settings): stops what spends tokens on its
  // own. Stopping only stops, so a late run and a drafts-only run may.
  { name: 'pause', route: '/pause', usage: 'ba app pause', modes: both(NOT_READONLY), callers: OWNER, late: true, parse: none, check: empty, chats: () => [] },
  // Turning it back on starts spending again: only a run in full mode, never late.
  { name: 'pause off', route: '/pause/off', usage: 'ba app pause off', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Check Now (the right-click menu): reads every Chat again for the list, now.
  { name: 'check now', route: '/check-now', usage: 'ba app check now', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Keep Drafting Today (the Menu bar panel): Agent Drafts go on past the daily budget until midnight.
  { name: 'keep drafting', route: '/keep-drafting', usage: 'ba app keep drafting', modes: both(FULL), callers: OWNER, late: false, parse: none, check: empty, chats: () => [] },
  // Stop on a Reply that is sending (the sidebar): its waiting Steps are cancelled. Stopping only stops.
  { name: 'reply stop', route: '/reply/stop', usage: 'ba app reply stop <chatID>', modes: both(NOT_READONLY), callers: OWNER, late: true, parse: oneChat, check: chatBody, chats: (b) => [b.chatID] },
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
