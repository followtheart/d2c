/**
 * Perceptual hash (pHash) — 64-bit DCT-based image signature.
 *
 * Algorithm:
 *   1. Convert to 32×32 grayscale.
 *   2. Apply 2-D DCT-II.
 *   3. Keep the top-left 8×8 low-frequency block (skip DC).
 *   4. Compare each coefficient to the median → bit.
 *
 * Hamming distance 0..64; lower = more similar.  For 8×8 = 64 bits,
 * a distance of ≤ 10 is usually "visually similar".
 */
import type { RGBAImage } from '../types';
import { luminance } from './ssim';

const N = 32;
const K = 8;

/**
 * Resize grayscale image (represented as Float32Array) to N×N via
 * bilinear resampling.
 */
function resizeGray(
  gray: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const dst = new Float32Array(dstW * dstH);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = fx - x0;
      const top =
        gray[y0 * srcW + x0] * (1 - wx) + gray[y0 * srcW + x1] * wx;
      const bot =
        gray[y1 * srcW + x0] * (1 - wx) + gray[y1 * srcW + x1] * wx;
      dst[y * dstW + x] = top * (1 - wy) + bot * wy;
    }
  }
  return dst;
}

/**
 * 1-D DCT-II (naive O(N²) — fine for N = 32 small windows).
 */
function dct1D(input: Float32Array, stride: number, length: number, out: Float32Array, outStride: number): void {
  for (let k = 0; k < length; k++) {
    let sum = 0;
    for (let n = 0; n < length; n++) {
      sum += input[n * stride] * Math.cos((Math.PI / length) * (n + 0.5) * k);
    }
    out[k * outStride] = sum;
  }
}

function dct2D(block: Float32Array, size: number): Float32Array {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  // Row pass
  for (let y = 0; y < size; y++) {
    const row = block.subarray(y * size, (y + 1) * size);
    const outRow = tmp.subarray(y * size, (y + 1) * size);
    // Copy row and apply DCT
    const src = new Float32Array(row);
    dct1D(src, 1, size, outRow, 1);
  }
  // Column pass
  for (let x = 0; x < size; x++) {
    const col = new Float32Array(size);
    for (let y = 0; y < size; y++) col[y] = tmp[y * size + x];
    const outCol = new Float32Array(size);
    dct1D(col, 1, size, outCol, 1);
    for (let y = 0; y < size; y++) out[y * size + x] = outCol[y];
  }
  return out;
}

/**
 * Compute a 64-bit perceptual hash as a bigint.
 */
export function phash(img: RGBAImage): bigint {
  const gray = luminance(img);
  const small = resizeGray(gray, img.width, img.height, N, N);
  const coeffs = dct2D(small, N);

  // Extract top-left K×K (skip [0,0] — the DC term)
  const block = new Float32Array(K * K);
  for (let y = 0; y < K; y++) {
    for (let x = 0; x < K; x++) {
      block[y * K + x] = coeffs[y * N + x];
    }
  }

  // Median of block (excluding DC at index 0)
  const sortable = Array.from(block.slice(1)).sort((a, b) => a - b);
  const median = sortable[Math.floor(sortable.length / 2)];

  let hash = 0n;
  for (let i = 0; i < K * K; i++) {
    if (i === 0) continue;
    if (block[i] > median) {
      hash |= 1n << BigInt(i - 1);
    }
  }
  return hash;
}

/**
 * Hamming distance between two 64-bit hashes.
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let d = 0;
  while (x !== 0n) {
    d += Number(x & 1n);
    x >>= 1n;
  }
  return d;
}

/**
 * Similarity score in [0, 1] derived from Hamming distance on 64 bits.
 */
export function phashSimilarity(a: RGBAImage, b: RGBAImage): number {
  const ha = phash(a);
  const hb = phash(b);
  const d = hammingDistance(ha, hb);
  return Math.max(0, 1 - d / 63);
}
