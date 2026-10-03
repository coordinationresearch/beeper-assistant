#!/usr/bin/env node
// beeper-assistant: task-shaped commands over the official Beeper CLI.
// Reads are compact. Writes take exact chat references only and verify by reading back.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { BeeperError, SEARCH_MEDIA, apiOnce, asList, attachmentFile, listChats, listChatsSince, listMessages, listMessagesFast, participantsOf, runBeeper, searchChats, searchMessages, showChat } from './lib/beeper.mjs';
import { loadContacts, looksLikeEmail, looksLikePhone, normalizeEmail, normalizePhone, ownersOf, resetContacts, searchPeople } from './lib/contacts.mjs';
import { addContact } from './lib/contacts-write.mjs';
import { gapsIn } from './lib/gaps.mjs';
import { corpusMessage, decideSame, findPeople, mindMapPath, openCorpus, personProfile } from './lib/corpus.mjs';
import { HistoryError, chatStats, historyStatus, messagesAround, strangerRates } from './lib/history.mjs';
import { NotesError, addNote, deleteNote, listNotes } from './lib/notes.mjs';
import { collectTriage } from './lib/triage-run.mjs';
import { UNTRUSTED_NOTE, ago, mediaKind, networkName, plural, quote, renderChat, renderMedia, renderPending, renderSearch, renderTriage, renderWho } from './lib/render.mjs';
import { appendOutbox, chatAlias, dismiss, dropFromOutbox, isChatAlias, isMessageAlias, loadState, messageAlias, pruneDismissed, readOutbox, recordDraft, recordSkip, copyMedia, pruneMedia, rememberChats, rememberMessages, saveState, savedMessage, stateDir, undismiss } from './lib/state.mjs';
import { matchChat, outboxEntry, selectPending, stillCurrent, tidyDecision } from './lib/unattended.mjs';
import { DEFAULT_WINDOW_DAYS, applyContext, buildTriage, chatName, clip, counterparties, draftText, finalizeTriage, handlesOf, htmlToText, isGroup, previewKind, wantsHistory } from './lib/triage.mjs';

const DAY = 86_400_000;
const BOOL = new Set(['json', 'confirmed', 'replace', 'for-everyone', 'dismiss-on-message', 'help', 'all', 'dry-run']);
const MULTI = new Set(['to', 'from']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UsageError extends Error {}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let val;
    if (eq > 0) val = a.slice(eq + 1);
    else if (BOOL.has(key)) val = true;
    else {
      val = argv[++i];
      if (val === undefined) throw new UsageError(`--${key} needs a value`);
    }
    if (MULTI.has(key)) (flags[key] ||= []).push(val);
    else flags[key] = val;
  }
  return { pos, flags };
}

function textFrom(flags) {
  let t = flags.text;
  if (flags['text-file']) t = readFileSync(flags['text-file'], 'utf8');
  if (t === '-') t = readFileSync(0, 'utf8');
  if (typeof t !== 'string' || !t.trim()) throw new UsageError('Give the message with --text "…", --text - to read stdin, or --text-file <path>.');
  return t.replace(/\s+$/, '');
}

function needConfirmed(flags, what) {
  if (flags.confirmed) return;
  throw new UsageError(`Not done. ${what} needs the Owner's Confirmation. Show them the exact text and the chat name, get a yes, then run again with --confirmed.`);
}

const isTombstone = (text) => /\bunsent a message\b|\bmessage (was )?deleted\b|^\{\{sender\}\}/i.test(String(text || ''));
const looksLikeExactID = (s) => /^(!|imsg##)/.test(s) || /^\d+$/.test(s);

async function resolveChat(ref, state) {
  if (!ref) throw new UsageError('Give a chat reference such as c1a2b3c4d. Get one from triage or find.');
  let id = null;
  if (isChatAlias(ref)) {
    id = state.aliases[ref] && state.aliases[ref].id;
    if (!id) {
      const chats = await listChats({ limit: 1600, filtered: false });
      rememberChats(state, chats);
      saveState(state);
      id = state.aliases[ref] && state.aliases[ref].id;
    }
    if (!id) throw new UsageError(`No chat matches ${ref}. Run triage or find again to get a current reference.`);
  } else if (looksLikeExactID(ref)) {
    id = ref;
  } else {
    throw new UsageError(`"${ref}" is a name or title, not an exact reference. Run: find "${ref}"`);
  }
  const chat = await showChat(id);
  const exact = chat && (chat.id === id || String(chat.localChatID) === id);
  if (!exact) throw new BeeperError(`Beeper returned a different chat than the one asked for. Stopped. Asked ${id}, got ${chat && chat.id}.`);
  return chat;
}

async function resolveMessage(chat, ref) {
  if (!ref) throw new UsageError('Give a message reference such as m1a2b3c4d. The chat command prints them.');
  if (!isMessageAlias(ref)) return ref; // assume an exact message ID
  const msgs = await listMessages(chat.id, { limit: 100 });
  const hit = msgs.filter((m) => messageAlias(m.id) === ref);
  if (hit.length === 1) return hit[0].id;
  // An older message found by search, remembered with the chat it belongs to.
  const saved = savedMessage(loadState(), chat.id, ref);
  if (saved) return saved;
  throw new UsageError(`No message matches ${ref} in this chat. Get references from the chat or search command.`);
}

const label = (chat, contacts) => `${chatName(chat, contacts).name} · ${chat.network}${isGroup(chat) ? ' · group' : ''}`;

// ---------- read commands ----------

async function cmdCheck() {
  const lines = [];
  let ok = true;
  const fail = (what, ...fix) => { ok = false; lines.push(`FAIL  ${what}`); for (const f of fix) lines.push(`      ${f}`); };

  if (process.platform === 'darwin') lines.push('ok    Mac');
  else fail(`This is ${process.platform}. The skill needs a Mac.`);

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) lines.push(`ok    Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node} is too old`, 'Fix: brew install node');

  const app = ['/Applications/Beeper Desktop.app', `${homedir()}/Applications/Beeper Desktop.app`].some((p) => existsSync(p));
  if (app) lines.push('ok    Beeper Desktop is installed');
  else fail('Beeper Desktop is not installed', 'Fix: the person installs it from https://www.beeper.com, signs in, and connects their chat apps.');

  let cli = true;
  try { await runBeeper(['version'], { timeoutMs: 15_000 }); } catch (e) { if (e.detail && e.detail.code === 'NO_CLI') cli = false; }
  if (cli) lines.push('ok    Beeper command line tool is installed');
  else fail('Beeper command line tool is not installed', 'Fix: brew install beeper/tap/cli', 'No brew command? Install Homebrew first, from https://brew.sh');

  if (app && cli) {
    try {
      await listChats({ limit: 1, filtered: false });
      lines.push('ok    Beeper answers');
    } catch (e) {
      fail(`Beeper does not answer: ${e.message}`, 'Fix: open Beeper Desktop and sign in, then run: beeper setup', 'If setup asks a question, the person answers it in their own terminal.');
    }
  } else {
    lines.push('      Beeper connection not tested yet, since something above is missing.');
  }

  const c = await loadContacts();
  if (c.available) lines.push(`ok    Contacts readable (${plural(c.people.size, 'person', 'people')})`);
  else lines.push('warn  Contacts not readable, so iMessage chats will show phone numbers. The skill works without it.', '      Optional fix: give the app your agent runs in Full Disk Access, in System Settings, Privacy & Security.');
  for (const h of await historyStatus()) lines.push(h.ok ? `ok    ${h.text}` : `warn  ${h.text}`);

  try { saveState(loadState()); lines.push(`ok    State folder ${stateDir()}`); } catch (e) { fail(`Cannot write state in ${stateDir()}: ${e.message}`); }

  const mode = currentMode();
  lines.push(`ok    Mode: ${mode === 'full' ? 'full. It can save drafts and mark read, and it sends only after a yes' : mode === 'drafts' ? 'drafts only. It can read and save drafts' : 'read only. It changes nothing'}`);
  console.log(lines.join('\n'));
  if (!ok) process.exitCode = 1;
}

