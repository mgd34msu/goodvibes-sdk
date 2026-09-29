/**
 * github, dark and light (Primer primitives, github.com/primer/primitives).
 *
 * Authored from the official published palette. Values that miss a contrast
 * floor against the panel carry the smallest adjustment that reaches it; each
 * one is noted beside its token with the published value.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const GITHUB_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#58a6ff', light: '#0969da' },
    secondary: { dark: '#a371f7', light: '#8250df' },
    accent: { dark: '#39c5cf', light: '#1b7c83' },
    error: { dark: '#f85149', light: '#d1242f' },
    warning: { dark: '#d29922', light: '#9a6700' },
    success: { dark: '#3fb950', light: '#1a7f37' },
    info: { dark: '#58a6ff', light: '#0969da' },
    text: { dark: '#e6edf3', light: '#1f2328' },
    textMuted: { dark: '#7d8590', light: '#656d76' },
    // dark: published #484f58 is 2.09:1 on the panel; adjusted to reach 2.5:1.
    textFaint: { dark: '#555b64', light: '#8c959f' },
    selectedListItemText: { dark: '#0d1117', light: '#ffffff' },
    background: { dark: '#0d1117', light: '#ffffff' },
    backgroundPanel: { dark: '#161b22', light: '#f6f8fa' },
    backgroundElement: { dark: '#21262d', light: '#eaeef2' },
    backgroundMenu: { dark: '#21262d', light: '#eaeef2' },
    border: { dark: '#30363d', light: '#d0d7de' },
    borderActive: { dark: '#8b949e', light: '#57606a' },
    borderSubtle: { dark: '#21262d', light: '#eaeef2' },
    reasoning: { dark: '#a371f7', light: '#8250df' },
    diffAdded: { dark: '#3fb950', light: '#1a7f37' },
    diffRemoved: { dark: '#f85149', light: '#d1242f' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#58a6ff', light: '#0969da' },
    diffHighlightAdded: { dark: '#56d364', light: '#116329' },
    diffHighlightRemoved: { dark: '#ff7b72', light: '#a40e26' },
    diffAddedBg: { dark: '#183624', light: '#dfede3' },
    diffRemovedBg: { dark: '#411f22', light: '#f9e0e2' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#1f3e2c', light: '#d7e7df' },
    diffRemovedLineNumberBg: { dark: '#48272b', light: '#f1dade' },
    markdownText: 'text',
    markdownHeading: { dark: '#58a6ff', light: '#0969da' },
    markdownLink: { dark: '#58a6ff', light: '#0969da' },
    markdownLinkText: { dark: '#58a6ff', light: '#0969da' },
    markdownCode: { dark: '#a5d6ff', light: '#0a3069' },
    markdownBlockQuote: { dark: '#8b949e', light: '#656d76' },
    markdownEmph: { dark: '#d2a8ff', light: '#8250df' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#30363d', light: '#d0d7de' },
    markdownListItem: { dark: '#ffa657', light: '#953800' },
    markdownListEnumeration: { dark: '#ffa657', light: '#953800' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#8b949e', light: '#6e7781' },
    syntaxKeyword: { dark: '#ff7b72', light: '#cf222e' },
    syntaxFunction: { dark: '#d2a8ff', light: '#8250df' },
    syntaxVariable: { dark: '#ffa657', light: '#953800' },
    syntaxString: { dark: '#a5d6ff', light: '#0a3069' },
    syntaxNumber: { dark: '#79c0ff', light: '#0550ae' },
    syntaxType: { dark: '#ffa657', light: '#953800' },
    syntaxOperator: { dark: '#ff7b72', light: '#cf222e' },
    syntaxPunctuation: { dark: '#e6edf3', light: '#1f2328' },
    syntaxProperty: { dark: '#79c0ff', light: '#0550ae' },
    syntaxBuiltin: { dark: '#79c0ff', light: '#0550ae' },
  },
};
