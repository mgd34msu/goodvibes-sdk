/**
 * solarized, dark and light (ethanschoonover.com/solarized).
 *
 * Authored from the official published palette. Values that miss a contrast
 * floor against the panel carry the smallest adjustment that reaches it; each
 * one is noted beside its token with the published value.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const SOLARIZED_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: '#268bd2',
    secondary: '#6c71c4',
    accent: '#d33682',
    error: '#dc322f',
    // light: published #b58900 is 2.98:1 on the panel; adjusted to reach 3:1.
    warning: { dark: '#b58900', light: '#b38800' },
    // light: published #859900 is 2.97:1 on the panel; adjusted to reach 3:1.
    success: { dark: '#859900', light: '#849700' },
    // light: published #2aa198 is 2.93:1 on the panel; adjusted to reach 3:1.
    info: { dark: '#2aa198', light: '#299e95' },
    // dark: published #93a1a1 is 5.61:1 on the panel; adjusted to reach 7:1.
    // light: published #586e75 is 4.99:1 on the panel; adjusted to reach 7:1.
    text: { dark: '#a9b4b4', light: '#46575c' },
    // light: published #657b83 is 4.13:1 on the panel; adjusted to reach 4.5:1.
    textMuted: { dark: '#839496', light: '#5f747b' },
    // light: published #93a1a1 is 2.48:1 on the panel; adjusted to reach 2.5:1.
    textFaint: { dark: '#586e75', light: '#929f9f' },
    selectedListItemText: { dark: '#002b36', light: '#fdf6e3' },
    background: { dark: '#002b36', light: '#fdf6e3' },
    backgroundPanel: { dark: '#002b36', light: '#fdf6e3' },
    backgroundElement: { dark: '#073642', light: '#eee8d5' },
    backgroundMenu: { dark: '#073642', light: '#eee8d5' },
    border: { dark: '#586e75', light: '#93a1a1' },
    borderActive: { dark: '#839496', light: '#657b83' },
    borderSubtle: { dark: '#073642', light: '#eee8d5' },
    reasoning: '#6c71c4',
    diffAdded: '#859900',
    diffRemoved: '#dc322f',
    diffContext: 'textMuted',
    diffHunkHeader: '#268bd2',
    diffHighlightAdded: '#859900',
    diffHighlightRemoved: '#cb4b16',
    diffAddedBg: { dark: '#1d432a', light: '#ece9c3' },
    diffRemovedBg: { dark: '#302d34', light: '#f8dbca' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#1d432a', light: '#ece9c3' },
    diffRemovedLineNumberBg: { dark: '#302d34', light: '#f8dbca' },
    markdownText: 'text',
    markdownHeading: '#b58900',
    markdownLink: '#268bd2',
    markdownLinkText: '#2aa198',
    markdownCode: '#2aa198',
    markdownBlockQuote: { dark: '#839496', light: '#657b83' },
    markdownEmph: '#d33682',
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#586e75', light: '#93a1a1' },
    markdownListItem: '#268bd2',
    markdownListEnumeration: '#268bd2',
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#586e75', light: '#93a1a1' },
    syntaxKeyword: '#859900',
    syntaxFunction: '#268bd2',
    syntaxVariable: { dark: '#93a1a1', light: '#586e75' },
    syntaxString: '#2aa198',
    syntaxNumber: '#d33682',
    syntaxType: '#b58900',
    syntaxOperator: '#859900',
    syntaxPunctuation: { dark: '#839496', light: '#657b83' },
    syntaxProperty: '#268bd2',
    syntaxBuiltin: '#cb4b16',
  },
};