// Shows the mode, or tightens it. Loosening is left to the person, on purpose.
async function cmdMode({ pos }) {
  const file = `${stateDir()}/mode`;
  const want = String(pos[0] || '').toLowerCase();
  const now = currentMode();
  const pinned = (() => { try { return readFileSync(file, 'utf8').trim().toLowerCase() || null; } catch { return null; } })();
  if (!want) {
    console.log(`Mode: ${now}.${pinned ? ` The file ${file} says ${pinned}.` : ' No mode file is set.'}`);
    return;
  }
  if (!(want in RANK)) throw new UsageError('Usage: mode [readonly | drafts]');
  if (RANK[want] > RANK[pinned || 'full'] || (want === 'full')) {
    throw new UsageError(`Not changed. This command only makes the mode stricter. To loosen it, the person edits or deletes ${file} themselves.`);
  }
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file, `${want}\n`);
  console.log(`Mode is now ${want}, for every agent on this Mac. To loosen it later, the person edits or deletes ${file} themselves.`);
}

async function cmdTriage({ flags }) {
  const windowDays = Number(flags.days || DEFAULT_WINDOW_DAYS);
  if (!(windowDays > 0)) throw new UsageError('--days must be a positive number');
  const now = Date.now();
  const state = loadState();
  const t = await collectTriage({
    chatsSince: async (cutoff) => {
      const got = await listChatsSince(cutoff);
      pruneDismissed(state, got.chats);
      rememberChats(state, got.chats);
      saveState(state);
      return got;
    },
    contacts: loadContacts,
    state: () => state,
    messages: (id, limit) => listMessagesFast(id, { limit }),
    history: (chats) => chatStats(chats, { now }),
    strangers: () => strangerRates({ now }),
  }, { now, windowDays, includeAutomated: flags.all === true, maxPeople: Number(flags.max || 100), maxGroups: Number(flags['max-groups'] || 10) });
  console.log(flags.json ? JSON.stringify(t, null, 1) : renderTriage(t));
}

async function cmdChat({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const limit = Number(flags.limit || 20);
  if (!(limit >= 1 && limit <= 200)) throw new UsageError('--limit must be between 1 and 200');
  let around = null;
  let messages;
  if (flags.around) {
    around = await resolveMessage(chat, flags.around);
    // Beeper confirms the message is in this chat. The history files only supply its neighbours.
    const target = await runBeeper(['messages', 'show', '--chat', chat.id, '--id', around]);
    if (!target || String(target.id) !== String(around)) throw new BeeperError(`Beeper returned a different message than the one asked for. Stopped. Asked ${around}, got ${target && target.id}.`);
    const before = Math.floor(limit / 2);
    try { messages = await messagesAround(chat, around, { before, after: limit - before - 1 }); } catch (e) {
      if (e instanceof HistoryError) throw new BeeperError(`Could not show older messages. ${e.message}`);
      throw e;
    }
    rememberMessages(state, messages);
    saveState(state);
  } else {
    messages = await listMessages(chat.id, { limit });
  }
  const contacts = await loadContacts();
  if (flags.json) {
    console.log(JSON.stringify({ chat: { ref: chatAlias(chat.id), id: chat.id, name: chatName(chat, contacts).name, network: chat.network, type: chat.type, unreadCount: chat.unreadCount, draft: chat.draft, reminder: chat.reminder }, around: around ? messageAlias(around) : undefined, messages: messages.map((m) => ({ ref: messageAlias(m.id), id: m.id, from: m.isSender ? 'me' : 'them', sender: m.senderName, at: m.timestamp, text: htmlToText(m.text).replace(/\{\{\s*sender\s*\}\}/g, m.isSender ? 'I' : (m.senderName || 'They')), hidden: m.isHidden === true, replyTo: m.linkedMessageID || null })) }, null, 1));
    return;
  }
  console.log(renderChat(chat, messages, { contacts, around }));
}

function matchesTokens(text, tokens) {
  const words = String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => words.some((w) => w.startsWith(t)));
}

async function cmdFind({ pos, flags }) {
  const q = pos.join(' ').trim();
  if (!q) throw new UsageError('Usage: find <name, number, or email>');
  const tokens = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const contacts = await loadContacts();
  const people = looksLikePhone(q) ? [] : searchPeople(contacts, q);
  const phones = new Set(people.flatMap((p) => p.phones));
  const emails = new Set(people.flatMap((p) => p.emails));
  if (looksLikePhone(q)) phones.add(normalizePhone(q));
  if (q.includes('@')) emails.add(normalizeEmail(q));

  const pools = [listChats({ limit: 800, filtered: false }), searchChats(q, { limit: 30 }).catch(() => [])];
  for (const n of [...phones].slice(0, 6)) pools.push(searchChats(n, { limit: 10 }).catch(() => []));
  const seen = new Map();
  for (const list of await Promise.all(pools)) for (const c of list) if (c && c.id && !seen.has(c.id)) seen.set(c.id, c);

  const hits = [];
  for (const c of seen.values()) {
    const cps = counterparties(c);
    const byHandle = cps.some((p) => (p.phoneNumber && phones.has(normalizePhone(p.phoneNumber))) || (p.email && emails.has(normalizeEmail(p.email))));
    const byName = isGroup(c)
      ? matchesTokens(c.title, tokens)
      : matchesTokens(c.title, tokens) || cps.some((p) => matchesTokens(p.fullName, tokens) || matchesTokens(p.username, tokens));
    if (!byHandle && !byName) continue;
    if (isGroup(c) && byHandle && !byName && !flags.all) continue; // groups they are merely in
    let owner = null;
    if (byHandle) {
      const mine = cps.flatMap((p) => [p.phoneNumber && normalizePhone(p.phoneNumber), p.email && normalizeEmail(p.email)]).filter(Boolean);
      owner = people.filter((p) => mine.some((h) => p.phones.includes(h) || p.emails.includes(h))).map((p) => p.name);
    }
    hits.push({ chat: c, why: byHandle ? 'contact handle' : 'name', owner });
  }
  hits.sort((a, b) => (Date.parse(b.chat.lastActivity) || 0) - (Date.parse(a.chat.lastActivity) || 0));
  const state = loadState();
  rememberChats(state, hits.map((h) => h.chat));
  saveState(state);

  const now = Date.now();
  const shown = (h) => {
    const n = chatName(h.chat, contacts);
    if (n.resolved || !h.owner || !h.owner.length) return n.name;
    return `${h.owner.join(' or ')} (number shared by ${h.owner.length > 1 ? 'these contacts' : 'this contact'})`;
  };
  const rows = hits.map((h) => ({ ref: chatAlias(h.chat.id), id: h.chat.id, name: shown(h), network: h.chat.network, type: isGroup(h.chat) ? 'group' : 'single', lastActivity: h.chat.lastActivity, matchedBy: h.why }));
  if (flags.json) { console.log(JSON.stringify({ query: q, contacts: people.map((p) => p.name), chats: rows }, null, 1)); return; }
  const out = [`FIND ${quote(q)} · ${rows.length} chat${rows.length === 1 ? '' : 's'}`];
  if (people.length) out.push(`Contacts matching: ${people.slice(0, 8).map((p) => p.name).join(', ')}${people.length > 8 ? ` +${people.length - 8}` : ''}`);
  else if (!contacts.available) out.push('Contacts could not be read, so matching used chat titles only.');
  for (const r of rows.slice(0, 40)) out.push(`${r.ref}  ${r.name} · ${r.network} · ${r.type} · last ${ago(now - (Date.parse(r.lastActivity) || 0))} · matched by ${r.matchedBy}`);
  if (!rows.length) out.push('No chat found. The person may have no chat yet, or their chat is older than the last 800.');
  // Groups carry their own names, so only one-to-one chats say whether several people match.
  if (people.length > 1 || new Set(rows.filter((r) => r.type === 'single').map((r) => r.name)).size > 1) out.push('More than one person matches. Ask the Owner which one. Never pick for them.');
  if (!flags.all) out.push('Groups a person only belongs to are hidden. Add --all to include them.');
  console.log(out.join('\n'));
}

