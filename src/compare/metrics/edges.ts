/**
 * Edge-based structural similarity.
 *
 * Uses Sobel gradient magnitudes as a coarse edge map, thresholds
 * them to binary, then computes an Intersection-over-Union (IoU)
 * between the two binary edge masks.
 *
 * Insensitive to uniform color shifts — catches whether dividers,
 * icon outlines and text shapes match up.
 */
import type { RGBAImage } from '../types';
import { luminance } from './ssim';

/**
 * Compute a binary edge mask (1 = edge, 0 = flat) using Sobel + threshold.
 */
export function edgeMask(img: RGBAImage, threshold = 48): Uint8Array {
  const w = img.width;
  const h = img.height;
  const gray = luminance(img);
  const mask = new Uint8Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] -
        2 * gray[i - 1] -
        gray[i + w - 1] +
        gray[i - w + 1] +
        2 * gray[i + 1] +
        gray[i + w + 1];
      const gy =
        -gray[i - w - 1] -
        2 * gray[i - w] -
        gray[i - w + 1] +
        gray[i + w - 1] +
        2 * gray[i + w] +
        gray[i + w + 1];
      const mag = Math.hypot(gx, gy);
      mask[i] = mag >= threshold ? 1 : 0;
    }
  }
  return mask;
}

/**
 * IoU between two binary masks of equal size.
 */
export function maskIoU(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av || bv) {
      union++;
      if (av && bv) inter++;
    }
  }
  return union === 0 ? 1 : inter / union;
}

/**
 * Convenience: compute edge-IoU directly from two RGBA images.
 */
export function edgeIoU(
  a: RGBAImage,
  b: RGBAImage,
  threshold?: number,
): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `edgeIoU: size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`,
    );
  }
  const ma = edgeMask(a, threshold);
  const mb = edgeMask(b, threshold);
  return maskIoU(ma, mb);
}
