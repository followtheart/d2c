/**
 * Color helpers: normalize between Figma's {r,g,b,a} 0-1 and css hex/rgba.
 */

export interface RGBA {
  r: number; // 0-1
  g: number; // 0-1
  b: number; // 0-1
  a?: number; // 0-1
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function toHex(n: number): string {
  const v = Math.round(clamp01(n) * 255);
  return v.toString(16).padStart(2, '0');
}

export function rgbaToCss(rgba: RGBA): string {
  const a = rgba.a ?? 1;
  if (a >= 1) {
    return `#${toHex(rgba.r)}${toHex(rgba.g)}${toHex(rgba.b)}`;
  }
  const r = Math.round(clamp01(rgba.r) * 255);
  const g = Math.round(clamp01(rgba.g) * 255);
  const b = Math.round(clamp01(rgba.b) * 255);
  return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}

export function anyColorToCss(c: unknown): string | undefined {
  if (!c) return undefined;
  if (typeof c === 'string') return c;
  if (typeof c === 'object' && c !== null && 'r' in (c as any)) {
    return rgbaToCss(c as RGBA);
  }
  return undefined;
}

/** Rough perceptual lightness for contrast heuristics */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
