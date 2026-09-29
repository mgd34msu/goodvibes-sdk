/**
 * goodvibes-neon, the pre-2026-09 GoodVibes look.
 *
 * Dark mirrors TONE_TOKENS / DIFF_TONES (tones.ts) role for role, plus the
 * TUI's transcript and syntax colors (goodvibes-tui src/renderer/code-block.ts
 * and syntax-highlighter.ts), so themeToTones(resolveTheme(neon, 'dark'))
 * reproduces TONE_TOKENS. One documented difference: textFaint (fg.dim and
 * chrome.faint) is lifted from #475569 to #4e5c6f, the smallest change that
 * reaches the 2.5:1 floor against the #161a22 panel.
 *
 * Light takes TONE_TOKENS_LIGHT's values where that table defines them
 * (chrome, state.info, reasoning, brand, gradient) and a slate/Tailwind light
 * scale for the surfaces TONE_TOKENS_LIGHT leaves dark.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const NEON_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#00ffff', light: '#0077aa' },
    secondary: { dark: '#d000ff', light: '#a21caf' },
    accent: { dark: '#a855f7', light: '#7c3aed' },
    error: { dark: '#ef4444', light: '#dc2626' },
    warning: { dark: '#f59e0b', light: '#b45309' },
    success: { dark: '#22c55e', light: '#15803d' },
    info: { dark: '#38bdf8', light: '#0369a1' },

    text: { dark: '#e2e8f0', light: '#0f172a' },
    textSecondary: { dark: '#cbd5e1', light: '#334155' },
    textMuted: { dark: '#94a3b8', light: '#64748b' },
    textFaint: { dark: '#4e5c6f', light: '#94a3b8' },
    textPlaceholder: { dark: '#334155', light: '#cbd5e1' },
    selectedListItemText: { dark: '#0f172a', light: '#ffffff' },

    background: 'transparent',
    backgroundBase: { dark: '#11131a', light: '#ffffff' },
    backgroundPanel: { dark: '#161a22', light: '#ffffff' },
    backgroundElement: { dark: '#1e293b', light: '#f1f5f9' },
    backgroundMenu: 'backgroundElement',
    backgroundTitle: { dark: '#0f172a', light: '#f8fafc' },
    backgroundSection: { dark: '#18202b', light: '#f1f5f9' },
    backgroundSummary: { dark: '#1b2430', light: '#eef2f7' },
    backgroundSelected: { dark: '#223049', light: '#dbeafe' },
    backgroundInput: { dark: '#1e293b', light: '#f1f5f9' },
    backgroundWarning: { dark: '#2b2116', light: '#fef3c7' },
    backgroundError: { dark: '#2a161b', light: '#fee2e2' },
    backgroundSuccess: { dark: '#14241b', light: '#dcfce7' },
    backgroundFooter: { dark: '#111827', light: '#f8fafc' },
    backgroundCode: { dark: '#0d0d0d', light: '#f8fafc' },

    border: { dark: '#64748b', light: '#cbd5e1' },
    borderActive: { dark: '#94a3b8', light: '#64748b' },
    borderSubtle: { dark: '#334155', light: '#e2e8f0' },

    brand: { dark: '#00ffff', light: '#0077aa' },
    brandEnd: { dark: '#d000ff', light: '#7c3aed' },
    reasoning: { dark: '#a855f7', light: '#7c3aed' },
    blocked: { dark: '#f97316', light: '#c2410c' },
    remote: { dark: '#a78bfa', light: '#6d28d9' },
    active: { dark: '#60a5fa', light: '#2563eb' },

    panelBrowser: { dark: '#7dd3fc', light: '#0369a1' },
    panelControl: { dark: '#22d3ee', light: '#0e7490' },
    panelInspector: { dark: '#c4b5fd', light: '#6d28d9' },
    panelWorkflow: { dark: '#fbbf24', light: '#b45309' },
    panelConversation: { dark: '#93c5fd', light: '#1d4ed8' },

    diffAdded: { dark: '#00ff88', light: '#15803d' },
    diffRemoved: { dark: '#ff4444', light: '#dc2626' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#88aaff', light: '#4f46e5' },
    diffHighlightAdded: { dark: '#66ffbb', light: '#166534' },
    diffHighlightRemoved: { dark: '#ff7777', light: '#b91c1c' },
    diffAddedBg: { dark: '#12291f', light: '#dcfce7' },
    diffRemovedBg: { dark: '#2a1518', light: '#fee2e2' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#0f2019', light: '#c9f0d6' },
    diffRemovedLineNumberBg: { dark: '#22121a', light: '#fbd0d0' },

    markdownText: 'text',
    markdownHeading: { dark: '#00ffff', light: '#0077aa' },
    markdownLink: { dark: '#00aaff', light: '#0369a1' },
    markdownLinkText: { dark: '#00ffff', light: '#0077aa' },
    markdownCode: { dark: '#ffcc00', light: '#b45309' },
    markdownBlockQuote: 'textMuted',
    markdownEmph: { dark: '#c4b5fd', light: '#6d28d9' },
    markdownStrong: 'text',
    markdownHorizontalRule: 'border',
    markdownListItem: 'textMuted',
    markdownListEnumeration: 'textMuted',
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',

    syntaxComment: { dark: '#666666', light: '#64748b' },
    syntaxKeyword: { dark: '#d000ff', light: '#a21caf' },
    syntaxFunction: { dark: '#00ffff', light: '#0077aa' },
    syntaxVariable: { dark: '#ffffff', light: '#0f172a' },
    syntaxString: { dark: '#00ff88', light: '#15803d' },
    syntaxNumber: { dark: '#ffcc00', light: '#b45309' },
    syntaxType: { dark: '#ff6b9d', light: '#be185d' },
    syntaxOperator: { dark: '#ffffff', light: '#334155' },
    syntaxPunctuation: { dark: '#ffffff', light: '#334155' },
    syntaxProperty: { dark: '#87ceeb', light: '#0369a1' },
    syntaxBuiltin: { dark: '#ff8c00', light: '#c2410c' },
  },
};
