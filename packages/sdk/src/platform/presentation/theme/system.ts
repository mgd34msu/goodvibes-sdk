/**
 * system.ts, the `system` theme: generated from the user's own terminal colors.
 *
 * Consumers probe the terminal (OSC 10/11 for foreground/background, OSC 4 for
 * the 16 ANSI slots), pass what they got as a TerminalPalette, and resolve the
 * returned ThemeJson like any bundled theme. The background stays transparent
 * so the terminal's own background (including any transparency) shows through;
 * panels, elements and borders are a ramp stepped from the terminal background
 * toward its foreground. Every text and status color is pushed, only as far as
 * needed, to the same contrast floors the bundled themes meet against the panel.
 *
 * Pure and deterministic: the same palette and mode always produce the same file.
 */

import { ansiToHex, ensureContrast, isHexColor, mixHex, normalizeHex, relativeLuminance, tint } from './color.js';
import type { TerminalPalette, ThemeJson, ThemeMode } from './types.js';

/** Contrast floors against backgroundPanel, shared with the bundled-theme tests. */
const FLOOR_TEXT = 7;
const FLOOR_MUTED = 4.5;
const FLOOR_FAINT = 2.5;
const FLOOR_STATUS = 3;

function slot(palette: TerminalPalette, index: number, pair: number): string {
  const own = palette.ansi[index];
  if (own !== undefined && isHexColor(own)) return normalizeHex(own);
  const other = palette.ansi[pair];
  if (other !== undefined && isHexColor(other)) return normalizeHex(other);
  return ansiToHex(index);
}

function pickSolid(candidates: ReadonlyArray<string | undefined>, fallback: string): string {
  for (const candidate of candidates) {
    if (candidate !== undefined && isHexColor(candidate)) return normalizeHex(candidate);
  }
  return fallback;
}

/**
 * Build a theme file from a probed terminal palette. `mode` is the terminal's
 * background mode (callers usually derive it from the background luminance).
 */
export function generateSystemTheme(palette: TerminalPalette, mode: ThemeMode): ThemeJson {
  const dark = mode === 'dark';
  const bg = dark
    ? pickSolid([palette.background, palette.ansi[0]], '#000000')
    : pickSolid([palette.background, palette.ansi[15], palette.ansi[7]], '#ffffff');
  const rawFg = dark
    ? pickSolid([palette.foreground, palette.ansi[7], palette.ansi[15]], '#e5e5e5')
    : pickSolid([palette.foreground, palette.ansi[0], palette.ansi[8]], '#000000');

  // Ramp from the background toward the foreground. Near-black and near-white
  // backgrounds need larger steps before a panel reads as distinct.
  const lum = relativeLuminance(bg);
  const extreme = dark ? lum < 0.01 : lum > 0.9;
  const step = extreme ? 0.045 : 0.035;
  const ramp = (i: number): string => mixHex(bg, rawFg, step * i);

  const panel = ramp(2);
  const element = ramp(3);

  const text = ensureContrast(rawFg, panel, FLOOR_TEXT);
  const textMuted = ensureContrast(mixHex(bg, text, 0.62), panel, FLOOR_MUTED);
  const textFaint = ensureContrast(mixHex(bg, text, 0.4), panel, FLOOR_FAINT);

  const status = (index: number, pair: number): string =>
    ensureContrast(slot(palette, index, pair), panel, FLOOR_STATUS);

  const red = status(1, 9);
  const green = status(2, 10);
  const yellow = status(3, 11);
  const blue = status(4, 12);
  const magenta = status(5, 13);
  const cyan = status(6, 14);
  const redBright = ensureContrast(slot(palette, 9, 1), panel, FLOOR_STATUS);
  const greenBright = ensureContrast(slot(palette, 10, 2), panel, FLOOR_STATUS);

  const diffAlpha = dark ? 0.22 : 0.14;

  return {
    theme: {
      primary: cyan,
      secondary: magenta,
      accent: blue,
      error: red,
      warning: yellow,
      success: green,
      info: cyan,

      text,
      textMuted,
      textFaint,
      selectedListItemText: bg,

      background: 'transparent',
      backgroundPanel: panel,
      backgroundElement: element,
      backgroundMenu: element,
      backgroundBase: bg,

      borderSubtle: ramp(5),
      border: ramp(7),
      borderActive: ramp(10),

      diffAdded: green,
      diffRemoved: red,
      diffContext: textMuted,
      diffHunkHeader: blue,
      diffHighlightAdded: greenBright,
      diffHighlightRemoved: redBright,
      diffAddedBg: tint(bg, green, diffAlpha),
      diffRemovedBg: tint(bg, red, diffAlpha),
      diffContextBg: panel,
      diffLineNumber: textFaint,
      diffAddedLineNumberBg: tint(panel, green, diffAlpha),
      diffRemovedLineNumberBg: tint(panel, red, diffAlpha),

      markdownText: text,
      markdownHeading: blue,
      markdownLink: blue,
      markdownLinkText: cyan,
      markdownCode: green,
      markdownBlockQuote: textMuted,
      markdownEmph: yellow,
      markdownStrong: text,
      markdownHorizontalRule: textFaint,
      markdownListItem: textMuted,
      markdownListEnumeration: cyan,
      markdownImage: blue,
      markdownImageText: cyan,
      markdownCodeBlock: text,

      syntaxComment: textMuted,
      syntaxKeyword: magenta,
      syntaxFunction: blue,
      syntaxVariable: text,
      syntaxString: green,
      syntaxNumber: yellow,
      syntaxType: cyan,
      syntaxOperator: cyan,
      syntaxPunctuation: text,

      reasoning: magenta,
      lanes: [cyan, blue, magenta, green, yellow, red],
    },
  };
}
