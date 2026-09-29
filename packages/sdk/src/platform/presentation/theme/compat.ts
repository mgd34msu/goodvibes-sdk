/**
 * compat.ts, the bridge from a resolved theme to the legacy TONE_TOKENS /
 * DIFF_TONES shapes, so consumers can switch one read site at a time.
 *
 * Every legacy role maps to exactly one theme token (no blending here: the
 * blending lives in the theme's own derived fallbacks, see resolve.ts), so a
 * theme that sets those tokens explicitly reproduces the legacy table exactly.
 * The neon theme does, see test/platform-presentation-theme.test.ts.
 */

import type { ToneTokens } from '../tones.js';
import type { ThemeTokens } from './types.js';

/** The DIFF_TONES shape with plain string values. */
export interface DiffToneTokens {
  readonly add: string;
  readonly del: string;
  readonly hunk: string;
}

/** Map resolved theme tokens onto the TONE_TOKENS shape. */
export function themeToTones(tokens: ThemeTokens): ToneTokens {
  return {
    fg: {
      primary: tokens.text,
      secondary: tokens.textSecondary,
      muted: tokens.textMuted,
      dim: tokens.textFaint,
      inverse: tokens.selectedListItemText,
      empty: tokens.textPlaceholder,
    },
    bg: {
      base: tokens.backgroundBase,
      surface: tokens.backgroundPanel,
      title: tokens.backgroundTitle,
      section: tokens.backgroundSection,
      summary: tokens.backgroundSummary,
      selected: tokens.backgroundSelected,
      input: tokens.backgroundInput,
      warning: tokens.backgroundWarning,
      error: tokens.backgroundError,
      success: tokens.backgroundSuccess,
      footer: tokens.backgroundFooter,
    },
    state: {
      info: tokens.info,
      good: tokens.success,
      warn: tokens.warning,
      bad: tokens.error,
      blocked: tokens.blocked,
      active: tokens.active,
      reasoning: tokens.reasoning,
    },
    accent: {
      browser: tokens.panelBrowser,
      control: tokens.panelControl,
      inspector: tokens.panelInspector,
      workflow: tokens.panelWorkflow,
      conversation: tokens.panelConversation,
      brand: tokens.brand,
      gradientStart: tokens.brand,
      gradientEnd: tokens.brandEnd,
    },
    border: tokens.border,
    chrome: {
      label: tokens.textMuted,
      faint: tokens.textFaint,
      warn: tokens.warning,
      bad: tokens.error,
      good: tokens.success,
      remote: tokens.remote,
    },
  };
}

/** Map resolved theme tokens onto the DIFF_TONES shape. */
export function themeToDiffTones(tokens: ThemeTokens): DiffToneTokens {
  return {
    add: tokens.diffAdded,
    del: tokens.diffRemoved,
    hunk: tokens.diffHunkHeader,
  };
}
