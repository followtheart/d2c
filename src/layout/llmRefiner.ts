/**
 * LLM-driven layout refiner.
 *
 * Addresses one of the structural fidelity-loss paths called out in the
 * architecture review: the rule engine handles deterministic stacking
 * patterns well, but it falls back to `absolute` (or low-confidence flex)
 * for mixed/ambiguous layouts. This is exactly where a multimodal model
 * shines — given the children's bounding boxes (and optionally a
 * screenshot of the container), it can propose flex/grid structures that
 * heuristics miss.
 *
 * The refiner is opt-in (you must inject a `LayoutLLMProvider`), and it
 * only consults the model for containers whose `layout.confidence` is
 * below a threshold. Everything else stays purely deterministic, so the
 * default offline pipeline is unchanged.
 */
import type { IRNode, Layout } from '../ir/types';

export interface LayoutSuggestion {
  /** The container we want to refine, identified by IR node id. */
  nodeId: string;
  layout: Layout;
}

/**
 * A pluggable provider that turns a batch of (node + children boxes) into
 * a list of layout suggestions. Implementations are expected to use a
 * vision model (or a structured-text LLM) — the d2c core is provider-
 * agnostic and only expects this small interface.
 */
export interface LayoutLLMProvider {
  refine(
    candidates: Array<{
      node: IRNode;
      reason: 'low-confidence' | 'absolute-fallback';
    }>,
  ): Promise<LayoutSuggestion[]>;
}

export interface RefineOptions {
  /** Confidence threshold below which a container is sent to the LLM. */
  threshold?: number;
  /** Skip nodes that have fewer than this many children. */
  minChildren?: number;
}

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MIN_CHILDREN = 2;

function collectCandidates(
  root: IRNode,
  threshold: number,
  minChildren: number,
): Array<{ node: IRNode; reason: 'low-confidence' | 'absolute-fallback' }> {
  const out: Array<{
    node: IRNode;
    reason: 'low-confidence' | 'absolute-fallback';
  }> = [];

  function walk(node: IRNode): void {
    if (node.children.length >= minChildren) {
      const conf = node.layout.confidence ?? 1;
      if (node.layout.type === 'absolute') {
        out.push({ node, reason: 'absolute-fallback' });
      } else if (conf < threshold) {
        out.push({ node, reason: 'low-confidence' });
      }
    }
    for (const c of node.children) walk(c);
  }
  walk(root);
  return out;
}

function applySuggestions(
  root: IRNode,
  suggestions: LayoutSuggestion[],
): IRNode {
  if (!suggestions.length) return root;
  const byId = new Map(suggestions.map((s) => [s.nodeId, s.layout]));

  function rewrite(node: IRNode): IRNode {
    const next = byId.get(node.id);
    const children = node.children.map(rewrite);
    if (!next) return { ...node, children };
    // Merge: trust the LLM's structural fields but keep its source/confidence
    // explicit so later stages can tell where the layout came from.
    const merged: Layout = {
      ...node.layout,
      ...next,
      source: 'llm-refined',
      confidence: next.confidence ?? Math.max(0.85, node.layout.confidence ?? 0.85),
    };
    return { ...node, layout: merged, children };
  }

  return rewrite(root);
}

export async function refineLayoutWithLLM(
  root: IRNode,
  provider: LayoutLLMProvider,
  opts: RefineOptions = {},
): Promise<IRNode> {
  const candidates = collectCandidates(
    root,
    opts.threshold ?? DEFAULT_THRESHOLD,
    opts.minChildren ?? DEFAULT_MIN_CHILDREN,
  );
  if (!candidates.length) return root;
  const suggestions = await provider.refine(candidates);
  return applySuggestions(root, suggestions);
}

/**
 * Build the JSON payload that a LayoutLLMProvider would typically send to
 * a vision model. Exposed for downstream provider implementations and
 * for tests — keeps the prompt format in one place.
 */
export function buildRefinePayload(node: IRNode): {
  containerId: string;
  containerName: string;
  containerBox: IRNode['box'];
  children: Array<{
    id: string;
    name: string;
    type: string;
    box: IRNode['box'];
  }>;
  hint?: {
    fromAutoLayout?: boolean;
    constraints?: unknown;
  };
} {
  return {
    containerId: node.id,
    containerName: node.name,
    containerBox: node.box,
    children: node.children.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      box: c.box,
    })),
    hint: node.meta?.figma
      ? {
          fromAutoLayout: !!node.meta.figma.autoLayout,
          constraints: node.meta.figma.constraints,
        }
      : undefined,
  };
}

/**
 * Default refine prompt — providers can override but most can reuse this.
 */
export const DEFAULT_REFINE_PROMPT = `You are a CSS layout expert. For each
container described below you receive its bounding box and the bounding
boxes of its direct children (relative to the container). Decide whether
the children fit a flex (row/column) or grid layout, and report the
inferred properties as JSON. If the layout is genuinely overlapping (an
overlay, a stack of badges on an avatar, etc.), respond with
{"type": "absolute"}.

Respond as a JSON array, one object per container, e.g.:
[
  {
    "nodeId": "<id>",
    "layout": {"type": "flex", "direction": "row", "gap": 12,
               "alignItems": "center", "justifyContent": "space-between",
               "confidence": 0.9}
  }
]
`;
