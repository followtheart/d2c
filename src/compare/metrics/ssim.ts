/**
 * Structural Similarity Index (SSIM) — perceptual image similarity.
 *
 * Implements single-scale luminance SSIM with a sliding-window mean +
 * variance, fast enough for screenshots up to a few megapixels.
 *
 * Reference: Wang et al. 2004 "Image Quality Assessment: From Error
 * Visibility to Structural Similarity", IEEE TIP.
 */
import type { RGBAImage } from '../types';

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/**
 * Convert RGBA → single-channel luminance (ITU-R BT.601).
 */
export function luminance(img: RGBAImage): Float32Array {
  const { width, height, data } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return out;
}

/**
 * Compute global mean-SSIM over two equally-sized RGBA images.
 *
 * Returns a value in [-1, 1]; 1 = identical.  In practice, UI
 * screenshots compare in [0.3, 1.0].
 *
 * Algorithm: 8×8 sliding window with 8-pixel stride — trades a
 * little smoothness for ~60× speedup over pixel-stride windows.
 */
export function ssim(a: RGBAImage, b: RGBAImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `ssim: size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`,
    );
  }
  const w = a.width;
  const h = a.height;
  const la = luminance(a);
  const lb = luminance(b);

  const win = 8;
  const stride = 4;
  let sum = 0;
  let count = 0;

  for (let y = 0; y + win <= h; y += stride) {
    for (let x = 0; x + win <= w; x += stride) {
      let muA = 0;
      let muB = 0;
      const n = win * win;
      for (let yy = 0; yy < win; yy++) {
        const row = (y + yy) * w + x;
        for (let xx = 0; xx < win; xx++) {
          muA += la[row + xx];
          muB += lb[row + xx];
        }
      }
      muA /= n;
      muB /= n;

      let varA = 0;
      let varB = 0;
      let cov = 0;
      for (let yy = 0; yy < win; yy++) {
        const row = (y + yy) * w + x;
        for (let xx = 0; xx < win; xx++) {
          const da = la[row + xx] - muA;
          const db = lb[row + xx] - muB;
          varA += da * da;
          varB += db * db;
          cov += da * db;
        }
      }
      varA /= n;
      varB /= n;
      cov /= n;

      const num = (2 * muA * muB + C1) * (2 * cov + C2);
      const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
      sum += num / den;
      count++;
    }
  }

  return count > 0 ? sum / count : 1;
}

/**
 * Multi-scale SSIM (a simplified MS-SSIM) — averages SSIM computed at
 * scales 1, 0.5, 0.25.  Helpful for images dominated by both fine
 * detail and large color regions.
 */
export function msSSIM(a: RGBAImage, b: RGBAImage): number {
  // Simple integer halving downsample
  const scales: Array<{ a: RGBAImage; b: RGBAImage }> = [{ a, b }];
  for (let s = 0; s < 2; s++) {
    const prev = scales[scales.length - 1];
    if (prev.a.width < 16 || prev.a.height < 16) break;
    scales.push({ a: downsample2x(prev.a), b: downsample2x(prev.b) });
  }
  const weights = [0.5, 0.3, 0.2].slice(0, scales.length);
  const total = weights.reduce((acc, w) => acc + w, 0);
  let out = 0;
  for (let i = 0; i < scales.length; i++) {
    out += (weights[i] / total) * ssim(scales[i].a, scales[i].b);
  }
  return out;
}

function downsample2x(img: RGBAImage): RGBAImage {
  const dw = img.width >> 1;
  const dh = img.height >> 1;
  const dst = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const i00 = ((y * 2) * img.width + x * 2) * 4;
      const i01 = i00 + 4;
      const i10 = i00 + img.width * 4;
      const i11 = i10 + 4;
      const di = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        dst[di + c] = Math.round(
          (img.data[i00 + c] +
            img.data[i01 + c] +
            img.data[i10 + c] +
            img.data[i11 + c]) /
            4,
        );
      }
    }
  }
  return { width: dw, height: dh, data: dst };
}
