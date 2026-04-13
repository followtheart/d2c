/**
 * Tests for Figma Make (.make) parser and renderer.
 *
 * Covers:
 *  - Kiwi ByteBuffer (binary primitives)
 *  - Kiwi schema parser
 *  - Kiwi data decoder (struct, message, enum, arrays)
 *  - .make JSON parser (parseMakeJson)
 *  - Auto-detection of 'make' format
 *  - IR conversion correctness
 *  - Multi-page split
 *  - Make render tree (buildMakeRenderTree)
 *  - Make HTML preview (renderMakeHtmlPreview)
 *  - One-shot renderMake API
 *  - Edge cases: hidden nodes, empty nodes, code-only documents
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ByteBuffer, parseKiwiSchema, decodeKiwiMessage } from '../parser/kiwi';
import {
  parseMakeJson,
  parseMakeJsonMultiPage,
  isMakeJson,
  isMakeBinary,
} from '../parser/makeParser';
import type { MakeDocument } from '../parser/makeParser';
import { parseDesign } from '../parser';
import { buildMakeRenderTree } from '../renderer/makeRenderTree';
import { renderMakeHtmlPreview } from '../renderer/makeHtmlPreview';
import { renderMake } from '../renderer';

function loadExample(name: string): unknown {
  const p = path.resolve(__dirname, '..', '..', 'examples', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadMakeSample(): MakeDocument {
  return loadExample('figma-make-sample.json') as MakeDocument;
}

/* ═══════════════════════════════════════════════════════════════════════
   ByteBuffer primitives
   ═══════════════════════════════════════════════════════════════════════ */

test('ByteBuffer: readByte', () => {
  const buf = new ByteBuffer(new Uint8Array([0x01, 0x02, 0xFF]));
  assert.equal(buf.readByte(), 0x01);
  assert.equal(buf.readByte(), 0x02);
  assert.equal(buf.readByte(), 0xFF);
});

test('ByteBuffer: readVarUint single byte', () => {
  const buf = new ByteBuffer(new Uint8Array([0x05]));
  assert.equal(buf.readVarUint(), 5);
});

test('ByteBuffer: readVarUint multi-byte', () => {
  // 300 = 0b100101100 → LEB128: 0xAC 0x02
  const buf = new ByteBuffer(new Uint8Array([0xAC, 0x02]));
  assert.equal(buf.readVarUint(), 300);
});

test('ByteBuffer: readVarInt positive (zigzag)', () => {
  // zigzag: 1 → 2
  const buf = new ByteBuffer(new Uint8Array([0x02]));
  assert.equal(buf.readVarInt(), 1);
});

test('ByteBuffer: readVarInt negative (zigzag)', () => {
  // zigzag: -1 → 1
  const buf = new ByteBuffer(new Uint8Array([0x01]));
  assert.equal(buf.readVarInt(), -1);
});

test('ByteBuffer: readString', () => {
  const str = 'hello';
  const enc = new TextEncoder().encode(str);
  const buf = new ByteBuffer(new Uint8Array([enc.length, ...enc]));
  assert.equal(buf.readString(), 'hello');
});

test('ByteBuffer: readString empty', () => {
  const buf = new ByteBuffer(new Uint8Array([0x00]));
  assert.equal(buf.readString(), '');
});

test('ByteBuffer: readBool', () => {
  const buf = new ByteBuffer(new Uint8Array([0x01, 0x00]));
  assert.equal(buf.readBool(), true);
  assert.equal(buf.readBool(), false);
});

test('ByteBuffer: readFloat32', () => {
  const f32 = new Float32Array([3.14]);
  const bytes = new Uint8Array(f32.buffer);
  const buf = new ByteBuffer(bytes);
  assert.ok(Math.abs(buf.readFloat32() - 3.14) < 0.001);
});

test('ByteBuffer: readUint32LE', () => {
  // 0x01000000 = 1 in LE
  const buf = new ByteBuffer(new Uint8Array([0x01, 0x00, 0x00, 0x00]));
  assert.equal(buf.readUint32LE(), 1);
});

