/**
 * resolve.ts, theme file -> resolved ThemeTokens for one mode.
 *
 * Resolution is lazy and memoized per token: a reference to a GoodVibes key the
 * file omits resolves to that key's derived fallback, so fallbacks compose
 * (textPlaceholder -> textFaint -> mix(background, textMuted)). Reference chains
 * are tracked end to end, a cycle throws ThemeResolveError naming the chain.
 */

import { ansiToHex, isHexColor, mixHex, normalizeHex, tint } from './color.js';
import {
  themeColorKeys,
  type GoodVibesColorKey,
  type OptionalOpencodeColorKey,
  type ThemeColorKey,
  type ThemeColorValue,
  type ThemeJson,
  type ThemeMode,
  type ThemeTokens,
} from './types.js';

/** Thrown for a malformed theme: bad literal, unknown reference, cycle, missing token. */
export class ThemeResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeResolveError';
  }
}

/** Background used by selectedListItemText when the theme background is transparent. */
const TRANSPARENT_SELECTED_TEXT = '#10111a';
const DEFAULT_THINKING_OPACITY = 0.6;

type Getter = (key: ThemeColorKey) => string;
type Derivation = (get: Getter) => string;

/** A solid color standing in for `background` when the theme leaves it transparent. */
function solidBackground(get: Getter): string {
  return get('background') || get('backgroundPanel');
}

/**
 * Fallbacks for every optional key, built per call (no module-scope table).
 * Blends that start from `background` use solidBackground, so a transparent
 * background falls back to the panel color.
 */
function derivations(): Readonly<Record<GoodVibesColorKey | OptionalOpencodeColorKey, Derivation>> {
  return {
    selectedListItemText: (get) => get('background') || TRANSPARENT_SELECTED_TEXT,
    backgroundMenu: (get) => get('backgroundElement'),
    textFaint: (get) => mixHex(solidBackground(get), get('textMuted'), 0.55),
    textSecondary: (get) => mixHex(get('text'), get('textMuted'), 0.35),
    textPlaceholder: (get) => get('textFaint'),
    backgroundBase: (get) => solidBackground(get),
    backgroundTitle: (get) => get('backgroundPanel'),
    backgroundSection: (get) => get('backgroundElement'),
    backgroundSummary: (get) => get('backgroundElement'),
    backgroundSelected: (get) => tint(get('backgroundElement'), get('primary'), 0.16),
    backgroundInput: (get) => get('backgroundElement'),
    backgroundFooter: (get) => get('backgroundPanel'),
    backgroundCode: (get) => get('backgroundPanel'),
    backgroundWarning: (get) => tint(get('backgroundPanel'), get('warning'), 0.12),
    backgroundError: (get) => tint(get('backgroundPanel'), get('error'), 0.12),
    backgroundSuccess: (get) => tint(get('backgroundPanel'), get('success'), 0.12),
    brand: (get) => get('primary'),
    brandEnd: (get) => get('secondary'),
    reasoning: (get) => get('accent'),
    blocked: (get) => get('warning'),
    remote: (get) => get('secondary'),
    active: (get) => get('info'),
    panelBrowser: (get) => get('info'),
    panelControl: (get) => get('primary'),
    panelInspector: (get) => get('accent'),
    panelWorkflow: (get) => get('warning'),
    panelConversation: (get) => get('markdownLink'),
    syntaxProperty: (get) => get('syntaxVariable'),
    syntaxBuiltin: (get) => get('syntaxNumber'),
    searchMatchBg: (get) => tint(solidBackground(get), get('warning'), 0.35),
    searchCurrentBg: (get) => get('warning'),
  };
}

function chainText(chain: readonly string[]): string {
  return chain.map((entry) => entry.slice(entry.indexOf(':') + 1)).join(' -> ');
}

/**
 * Resolve a theme file for one mode into a complete ThemeTokens table.
 * Throws ThemeResolveError on an invalid literal, an unknown reference, a
 * reference cycle, or a missing required (opencode) token.
 */
