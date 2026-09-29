/**
 * gruvbox, dark and light (github.com/morhetz/gruvbox).
 *
 * Authored from the official published palette. Values that miss a contrast
 * floor against the panel carry the smallest adjustment that reaches it; each
 * one is noted beside its token with the published value.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const GRUVBOX_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#83a598', light: '#076678' },
    secondary: { dark: '#d3869b', light: '#8f3f71' },
    accent: { dark: '#fe8019', light: '#af3a03' },
    error: { dark: '#fb4934', light: '#9d0006' },
    warning: { dark: '#fabd2f', light: '#b57614' },
    success: { dark: '#b8bb26', light: '#79740e' },
    info: { dark: '#8ec07c', light: '#427b58' },
    text: { dark: '#ebdbb2', light: '#3c3836' },
    // light: published #7c6f64 is 4.42:1 on the panel; adjusted to reach 4.5:1.
    textMuted: { dark: '#a89984', light: '#7a6d62' },
    textFaint: { dark: '#7c6f64', light: '#a89984' },
    selectedListItemText: { dark: '#282828', light: '#fbf1c7' },
    background: { dark: '#282828', light: '#fbf1c7' },
    backgroundPanel: { dark: '#1d2021', light: '#f9f5d7' },
    backgroundElement: { dark: '#3c3836', light: '#ebdbb2' },
    backgroundMenu: { dark: '#3c3836', light: '#ebdbb2' },
    border: { dark: '#504945', light: '#d5c4a1' },
    borderActive: { dark: '#7c6f64', light: '#a89984' },
    borderSubtle: { dark: '#3c3836', light: '#ebdbb2' },
    reasoning: { dark: '#d3869b', light: '#8f3f71' },
    diffAdded: { dark: '#b8bb26', light: '#79740e' },
    diffRemoved: { dark: '#fb4934', light: '#9d0006' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#83a598', light: '#076678' },
    diffHighlightAdded: { dark: '#b8bb26', light: '#98971a' },
    diffHighlightRemoved: { dark: '#fb4934', light: '#cc241d' },
    diffAddedBg: { dark: '#484828', light: '#e9e0ad' },
    diffRemovedBg: { dark: '#562f2b', light: '#eecfac' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#3f4222', light: '#e7e3bb' },
    diffRemovedLineNumberBg: { dark: '#4e2925', light: '#ecd3ba' },
    markdownText: 'text',
    markdownHeading: { dark: '#fabd2f', light: '#b57614' },
    markdownLink: { dark: '#83a598', light: '#076678' },
    markdownLinkText: { dark: '#8ec07c', light: '#427b58' },
    markdownCode: { dark: '#b8bb26', light: '#79740e' },
    markdownBlockQuote: '#928374',
    markdownEmph: { dark: '#d3869b', light: '#8f3f71' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#665c54', light: '#bdae93' },
    markdownListItem: { dark: '#83a598', light: '#076678' },
    markdownListEnumeration: { dark: '#83a598', light: '#076678' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: '#928374',
    syntaxKeyword: { dark: '#fb4934', light: '#9d0006' },
    syntaxFunction: { dark: '#b8bb26', light: '#79740e' },
    syntaxVariable: { dark: '#83a598', light: '#076678' },
    syntaxString: { dark: '#b8bb26', light: '#79740e' },
    syntaxNumber: { dark: '#d3869b', light: '#8f3f71' },
    syntaxType: { dark: '#fabd2f', light: '#b57614' },
    syntaxOperator: { dark: '#8ec07c', light: '#427b58' },
    syntaxPunctuation: { dark: '#ebdbb2', light: '#3c3836' },
    syntaxProperty: { dark: '#83a598', light: '#076678' },
    syntaxBuiltin: { dark: '#fe8019', light: '#af3a03' },
  },
};
