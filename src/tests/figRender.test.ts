/**
 * Tests for the Figma (.fig) rendering engine.
 *
 * These tests exercise the full .fig → RenderTree → SVG/HTML pipeline using
 * synthetic FigDocument structures.  Parsing a real .fig file requires the
 * `fzstd` and `kiwi-schema` dependencies at runtime and is covered separately
 * in end-to-end CLI tests.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type {
  FigDocument,
  FigNode,
  FigImageAsset,
} from '../parser/figBinaryParser';
import { buildFigRenderTree } from '../renderer/figRenderTree';
import { renderArtboardToSvg } from '../renderer/svgRenderer';
import { renderFig } from '../renderer';

/* ── Helpers ─────────────────────────────────────────────────────────── */

function makeDoc(overrides: Partial<FigDocument> = {}): FigDocument {
  return {
    name: overrides.name ?? 'Synthetic',
    pages: overrides.pages ?? [],
    width: overrides.width ?? 1440,
    height: overrides.height ?? 900,
    images: overrides.images ?? new Map<string, FigImageAsset>(),
    thumbnail: overrides.thumbnail,
  };
}

function makeFrame(id: string, name: string, children: FigNode[] = []): FigNode {
  return {
    id,
    type: 'FRAME',
    name,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    children,
  };
}

/* ── Render tree construction ────────────────────────────────────────── */

test('figRenderTree: one artboard per top-level frame', () => {
  const doc = makeDoc({
    pages: [{
      id: 'p1',
      name: 'Page 1',
      children: [
        makeFrame('f1', 'Home'),
        makeFrame('f2', 'Settings'),
      ],
    }],
  });

  const { renderDoc } = buildFigRenderTree(doc);
  assert.equal(renderDoc.artboards.length, 2);
  assert.equal(renderDoc.artboards[0].name, 'Home');
  assert.equal(renderDoc.artboards[1].name, 'Settings');
});

test('figRenderTree: top-level components are skipped in per-frame preview mode', () => {
  const component: FigNode = {
    id: 'c1',
    type: 'COMPONENT',
    name: 'Icon/Button',
    x: 0,
    y: 0,
    width: 24,
    height: 24,
    visible: true,
    children: [],
  };
  const doc = makeDoc({
    pages: [{
      id: 'p1',
      name: 'Page 1',
      children: [makeFrame('f1', 'Home'), component],
    }],
  });

  const { renderDoc } = buildFigRenderTree(doc);
  assert.equal(renderDoc.artboards.length, 1);
  assert.equal(renderDoc.artboards[0].name, 'Home');
});

test('figRenderTree: loose top-level shapes packed into one artboard', () => {
  const loose: FigNode = {
    id: 'l1',
    type: 'RECTANGLE',
    name: 'Loose',
    x: 20,
    y: 30,
    width: 100,
    height: 60,
    visible: true,
    fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.8 } }],
  };
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Loose Page', children: [loose] }],
  });

  const { renderDoc } = buildFigRenderTree(doc);
  assert.equal(renderDoc.artboards.length, 1);
  assert.equal(renderDoc.artboards[0].root.children.length, 1);
});

test('figRenderTree: loose top-level shapes are ignored when screen frames exist', () => {
  const loose: FigNode = {
    id: 'l1',
    type: 'RECTANGLE',
    name: 'Loose',
    x: 20,
    y: 30,
    width: 100,
    height: 60,
    visible: true,
    fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.8 } }],
  };
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Loose Page', children: [makeFrame('f1', 'Home'), loose] }],
  });

  const { renderDoc } = buildFigRenderTree(doc);
  assert.equal(renderDoc.artboards.length, 1);
  assert.equal(renderDoc.artboards[0].name, 'Home');
});

test('figRenderTree: perFrameArtboards=false collapses a page into one artboard', () => {
  const doc = makeDoc({
    pages: [{
      id: 'p1',
      name: 'Page',
      children: [makeFrame('f1', 'A'), makeFrame('f2', 'B')],
    }],
  });

  const { renderDoc } = buildFigRenderTree(doc, { perFrameArtboards: false });
  assert.equal(renderDoc.artboards.length, 1);
  assert.equal(renderDoc.artboards[0].root.children.length, 2);
});

test('figRenderTree: preserves rotation from transform', () => {
  const rotated: FigNode = {
    id: 'r1',
    type: 'RECTANGLE',
    name: 'Rotated',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 45,
    visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
  };
  const frame = makeFrame('f1', 'Frame', [rotated]);
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Page', children: [frame] }],
  });
  const { renderDoc } = buildFigRenderTree(doc);
  const child = renderDoc.artboards[0].root.children[0];
  assert.equal(child.rotation, 45);
});

