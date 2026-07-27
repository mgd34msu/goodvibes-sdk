/**
 * Writing-style-matched draft reply composer.
 *
 * This module is PURE and DETERMINISTIC — no Date.now(), Math.random(),
 * or I/O.  It takes a corpus of prior sent messages and an inbound message
 * and produces a draft body that mirrors the user's writing style.
 *
 * BEFORE-SEND REVIEW BOUNDARY
 * ──────────────────────────────────────────────────────────────────────────
 * This composer produces a DRAFT only.  No send path is included here.
 * Delivery MUST go through the existing confirmed SMTP / connector send
 * route (EmailService.sendMail with confirm:true, or the equivalent MCP
 * connector action with explicit user confirmation).  The lane descriptor
 * in style-reply-lane.ts enforces this boundary at the Personal Ops level.
 *
 * The secret-like-text check is injected rather than imported: which strings
 * count as credentials is a product policy, and the composer must run against
 * whichever predicate the surface already uses on the rest of its text.
 */

import type { SecretLikeTextPredicate } from '../google/account-registry.js';
import type { EmailSummary } from './email-service.js';

// ---------------------------------------------------------------------------
// Style profile
// ---------------------------------------------------------------------------

export interface StyleProfile {
  /** Most common greeting prefix found in sent messages, e.g. 'Hi', 'Hello', 'Hey'. */
  readonly greeting: string;
  /** Most common sign-off found in sent messages, e.g. 'Thanks', 'Best', 'Cheers'. */
  readonly signOff: string;
  /** Median sentence count across sent messages (whole number, ≥1). */
  readonly medianSentenceCount: number;
  /** Dominant tone inferred from token analysis: 'formal' | 'casual' | 'neutral'. */
  readonly tone: 'formal' | 'casual' | 'neutral';
  /** True when the corpus is empty — all values are defaults. */
  readonly isDefault: boolean;
}

/** Greeting tokens in priority order (most → least common in business email). */
const GREETING_TOKENS: readonly string[] = [
  'Hi', 'Hello', 'Hey', 'Dear', 'Greetings', 'Good morning', 'Good afternoon',
];

/**
 * Sign-off tokens ordered longest-first so that multi-word phrases
 * ('Kind regards', 'Best regards') are matched before their single-word
 * substrings ('Regards', 'Best').  mostFrequent breaks ties by earliest
 * position in this array.
 */
const SIGN_OFF_TOKENS: readonly string[] = [
  'Kind regards', 'Best regards', 'All the best', 'Thank you', 'Thanks',
  'Sincerely', 'Take care', 'Cheers', 'Regards', 'Best',
];

/** Formal tokens that shift tone toward 'formal'. */
const FORMAL_TOKENS: readonly string[] = [
  'please', 'kindly', 'sincerely', 'regards', 'dear', 'pursuant', 'accordingly',
  'therefore', 'attached', 'enclosed', 'herewith',
];

/** Casual tokens that shift tone toward 'casual'. */
const CASUAL_TOKENS: readonly string[] = [
  'hey', 'cheers', 'yep', 'nope', 'yeah', 'cool', 'awesome', 'sure thing',
  'no worries', 'sounds good', 'chat soon', 'catch you',
];

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Count how many sentences a text body contains.
 * Splits on '. ', '! ', '? ' and trailing punctuation.
 * Returns at least 1 for any non-empty string.
 */
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Split on end-of-sentence punctuation followed by whitespace or end-of-string
  const parts = trimmed.split(/[.!?](?:\s+|$)/).filter((s) => s.trim().length > 0);
  return Math.max(1, parts.length);
}

/**
 * Compute the median of a sorted number array.
 * Returns `fallback` when the array is empty.
 */
export function median(sorted: readonly number[], fallback: number): number {
  if (sorted.length === 0) return fallback;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round(((sorted[mid - 1]!) + (sorted[mid]!)) / 2);
}

/**
 * Find the most frequently occurring token in a list.
 * When there are ties, the token appearing earliest in `candidates` wins.
 * Returns `fallback` when no candidates match.
 */