// One person across every network, with stats, from the Beeper Companion's corpus. Without
// a corpus on this Mac it falls back to find, which reads live.
async function cmdWho({ pos, flags }) {
  const q = pos.join(' ').trim();
  if (!q) throw new UsageError('Usage: who <name, number, email, or person id>');
  const corpus = await openCorpus();
  if (!corpus.ok) {
    console.error(`No stats: ${corpus.reason}. Showing live chats instead. Stats need the Beeper Companion's corpus.`);
    return cmdFind({ pos, flags });
  }
  const people = await findPeople(corpus.file, q);
  if (!people.length) {
    console.error('Nobody in the corpus matches. Showing live chats instead, in case the chat is newer than the corpus.');
    return cmdFind({ pos, flags });
  }
  const now = Date.now();
  if (people.length > 1) {
    const rows = people.map((p) => ({ id: p.person_id, name: p.display_name, messages: p.messages, networks: JSON.parse(p.networks || '[]') }));
    if (flags.json) { console.log(JSON.stringify({ query: q, people: rows }, null, 1)); return; }
    const out = [`WHO ${quote(q)} · ${rows.length} people`];
    for (const r of rows) out.push(`${r.id}  ${r.name || '(no name)'} · ${r.networks.map(networkName).join(', ') || 'no chats'} · ${plural(r.messages, 'message')}`);
    out.push('More than one person matches. Ask the Owner which one. Never pick for them. Then run who with their id.');
    console.log(out.join('\n'));
    return;
  }
  // The corpus may rebuild between the lookup and the profile. Look again once.
  let p = await personProfile(corpus.file, people[0].person_id);
  if (!p) {
    const again = await findPeople(corpus.file, q);
    p = again.length === 1 ? await personProfile(corpus.file, again[0].person_id) : null;
  }
  if (!p) throw new UsageError('The corpus changed while reading it. Run who again.');
  const ids = p.chats.map((c) => c.beeper_chat_id || (c.chat_key.startsWith('imessage:') ? null : c.chat_key)).filter(Boolean);
  const state = loadState();
  rememberChats(state, ids.map((id) => ({ id })));
  saveState(state);
  if (flags.json) {
    console.log(JSON.stringify({ ...p, chats: p.chats.map((c) => ({ ...c, ref: c.beeper_chat_id || !c.chat_key.startsWith('imessage:') ? chatAlias(c.beeper_chat_id || c.chat_key) : null })), builtAt: corpus.builtAt }, null, 1));
    return;
  }
  console.log(renderWho(p, { now, builtAt: corpus.builtAt, chatRef: chatAlias }));
}

// The Owner's Mind map, as the Beeper Companion wrote it: Areas of their life and claims drawn
// from their own messages, each with the Corpus key of its message. --receipt <key> reads one.
async function cmdMind({ flags }) {
  if (flags.receipt) {
    const corpus = await openCorpus();
    if (!corpus.ok) throw new UsageError(`Can't read a receipt: ${corpus.reason}.`);
    const m = await corpusMessage(corpus.file, String(flags.receipt));
    if (!m || m.retracted) throw new UsageError('The corpus no longer has that message. It was deleted or edited since. Leave that claim out.');
    const where = m.kind === 'group' ? `the group ${quote(m.title || 'with no name')}` : `a chat with ${m.counterparty || m.title || 'someone'}`;
    const at = m.sent_at ? new Date(m.sent_at).toISOString().slice(0, 16).replace('T', ' ') : 'an unknown time';
    const ref = m.beeper_chat_id || (m.chat_key.startsWith('imessage:') ? null : m.chat_key);
    // So `chat <ref>` opens it next, as after who.
    if (ref) { const state = loadState(); rememberChats(state, [{ id: ref }]); saveState(state); }
    if (flags.json) { console.log(JSON.stringify({ key: m.message_key, fromOwner: Boolean(m.from_owner), at: m.sent_at, network: m.network, where, chat: ref ? chatAlias(ref) : null, text: m.text }, null, 1)); return; }
    console.log([`${m.from_owner ? 'The Owner' : 'Someone else'} wrote this in ${where} on ${networkName(m.network)}, ${at}${ref ? ` · chat ${chatAlias(ref)}` : ''}:`, UNTRUSTED_NOTE, quote(m.text || '(no text)')].join('\n'));
    return;
  }
  const path = mindMapPath();
  if (!existsSync(path)) throw new UsageError('There is no Mind map on this Mac yet. The Beeper Companion builds one once its corpus has read the Owner\'s messages.');
  const text = readFileSync(path, 'utf8');
  if (flags.json) { console.log(JSON.stringify({ path, text }, null, 1)); return; }
  console.log(`Mind map: ${path}\n\n${text}`);
}

// The Owner's answer about whether two People from who are one person. Only on the Owner's
// own words, so it needs --confirmed, and never in an Unattended run.
async function cmdSameOrDifferent(decision, { pos, flags }) {
  if (pos.length !== 2 || !pos.every((id) => /^p_[0-9a-f]+$/.test(id))) throw new UsageError(`Usage: ${decision} <person id> <person id> --confirmed, with ids from who`);
  if (!flags.confirmed) throw new UsageError(`Not done. Only the Owner can say whether these are ${decision === 'same' ? 'the same person' : 'different people'}. Ask them, then run again with --confirmed.`);
  const corpus = await openCorpus();
  if (!corpus.ok) throw new UsageError(`No corpus to record this in: ${corpus.reason}.`);
  const r = await decideSame(corpus.file, pos[0], pos[1], decision);
  if (!r.ok) throw new UsageError(r.reason);
  console.log(`Recorded: ${decision === 'same' ? 'the same person' : 'different people'}. It takes effect when the corpus next rebuilds, within about 15 minutes.`);
}

async function cmdSearch({ pos, flags }) {
  const query = pos.join(' ').trim();
  const media = flags.media ? String(flags.media).toLowerCase().split(',').map((x) => x.trim()).filter(Boolean) : [];
  for (const m of media) if (!SEARCH_MEDIA.includes(m)) throw new UsageError(`--media takes ${SEARCH_MEDIA.join(', ')}. Join several with commas.`);
  const from = flags.from ? String(flags.from).toLowerCase() : null;
  if (from && from !== 'me' && from !== 'them') throw new UsageError('--from takes me or them');
  const days = flags.days === undefined ? 0 : Number(flags.days);
  if (flags.days !== undefined && !(days > 0)) throw new UsageError('--days must be a positive number');
  const max = flags.max === undefined ? 20 : Number(flags.max);
  if (!(max >= 1 && max <= 100)) throw new UsageError('--max must be between 1 and 100');
  if (!query && !media.length) throw new UsageError('Usage: search <words> [--chat <chat>] [--from me|them] [--media image,video,file,link,any] [--days N] [--max 20]. Give words, or --media.');

  const state = loadState();
  const chat = flags.chat ? await resolveChat(flags.chat, state) : null;
  const sinceMs = days ? Date.now() - days * DAY : 0;
  const found = await searchMessages({ query, chatID: chat && chat.id, sender: from === 'them' ? 'others' : from, media }, { max, sinceMs, keep: (m) => !m.isHidden && previewKind(m) !== 'reaction' });
  rememberChats(state, Object.values(found.chats));
  rememberMessages(state, found.items);
  saveState(state);
  const contacts = await loadContacts();

  if (flags.json) {
    const byChat = new Map();
    for (const m of found.items) {
      const c = found.chats[m.chatID] || { id: m.chatID };
      if (!byChat.has(m.chatID)) byChat.set(m.chatID, { ref: chatAlias(m.chatID), id: m.chatID, name: chatName(c, contacts).name, network: c.network || null, type: c.type || null, messages: [] });
      byChat.get(m.chatID).messages.push({ ref: messageAlias(m.id), id: m.id, from: m.isSender ? 'me' : 'them', sender: m.senderName, at: m.timestamp, text: htmlToText(m.text), attachments: (m.attachments || []).map(mediaKind) });
    }
    console.log(JSON.stringify({ query, more: found.more, chats: [...byChat.values()] }, null, 1));
    return;
  }
  const filters = [chat && `in ${label(chat, contacts)}`, from && `from ${from}`, media.length && `with ${media.join(' or ')}`, days && `last ${plural(days, 'day')}`].filter(Boolean);
  console.log(renderSearch({ query, ...found }, { contacts, filters, max }));
}

