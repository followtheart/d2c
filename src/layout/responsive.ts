/**
 * Responsive breakpoint inference (P3).
 *
 * Takes a primary IR document plus zero or more secondary IR documents
 * (each representing the same design at a different viewport width) and
 * stamps `node.responsive[breakpoint]` overrides on the primary tree
 * with whatever properties differ.
 *
 * Nodes are matched across documents by id first, then by name + type
 * + role as a fallback.
 */
import type {
  IRDocument,
  IRNode,
  ResponsiveVariants,
  Box,
} from '../ir/types';
import { map, walk } from '../utils/tree';

export interface ResponsiveVariantInput {
  /** Tailwind-style breakpoint name (e.g. 'sm', 'md', 'lg'). */
  breakpoint: string;
  /** The IR document for this viewport (after parsing + layout inference). */
  doc: IRDocument;
}

function indexNodes(root: IRNode): {
  byId: Map<string, IRNode>;
  byKey: Map<string, IRNode>;
} {
  const byId = new Map<string, IRNode>();
  const byKey = new Map<string, IRNode>();
  walk(root, (n) => {
    byId.set(n.id, n);
    const key = `${n.type}|${n.name}|${n.semantics?.role ?? ''}`;
    if (!byKey.has(key)) byKey.set(key, n);
  });
  return { byId, byKey };
}

function findMatch(
  node: IRNode,
  ix: { byId: Map<string, IRNode>; byKey: Map<string, IRNode> },
): IRNode | undefined {
  const direct = ix.byId.get(node.id);
  if (direct) return direct;
  const key = `${node.type}|${node.name}|${node.semantics?.role ?? ''}`;
  return ix.byKey.get(key);
}

function diffBox(a: Box, b: Box): Partial<Box> | undefined {
  const out: Partial<Box> = {};
  let changed = false;
  if (a.x !== b.x) {
    out.x = b.x;
    changed = true;
  }
  if (a.y !== b.y) {
    out.y = b.y;
    changed = true;
  }
  if (a.width !== b.width) {
    out.width = b.width;
    changed = true;
  }
  if (a.height !== b.height) {
    out.height = b.height;
    changed = true;
  }
  if (JSON.stringify(a.padding) !== JSON.stringify(b.padding)) {
    out.padding = b.padding;
    changed = true;
  }
  return changed ? out : undefined;
}

function diffNode(base: IRNode, variant: IRNode): ResponsiveVariants[string] | null {
  const out: ResponsiveVariants[string] = {};
  let any = false;
  const boxDiff = diffBox(base.box, variant.box);
  if (boxDiff) {
    out.box = boxDiff;
    any = true;
  }
  if (JSON.stringify(base.layout) !== JSON.stringify(variant.layout)) {
    out.layout = variant.layout;
    any = true;
  }
  if (JSON.stringify(base.style) !== JSON.stringify(variant.style)) {
    out.style = variant.style;
    any = true;
  }
  if (
    base.textStyle &&
    variant.textStyle &&
    JSON.stringify(base.textStyle) !== JSON.stringify(variant.textStyle)
  ) {
    out.textStyle = variant.textStyle;
    any = true;
  }
  return any ? out : null;
}

/**
 * Apply responsive overrides on `base`. Each variant doc is matched
 * node-by-node and any differences are recorded under
 * `node.responsive[breakpoint]`. Variants whose nodes are missing in the
 * base are marked `hidden: false` (we can't introduce nodes here, so
 * they're skipped — that's a future enhancement).
 */
export function inferResponsive(
  base: IRDocument,
  variants: ResponsiveVariantInput[],
): IRDocument {
  if (!variants.length) return base;
  const variantIndexes = variants.map((v) => ({
    breakpoint: v.breakpoint,
    doc: v.doc,
    ix: indexNodes(v.doc.root),
  }));

  const newRoot = map(base.root, (node) => {
    const responsive: ResponsiveVariants = { ...(node.responsive ?? {}) };
    let changed = false;
    for (const v of variantIndexes) {
      const match = findMatch(node, v.ix);
      if (!match) {
        responsive[v.breakpoint] = { hidden: true };
        changed = true;
        continue;
      }
      const d = diffNode(node, match);
      if (d) {
        responsive[v.breakpoint] = d;
        changed = true;
      }
    }
    return changed ? { ...node, responsive } : node;
  });
  return { ...base, root: newRoot };
}
