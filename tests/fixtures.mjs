// Synthetic data only. No real people, numbers, or messages.
export const NOW = Date.parse('2026-09-27T20:00:00Z');
const HOUR = 3_600_000;
const ago = (h) => new Date(NOW - h * HOUR).toISOString();
let n = 0;

export function person({ name = '', phone = '', email = '', self = false, bot = false } = {}) {
  n += 1;
  const p = { id: `imsg##participant:${String(n).padStart(8, '0')}`, fullName: name || phone || email };
  if (phone) p.phoneNumber = phone;
  if (email) p.email = email;
  if (self) p.isSelf = true;
  if (bot) p.isNetworkBot = true;
  return p;
}

export const ME = person({ name: 'Owner', phone: '+15550000001', self: true });

export function chat(o = {}) {
  n += 1;
  const others = o.others || [person({ name: o.title || 'Someone' })];
  const items = [...others, ME];
  const fromMe = o.lastFrom === 'me';
  return {
    id: o.id || `!room${n}:beeper.local`,
    localChatID: String(1000 + n),
    accountID: o.accountID || 'testnet',
    network: o.network || 'TestNet',
    type: o.type || 'single',
    title: o.title === undefined ? 'Someone' : o.title,
    participants: { items, hasMore: false, total: o.total || items.length },
    lastActivity: ago(o.hoursAgo === undefined ? 1 : o.hoursAgo),
    unreadCount: o.unread || 0,
    unreadMentionsCount: o.mentions || 0,
    isMarkedUnread: !!o.markedUnread,
    isArchived: !!o.archived,
    isMuted: !!o.muted,
    isLowPriority: !!o.low,
    isPinned: !!o.pinned,
    isReadOnly: !!o.readOnly,
    draft: o.draft ? { text: o.draft } : null,
    reminder: o.reminder || null,
    preview: {
      id: o.previewID || `$msg${n}`,
      sortKey: String(n),
      isSender: fromMe,
      senderID: fromMe ? ME.id : others[0].id,
      senderName: fromMe ? 'Owner' : (o.senderName === undefined ? others[0].fullName : o.senderName),
      text: o.text === undefined ? 'are you free friday?' : o.text,
      timestamp: ago(o.hoursAgo === undefined ? 1 : o.hoursAgo),
    },
  };
}

export const CONTACT_ROWS = [
  { pk: 1, first: 'Ada', last: 'Lovelace', nick: null, org: null, value: '+1 (555) 010-0001', kind: 'phone' },
  { pk: 1, first: 'Ada', last: 'Lovelace', nick: null, org: null, value: 'Ada@Example.com', kind: 'email' },
  { pk: 2, first: 'Grace', last: 'Hopper', nick: null, org: null, value: '555-010-0002', kind: 'phone' },
  { pk: 3, first: null, last: null, nick: null, org: 'Pizza Place', value: '+15550100003', kind: 'phone' },
  // One number listed under two different contacts. It must not resolve.
  { pk: 4, first: 'Shared', last: 'One', nick: null, org: null, value: '+15550100009', kind: 'phone' },
  { pk: 5, first: 'Shared', last: 'Two', nick: null, org: null, value: '+15550100009', kind: 'phone' },
  { pk: 6, first: 'Ada', last: 'Byron', nick: null, org: null, value: '+445550100004', kind: 'phone' },
];
