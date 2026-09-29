/**
 * registry.ts, the bundled-theme catalog.
 *
 * The catalog array is built inside listBundledThemes on each call, never at
 * module scope: imported theme bindings are only read when a caller asks, so
 * module evaluation order inside a compiled bundle cannot observe an
 * uninitialized binding.
 *
 * The `system` theme is not in this catalog. It has no static file: consumers
 * probe their terminal and call generateSystemTheme(palette, mode), then treat
 * the result like any bundled theme's json. SYSTEM_THEME_NAME is the name a
 * settings UI should list and persist for it.
 */

import { CATPPUCCIN_THEME } from './bundled/catppuccin.js';
import { DRACULA_THEME } from './bundled/dracula.js';
import { GITHUB_THEME } from './bundled/github.js';
import { GOODVIBES_THEME } from './bundled/goodvibes.js';
import { GRUVBOX_THEME } from './bundled/gruvbox.js';
import { NEON_THEME } from './bundled/neon.js';
import { NORD_THEME } from './bundled/nord.js';
import { ONE_DARK_THEME } from './bundled/one-dark.js';
import { ROSEPINE_THEME } from './bundled/rosepine.js';
import { SOLARIZED_THEME } from './bundled/solarized.js';
import { TOKYONIGHT_THEME } from './bundled/tokyonight.js';
import type { BundledTheme } from './types.js';

/** The theme a fresh install uses. */
export const DEFAULT_THEME_NAME = 'goodvibes';

/** The terminal-following theme; generated at runtime by generateSystemTheme. */
export const SYSTEM_THEME_NAME = 'system';

/** Every bundled theme, default first. `variants` lists the modes it was authored for. */
export function listBundledThemes(): BundledTheme[] {
  return [
    { name: 'goodvibes', label: 'GoodVibes', variants: ['dark', 'light'], json: GOODVIBES_THEME },
    { name: 'goodvibes-neon', label: 'GoodVibes Neon', variants: ['dark', 'light'], json: NEON_THEME },
    { name: 'catppuccin', label: 'Catppuccin', variants: ['dark', 'light'], json: CATPPUCCIN_THEME },
    { name: 'tokyonight', label: 'Tokyo Night', variants: ['dark', 'light'], json: TOKYONIGHT_THEME },
    { name: 'dracula', label: 'Dracula', variants: ['dark', 'light'], json: DRACULA_THEME },
    { name: 'nord', label: 'Nord', variants: ['dark'], json: NORD_THEME },
    { name: 'gruvbox', label: 'Gruvbox', variants: ['dark', 'light'], json: GRUVBOX_THEME },
    { name: 'one-dark', label: 'One Dark', variants: ['dark'], json: ONE_DARK_THEME },
    { name: 'rosepine', label: 'Rosé Pine', variants: ['dark', 'light'], json: ROSEPINE_THEME },
    { name: 'solarized', label: 'Solarized', variants: ['dark', 'light'], json: SOLARIZED_THEME },
    { name: 'github', label: 'GitHub', variants: ['dark', 'light'], json: GITHUB_THEME },
  ];
}

/** Look up a bundled theme by name; undefined for unknown names and for 'system'. */
export function getBundledTheme(name: string): BundledTheme | undefined {
  return listBundledThemes().find((theme) => theme.name === name);
}
