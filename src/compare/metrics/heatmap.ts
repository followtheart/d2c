/**
 * Pixel-diff heatmap generator.
 *
 * Produces an RGBA PNG where each pixel's redness encodes the
 * magnitude of the color difference (ΔE2000) between reference and
 * candidate.  The candidate image serves as the background so the
 * heatmap stays visually anchored to the UI.
 */
import type { RGBAImage } from '../types';
import { createImage } from '../pngIO';
import { deltaE2000, rgbToLab } from './deltaE';

export interface HeatmapOptions {
  /** Max ΔE considered "full red". Default 30. */
  maxDeltaE?: number;
  /** Blend factor of the heatmap overlay (0..1). Default 0.6. */
  alpha?: number;
}

export function buildDiffHeatmap(
  reference: RGBAImage,
  candidate: RGBAImage,
  opts: HeatmapOptions = {},
): RGBAImage {
  if (
    reference.width !== candidate.width ||
    reference.height !== candidate.height
  ) {
    throw new Error('buildDiffHeatmap: images must be same size');
  }

  const maxDE = opts.maxDeltaE ?? 30;
  const alpha = opts.alpha ?? 0.6;
  const w = reference.width;
  const h = reference.height;
  const out = createImage(w, h);

  for (let i = 0; i < w * h; i++) {
    const base = i * 4;
    // Base: faded candidate
    const r0 = candidate.data[base];
    const g0 = candidate.data[base + 1];
    const b0 = candidate.data[base + 2];
    const gray = Math.round(0.299 * r0 + 0.587 * g0 + 0.114 * b0);
    const [L1, a1, b1] = rgbToLab(
      reference.data[base],
      reference.data[base + 1],
      reference.data[base + 2],
    );
    const [L2, a2, b2] = rgbToLab(r0, g0, b0);
    const de = deltaE2000(L1, a1, b1, L2, a2, b2);
    const t = Math.min(1, de / maxDE);

    // Heat color: green → yellow → red
    const hr = Math.round(255 * t);
    const hg = Math.round(255 * (1 - Math.abs(t - 0.5) * 2));
    const hb = Math.round(255 * (1 - t) * 0.2);

    // Fade background towards gray
    const bgR = Math.round(gray * 0.6 + r0 * 0.4);
    const bgG = Math.round(gray * 0.6 + g0 * 0.4);
    const bgB = Math.round(gray * 0.6 + b0 * 0.4);

    const a = t * alpha;
    out.data[base] = Math.round(hr * a + bgR * (1 - a));
    out.data[base + 1] = Math.round(hg * a + bgG * (1 - a));
    out.data[base + 2] = Math.round(hb * a + bgB * (1 - a));
    out.data[base + 3] = 255;
  }
  return out;
}