export function resolveTheme(json: ThemeJson, mode: ThemeMode): ThemeTokens {
  const defs: Readonly<Record<string, ThemeColorValue>> = json.defs ?? {};
  const theme = json.theme as Readonly<Record<string, unknown>>;
  const derived = derivations();
  const keys = themeColorKeys();
  const keySet = new Set<string>(keys);
  const memo = new Map<string, string>();

  const colorOf = (value: ThemeColorValue, chain: readonly string[]): string => {
    if (typeof value === 'number') {
      try {
        return ansiToHex(value);
      } catch (err) {
        throw new ThemeResolveError(`${(err as Error).message} at ${chainText(chain)}`);
      }
    }
    if (typeof value === 'object' && value !== null) {
      const picked = value[mode];
      if (picked === undefined) {
        throw new ThemeResolveError(`Missing "${mode}" variant at ${chainText(chain)}`);
      }
      return colorOf(picked, chain);
    }
    if (typeof value !== 'string') {
      throw new ThemeResolveError(`Unsupported color value at ${chainText(chain)}`);
    }
    if (value === 'transparent' || value === 'none' || value === '') return '';
    if (value.startsWith('#')) {
      if (!isHexColor(value)) {
        throw new ThemeResolveError(`Invalid hex color "${value}" at ${chainText(chain)}`);
      }
      return normalizeHex(value);
    }
    return reference(value, chain);
  };

  const reference = (name: string, chain: readonly string[]): string => {
    if (Object.prototype.hasOwnProperty.call(defs, name)) {
      const link = `def:${name}`;
      if (chain.includes(link)) {
        throw new ThemeResolveError(`Circular color reference: ${chainText([...chain, link])}`);
      }
      return colorOf(defs[name]!, [...chain, link]);
    }
    if (keySet.has(name)) return token(name as ThemeColorKey, chain);
    throw new ThemeResolveError(
      `Color reference "${name}" not found in defs or theme (at ${chainText(chain) || name})`,
    );
  };

  const token = (key: ThemeColorKey, chain: readonly string[]): string => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const link = `token:${key}`;
    if (chain.includes(link)) {
      throw new ThemeResolveError(`Circular color reference: ${chainText([...chain, link])}`);
    }
    const next = [...chain, link];
    const raw = theme[key] as ThemeColorValue | undefined;
    let value: string;
    if (raw !== undefined) {
      value = colorOf(raw, next);
    } else {
      const derive = derived[key as GoodVibesColorKey | OptionalOpencodeColorKey];
      if (derive === undefined) {
        throw new ThemeResolveError(`Theme is missing required token "${key}"`);
      }
      value = derive((k) => token(k, next));
    }
    memo.set(key, value);
    return value;
  };

  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = token(key, []);

  const rawLanes = theme['lanes'] as readonly ThemeColorValue[] | undefined;
  if (rawLanes !== undefined && (!Array.isArray(rawLanes) || rawLanes.length === 0)) {
    throw new ThemeResolveError('Theme "lanes" must be a non-empty array of colors');
  }
  out['lanes'] = rawLanes
    ? rawLanes.map((lane, i) => colorOf(lane, [`token:lanes[${i}]`]))
    : ['primary', 'accent', 'secondary', 'info', 'success', 'warning'].map((k) => memo.get(k)!);

  const rawOpacity = theme['thinkingOpacity'];
  if (rawOpacity !== undefined && (typeof rawOpacity !== 'number' || !Number.isFinite(rawOpacity))) {
    throw new ThemeResolveError('Theme "thinkingOpacity" must be a finite number');
  }
  out['thinkingOpacity'] =
    rawOpacity === undefined ? DEFAULT_THINKING_OPACITY : Math.max(0, Math.min(1, rawOpacity as number));

  return out as ThemeTokens;
}
