import { describe, test, expect } from 'bun:test';
import { getTierPromptSupplement, getTierForContextWindow } from '@pellux/goodvibes-sdk/platform/providers';
import type { ModelTier } from '@pellux/goodvibes-sdk/platform/providers';

describe('getTierPromptSupplement', () => {
  test('premium tier returns empty string', () => {
    expect(getTierPromptSupplement('premium')).toBe('');
  });

  test('free tier supplement is longer than standard tier', () => {
    const free = getTierPromptSupplement('free');
    const standard = getTierPromptSupplement('standard');
    expect(free.length).toBeGreaterThan(standard.length);
  });

  test('free tier mentions tool call format', () => {
    const result = getTierPromptSupplement('free');
    expect(result).toContain('tool call');
  });

  test('free tier mentions multi-agent workflows', () => {
    const result = getTierPromptSupplement('free');
    expect(result.toLowerCase()).toContain('agent');
  });

  test('standard tier mentions required parameters', () => {
    const result = getTierPromptSupplement('standard');
    expect(result.toLowerCase()).toContain('parameter');
  });

  test('free tier is under 400 tokens (~1600 chars) to keep it concise', () => {
    // Rough heuristic: 1 token ≈ 4 chars. 400 tokens = ~1600 chars.
    const result = getTierPromptSupplement('free');
    expect(result.length).toBeLessThan(1600);
  });
});

// A person's conversation never gets the agent-run completion demand. Live run:
// an 8.2k-window model ('free' tier) in a TUI main session was told its final
// message MUST end with the JSON completion block and ended a reply to a person
// with {"status":"completed"}.
const REPORT_DEMAND = /completion (block|report)|json block|```json|no human watching/i;
const ALL_TIERS: ModelTier[] = ['free', 'standard', 'premium', 'subscription'];

describe('getTierPromptSupplement audience', () => {
  test('the default audience is the agent: every existing caller keeps its text', () => {
    for (const tier of ALL_TIERS) {
      expect(getTierPromptSupplement(tier, { audience: 'agent' })).toBe(getTierPromptSupplement(tier));
      expect(getTierPromptSupplement(tier, {})).toBe(getTierPromptSupplement(tier));
    }
    expect(getTierPromptSupplement('free')).toMatch(REPORT_DEMAND);
  });

  test('no tier asks a conversation for a JSON completion block or unattended behavior', () => {
    for (const tier of ALL_TIERS) {
      expect(getTierPromptSupplement(tier, { audience: 'conversation' })).not.toMatch(REPORT_DEMAND);
    }
  });

  test('the small-context conversation text keeps the tool-call guidance', () => {
    const text = getTierPromptSupplement('free', { audience: 'conversation' });
    expect(text).toContain('required parameters');
    expect(text).toContain('spawn all of them before waiting');
    expect(text).not.toBe(getTierPromptSupplement('free'));
  });

  test('larger tiers read the same for both audiences', () => {
    for (const tier of ['standard', 'premium', 'subscription'] as const) {
      expect(getTierPromptSupplement(tier, { audience: 'conversation' })).toBe(getTierPromptSupplement(tier));
    }
  });
});

describe('getTierForContextWindow', () => {
  test('small context (<32K) returns free tier', () => {
    expect(getTierForContextWindow(0)).toBe('free');
    expect(getTierForContextWindow(8_192)).toBe('free');
    expect(getTierForContextWindow(31_999)).toBe('free');
  });

  test('medium context (32K–128K) returns standard tier', () => {
    expect(getTierForContextWindow(32_000)).toBe('standard');
    expect(getTierForContextWindow(65_536)).toBe('standard');
    expect(getTierForContextWindow(128_000)).toBe('standard');
  });

  test('large context (>128K) returns premium tier', () => {
    expect(getTierForContextWindow(128_001)).toBe('premium');
    expect(getTierForContextWindow(200_000)).toBe('premium');
    expect(getTierForContextWindow(1_000_000)).toBe('premium');
  });
});
