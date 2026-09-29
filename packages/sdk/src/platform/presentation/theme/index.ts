/**
 * The theme system: an opencode-compatible theme-file format, a resolver that
 * turns a file into a complete token table for one mode, bundled themes, a
 * `system` theme generated from the user's terminal palette, and a bridge back
 * to the legacy TONE_TOKENS / DIFF_TONES shapes for incremental migration.
 *
 * Typical use:
 *   const json = name === SYSTEM_THEME_NAME
 *     ? generateSystemTheme(probedPalette, mode)
 *     : (getBundledTheme(name) ?? getBundledTheme(DEFAULT_THEME_NAME)!).json;
 *   const tokens = resolveTheme(json, mode);
 *
 * Pure: no fs, no terminal I/O, no process globals.
 */

export {
  ansiToHex,
  contrastRatio,
  ensureContrast,
  isHexColor,
  mixHex,
  normalizeHex,
  relativeLuminance,
  tint,
} from './color.js';

export { resolveTheme, ThemeResolveError } from './resolve.js';

export { generateSystemTheme } from './system.js';

export { themeToTones, themeToDiffTones, type DiffToneTokens } from './compat.js';

export {
  DEFAULT_THEME_NAME,
  SYSTEM_THEME_NAME,
  getBundledTheme,
  listBundledThemes,
} from './registry.js';

export {
  goodVibesColorKeys,
  opencodeColorKeys,
  themeColorKeys,
  type BundledTheme,
  type GoodVibesColorKey,
  type OpencodeColorKey,
  type OptionalOpencodeColorKey,
  type TerminalPalette,
  type ThemeColorKey,
  type ThemeColorValue,
  type ThemeJson,
  type ThemeJsonTokens,
  type ThemeTokens,
  type ThemeVariantValue,
} from './types.js';