async function cmdMedia({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const id = await resolveMessage(chat, pos[1]);
  const msg = await runBeeper(['messages', 'show', '--chat', chat.id, '--id', id]);
  if (!msg || String(msg.id) !== String(id) || (msg.chatID && String(msg.chatID) !== String(chat.id))) throw new BeeperError(`Beeper returned a different message than the one asked for. Stopped. Asked ${id}, got ${msg && msg.id}.`);
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (!atts.length) { console.log(`Message ${messageAlias(id)} has no attachments.`); return; }
  // One at a time. Each download is a single request, and a failure is reported, never retried.
  pruneMedia();
  const files = [];
  for (const [i, a] of atts.entries()) {
    const got = await attachmentFile(a);
    // Video and audio stay where Beeper keeps them. Nothing here can watch or hear them.
    if (got.path && !['video', 'audio', 'voice note'].includes(mediaKind(a))) {
      try { got.path = copyMedia(got.path, a, `${messageAlias(id)}-${i + 1}`); } catch (e) { got.note = `could not copy it out of Beeper (${e.message}), so this is Beeper's own copy`; }
    }
    files.push({ attachment: a, ...got });
  }
  const contacts = await loadContacts();
  if (flags.json) {
    console.log(JSON.stringify({ chat: chatAlias(chat.id), message: messageAlias(id), files: files.map((f) => ({ kind: mediaKind(f.attachment), fileName: f.attachment.fileName || null, mimeType: f.attachment.mimeType || null, bytes: f.attachment.fileSize || null, transcript: (f.attachment.transcription && f.attachment.transcription.transcription) || null, path: f.path || null, error: f.error || null })) }, null, 1));
    return;
  }
  console.log(renderMedia(chat, msg, files, { contacts }));
  if (files.every((f) => !f.path)) process.exitCode = 1;
}

async function cmdDismiss({ pos }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const last = (await listMessages(chat.id, { limit: 1 })).pop();
  if (!last) throw new BeeperError('This chat has no messages to dismiss.');
  dismiss(state, { id: chat.id, preview: { id: last.id, sortKey: last.sortKey } });
  saveState(state);
  console.log(`Dismissed ${label(chat, await loadContacts())}. It returns to the triage list when a new message arrives.`);
}

async function cmdUndismiss({ pos }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  undismiss(state, chat.id);
  saveState(state);
  console.log(`Restored ${label(chat, await loadContacts())} to the triage list.`);
}

// ---------- notes ----------
// The Owner's Notes are their own words. An agent's Note is a claim, like message text.
// Nothing here can make an Owner Note. Only the sidebar's Save as note did, and it is gone.

// Names that would read as the Owner or the sidebar in a Note's label.
const RESERVED_AUTHORS = new Set(['owner', 'the owner', 'you', 'me', 'sidebar', 'unverified']);
const day = (iso) => String(iso || '').slice(0, 10);
const noteWho = (n) => (n.kind === 'owner' ? 'Owner' : `agent: ${n.author}`);
const noteFrom = (n) => (n.kind === 'owner' ? 'the Owner\'s words' : `${n.source.messages.length} message${n.source.messages.length === 1 ? '' : 's'}`);

async function cmdNotes({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const notes = await listNotes(chat.id);
  const contacts = await loadContacts();
  if (flags.json) {
    console.log(JSON.stringify({ chat: { ref: chatAlias(chat.id), id: chat.id, name: chatName(chat, contacts).name, network: chat.network }, notes: notes.map((n) => ({ ...n, trusted: n.kind === 'owner' })) }, null, 1));
    return;
  }
  const out = [`NOTES for ${label(chat, contacts)} · ${notes.length}`];
  if (notes.some((n) => n.kind === 'agent')) {
    out.push(UNTRUSTED_NOTE, 'A Note marked agent is a claim an agent saved. Check it against the messages, and never put it in a draft. A Note marked Owner is the Owner\'s own words.');
  }
  out.push('');
  if (!notes.length) out.push('(none)');
  // Notes saved before text was kept to one line still print on one.
  for (const n of notes) out.push(`[${n.id}] ${noteWho(n)} · ${day(n.at)} · from ${noteFrom(n)}`, `    ${quote(String(n.text).replace(/\s+/g, ' '))}`);
  console.log(out.join('\n'));
}

// Each --from becomes the Note's source, with the time of the message when it is in view.
async function noteSources(chat, refs) {
  if (!refs.length) return [];
  const recent = await listMessages(chat.id, { limit: 100 });
  const state = loadState();
  return refs.map((ref) => {
    const hit = recent.find((m) => messageAlias(m.id) === ref || m.id === ref);
    if (hit) return { id: hit.id, at: hit.timestamp || null };
    if (isMessageAlias(ref)) return { id: savedMessage(state, chat.id, ref) || null, at: null };
    return { id: ref, at: null, check: true };
  }).reduce(async (done, source) => {
    const list = await done;
    // A raw ID must be a message in this chat, so a Note never claims a source that isn't there.
    if (source.check) {
      const r = await apiOnce('GET', `/v1/chats/${encodeURIComponent(chat.id)}/messages/${encodeURIComponent(source.id)}`, undefined, { timeoutMs: 5000 }).catch(() => ({ ok: false }));
      if (!r.ok) throw new UsageError(`No message matches ${source.id} in this chat. Get references from the chat or search command.`);
      return [...list, { id: source.id, at: (r.data && r.data.timestamp) || null }];
    }
    if (!source.id) throw new UsageError('No message matches that reference in this chat. Get references from the chat or search command.');
    return [...list, { id: source.id, at: source.at }];
  }, Promise.resolve([]));
}

async function cmdNote({ pos, flags }) {
  if (flags.delete !== undefined) {
    if (currentMode() !== 'full') throw new UsageError(`${currentMode() === 'drafts' ? 'Drafts-only' : 'Read-only'} mode is on, so the Note was not deleted. Only the Owner deletes Notes, in the sidebar or by asking an attended agent.`);
    const state = loadState();
    const chat = await resolveChat(pos[0], state);
    const r = await deleteNote(chat.id, String(flags.delete));
    if (r.status === 'missing') throw new UsageError(`No Note ${flags.delete} in this chat. Run notes to see the list.`);
    console.log(`Deleted Note ${r.note.id} from ${label(chat, await loadContacts())}. Agents will not save the same text, or a Note from the same messages, again.`);
    return;
  }
  // Cleaned the way notes.mjs cleans it, so a control character can't smuggle in a reserved name.
  const by = String(flags.by || 'agent').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!by || RESERVED_AUTHORS.has(by.toLowerCase())) throw new UsageError(`--by ${by || '(empty)'} is reserved. Give your own agent name, such as claude or hermes.`);
  const text = textFrom(flags);
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const sources = await noteSources(chat, flags.from || []);
  const r = await addNote(chat.id, { text, kind: 'agent', author: by, source: { messages: sources } });
  const where = label(chat, await loadContacts());
  if (r.status === 'duplicate') { console.log(`That Note is already saved in ${where}, as ${r.note.id}. Nothing changed.`); return; }
  if (r.status === 'tombstoned') throw new UsageError(`Not saved. The Owner deleted a Note with this text, or from these messages, in ${where}. It stays deleted.`);
  if (r.status === 'rate-limited') throw new UsageError(`Not saved. Agents already saved 3 Notes in ${where} in the last 30 minutes. Keep only what matters most, and try later.`);
  if (r.status === 'full') throw new UsageError(`Not saved. ${where} holds 30 Notes, all the Owner's.`);
  console.log(`Note ${r.note.id} saved in ${where}, as a claim by ${r.note.author}, citing ${noteFrom(r.note)}. Nothing was sent.`);
}

// ---------- write commands ----------

const newestRealOf = (messages) => messages.filter((m) => !m.isHidden && !isTombstone(m.text)).pop() || null;
const syncsAcrossDevices = (chat) => !String(chat.id).startsWith('imsg##');
const sameText = (a, b) => String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();

async function cmdDraft({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const text = textFrom(flags);
  const contacts = await loadContacts();
  const unattended = currentMode() === 'drafts';
  if (unattended && !flags.for) throw new UsageError('Give --for <message>, the "answers" reference printed by pending. It ties the draft to the message it replies to.');
  let newest = null;
  if (flags.for) {
    newest = newestRealOf(await listMessagesFast(chat.id, { limit: 20 }));
    if (!newest || newest.isSender) throw new UsageError(`Not drafted. In ${label(chat, contacts)} the Owner spoke last, so nothing is waiting.`);
    if (messageAlias(newest.id) !== flags.for && newest.id !== flags.for) throw new UsageError(`Not drafted. ${label(chat, contacts)} has a newer message, ${messageAlias(newest.id)}. Read it again before writing.`);
  }
  const existing = draftText(chat);
  if (existing && sameText(existing, text)) { console.log(`That exact draft is already saved in ${label(chat, contacts)}. Nothing changed.`); return; }
  if (existing && unattended) throw new UsageError(`Not drafted. ${label(chat, contacts)} already holds a draft, which may be the Owner's own. An unattended run never replaces one.`);
  if (existing && !flags.replace) {
    throw new UsageError(`This chat already holds a draft: ${quote(clip(existing, 200))}. It may be the Owner's own. Ask before replacing it, then run again with --replace.`);
  }
  if (flags['dry-run']) { console.log(`Dry run. Would save a draft of ${plural(text.length, 'character')} in ${label(chat, contacts)}.`); return; }
  if (existing) await runBeeper(['chats', 'draft', '--chat', chat.id, '--clear'], { write: true });
  await runBeeper(['chats', 'draft', '--chat', chat.id, '--text', text], { write: true });
  const after = await showChat(chat.id);
  const saved = draftText(after);
  if (!sameText(saved, text)) throw new BeeperError(`Draft did not save as written. Beeper now holds: ${saved ? quote(clip(saved, 200)) : 'no draft'}. Give the Owner the text to paste.`);
  recordDraft(state, chat.id, { forMessage: newest ? newest.id : null, text });
  saveState(state);
  let where = 'The Owner can review and send it in Beeper.';
  if (unattended && !syncsAcrossDevices(chat) && !isGroup(chat)) {
    appendOutbox(outboxEntry(chat, { text, newest, name: chatName(chat, contacts).name }));
    where = 'iMessage drafts stay on the machine that saved them, so it is also queued for the Owner\'s other Mac.';
  }
  const open = gapsIn(text).length;
  console.log(`Draft saved in ${label(chat, contacts)}. Nothing was sent. ${where}${open ? ` It holds ${open} blank${open > 1 ? 's' : ''} for the Owner to fill.` : ''}`);
}

// ---------- unattended runs ----------

async function gatherRows({ flags, state, contacts }) {
  const windowDays = Number(flags.days || DEFAULT_WINDOW_DAYS);
  const now = Date.now();
  const { chats } = await listChatsSince(now - windowDays * DAY);
  rememberChats(state, chats);
  const t = buildTriage(chats, { now, windowDays, state, contacts, finalize: false });
  const queue = t.people.slice(0, 150);
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try { r.context = await listMessagesFast(r.id, { limit: 20 }); applyContext(r, r.context, { now }); } catch { /* keep the preview */ }
    }
  }));
  finalizeTriage(t, { maxPeople: 1000, maxGroups: 0 });
  return t;
}

