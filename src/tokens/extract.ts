/**
 * Design token extraction (P2).
 *
 * Walks an IR tree and collects recurring values — colors, font sizes,
 * spacings, radii, shadows — into a deduplicated token bag. The output is
 * shaped to be compatible with the `style-dictionary` JSON format so
 * users can import `tokens.json` directly into their toolchain.
 *
 * The extraction is deterministic and offline. We give each token a
 * stable, human-friendly name derived from its value (e.g. `blue-500`,
 * `fs-14`, `sp-24`) and expose the raw maps too so downstream tooling
 * (Tailwind preset, CSS variables, iOS/Android exports) can consume
 * them without having to walk the IR again.
 */
import type { IRDocument, IRNode } from '../ir/types';
import { walk } from '../utils/tree';

export interface TokenSet {
  colors: Record<string, string>;
  fontSizes: Record<string, number>;
  fontWeights: Record<string, number>;
  spacings: Record<string, number>;
  radii: Record<string, number>;
  shadows: Record<string, string>;
}

export interface StyleDictionaryToken {
  value: string | number;
  type: string;
  comment?: string;
}

export interface StyleDictionaryFile {
  color: Record<string, StyleDictionaryToken>;
  size: {
    font: Record<string, StyleDictionaryToken>;
    spacing: Record<string, StyleDictionaryToken>;
    radius: Record<string, StyleDictionaryToken>;
  };
  fontWeight: Record<string, StyleDictionaryToken>;
  shadow: Record<string, StyleDictionaryToken>;
}

interface ColorStat {
  css: string;
  count: number;
}

