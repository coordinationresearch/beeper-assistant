// Synthetic CLI replay. Every dependency is replaced; no account, database, or native app opens.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { gapsIn } from '../scripts/lib/gaps.mjs';
import { FIRST_MESSAGE_IN_CREATE, memberKey } from '../scripts/lib/groups.mjs';

process.env.TZ = 'UTC'; // The VM-enabled direct test invocation uses the same captured timezone.
const source = readFileSync(new URL('../scripts/ba.mjs', import.meta.url), 'utf8');
const cases = {
  mode: ['readonly'], dismiss: ['!one'], undismiss: ['!one'], same: ['p_a', 'p_b'], different: ['p_a', 'p_b'],
  note: ['!one', '--text', 'Synthetic reply'], draft: ['!one', '--text', 'Synthetic reply'],
  suggest: ['!one', '--text', 'Synthetic reply', '--agent', 'Test', '--after', 'msg-1'],
  send: ['!one', '--text', 'Synthetic reply', '--after', 'msg-1'], read: ['!one'], react: ['!one', 'msg-1', '👍'],
  remind: ['!one', '--when', '2099-01-01T12:00:00Z'], unremind: ['!one'], edit: ['!one', 'msg-1', '--text', 'Synthetic reply'],
  delete: ['!one', 'msg-1'], contact: ['!one', '--first', 'Test'], group: ['--from', '!one', '--from', '!two'],
  start: ['--to', '+15550102030', '--account', 'test'],
};
const confirmed = new Set(['same', 'different', 'send', 'react', 'edit', 'delete', 'contact', 'group', 'start']);
const previews = new Set(['draft', 'suggest']);
const booleans = ['json', 'confirmed', 'replace', 'for-everyone', 'dismiss-on-message', 'help', 'all', 'dry-run'];

