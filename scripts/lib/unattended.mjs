// Pending: the Chats an Unattended run may draft for. Beeper Companion's Agent Drafts ask it about
// each one-to-one Chat (apps/beeper-companion/src/main/agent-drafts.ts decide). Pure, no I/O.

const HOUR = 3_600_000;
const ANSWERABLE = new Set(['text', 'link', 'attachment']);

// The Pending Chats, and why the rest were left out.
export function selectPending(rows, { max = 5 } = {}) {
  const counts = { strangers: 0, holdingDraft: 0, ownerSpokeLast: 0, nothingToAnswer: 0 };
  const ok = [];
  for (const r of rows) {
    if (r.type !== 'single') continue;
    if (r.ownerSpoke !== true) { counts.strangers++; continue; }
    if (r.lastFrom !== 'them' || !r.newestID) { counts.ownerSpokeLast++; continue; }
    if (!ANSWERABLE.has(r.kind)) { counts.nothingToAnswer++; continue; }
    if (r.hasDraft) { counts.holdingDraft++; continue; }
    ok.push(r);
  }
  const fresh = (r) => r.ageMs < 48 * HOUR;
  ok.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (fresh(a) !== fresh(b)) return fresh(a) ? -1 : 1;
    return fresh(a) ? a.ageMs - b.ageMs : b.ageMs - a.ageMs;
  });
  return { batch: ok.slice(0, max), waiting: ok.length, counts };
}
