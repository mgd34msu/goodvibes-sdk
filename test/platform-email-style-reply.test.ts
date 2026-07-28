/**
 * Tests for the writing-style-matched draft reply composer and lane descriptor.
 *
 * All tests are deterministic — no Date.now(), Math.random(), or I/O.
 */

import { describe, expect, it } from 'bun:test';
import {
  testContainsSecretLikeText,
  testDescribeSenderClaim,
} from './_helpers/platform-email-fixtures.ts';
import type { EmailSummary } from '../packages/sdk/src/platform/email/email-service.ts';
import {
  classifyTone,
  composeDraftReply,
  countSentences,
  extractSenderName,
  extractStyleProfile,
  median,
  mostFrequent,
  replySubject,
} from '../packages/sdk/src/platform/email/style-reply.ts';
import {
  buildStyleReplyLaneAdditions,
  styleReplyLiveRecord,
  styleReplyWorkflow,
  styleReplyWorkflowStatus,
} from '../packages/sdk/src/platform/email/style-reply-lane.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<EmailSummary> = {}): EmailSummary {
  return {
    uid: 1,
    messageId: '<test-message-1@example.com>',
    from: 'sender@example.com',
    subject: 'Test subject',
    date: '2024-01-01T10:00:00Z',
    unread: true,
    bodyPreview: '',
    mailbox: 'INBOX',
    deliveredTo: [],
    unverifiedToHeaderClaim: '',
    senderClaim: testDescribeSenderClaim('sender@example.com'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// countSentences
// ---------------------------------------------------------------------------

describe('countSentences', () => {
  it('returns 0 for empty string', () => {
    expect(countSentences('')).toBe(0);
  });

  it('returns 1 for a single sentence without trailing punctuation', () => {
    expect(countSentences('Hello there')).toBe(1);
  });

  it('counts multiple sentences separated by period-space', () => {
    expect(countSentences('First sentence. Second sentence. Third sentence.')).toBe(3);
  });

  it('counts sentences ending with exclamation marks', () => {
    expect(countSentences('Great! Sounds good! Talk soon.')).toBe(3);
  });

  it('counts sentences ending with question marks', () => {
    expect(countSentences('How are you? Are you free? Let me know.')).toBe(3);
  });

  it('returns at least 1 for any non-empty string', () => {
    expect(countSentences('no punctuation here')).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

describe('median', () => {
  it('returns fallback for empty array', () => {
    expect(median([], 5)).toBe(5);
  });

  it('returns the single element for a one-element array', () => {
    expect(median([7], 0)).toBe(7);
  });

  it('returns the middle element for odd-length array', () => {
    expect(median([1, 3, 5], 0)).toBe(3);
  });

  it('returns rounded average of two midpoints for even-length array', () => {
    expect(median([2, 4], 0)).toBe(3);
  });

  it('handles larger sorted arrays', () => {
    expect(median([1, 2, 3, 4, 5, 6], 0)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// mostFrequent
// ---------------------------------------------------------------------------

describe('mostFrequent', () => {
  it('returns fallback when corpus is empty', () => {
    expect(mostFrequent([], ['Hi', 'Hello'], 'Hey')).toBe('Hey');
  });

  it('returns the candidate that appears most in the corpus', () => {
    const corpus = [
      'Hi there, hope you are well',
      'Hi Alice,',
      'Hello Bob,',
    ];
    expect(mostFrequent(corpus, ['Hi', 'Hello', 'Hey'], 'Hey')).toBe('Hi');
  });

  it('returns fallback when no candidates appear in corpus', () => {
    const corpus = ['Good morning team'];
    expect(mostFrequent(corpus, ['Hey', 'Yo'], 'Hi')).toBe('Hi');
  });

  it('is case-insensitive', () => {
    const corpus = ['HELLO everyone', 'hello again'];
    expect(mostFrequent(corpus, ['Hello', 'Hi'], 'Hi')).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// classifyTone
// ---------------------------------------------------------------------------

describe('classifyTone', () => {
  it('returns neutral for empty corpus', () => {
    expect(classifyTone([])).toBe('neutral');
  });

  it('returns formal when formal tokens dominate', () => {
    const bodies = [
      'Please kindly review the attached document.',
      'I am writing pursuant to our previous discussion.',
      'Regards, sincerely yours.',
    ];
    expect(classifyTone(bodies)).toBe('formal');
  });

  it('returns casual when casual tokens dominate', () => {
    const bodies = [
      'Hey, sounds good! No worries about the delay.',
      'Yeah, cheers! Chat soon.',
    ];
    expect(classifyTone(bodies)).toBe('casual');
  });

  it('returns neutral when balanced', () => {
    // Deliberately crafted to have equal formal and casual hits (0 each)
    expect(classifyTone(['Thank you for your time'])).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// extractSenderName
// ---------------------------------------------------------------------------

describe('extractSenderName', () => {
  it('extracts display name from "Name <email>" form', () => {
    expect(extractSenderName('Alice Smith <alice@example.com>')).toBe('Alice');
  });

  it('extracts local part from bare email address', () => {
    expect(extractSenderName('bob@example.com')).toBe('Bob');
  });

  it('returns empty string when from is empty', () => {
    expect(extractSenderName('')).toBe('');
  });

  it('handles quoted display name', () => {
    expect(extractSenderName('"Carol Jones" <carol@example.com>')).toBe('Carol');
  });

  it('capitalises local part when no display name exists', () => {
    expect(extractSenderName('dave@example.com')).toBe('Dave');
  });
});

// ---------------------------------------------------------------------------
// replySubject
// ---------------------------------------------------------------------------

describe('replySubject', () => {
  it('prepends Re: when subject does not have it', () => {
    expect(replySubject('Project update')).toBe('Re: Project update');
  });

  it('does not double-prefix when subject already starts with Re:', () => {
    expect(replySubject('Re: Project update')).toBe('Re: Project update');
  });

  it('is case-insensitive for Re: prefix detection', () => {
    expect(replySubject('RE: Important')).toBe('RE: Important');
  });

  it('trims leading/trailing whitespace before checking prefix', () => {
    const result = replySubject('  Hello  ');
    expect(result).toBe('Re: Hello');
  });
});

// ---------------------------------------------------------------------------
// extractStyleProfile — empty corpus
// ---------------------------------------------------------------------------

describe('extractStyleProfile — empty corpus', () => {
  it('returns default profile when corpus is empty', () => {
    const profile = extractStyleProfile([]);
    expect(profile.isDefault).toBe(true);
    expect(profile.greeting).toBe('Hi');
    expect(profile.signOff).toBe('Thanks');
    expect(profile.medianSentenceCount).toBeGreaterThanOrEqual(1);
    expect(['formal', 'casual', 'neutral']).toContain(profile.tone);
  });
});

// ---------------------------------------------------------------------------
// extractStyleProfile — corpus with bodies
// ---------------------------------------------------------------------------

describe('extractStyleProfile — corpus with bodies', () => {
  it('detects casual greeting from corpus', () => {
    const sent = [
      makeSummary({ bodyPreview: 'Hey Bob,\nJust checking in.\nCheers' }),
      makeSummary({ bodyPreview: 'Hey Carol,\nSounds good!\nCheers' }),
      makeSummary({ bodyPreview: 'Hey Dave,\nLet me know.\nCheers' }),
    ];
    const profile = extractStyleProfile(sent);
    expect(profile.greeting).toBe('Hey');
    expect(profile.isDefault).toBe(false);
  });

  it('detects formal sign-off from corpus', () => {
    const sent = [
      makeSummary({ bodyPreview: 'Dear Alice,\nPlease see the attached.\nKind regards' }),
      makeSummary({ bodyPreview: 'Dear Bob,\nKindly review the document.\nKind regards' }),
    ];
    const profile = extractStyleProfile(sent);
    expect(profile.signOff).toBe('Kind regards');
  });

  it('sets medianSentenceCount >= 1', () => {
    const sent = [
      makeSummary({ bodyPreview: 'Hi,\nOne sentence.\nThanks' }),
    ];
    const profile = extractStyleProfile(sent);
    expect(profile.medianSentenceCount).toBeGreaterThanOrEqual(1);
  });

  it('classifies formal tone correctly', () => {
    const sent = [
      makeSummary({
        bodyPreview:
          'Dear Ms Smith,\nPlease kindly review the enclosed document pursuant to our agreement.\nSincerely',
      }),
    ];
    const profile = extractStyleProfile(sent);
    expect(profile.tone).toBe('formal');
  });

  it('ignores messages with empty bodyPreview', () => {
    const sent = [
      makeSummary({ bodyPreview: '' }),
      makeSummary({ bodyPreview: '' }),
    ];
    // Falls back to defaults since no usable bodies
    const profile = extractStyleProfile(sent);
    // Should not throw; greeting and signOff are still valid strings
    expect(typeof profile.greeting).toBe('string');
    expect(typeof profile.signOff).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// composeDraftReply
// ---------------------------------------------------------------------------

describe('composeDraftReply', () => {
  const inbound = makeSummary({
    from: 'Alice Smith <alice@example.com>',
    subject: 'Project update',
    bodyPreview: 'Hi, just checking in on the project status...',
  });
  const defaultProfile = extractStyleProfile([]);

  it('returns a draft with requiresBeforeSendReview = true', () => {
    const result = composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.requiresBeforeSendReview).toBe(true);
  });

  it('subject is prefixed with Re:', () => {
    const result = composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.subject).toMatch(/^Re:/i);
  });

  it('body includes greeting and sign-off', () => {
    const result = composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.body).toContain(defaultProfile.greeting);
    expect(result.body).toContain(defaultProfile.signOff);
  });

  it('body includes extracted sender first name', () => {
    const result = composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.body).toContain('Alice');
  });

  it('weaves context into the draft body', () => {
    const result = composeDraftReply(
      inbound,
      defaultProfile,
      'The milestone is on track and details follow Friday.',
      testContainsSecretLikeText,
    );
    expect(result.body).toContain('The milestone is on track');
  });

  it('reviewBoundary mentions confirm:true', () => {
    const result = composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.reviewBoundary).toContain('confirm:true');
  });

  it('returns the profile used', () => {
    const result = composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.profile).toBe(defaultProfile);
  });

  it('throws when context contains secret-like text', () => {
    expect(() =>
      composeDraftReply(inbound, defaultProfile, 'token: abc123secretpassword', testContainsSecretLikeText),
    ).toThrow(/secret-like text/);
  });

  it('is deterministic — same inputs produce identical output', () => {
    const a = composeDraftReply(inbound, defaultProfile, 'some context', testContainsSecretLikeText);
    const b = composeDraftReply(inbound, defaultProfile, 'some context', testContainsSecretLikeText);
    expect(a.body).toBe(b.body);
    expect(a.subject).toBe(b.subject);
  });

  it('body does not contain secret-like text for normal inputs', () => {
    const result = composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    // Verify the body passes the assertNoSecretLikeText check indirectly
    // (no throw means it passed during composition)
    expect(result.body).toBeTruthy();
  });

  it('handles inbound with no sender name gracefully', () => {
    const noName = makeSummary({ from: 'noreply@example.com', subject: 'Alert' });
    const result = composeDraftReply(noName, defaultProfile, '', testContainsSecretLikeText);
    expect(result.body).toBeTruthy();
    expect(result.requiresBeforeSendReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// styleReplyWorkflowStatus
// ---------------------------------------------------------------------------

describe('styleReplyWorkflowStatus', () => {
  it('returns ready when email capability is available', () => {
    expect(styleReplyWorkflowStatus(true)).toBe('ready');
  });

  it('returns needs-setup when email capability is absent', () => {
    expect(styleReplyWorkflowStatus(false)).toBe('needs-setup');
  });
});

// ---------------------------------------------------------------------------
// styleReplyWorkflow
// ---------------------------------------------------------------------------

describe('styleReplyWorkflow', () => {
  it('has correct id', () => {
    const wf = styleReplyWorkflow(true);
    expect(wf.id).toBe('inbox-style-matched-draft-reply');
  });

  it('is ready when capability is available', () => {
    const wf = styleReplyWorkflow(true);
    expect(wf.status).toBe('ready');
  });

  it('is needs-setup when capability is absent', () => {
    const wf = styleReplyWorkflow(false);
    expect(wf.status).toBe('needs-setup');
  });

  it('runBoundary mentions local-only effect', () => {
    const wf = styleReplyWorkflow(true);
    expect(wf.runBoundary.toLowerCase()).toContain('local');
  });

  it('runBoundary mentions confirmed send', () => {
    const wf = styleReplyWorkflow(true);
    expect(wf.runBoundary.toLowerCase()).toContain('confirmed');
  });

  it('is deterministic — same capability produces identical descriptor', () => {
    const a = styleReplyWorkflow(true);
    const b = styleReplyWorkflow(true);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// styleReplyLiveRecord
// ---------------------------------------------------------------------------

describe('styleReplyLiveRecord', () => {
  it('has id inbox-style-reply-draft', () => {
    const rec = styleReplyLiveRecord(true);
    expect(rec.id).toBe('inbox-style-reply-draft');
  });

  it('effect is read-only (local composition, no provider write)', () => {
    const rec = styleReplyLiveRecord(true);
    expect(rec.effect).toBe('read-only');
  });

  it('confirmationRequired is false for local composition', () => {
    const rec = styleReplyLiveRecord(true);
    expect(rec.confirmationRequired).toBe(false);
  });

  it('follow-up send route has confirmationRequired = true', () => {
    const rec = styleReplyLiveRecord(true);
    const sendRoute = rec.followUpRoutes?.find((r) => r.id === 'send-after-review');
    expect(sendRoute).toBeDefined();
    expect(sendRoute!.requiresConfirmation).toBe(true);
  });

  it('follow-up send route effect is confirmed-effect', () => {
    const rec = styleReplyLiveRecord(true);
    const sendRoute = rec.followUpRoutes?.find((r) => r.id === 'send-after-review');
    expect(sendRoute!.effect).toBe('confirmed-effect');
  });

  it('is needs-setup when capability absent', () => {
    const rec = styleReplyLiveRecord(false);
    expect(rec.status).toBe('needs-setup');
  });
});

// ---------------------------------------------------------------------------
// buildStyleReplyLaneAdditions
// ---------------------------------------------------------------------------

describe('buildStyleReplyLaneAdditions', () => {
  it('returns both workflow and liveRecord', () => {
    const additions = buildStyleReplyLaneAdditions(true);
    expect(additions.workflow).toBeDefined();
    expect(additions.liveRecord).toBeDefined();
  });

  it('workflow and liveRecord have consistent status', () => {
    const additions = buildStyleReplyLaneAdditions(true);
    expect(additions.liveRecord.status).toBe(additions.workflow.status);
  });

  it('is deterministic — two calls with same arg produce equal results', () => {
    const a = buildStyleReplyLaneAdditions(false);
    const b = buildStyleReplyLaneAdditions(false);
    expect(a).toEqual(b);
  });
});
