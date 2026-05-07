/**
 * Token resolver — turn raw IR style values into design-token references
 * during code generation.
 *
 * Without this layer, the generator emits hardcoded values such as
 * `bg-[#3f8cff]`, `text-[14px]`, `gap-[12px]`. Even when the same colour
 * shows up across the design (and is captured in `tokens.colors`),
 * the generated code never references the token, which means:
 *   - theming/dark-mode is impossible without manual rewiring;
 *   - identical colours can drift apart over time;
 *   - the token file becomes documentation-only rather than the
 *     single-source-of-truth the design system promises.
 *
 * The resolver builds reverse lookup maps from a `TokenSet` so that a
 * generator can ask: "Do I have a token for #3f8cff?" → "blue-500".
 * Tailwind output then becomes `bg-blue-500` rather than the arbitrary
 * `bg-[#3f8cff]` — this is what makes the design tokens load-bearing
 * instead of decorative.
 */
import type { TokenSet } from './extract';

export interface TokenLookup {
  color(css: string | undefined): string | undefined;
  fontSize(size: number | undefined): string | undefined;
  spacing(value: number | undefined): string | undefined;
  radius(value: number | undefined): string | undefined;
}

function normalizeColor(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return '#' + s.slice(1).split('').map((c) => c + c).join('');
  }
  return s;
}

/**
 * Build a reverse lookup so generators can substitute hard-coded values
 * with token names. All maps are pure functions — same TokenSet → same
 * output, regardless of call order.
 */
export function buildTokenLookup(tokens: TokenSet): TokenLookup {
  const colorByCss = new Map<string, string>();
  for (const [name, css] of Object.entries(tokens.colors)) {
    colorByCss.set(normalizeColor(css), name);
  }

  const fontSizeByValue = new Map<number, string>();
  for (const [name, value] of Object.entries(tokens.fontSizes)) {
    if (!fontSizeByValue.has(value)) fontSizeByValue.set(value, name);
  }

  const spacingByValue = new Map<number, string>();
  for (const [name, value] of Object.entries(tokens.spacings)) {
    if (!spacingByValue.has(value)) spacingByValue.set(value, name);
  }

  const radiusByValue = new Map<number, string>();
  for (const [name, value] of Object.entries(tokens.radii)) {
    if (!radiusByValue.has(value)) radiusByValue.set(value, name);
  }

  return {
    color(css) {
      if (!css) return undefined;
      return colorByCss.get(normalizeColor(css));
    },
    fontSize(size) {
      if (size === undefined) return undefined;
      return fontSizeByValue.get(size);
    },
    spacing(value) {
      if (value === undefined) return undefined;
      return spacingByValue.get(value);
    },
    radius(value) {
      if (value === undefined) return undefined;
      return radiusByValue.get(value);
    },
  };
}

/** A no-op lookup that always returns undefined — used when tokens aren't available. */
export const NULL_TOKEN_LOOKUP: TokenLookup = {
  color: () => undefined,
  fontSize: () => undefined,
  spacing: () => undefined,
  radius: () => undefined,
};
