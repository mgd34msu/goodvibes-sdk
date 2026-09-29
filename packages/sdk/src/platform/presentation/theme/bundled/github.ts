/**
 * github, dark and light (Primer primitives v11.10.0, github.com/primer/primitives).
 *
 * Sources: src/tokens/functional/color/{fgColor,bgColor,borderColor,syntax}.json5
 * resolved against src/tokens/base/color/{dark/dark,light/light}.json5 (dark = the
 * default dark mode, light = the default light mode).
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
    primary: { dark: '#4493f8', light: '#0969da' },
    secondary: { dark: '#ab7df8', light: '#8250df' },
    accent: { dark: '#39c5cf', light: '#1b7c83' },
    error: { dark: '#f85149', light: '#d1242f' },
    warning: { dark: '#d29922', light: '#9a6700' },
    success: { dark: '#3fb950', light: '#1a7f37' },
    info: { dark: '#4493f8', light: '#0969da' },
    text: { dark: '#f0f6fc', light: '#1f2328' },
    textMuted: { dark: '#9198a1', light: '#59636e' },
    textFaint: { dark: '#656c76', light: '#818b98' },
    selectedListItemText: { dark: '#0d1117', light: '#ffffff' },
    background: { dark: '#0d1117', light: '#ffffff' },
    backgroundPanel: { dark: '#151b23', light: '#f6f8fa' },
    backgroundElement: { dark: '#212830', light: '#eff2f5' },
    backgroundMenu: { dark: '#212830', light: '#eff2f5' },
    border: { dark: '#3d444d', light: '#d1d9e0' },
    borderActive: { dark: '#656c76', light: '#818b98' },
    borderSubtle: { dark: '#212830', light: '#eff2f5' },
    reasoning: { dark: '#ab7df8', light: '#8250df' },
    diffAdded: { dark: '#3fb950', light: '#1a7f37' },
    diffRemoved: { dark: '#f85149', light: '#d1242f' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#4493f8', light: '#0969da' },
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
    markdownBlockQuote: { dark: '#9198a1', light: '#59636e' },
    markdownEmph: { dark: '#d2a8ff', light: '#8250df' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#3d444d', light: '#d1d9e0' },
    markdownListItem: { dark: '#ffa657', light: '#953800' },
    markdownListEnumeration: { dark: '#ffa657', light: '#953800' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#9198a1', light: '#59636e' },
    syntaxKeyword: { dark: '#ff7b72', light: '#cf222e' },
    syntaxFunction: { dark: '#d2a8ff', light: '#8250df' },
    syntaxVariable: { dark: '#ffa657', light: '#953800' },
    syntaxString: { dark: '#a5d6ff', light: '#0a3069' },
    syntaxNumber: { dark: '#79c0ff', light: '#0550ae' },
    syntaxType: { dark: '#ffa657', light: '#953800' },
    syntaxOperator: { dark: '#ff7b72', light: '#cf222e' },
    syntaxPunctuation: { dark: '#f0f6fc', light: '#1f2328' },
    syntaxProperty: { dark: '#79c0ff', light: '#0550ae' },
    syntaxBuiltin: { dark: '#79c0ff', light: '#0550ae' },
  },
};