test('figRenderTree: nested children are normalized to artboard-local absolute coordinates', () => {
  const nested: FigNode = {
    id: 'n1',
    type: 'RECTANGLE',
    name: 'Nested',
    x: 12,
    y: 18,
    width: 40,
    height: 24,
    visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
  };
  const group: FigNode = {
    id: 'g1',
    type: 'GROUP',
    name: 'Group',
    x: 30,
    y: 40,
    width: 100,
    height: 80,
    visible: true,
    children: [nested],
  };
  const frame = makeFrame('f1', 'Frame', [group]);
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Page', children: [frame] }],
  });

  const { renderDoc } = buildFigRenderTree(doc);
  const renderedGroup = renderDoc.artboards[0].root.children[0];
  const renderedNested = renderedGroup.children[0];
  assert.equal(renderedGroup.frame.x, 30);
  assert.equal(renderedGroup.frame.y, 40);
  assert.equal(renderedNested.frame.x, 42);
  assert.equal(renderedNested.frame.y, 58);
});

test('figRenderTree: converts GRADIENT_LINEAR into a RenderGradient fill', () => {
  const gradNode: FigNode = {
    id: 'g1',
    type: 'RECTANGLE',
    name: 'Grad',
    x: 0, y: 0, width: 200, height: 100,
    visible: true,
    fills: [{
      type: 'GRADIENT_LINEAR',
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0 } },
        { position: 1, color: { r: 0, g: 0, b: 1 } },
      ],
      gradientHandlePositions: [
        { x: 0, y: 0.5 },
        { x: 1, y: 0.5 },
        { x: 0, y: 1 },
      ],
    }],
  };
  const frame = makeFrame('f1', 'Frame', [gradNode]);
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Page', children: [frame] }],
  });
  const { renderDoc } = buildFigRenderTree(doc);
  const rn = renderDoc.artboards[0].root.children[0];
  assert.equal(rn.fills.length, 1);
  assert.equal(rn.fills[0].type, 'gradient');
  assert.equal(rn.fills[0].gradient?.type, 'linear');
  assert.equal(rn.fills[0].gradient?.stops.length, 2);
});

test('figRenderTree: resolves IMAGE fill to a data URI from the images map', () => {
  // 1x1 transparent PNG
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  const images = new Map<string, FigImageAsset>();
  images.set('abc123', { hash: 'abc123', data: pngBytes, mime: 'image/png' });

  const imgNode: FigNode = {
    id: 'i1',
    type: 'RECTANGLE',
    name: 'Photo',
    x: 0, y: 0, width: 200, height: 200,
    visible: true,
    fills: [{ type: 'IMAGE', imageRef: 'abc123' }],
  };
  const frame = makeFrame('f1', 'Frame', [imgNode]);
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Page', children: [frame] }],
    images,
  });

  const { renderDoc } = buildFigRenderTree(doc);
  const child = renderDoc.artboards[0].root.children[0];
  assert.equal(child.type, 'image');
  assert.ok(child.imageRef?.startsWith('data:image/png;base64,'), 'imageRef should be a data URI');
});

test('figRenderTree: rectangleCornerRadii mapped correctly', () => {
  const node: FigNode = {
    id: 'n1',
    type: 'RECTANGLE',
    name: 'Corners',
    x: 0, y: 0, width: 100, height: 100,
    visible: true,
    rectangleCornerRadii: [10, 20, 30, 40],
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
  };
  const frame = makeFrame('f1', 'Frame', [node]);
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Page', children: [frame] }],
  });
  const { renderDoc } = buildFigRenderTree(doc);
  const rn = renderDoc.artboards[0].root.children[0];
  assert.deepEqual(rn.borderRadius, [10, 20, 30, 40]);
});

test('figRenderTree: uniform cornerRadius collapsed to a single number', () => {
  const node: FigNode = {
    id: 'n1',
    type: 'RECTANGLE',
    name: 'Uniform',
    x: 0, y: 0, width: 100, height: 100,
    visible: true,
    rectangleCornerRadii: [8, 8, 8, 8],
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
  };
  const frame = makeFrame('f1', 'Frame', [node]);
  const doc = makeDoc({ pages: [{ id: 'p1', name: 'Page', children: [frame] }] });
  const { renderDoc } = buildFigRenderTree(doc);
  assert.equal(renderDoc.artboards[0].root.children[0].borderRadius, 8);
});