async function replay(argv, { alias = false, text = source, existing = '', line = [], env = {}, app = null, network = 'WhatsApp', failCreate = false, older = [], more = [] } = {}) {
  const mutations = [], stdout = [], stderr = [];
  const state = { aliases: {}, drafted: {}, dismissed: {} };
  const chat = (id) => ({ id, title: 'Test Chat', network, accountID: 'test', type: id === '!group' ? 'group' : 'single', draft: draft, participants: [{ id, phoneNumber: '+15550102030' }] });
  let draft = existing, created = false, contact = false;
  let messages = [{ id: 'msg-1', text: 'Synthetic question', isSender: false }, ...more];
  const mutate = (name, result) => (...args) => { mutations.push([name, args]); return result; };
  const mocks = {
    BeeperError: class extends Error {}, NotesError: class extends Error {}, HistoryError: class extends Error {}, PlaybookError: class extends Error {},
    readFileSync: () => { throw Error('absent'); },
    existsSync: () => false, mkdirSync: mutate('mkdir'), writeFileSync: mutate('file'), homedir: () => '/synthetic',
    stateDir: () => '/synthetic', loadState: () => state, saveState: mutate('state'), isLineChat: (id) => line.includes(id),
    loadContacts: () => ({}), resetContacts: () => {}, chatName: () => ({ name: 'Test Chat' }),
    isChatAlias: (id) => id === 'c00000000', isMessageAlias: () => false, chatAlias: () => 'c00000000', messageAlias: (id) => `ref-${id}`,
    rememberChats: (s, chats) => { s.aliases.c00000000 = { id: chats[0].id }; },
    showChat: async (id) => chat(id), listChats: () => [...['!one', '!two', ...(created ? ['!group'] : [])].map(chat)],
    listMessages: async () => [...messages], listMessagesFast: async () => [...messages], draftText: (c) => c.draft,
    isGroup: (c) => c.type === 'group', counterparties: (c) => c.id === '!group' ? [{ id: '!one' }, { id: '!two' }] : [{ id: c.id }],
    participantsOf: () => [{}, {}, {}], handlesOf: () => ['+15550102030'], looksLikeEmail: () => false,
    ownersOf: () => contact ? ['Test'] : [], addContact: () => { contact = true; return mutate('contact', 'contact-1')(); },
    // older: the Messages database's iMessage groups, or 'unreadable'.
    iMessageGroupMembers: async () => { if (older === 'unreadable') throw new mocks.HistoryError('The Messages database could not be read.'); return older; }, normalizePhone: (s) => s, normalizeEmail: (s) => s,
    // The shared group rules (lib/groups.mjs), over this test's own participants, whose IDs no phone
    // number or email normalizes.
    FIRST_MESSAGE_IN_CREATE, memberKey,
    olderIMessageGroup: async (handles, read) => (await read()).some((g) => g.length === handles.length && handles.every((h) => g.includes(h))),
    holdsExactly: (c, members) => mocks.isGroup(c) && mocks.counterparties(c).length === members.length && members.every((m) => mocks.counterparties(c).some((p) => p.id === m.id)),
    gapsIn, clip: (s) => s, plural: (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`, quote: (s) => `«${s}»`, htmlToText: (s) => s,
    openCorpus: () => ({ ok: true, file: '/synthetic' }), decideSame: mutate('identity', { ok: true }),
    addNote: mutate('note', { status: 'saved', note: { id: 'n00000000', author: 'agent', source: { messages: [] } } }),
    deleteNote: mutate('deleteNote', { status: 'deleted', note: { id: 'n00000000' } }),
    agentLabel: () => 'Test', replyProblem: () => null, writeSuggestion: mutate('suggestion'),
    dismiss: mutate('dismiss'), undismiss: mutate('undismiss'), recordDraft: mutate('recordDraft'),
    runBeeper: (args, opts) => {
      if (opts?.write) mutations.push(['cli', args]);
      if (args[1] === 'draft') draft = args.includes('--clear') ? '' : args[args.indexOf('--text') + 1];
      if (args[1] === 'delete') messages = [];
      return { id: '!new' };
    },
    apiOnce: (method, path, body) => {
      if (method !== 'GET') mutations.push(['api', { method, path, body }]);
      // failCreate: Beeper errors at once and makes nothing, as iMessage did on 2026-10-11 without a first message.
      if (path === '/v1/chats' && failCreate) return { ok: false, error: 'Failed to execute tool: createChat' };
      if (path === '/v1/chats') { created = true; if (body.messageText) messages.push({ id: 'sent-1', text: body.messageText, isSender: true }); }
      else messages.push({ id: 'sent-1', text: body.text, isSender: true });
      return { ok: true };
    },
  };
  const proc = { argv: ['node', 'ba', ...argv], env, exitCode: 0 };
  const Clock = class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-10T00:00:00.000Z'])); } static now() { return Date.parse('2026-10-10T00:00:00.000Z'); } };
  const context = vm.createContext({ Date: Clock, process: proc, console: { log: (s) => stdout.push(`${s}\n`), error: (s) => stderr.push(`${s}\n`) }, setTimeout: (fn) => fn() });
  // ./lib/app.mjs, which send, react, draft, and group import: the test's own. With none given, the
  // Terminal finds no Companion on this Mac, so they write as the skill always has (ADR 0110), and
  // group finds none that takes Intros (ADR 0096).
  const companion = app ?? { terminalRoute: async () => ({ standalone: true }), introRoute: async () => ({ direct: true }) };
  const importModuleDynamically = async (specifier) => {
    if (specifier !== './lib/app.mjs') throw Error(`Unexpected dynamic import ${specifier}`);
    const names = Object.keys(companion);
    const m = new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, companion[name]); }, { context });
    await m.link(() => {}); await m.evaluate();
    return m;
  };
  const module = new vm.SourceTextModule(text, { context, importModuleDynamically });
  await module.link((specifier) => {
    const names = text.match(new RegExp(`import \\{([^}]+)\\} from '${specifier.replaceAll('.', '\\.')}';`))[1].split(',').map((s) => s.trim());
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, mocks[name] ?? (() => { throw Error(`Unexpected dependency ${name}`); }));
    }, { context });
  });
  if (alias) proc.argv = proc.argv.map((a) => a === '!one' ? 'c00000000' : a);
  await module.evaluate(); await module.namespace.finished;
  return JSON.parse(JSON.stringify({ status: proc.exitCode, stdout: stdout.join(''), stderr: stderr.join(''), mutations }));
}

if (!vm.SourceTextModule) {
  test('write flags and output parity in an isolated module runtime', () => {
    const env = { ...process.env, TZ: 'UTC' }; delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
} else {
  test('false replacement, deletion scope, reminder dismissal, and Note deletion', async () => {
    const blocked = await replay(['draft', '!one', '--text', 'Synthetic reply', '--replace=false'], { existing: 'Existing draft' });
    assert.equal(blocked.status, 2); assert.deepEqual(blocked.mutations, []);
    for (const [name, flag] of [['delete', 'for-everyone'], ['remind', 'dismiss-on-message']]) assert.deepEqual(await replay([name, ...cases[name], ...(confirmed.has(name) ? ['--confirmed'] : []), `--${flag}=false`]), OUTPUT[name]);
    const args = ['note', '!one', '--delete', 'n00000000']; assert.equal((await replay(args)).mutations[0][0], 'deleteNote');
    for (const flag of ['--dry-run', '--confirmed=false', '--replace=wrong']) { const r = await replay([...args, flag]); assert.equal(r.status, 2); assert.deepEqual(r.mutations, []); }
  });
  test('ambiguous values and cache-writing reads refuse dry-run', async () => {
    for (const args of [['send', '!one', '--text', '--dry-run', '--after', 'msg-1', '--confirmed'], ['draft', '!one', '--text', 'one', '--text', 'two'], ['react', '!one', 'msg-1', '--confirmed', 'false'], ['edit', '!one', '--confirmed', 'false', '--text', 'Synthetic'], ['media', '!one', 'msg-1', '--unused', '--dry-run'], ...['media', 'check', 'triage', 'find', 'search'].map((n) => [n, '--dry-run'])]) {
      const r = await replay(args); assert.equal(r.status, 2, r.stderr); assert.deepEqual(r.mutations, []);
    }
    const r = await replay(['draft', '!one', '--text=--dry-run']); assert.equal(r.status, 0, r.stderr); assert.ok(r.mutations.length);
  });
  // iMessage makes a group only by sending into it, so the first message goes in the one create
  // request (ADR 0001). Elsewhere the group is created empty, as the golden output above pins.
  test('an iMessage group carries its first message in its one create request, and never sends it again', async () => {
    const group = ['group', ...cases.group, '--confirmed'];
    const bare = await replay(group, { network: 'iMessage' });
    assert.equal(bare.status, 2); assert.deepEqual(bare.mutations, []);
    assert.match(bare.stderr, /^usage: An iMessage group starts with its first message, which goes out with the group\. Give --text/);
    for (const network of ['iMessage', 'WhatsApp']) {
      const blank = await replay([...group, '--text', 'Meet _ on Friday'], { network });
      assert.equal(blank.status, 2, network); assert.deepEqual(blank.mutations, [], network);
      assert.match(blank.stderr, /^usage: Not created\. The first message still holds a blank/, network);
    }
    const made = await replay([...group, '--text', 'Synthetic intro'], { network: 'iMessage' });
    assert.equal(made.status, 0, made.stderr);
    assert.deepEqual(made.mutations.filter(([kind]) => kind === 'api'), [['api', { method: 'POST', path: '/v1/chats', body: { accountID: 'test', type: 'group', participantIDs: ['!one', '!two'], messageText: 'Synthetic intro' } }]], 'one request, and no send after it');
    assert.equal(made.stdout, 'Group created: Test Chat · iMessage · 3 members · ref c00000000\nThe first message went out with the group and is in it as ref-sent-1. Delivery is not confirmed.\n');
    const failed = await replay([...group, '--text', 'Synthetic intro'], { network: 'iMessage', failCreate: true });
    assert.equal(failed.status, 1);
    assert.equal(failed.mutations.filter(([kind]) => kind === 'api').length, 1, 'never retried');
    assert.equal(failed.stdout, 'NOT VERIFIED. Beeper said: Failed to execute tool: createChat. No group with exactly those members is visible. Do not retry. Ask the Owner to look in Beeper first. The first message went in the same request, so it may have gone out too.\n');
    // Messages sends into an older group with the same people, past the chats Beeper lists first.
    const another = await replay([...group, '--text', 'Synthetic intro'], { network: 'iMessage', older: [['!one', '!two', '!three'], ['!two']] });
    assert.equal(another.status, 0, another.stderr);
    assert.equal(another.mutations.filter(([kind]) => kind === 'api').length, 1, 'a group with other members is no match');
    const older = await replay([...group, '--text', 'Synthetic intro'], { network: 'iMessage', older: [['!two', '!one']] });
    assert.equal(older.status, 1); assert.deepEqual(older.mutations, []);
    assert.match(older.stdout, /^Not created, and nothing was sent\. An older iMessage group with exactly those members is on this Mac/);
    const unread = await replay([...group, '--text', 'Synthetic intro'], { network: 'iMessage', older: 'unreadable' });
    assert.equal(unread.status, 1); assert.deepEqual(unread.mutations, []);
    assert.match(unread.stderr, /^beeper: Not created\. The Messages database could not be read\. Without it, an older group with these people can't be ruled out/);
  });
  // A reply posted after a newer message would show as the answer to a message its writer never saw.
  test('suggest posts only for the newest message the agent read', async () => {
    const base = ['suggest', '!one', '--text', 'Synthetic reply', '--agent', 'Test'];
    const bare = await replay(base);
    assert.equal(bare.status, 2); assert.deepEqual(bare.mutations, []);
    assert.match(bare.stderr, /^usage: Give --after <message>/);
    const stale = await replay([...base, '--after', 'msg-0']);
    assert.equal(stale.status, 2); assert.deepEqual(stale.mutations, []);
    assert.equal(stale.stderr, 'usage: Not posted. Test Chat · WhatsApp has changed since it was read: the newest message is now ref-msg-1, from them. Read the chat again and write the reply for it.\n');
    const byAlias = await replay([...base, '--after', 'ref-msg-1']);
    assert.equal(byAlias.status, 0, byAlias.stderr); assert.equal(byAlias.mutations[0][0], 'suggestion');
    // The newest is the one the chat command prints: a hidden event after it changes nothing, and a
    // deleted message still counts.
    const hidden = await replay([...base, '--after', 'msg-1'], { more: [{ id: 'event-2', text: 'You reacted', isSender: true, isHidden: true }] });
    assert.equal(hidden.status, 0, hidden.stderr);
    const deleted = await replay([...base, '--after', 'deleted-2'], { more: [{ id: 'deleted-2', text: 'unsent', isSender: false, isDeleted: true }] });
    assert.equal(deleted.status, 0, deleted.stderr);
    assert.deepEqual(deleted.mutations[0][1][1].forMessageID, 'msg-1', 'the reply still answers their newest message that is there');
  });
  test('every command that writes into a Chat refuses the Line\'s own Chat and changes nothing', async () => {
    for (const name of ['draft', 'suggest', 'send', 'react', 'edit', 'delete', 'group']) {
      const r = await replay([name, ...cases[name], ...(confirmed.has(name) ? ['--confirmed'] : [])], { line: ['!one'] });
      assert.equal(r.status, 2, name); assert.deepEqual(r.mutations, [], name);
      assert.match(r.stderr, /^usage: LINE_CHAT: /, name);
    }
    // Reading state into the Chat is not writing into it, and another Chat is untouched.
    for (const name of ['read', 'remind', 'unremind', 'dismiss', 'note']) assert.deepEqual(await replay([name, ...cases[name]], { line: ['!one'] }), OUTPUT[name], name);
    assert.deepEqual(await replay([...['send', ...cases.send], '--confirmed'], { line: ['!two'] }), OUTPUT.send);
  });
  // Inside a Companion run, send and react go through the app and never to Beeper directly
  // (docs/plans/one-agent.md, part 6 and slice 5), whatever the app answers.
  test('inside a Companion run, send and react go only through the app, and print its answer', async () => {
    const { deliveryLines } = await import('../scripts/lib/app.mjs');
    const env = { COMPANION_RUN: 'run-invented' };
    for (const [name, failure] of [['send', 'unavailable'], ['react', 'unavailable'], ['send', 'uncertain']]) {
      const asked = [];
      const r = await replay([name, ...cases[name], '--confirmed'], { env, app: { deliveryLines, deliverThroughApp: async (kind, payload) => { asked.push([kind, payload]); return { failure }; } } });
      assert.equal(r.status, 1, `${name} ${failure}`);
      assert.deepEqual(r.mutations, [], 'no request to Beeper, no CLI write');
      assert.match(r.stdout, failure === 'uncertain' ? /^NOT VERIFIED for Test Chat · WhatsApp\. Beeper Companion did not answer/ : /^NOT SENT to Test Chat · WhatsApp\./);
      assert.deepEqual(JSON.parse(JSON.stringify(asked)), [[name, name === 'send' ? { chatID: '!one', text: 'Synthetic reply', after: 'msg-1' } : { chatID: '!one', messageID: 'msg-1', key: '👍' }]]);
    }
    const sent = await replay(['send', ...cases.send, '--confirmed'], { env, app: { deliveryLines, deliverThroughApp: async () => ({ answer: { ok: true, status: 'sent', messageID: 'sent-9' } }) } });
    assert.deepEqual({ status: sent.status, stdout: sent.stdout, mutations: sent.mutations },
      { status: 0, stdout: 'Sent to Test Chat · WhatsApp. The message is in the chat as ref-sent-9. Delivery is not confirmed.\n', mutations: [] }, 'the same line as a direct send');
    const reacted = await replay(['react', ...cases.react, '--confirmed'], { env, app: { deliveryLines, deliverThroughApp: async () => ({ answer: { ok: true, status: 'sent' } }) } });
    assert.equal(reacted.stdout, OUTPUT.react.stdout);
    assert.deepEqual(reacted.mutations, []);
  });
  // A run's Draft goes through the app's one draft writer too, never straight to Beeper (ADR 0110),
  // and over exactly the draft it read when told to replace it.
  test('inside a Companion run, draft goes only through the app, and prints its answer', async () => {
    const { draftLines } = await import('../scripts/lib/app.mjs');
    const env = { COMPANION_RUN: 'run-invented' };
    const asked = [];
    const app = (outcome) => ({ draftLines, deliverThroughApp: async (kind, payload) => { asked.push([kind, payload]); return outcome; } });
    const drafted = await replay(['draft', ...cases.draft], { env, app: app({ answer: { ok: true, status: 'saved' } }) });
    assert.equal(drafted.stdout, OUTPUT.draft.stdout, 'the same line as a direct draft');
    assert.deepEqual(drafted.mutations.map(([kind]) => kind), ['recordDraft', 'state'], 'no CLI write; the skill still records its own draft');
    const replaced = await replay(['draft', '!one', '--text', 'Synthetic reply', '--replace'], { env, existing: 'Existing draft', app: app({ answer: { ok: true, status: 'saved' } }) });
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.deepEqual(replaced.mutations.map(([kind]) => kind), ['recordDraft', 'state'], 'never a clear, then a write');
    assert.deepEqual(JSON.parse(JSON.stringify(asked)), [['draft', { chatID: '!one', text: 'Synthetic reply' }], ['draft', { chatID: '!one', text: 'Synthetic reply', replacing: 'Existing draft' }]]);
    for (const [outcome, line] of [[{ failure: 'unavailable' }, /^Not drafted in Test Chat · WhatsApp\. Beeper Companion couldn't take this Draft/],
      [{ answer: { ok: false, code: 'APP_CLI_TYPING' } }, /^Not drafted\. The Owner has Test Chat · WhatsApp open in Beeper and may be typing there/],
      [{ answer: { ok: false, code: 'APP_CLI_RUN_ENDED' } }, /^Not drafted\. The Companion run this command belongs to has ended/]]) {
      const r = await replay(['draft', ...cases.draft], { env, app: app(outcome) });
      assert.equal(r.status, 1); assert.deepEqual(r.mutations, [], 'nothing written to Beeper, nothing recorded');
      assert.match(r.stdout, line);
    }
  });
  // From the Terminal, while the Companion is on this Mac, send, react, and draft go only through it
  // (ADR 0110): a refusal or a Companion that didn't start writes nothing to Beeper.
  test('from the Terminal with the Companion on this Mac, send, react, and draft go only through it', async () => {
    const { deliveryLines, draftLines } = await import('../scripts/lib/app.mjs');
    const companion = (answers, asked) => ({ deliveryLines, draftLines, terminalRoute: async () => ({ client: 'client' }),
      deliverWith: async (client, kind, payload) => { asked.push([client, kind, payload]); return answers[kind]; } });
    const asked = [];
    const answers = { send: { answer: { ok: true, status: 'sent', messageID: 'sent-9' } }, react: { answer: { ok: true, status: 'sent' } }, draft: { answer: { ok: true, status: 'saved' } } };
    const sent = await replay(['send', ...cases.send, '--confirmed'], { app: companion(answers, asked) });
    assert.deepEqual([sent.status, sent.stdout, sent.mutations], [0, 'Sent to Test Chat · WhatsApp. The message is in the chat as ref-sent-9. Delivery is not confirmed.\n', []]);
    const reacted = await replay(['react', ...cases.react, '--confirmed'], { app: companion(answers, asked) });
    assert.deepEqual([reacted.stdout, reacted.mutations], [OUTPUT.react.stdout, []]);
    const drafted = await replay(['draft', ...cases.draft], { app: companion(answers, asked) });
    assert.equal(drafted.stdout, OUTPUT.draft.stdout, 'the same line as a direct draft');
    assert.deepEqual(drafted.mutations.map(([kind]) => kind), ['recordDraft', 'state'], 'no CLI write; the skill still records its own draft');
    const replaced = await replay(['draft', '!one', '--text', 'Synthetic reply', '--replace'], { existing: 'Existing draft', app: companion(answers, asked) });
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.deepEqual(JSON.parse(JSON.stringify(asked)), [['client', 'send', { chatID: '!one', text: 'Synthetic reply', after: 'msg-1' }], ['client', 'react', { chatID: '!one', messageID: 'msg-1', key: '👍' }],
      ['client', 'draft', { chatID: '!one', text: 'Synthetic reply' }], ['client', 'draft', { chatID: '!one', text: 'Synthetic reply', replacing: 'Existing draft' }]], 'a replacement names exactly the draft it read');
    const held = await replay(['draft', ...cases.draft], { app: companion({ draft: { answer: { ok: false, code: 'APP_CLI_HELD' } } }, []) });
    assert.equal(held.status, 1); assert.deepEqual(held.mutations, []);
    assert.match(held.stdout, /^Not drafted\. A send in Test Chat · WhatsApp isn't confirmed yet/);
    const notStarted = { deliveryLines, draftLines, terminalRoute: async () => ({ failure: 'not-started' }), deliverWith: async () => { throw Error('never asked'); } };
    for (const name of ['send', 'react', 'draft']) {
      const r = await replay([name, ...cases[name], ...(confirmed.has(name) ? ['--confirmed'] : [])], { app: notStarted });
      assert.equal(r.status, 1, name); assert.deepEqual(r.mutations, [], `${name}: never written straight to Beeper`);
      assert.match(r.stdout, name === 'draft' ? /^Not drafted in Test Chat · WhatsApp\. Beeper Companion isn't running and didn't start/ : /^NOT SENT to Test Chat · WhatsApp\. Beeper Companion isn't running and didn't start/, name);
    }
  });
  for (const [name, args] of Object.entries(cases)) {
    const good = [name, ...args, ...(confirmed.has(name) ? ['--confirmed'] : [])];
    test(`${name}: malformed, unsupported, duplicate, and dry-run flags never mutate`, async () => {
      const bad = [...booleans.flatMap((key) => ['falsey', '', '0', 'TRUE'].map((v) => `--${key}=${v}`)), '--unexpected=value'];
      for (const flag of bad) {
        const r = await replay([...good, flag]);
        assert.equal(r.status, 2, `${flag}: ${r.stderr}`); assert.deepEqual(r.mutations, []);
        assert.equal(r.stdout, ''); assert.match(r.stderr, /^usage: /);
      }
      for (const flags of [['--dry-run', '--dry-run=false'], ['--dry-run=true'], ['--dry-run']]) {
        const r = await replay([...good, ...flags], { alias: true });
        assert.deepEqual(r.mutations, [], r.stderr);
        if (flags.length === 1 && previews.has(name)) assert.equal(r.stdout, PREVIEWS[name]);
        assert.equal(r.status, flags.length === 1 && previews.has(name) ? 0 : 2, r.stderr);
      }
      if (confirmed.has(name)) for (const flags of [[], ['--confirmed=false'], ['--confirmed', 'false'], ['--confirmed=false', '--confirmed']]) {
        const r = await replay([name, ...args, ...flags], { alias: true });
        assert.equal(r.status, 2, r.stderr); assert.deepEqual(r.mutations, [], name);
      }
    });
    test(`${name}: good path retains output bytes and mutations`, async () => {
      const r = await replay(good);
      const golden = OUTPUT[name];
      assert.deepEqual(JSON.parse(JSON.stringify(r)), golden);
      assert.equal(r.status, 0, r.stderr); assert.ok(r.mutations.length);
      if (confirmed.has(name)) assert.deepEqual(await replay(good.map((a) => a === '--confirmed' ? '--confirmed=true' : a)), r);
      assert.deepEqual(await replay([...good, '--dry-run=false']), r);
    });
  }
}

// Captured from the unmodified entry point before this repair, with the synthetic dependencies above.
const OUTPUT = {
"mode": {"status":0,"stdout":"Mode is now readonly, for every agent on this Mac. To loosen it later, the person edits or deletes /synthetic/mode themselves.\n","stderr":"","mutations":[["mkdir",["/synthetic",{"recursive":true}]],["file",["/synthetic/mode","readonly\n"]]]},
"dismiss": {"status":0,"stdout":"Dismissed Test Chat · WhatsApp. It returns to the triage list when a new message arrives.\n","stderr":"","mutations":[["dismiss",[{"aliases":{},"drafted":{},"dismissed":{}},{"id":"!one","preview":{"id":"msg-1"}}]],["state",[{"aliases":{},"drafted":{},"dismissed":{}}]]]},
"undismiss": {"status":0,"stdout":"Restored Test Chat · WhatsApp to the triage list.\n","stderr":"","mutations":[["undismiss",[{"aliases":{},"drafted":{},"dismissed":{}},"!one"]],["state",[{"aliases":{},"drafted":{},"dismissed":{}}]]]},
"same": {"status":0,"stdout":"Recorded: the same person. It takes effect when the corpus next rebuilds, within about 15 minutes.\n","stderr":"","mutations":[["identity",["/synthetic","p_a","p_b","same"]]]},
"different": {"status":0,"stdout":"Recorded: different people. It takes effect when the corpus next rebuilds, within about 15 minutes.\n","stderr":"","mutations":[["identity",["/synthetic","p_a","p_b","different"]]]},
"note": {"status":0,"stdout":"Note n00000000 saved in Test Chat · WhatsApp, as a claim by agent, citing 0 messages. Nothing was sent.\n","stderr":"","mutations":[["note",["!one",{"text":"Synthetic reply","kind":"agent","author":"agent","source":{"messages":[]}}]]]},
"draft": {"status":0,"stdout":"Draft saved in Test Chat · WhatsApp. Nothing was sent. The Owner can review and send it in Beeper.\n","stderr":"","mutations":[["cli",["chats","draft","--chat","!one","--text","Synthetic reply"]],["recordDraft",[{"aliases":{},"drafted":{},"dismissed":{}},"!one",{"text":"Synthetic reply"}]],["state",[{"aliases":{},"drafted":{},"dismissed":{}}]]]},
"suggest": {"status":0,"stdout":"Posted to Beeper Companion's sidebar for Test Chat · WhatsApp: 1 message, as Test. Nothing was sent. When the Owner opens this Chat, the sidebar puts the first message in Beeper's compose box, and the reply sends only if they press Send there. A newer message in the Chat retires it.\n","stderr":"","mutations":[["suggestion",["!one",{"steps":[{"kind":"message","text":"Synthetic reply","waitMs":0}],"forMessageID":"msg-1","author":"Test"}]]]},
"send": {"status":0,"stdout":"Sent to Test Chat · WhatsApp. The message is in the chat as ref-sent-1. Delivery is not confirmed.\n","stderr":"","mutations":[["api",{"method":"POST","path":"/v1/chats/!one/messages","body":{"text":"Synthetic reply"}}]]},
"read": {"status":0,"stdout":"Marked read: Test Chat · WhatsApp.\n","stderr":"","mutations":[["cli",["chats","mark-read","--chat","!one"]]]},
"react": {"status":0,"stdout":"Reacted 👍 to ref-msg-1 in Test Chat · WhatsApp.\n","stderr":"","mutations":[["cli",["send","react","--to","!one","--id","msg-1","--reaction","👍"]]]},
"remind": {"status":0,"stdout":"Reminder requested, not yet visible, for Test Chat · WhatsApp at 1/1/2099, 12:00:00 PM.\n","stderr":"","mutations":[["cli",["chats","remind","--chat","!one","--when","2099-01-01T12:00:00.000Z"]]]},
"unremind": {"status":0,"stdout":"Reminder cleared for Test Chat · WhatsApp.\n","stderr":"","mutations":[["cli",["chats","unremind","--chat","!one"]]]},
"edit": {"status":0,"stdout":"Edited ref-msg-1 in Test Chat · WhatsApp. Some networks show the edit history to the other person.\n","stderr":"","mutations":[["cli",["messages","edit","--chat","!one","--id","msg-1","--message","Synthetic reply"]]]},
"delete": {"status":0,"stdout":"Deleted ref-msg-1 in Test Chat · WhatsApp on this side only.\n","stderr":"","mutations":[["cli",["messages","delete","--chat","!one","--id","msg-1"]]]},
"contact": {"status":0,"stdout":"Contact created: Test · +15550102030. The chat will show this name from now on. Contact id contact-1\n","stderr":"","mutations":[["contact",[]]]},
"group": {"status":0,"stdout":"Group created: Test Chat · WhatsApp · 3 members · ref c00000000\nIt already holds 1 message. Read the chat before sending, since some networks insert a placeholder.\n","stderr":"","mutations":[["api",{"method":"POST","path":"/v1/chats","body":{"accountID":"test","type":"group","participantIDs":["!one","!two"]}}],["state",[{"aliases":{"c00000000":{"id":"!group"}},"drafted":{},"dismissed":{}}]]]},
"start": {"status":0,"stdout":"Chat ready: Test Chat · WhatsApp · ref c00000000. Nothing was sent.\n","stderr":"","mutations":[["cli",["chats","start","+15550102030","--account","test"]],["state",[{"aliases":{"c00000000":{"id":"!new"}},"drafted":{},"dismissed":{}}]]]},
};

const PREVIEWS = {
"draft": "Dry run. Would save a draft of 15 characters in Test Chat · WhatsApp.\n",
"suggest": "Dry run. Would post 1 message to the sidebar for Test Chat · WhatsApp, as Test.\n",
};
