/**
 * rosepine, dark = main, light = dawn (rosepinetheme.com/palette).
 *
 * Authored from the official published palette. Values that miss a contrast
 * floor against the panel carry the smallest adjustment that reaches it; each
 * one is noted beside its token with the published value.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const ROSEPINE_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#ebbcba', light: '#d7827e' },
    secondary: { dark: '#c4a7e7', light: '#907aa9' },
    accent: { dark: '#9ccfd8', light: '#56949f' },
    error: { dark: '#eb6f92', light: '#b4637a' },
    // light: published #ea9d34 is 2.16:1 on the panel; adjusted to reach 3:1.
    warning: { dark: '#f6c177', light: '#c5842c' },
    success: { dark: '#9ccfd8', light: '#56949f' },
    info: { dark: '#c4a7e7', light: '#907aa9' },
    text: { dark: '#e0def4', light: '#575279' },
    // light: published #797593 is 4.23:1 on the panel; adjusted to reach 4.5:1.
    textMuted: { dark: '#908caa', light: '#74708d' },
    textFaint: { dark: '#6e6a86', light: '#9893a5' },
    selectedListItemText: { dark: '#191724', light: '#faf4ed' },
    background: { dark: '#191724', light: '#faf4ed' },
    backgroundPanel: { dark: '#1f1d2e', light: '#fffaf3' },
    backgroundElement: { dark: '#26233a', light: '#f2e9e1' },
    backgroundMenu: { dark: '#26233a', light: '#f2e9e1' },
    border: { dark: '#403d52', light: '#dfdad9' },
    borderActive: { dark: '#524f67', light: '#cecacd' },
    borderSubtle: { dark: '#21202e', light: '#f4ede8' },
    reasoning: { dark: '#c4a7e7', light: '#907aa9' },
    diffAdded: { dark: '#9ccfd8', light: '#56949f' },
    diffRemoved: { dark: '#eb6f92', light: '#b4637a' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#c4a7e7', light: '#907aa9' },
    diffHighlightAdded: { dark: '#9ccfd8', light: '#286983' },
    diffHighlightRemoved: { dark: '#eb6f92', light: '#b4637a' },
    diffAddedBg: { dark: '#363f4c', light: '#e3e7e2' },
    diffRemovedBg: { dark: '#472a3c', light: '#f0e0dd' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#3b4453', light: '#e7ece7' },
    diffRemovedLineNumberBg: { dark: '#4c2f44', light: '#f5e5e2' },
    markdownText: 'text',
    markdownHeading: { dark: '#c4a7e7', light: '#907aa9' },
    markdownLink: { dark: '#9ccfd8', light: '#56949f' },
    markdownLinkText: { dark: '#ebbcba', light: '#d7827e' },
    markdownCode: { dark: '#f6c177', light: '#ea9d34' },
    markdownBlockQuote: { dark: '#908caa', light: '#797593' },
    markdownEmph: { dark: '#f6c177', light: '#ea9d34' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#6e6a86', light: '#9893a5' },
    markdownListItem: { dark: '#9ccfd8', light: '#56949f' },
    markdownListEnumeration: { dark: '#9ccfd8', light: '#56949f' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#6e6a86', light: '#9893a5' },
    syntaxKeyword: { dark: '#31748f', light: '#286983' },
    syntaxFunction: { dark: '#ebbcba', light: '#d7827e' },
    syntaxVariable: { dark: '#e0def4', light: '#575279' },
    syntaxString: { dark: '#f6c177', light: '#ea9d34' },
    syntaxNumber: { dark: '#f6c177', light: '#ea9d34' },
    syntaxType: { dark: '#9ccfd8', light: '#56949f' },
    syntaxOperator: { dark: '#908caa', light: '#797593' },
    syntaxPunctuation: { dark: '#908caa', light: '#797593' },
    syntaxProperty: { dark: '#9ccfd8', light: '#56949f' },
    syntaxBuiltin: { dark: '#eb6f92', light: '#b4637a' },
  },
};
