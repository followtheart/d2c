/**
 * CIEDE2000 color difference (ΔE₀₀).
 *
 * Standard implementation from:
 *   Sharma, Wu, Dalal (2005) "The CIEDE2000 Color-Difference Formula:
 *   Implementation Notes, Supplementary Test Data, and Mathematical
 *   Observations", Color Research & Application.
 *
 * Inputs are sRGB 8-bit; internally we convert to linear RGB → XYZ → Lab.
 */
import type { RGBAImage } from '../types';

function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
}

function linearToXyz(r: number, g: number, b: number): [number, number, number] {
  // sRGB D65
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  return [x, y, z];
}

// D65 reference white
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const fx = labF(x / XN);
  const fy = labF(y / YN);
  const fz = labF(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labF(t: number): number {
  const d = 6 / 29;
  return t > d ** 3 ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
}

export function rgbToLab(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const [x, y, z] = linearToXyz(lr, lg, lb);
  return xyzToLab(x, y, z);
}

/**
 * Compute CIEDE2000 ΔE between two Lab points.
 */
export function deltaE2000(
  L1: number,
  a1: number,
  b1: number,
  L2: number,
  a2: number,
  b2: number,
): number {
  const kL = 1;
  const kC = 1;
  const kH = 1;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G =
    0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(a1p, b1);
  const h2p = hueDeg(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else {
    const diff = h2p - h1p;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);

  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2;
  else hbp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos(((hbp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hbp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hbp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hbp - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl =
    1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;

  const dE = Math.sqrt(
    (dLp / (kL * Sl)) ** 2 +
      (dCp / (kC * Sc)) ** 2 +
      (dHp / (kH * Sh)) ** 2 +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)),
  );
  return dE;
}

function hueDeg(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return deg >= 0 ? deg : deg + 360;
}

export interface DeltaEStats {
  mean: number;
  p95: number;
  max: number;
}

/**
 * Compute ΔE2000 stats across two equally-sized RGBA images.
 * Fully-transparent pixels are skipped.
 *
 * To keep runtime bounded we subsample every `step` pixels (default 2).
 */
export function deltaEStats(
  a: RGBAImage,
  b: RGBAImage,
  step = 2,
): DeltaEStats {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `deltaEStats: size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`,
    );
  }
  const values: number[] = [];
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const i = (y * a.width + x) * 4;
      if (a.data[i + 3] === 0 && b.data[i + 3] === 0) continue;
      const [L1, a1, b1] = rgbToLab(a.data[i], a.data[i + 1], a.data[i + 2]);
      const [L2, a2, b2] = rgbToLab(b.data[i], b.data[i + 1], b.data[i + 2]);
      values.push(deltaE2000(L1, a1, b1, L2, a2, b2));
    }
  }
  if (values.length === 0) return { mean: 0, p95: 0, max: 0 };
  let sum = 0;
  let max = 0;
  for (const v of values) {
    sum += v;
    if (v > max) max = v;
  }
  values.sort((x, y) => x - y);
  const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
  return { mean: sum / values.length, p95, max };
}