/** Converts `#aabbcc` / `rgba(...)` to a stable lowercase key */
function normalizeColor(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) {
    // Expand shorthand
    return '#' + s
      .slice(1)
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return s;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Name colors with a palette-friendly slug. Neutrals pick a gray-50…gray-900
 * bucket by luminance; chromatic colors pick the dominant hue family.
 */
function colorName(css: string, usedNames: Set<string>): string {
  const rgb = hexToRgb(css);
  if (!rgb) {
    // Non-hex (rgba with alpha) → transparent-N
    let i = 1;
    while (usedNames.has(`overlay-${i}`)) i++;
    return `overlay-${i}`;
  }
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255;
  const sat = max === min ? 0 : (max - min) / 255;

  // Map lightness → tailwind-ish shade key (50, 100 … 900)
  const shadeScale = [
    { at: 0.97, key: '50' },
    { at: 0.92, key: '100' },
    { at: 0.85, key: '200' },
    { at: 0.76, key: '300' },
    { at: 0.62, key: '400' },
    { at: 0.48, key: '500' },
    { at: 0.36, key: '600' },
    { at: 0.24, key: '700' },
    { at: 0.12, key: '800' },
    { at: 0, key: '900' },
  ];
  const shade = shadeScale.find((s) => l >= s.at)?.key ?? '900';

  let family = 'gray';
  if (sat > 0.12) {
    // Pick dominant channel or secondary hue
    if (r >= g && r >= b) {
      family = g > b ? 'orange' : 'red';
    } else if (g >= r && g >= b) {
      family = b > r ? 'teal' : 'green';
    } else {
      family = r > g ? 'purple' : 'blue';
    }
  } else {
    family = 'slate';
  }

  let base = `${family}-${shade}`;
  let i = 1;
  while (usedNames.has(base)) {
    base = `${family}-${shade}-${++i}`;
  }
  return base;
}

/** Collect the raw IR values into stats (value → count). */
function collectRaw(doc: IRDocument): {
  colorsByCss: Map<string, ColorStat>;
  fontSizes: Set<number>;
  fontWeights: Set<number>;
  spacings: Set<number>;
  radii: Set<number>;
  shadows: Map<string, string>;
} {
  const colorsByCss = new Map<string, ColorStat>();
  const fontSizes = new Set<number>();
  const fontWeights = new Set<number>();
  const spacings = new Set<number>();
  const radii = new Set<number>();
  const shadows = new Map<string, string>();

  const addColor = (raw: string | undefined) => {
    if (!raw) return;
    const k = normalizeColor(raw);
    const s = colorsByCss.get(k);
    if (s) s.count++;
    else colorsByCss.set(k, { css: k, count: 1 });
  };

  walk(doc.root, (n) => {
    addColor(n.style.backgroundColor);
    if (n.style.border) addColor(n.style.border.color);
    if (typeof n.style.borderRadius === 'number' && n.style.borderRadius > 0) {
      radii.add(n.style.borderRadius);
    }
    if (Array.isArray(n.style.borderRadius)) {
      for (const r of n.style.borderRadius) if (r > 0) radii.add(r);
    }
    if (n.style.shadows) {
      for (const s of n.style.shadows) {
        const key = `${s.x}_${s.y}_${s.blur}_${s.spread ?? 0}_${s.color}`;
        const val = `${s.x}px ${s.y}px ${s.blur}px${
          s.spread ? ' ' + s.spread + 'px' : ''
        } ${s.color}`;
        shadows.set(key, val);
      }
    }
    if (n.box.padding) {
      for (const p of n.box.padding) if (p > 0) spacings.add(p);
    }
    if (n.layout.gap) spacings.add(n.layout.gap);
    if (n.textStyle) {
      fontSizes.add(n.textStyle.fontSize);
      fontWeights.add(n.textStyle.fontWeight);
      addColor(n.textStyle.color);
    }
  });

  return { colorsByCss, fontSizes, fontWeights, spacings, radii, shadows };
}

const FONT_SIZE_NAMES: Array<[number, string]> = [
  [10, 'xs'],
  [12, 'xs'],
  [14, 'sm'],
  [16, 'base'],
  [18, 'lg'],
  [20, 'xl'],
  [24, '2xl'],
  [30, '3xl'],
  [36, '4xl'],
  [48, '5xl'],
  [60, '6xl'],
];

function fontSizeName(size: number, used: Set<string>): string {
  // Nearest bucket
  let best = FONT_SIZE_NAMES[0];
  for (const b of FONT_SIZE_NAMES) if (size >= b[0]) best = b;
  let key = best[1];
  let i = 2;
  while (used.has(key)) key = `${best[1]}-${i++}`;
  return key;
}

function spacingName(n: number): string {
  // Tailwind uses 4px increments. 4 → 1, 8 → 2, 12 → 3 …
  if (n % 4 === 0) return String(n / 4);
  return `${n}px`;
}

function fontWeightName(w: number): string {
  const m: Record<number, string> = {
    100: 'thin',
    200: 'extralight',
    300: 'light',
    400: 'normal',
    500: 'medium',
    600: 'semibold',
    700: 'bold',
    800: 'extrabold',
    900: 'black',
  };
  return m[w] ?? `w${w}`;
}

/**
 * Extract a deduplicated token set from the IR. The result is stable:
 * same IR → same tokens (both in content and naming).
 */
export function extractTokens(doc: IRDocument): TokenSet {
  const raw = collectRaw(doc);

  const colors: Record<string, string> = {};
  const colorNames = new Set<string>();
  // Sort by frequency desc, then by css for stability → dominant colors get
  // friendlier names like "blue-500" rather than "blue-500-2"
  const sortedColors = [...raw.colorsByCss.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.css.localeCompare(b.css);
  });
  for (const c of sortedColors) {
    const name = colorName(c.css, colorNames);
    colorNames.add(name);
    colors[name] = c.css;
  }

  const fontSizes: Record<string, number> = {};
  const fsUsed = new Set<string>();
  for (const s of [...raw.fontSizes].sort((a, b) => a - b)) {
    const name = fontSizeName(s, fsUsed);
    fsUsed.add(name);
    fontSizes[name] = s;
  }

  const fontWeights: Record<string, number> = {};
  for (const w of [...raw.fontWeights].sort((a, b) => a - b)) {
    fontWeights[fontWeightName(w)] = w;
  }

  const spacings: Record<string, number> = {};
  for (const n of [...raw.spacings].sort((a, b) => a - b)) {
    spacings[spacingName(n)] = n;
  }

  const radii: Record<string, number> = {};
  const radiiSorted = [...raw.radii].sort((a, b) => a - b);
  const radiiLabels = ['sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full'];
  radiiSorted.forEach((r, i) => {
    radii[radiiLabels[Math.min(i, radiiLabels.length - 1)]] = r;
  });

  const shadows: Record<string, string> = {};
  [...raw.shadows.values()].forEach((s, i) => {
    const key = i === 0 ? 'sm' : i === 1 ? 'md' : i === 2 ? 'lg' : `sh-${i}`;
    shadows[key] = s;
  });

  return { colors, fontSizes, fontWeights, spacings, radii, shadows };
}

/** Convert a TokenSet to a style-dictionary-compatible nested object. */
export function toStyleDictionary(tokens: TokenSet): StyleDictionaryFile {
  const wrap = <T extends string | number>(
    obj: Record<string, T>,
    type: string,
  ): Record<string, StyleDictionaryToken> => {
    const out: Record<string, StyleDictionaryToken> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = { value: v, type };
    return out;
  };
  return {
    color: wrap(tokens.colors, 'color'),
    size: {
      font: wrap(tokens.fontSizes, 'dimension'),
      spacing: wrap(tokens.spacings, 'dimension'),
      radius: wrap(tokens.radii, 'dimension'),
    },
    fontWeight: wrap(tokens.fontWeights, 'fontWeight'),
    shadow: wrap(tokens.shadows, 'shadow'),
  };
}
