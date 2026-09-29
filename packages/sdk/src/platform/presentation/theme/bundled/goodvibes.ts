/**
 * goodvibes, the default theme (owner-approved palette, 2026-09).
 *
 * The background is transparent: GoodVibes paints on the terminal's own
 * background and uses the panel/element shades only for opaque surfaces.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const GOODVIBES_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#5ee0e6', light: '#007a83' },
    secondary: { dark: '#d18cf5', light: '#9a32c4' },
    accent: { dark: '#a99af7', light: '#6450d0' },
    error: { dark: '#f2767e', light: '#c8323c' },
    warning: { dark: '#f0b660', light: '#9a6400' },
    success: { dark: '#7ddcae', light: '#23824d' },
    info: { dark: '#7aa7f5', light: '#2e62c8' },

    text: { dark: '#e4e2ee', light: '#1c1b22' },
    textMuted: { dark: '#8e8ba3', light: '#62606d' },
    // Dark: the approved #5c5a70 measures 2.28:1 on the #232438 panel, below
    // the 2.5 floor; #636176 is the smallest lift that reaches it.
    textFaint: { dark: '#636176', light: '#9794a4' },
    selectedListItemText: { dark: '#10111a', light: '#ffffff' },

    background: 'transparent',
    backgroundPanel: { dark: '#232438', light: '#ffffff' },
    backgroundElement: { dark: '#2d2e48', light: '#eeecf3' },
    backgroundMenu: 'backgroundElement',
    backgroundSelected: { dark: '#273b42', light: '#d4e6e9' },

    border: { dark: '#3a3b57', light: '#dcd9e4' },
    borderActive: { dark: '#575463', light: '#aeaabb' },
    borderSubtle: { dark: '#2a2833', light: '#e9e7ef' },

    brand: { dark: '#5ee0e6', light: '#0077aa' },
    brandEnd: { dark: '#d18cf5', light: '#7c3aed' },
    reasoning: { dark: '#c08af0', light: '#7c3aed' },

    diffAdded: { dark: '#6fdcb0', light: '#23824d' },
    diffRemoved: { dark: '#f2767e', light: '#c8323c' },
    diffContext: 'textMuted',
    diffHunkHeader: 'info',
    diffHighlightAdded: { dark: '#a6f0cc', light: '#15693a' },
    diffHighlightRemoved: { dark: '#ff9aa0', light: '#a0222c' },
    diffAddedBg: { dark: '#1c3230', light: '#e3edea' },
    diffRemovedBg: { dark: '#3a2031', light: '#f8e8ec' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#172a2a', light: '#d6e6e0' },
    diffRemovedLineNumberBg: { dark: '#2f1a28', light: '#f0dbe1' },

    markdownText: 'text',
    markdownHeading: 'accent',
    markdownLink: { dark: '#7aa7f5', light: '#2e62c8' },
    markdownLinkText: 'primary',
    markdownCode: 'syntaxString',
    markdownBlockQuote: 'textMuted',
    markdownEmph: { dark: '#f0cf7a', light: '#8a6200' },
    markdownStrong: 'text',
    markdownHorizontalRule: 'textMuted',
    markdownListItem: 'textMuted',
    markdownListEnumeration: 'textMuted',
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',

    syntaxComment: { dark: '#6f6c85', light: '#8a8796' },
    syntaxKeyword: { dark: '#d18cf5', light: '#9a32c4' },
    syntaxFunction: { dark: '#5ee0e6', light: '#007a83' },
    syntaxVariable: 'text',
    syntaxString: { dark: '#9ee6a8', light: '#2d7d3a' },
    syntaxNumber: { dark: '#f5a97a', light: '#b04f12' },
    syntaxType: { dark: '#f0cf7a', light: '#8a6200' },
    syntaxOperator: { dark: '#8fb8f5', light: '#2e62c8' },
    syntaxPunctuation: 'text',

    lanes: ['primary', 'accent', 'secondary', 'info', 'success', 'warning'],
    thinkingOpacity: 0.6,
  },
};