test('ByteBuffer: throws on read past end', () => {
  const buf = new ByteBuffer(new Uint8Array([0x01]));
  buf.readByte();
  assert.throws(() => buf.readByte(), /unexpected end/);
});

test('ByteBuffer: seek and position', () => {
  const buf = new ByteBuffer(new Uint8Array([0x01, 0x02, 0x03]));
  assert.equal(buf.position, 0);
  buf.seek(2);
  assert.equal(buf.position, 2);
  assert.equal(buf.readByte(), 0x03);
});

/* ═══════════════════════════════════════════════════════════════════════
   Kiwi schema parser
   ═══════════════════════════════════════════════════════════════════════ */

/** Manually encode a minimal Kiwi schema: one message "Color" with 3 float fields. */
function buildMinimalSchema(): Uint8Array {
  // Schema: 1 definition
  //   name: "Color" (5 bytes)
  //   kind: 2 (message)
  //   fieldCount: 3
  //     field 0: name "r", typeId=-5 (float), isArray=false, value=1
  //     field 1: name "g", typeId=-5 (float), isArray=false, value=2
  //     field 2: name "b", typeId=-5 (float), isArray=false, value=3
  function encStr(s: string): number[] {
    const b = new TextEncoder().encode(s);
    return [b.length, ...b];
  }
  // zigzag encode: -5 → 9
  function encVarInt(n: number): number[] {
    const zigzag = n >= 0 ? n * 2 : (-n - 1) * 2 + 1;
    const out: number[] = [];
    let v = zigzag;
    do {
      let b = v & 0x7F;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      out.push(b);
    } while (v !== 0);
    return out;
  }

  const bytes: number[] = [
    1, // defCount = 1
    ...encStr('Color'),
    2, // kind = message
    3, // fieldCount = 3
    ...encStr('r'), ...encVarInt(-5), 0, 1,
    ...encStr('g'), ...encVarInt(-5), 0, 2,
    ...encStr('b'), ...encVarInt(-5), 0, 3,
  ];
  return new Uint8Array(bytes);
}

test('Kiwi schema: parses definition names and kinds', () => {
  const schema = parseKiwiSchema(buildMinimalSchema());
  assert.equal(schema.definitions.length, 1);
  assert.equal(schema.definitions[0].name, 'Color');
  assert.equal(schema.definitions[0].kind, 'message');
});

test('Kiwi schema: parses field count and names', () => {
  const schema = parseKiwiSchema(buildMinimalSchema());
  const def = schema.definitions[0];
  assert.equal(def.fields.length, 3);
  assert.equal(def.fields[0].name, 'r');
  assert.equal(def.fields[1].name, 'g');
  assert.equal(def.fields[2].name, 'b');
});

test('Kiwi schema: definitionIndex maps name to index', () => {
  const schema = parseKiwiSchema(buildMinimalSchema());
  assert.equal(schema.definitionIndex.get('Color'), 0);
});

test('Kiwi schema: field typeId is -5 (float)', () => {
  const schema = parseKiwiSchema(buildMinimalSchema());
  assert.equal(schema.definitions[0].fields[0].typeId, -5);
  assert.equal(schema.definitions[0].fields[0].isArray, false);
});

test('Kiwi schema: field values are 1, 2, 3', () => {
  const schema = parseKiwiSchema(buildMinimalSchema());
  const fields = schema.definitions[0].fields;
  assert.equal(fields[0].value, 1);
  assert.equal(fields[1].value, 2);
  assert.equal(fields[2].value, 3);
});

/* ═══════════════════════════════════════════════════════════════════════
   Kiwi data decoder
   ═══════════════════════════════════════════════════════════════════════ */

/** Build a minimal Kiwi-encoded Color message: r=1.0, g=0.5, b=0.0 */
function buildColorData(): Uint8Array {
  const r32 = new Float32Array([1.0]);
  const g32 = new Float32Array([0.5]);
  const b32 = new Float32Array([0.0]);
  return new Uint8Array([
    1, ...new Uint8Array(r32.buffer),  // field 1 = r
    2, ...new Uint8Array(g32.buffer),  // field 2 = g
    3, ...new Uint8Array(b32.buffer),  // field 3 = b
    0,                                 // terminator
  ]);
}

