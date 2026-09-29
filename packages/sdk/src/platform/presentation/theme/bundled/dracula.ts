/**
 * dracula, dark = Dracula, light = Alucard (draculatheme.com/spec).
 *
 * Authored from the official published palette. Values that miss a contrast
 * floor against the panel carry the smallest adjustment that reaches it; each
 * one is noted beside its token with the published value.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const DRACULA_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#bd93f9', light: '#644ac9' },
    secondary: { dark: '#ff79c6', light: '#a3144d' },
    accent: { dark: '#8be9fd', light: '#036a96' },
    error: { dark: '#ff5555', light: '#cb3a2a' },
    warning: { dark: '#ffb86c', light: '#a34d14' },
    success: { dark: '#50fa7b', light: '#14710a' },
    info: { dark: '#8be9fd', light: '#036a96' },
    text: { dark: '#f8f8f2', light: '#1f1f1f' },
    // dark: published #6272a4 is 3.36:1 on the panel; adjusted to reach 4.5:1.
    textMuted: { dark: '#7b89b3', light: '#6c664b' },
    textFaint: { dark: '#6272a4', light: '#a39f8a' },
    selectedListItemText: { dark: '#282a36', light: '#fffbeb' },
    background: { dark: '#282a36', light: '#fffbeb' },
    backgroundPanel: { dark: '#21222c', light: '#fffbeb' },
    backgroundElement: { dark: '#44475a', light: '#efebd8' },
    backgroundMenu: { dark: '#343746', light: '#efebd8' },
    border: { dark: '#44475a', light: '#cfcfde' },
    borderActive: { dark: '#6272a4', light: '#6c664b' },
    borderSubtle: { dark: '#343746', light: '#e6e2cf' },
    reasoning: { dark: '#bd93f9', light: '#644ac9' },
    diffAdded: { dark: '#50fa7b', light: '#14710a' },
    diffRemoved: { dark: '#ff5555', light: '#cb3a2a' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#bd93f9', light: '#644ac9' },
    diffHighlightAdded: { dark: '#69ff94', light: '#0e5a07' },
    diffHighlightRemoved: { dark: '#ff6e6e', light: '#a8281c' },
    diffAddedBg: { dark: '#315845', light: '#dee8cc' },
    diffRemovedBg: { dark: '#57333d', light: '#f8e0d0' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#2b523d', light: '#dee8cc' },
    diffRemovedLineNumberBg: { dark: '#522d35', light: '#f8e0d0' },
    markdownText: 'text',
    markdownHeading: { dark: '#bd93f9', light: '#644ac9' },
    markdownLink: { dark: '#8be9fd', light: '#036a96' },
    markdownLinkText: { dark: '#ff79c6', light: '#a3144d' },
    markdownCode: { dark: '#50fa7b', light: '#14710a' },
    markdownBlockQuote: { dark: '#f1fa8c', light: '#846e15' },
    markdownEmph: { dark: '#f1fa8c', light: '#846e15' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#6272a4', light: '#6c664b' },
    markdownListItem: { dark: '#8be9fd', light: '#036a96' },
    markdownListEnumeration: { dark: '#8be9fd', light: '#036a96' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#6272a4', light: '#6c664b' },
    syntaxKeyword: { dark: '#ff79c6', light: '#a3144d' },
    syntaxFunction: { dark: '#50fa7b', light: '#14710a' },
    syntaxVariable: { dark: '#f8f8f2', light: '#1f1f1f' },
    syntaxString: { dark: '#f1fa8c', light: '#846e15' },
    syntaxNumber: { dark: '#bd93f9', light: '#644ac9' },
    syntaxType: { dark: '#8be9fd', light: '#036a96' },
    syntaxOperator: { dark: '#ff79c6', light: '#a3144d' },
    syntaxPunctuation: { dark: '#f8f8f2', light: '#1f1f1f' },
    syntaxProperty: { dark: '#ffb86c', light: '#a34d14' },
    syntaxBuiltin: { dark: '#bd93f9', light: '#644ac9' },
  },
};
