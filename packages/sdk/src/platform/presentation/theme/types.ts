/**
 * types.ts, the theme-file format and the resolved token table.
 *
 * The file format is opencode-compatible: an opencode theme JSON resolves here
 * unchanged. GoodVibes adds optional keys on top, each with a derived fallback
 * (see resolve.ts), so an opencode file still produces a complete table.
 */

import type { ThemeMode } from '../tones.js';

export type { ThemeMode };

/** A mode-specific pair: each side is a hex literal, a reference name or an ANSI index. */
export interface ThemeVariantValue {
  readonly dark: string | number;
  readonly light: string | number;
}

/**
 * One color value in a theme file:
 *  - '#rgb' / '#rrggbb' / '#rrggbbaa' literal;
 *  - a reference name, resolved against `defs` first and then other tokens;
 *  - 'transparent' or 'none', meaning "terminal default background" (resolves to '');
 *  - an integer 0..255, an xterm ANSI color index;
 *  - `{ dark, light }`, one of the above per mode.
 */
export type ThemeColorValue = string | number | ThemeVariantValue;

/** The token names opencode themes define, verbatim. */
export type OpencodeColorKey =
  | 'primary' | 'secondary' | 'accent'
  | 'error' | 'warning' | 'success' | 'info'
  | 'text' | 'textMuted' | 'selectedListItemText'
  | 'background' | 'backgroundPanel' | 'backgroundElement' | 'backgroundMenu'
  | 'border' | 'borderActive' | 'borderSubtle'
  | 'diffAdded' | 'diffRemoved' | 'diffContext' | 'diffHunkHeader'
  | 'diffHighlightAdded' | 'diffHighlightRemoved'
  | 'diffAddedBg' | 'diffRemovedBg' | 'diffContextBg' | 'diffLineNumber'
  | 'diffAddedLineNumberBg' | 'diffRemovedLineNumberBg'
  | 'markdownText' | 'markdownHeading' | 'markdownLink' | 'markdownLinkText'
  | 'markdownCode' | 'markdownBlockQuote' | 'markdownEmph' | 'markdownStrong'
  | 'markdownHorizontalRule' | 'markdownListItem' | 'markdownListEnumeration'
  | 'markdownImage' | 'markdownImageText' | 'markdownCodeBlock'
  | 'syntaxComment' | 'syntaxKeyword' | 'syntaxFunction' | 'syntaxVariable'
  | 'syntaxString' | 'syntaxNumber' | 'syntaxType' | 'syntaxOperator' | 'syntaxPunctuation';

/** Opencode keys a theme file may omit (opencode itself treats these as optional). */
export type OptionalOpencodeColorKey = 'selectedListItemText' | 'backgroundMenu';

/** GoodVibes color keys, all optional in a theme file, each with a derived fallback. */
export type GoodVibesColorKey =
  | 'textFaint' | 'textSecondary' | 'textPlaceholder'
  | 'backgroundBase' | 'backgroundTitle' | 'backgroundSection' | 'backgroundSummary'
  | 'backgroundSelected' | 'backgroundInput' | 'backgroundFooter' | 'backgroundCode'
  | 'backgroundWarning' | 'backgroundError' | 'backgroundSuccess'
  | 'brand' | 'brandEnd' | 'reasoning' | 'blocked' | 'remote' | 'active'
  | 'panelBrowser' | 'panelControl' | 'panelInspector' | 'panelWorkflow' | 'panelConversation'
  | 'syntaxProperty' | 'syntaxBuiltin'
  | 'searchMatchBg' | 'searchCurrentBg';

/** Every color token name in a resolved theme. */
export type ThemeColorKey = OpencodeColorKey | GoodVibesColorKey;

/** The `theme` block of a theme file. */
export type ThemeJsonTokens = {
  readonly [K in Exclude<OpencodeColorKey, OptionalOpencodeColorKey>]: ThemeColorValue;
} & {
  readonly [K in OptionalOpencodeColorKey | GoodVibesColorKey]?: ThemeColorValue;
} & {
  /** Agent/lane colors, in order. Fallback: [primary, accent, secondary, info, success, warning]. */
  readonly lanes?: readonly ThemeColorValue[];
  /** Opacity for reasoning/thinking text, 0..1. Default 0.6. */
  readonly thinkingOpacity?: number;
};

/** A theme file (opencode-compatible). */
export interface ThemeJson {
  readonly $schema?: string;
  readonly defs?: Readonly<Record<string, ThemeColorValue>>;
  readonly theme: ThemeJsonTokens;
}

/**
 * A resolved theme for one mode. Every color is lowercase '#rrggbb', or ''
 * meaning "leave the terminal's default background" (only produced by a
 * 'transparent' / 'none' value, in practice `background`).
 */
export type ThemeTokens = {
  readonly [K in ThemeColorKey]: string;
} & {
  readonly lanes: readonly string[];
  readonly thinkingOpacity: number;
};

/**
 * A probed terminal palette, the input to generateSystemTheme. Every entry is
 * a hex color or undefined when the terminal did not answer for that slot.
 */
export interface TerminalPalette {
  readonly background?: string;
  readonly foreground?: string;
  /** ANSI slots 0..15. Missing or non-hex entries fall back to xterm defaults. */
  readonly ansi: ReadonlyArray<string | undefined>;
}

/** One entry of the bundled-theme catalog. */
export interface BundledTheme {
  readonly name: string;
  readonly label: string;
  readonly variants: readonly ThemeMode[];
  readonly json: ThemeJson;
}

/** The opencode token names, in opencode's order. */
export function opencodeColorKeys(): readonly OpencodeColorKey[] {
  return [
    'primary', 'secondary', 'accent', 'error', 'warning', 'success', 'info',
    'text', 'textMuted', 'selectedListItemText',
    'background', 'backgroundPanel', 'backgroundElement', 'backgroundMenu',
    'border', 'borderActive', 'borderSubtle',
    'diffAdded', 'diffRemoved', 'diffContext', 'diffHunkHeader',
    'diffHighlightAdded', 'diffHighlightRemoved',
    'diffAddedBg', 'diffRemovedBg', 'diffContextBg', 'diffLineNumber',
    'diffAddedLineNumberBg', 'diffRemovedLineNumberBg',
    'markdownText', 'markdownHeading', 'markdownLink', 'markdownLinkText',
    'markdownCode', 'markdownBlockQuote', 'markdownEmph', 'markdownStrong',
    'markdownHorizontalRule', 'markdownListItem', 'markdownListEnumeration',
    'markdownImage', 'markdownImageText', 'markdownCodeBlock',
    'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable',
    'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation',
  ];
}

/** The GoodVibes extension token names. */
export function goodVibesColorKeys(): readonly GoodVibesColorKey[] {
  return [
    'textFaint', 'textSecondary', 'textPlaceholder',
    'backgroundBase', 'backgroundTitle', 'backgroundSection', 'backgroundSummary',
    'backgroundSelected', 'backgroundInput', 'backgroundFooter', 'backgroundCode',
    'backgroundWarning', 'backgroundError', 'backgroundSuccess',
    'brand', 'brandEnd', 'reasoning', 'blocked', 'remote', 'active',
    'panelBrowser', 'panelControl', 'panelInspector', 'panelWorkflow', 'panelConversation',
    'syntaxProperty', 'syntaxBuiltin',
    'searchMatchBg', 'searchCurrentBg',
  ];
}

/** Every color token name of ThemeTokens (opencode names first, then GoodVibes). */
export function themeColorKeys(): readonly ThemeColorKey[] {
  return [...opencodeColorKeys(), ...goodVibesColorKeys()];
}