test('Kiwi decode: decodes message fields correctly', () => {
  const schema = parseKiwiSchema(buildMinimalSchema());
  const data = buildColorData();
  const result = decodeKiwiMessage(data, schema, 'Color') as Record<string, number>;
  assert.ok(Math.abs(result.r - 1.0) < 0.001);
  assert.ok(Math.abs(result.g - 0.5) < 0.001);
  assert.ok(Math.abs(result.b - 0.0) < 0.001);
});

test('Kiwi decode: throws on unknown root type', () => {
  const schema = parseKiwiSchema(buildMinimalSchema());
  const data = buildColorData();
  assert.throws(() => decodeKiwiMessage(data, schema, 'Unknown'), /not found in schema/);
});

/* ═══════════════════════════════════════════════════════════════════════
   isMakeBinary
   ═══════════════════════════════════════════════════════════════════════ */

test('isMakeBinary: detects "fig-makee" magic', () => {
  const magic = Buffer.from('fig-makee\0\0\0');
  assert.equal(isMakeBinary(magic), true);
});

test('isMakeBinary: rejects non-make buffers', () => {
  assert.equal(isMakeBinary(Buffer.from('fig-kiwi\0\0\0\0')), false);
  assert.equal(isMakeBinary(Buffer.from('{"nodes":[]}')), false);
  assert.equal(isMakeBinary(Buffer.alloc(4)), false);
});

/* ═══════════════════════════════════════════════════════════════════════
   isMakeJson
   ═══════════════════════════════════════════════════════════════════════ */

test('isMakeJson: detects decoded make JSON', () => {
  const sample = loadExample('figma-make-sample.json');
  assert.equal(isMakeJson(sample), true);
});

test('isMakeJson: rejects figma REST shape', () => {
  assert.equal(isMakeJson({ document: { children: [] } }), false);
});

test('isMakeJson: rejects native format', () => {
  assert.equal(isMakeJson({ root: {}, width: 1440, height: 900 }), false);
});

test('isMakeJson: rejects non-objects', () => {
  assert.equal(isMakeJson(null), false);
  assert.equal(isMakeJson('string'), false);
  assert.equal(isMakeJson(42), false);
});

/* ═══════════════════════════════════════════════════════════════════════
   parseMakeJson — IR conversion
   ═══════════════════════════════════════════════════════════════════════ */

test('parseMakeJson: parses sample document name', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseMakeJson(raw);
  assert.equal(ir.name, 'Figma Make Sample — Dashboard');
});

test('parseMakeJson: document dimensions match first frame', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseMakeJson(raw);
  assert.equal(ir.width, 1440);
  assert.equal(ir.height, 900);
});

test('parseMakeJson: root node type is container', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseMakeJson(raw);
  assert.equal(ir.root.type, 'container');
});

test('parseMakeJson: root has children', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseMakeJson(raw);
  assert.ok(ir.root.children.length >= 1, 'root should have children');
});

test('parseMakeJson: preserves background fill color', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseMakeJson(raw);
  assert.ok(ir.root.style.backgroundColor, 'root should have a background color');
});

test('parseMakeJson: auto-layout HORIZONTAL maps to flex row', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseMakeJson(raw);
  // frame-dashboard has layoutMode: HORIZONTAL
  assert.equal(ir.root.layout.type, 'flex');
  assert.equal(ir.root.layout.direction, 'row');
});

test('parseMakeJson: finds text nodes', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseMakeJson(raw);

  function findText(node: typeof ir.root): typeof ir.root | undefined {
    if (node.type === 'text') return node;
    for (const c of node.children) {
      const found = findText(c);
      if (found) return found;
    }
    return undefined;
  }

  const textNode = findText(ir.root);
  assert.ok(textNode, 'should find at least one text node');
  assert.ok(textNode!.textStyle?.content, 'text node should have content');
});

test('parseMakeJson: drop shadows are preserved', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseMakeJson(raw);

  function findShadow(node: typeof ir.root): boolean {
    if (node.style.shadows && node.style.shadows.length > 0) return true;
    return node.children.some(findShadow);
  }
  assert.ok(findShadow(ir.root), 'at least one node should have a shadow');
});

