/**
 * color.ts, pure hex-color math for the theme system.
 *
 * Every function takes and returns lowercase '#rrggbb' strings. Inputs accept
 * '#rgb', '#rrggbb' and '#rrggbbaa' (alpha is dropped: terminals paint opaque
 * cells). No module-scope work: the xterm table below is a plain literal and
 * every computation happens inside a function call.
 */

/** A parsed color, each channel 0..255. */
interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** True when `value` is a '#rgb', '#rrggbb' or '#rrggbbaa' literal. */
export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

function parseHex(hex: string): Rgb {
  if (!HEX_RE.test(hex)) {
    throw new Error(`Invalid hex color "${hex}" (expected #rgb, #rrggbb or #rrggbbaa)`);
  }
  const body = hex.slice(1);
  if (body.length === 3) {
    return {
      r: parseInt(body[0]! + body[0]!, 16),
      g: parseInt(body[1]! + body[1]!, 16),
      b: parseInt(body[2]! + body[2]!, 16),
    };
  }
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

function channel(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, '0');
}

function toHex(rgb: Rgb): string {
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

/** Normalize any accepted hex form to lowercase '#rrggbb'. Throws on invalid input. */
export function normalizeHex(hex: string): string {
  return toHex(parseHex(hex));
}

/**
 * Linear interpolation between two colors in sRGB space.
 * t = 0 returns `a`, t = 1 returns `b`; t is clamped to [0, 1].
 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const k = Math.max(0, Math.min(1, t));
  return toHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
  });
}

/**
 * Paint `overlay` over `base` at opacity `alpha` (0..1). Same math as mixHex,
 * named for the alpha-compositing reading: tint(bg, green, 0.22) is "green at
 * 22% over the background".
 */
export function tint(base: string, overlay: string, alpha: number): string {
  return mixHex(base, overlay, alpha);
}

function linearize(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG 2.x contrast ratio between two colors, 1 .. 21. Order does not matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Return `color` unchanged when it already reaches `minRatio` against
 * `background`; otherwise the smallest step (1% increments) of `color` mixed
 * toward white (dark background) or black (light background) that does.
 * Keeps hue as much as possible while guaranteeing legibility. Deterministic.
 */
export function ensureContrast(color: string, background: string, minRatio: number): string {
  const start = normalizeHex(color);
  if (contrastRatio(start, background) >= minRatio) return start;
  const target = relativeLuminance(background) < 0.18 ? '#ffffff' : '#000000';
  for (let step = 1; step <= 100; step++) {
    const candidate = mixHex(start, target, step / 100);
    if (contrastRatio(candidate, background) >= minRatio) return candidate;
  }
  return target;
}

/**
 * xterm's standard 16-color table. Used when a numeric ANSI index appears in a
 * theme file and as the fallback for missing slots in a probed terminal palette.
 */
function xterm16(index: number): string {
  const table = [
    '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
    '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
  ];
  return table[index] ?? '#000000';
}

/**
 * Hex value of an xterm 256-color index: 0..15 the standard table, 16..231 the
 * 6x6x6 cube, 232..255 the gray ramp. Out-of-range or fractional input throws.
 */
export function ansiToHex(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new Error(`Invalid ANSI color index ${index} (expected an integer 0..255)`);
  }
  if (index < 16) return xterm16(index);
  if (index < 232) {
    const i = index - 16;
    const level = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
    return toHex({ r: level(Math.floor(i / 36)), g: level(Math.floor(i / 6) % 6), b: level(i % 6) });
  }
  const gray = 8 + (index - 232) * 10;
  return toHex({ r: gray, g: gray, b: gray });
}