async function cmdPending({ flags }) {
  const state = loadState();
  const contacts = await loadContacts();
  const t = await gatherRows({ flags, state, contacts });
  saveState(state);
  const p = selectPending(t.people, { state, max: Number(flags.max || 5) });
  if (flags.json) {
    console.log(JSON.stringify({ waiting: p.waiting, counts: p.counts, batch: p.batch.map((r) => ({ ref: r.ref, id: r.id, name: r.name, network: r.network, ageMs: r.ageMs, pinned: r.pinned, answers: messageAlias(r.newestID), messages: (r.context || []).filter((m) => !m.isHidden).slice(-10).map((m) => ({ from: m.isSender ? 'me' : 'them', at: m.timestamp, text: htmlToText(m.text) })) })) }, null, 1));
    return;
  }
  console.log(renderPending(p));
}

async function cmdSkip({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  if (!flags.for) throw new UsageError('Usage: skip <chat> --for <message> [--reason "…"]');
  const newest = newestRealOf(await listMessagesFast(chat.id, { limit: 20 }));
  const forID = newest && (messageAlias(newest.id) === flags.for || newest.id === flags.for) ? newest.id : null;
  if (!forID) throw new UsageError(`Not recorded. The newest message in ${label(chat, await loadContacts())} is not ${flags.for}. Read the chat again.`);
  recordSkip(state, chat.id, { forMessage: forID, reason: flags.reason || '' });
  saveState(state);
  console.log(`Skipped ${label(chat, await loadContacts())} until a new message arrives. The Owner still sees it in triage.`);
}

// Clears drafts this skill saved that no longer fit. Never touches a draft the Owner edited.
async function cmdTidy({ flags }) {
  const state = loadState();
  const contacts = await loadContacts();
  const tally = { clear: 0, forget: 0, keep: 0, gone: 0 };
  for (const [chatID, record] of Object.entries(state.drafted)) {
    let chat;
    try { chat = await showChat(chatID); } catch { if (!flags['dry-run']) delete state.drafted[chatID]; tally.gone++; continue; }
    const newestReal = newestRealOf(await listMessagesFast(chatID, { limit: 20 }).catch(() => []));
    const what = tidyDecision({ record, draftNow: draftText(chat), newestReal });
    tally[what]++;
    if (what === 'keep') continue;
    if (what === 'clear' && !flags['dry-run']) {
      await runBeeper(['chats', 'draft', '--chat', chatID, '--clear'], { write: true });
      console.log(`Cleared a stale draft in ${label(chat, contacts)}.`);
    }
    if (!flags['dry-run']) { delete state.drafted[chatID]; dropFromOutbox(outboxEntry(chat, { text: '', newest: null }).chatKey); }
  }
  if (!flags['dry-run']) saveState(state);
  console.log(`${flags['dry-run'] ? 'Dry run. ' : ''}Drafts from earlier runs: ${tally.keep} still waiting · ${tally.clear} stale${flags['dry-run'] ? '' : ' and cleared'} · ${tally.forget} sent, removed, or edited by the Owner${tally.gone ? ` · ${tally.gone} in chats that no longer exist` : ''}`);
}

// Prints queued drafts, one JSON object per line, for another machine to place.
async function cmdOutbox() {
  for (const e of readOutbox()) console.log(JSON.stringify(e));
}

// Reads queued drafts from stdin and saves each in the matching chat on this machine.
async function cmdPlace({ flags }) {
  const lines = readFileSync(0, 'utf8').split('\n').filter((l) => l.trim());
  const state = loadState();
  const contacts = await loadContacts();
  const chats = lines.length ? await listChats({ limit: 1600, filtered: false }) : [];
  const tally = { placed: 0, already: 0, stale: 0, unmatched: 0, busy: 0, bad: 0 };
  const done = (id) => { if (!flags['dry-run']) state.placed[id] = new Date().toISOString(); };
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { tally.bad++; continue; }
    if (!e || !e.id || typeof e.text !== 'string' || !e.text.trim()) { tally.bad++; continue; }
    if (state.placed[e.id]) { tally.already++; continue; }
    const { chat: hit, why } = matchChat(e, chats);
    if (!hit) { tally.unmatched++; console.log(`Not placed, ${why}: ${e.network}.`); continue; }
    const chat = await showChat(hit.id);
    const newestReal = newestRealOf(await listMessagesFast(chat.id, { limit: 20 }).catch(() => []));
    const cur = stillCurrent(e, newestReal);
    if (!cur.ok) { tally.stale++; done(e.id); console.log(`Not placed in ${label(chat, contacts)}, ${cur.why}.`); continue; }
    const existing = draftText(chat);
    if (existing && sameText(existing, e.text)) { tally.already++; done(e.id); continue; }
    if (existing) { tally.busy++; console.log(`Not placed in ${label(chat, contacts)}, it already holds a draft.`); continue; }
    if (flags['dry-run']) { tally.placed++; console.log(`Dry run. Would place a draft in ${label(chat, contacts)}.`); continue; }
    await runBeeper(['chats', 'draft', '--chat', chat.id, '--text', e.text], { write: true });
    const saved = draftText(await showChat(chat.id));
    if (!sameText(saved, e.text)) { tally.bad++; console.log(`Draft did not save in ${label(chat, contacts)}.`); continue; }
    recordDraft(state, chat.id, { forMessage: newestReal ? newestReal.id : null, text: e.text });
    done(e.id);
    tally.placed++;
    console.log(`Draft placed in ${label(chat, contacts)}.`);
  }
  for (const [id, at] of Object.entries(state.placed)) if (Date.now() - Date.parse(at) > 7 * DAY) delete state.placed[id];
  if (!flags['dry-run']) saveState(state);
  console.log(`${flags['dry-run'] ? 'Dry run. ' : ''}Queue of ${lines.length}: ${tally.placed} placed · ${tally.already} placed earlier · ${tally.stale} out of date · ${tally.busy} blocked by an existing draft · ${tally.unmatched} with no matching chat${tally.bad ? ` · ${tally.bad} unreadable` : ''}`);
}