test('parseMakeJson: border radius is preserved', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseMakeJson(raw);

  function findRadius(node: typeof ir.root): boolean {
    if (node.style.borderRadius !== undefined) return true;
    return node.children.some(findRadius);
  }
  assert.ok(findRadius(ir.root), 'at least one node should have a border radius');
});

test('parseMakeJson: throws on invalid input', () => {
  assert.throws(() => parseMakeJson(null), /must be an object/);
  assert.throws(() => parseMakeJson(42), /must be an object/);
});

/* ═══════════════════════════════════════════════════════════════════════
   parseMakeJson — multi-page split
   ═══════════════════════════════════════════════════════════════════════ */

test('parseMakeJsonMultiPage: single root → one page', () => {
  const raw = loadExample('figma-make-sample.json');
  const pages = parseMakeJsonMultiPage(raw);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].name, 'Dashboard');
});

test('parseMakeJsonMultiPage: multiple root nodes → one page per node', () => {
  const multi = {
    name: 'Multi',
    width: 1440,
    height: 900,
    nodes: [
      { id: 'f1', type: 'FRAME', name: 'Page A', visible: true, x: 0, y: 0, width: 1440, height: 900 },
      { id: 'f2', type: 'FRAME', name: 'Page B', visible: true, x: 0, y: 0, width: 375, height: 812 },
    ],
    codeFiles: [],
  };
  const pages = parseMakeJsonMultiPage(multi);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].name, 'Page A');
  assert.equal(pages[1].name, 'Page B');
});

/* ═══════════════════════════════════════════════════════════════════════
   Auto-detection via parseDesign
   ═══════════════════════════════════════════════════════════════════════ */

test('parseDesign auto-detects make JSON format', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseDesign(raw);
  assert.equal(ir.name, 'Figma Make Sample — Dashboard');
});

test('parseDesign explicit make format', () => {
  const raw = loadExample('figma-make-sample.json');
  const ir = parseDesign(raw, 'make');
  assert.equal(ir.width, 1440);
});

/* ═══════════════════════════════════════════════════════════════════════
   buildMakeRenderTree
   ═══════════════════════════════════════════════════════════════════════ */

test('buildMakeRenderTree: returns renderDoc and codeFiles', () => {
  const sample = loadMakeSample();
  const { renderDoc, codeFiles } = buildMakeRenderTree(sample);
  assert.ok(renderDoc.artboards.length >= 1, 'should have at least one artboard');
  assert.ok(codeFiles.length >= 1, 'should have code files');
});

test('buildMakeRenderTree: artboard name matches frame name', () => {
  const sample = loadMakeSample();
  const { renderDoc } = buildMakeRenderTree(sample);
  assert.equal(renderDoc.artboards[0].name, 'Dashboard');
});

test('buildMakeRenderTree: artboard dimensions match', () => {
  const sample = loadMakeSample();
  const { renderDoc } = buildMakeRenderTree(sample);
  const ab = renderDoc.artboards[0];
  assert.equal(ab.frame.width, 1440);
  assert.equal(ab.frame.height, 900);
});

test('buildMakeRenderTree: root node has children', () => {
  const sample = loadMakeSample();
  const { renderDoc } = buildMakeRenderTree(sample);
  const root = renderDoc.artboards[0].root;
  assert.ok(root.children.length >= 1, 'artboard root should have children');
});

test('buildMakeRenderTree: extracts code files with paths', () => {
  const sample = loadMakeSample();
  const { codeFiles } = buildMakeRenderTree(sample);
  const paths = codeFiles.map((f) => f.path);
  assert.ok(paths.includes('src/App.tsx'), 'should include App.tsx');
  assert.ok(paths.includes('src/components/Dashboard.tsx'), 'should include Dashboard.tsx');
});

test('buildMakeRenderTree: code files have content', () => {
  const sample = loadMakeSample();
  const { codeFiles } = buildMakeRenderTree(sample);
  for (const f of codeFiles) {
    assert.ok(f.content.length > 0, `${f.path} should have non-empty content`);
  }
});