export function mostFrequent(
  corpus: readonly string[],
  candidates: readonly string[],
  fallback: string,
): string {
  const lower = corpus.map((s) => s.toLowerCase());
  const counts = candidates.map((token) => ({
    token,
    count: lower.filter((text) => text.includes(token.toLowerCase())).length,
  }));
  const best = counts.reduce(
    (best, candidate) => (candidate.count > best.count ? candidate : best),
    { token: fallback, count: 0 },
  );
  return best.count > 0 ? best.token : fallback;
}

/**
 * Classify tone from a corpus of message bodies.
 * Returns 'formal', 'casual', or 'neutral'.
 */
export function classifyTone(bodies: readonly string[]): 'formal' | 'casual' | 'neutral' {
  if (bodies.length === 0) return 'neutral';
  const combined = bodies.join(' ').toLowerCase();
  const formalHits = FORMAL_TOKENS.filter((t) => combined.includes(t)).length;
  const casualHits = CASUAL_TOKENS.filter((t) => combined.includes(t)).length;
  if (formalHits > casualHits) return 'formal';
  if (casualHits > formalHits) return 'casual';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a StyleProfile from a corpus of the user's prior sent messages.
 *
 * When `sentMessages` is empty, returns a neutral default profile.
 * Never reads the clock; fully deterministic.
 */
export function extractStyleProfile(sentMessages: readonly EmailSummary[]): StyleProfile {
  if (sentMessages.length === 0) {
    return {
      greeting: 'Hi',
      signOff: 'Thanks',
      medianSentenceCount: 3,
      tone: 'neutral',
      isDefault: true,
    };
  }

  const bodies = sentMessages.map((m) => m.bodyPreview).filter((b) => b.length > 0);
  const greetingCorpus = bodies.map((b) => b.split('\n')[0] ?? '');
  const signOffCorpus = bodies.map((b) => {
    const lines = b.split('\n').filter((l) => l.trim().length > 0);
    return lines[lines.length - 1] ?? '';
  });

  const greeting = mostFrequent(greetingCorpus, GREETING_TOKENS, 'Hi');
  const signOff = mostFrequent(signOffCorpus, SIGN_OFF_TOKENS, 'Thanks');

  const sentenceCounts = bodies
    .map(countSentences)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  const medianSentenceCount = Math.max(1, median(sentenceCounts, 3));
  const tone = classifyTone(bodies);

  return {
    greeting,
    signOff,
    medianSentenceCount,
    tone,
    isDefault: false,
  };
}

export interface DraftReplyResult {
  /** Fully composed draft body. Never includes credentials or secret-looking text. */
  readonly body: string;
  /** The style profile used to compose this draft. */
  readonly profile: StyleProfile;
  /** Subject line for the reply, prefixed with 'Re: ' if not already. */
  readonly subject: string;
  /** BEFORE-SEND REVIEW BOUNDARY: always true — this is a draft, never auto-sent. */
  readonly requiresBeforeSendReview: true;
  /** Human-readable reminder of the review boundary. */
  readonly reviewBoundary: string;
}

/**
 * Compose a draft reply to `inbound` in the user's style as described by
 * `profile`.  An optional `context` string (e.g. key points the user wants
 * to include) is woven into the body.
 *
 * SAFETY GUARANTEES
 * - Throws if the composed body or context contains secret-like text.
 * - Never sends — returns a DraftReplyResult with requiresBeforeSendReview: true.
 * - No Date.now() / Math.random() — deterministic output for a given input.
 *
 * @param inbound   The email the user received and wants to reply to.
 * @param profile   Writing-style profile extracted from prior sent messages.
 * @param context   Key points / instructions to fold into the draft body; '' for none.
 * @param containsSecretLikeText  The surface's own credential-shaped-text
 *   predicate. Required rather than defaulted: a default would have to be
 *   permissive, and a permissive default here silently disables the check.
 */
export function composeDraftReply(
  inbound: EmailSummary,
  profile: StyleProfile,
  context: string,
  containsSecretLikeText: SecretLikeTextPredicate,
): DraftReplyResult {
  // Validate context for secret-like text before use
  if (context && containsSecretLikeText(context)) {
    throw new Error(
      'composeDraftReply: context contains secret-like text. ' +
      'Remove credentials or sensitive values before composing a draft.',
    );
  }

  const senderName = extractSenderName(inbound.from);
  const subjectLine = replySubject(inbound.subject);

  // Build body paragraphs scaled to the user's median sentence count.
  // We keep the length heuristic simple and deterministic.
  const lines: string[] = [];

  // Greeting
  lines.push(`${profile.greeting}${senderName ? ` ${senderName}` : ''},`);
  lines.push('');

  // Acknowledgement sentence
  const acknowledgement = buildAcknowledgement(inbound, profile.tone);
  lines.push(acknowledgement);

  // User-supplied context woven in as a separate paragraph
  if (context.trim()) {
    lines.push('');
    lines.push(context.trim());
  }

  // Filler sentences to approximate median length (when no context provided
  // and the profile expects more sentences than the acknowledgement alone)
  if (!context.trim() && profile.medianSentenceCount > 2) {
    lines.push('');
    lines.push(buildPlaceholderBody(profile.medianSentenceCount - 1, profile.tone));
  }

  // Sign-off
  lines.push('');
  lines.push(`${profile.signOff},`);

  const body = lines.join('\n');

  // Assert no secret-like text in the composed output
  if (containsSecretLikeText(body)) {
    throw new Error(
      'composeDraftReply: composed draft body contains secret-like text. ' +
      'Review the inbound message content and context before composing.',
    );
  }

  return {
    body,
    profile,
    subject: subjectLine,
    requiresBeforeSendReview: true,
    reviewBoundary:
      'This is a DRAFT only. Review the content before sending. ' +
      'Sending requires confirm:true on the email send path (SMTP or connector) ' +
      'with explicit user confirmation of recipients and body.',
  };
}

// ---------------------------------------------------------------------------
// Internal composition helpers
// ---------------------------------------------------------------------------

/**
 * Extract a first name from an RFC-5322-style From header value.
 * Handles both "Display Name <addr>" and "addr" forms.
 * Returns empty string when no usable name is found.
 */
export function extractSenderName(from: string): string {
  // Try "Display Name <email>" pattern
  const displayMatch = /^([^<]+)</.exec(from.trim());
  if (displayMatch) {
    const display = displayMatch[1]!.trim().replace(/^["']+|["']+$/g, '').trim();
    if (display) {
      // Return first token only (first name)
      return display.split(/\s+/)[0] ?? '';
    }
  }
  // Fall back to local part of email address
  const localMatch = /^([^@<]+)@/.exec(from.trim());
  if (localMatch) {
    const local = localMatch[1]!.trim();
    // Capitalize first letter
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  return '';
}

/** Ensure subject is prefixed with 'Re: ' exactly once. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re:\s*/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

/** Build a natural acknowledgement sentence adapted to tone. */
function buildAcknowledgement(inbound: EmailSummary, tone: StyleProfile['tone']): string {
  const subject = inbound.subject.trim();
  switch (tone) {
    case 'formal':
      return subject
        ? `Thank you for your message regarding "${subject}".`
        : 'Thank you for reaching out.';
    case 'casual':
      return subject
        ? `Thanks for your message about "${subject}"!`
        : 'Thanks for reaching out!';
    default:
      return subject
        ? `Thanks for your message about "${subject}".`
        : 'Thanks for reaching out.';
  }
}

/**
 * Build placeholder body sentences to approximate target sentence count.
 * Returns one paragraph with `targetCount` filler sentences.
 * Deterministic — no randomness.
 */
function buildPlaceholderBody(targetCount: number, tone: StyleProfile['tone']): string {
  const formalSentences = [
    'I have reviewed the relevant details and will follow up accordingly.',
    'Please let me know if you require any further information.',
    'I will ensure this is addressed in a timely manner.',
    'Kindly advise if you would like to discuss this further.',
  ];
  const casualSentences = [
    'Let me know if you have any questions.',
    'Happy to chat more about this if helpful.',
    'Feel free to reach out if anything else comes up.',
    'Let me know what works best for you.',
  ];
  const neutralSentences = [
    'Let me know if you need anything else.',
    'Happy to discuss further if useful.',
    'Please let me know if you have any questions.',
    'Looking forward to hearing from you.',
  ];

  const pool = tone === 'formal' ? formalSentences : tone === 'casual' ? casualSentences : neutralSentences;
  // Take up to targetCount sentences from the pool (cycle if needed)
  const sentences: string[] = [];
  for (let i = 0; i < Math.min(targetCount, 4); i++) {
    sentences.push(pool[i % pool.length]!);
  }
  return sentences.join(' ');
}
