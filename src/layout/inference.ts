/**
 * Layout inference: turn absolute-positioned children into flex/grid layout.
 *
 * Algorithm (rule-based, deterministic):
 *   1. Traverse bottom-up (children first).
 *   2. For each container whose layout is already flex/grid, recurse.
 *   3. For each absolute container with >=2 children:
 *      - Sort children by x / y
 *      - If no pair overlaps along Y → vertical stack (column)
 *      - If no pair overlaps along X → horizontal stack (row)
 *      - If children form an NxM regular grid → grid with columns
 *      - Otherwise leave absolute as a fallback
 *   4. Once a flex direction is chosen, compute:
 *      - gap (median spacing between adjacent children along main axis)
 *      - justifyContent (space-between vs. clustered at start)
 *      - alignItems (min/center/max on cross axis)
 *      - padding (distance from bounding box to extreme children)
 */
import type { IRNode, Layout, Box, AlignValue, JustifyValue } from '../ir/types';
import { map } from '../utils/tree';

const EPS = 2; // pixel tolerance

function numOr(n: number | 'auto' | 'fill', fallback: number): number {
  return typeof n === 'number' ? n : fallback;
}

function bounds(box: Box): { x1: number; y1: number; x2: number; y2: number } {
  const w = numOr(box.width, 0);
  const h = numOr(box.height, 0);
  return { x1: box.x, y1: box.y, x2: box.x + w, y2: box.y + h };
}

function overlapsY(a: IRNode, b: IRNode): boolean {
  const ab = bounds(a.box);
  const bb = bounds(b.box);
  return Math.min(ab.y2, bb.y2) - Math.max(ab.y1, bb.y1) > EPS;
}

function overlapsX(a: IRNode, b: IRNode): boolean {
  const ab = bounds(a.box);
  const bb = bounds(b.box);
  return Math.min(ab.x2, bb.x2) - Math.max(ab.x1, bb.x1) > EPS;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function inferCrossAlign(
  children: IRNode[],
  parent: IRNode,
  axis: 'row' | 'column',
): AlignValue {
  const pw = numOr(parent.box.width, 0);
  const ph = numOr(parent.box.height, 0);
  const [pt, pr, pb, pl] = parent.box.padding ?? [0, 0, 0, 0];
  const innerW = pw - pl - pr;
  const innerH = ph - pt - pb;

  if (axis === 'row') {
    const tops = children.map((c) => c.box.y - pt);
    const bottoms = children.map((c) => innerH - (c.box.y - pt + numOr(c.box.height, 0)));
    if (tops.every((t) => Math.abs(t) <= EPS)) return 'start';
    if (bottoms.every((b) => Math.abs(b) <= EPS)) return 'end';
    const centers = children.map(
      (c) => c.box.y - pt + numOr(c.box.height, 0) / 2 - innerH / 2,
    );
    if (centers.every((c) => Math.abs(c) <= EPS + 1)) return 'center';
    return 'start';
  }
  // column
  const lefts = children.map((c) => c.box.x - pl);
  const rights = children.map((c) => innerW - (c.box.x - pl + numOr(c.box.width, 0)));
  if (lefts.every((l) => Math.abs(l) <= EPS)) return 'start';
  if (rights.every((r) => Math.abs(r) <= EPS)) return 'end';
  const centers = children.map(
    (c) => c.box.x - pl + numOr(c.box.width, 0) / 2 - innerW / 2,
  );
  if (centers.every((c) => Math.abs(c) <= EPS + 1)) return 'center';
  return 'start';
}

function inferJustify(
  children: IRNode[],
  parent: IRNode,
  axis: 'row' | 'column',
): { justify: JustifyValue; gap: number } {
  const [pt, pr, pb, pl] = parent.box.padding ?? [0, 0, 0, 0];
  const pw = numOr(parent.box.width, 0) - pl - pr;
  const ph = numOr(parent.box.height, 0) - pt - pb;

  const sorted = [...children].sort((a, b) =>
    axis === 'row' ? a.box.x - b.box.x : a.box.y - b.box.y,
  );
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (axis === 'row') {
      gaps.push(curr.box.x - (prev.box.x + numOr(prev.box.width, 0)));
    } else {
      gaps.push(curr.box.y - (prev.box.y + numOr(prev.box.height, 0)));
    }
  }
  const medGap = Math.max(0, Math.round(median(gaps)));

  // Check if children evenly span the container (space-between heuristic)
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (axis === 'row') {
    const firstGap = first.box.x - pl;
    const lastGap = pw - (last.box.x - pl + numOr(last.box.width, 0));
    const interiorVariance =
      gaps.length > 1 ? Math.max(...gaps) - Math.min(...gaps) : 0;
    if (
      firstGap <= EPS &&
      lastGap <= EPS &&
      interiorVariance <= EPS * 2 &&
      gaps.length
    )
      return { justify: 'space-between', gap: medGap };
  } else {
    const firstGap = first.box.y - pt;
    const lastGap = ph - (last.box.y - pt + numOr(last.box.height, 0));
    const interiorVariance =
      gaps.length > 1 ? Math.max(...gaps) - Math.min(...gaps) : 0;
    if (
      firstGap <= EPS &&
      lastGap <= EPS &&
      interiorVariance <= EPS * 2 &&
      gaps.length
    )
      return { justify: 'space-between', gap: medGap };
  }
  return { justify: 'start', gap: medGap };
}