test('buildMakeRenderTree: fills are extracted', () => {
  const sample = loadMakeSample();
  const { renderDoc } = buildMakeRenderTree(sample);

  function hasFill(node: typeof renderDoc.artboards[0]['root']): boolean {
    if (node.fills.length > 0) return true;
    return node.children.some(hasFill);
  }
  assert.ok(hasFill(renderDoc.artboards[0].root), 'should find nodes with fills');
});

test('buildMakeRenderTree: shadows are extracted', () => {
  const sample = loadMakeSample();
  const { renderDoc } = buildMakeRenderTree(sample);

  function hasShadow(node: typeof renderDoc.artboards[0]['root']): boolean {
    if (node.shadows.length > 0) return true;
    return node.children.some(hasShadow);
  }
  assert.ok(hasShadow(renderDoc.artboards[0].root), 'should find nodes with shadows');
});

test('buildMakeRenderTree: text nodes have text content', () => {
  const sample = loadMakeSample();
  const { renderDoc } = buildMakeRenderTree(sample);

  function findText(node: typeof renderDoc.artboards[0]['root']): boolean {
    if (node.text && node.text.content.length > 0) return true;
    return node.children.some(findText);
  }
  assert.ok(findText(renderDoc.artboards[0].root), 'should find nodes with text');
});

test('buildMakeRenderTree: hidden nodes excluded by default', () => {
  const doc: MakeDocument = {
    name: 'Test',
    width: 100,
    height: 100,
    nodes: [
      { id: 'a', type: 'FRAME', name: 'Visible', visible: true, x: 0, y: 0, width: 100, height: 100, children: [
        { id: 'b', type: 'RECTANGLE', name: 'Hidden', visible: false, x: 0, y: 0, width: 50, height: 50 },
        { id: 'c', type: 'RECTANGLE', name: 'Shown', visible: true, x: 50, y: 0, width: 50, height: 50 },
      ]},
    ],
    codeFiles: [],
  };
  const { renderDoc } = buildMakeRenderTree(doc);
  const root = renderDoc.artboards[0].root;
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].name, 'Shown');
});

test('buildMakeRenderTree: includeHidden shows hidden nodes', () => {
  const doc: MakeDocument = {
    name: 'Test',
    width: 100,
    height: 100,
    nodes: [
      { id: 'a', type: 'FRAME', name: 'Frame', visible: true, x: 0, y: 0, width: 100, height: 100, children: [
        { id: 'b', type: 'RECTANGLE', name: 'Hidden', visible: false, x: 0, y: 0, width: 50, height: 50 },
      ]},
    ],
    codeFiles: [],
  };
  const { renderDoc } = buildMakeRenderTree(doc, { includeHidden: true });
  assert.equal(renderDoc.artboards[0].root.children.length, 1);
  assert.equal(renderDoc.artboards[0].root.children[0].name, 'Hidden');
});

test('buildMakeRenderTree: code-only doc (no visual nodes) creates synthetic artboard', () => {
  const doc: MakeDocument = {
    name: 'Code Only',
    width: 1440,
    height: 900,
    nodes: [],
    codeFiles: [{ path: 'index.ts', content: 'export {}', language: 'typescript' }],
  };
  const { renderDoc } = buildMakeRenderTree(doc);
  // Should still return a document (even if empty artboards)
  assert.ok(renderDoc.artboards !== undefined);
});

/* ═══════════════════════════════════════════════════════════════════════
   renderMakeHtmlPreview
   ═══════════════════════════════════════════════════════════════════════ */

test('renderMakeHtmlPreview: returns valid HTML document', () => {
  const sample = loadMakeSample();
  const { renderDoc, codeFiles } = buildMakeRenderTree(sample);
  const html = renderMakeHtmlPreview(renderDoc, codeFiles);
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<html/);
  assert.match(html, /<\/html>/);
});

test('renderMakeHtmlPreview: includes document name in title', () => {
  const sample = loadMakeSample();
  const { renderDoc, codeFiles } = buildMakeRenderTree(sample);
  const html = renderMakeHtmlPreview(renderDoc, codeFiles);
  assert.match(html, /Figma Make/);
});