async function verifyOutgoing(chat, text, beforeIDs) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const msgs = await listMessages(chat.id, { limit: 12 });
    const hit = msgs.filter((m) => m.isSender && !beforeIDs.has(m.id) && (norm(m.text) === norm(text) || norm(htmlToText(m.text)) === norm(text)));
    if (hit.length) return hit;
    await sleep(1500);
  }
  return [];
}

async function cmdSend({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const text = textFrom(flags);
  const contacts = await loadContacts();
  const gaps = gapsIn(text);
  if (gaps.length) throw new UsageError(`Not sent. The text still holds ${gaps.length === 1 ? 'a blank' : `${gaps.length} blanks`}, marked with an underscore. Ask the Owner what goes there, then send the finished text.`);
  needConfirmed(flags, `Sending to ${label(chat, contacts)}`);
  if (chat.isReadOnly) throw new BeeperError('This chat is read-only. Nothing was sent.');
  const recent = await listMessages(chat.id, { limit: 12 });
  const newest = recent.filter((m) => !m.isHidden).pop();
  // The chat must still look the way it did when the reply was written.
  const after = flags.after;
  if (!after) throw new UsageError('Give --after <message>, the "newest message" reference printed by the chat command. It proves the chat was read before writing. Use --after none for a chat with no messages.');
  if (after === 'none' ? !!newest : !newest || (messageAlias(newest.id) !== after && newest.id !== after)) {
    throw new UsageError(`Not sent. ${label(chat, contacts)} has changed since it was read${newest ? `: the newest message is now ${messageAlias(newest.id)}, from ${newest.isSender ? 'the Owner' : 'them'}` : ''}. Read the chat again, check the reply still fits, and ask the Owner again if the text changes.`);
  }
  const before = new Set(recent.map((m) => m.id));
  const body = { text };
  if (flags['reply-to']) body.replyToMessageID = await resolveMessage(chat, flags['reply-to']);
  const res = await apiOnce('POST', `/v1/chats/${encodeURIComponent(chat.id)}/messages`, body);
  const failure = res.ok ? null : new BeeperError(res.error);
  const found = await verifyOutgoing(chat, text, before);
  if (found.length === 1) {
    console.log(`Sent to ${label(chat, contacts)}. The message is in the chat as ${messageAlias(found[0].id)}. Delivery is not confirmed.`);
    if (failure) console.log(`Note: Beeper reported an error (${failure.message}) but the message is in the chat. Do not send it again.`);
  } else if (found.length > 1) {
    console.log(`WARNING: the message appears ${found.length} times in ${label(chat, contacts)}. Tell the Owner. Do not send again.`);
    process.exitCode = 1;
  } else {
    console.log(`NOT VERIFIED for ${label(chat, contacts)}. ${failure ? `Beeper said: ${failure.message}.` : 'Beeper accepted the request.'} The message is not visible in the chat yet. Do not retry. Ask the Owner to look in Beeper first.`);
    process.exitCode = 1;
  }
}

async function cmdRead({ pos }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  await runBeeper(['chats', 'mark-read', '--chat', chat.id], { write: true });
  const after = await showChat(chat.id);
  const clear = !(after.unreadCount > 0) && !after.isMarkedUnread;
  console.log(clear ? `Marked read: ${label(chat, await loadContacts())}.` : `Beeper still shows ${after.unreadCount} unread in ${label(chat, await loadContacts())}. It may take a moment to sync.`);
  if (!clear) process.exitCode = 1;
}

async function cmdReact({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const reaction = pos[2];
  if (!reaction) throw new UsageError('Usage: react <chat> <message> <emoji> --confirmed');
  needConfirmed(flags, `Reacting in ${label(chat, await loadContacts())}`);
  const id = await resolveMessage(chat, pos[1]);
  await runBeeper(['send', 'react', '--to', chat.id, '--id', id, '--reaction', reaction], { write: true });
  console.log(`Reacted ${reaction} to ${messageAlias(id)} in ${label(chat, await loadContacts())}.`);
}

async function cmdRemind({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const when = new Date(flags.when || '');
  if (Number.isNaN(when.getTime())) throw new UsageError('Give --when as a full timestamp with zone, such as 2026-10-01T09:00:00-07:00');
  if (when.getTime() < Date.now()) throw new UsageError('--when is in the past.');
  const args = ['chats', 'remind', '--chat', chat.id, '--when', when.toISOString()];
  if (flags['dismiss-on-message']) args.push('--dismiss-on-message');
  await runBeeper(args, { write: true });
  const after = await showChat(chat.id);
  console.log(`${after.reminder ? 'Reminder set' : 'Reminder requested, not yet visible,'} for ${label(chat, await loadContacts())} at ${when.toLocaleString()}.`);
}

async function cmdUnremind({ pos }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  await runBeeper(['chats', 'unremind', '--chat', chat.id], { write: true });
  console.log(`Reminder cleared for ${label(chat, await loadContacts())}.`);
}

async function cmdEdit({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const text = textFrom(flags);
  needConfirmed(flags, `Editing a message in ${label(chat, await loadContacts())}`);
  const id = await resolveMessage(chat, pos[1]);
  await runBeeper(['messages', 'edit', '--chat', chat.id, '--id', id, '--message', text], { write: true });
  console.log(`Edited ${messageAlias(id)} in ${label(chat, await loadContacts())}. Some networks show the edit history to the other person.`);
}

async function cmdDelete({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  needConfirmed(flags, `Deleting a message in ${label(chat, await loadContacts())}`);
  const id = await resolveMessage(chat, pos[1]);
  const args = ['messages', 'delete', '--chat', chat.id, '--id', id];
  if (flags['for-everyone']) args.push('--for-everyone');
  let failure = null;
  try { await runBeeper(args, { write: true }); } catch (e) { failure = e; }
  await sleep(1500);
  const left = (await listMessages(chat.id, { limit: 100 })).find((m) => m.id === id);
  const name = label(chat, await loadContacts());
  // An unsent message stays in the list as a placeholder with its text replaced.
  if (!left) console.log(`Deleted ${messageAlias(id)} in ${name}${flags['for-everyone'] ? ' for everyone' : ' on this side only'}.`);
  else if (isTombstone(left.text)) console.log(`Unsent ${messageAlias(id)} in ${name}. The other side sees that a message was unsent.`);
  else {
    console.log(`Not deleted. ${messageAlias(id)} in ${name} is unchanged.${failure ? ` Beeper said: ${failure.message}.` : ''} Networks set their own limits. iMessage only unsends for about two minutes after sending.${flags['for-everyone'] ? '' : ' Deleting on this side only is not supported everywhere.'}`);
    process.exitCode = 1;
  }
}

// Name the unnamed. The handle comes from the exact chat, never from typed input.
async function cmdContact({ pos, flags }) {
  const state = loadState();
  const chat = await resolveChat(pos[0], state);
  const first = String(flags.first || '').trim();
  const last = String(flags.last || '').trim();
  if (!first) throw new UsageError('Usage: contact <chat> --first "Given" [--last "Family"] [--handle <number or email of a group member>] --confirmed');
  const cps = counterparties(chat);
  let target = null;
  if (flags.handle) {
    const want = looksLikeEmail(flags.handle) ? normalizeEmail(flags.handle) : normalizePhone(flags.handle);
    target = cps.find((p) => (p.phoneNumber && normalizePhone(p.phoneNumber) === want) || (p.email && normalizeEmail(p.email) === want));
    if (!target) throw new UsageError('That handle does not belong to anyone in this chat. Nothing was created.');
  } else {
    if (isGroup(chat)) throw new UsageError('This is a group. Say which member with --handle, using a number or email shown in the chat.');
    target = cps[0];
  }
  const handle = flags.handle ? (target.phoneNumber || target.email) : (handlesOf(chat)[0] || null);
  if (!handle) throw new UsageError(`This chat is on ${chat.network}, which gives no phone number or email. Contacts can only be created for numbers and emails.`);
  const kind = looksLikeEmail(handle) ? 'email' : 'phone';
  let contacts = await loadContacts();
  const owners = ownersOf(contacts, handle);
  if (owners.length) throw new UsageError(`${handle} already belongs to ${owners.join(' and ')} in Contacts. Nothing was created.`);
  const full = [first, last].filter(Boolean).join(' ');
  needConfirmed(flags, `Creating the contact "${full}" for ${handle}`);
  const id = await addContact({ first, last, handle, kind });
  let seen = [];
  for (let i = 0; i < 6 && !seen.length; i++) {
    await sleep(1000);
    resetContacts();
    contacts = await loadContacts();
    seen = ownersOf(contacts, handle);
  }
  if (seen.includes(full)) console.log(`Contact created: ${full} · ${handle}. The chat will show this name from now on. Contact id ${id}`);
  else console.log(`Contacts accepted "${full}" for ${handle} (id ${id}) but the lookup does not show it yet. It can take a minute to appear.`);
}

const memberKey = (m) => m.phoneNumber || m.email || m.id;

// New group from the people in existing one-to-one chats. Members are chosen by exact reference.
// The first message is never sent inside the create call. It goes through send, once.
async function cmdGroup({ flags }) {
  const refs = flags.from || [];
  if (refs.length < 2) throw new UsageError('Usage: group --from <chat> --from <chat> [--title "…"] [--text "first message"] --confirmed');
  const state = loadState();
  const contacts = await loadContacts();
  const sources = [];
  for (const r of refs) sources.push(await resolveChat(r, state));
  const bad = sources.find((c) => isGroup(c));
  if (bad) throw new UsageError(`${label(bad, contacts)} is a group. Build a group from one-to-one chats only.`);
  const accounts = new Set(sources.map((c) => c.accountID));
  if (accounts.size !== 1) throw new UsageError(`Those chats are on different networks (${sources.map((c) => c.network).join(', ')}). A group needs everyone on one network.`);
  const members = sources.map((c) => counterparties(c)[0]).filter(Boolean);
  if (new Set(members.map(memberKey)).size !== members.length) throw new UsageError('The same person was given twice.');
  const names = sources.map((c) => chatName(c, contacts).name);
  const text = flags.text !== undefined || flags['text-file'] ? textFrom(flags) : null;
  needConfirmed(flags, `Creating ${/^[aeiou]/i.test(sources[0].network) ? 'an' : 'a'} ${sources[0].network} group with ${names.join(', ')}`);

  const sameMembers = (c) => {
    const others = counterparties(c);
    return isGroup(c) && others.length === members.length && members.every((m) => others.some((p) => p.id === m.id || (m.phoneNumber && p.phoneNumber && normalizePhone(p.phoneNumber) === normalizePhone(m.phoneNumber)) || (m.email && p.email && normalizeEmail(p.email) === normalizeEmail(m.email))));
  };
  const findGroup = async () => (await listChats({ limit: 300, filtered: false })).find((c) => c.accountID === sources[0].accountID && sameMembers(c));

  let chat = await findGroup();
  const existed = !!chat;
  let failure = null;
  if (!chat) {
    const body = { accountID: sources[0].accountID, type: 'group', participantIDs: members.map(memberKey) };
    if (flags.title) body.title = flags.title;
    const res = await apiOnce('POST', '/v1/chats', body, { timeoutMs: 90_000 });
    if (!res.ok) failure = res.error;
    // Creation can succeed while reporting an error, so look before saying anything.
    for (let i = 0; i < 4 && !chat; i++) { await sleep(2000); chat = await findGroup(); }
  }
  if (!chat) {
    console.log(`NOT VERIFIED. ${failure ? `Beeper said: ${failure}.` : 'Beeper accepted the request.'} No group with exactly those members is visible. Do not retry. Ask the Owner to look in Beeper first.${text ? ' Some networks only create a group once a first message is sent, and that was not attempted.' : ''}`);
    process.exitCode = 1;
    return;
  }
  chat = await showChat(chat.id);
  rememberChats(state, [chat]);
  saveState(state);
  console.log(`${existed ? 'A group with exactly those members already exists' : 'Group created'}: ${chatName(chat, contacts).name} · ${chat.network} · ${plural(participantsOf(chat).length, 'member')} · ref ${chatAlias(chat.id)}`);
  if (failure) console.log(`Note: Beeper reported an error (${failure}) but the group exists. Do not create it again.`);
  if (flags.title && String(chat.title || '').trim() !== String(flags.title).trim()) {
    try {
      await runBeeper(['chats', 'rename', '--chat', chat.id, '--title', flags.title], { write: true });
      await sleep(1500);
      const renamed = await showChat(chat.id);
      console.log(String(renamed.title || '').trim() === String(flags.title).trim() ? `Named it "${flags.title}".` : `Asked to name it "${flags.title}". Beeper still shows "${chatName(renamed, contacts).name}".`);
    } catch (e) { console.log(`Could not set the name: ${e.message}`); }
  }
  const msgs = await listMessages(chat.id, { limit: 5 }).catch(() => []);
  if (!existed && msgs.length) console.log(`It already holds ${msgs.length} message${msgs.length > 1 ? 's' : ''}. Read the chat before sending, since some networks insert a placeholder.`);
  if (text) {
    if (existed) { console.log('The first message was not sent, because the group already existed. Read it, then use send.'); return; }
    const newest = msgs.filter((m) => !m.isHidden).pop();
    await cmdSend({ pos: [chat.id], flags: { text, confirmed: true, after: newest ? messageAlias(newest.id) : 'none' } });
  }
}

// Open or reuse a one-to-one chat with someone who has no chat yet.
async function cmdStart({ flags }) {
  const to = (flags.to || [])[0];
  if (!to || (flags.to || []).length !== 1) throw new UsageError('Usage: start --to <number, email, or user ID> --account <account> --confirmed. For several people use group.');
  if (!flags.account) throw new UsageError('Give --account. Run: beeper accounts --json');
  needConfirmed(flags, `Starting a chat with ${to} on ${flags.account}`);
  const beforeIDs = new Set((await listChats({ limit: 50, filtered: false })).map((c) => c.id));
  let failure = null;
  let data = null;
  try { data = await runBeeper(['chats', 'start', to, '--account', flags.account], { write: true, timeoutMs: 90_000 }); } catch (e) { failure = e; }
  await new Promise((r) => setTimeout(r, 1500));
  const id = data && (data.id || data.chatID || (data.chat && data.chat.id));
  const chat = (id && await showChat(id).catch(() => null)) || (await listChats({ limit: 50, filtered: false })).find((c) => !beforeIDs.has(c.id) && !isGroup(c));
  if (!chat) {
    console.log(`NOT VERIFIED. ${failure ? `The CLI said: ${failure.message}.` : 'No chat came back.'} Do not retry. Search with find, then ask the Owner to look in Beeper.`);
    process.exitCode = 1;
    return;
  }
  const state = loadState();
  rememberChats(state, [chat]);
  saveState(state);
  console.log(`Chat ready: ${label(chat, await loadContacts())} · ref ${chatAlias(chat.id)}. Nothing was sent.`);
  if (failure) console.log(`Note: the CLI reported an error (${failure.message}) but the chat exists.`);
}

const HELP = `beeper-assistant

Read
  check                               verify the setup, and print the fix for anything missing
  mode [readonly | drafts]            show the mode, or make it stricter
  triage [--days 14] [--max 100]      chats that want the Owner's attention. Add --all to keep automated senders
  chat <chat> [--limit 20]            recent messages in one chat
  chat <chat> --around <message>      older messages around one, such as a search hit
  find <name | number | email>        every chat for a person. Add --all for groups they are in
  who <name | number | email>         one person on every network, with message counts, reply times, and
                                      who starts conversations. Needs the Beeper Companion's corpus; without it, runs find
  mind [--receipt <key>]              the Owner's Mind map: Areas of their life and claims from their own messages.
                                      --receipt reads the message a claim cites. Needs the Beeper Companion
  search <words> [--chat <chat>] [--from me|them] [--media image] [--days N] [--max 20]
                                      messages that contain these words, across all chats
  media <chat> <message>              put a message's photos and files on this Mac, and print where

Triage state
  dismiss <chat>                      hide from triage until a new message arrives
  undismiss <chat>

Notes
  notes <chat>                        what the Owner and agents saved about this chat
  note <chat> --text "…" [--from <message>]... [--by <your name>]
                                      save something worth remembering, as an agent's claim
  note <chat> --delete <note>         delete a Note. Full mode only

Write, no Confirmation needed
  draft <chat> --text "…" [--replace] save a reply in Beeper's compose box
  read <chat>                         mark as read
  remind <chat> --when <timestamp> [--dismiss-on-message]
  unremind <chat>

Runs with no person in the turn
  pending [--max 5]                   chats to draft for, each with its recent messages
  draft <chat> --text "…" --for <message>   save a draft tied to the message it answers
  skip <chat> --for <message>         leave a chat alone until a new message arrives
  tidy                                clear drafts from earlier runs that no longer fit
  outbox                              print queued drafts for another machine
  place                               read queued drafts from stdin and save them here

Write, needs --confirmed after the Owner says yes
  same <person> <person>              record the Owner's word that two people from who are one person
  different <person> <person>         or that they are different people
  send <chat> --text "…" --after <message> [--reply-to <message>]
  contact <chat> --first "…" [--last "…"]     add the chat's number to the Mac's Contacts under a name
  react <chat> <message> <emoji>
  edit <chat> <message> --text "…"
  delete <chat> <message> [--for-everyone]
  group --from <chat> --from <chat> [--title "…"] [--text "…"]
  start --to <handle> --account <account>

<chat> is a reference like c1a2b3c4d from triage or find, or an exact Beeper chat ID.
<message> is a reference like m1a2b3c4d from the chat command.
Names and titles are never accepted as <chat>. Add --json to triage, chat, find, who, mind, search, media, pending, and notes.
--text - reads the message from stdin.
Set BEEPER_ASSISTANT_MODE=drafts to allow reading and drafts only, or readonly to allow reading only.
A file named mode in the state folder does the same, and the stricter of the two wins.`;

// What may run in each mode. This guards against mistakes. It is not a wall: an agent with a
// shell can change its own environment, or call Beeper without this script.
//   full      everything, with Confirmation where the skill asks for it
//   drafts    for runs with no person in the turn: read, save drafts, and save Notes. Nothing anyone else can see
//   readonly  read only
const ALLOWED = {
  readonly: new Set(['check', 'mode', 'triage', 'chat', 'find', 'who', 'mind', 'search', 'media', 'pending', 'outbox', 'dismiss', 'undismiss', 'notes']),
  drafts: new Set(['check', 'mode', 'triage', 'chat', 'find', 'who', 'mind', 'search', 'media', 'pending', 'outbox', 'draft', 'skip', 'tidy', 'place', 'notes', 'note']),
};
const RANK = { readonly: 0, drafts: 1, full: 2 };
function modeFromEnv() {
  if (['1', 'true', 'yes'].includes(String(process.env.BEEPER_ASSISTANT_READONLY || '').toLowerCase())) return 'readonly';
  const m = String(process.env.BEEPER_ASSISTANT_MODE || '').trim().toLowerCase();
  if (!m) return 'full';
  if (!(m in RANK)) throw new UsageError(`BEEPER_ASSISTANT_MODE is "${m}". Use full, drafts, or readonly.`);
  return m;
}
// The Owner can also pin a mode in a file. A machine that only ever runs unattended gets one.
function modeFromFile() {
  let m = '';
  try { m = readFileSync(`${stateDir()}/mode`, 'utf8').trim().toLowerCase(); } catch { return 'full'; }
  if (!m) return 'full';
  if (!(m in RANK)) throw new UsageError(`The mode file in ${stateDir()} says "${m}". Use full, drafts, or readonly.`);
  return m;
}
// The stricter of the two wins, so neither one can loosen the other.
function currentMode() {
  const e = modeFromEnv();
  const f = modeFromFile();
  return RANK[e] <= RANK[f] ? e : f;
}

const COMMANDS = { check: cmdCheck, triage: cmdTriage, chat: cmdChat, find: cmdFind, who: cmdWho, mind: cmdMind, same: (a) => cmdSameOrDifferent('same', a), different: (a) => cmdSameOrDifferent('different', a), search: cmdSearch, media: cmdMedia, dismiss: cmdDismiss, undismiss: cmdUndismiss, draft: cmdDraft, send: cmdSend, read: cmdRead, react: cmdReact, remind: cmdRemind, unremind: cmdUnremind, edit: cmdEdit, delete: cmdDelete, group: cmdGroup, start: cmdStart, contact: cmdContact, pending: cmdPending, skip: cmdSkip, tidy: cmdTidy, outbox: cmdOutbox, place: cmdPlace, mode: cmdMode, notes: cmdNotes, note: cmdNote };

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === 'help' || name === '--help' || name === '-h') { console.log(HELP); return; }
  const fn = COMMANDS[name];
  if (!fn) throw new UsageError(`Unknown command "${name}". Run with help to see the list.`);
  const args = parseArgs(rest);
  if (args.flags.help) { console.log(HELP); return; }
  const mode = currentMode();
  if (mode === 'readonly' && !ALLOWED.readonly.has(name)) {
    throw new UsageError(`Read-only mode is on, so "${name}" did not run and nothing changed. Tell the Owner. Only they can loosen the mode.`);
  }
  if (mode === 'drafts' && !ALLOWED.drafts.has(name)) {
    throw new UsageError(`Drafts-only mode is on, so "${name}" did not run and nothing changed. This run may read and save drafts. Anything else waits for the Owner.`);
  }
  await fn(args);
}

main().catch((e) => {
  const kind = e instanceof UsageError ? 'usage' : e instanceof BeeperError ? 'beeper' : e instanceof NotesError ? 'notes' : 'error';
  console.error(`${kind}: ${e.message}`);
  if (kind === 'error' && process.env.BA_DEBUG) console.error(e.stack);
  process.exitCode = kind === 'usage' ? 2 : 1;
});

export { UNTRUSTED_NOTE, asList };
