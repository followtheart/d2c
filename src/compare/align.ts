/**
 * Canvas alignment — resizes two RGBA images to a common target size
 * so pixel-level metrics are meaningful.
 *
 * We use a pure-JS bilinear resampler (no external deps). Quality is
 * sufficient for fidelity scoring; for publication-grade output use
 * a dedicated image library.
 */
import type { AlignmentInfo, RGBAImage } from './types';
import { createImage } from './pngIO';

export interface AlignOptions {
  /** Explicit target canvas size.  If omitted, use max(ref, cand). */
  targetWidth?: number;
  targetHeight?: number;
  /**
   * How to align the candidate when its aspect ratio differs from
   * the reference.  'fit-width' (default) scales by width and
   * measures vertical overflow separately.
   */
  mode?: 'fit-width' | 'stretch';
}

/**
 * Bilinear-interpolated resize for 8-bit RGBA buffers.
 */
export function resizeRGBA(
  src: RGBAImage,
  dstW: number,
  dstH: number,
): RGBAImage {
  if (src.width === dstW && src.height === dstH) {
    return { width: dstW, height: dstH, data: new Uint8Array(src.data) };
  }
  const dst = createImage(dstW, dstH);
  const sx = src.width / dstW;
  const sy = src.height / dstH;

  for (let y = 0; y < dstH; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;

    for (let x = 0; x < dstW; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;

      const i00 = (y0 * src.width + x0) * 4;
      const i01 = (y0 * src.width + x1) * 4;
      const i10 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const di = (y * dstW + x) * 4;

      for (let c = 0; c < 4; c++) {
        const top = src.data[i00 + c] * (1 - wx) + src.data[i01 + c] * wx;
        const bot = src.data[i10 + c] * (1 - wx) + src.data[i11 + c] * wx;
        dst.data[di + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return dst;
}

/**
 * Crop the bottom overflow off the taller image so both have the same height.
 * Returns the overflow ratio (0..1) that got trimmed.
 */
function cropToHeight(
  img: RGBAImage,
  targetH: number,
): { img: RGBAImage; overflow: number } {
  if (img.height === targetH) return { img, overflow: 0 };
  if (img.height < targetH) {
    // Pad bottom with white pixels so shape matches.
    const padded = createImage(img.width, targetH);
    padded.data.set(img.data);
    // Fill remaining with white.
    for (let i = img.data.length; i < padded.data.length; i += 4) {
      padded.data[i] = 255;
      padded.data[i + 1] = 255;
      padded.data[i + 2] = 255;
      padded.data[i + 3] = 255;
    }
    return { img: padded, overflow: 0 };
  }
  const overflow = (img.height - targetH) / img.height;
  const cropped = createImage(img.width, targetH);
  cropped.data.set(img.data.subarray(0, img.width * targetH * 4));
  return { img: cropped, overflow };
}

export interface AlignmentResult {
  reference: RGBAImage;
  candidate: RGBAImage;
  info: AlignmentInfo;
}

/**
 * Align reference + candidate renderings onto a common canvas.
 *
 * Algorithm:
 *   1. target width  = min(ref.w, cand.w)   — keep sharpness of the smaller
 *      target height = min(ref.h, cand.h) after width-equalization
 *      (we scale by *width* first so horizontal layouts compare apples-to-apples)
 *   2. Resize both images to (targetW, scaledH_i) by their own scale factors.
 *   3. Crop the taller one down to targetH, record overflow ratio.
 */
export function alignImages(
  reference: RGBAImage,
  candidate: RGBAImage,
  opts: AlignOptions = {},
): AlignmentResult {
  const mode = opts.mode ?? 'fit-width';

  const targetW = opts.targetWidth ?? Math.min(reference.width, candidate.width);

  // Scale both by width first
  const refScale = targetW / reference.width;
  const candScale = targetW / candidate.width;
  const refScaledH = Math.round(reference.height * refScale);
  const candScaledH = Math.round(candidate.height * candScale);

  const refResized = resizeRGBA(reference, targetW, refScaledH);
  const candResized = resizeRGBA(candidate, targetW, candScaledH);

  let targetH: number;
  if (mode === 'stretch' && opts.targetHeight) {
    targetH = opts.targetHeight;
  } else {
    targetH = opts.targetHeight ?? Math.min(refScaledH, candScaledH);
  }

  const refCropped = cropToHeight(refResized, targetH);
  const candCropped = cropToHeight(candResized, targetH);

  return {
    reference: refCropped.img,
    candidate: candCropped.img,
    info: {
      width: targetW,
      height: targetH,
      referenceScale: refScale,
      candidateScale: candScale,
      candidateOverflow: candCropped.overflow,
    },
  };
}
