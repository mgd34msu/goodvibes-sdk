/**
 * catppuccin, dark = Mocha, light = Latte (github.com/catppuccin/palette).
 *
 * Authored from the official published palette. Values that miss a contrast
 * floor against the panel carry the smallest adjustment that reaches it; each
 * one is noted beside its token with the published value.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const CATPPUCCIN_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#89b4fa', light: '#1e66f5' },
    secondary: { dark: '#cba6f7', light: '#8839ef' },
    accent: { dark: '#f5c2e7', light: '#ea76cb' },
    error: { dark: '#f38ba8', light: '#d20f39' },
    // light: published #df8e1d is 2.15:1 on the panel; adjusted to reach 3:1.
    warning: { dark: '#f9e2af', light: '#b97618' },
    // light: published #40a02b is 2.75:1 on the panel; adjusted to reach 3:1.
    success: { dark: '#a6e3a1', light: '#3d9829' },
    // light: published #04a5e5 is 2.30:1 on the panel; adjusted to reach 3:1.
    info: { dark: '#89dceb', light: '#038ec5' },
    // light: published #4c4f69 is 6.57:1 on the panel; adjusted to reach 7:1.
    text: { dark: '#cdd6f4', light: '#484b64' },
    // light: published #6c6f85 is 4.06:1 on the panel; adjusted to reach 4.5:1.
    textMuted: { dark: '#a6adc8', light: '#64677c' },
    // light: published #9ca0b0 is 2.14:1 on the panel; adjusted to reach 2.5:1.
    textFaint: { dark: '#6c7086', light: '#9093a2' },
    selectedListItemText: { dark: '#1e1e2e', light: '#eff1f5' },
    background: { dark: '#1e1e2e', light: '#eff1f5' },
    backgroundPanel: { dark: '#181825', light: '#e6e9ef' },
    backgroundElement: { dark: '#313244', light: '#dce0e8' },
    backgroundMenu: { dark: '#313244', light: '#dce0e8' },
    border: { dark: '#45475a', light: '#ccd0da' },
    borderActive: { dark: '#6c7086', light: '#9ca0b0' },
    borderSubtle: { dark: '#313244', light: '#dce0e8' },
    reasoning: { dark: '#cba6f7', light: '#8839ef' },
    diffAdded: { dark: '#a6e3a1', light: '#40a02b' },
    diffRemoved: { dark: '#f38ba8', light: '#d20f39' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#b4befe', light: '#7287fd' },
    diffHighlightAdded: { dark: '#94e2d5', light: '#179299' },
    diffHighlightRemoved: { dark: '#eba0ac', light: '#e64553' },
    diffAddedBg: { dark: '#3c4947', light: '#d7e6d9' },
    diffRemovedBg: { dark: '#4d3649', light: '#ebd1db' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#374540', light: '#cfdfd4' },
    diffRemovedLineNumberBg: { dark: '#483142', light: '#e3cad6' },
    markdownText: 'text',
    markdownHeading: { dark: '#89b4fa', light: '#1e66f5' },
    markdownLink: { dark: '#89b4fa', light: '#1e66f5' },
    markdownLinkText: { dark: '#b4befe', light: '#7287fd' },
    markdownCode: { dark: '#a6e3a1', light: '#40a02b' },
    markdownBlockQuote: { dark: '#a6adc8', light: '#6c6f85' },
    markdownEmph: { dark: '#f9e2af', light: '#df8e1d' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#6c7086', light: '#9ca0b0' },
    markdownListItem: { dark: '#94e2d5', light: '#179299' },
    markdownListEnumeration: { dark: '#94e2d5', light: '#179299' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#9399b2', light: '#7c7f93' },
    syntaxKeyword: { dark: '#cba6f7', light: '#8839ef' },
    syntaxFunction: { dark: '#89b4fa', light: '#1e66f5' },
    syntaxVariable: { dark: '#cdd6f4', light: '#4c4f69' },
    syntaxString: { dark: '#a6e3a1', light: '#40a02b' },
    syntaxNumber: { dark: '#fab387', light: '#fe640b' },
    syntaxType: { dark: '#f9e2af', light: '#df8e1d' },
    syntaxOperator: { dark: '#89dceb', light: '#04a5e5' },
    syntaxPunctuation: { dark: '#9399b2', light: '#7c7f93' },
    syntaxProperty: { dark: '#b4befe', light: '#7287fd' },
    syntaxBuiltin: { dark: '#f38ba8', light: '#d20f39' },
  },
};
