/**
 * Tests for the architectural improvements addressing the five
 * fidelity-loss paths called out in the design review:
 *
 *   1. IR preserves Figma-specific metadata (constraints, autoLayout,
 *      sizing, instances, components).
 *   2. Layout inference attaches `confidence` + `source` so downstream
 *      stages can selectively re-decide.
 *   3. The LLM layout refiner picks up only low-confidence containers.
 *   4. The token resolver maps raw values to token names so codegen
 *      emits semantic Tailwind classes (`bg-blue-500`) instead of
 *      arbitrary literals (`bg-[#3f8cff]`).
 *   5. The visual-feedback helpers identify and mark low-fidelity
 *      nodes so the next refine pass picks them up.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFigma } from '../parser';
import { inferLayout } from '../layout/inference';
import {
  refineLayoutWithLLM,
  LayoutLLMProvider,
  LayoutSuggestion,
} from '../layout/llmRefiner';
import { buildTokenLookup } from '../tokens/resolver';
import { runPipeline } from '../pipeline/d2cPipeline';
import {
  selectLowFidelityNodeIds,
  markLowFidelityNodes,
} from '../pipeline/visualFeedback';
import type { IRNode, ExtendedTokenSet } from '../ir/types';
import type { RegionScore } from '../compare/types';

function loadExample(name: string): unknown {
  const p = path.resolve(__dirname, '..', '..', 'examples', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeNode(overrides: Partial<IRNode> & { id: string }): IRNode {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    type: overrides.type ?? 'container',
    box: overrides.box ?? { x: 0, y: 0, width: 100, height: 100 },
    layout: overrides.layout ?? { type: 'absolute' },
    style: overrides.style ?? {},
    children: overrides.children ?? [],
    semantics: overrides.semantics,
    textStyle: overrides.textStyle,
    meta: overrides.meta,
  };
}

// ── 1. IR preserves Figma-specific metadata ──────────────────────────

test('figma parser preserves auto-layout, constraints, instances, components', () => {
  const raw = {
    name: 'demo',
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [
        {
          id: '0:1',
          name: 'Canvas',
          type: 'CANVAS',
          children: [
            {
              id: '1:1',
              name: 'Frame',
              type: 'FRAME',
              absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 },
              layoutMode: 'HORIZONTAL',
              itemSpacing: 12,
              layoutWrap: 'WRAP',
              primaryAxisAlignItems: 'SPACE_BETWEEN',
              counterAxisAlignItems: 'CENTER',
              primaryAxisSizingMode: 'AUTO',
              counterAxisSizingMode: 'FIXED',
              layoutSizingHorizontal: 'FILL',
              layoutSizingVertical: 'HUG',
              constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' },
              individualStrokeWeights: { top: 1, right: 0, bottom: 1, left: 0 },
              children: [
                {
                  id: '1:2',
                  name: 'Btn',
                  type: 'INSTANCE',
                  componentId: 'C:42',
                  componentSetId: 'CS:7',
                  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
                  overrides: [{ id: '1:2', overriddenFields: ['characters'] }],
                },
                {
                  id: '1:3',
                  name: 'Master',
                  type: 'COMPONENT',
                  componentSetId: 'CS:7',
                  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
                  componentProperties: {
                    'state': { type: 'VARIANT', value: 'primary' },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const ir = parseFigma(raw);
  const meta = ir.root.meta?.figma;
  assert.ok(meta, 'expected figma meta to be populated');
  assert.equal(meta?.autoLayout?.direction, 'HORIZONTAL');
  assert.equal(meta?.autoLayout?.layoutWrap, 'WRAP');
  assert.equal(meta?.autoLayout?.primaryAlign, 'SPACE_BETWEEN');
  assert.equal(meta?.autoLayout?.primarySizing, 'AUTO');
  assert.equal(meta?.sizing?.horizontal, 'FILL');
  assert.equal(meta?.sizing?.vertical, 'HUG');
  assert.equal(meta?.constraints?.horizontal, 'LEFT_RIGHT');
  assert.deepEqual(meta?.strokeWeights, {
    top: 1,
    right: 0,
    bottom: 1,
    left: 0,
  });
  // wrap propagates into the layout
  assert.equal(ir.root.layout.wrap, true);
  // confidence/source from auto-layout
  assert.equal(ir.root.layout.confidence, 1);
  assert.equal(ir.root.layout.source, 'figma-autolayout');

  const instance = ir.root.children[0];
  assert.equal(instance.meta?.figma?.instance?.componentId, 'C:42');
  assert.equal(instance.meta?.figma?.instance?.componentSetId, 'CS:7');
  assert.deepEqual(instance.meta?.figma?.instance?.overrides, ['characters']);

  const master = ir.root.children[1];
  assert.equal(master.meta?.figma?.component?.setKey, 'CS:7');
  assert.deepEqual(master.meta?.figma?.component?.variantProps, {
    state: 'primary',
  });
});

// ── 2. Layout inference emits confidence + source ────────────────────

test('layout inference attaches confidence and source', () => {
  const raw = loadExample('sample-design.json');
  const ir = JSON.parse(JSON.stringify(raw));
  // The native parser already stamps an explicit layout in some places,
  // so test the inference output on a hand-built tree to keep this test
  // independent of the native input format.
  const root = makeNode({
    id: 'root',
    box: { x: 0, y: 0, width: 200, height: 600 },
    children: [
      makeNode({ id: 'a', box: { x: 0, y: 0, width: 200, height: 100 } }),
      makeNode({ id: 'b', box: { x: 0, y: 120, width: 200, height: 100 } }),
      makeNode({ id: 'c', box: { x: 0, y: 240, width: 200, height: 100 } }),
    ],
  });
  const out = inferLayout(root);
  assert.equal(out.layout.type, 'flex');
  assert.equal(out.layout.direction, 'column');
  assert.ok((out.layout.confidence ?? 0) >= 0.9, 'clean stack should be high-confidence');
  assert.equal(out.layout.source, 'rule-engine');
  // Ignore unused
  void ir;
});

test('layout inference: overlapping fallback flagged with low confidence', () => {
  const root = makeNode({
    id: 'root',
    box: { x: 0, y: 0, width: 300, height: 300 },
    children: [
      makeNode({ id: 'a', box: { x: 0, y: 0, width: 150, height: 150 } }),
      makeNode({ id: 'b', box: { x: 50, y: 50, width: 200, height: 200 } }),
      makeNode({ id: 'c', box: { x: 0, y: 100, width: 150, height: 150 } }),
    ],
  });
  const out = inferLayout(root);
  assert.equal(out.layout.type, 'absolute');
  assert.ok((out.layout.confidence ?? 1) < 0.5, 'absolute fallback must be low-confidence');
});

// ── 3. LLM layout refiner picks up only low-confidence nodes ─────────

test('layout refiner: only low-confidence containers reach the provider', async () => {
  const root = makeNode({
    id: 'root',
    box: { x: 0, y: 0, width: 300, height: 200 },
    layout: { type: 'flex', direction: 'column', confidence: 0.95, source: 'rule-engine' },
    children: [
      // High confidence container — should be skipped.
      makeNode({
        id: 'high',
        box: { x: 0, y: 0, width: 300, height: 80 },
        layout: { type: 'flex', direction: 'row', confidence: 0.9, source: 'rule-engine' },
        children: [
          makeNode({ id: 'h1', box: { x: 0, y: 0, width: 80, height: 40 } }),
          makeNode({ id: 'h2', box: { x: 100, y: 0, width: 80, height: 40 } }),
        ],
      }),
      // Low confidence container — should be visited.
      makeNode({
        id: 'low',
        box: { x: 0, y: 100, width: 300, height: 80 },
        layout: { type: 'absolute', confidence: 0.2, source: 'rule-engine' },
        children: [
          makeNode({ id: 'l1', box: { x: 0, y: 0, width: 100, height: 40 } }),
          makeNode({ id: 'l2', box: { x: 110, y: 0, width: 100, height: 40 } }),
        ],
      }),
    ],
  });

  const visited: string[] = [];
  const provider: LayoutLLMProvider = {
    async refine(candidates) {
      for (const c of candidates) visited.push(c.node.id);
      const suggestions: LayoutSuggestion[] = candidates.map((c) => ({
        nodeId: c.node.id,
        layout: { type: 'flex', direction: 'row', gap: 10 },
      }));
      return suggestions;
    },
  };

  const refined = await refineLayoutWithLLM(root, provider);
  assert.deepEqual(visited.sort(), ['low']);

  // Refined node carries the LLM-refined source marker.
  const lowRefined = refined.children.find((c) => c.id === 'low')!;
  assert.equal(lowRefined.layout.type, 'flex');
  assert.equal(lowRefined.layout.source, 'llm-refined');
});

// ── 4. Token resolver substitutes raw values ────────────────────────

test('token resolver maps colors and spacings to token names', () => {
  const tokens: ExtendedTokenSet = {
    colors: { 'blue-500': '#3f8cff', 'gray-900': '#111111' },
    spacings: { '3': 12, '6': 24 },
    radii: { md: 8 },
    fontSizes: { sm: 14, base: 16 },
    fontWeights: {},
    shadows: {},
  };
  const lookup = buildTokenLookup(tokens);
  assert.equal(lookup.color('#3f8cff'), 'blue-500');
  // Hex normalization: shorthand should resolve too.
  assert.equal(lookup.color('#111'), 'gray-900');
  assert.equal(lookup.spacing(12), '3');
  assert.equal(lookup.spacing(7), undefined);
  assert.equal(lookup.fontSize(14), 'sm');
  assert.equal(lookup.radius(8), 'md');
});

test('react codegen: tokens become semantic Tailwind classes, not arbitrary literals', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'react' });
  const tsx = result.generated.files[0].content;

  // The token-aware path drops at least *some* arbitrary-color background
  // for a named class. We just need to see that the pipeline now emits
  // *some* semantic class drawn from the token names — independent of
  // which exact colour was the dominant one.
  const tokenColorNames = Object.keys(result.tokens.colors);
  const namedBgPresent = tokenColorNames.some((n) =>
    tsx.includes(`bg-${n}`),
  );
  const namedTextPresent = tokenColorNames.some((n) =>
    tsx.includes(`text-${n}`),
  );
  assert.ok(
    namedBgPresent || namedTextPresent,
    'expected at least one bg-{token} or text-{token} class in generated React output',
  );
});

// ── 5. Visual feedback helpers ──────────────────────────────────────

test('visual feedback: low-fidelity nodes are flagged for re-refinement', () => {
  const root = makeNode({
    id: 'root',
    box: { x: 0, y: 0, width: 300, height: 300 },
    layout: { type: 'flex', direction: 'column', confidence: 0.9, source: 'rule-engine' },
    children: [
      makeNode({
        id: 'good',
        box: { x: 0, y: 0, width: 300, height: 100 },
        layout: { type: 'flex', direction: 'row', confidence: 0.9, source: 'rule-engine' },
      }),
      makeNode({
        id: 'bad',
        box: { x: 0, y: 100, width: 300, height: 100 },
        layout: { type: 'flex', direction: 'row', confidence: 0.95, source: 'rule-engine' },
      }),
    ],
  });

  const scores: RegionScore[] = [
    {
      nodeId: 'good',
      name: 'good',
      type: 'container',
      bbox: { x: 0, y: 0, width: 300, height: 100 },
      area: 30000,
      ssim: 0.95,
      deltaE: 1,
      aggregated: 0.92,
    },
    {
      nodeId: 'bad',
      name: 'bad',
      type: 'container',
      bbox: { x: 0, y: 100, width: 300, height: 100 },
      area: 30000,
      ssim: 0.55,
      deltaE: 12,
      aggregated: 0.4,
    },
  ];

  const lowIds = selectLowFidelityNodeIds(scores, 0.7);
  assert.deepEqual([...lowIds].sort(), ['bad']);

  const marked = markLowFidelityNodes(root, lowIds);
  const goodAfter = marked.children.find((c) => c.id === 'good')!;
  const badAfter = marked.children.find((c) => c.id === 'bad')!;
  assert.equal(goodAfter.layout.confidence, 0.9, 'good node confidence unchanged');
  assert.ok(
    (badAfter.layout.confidence ?? 1) < 0.5,
    'bad node confidence pushed below the refiner threshold',
  );
  assert.equal(badAfter.layout.source, 'vision-refined');
});