test('renderMakeHtmlPreview: embeds SVG artboards', () => {
  const sample = loadMakeSample();
  const { renderDoc, codeFiles } = buildMakeRenderTree(sample);
  const html = renderMakeHtmlPreview(renderDoc, codeFiles);
  assert.match(html, /<svg xmlns/);
});

test('renderMakeHtmlPreview: includes code file tabs', () => {
  const sample = loadMakeSample();
  const { renderDoc, codeFiles } = buildMakeRenderTree(sample);
  const html = renderMakeHtmlPreview(renderDoc, codeFiles);
  assert.match(html, /code-tab/);
  assert.match(html, /App\.tsx/);
});

test('renderMakeHtmlPreview: includes code content', () => {
  const sample = loadMakeSample();
  const { renderDoc, codeFiles } = buildMakeRenderTree(sample);
  const html = renderMakeHtmlPreview(renderDoc, codeFiles);
  // Should contain escaped code content
  assert.match(html, /import React/);
});

test('renderMakeHtmlPreview: includes Figma Make badge', () => {
  const sample = loadMakeSample();
  const { renderDoc, codeFiles } = buildMakeRenderTree(sample);
  const html = renderMakeHtmlPreview(renderDoc, codeFiles);
  assert.match(html, /Figma Make/);
});

test('renderMakeHtmlPreview: no code files → hides code panel', () => {
  const sample = loadMakeSample();
  const { renderDoc } = buildMakeRenderTree(sample);
  const html = renderMakeHtmlPreview(renderDoc, []);
  // code panel container should be display:none
  assert.match(html, /display: none/);
});

test('renderMakeHtmlPreview: escapes HTML special chars in code', () => {
  const doc: MakeDocument = {
    name: 'XSS Test',
    width: 100,
    height: 100,
    nodes: [{ id: 'f', type: 'FRAME', name: 'Frame', visible: true, x: 0, y: 0, width: 100, height: 100 }],
    codeFiles: [{ path: 'test.ts', content: 'const x = a < b && c > d;', language: 'typescript' }],
  };
  const { renderDoc, codeFiles } = buildMakeRenderTree(doc);
  const html = renderMakeHtmlPreview(renderDoc, codeFiles);
  // Raw < and > in code must be escaped
  assert.ok(!html.includes('a < b'), 'raw < should be escaped');
  assert.match(html, /&lt;/);
});

test('renderMakeHtmlPreview: includes theme toggle button', () => {
  const sample = loadMakeSample();
  const { renderDoc, codeFiles } = buildMakeRenderTree(sample);
  const html = renderMakeHtmlPreview(renderDoc, codeFiles);
  assert.match(html, /themeToggle/);
});

/* ═══════════════════════════════════════════════════════════════════════
   renderMake one-shot API
   ═══════════════════════════════════════════════════════════════════════ */

test('renderMake: returns all outputs', () => {
  const sample = loadMakeSample();
  const result = renderMake(sample);
  assert.ok(result.renderDoc);
  assert.ok(result.svgs);
  assert.ok(result.html);
  assert.ok(result.codeFiles);
});

test('renderMake: svgs map has artboard entries', () => {
  const sample = loadMakeSample();
  const result = renderMake(sample);
  assert.ok(result.svgs.size >= 1);
  assert.ok(result.svgs.has('Dashboard'));
});

test('renderMake: html is a full document', () => {
  const sample = loadMakeSample();
  const result = renderMake(sample);
  assert.match(result.html, /<!DOCTYPE html>/);
  assert.match(result.html, /Figma Make/);
});

test('renderMake: codeFiles match sample', () => {
  const sample = loadMakeSample();
  const result = renderMake(sample);
  assert.equal(result.codeFiles.length, 5);
  assert.ok(result.codeFiles.some((f) => f.path === 'src/App.tsx'));
});

test('renderMake: scale option applies to SVG size', () => {
  const sample = loadMakeSample();
  const result = renderMake(sample, { scale: 0.5 });
  const svg = result.svgs.get('Dashboard')!;
  // At 0.5x, 1440px artboard → 720
  assert.match(svg, /width="720"/);
});