test('figRenderTree: inner shadow and layer blur extracted', () => {
  const node: FigNode = {
    id: 'n1',
    type: 'RECTANGLE',
    name: 'FX',
    x: 0, y: 0, width: 100, height: 100,
    visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    effects: [
      { type: 'INNER_SHADOW', radius: 4, offset: { x: 0, y: 2 }, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      { type: 'LAYER_BLUR', radius: 6 },
    ],
  };
  const frame = makeFrame('f1', 'Frame', [node]);
  const doc = makeDoc({ pages: [{ id: 'p1', name: 'Page', children: [frame] }] });
  const { renderDoc } = buildFigRenderTree(doc);
  const rn = renderDoc.artboards[0].root.children[0];
  assert.equal(rn.innerShadows.length, 1);
  assert.equal(rn.innerShadows[0].y, 2);
  assert.equal(rn.blur?.radius, 6);
  assert.equal(rn.blur?.type, 'gaussian');
});

test('figRenderTree: hidden children are dropped unless includeHidden', () => {
  const hidden: FigNode = {
    id: 'h1', type: 'RECTANGLE', name: 'Hidden',
    x: 0, y: 0, width: 10, height: 10, visible: false,
  };
  const visible: FigNode = {
    id: 'v1', type: 'RECTANGLE', name: 'Visible',
    x: 0, y: 0, width: 10, height: 10, visible: true,
  };
  const frame = makeFrame('f1', 'Frame', [hidden, visible]);
  const doc = makeDoc({ pages: [{ id: 'p1', name: 'Page', children: [frame] }] });
  const r1 = buildFigRenderTree(doc).renderDoc;
  assert.equal(r1.artboards[0].root.children.length, 1);
  const r2 = buildFigRenderTree(doc, { includeHidden: true }).renderDoc;
  assert.equal(r2.artboards[0].root.children.length, 2);
});

/* ── SVG output ──────────────────────────────────────────────────────── */

test('renderFig: produces an SVG per artboard and an HTML preview', () => {
  const doc = makeDoc({
    pages: [{
      id: 'p1', name: 'Page',
      children: [makeFrame('f1', 'Home'), makeFrame('f2', 'Details')],
    }],
  });
  const result = renderFig(doc);
  assert.equal(result.svgs.size, 2);
  for (const svg of result.svgs.values()) {
    assert.ok(svg.startsWith('<svg'));
  }
  assert.ok(result.html.includes('<html'));
});

test('renderFig: gradient fill emits a linearGradient def in SVG', () => {
  const gradNode: FigNode = {
    id: 'g1', type: 'RECTANGLE', name: 'Grad',
    x: 0, y: 0, width: 200, height: 100, visible: true,
    fills: [{
      type: 'GRADIENT_LINEAR',
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0 } },
        { position: 1, color: { r: 0, g: 0, b: 1 } },
      ],
      gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    }],
  };
  const frame = makeFrame('f1', 'Frame', [gradNode]);
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Page', children: [frame] }],
  });
  const { renderDoc } = buildFigRenderTree(doc);
  const svg = renderArtboardToSvg(renderDoc.artboards[0]);
  assert.ok(svg.includes('<linearGradient'), 'SVG should contain a <linearGradient>');
  assert.ok(svg.includes('stop-color="#ff0000"'), 'first gradient stop should be red');
});

test('renderFig: nested fig nodes render at absolute artboard coordinates in SVG', () => {
  const nested: FigNode = {
    id: 'n1',
    type: 'RECTANGLE',
    name: 'Nested',
    x: 12,
    y: 18,
    width: 40,
    height: 24,
    visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
  };
  const group: FigNode = {
    id: 'g1',
    type: 'GROUP',
    name: 'Group',
    x: 30,
    y: 40,
    width: 100,
    height: 80,
    visible: true,
    clipsContent: true,
    children: [nested],
  };
  const frame = makeFrame('f1', 'Frame', [group]);
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Page', children: [frame] }],
  });

  const svg = renderFig(doc).svgs.get('Frame')!;
  assert.match(svg, /<clipPath id="clip_\d+"><rect x="30" y="40" width="100" height="80" \/><\/clipPath>/);
  assert.ok(svg.includes('<rect x="42" y="58" width="40" height="24" fill="#ff0000"'));
});

test('renderFig: real image fill emits an <image> tag with the data URI', () => {
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  const images = new Map<string, FigImageAsset>();
  images.set('hash1', { hash: 'hash1', data: pngBytes, mime: 'image/png' });

  const imgNode: FigNode = {
    id: 'i1', type: 'RECTANGLE', name: 'Photo',
    x: 0, y: 0, width: 100, height: 100, visible: true,
    fills: [{ type: 'IMAGE', imageRef: 'hash1' }],
  };
  const frame = makeFrame('f1', 'Frame', [imgNode]);
  const doc = makeDoc({
    pages: [{ id: 'p1', name: 'Page', children: [frame] }],
    images,
  });
  const { renderDoc } = buildFigRenderTree(doc);
  const svg = renderArtboardToSvg(renderDoc.artboards[0]);
  assert.ok(svg.includes('<image '), 'SVG should contain an <image> element');
  assert.ok(svg.includes('data:image/png;base64,'), 'image href should be a PNG data URI');
});
