/**
 * Visual feedback loop — close the loop on pipeline fidelity.
 *
 * Architecture review identifies the d2c pipeline as a "one-shot"
 * design-to-code flow: parse → IR → layout → semantic → codegen.
 * Once the rule engine commits to a layout decision (e.g. an
 * `absolute` fallback for a mixed-overlap container) the rest of the
 * stages — semantics, codegen — happily build on that mistake without
 * ever looking back at the ground truth.
 *
 * This module implements the missing back-edge: take a list of
 * region-level fidelity scores (computed by the `compare/` module
 * against a reference rendering of the design), find the nodes that
 * regressed, and rewrite their layouts so the next iteration of the
 * pipeline can do better. Two complementary modes are supported:
 *
 *   1. **Mark-only** (`markLowFidelityNodes`). Stamp the IR's
 *      `layout.confidence` and `layout.source` so that subsequent
 *      runs of `refineLayoutWithLLM` automatically pick those nodes
 *      up. This is purely deterministic and offline.
 *
 *   2. **Iterate** (`runVisualFeedback`). Given a layout-LLM provider
 *      and a renderer, run a fixed-point iteration: render → score →
 *      mark → refine → render until either the score stops improving
 *      or the iteration budget is exhausted.
 *
 * The renderer/scorer are injected as small interfaces so the loop
 * stays decoupled from Playwright, Sharp, the Figma API, etc.
 */
import type { IRDocument, IRNode } from '../ir/types';
import type { RegionScore } from '../compare/types';
import {
  refineLayoutWithLLM,
  LayoutLLMProvider,
  RefineOptions,
} from '../layout/llmRefiner';
import { map } from '../utils/tree';

export interface VisualFeedbackRenderer {
  /** Render the IR to a PNG buffer (for example via Playwright on the generated code). */
  render(doc: IRDocument): Promise<Buffer>;
}

export interface VisualFeedbackScorer {
  /** Compare a candidate rendering against the reference and report region scores. */
  score(reference: Buffer, candidate: Buffer, doc: IRDocument): Promise<RegionScore[]>;
}

export interface VisualFeedbackOptions {
  /** Region scores below this aggregate are considered low-fidelity. */
  fidelityThreshold?: number;
  /** Maximum number of refine iterations. */
  maxIterations?: number;
  /** Refiner options forwarded to `refineLayoutWithLLM`. */
  refine?: RefineOptions;
  /** Optional logger. */
  log?: (msg: string) => void;
}

const DEFAULT_FIDELITY_THRESHOLD = 0.7;
const DEFAULT_MAX_ITER = 2;

/**
 * Build a set of node IDs whose region score is below the threshold.
 */
export function selectLowFidelityNodeIds(
  scores: RegionScore[],
  threshold: number,
): Set<string> {
  const out = new Set<string>();
  for (const s of scores) {
    if (s.aggregated < threshold) out.add(s.nodeId);
  }
  return out;
}

/**
 * Stamp the IR's `layout.confidence` to a low value for nodes flagged
 * by visual scoring. Subsequent runs of `refineLayoutWithLLM` will
 * pick those nodes up automatically. Returns a new IR — no mutation.
 */
export function markLowFidelityNodes(
  root: IRNode,
  lowFidelityIds: ReadonlySet<string>,
  /**
   * Confidence to stamp. Defaults to 0.1 — well below the refiner's
   * default 0.5 threshold, so a follow-up refine pass will visit the
   * marked containers.
   */
  confidence = 0.1,
): IRNode {
  if (!lowFidelityIds.size) return root;
  return map(root, (node) => {
    if (!lowFidelityIds.has(node.id)) return node;
    return {
      ...node,
      layout: {
        ...node.layout,
        confidence,
        source: 'vision-refined',
      },
    };
  });
}

/**
 * Run the visual feedback loop:
 *   render → score → mark → refine → repeat
 *
 * Stops when (a) all regions clear the threshold, (b) the score stops
 * improving, or (c) the iteration budget is exhausted. Each iteration
 * yields a snapshot the caller can inspect for debugging.
 */
export interface FeedbackIteration {
  iteration: number;
  ir: IRDocument;
  meanFidelity: number;
  belowThreshold: number;
}

export async function runVisualFeedback(
  initial: IRDocument,
  reference: Buffer,
  renderer: VisualFeedbackRenderer,
  scorer: VisualFeedbackScorer,
  refiner: LayoutLLMProvider,
  opts: VisualFeedbackOptions = {},
): Promise<{ ir: IRDocument; iterations: FeedbackIteration[] }> {
  const threshold = opts.fidelityThreshold ?? DEFAULT_FIDELITY_THRESHOLD;
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITER;
  const log = opts.log ?? (() => undefined);

  let current = initial;
  let bestMean = -Infinity;
  const iterations: FeedbackIteration[] = [];

  for (let i = 0; i < maxIter; i++) {
    const candidatePng = await renderer.render(current);
    const scores = await scorer.score(reference, candidatePng, current);

    const meanFidelity = scores.length
      ? scores.reduce((s, r) => s + r.aggregated, 0) / scores.length
      : 1;
    const lowIds = selectLowFidelityNodeIds(scores, threshold);

    iterations.push({
      iteration: i,
      ir: current,
      meanFidelity,
      belowThreshold: lowIds.size,
    });

    log(
      `[visual-feedback] iter=${i} mean=${meanFidelity.toFixed(3)} below=${lowIds.size}`,
    );

    if (!lowIds.size) break;
    if (meanFidelity <= bestMean + 1e-3) break;
  if (i >= maxIter - 1) break;
    bestMean = meanFidelity;

    const marked = markLowFidelityNodes(current.root, lowIds);
    const refined = await refineLayoutWithLLM(marked, refiner, opts.refine);
    current = { ...current, root: refined };
  }

  return { ir: current, iterations };
}
