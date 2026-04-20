/**
 * Region-level fidelity — computes per-node SSIM + ΔE by cropping
 * both images to each IR node's absolute bounding box, then
 * aggregates an area-weighted mean.
 *
 * This is the single most *diagnostic* dimension — it tells you
 * exactly which component drifted.
 */
import type { IRDocument, IRNode } from '../ir/types';
import type { BBox, RegionScore, RGBAImage } from './types';
import { ssim } from './metrics/ssim';
import { deltaEStats } from './metrics/deltaE';

export interface RegionOptions {
  /** Minimum bbox width/height in pixels; smaller nodes are skipped. */
  minDim?: number;
  /** Maximum number of regions to evaluate (depth-first). */
  limit?: number;
  /** ΔE at which the color penalty saturates (=0 score). */
  deltaESaturation?: number;
  /** Upper bound on ΔE contribution to the combined score. */
  deltaEWeightInAggregate?: number;
}

/**
 * Build a flat list of absolute-space bboxes for every visible node.
 * `box.x`/`box.y` in IR are parent-relative, so we accumulate.
 */
export function collectAbsoluteBoxes(
  doc: IRDocument,
): Array<{ node: IRNode; bbox: BBox; depth: number }> {
  const out: Array<{ node: IRNode; bbox: BBox; depth: number }> = [];

  function toNum(v: number | 'auto' | 'fill'): number {
    return typeof v === 'number' ? v : 0;
  }

  function walk(node: IRNode, ox: number, oy: number, depth: number): void {
    const ax = ox + (node.box.x ?? 0);
    const ay = oy + (node.box.y ?? 0);
    const bw = toNum(node.box.width);
    const bh = toNum(node.box.height);
    if (bw > 0 && bh > 0) {
      out.push({
        node,
        depth,
        bbox: { x: ax, y: ay, width: bw, height: bh },
      });
    }
    for (const c of node.children) walk(c, ax, ay, depth + 1);
  }

  walk(doc.root, 0, 0, 0);
  return out;
}

/**
 * Convert a bbox expressed in IR/design coordinates (document width
 * = `docWidth`) into pixel coordinates on a target canvas sized
 * `canvasW × canvasH`.
 */
function bboxToCanvas(
  bbox: BBox,
  docW: number,
  docH: number,
  canvasW: number,
  canvasH: number,
): BBox {
  const sx = canvasW / docW;
  const sy = canvasH / docH;
  const x = Math.max(0, Math.round(bbox.x * sx));
  const y = Math.max(0, Math.round(bbox.y * sy));
  const w = Math.min(canvasW - x, Math.round(bbox.width * sx));
  const h = Math.min(canvasH - y, Math.round(bbox.height * sy));
  return { x, y, width: Math.max(0, w), height: Math.max(0, h) };
}

/**
 * Copy a sub-rectangle from a larger RGBA image into a freshly
 * allocated RGBAImage.
 */
function cropRGBA(src: RGBAImage, bbox: BBox): RGBAImage {
  const out: RGBAImage = {
    width: bbox.width,
    height: bbox.height,
    data: new Uint8Array(bbox.width * bbox.height * 4),
  };
  for (let row = 0; row < bbox.height; row++) {
    const srcOffset = ((bbox.y + row) * src.width + bbox.x) * 4;
    const dstOffset = row * bbox.width * 4;
    out.data.set(
      src.data.subarray(srcOffset, srcOffset + bbox.width * 4),
      dstOffset,
    );
  }
  return out;
}

export interface RegionEvaluation {
  regions: RegionScore[];
  /** Area-weighted aggregate score in [0,1]. */
  aggregate: number;
  /** Regions sorted worst-first. */
  worst: RegionScore[];
}

/**
 * Evaluate region-level fidelity for all visible IR nodes.
 */
export function evaluateRegions(
  doc: IRDocument,
  reference: RGBAImage,
  candidate: RGBAImage,
  opts: RegionOptions = {},
): RegionEvaluation {
  const minDim = opts.minDim ?? 12;
  const limit = opts.limit ?? 256;
  const deltaESat = opts.deltaESaturation ?? 30;
  const deltaEWeight = opts.deltaEWeightInAggregate ?? 0.35;

  if (
    reference.width !== candidate.width ||
    reference.height !== candidate.height
  ) {
    throw new Error('evaluateRegions: reference/candidate size mismatch');
  }

  const canvasW = reference.width;
  const canvasH = reference.height;
  const all = collectAbsoluteBoxes(doc);

  // Skip the root (covers full canvas — dominates aggregate trivially)
  const candidates = all.slice(1, 1 + limit);

  const regions: RegionScore[] = [];
  let totalArea = 0;
  let weightedSum = 0;

  for (const { node, bbox } of candidates) {
    const pxBox = bboxToCanvas(bbox, doc.width, doc.height, canvasW, canvasH);
    if (pxBox.width < minDim || pxBox.height < minDim) continue;
    const area = pxBox.width * pxBox.height;
    const ra = cropRGBA(reference, pxBox);
    const rb = cropRGBA(candidate, pxBox);

    const s = ssim(ra, rb);
    const de = deltaEStats(ra, rb, 2);

    const colorScore = Math.max(0, 1 - Math.min(1, de.mean / deltaESat));
    const aggregated =
      Math.max(0, Math.min(1, s)) * (1 - deltaEWeight) +
      colorScore * deltaEWeight;

    const rec: RegionScore = {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      bbox: pxBox,
      area,
      ssim: s,
      deltaE: de.mean,
      aggregated,
    };
    regions.push(rec);
    totalArea += area;
    weightedSum += aggregated * area;
  }

  const aggregate = totalArea > 0 ? weightedSum / totalArea : 1;
  const worst = [...regions]
    .sort((a, b) => a.aggregated - b.aggregated)
    .slice(0, 10);

  return { regions, aggregate, worst };
}
