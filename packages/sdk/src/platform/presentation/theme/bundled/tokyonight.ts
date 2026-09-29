/**
 * tokyonight, dark = Night, light = Day (github.com/folke/tokyonight.nvim).
 *
 * Authored from the official published palette. Values that miss a contrast
 * floor against the panel carry the smallest adjustment that reaches it; each
 * one is noted beside its token with the published value.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const TOKYONIGHT_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#7aa2f7', light: '#2e7de9' },
    secondary: { dark: '#bb9af7', light: '#9854f1' },
    accent: { dark: '#ff9e64', light: '#b15c00' },
    error: { dark: '#f7768e', light: '#f52a65' },
    warning: { dark: '#e0af68', light: '#8c6c3e' },
    success: { dark: '#9ece6a', light: '#587539' },
    info: { dark: '#7dcfff', light: '#007197' },
    // light: published #3760bf is 4.52:1 on the panel; adjusted to reach 7:1.
    text: { dark: '#c0caf5', light: '#28458a' },
    // light: published #6172b0 is 3.57:1 on the panel; adjusted to reach 4.5:1.
    textMuted: { dark: '#a9b1d6', light: '#536297' },
    // light: published #8990b3 is 2.42:1 on the panel; adjusted to reach 2.5:1.
    textFaint: { dark: '#565f89', light: '#868daf' },
    selectedListItemText: { dark: '#1a1b26', light: '#e1e2e7' },
    background: { dark: '#1a1b26', light: '#e1e2e7' },
    backgroundPanel: { dark: '#16161e', light: '#e1e2e7' },
    backgroundElement: { dark: '#292e42', light: '#d0d5e3' },
    backgroundMenu: { dark: '#292e42', light: '#d0d5e3' },
    border: { dark: '#3b4261', light: '#a8aecb' },
    borderActive: { dark: '#545c7e', light: '#68709a' },
    borderSubtle: { dark: '#292e42', light: '#c4c8da' },
    reasoning: { dark: '#bb9af7', light: '#9854f1' },
    diffAdded: { dark: '#9ece6a', light: '#587539' },
    diffRemoved: { dark: '#f7768e', light: '#f52a65' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#7aa2f7', light: '#2e7de9' },
    diffHighlightAdded: { dark: '#73daca', light: '#387068' },
    diffHighlightRemoved: { dark: '#db4b4b', light: '#c64343' },
    diffAddedBg: { dark: '#374235', light: '#ced3cf' },
    diffRemovedBg: { dark: '#4b2f3d', light: '#e4c8d5' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#343e2f', light: '#ced3cf' },
    diffRemovedLineNumberBg: { dark: '#482b37', light: '#e4c8d5' },
    markdownText: 'text',
    markdownHeading: { dark: '#7aa2f7', light: '#2e7de9' },
    markdownLink: { dark: '#7aa2f7', light: '#2e7de9' },
    markdownLinkText: { dark: '#7dcfff', light: '#007197' },
    markdownCode: { dark: '#9ece6a', light: '#587539' },
    markdownBlockQuote: { dark: '#a9b1d6', light: '#6172b0' },
    markdownEmph: { dark: '#e0af68', light: '#8c6c3e' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#565f89', light: '#8990b3' },
    markdownListItem: { dark: '#ff9e64', light: '#b15c00' },
    markdownListEnumeration: { dark: '#ff9e64', light: '#b15c00' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#565f89', light: '#848cb5' },
    syntaxKeyword: { dark: '#9d7cd8', light: '#7847bd' },
    syntaxFunction: { dark: '#7aa2f7', light: '#2e7de9' },
    syntaxVariable: { dark: '#c0caf5', light: '#3760bf' },
    syntaxString: { dark: '#9ece6a', light: '#587539' },
    syntaxNumber: { dark: '#ff9e64', light: '#b15c00' },
    syntaxType: { dark: '#2ac3de', light: '#188092' },
    syntaxOperator: { dark: '#89ddff', light: '#006a83' },
    syntaxPunctuation: { dark: '#89ddff', light: '#006a83' },
    syntaxProperty: { dark: '#73daca', light: '#387068' },
    syntaxBuiltin: { dark: '#f7768e', light: '#f52a65' },
  },
};
