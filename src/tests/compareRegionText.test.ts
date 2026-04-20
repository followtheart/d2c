/**
 * Unit tests for region-level and text fidelity layers.
 *
 * These tests construct an IR + synthetic images in-memory so no
 * pngjs / filesystem access is required.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { IRDocument, IRNode } from '../ir/types';
import type { RGBAImage } from '../compare/types';
import {
  evaluateRegions,
  collectAbsoluteBoxes,
} from '../compare/region';
import { evaluateText } from '../compare/text';

// ── Fixtures ─────────────────────────────────────────────────────────

function mkNode(overrides: Partial<IRNode>): IRNode {
  return {
    id: overrides.id ?? 'n',
    name: overrides.name ?? 'node',
    type: overrides.type ?? 'container',
    box: overrides.box ?? { x: 0, y: 0, width: 100, height: 100 },
    layout: overrides.layout ?? { type: 'absolute' },
    style: overrides.style ?? {},
    children: overrides.children ?? [],
    textStyle: overrides.textStyle,
  };
}

function mkDoc(): IRDocument {
  const textNode = mkNode({
    id: 'title',
    name: 'title',
    type: 'text',
    box: { x: 20, y: 20, width: 200, height: 40 },
    textStyle: {
      content: 'Hello World',
      fontSize: 24,
      fontWeight: 700,
      color: '#111111',
    },
  });
  const childNode = mkNode({
    id: 'card',
    name: 'Card',
    type: 'container',
    box: { x: 10, y: 70, width: 280, height: 100 },
    children: [],
  });
  const root = mkNode({
    id: 'root',
    name: 'root',
    type: 'container',
    box: { x: 0, y: 0, width: 300, height: 200 },
    children: [textNode, childNode],
  });
  return { name: 'demo', width: 300, height: 200, root };
}

function solid(width: number, height: number, r: number, g: number, b: number): RGBAImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

// ── collectAbsoluteBoxes ─────────────────────────────────────────────

test('collectAbsoluteBoxes: accumulates parent offsets', () => {
  const doc = mkDoc();
  const boxes = collectAbsoluteBoxes(doc);
  // root + 2 children = 3 entries
  assert.equal(boxes.length, 3);
  const title = boxes.find((b) => b.node.id === 'title')!;
  assert.equal(title.bbox.x, 20);
  assert.equal(title.bbox.y, 20);
  const card = boxes.find((b) => b.node.id === 'card')!;
  assert.equal(card.bbox.x, 10);
  assert.equal(card.bbox.y, 70);
});

// ── Region eval ──────────────────────────────────────────────────────

test('evaluateRegions: identical images → aggregate ≈ 1', () => {
  const doc = mkDoc();
  const ref = solid(300, 200, 220, 220, 220);
  const cand: RGBAImage = { ...ref, data: new Uint8Array(ref.data) };
  const result = evaluateRegions(doc, ref, cand);
  assert.ok(result.aggregate > 0.99, `got ${result.aggregate}`);
  assert.ok(result.regions.length >= 2);
  for (const r of result.regions) {
    assert.ok(r.ssim > 0.99);
    assert.ok(r.deltaE < 0.01);
  }
});

test('evaluateRegions: color-shifted candidate produces penalty', () => {
  const doc = mkDoc();
  const ref = solid(300, 200, 220, 220, 220);
  const cand = solid(300, 200, 50, 50, 200);
  const result = evaluateRegions(doc, ref, cand);
  assert.ok(result.aggregate < 0.9, `got ${result.aggregate}`);
  // Worst should be sorted ascending
  for (let i = 1; i < result.worst.length; i++) {
    assert.ok(result.worst[i].aggregated >= result.worst[i - 1].aggregated);
  }
});

test('evaluateRegions: size mismatch throws', () => {
  const doc = mkDoc();
  const a = solid(10, 10, 0, 0, 0);
  const b = solid(20, 20, 0, 0, 0);
  assert.throws(() => evaluateRegions(doc, a, b));
});

// ── Text eval ────────────────────────────────────────────────────────

test('evaluateText: all content present → aggregate 1', () => {
  const doc = mkDoc();
  const result = evaluateText(doc, {
    entryFile: 'index.html',
    files: [
      {
        path: 'index.html',
        content:
          '<div style="font-size:24px;font-weight:700">Hello World</div>',
      },
    ],
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].score, 1);
  assert.equal(result.aggregate, 1);
});

test('evaluateText: missing content reduces score', () => {
  const doc = mkDoc();
  const result = evaluateText(doc, {
    entryFile: 'index.html',
    files: [
      {
        path: 'index.html',
        content:
          '<div style="font-size:24px;font-weight:700">Goodbye</div>',
      },
    ],
  });
  assert.ok(result.aggregate < 1);
  assert.ok(result.items[0].reason?.includes('content'));
});

test('evaluateText: empty text nodes list → aggregate 1', () => {
  const root = mkNode({
    id: 'r',
    type: 'container',
    box: { x: 0, y: 0, width: 100, height: 100 },
  });
  const doc: IRDocument = { name: 'empty', width: 100, height: 100, root };
  const result = evaluateText(doc, { entryFile: 'x', files: [] });
  assert.equal(result.items.length, 0);
  assert.equal(result.aggregate, 1);
});

