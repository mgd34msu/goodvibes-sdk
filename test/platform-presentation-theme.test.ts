/**
 * platform-presentation-theme.test.ts
 *
 * The theme system under platform/presentation/theme/. Covers:
 *  - every bundled theme resolves in each declared variant to a complete,
 *    valid ThemeTokens table and meets the contrast floors against its panel;
 *  - the resolver: references through defs and tokens, derived fallbacks,
 *    ANSI indexes, 'transparent'/'none', cycle and missing-token errors;
 *  - the color helpers;
 *  - generateSystemTheme: deterministic, tolerant of missing slots, and
 *    meeting the same floors on three real terminal palettes;
 *  - the legacy bridge: neon dark reproduces TONE_TOKENS / DIFF_TONES.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_THEME_NAME,
  DIFF_TONES,
  SYSTEM_THEME_NAME,
  TONE_TOKENS,
  ThemeResolveError,
  ansiToHex,
  contrastRatio,
  ensureContrast,
  generateSystemTheme,
  getBundledTheme,
  listBundledThemes,
  mixHex,
  opencodeColorKeys,
  relativeLuminance,
  resolveTheme,
  resolveTones,
  themeColorKeys,
  themeToDiffTones,
  themeToTones,
  tint,
  type TerminalPalette,
  type ThemeJson,
  type ThemeMode,
  type ThemeTokens,
} from '../packages/sdk/src/platform/presentation/index.ts';

import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';

const HEX6 = /^#[0-9a-f]{6}$/;

/** Tokens allowed to resolve to '' (terminal default background). */
const MAY_BE_TRANSPARENT = new Set(['background']);

function assertFloors(tokens: ThemeTokens, label: string): void {
  const panel = tokens.backgroundPanel;
  const floors: Array<[keyof ThemeTokens & string, number]> = [
    ['text', 7],
    ['textMuted', 4.5],
    ['textFaint', 2.5],
    ['error', 3],
    ['warning', 3],
    ['success', 3],
    ['info', 3],
  ];
  for (const [key, floor] of floors) {
    const ratio = contrastRatio(tokens[key] as string, panel);
    if (ratio < floor) {
      throw new Error(`${label}: ${key} ${String(tokens[key])} is ${ratio.toFixed(2)}:1 on ${panel}, floor ${floor}`);
    }
  }
}

function assertComplete(tokens: ThemeTokens, label: string): void {
  for (const key of themeColorKeys()) {
    const value = tokens[key];
    expect(typeof value).toBe('string');
    if (value === '' && MAY_BE_TRANSPARENT.has(key)) continue;
    if (!HEX6.test(value)) throw new Error(`${label}: ${key} = "${value}" is not #rrggbb`);
  }
  expect(tokens.lanes.length).toBe(6);
  for (const lane of tokens.lanes) expect(lane).toMatch(HEX6);
  expect(tokens.thinkingOpacity).toBeGreaterThanOrEqual(0);
  expect(tokens.thinkingOpacity).toBeLessThanOrEqual(1);
}

