// The rules for a Reply suggestion with several steps (ADR 0054): messages and reactions in
// order, with the wait before each. `ba suggest` checks them before posting, and the companion
// checks them again on every file it reads and every reply the Owner confirms.
import { hasGap } from './gaps.mjs';

// 5 minutes covers 98.5% of the Owner's own follow-ups. A later step waits at least a second,
// so Beeper's composer shows the sent message gone before the next check reads it.
export const REPLY_LIMITS = Object.freeze({ steps: 6, reactions: 2, messageChars: 4_000, keyChars: 32, minWaitMs: 1_000, waitMs: 5 * 60_000, totalWaitMs: 10 * 60_000 });

/**
 * Why a reply breaks the limits, or null. loaded holds the message IDs a reaction may target.
 * @param {{ steps?: unknown }} reply
 * @param {{ has(id: string): boolean }} loaded
 * @returns {string | null}
 */
export function replyProblem(reply, loaded) {
  const steps = reply && reply.steps;
  if (!Array.isArray(steps) || !steps.length) return 'empty';
  if (steps.length > REPLY_LIMITS.steps) return 'too-many-steps';
  if (!steps.some((step) => step && step.kind === 'message')) return 'no-message';
  let reactions = 0, waited = 0;
  for (const [i, step] of steps.entries()) {
    if (!step || typeof step !== 'object') return 'bad-step';
    const wait = step.waitMs;
    if (!Number.isSafeInteger(wait) || wait > REPLY_LIMITS.waitMs || (i === 0 ? wait !== 0 : wait < REPLY_LIMITS.minWaitMs)) return 'bad-wait';
    waited += wait;
    if (step.kind === 'message') {
      if (typeof step.text !== 'string' || !step.text.trim() || step.text.length > REPLY_LIMITS.messageChars) return 'bad-message';
      if (hasGap(step.text)) return 'blank';
    } else if (step.kind === 'react') {
      if (++reactions > REPLY_LIMITS.reactions) return 'too-many-reactions';
      if (typeof step.key !== 'string' || !step.key.trim() || step.key.length > REPLY_LIMITS.keyChars || /\s/.test(step.key)) return 'bad-reaction';
      if (typeof step.messageID !== 'string' || !loaded.has(step.messageID)) return 'unknown-target';
    } else return 'bad-step';
  }
  return waited > REPLY_LIMITS.totalWaitMs ? 'too-long' : null;
}

// What each problem means, for an agent that posted the reply.
export const REPLY_PROBLEMS = Object.freeze({
  'empty': 'The reply has no steps.',
  'too-many-steps': `A reply holds at most ${REPLY_LIMITS.steps} steps.`,
  'no-message': 'A reply needs at least one message.',
  'bad-step': 'Each step is {"say": "…"}, {"react": "<message>", "key": "❤️"}, or {"wait": "20s"}.',
  'bad-wait': 'Waits go between steps, at least 1 s and at most 5 min each. Nothing waits before the first step.',
  'bad-message': `Each message needs text, at most ${REPLY_LIMITS.messageChars} characters.`,
  'blank': 'A message still holds a blank (_). Fill it in, or leave that fact out.',
  'too-many-reactions': `A reply holds at most ${REPLY_LIMITS.reactions} reactions.`,
  'bad-reaction': 'A reaction is one emoji or shortcode, with no spaces.',
  'unknown-target': 'A reaction must name one of the Chat\'s 30 newest messages.',
  'too-long': 'All the waits together come to at most 10 minutes.',
});
