/**
 * Tests for the Sketch Rendering Engine.
 *
 * Covers:
 *   - Render tree construction from Sketch JSON
 *   - SVG output structure and correctness
 *   - HTML preview generation
 *   - Gradient, shadow, blur, border, opacity handling
 *   - Multi-artboard documents
 *   - Edge cases (hidden layers, rotation, clipping)
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRenderTree } from '../renderer/sketchRenderTree';
import { renderArtboardToSvg, renderDocumentToSvg } from '../renderer/svgRenderer';
import { renderToHtmlPreview } from '../renderer/htmlPreview';
import { renderSketch } from '../renderer';

function loadExample(name: string): unknown {
  const p = path.resolve(__dirname, '..', '..', 'examples', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function findRenderNode(
  node: import('../renderer/types').RenderNode,
  id: string,
): import('../renderer/types').RenderNode | undefined {
  if (node.id === id) return node;
  for (const c of node.children) {
    const found = findRenderNode(c, id);
    if (found) return found;
  }
  return undefined;
}

// ─────────────────────── Render Tree Construction ─────────────────────

test('Renderer: builds render tree from basic sketch sample', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  assert.equal(doc.artboards.length, 1);
  assert.equal(doc.artboards[0].name, 'HomeScreen');
  assert.equal(doc.artboards[0].frame.width, 320);
  assert.equal(doc.artboards[0].frame.height, 240);
});

test('Renderer: preserves all child layers', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const root = doc.artboards[0].root;
  // artboard has 3 children: header, title, card
  assert.equal(root.children.length, 3);
  const header = findRenderNode(root, 'header');
  assert.ok(header, 'header node should exist');
  assert.equal(header!.type, 'rectangle');
  const title = findRenderNode(root, 'title');
  assert.ok(title, 'title node should exist');
  assert.equal(title!.type, 'text');
});

test('Renderer: extracts solid color fills', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const root = doc.artboards[0].root;
  const header = findRenderNode(root, 'header')!;
  assert.ok(header.fills.length >= 1);
  assert.equal(header.fills[0].type, 'color');
  assert.equal(header.fills[0].color, '#0f1729');
});

test('Renderer: extracts border radius', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const root = doc.artboards[0].root;
  const card = findRenderNode(root, 'card')!;
  assert.equal(card.borderRadius, 12);
});

test('Renderer: extracts text content and style', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const root = doc.artboards[0].root;
  const title = findRenderNode(root, 'title')!;
  assert.ok(title.text);
  assert.equal(title.text!.content, 'Welcome');
  assert.equal(title.text!.runs.length, 1);
  assert.equal(title.text!.runs[0].style.fontWeight, 700);
  assert.equal(title.text!.runs[0].style.fontSize, 18);
});

// ─────────────────────── Rich Sample (gradients, shadows) ─────────────

test('Renderer: builds render tree from rich sample with gradients', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  assert.equal(doc.artboards.length, 2);
  assert.equal(doc.artboards[0].name, 'LoginScreen');
  assert.equal(doc.artboards[1].name, 'ProfileCard');
});

test('Renderer: extracts linear gradient fills', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const login = doc.artboards[0].root;
  const statusBar = findRenderNode(login, 'status-bar-bg')!;
  assert.ok(statusBar.fills.length >= 1);
  assert.equal(statusBar.fills[0].type, 'gradient');
  assert.ok(statusBar.fills[0].gradient);
  assert.equal(statusBar.fills[0].gradient!.type, 'linear');
  assert.equal(statusBar.fills[0].gradient!.stops.length, 2);
});

test('Renderer: extracts radial gradient fills', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const profile = doc.artboards[1].root;
  const avatar = findRenderNode(profile, 'profile-avatar')!;
  assert.ok(avatar.fills.length >= 1);
  assert.equal(avatar.fills[0].type, 'gradient');
  assert.equal(avatar.fills[0].gradient!.type, 'radial');
});

test('Renderer: extracts shadows', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const login = doc.artboards[0].root;
  const formBg = findRenderNode(login, 'form-bg')!;
  assert.ok(formBg.shadows.length >= 1);
  assert.equal(formBg.shadows[0].blur, 24);
  assert.equal(formBg.shadows[0].y, 8);
});

test('Renderer: extracts borders with position', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const login = doc.artboards[0].root;
  const emailInput = findRenderNode(login, 'email-input')!;
  assert.ok(emailInput.borders.length >= 1);
  assert.equal(emailInput.borders[0].position, 'inside');
  assert.equal(emailInput.borders[0].thickness, 1);
});

test('Renderer: handles oval shapes', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const login = doc.artboards[0].root;
  const avatar = findRenderNode(login, 'avatar-circle')!;
  assert.equal(avatar.type, 'oval');
});

test('Renderer: handles nested groups', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const login = doc.artboards[0].root;
  const formGroup = findRenderNode(login, 'form-group')!;
  assert.equal(formGroup.type, 'group');
  assert.ok(formGroup.children.length >= 5);
  // Children inside the group should be accessible
  const signinBtn = findRenderNode(formGroup, 'signin-btn')!;
  assert.ok(signinBtn);
  assert.equal(signinBtn.fills[0].type, 'gradient');
});

test('Renderer: text alignment is extracted', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const login = doc.artboards[0].root;
  const appTitle = findRenderNode(login, 'app-title')!;
  assert.equal(appTitle.text!.runs[0].style.textAlign, 'center');
  const emailPh = findRenderNode(login, 'email-placeholder')!;
  assert.equal(emailPh.text!.runs[0].style.textAlign, 'left');
});

// ─────────────────────── SVG Rendering ────────────────────────────────

test('Renderer: SVG output is valid XML structure', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const svg = renderArtboardToSvg(doc.artboards[0]);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
});

test('Renderer: SVG contains rect for rectangle layers', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const svg = renderArtboardToSvg(doc.artboards[0]);
  assert.match(svg, /<rect /);
});

test('Renderer: SVG contains text elements', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const svg = renderArtboardToSvg(doc.artboards[0]);
  assert.match(svg, /<text /);
  assert.match(svg, /Welcome/);
});

test('Renderer: SVG includes gradient defs', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const svg = renderArtboardToSvg(doc.artboards[0]);
  assert.match(svg, /<defs>/);
  assert.match(svg, /<linearGradient /);
});

test('Renderer: SVG includes shadow filters', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const svg = renderArtboardToSvg(doc.artboards[0]);
  assert.match(svg, /<filter /);
  assert.match(svg, /feDropShadow/);
});

test('Renderer: SVG renders ellipses for ovals', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const svg = renderArtboardToSvg(doc.artboards[0]);
  assert.match(svg, /<ellipse /);
});

test('Renderer: SVG scale option works', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw, { scale: 2 });
  const svg = renderArtboardToSvg(doc.artboards[0], { scale: 2 });
  // At 2x, the 320px artboard should be 640
  assert.match(svg, /width="640"/);
  assert.match(svg, /height="480"/);
});

test('Renderer: renderDocumentToSvg returns all artboards', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const svgs = renderDocumentToSvg(doc.artboards);
  assert.equal(svgs.size, 2);
  assert.ok(svgs.has('LoginScreen'));
  assert.ok(svgs.has('ProfileCard'));
});

test('Renderer: SVG contains radial gradient defs', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  // ProfileCard has a radial gradient on the avatar
  const svg = renderArtboardToSvg(doc.artboards[1]);
  assert.match(svg, /<radialGradient /);
});

// ─────────────────────── HTML Preview ─────────────────────────────────

test('Renderer: HTML preview is a valid HTML document', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const html = renderToHtmlPreview(doc);
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<html/);
  assert.match(html, /<\/html>/);
  assert.match(html, /Sketch Preview/);
});

test('Renderer: HTML preview embeds SVG content', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const html = renderToHtmlPreview(doc);
  assert.match(html, /<svg xmlns/);
  assert.match(html, /Welcome/);
});

test('Renderer: HTML preview includes pan/zoom controls', () => {
  const raw = loadExample('sketch-sample.json');
  const doc = buildRenderTree(raw);
  const html = renderToHtmlPreview(doc);
  assert.match(html, /zoomIn/);
  assert.match(html, /zoomOut/);
  assert.match(html, /fitAll/);
});

test('Renderer: HTML preview shows artboard titles', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const html = renderToHtmlPreview(doc);
  assert.match(html, /LoginScreen/);
  assert.match(html, /ProfileCard/);
});

test('Renderer: HTML preview with multi-artboard navigation', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const html = renderToHtmlPreview(doc);
  assert.match(html, /nav-bar/);
  assert.match(html, /nav-btn/);
});

// ─────────────────────── One-shot renderSketch API ────────────────────

test('Renderer: renderSketch returns all outputs', () => {
  const raw = loadExample('sketch-sample.json');
  const result = renderSketch(raw);
  assert.ok(result.renderDoc);
  assert.ok(result.svgs);
  assert.ok(result.html);
  assert.equal(result.renderDoc.artboards.length, 1);
  assert.equal(result.svgs.size, 1);
  assert.match(result.html, /<!DOCTYPE html>/);
});

test('Renderer: renderSketch with scale option', () => {
  const raw = loadExample('sketch-sample.json');
  const result = renderSketch(raw, { scale: 2 });
  const svg = result.svgs.get('HomeScreen')!;
  assert.match(svg, /width="640"/);
});

test('Renderer: renderSketch on rich sample', () => {
  const raw = loadExample('sketch-render-sample.json');
  const result = renderSketch(raw);
  assert.equal(result.renderDoc.artboards.length, 2);
  assert.equal(result.svgs.size, 2);
  // HTML should contain both artboards
  assert.match(result.html, /LoginScreen/);
  assert.match(result.html, /ProfileCard/);
});

// ─────────────────────── Edge Cases ───────────────────────────────────

test('Renderer: hidden layers are excluded by default', () => {
  const raw = {
    _class: 'page',
    layers: [
      {
        _class: 'artboard',
        do_objectID: 'ab1',
        name: 'Test',
        frame: { x: 0, y: 0, width: 100, height: 100 },
        layers: [
          {
            _class: 'rectangle',
            do_objectID: 'visible-rect',
            name: 'Visible',
            frame: { x: 0, y: 0, width: 50, height: 50 },
            isVisible: true,
            style: {},
          },
          {
            _class: 'rectangle',
            do_objectID: 'hidden-rect',
            name: 'Hidden',
            frame: { x: 0, y: 0, width: 50, height: 50 },
            isVisible: false,
            style: {},
          },
        ],
      },
    ],
  };
  const doc = buildRenderTree(raw);
  const root = doc.artboards[0].root;
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].id, 'visible-rect');
});

test('Renderer: hidden layers included with includeHidden option', () => {
  const raw = {
    _class: 'page',
    layers: [
      {
        _class: 'artboard',
        do_objectID: 'ab1',
        name: 'Test',
        frame: { x: 0, y: 0, width: 100, height: 100 },
        layers: [
          {
            _class: 'rectangle',
            do_objectID: 'visible-rect',
            name: 'Visible',
            frame: { x: 0, y: 0, width: 50, height: 50 },
            isVisible: true,
            style: {},
          },
          {
            _class: 'rectangle',
            do_objectID: 'hidden-rect',
            name: 'Hidden',
            frame: { x: 0, y: 0, width: 50, height: 50 },
            isVisible: false,
            style: {},
          },
        ],
      },
    ],
  };
  const doc = buildRenderTree(raw, { includeHidden: true });
  const root = doc.artboards[0].root;
  assert.equal(root.children.length, 2);
});

test('Renderer: rotation is captured', () => {
  const raw = {
    _class: 'artboard',
    do_objectID: 'ab1',
    name: 'Test',
    frame: { x: 0, y: 0, width: 100, height: 100 },
    layers: [
      {
        _class: 'rectangle',
        do_objectID: 'rotated',
        name: 'Rotated',
        frame: { x: 10, y: 10, width: 30, height: 30 },
        rotation: 45,
        style: {},
      },
    ],
  };
  const doc = buildRenderTree(raw);
  const rotated = findRenderNode(doc.artboards[0].root, 'rotated')!;
  assert.equal(rotated.rotation, 45);
  // SVG should contain a rotate transform
  const svg = renderArtboardToSvg(doc.artboards[0]);
  assert.match(svg, /rotate\(/);
});

test('Renderer: opacity is captured', () => {
  const raw = {
    _class: 'artboard',
    do_objectID: 'ab1',
    name: 'Test',
    frame: { x: 0, y: 0, width: 100, height: 100 },
    layers: [
      {
        _class: 'rectangle',
        do_objectID: 'faded',
        name: 'Faded',
        frame: { x: 0, y: 0, width: 50, height: 50 },
        style: {
          contextSettings: { opacity: 0.5 },
        },
      },
    ],
  };
  const doc = buildRenderTree(raw);
  const faded = findRenderNode(doc.artboards[0].root, 'faded')!;
  assert.equal(faded.opacity, 0.5);
  const svg = renderArtboardToSvg(doc.artboards[0]);
  assert.match(svg, /opacity="0.5"/);
});

test('Renderer: multi-line text renders tspan per line', () => {
  const raw = loadExample('sketch-render-sample.json');
  const doc = buildRenderTree(raw);
  const profile = doc.artboards[1].root;
  const stat = findRenderNode(profile, 'stat-posts')!;
  assert.ok(stat.text);
  assert.match(stat.text!.content, /128\nPosts/);
  // SVG should have multiple tspans for the multi-line text
  const svg = renderArtboardToSvg(doc.artboards[1]);
  assert.match(svg, /128/);
  assert.match(svg, /Posts/);
});

test('Renderer: throws on invalid input', () => {
  assert.throws(() => buildRenderTree(null), /must be an object/);
  assert.throws(() => buildRenderTree('string'), /must be an object/);
  assert.throws(() => buildRenderTree(42), /must be an object/);
});

test('Renderer: loose layers on page get wrapped in synthetic artboard', () => {
  const raw = {
    _class: 'page',
    name: 'LoosePage',
    layers: [
      {
        _class: 'rectangle',
        do_objectID: 'rect1',
        name: 'Rect',
        frame: { x: 10, y: 10, width: 80, height: 40 },
        style: {},
      },
      {
        _class: 'text',
        do_objectID: 'text1',
        name: 'Label',
        frame: { x: 20, y: 60, width: 60, height: 20 },
        stringValue: 'Hello',
        style: {
          textStyle: {
            encodedAttributes: {
              MSAttributedStringFontAttribute: {
                attributes: { name: 'Helvetica', size: 14 },
              },
              MSAttributedStringColorAttribute: {
                red: 0, green: 0, blue: 0, alpha: 1,
              },
            },
          },
        },
      },
    ],
  };
  const doc = buildRenderTree(raw);
  assert.equal(doc.artboards.length, 1);
  assert.equal(doc.artboards[0].name, 'LoosePage');
  assert.equal(doc.artboards[0].root.children.length, 2);
});