describe('bundled themes', () => {
  test('catalog: default first, unique names, system is separate', () => {
    const themes = listBundledThemes();
    expect(themes[0]!.name).toBe(DEFAULT_THEME_NAME);
    expect(DEFAULT_THEME_NAME).toBe('goodvibes');
    expect(new Set(themes.map((t) => t.name)).size).toBe(themes.length);
    expect(themes.map((t) => t.name)).toEqual([
      'goodvibes', 'goodvibes-neon', 'catppuccin', 'tokyonight', 'dracula', 'nord',
      'gruvbox', 'one-dark', 'rosepine', 'solarized', 'github',
    ]);
    expect(SYSTEM_THEME_NAME).toBe('system');
    expect(getBundledTheme(SYSTEM_THEME_NAME)).toBeUndefined();
    expect(getBundledTheme('nope')).toBeUndefined();
    expect(getBundledTheme('nord')!.variants).toEqual(['dark']);
    expect(getBundledTheme('one-dark')!.variants).toEqual(['dark']);
  });

  test('display.theme config default and allowed values track the catalog', () => {
    const row = CONFIG_SCHEMA.find((entry) => entry.key === 'display.theme');
    expect(row).toBeDefined();
    expect(row!.type).toBe('enum');
    expect(row!.default).toBe(DEFAULT_THEME_NAME);
    expect(DEFAULT_CONFIG.display.theme).toBe(DEFAULT_THEME_NAME);
    // The schema carries a literal list (no registry call at module scope); this pins it to
    // the catalog names, the terminal-following theme, and the legacy 'vaporwave' alias.
    expect([...(row!.enumValues ?? [])].sort()).toEqual(
      [...listBundledThemes().map((theme) => theme.name), SYSTEM_THEME_NAME, 'vaporwave'].sort(),
    );
    expect(row!.enumValues![0]).toBe(DEFAULT_THEME_NAME);
  });

  for (const theme of listBundledThemes()) {
    for (const mode of theme.variants) {
      test(`${theme.name} (${mode}) resolves completely and meets the contrast floors`, () => {
        const tokens = resolveTheme(theme.json, mode);
        assertComplete(tokens, `${theme.name}/${mode}`);
        assertFloors(tokens, `${theme.name}/${mode}`);
      });
    }
  }

  test('goodvibes keeps the approved values', () => {
    const dark = resolveTheme(getBundledTheme('goodvibes')!.json, 'dark');
    expect(dark.background).toBe('');
    expect(dark.primary).toBe('#5ee0e6');
    expect(dark.backgroundPanel).toBe('#232438');
    expect(dark.diffContextBg).toBe(dark.backgroundPanel);
    expect(dark.diffLineNumber).toBe(dark.textFaint);
    expect(dark.markdownCode).toBe(dark.syntaxString);
    expect(dark.selectedListItemText).toBe('#10111a');
    expect(dark.lanes).toEqual(['#5ee0e6', '#a99af7', '#d18cf5', '#7aa7f5', '#7ddcae', '#f0b660']);
    expect(dark.thinkingOpacity).toBe(0.6);
    const light = resolveTheme(getBundledTheme('goodvibes')!.json, 'light');
    expect(light.primary).toBe('#007a83');
    expect(light.backgroundPanel).toBe('#ffffff');
  });
});

