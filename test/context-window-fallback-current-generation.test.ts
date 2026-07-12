/**
 * Confirms inferFallbackContextWindow() sizes the newly-discoverable current
 * generation of models sensibly (Claude 5 family, GPT-5.6 family) — required
 * by the model-lists-can-never-be-stale item so a brand-new model surfaced
 * by live discovery doesn't get mis-sized by a flat, unrelated default.
 */
import { describe, expect, test } from 'bun:test';
import { inferFallbackContextWindow } from '../packages/sdk/src/platform/providers/context-window-fallback.js';

describe('inferFallbackContextWindow — current-generation families', () => {
  test('Claude 5 family (Fable, Sonnet, Opus 4.8) sizes as the Anthropic 200k family, not the flat fallback', () => {
    expect(inferFallbackContextWindow('anthropic', 'claude-fable-5')).toBe(200_000);
    expect(inferFallbackContextWindow('anthropic', 'claude-sonnet-5')).toBe(200_000);
    expect(inferFallbackContextWindow('anthropic', 'claude-opus-4-8')).toBe(200_000);
    expect(inferFallbackContextWindow('anthropic', 'claude-haiku-4-5-20251001')).toBe(200_000);
  });

  test('GPT-5.6 family sizes as the GPT-5 400k family', () => {
    expect(inferFallbackContextWindow('openai', 'gpt-5.6')).toBe(400_000);
    expect(inferFallbackContextWindow('openai', 'gpt-5.6-sol')).toBe(400_000);
    expect(inferFallbackContextWindow('openai', 'gpt-5.6-terra')).toBe(400_000);
    expect(inferFallbackContextWindow('openai', 'gpt-5.6-luna')).toBe(400_000);
  });

  test('gemini family stays at the 1M gemini default regardless of generation suffix', () => {
    expect(inferFallbackContextWindow('gemini', 'gemini-3-pro')).toBe(1_000_000);
    expect(inferFallbackContextWindow('gemini', 'gemini-3.5-flash')).toBe(1_000_000);
  });

  test('an unrecognised provider/model still gets the conservative flat fallback, not zero', () => {
    expect(inferFallbackContextWindow('some-new-vendor', 'brand-new-model-nobody-has-seen')).toBe(128_000);
  });
});
