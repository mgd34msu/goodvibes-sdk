/**
 * nord, dark only (nordtheme.com/docs/colors-and-palettes; nord0..nord15 from
 * github.com/nordtheme/nord src/nord.css). The two text/border shades brighter
 * than nord3 (#616e88, #7b88a1) come from nordtheme/vim colors/nord.vim.
 *
 * Authored from the official published palette. Values that miss a contrast
 * floor against the panel carry the smallest adjustment that reaches it; each
 * one is noted beside its token with the published value.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const NORD_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: '#88c0d0',
    secondary: '#5e81ac',
    accent: '#b48ead',
    error: '#bf616a',
    warning: '#ebcb8b',
    success: '#a3be8c',
    info: '#81a1c1',
    text: '#eceff4',
    // dark: published #7b88a1 (nordtheme/vim nord3_gui_brightened, brightest step) is 3.50:1 on the panel; adjusted to reach 4.5:1.
    textMuted: '#919cb1',
    // dark: published #616e88 (nordtheme/vim nord3_gui_bright) is 2.43:1 on the panel; adjusted to reach 2.5:1.
    textFaint: '#64718a',
    selectedListItemText: '#2e3440',
    background: '#2e3440',
    backgroundPanel: '#2e3440',
    backgroundElement: '#3b4252',
    backgroundMenu: '#3b4252',
    border: '#434c5e',
    borderActive: '#616e88',
    borderSubtle: '#3b4252',
    reasoning: '#b48ead',
    diffAdded: '#a3be8c',
    diffRemoved: '#bf616a',
    diffContext: 'textMuted',
    diffHunkHeader: '#b48ead',
    diffHighlightAdded: '#a3be8c',
    diffHighlightRemoved: '#d08770',
    diffAddedBg: '#485251',
    diffRemovedBg: '#4e3e49',
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: '#485251',
    diffRemovedLineNumberBg: '#4e3e49',
    markdownText: 'text',
    markdownHeading: '#88c0d0',
    markdownLink: '#88c0d0',
    markdownLinkText: '#8fbcbb',
    markdownCode: '#a3be8c',
    markdownBlockQuote: '#a0a8b7',
    markdownEmph: '#ebcb8b',
    markdownStrong: 'text',
    markdownHorizontalRule: '#616e88',
    markdownListItem: '#88c0d0',
    markdownListEnumeration: '#b48ead',
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: '#616e88',
    syntaxKeyword: '#81a1c1',
    syntaxFunction: '#88c0d0',
    syntaxVariable: '#d8dee9',
    syntaxString: '#a3be8c',
    syntaxNumber: '#b48ead',
    syntaxType: '#8fbcbb',
    syntaxOperator: '#81a1c1',
    syntaxPunctuation: '#eceff4',
    syntaxProperty: '#8fbcbb',
    syntaxBuiltin: '#81a1c1',
  },
};