describe('resolveTheme', () => {
  // Every required opencode key and nothing else, so every optional key
  // (opencode's two plus all GoodVibes keys) resolves through its fallback.
  const base = (): Record<string, unknown> => {
    const theme: Record<string, unknown> = {};
    for (const key of opencodeColorKeys()) {
      if (key !== 'selectedListItemText' && key !== 'backgroundMenu') theme[key] = '#808080';
    }
    return theme;
  };
  const make = (overrides: Record<string, unknown>, defs?: Record<string, unknown>): ThemeJson =>
    ({ defs, theme: { ...base(), ...overrides } }) as unknown as ThemeJson;

  test('references resolve through defs, tokens, variants and ANSI indexes', () => {
    const tokens = resolveTheme(
      make(
        { primary: 'brandBlue', secondary: { dark: 'primary', light: 196 }, accent: 'none', info: 12 },
        { brandBlue: 'deep', deep: '#1234AB' },
      ),
      'dark',
    );
    expect(tokens.primary).toBe('#1234ab');
    expect(tokens.secondary).toBe('#1234ab');
    expect(tokens.accent).toBe('');
    expect(tokens.info).toBe('#5c5cff');
    const light = resolveTheme(make({ secondary: { dark: 'primary', light: 196 } }), 'light');
    expect(light.secondary).toBe('#ff0000');
  });

  test('a def and a token may share a name without a false cycle', () => {
    const tokens = resolveTheme(make({ primary: 'primary' }, { primary: '#00ff00' }), 'dark');
    expect(tokens.primary).toBe('#00ff00');
  });

  test('derived fallbacks apply and compose', () => {
    const tokens = resolveTheme(
      make({ background: 'transparent', backgroundPanel: '#202020', textMuted: '#a0a0a0', primary: '#00ffff' }),
      'dark',
    );
    expect(tokens.textFaint).toBe(mixHex('#202020', '#a0a0a0', 0.55));
    expect(tokens.textPlaceholder).toBe(tokens.textFaint);
    expect(tokens.selectedListItemText).toBe('#10111a');
    expect(tokens.backgroundMenu).toBe(tokens.backgroundElement);
    expect(tokens.backgroundSelected).toBe(tint(tokens.backgroundElement, '#00ffff', 0.16));
    expect(tokens.brand).toBe('#00ffff');
    expect(tokens.searchMatchBg).toBe(tint('#202020', tokens.warning, 0.35));
    expect(tokens.lanes).toEqual([tokens.primary, tokens.accent, tokens.secondary, tokens.info, tokens.success, tokens.warning]);
    expect(tokens.thinkingOpacity).toBe(0.6);
  });

  test('a reference to an omitted optional token resolves to its fallback', () => {
    const tokens = resolveTheme(make({ diffLineNumber: 'textFaint' }), 'dark');
    expect(tokens.diffLineNumber).toBe(tokens.textFaint);
  });

  test('token cycles throw a ThemeResolveError naming the chain', () => {
    expect(() => resolveTheme(make({ primary: 'secondary', secondary: 'accent', accent: 'primary' }), 'dark'))
      .toThrow(ThemeResolveError);
    expect(() => resolveTheme(make({ primary: 'secondary', secondary: 'primary' }), 'dark'))
      .toThrow(/Circular color reference: primary -> secondary -> primary/);
  });

  test('def cycles and cycles through derived fallbacks throw', () => {
    expect(() => resolveTheme(make({ primary: 'a' }, { a: 'b', b: 'a' }), 'dark')).toThrow(/Circular/);
    // brand's fallback is primary; primary pointing back at brand is a cycle.
    expect(() => resolveTheme(make({ primary: 'brand' }), 'dark')).toThrow(/Circular/);
  });

  test('unknown references, bad literals and missing tokens throw', () => {
    expect(() => resolveTheme(make({ primary: 'nothing' }), 'dark')).toThrow(/not found/);
    expect(() => resolveTheme(make({ primary: '#12' }), 'dark')).toThrow(/Invalid hex/);
    expect(() => resolveTheme(make({ primary: 300 }), 'dark')).toThrow(/ANSI/);
    const missing = base();
    delete missing['syntaxKeyword'];
    expect(() => resolveTheme({ theme: missing } as unknown as ThemeJson, 'dark')).toThrow(/syntaxKeyword/);
    expect(() => resolveTheme(make({ lanes: [] }), 'dark')).toThrow(/lanes/);
  });
});

describe('color helpers', () => {
  test('mix, tint, luminance, contrast, ANSI', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000', '#fff', 0.5)).toBe('#808080');
    expect(tint('#000000', '#ff0000', 0.5)).toBe('#800000');
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    expect(ansiToHex(1)).toBe('#cd0000');
    expect(ansiToHex(196)).toBe('#ff0000');
    expect(ansiToHex(16)).toBe('#000000');
    expect(ansiToHex(244)).toBe('#808080');
    const lifted = ensureContrast('#333333', '#222222', 4.5);
    expect(contrastRatio(lifted, '#222222')).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast('#ffffff', '#000000', 7)).toBe('#ffffff');
  });
});

const TOKYO_NIGHT: TerminalPalette = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  ansi: [
    '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
    '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5',
  ],
};
const SOLARIZED_LIGHT: TerminalPalette = {
  background: '#fdf6e3',
  foreground: '#657b83',
  ansi: [
    '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
    '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
  ],
};
const XTERM_16 = Array.from({ length: 16 }, (_, i) => ansiToHex(i));
const SAMPLES: Array<[string, TerminalPalette, ThemeMode]> = [
  ['tokyo night', TOKYO_NIGHT, 'dark'],
  ['solarized light', SOLARIZED_LIGHT, 'light'],
  ['xterm (no bg/fg reported, dark)', { ansi: XTERM_16 }, 'dark'],
  ['xterm default (white bg, light)', { background: '#ffffff', foreground: '#000000', ansi: XTERM_16 }, 'light'],
];

