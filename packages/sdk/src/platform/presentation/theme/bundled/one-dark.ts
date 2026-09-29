/**
 * one-dark, dark only (Atom One Dark, github.com/atom/atom one-dark-syntax).
 *
 * Authored from the official published palette. Values that miss a contrast
 * floor against the panel carry the smallest adjustment that reaches it; each
 * one is noted beside its token with the published value.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const ONE_DARK_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: '#61afef',
    secondary: '#c678dd',
    accent: '#d19a66',
    error: '#e06c75',
    warning: '#e5c07b',
    success: '#98c379',
    info: '#56b6c2',
    text: '#abb2bf',
    // dark: published #7f848e is 4.10:1 on the panel; adjusted to reach 4.5:1.
    textMuted: '#878b95',
    textFaint: '#5c6370',
    selectedListItemText: '#282c34',
    background: '#282c34',
    backgroundPanel: '#21252b',
    backgroundElement: '#2c313a',
    backgroundMenu: '#2c313a',
    border: '#3e4451',
    borderActive: '#5c6370',
    borderSubtle: '#2c313a',
    reasoning: '#c678dd',
    diffAdded: '#98c379',
    diffRemoved: '#e06c75',
    diffContext: 'textMuted',
    diffHunkHeader: '#61afef',
    diffHighlightAdded: '#98c379',
    diffHighlightRemoved: '#be5046',
    diffAddedBg: '#414d43',
    diffRemovedBg: '#503a42',
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: '#3b483c',
    diffRemovedLineNumberBg: '#4b353b',
    markdownText: 'text',
    markdownHeading: '#e06c75',
    markdownLink: '#61afef',
    markdownLinkText: '#56b6c2',
    markdownCode: '#98c379',
    markdownBlockQuote: '#5c6370',
    markdownEmph: '#c678dd',
    markdownStrong: 'text',
    markdownHorizontalRule: '#5c6370',
    markdownListItem: '#e06c75',
    markdownListEnumeration: '#d19a66',
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: '#5c6370',
    syntaxKeyword: '#c678dd',
    syntaxFunction: '#61afef',
    syntaxVariable: '#e06c75',
    syntaxString: '#98c379',
    syntaxNumber: '#d19a66',
    syntaxType: '#e5c07b',
    syntaxOperator: '#56b6c2',
    syntaxPunctuation: '#abb2bf',
    syntaxProperty: '#e06c75',
    syntaxBuiltin: '#e5c07b',
  },
};