function tryInferGrid(children: IRNode[]): { columns: number; gap: number } | null {
  if (children.length < 4) return null;
  // Group children into rows by Y buckets
  const sortedByY = [...children].sort((a, b) => a.box.y - b.box.y);
  const rows: IRNode[][] = [];
  let currentRow: IRNode[] = [];
  let currentY = -Infinity;
  for (const c of sortedByY) {
    if (Math.abs(c.box.y - currentY) > EPS * 4 && currentRow.length) {
      rows.push(currentRow);
      currentRow = [];
    }
    currentRow.push(c);
    currentY = c.box.y;
  }
  if (currentRow.length) rows.push(currentRow);
  if (rows.length < 2) return null;
  const columns = rows[0].length;
  if (columns < 2) return null;
  if (!rows.every((r) => r.length === columns)) return null;
  // Verify consistent column x positions
  const firstRow = [...rows[0]].sort((a, b) => a.box.x - b.box.x);
  for (const row of rows) {
    const sorted = [...row].sort((a, b) => a.box.x - b.box.x);
    for (let i = 0; i < columns; i++) {
      if (Math.abs(sorted[i].box.x - firstRow[i].box.x) > EPS * 4) return null;
    }
  }
  const gaps: number[] = [];
  for (let i = 1; i < firstRow.length; i++) {
    gaps.push(
      firstRow[i].box.x - (firstRow[i - 1].box.x + numOr(firstRow[i - 1].box.width, 0)),
    );
  }
  return { columns, gap: Math.max(0, Math.round(median(gaps))) };
}

function inferContainerLayout(node: IRNode): Layout {
  const children = node.children;
  // Keep explicit layouts (e.g. parsed from Figma Auto Layout)
  if (node.layout.type === 'flex' || node.layout.type === 'grid')
    return node.layout;

  if (children.length === 0) return { type: 'flex', direction: 'column' };
  if (children.length === 1)
    return { type: 'flex', direction: 'column', gap: 0 };

  // Grid detection first (a 2D repeating pattern beats flex)
  const grid = tryInferGrid(children);
  if (grid) {
    return { type: 'grid', columns: grid.columns, gap: grid.gap };
  }

  // Check stacking
  const noYOverlap = children.every((a, i) =>
    children.every((b, j) => i >= j || !overlapsY(a, b)),
  );
  const noXOverlap = children.every((a, i) =>
    children.every((b, j) => i >= j || !overlapsX(a, b)),
  );

  if (noYOverlap && !noXOverlap) {
    const sorted = [...children].sort((a, b) => a.box.y - b.box.y);
    const { justify, gap } = inferJustify(sorted, node, 'column');
    return {
      type: 'flex',
      direction: 'column',
      gap,
      justifyContent: justify,
      alignItems: inferCrossAlign(sorted, node, 'column'),
    };
  }
  if (noXOverlap && !noYOverlap) {
    const sorted = [...children].sort((a, b) => a.box.x - b.box.x);
    const { justify, gap } = inferJustify(sorted, node, 'row');
    return {
      type: 'flex',
      direction: 'row',
      gap,
      justifyContent: justify,
      alignItems: inferCrossAlign(sorted, node, 'row'),
    };
  }
  if (noXOverlap && noYOverlap) {
    // Both axes non-overlapping → pick dominant axis by extent
    const sortedY = [...children].sort((a, b) => a.box.y - b.box.y);
    const sortedX = [...children].sort((a, b) => a.box.x - b.box.x);
    const vExtent =
      sortedY[sortedY.length - 1].box.y - sortedY[0].box.y;
    const hExtent =
      sortedX[sortedX.length - 1].box.x - sortedX[0].box.x;
    if (vExtent >= hExtent) {
      const { justify, gap } = inferJustify(sortedY, node, 'column');
      return {
        type: 'flex',
        direction: 'column',
        gap,
        justifyContent: justify,
        alignItems: inferCrossAlign(sortedY, node, 'column'),
      };
    } else {
      const { justify, gap } = inferJustify(sortedX, node, 'row');
      return {
        type: 'flex',
        direction: 'row',
        gap,
        justifyContent: justify,
        alignItems: inferCrossAlign(sortedX, node, 'row'),
      };
    }
  }
  // Fallback to absolute positioning (truly overlapping)
  return { type: 'absolute' };
}

export function inferLayout(root: IRNode): IRNode {
  return map(root, (node) => {
    if (node.children.length === 0) return node;
    return { ...node, layout: inferContainerLayout(node) };
  });
}