describe('generateSystemTheme', () => {
  for (const [label, palette, mode] of SAMPLES) {
    test(`${label}: deterministic, complete, transparent background, floors met`, () => {
      const first = generateSystemTheme(palette, mode);
      const second = generateSystemTheme(structuredClone(palette), mode);
      expect(second).toEqual(first);
      const tokens = resolveTheme(first, mode);
      assertComplete(tokens, `system/${label}`);
      assertFloors(tokens, `system/${label}`);
      expect(tokens.background).toBe('');
      expect(tokens.diffAddedBg).toBe(tint(tokens.backgroundBase, tokens.diffAdded, mode === 'dark' ? 0.22 : 0.14));
    });
  }

  test('semantic colors come from their ANSI slots when legible', () => {
    const tokens = resolveTheme(generateSystemTheme(TOKYO_NIGHT, 'dark'), 'dark');
    expect(tokens.error).toBe('#f7768e');
    expect(tokens.success).toBe('#9ece6a');
    expect(tokens.warning).toBe('#e0af68');
    expect(tokens.accent).toBe('#7aa2f7');
    expect(tokens.secondary).toBe('#bb9af7');
    expect(tokens.primary).toBe('#7dcfff');
    expect(tokens.info).toBe('#7dcfff');
  });

  test('missing and malformed slots fall back without throwing', () => {
    const sparse: TerminalPalette = { background: 'rgb:1a1a/1b1b/2626', ansi: [undefined, '#ff5555', 'bogus'] };
    for (const mode of ['dark', 'light'] as const) {
      const tokens = resolveTheme(generateSystemTheme(sparse, mode), mode);
      assertComplete(tokens, `sparse/${mode}`);
      assertFloors(tokens, `sparse/${mode}`);
    }
    const empty = resolveTheme(generateSystemTheme({ ansi: [] }, 'dark'), 'dark');
    assertFloors(empty, 'empty/dark');
  });
});

describe('legacy bridge', () => {
  const neon = (mode: ThemeMode): ThemeTokens => resolveTheme(getBundledTheme('goodvibes-neon')!.json, mode);

  test('neon dark reproduces TONE_TOKENS except the documented textFaint lift', () => {
    const tones = themeToTones(neon('dark'));
    // Documented difference: textFaint lifted #475569 -> #4e5c6f to reach the
    // 2.5:1 floor on the #161a22 panel; it feeds fg.dim and chrome.faint.
    expect(tones.fg.dim).toBe('#4e5c6f');
    expect(tones.chrome.faint).toBe('#4e5c6f');
    const expected = {
      ...TONE_TOKENS,
      fg: { ...TONE_TOKENS.fg, dim: '#4e5c6f' },
      chrome: { ...TONE_TOKENS.chrome, faint: '#4e5c6f' },
    };
    expect(tones).toEqual(expected);
  });

  test('neon dark reproduces DIFF_TONES', () => {
    expect(themeToDiffTones(neon('dark'))).toEqual({ ...DIFF_TONES });
  });

  test('neon light matches the light chrome/accent roles resolveTones defines', () => {
    const tones = themeToTones(neon('light'));
    const legacy = resolveTones('light');
    expect(tones.chrome).toEqual({ ...legacy.chrome });
    expect(tones.state.info).toBe(legacy.state.info);
    expect(tones.state.reasoning).toBe(legacy.state.reasoning);
    expect(tones.accent.brand).toBe(legacy.accent.brand);
    expect(tones.accent.gradientStart).toBe(legacy.accent.gradientStart);
    expect(tones.accent.gradientEnd).toBe(legacy.accent.gradientEnd);
  });

  test('every bundled theme bridges to complete tone tables', () => {
    for (const theme of listBundledThemes()) {
      for (const mode of theme.variants) {
        const tones = themeToTones(resolveTheme(theme.json, mode));
        const walk = (node: unknown): void => {
          if (typeof node === 'string') expect(node).toMatch(HEX6);
          else for (const child of Object.values(node as Record<string, unknown>)) walk(child);
        };
        walk(tones);
      }
    }
  });
});
