/**
 * Basic end-to-end tests for the d2c pipeline.
 * Uses Node 22's built-in `node:test` runner — zero external dev deps.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  runMultiPagePipeline,
  runMultiPagePipelineWithVerification,
  runPipeline,
} from '../pipeline/d2cPipeline';
import { HtmlGenerator } from '../codegen/html';
import { inferLayout } from '../layout/inference';
import { parseNativeDesign, parseFigma } from '../parser';
import type { IRDocument, IRNode } from '../ir/types';

function loadExample(name: string): unknown {
  const p = path.resolve(__dirname, '..', '..', 'examples', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildMultiPageExample(): unknown {
  const desktop = loadExample('sample-design.json') as Record<string, unknown>;
  const mobile = loadExample('sample-design-mobile.json') as Record<string, unknown>;
  return {
    name: 'MultiUserCard',
    pages: [
      desktop,
      { ...mobile, name: 'UserCardMobile' },
    ],
  };
}

test('parses native design format', () => {
  const raw = loadExample('sample-design.json');
  const ir = parseNativeDesign(raw);
  assert.equal(ir.name, 'UserCard');
  assert.equal(ir.root.children.length, 5);
});

test('parses figma REST API shape', () => {
  const raw = loadExample('figma-sample.json');
  const ir = parseFigma(raw);
  assert.equal(ir.root.name, 'LoginForm');
  assert.equal(ir.root.layout.type, 'flex');
  assert.equal(ir.root.layout.direction, 'column');
});

test('layout inference: horizontal stack detected', () => {
  const raw = loadExample('sample-design.json');
  const ir = parseNativeDesign(raw);
  const laidOut = inferLayout(ir.root);
  const stats = findNode(laidOut, 'stats')!;
  assert.equal(stats.layout.type, 'flex');
  assert.equal(stats.layout.direction, 'row');
});

test('layout inference: vertical stack detected for root', () => {
  const raw = loadExample('sample-design.json');
  const ir = parseNativeDesign(raw);
  const laidOut = inferLayout(ir.root);
  assert.equal(laidOut.layout.type, 'flex');
  assert.equal(laidOut.layout.direction, 'column');
});

test('layout inference: dashboard-like two-column canvas stays absolute', () => {
  const root: IRNode = {
    id: 'root',
    name: 'Dashboard',
    type: 'container',
    box: { x: 0, y: 0, width: 360, height: 800 },
    layout: { type: 'absolute' },
    style: {},
    children: [
      {
        id: 'header',
        name: 'Header',
        type: 'container',
        box: { x: 10, y: 10, width: 340, height: 70 },
        layout: { type: 'absolute' },
        style: {},
        children: [],
      },
      {
        id: 'summary',
        name: 'Summary',
        type: 'container',
        box: { x: 20, y: 100, width: 320, height: 120 },
        layout: { type: 'absolute' },
        style: {},
        children: [],
      },
      {
        id: 'left-1',
        name: 'Left 1',
        type: 'container',
        box: { x: 30, y: 260, width: 145, height: 180 },
        layout: { type: 'absolute' },
        style: {},
        children: [],
      },
      {
        id: 'right-1',
        name: 'Right 1',
        type: 'container',
        box: { x: 185, y: 260, width: 145, height: 180 },
        layout: { type: 'absolute' },
        style: {},
        children: [],
      },
      {
        id: 'left-2',
        name: 'Left 2',
        type: 'container',
        box: { x: 30, y: 460, width: 145, height: 180 },
        layout: { type: 'absolute' },
        style: {},
        children: [],
      },
      {
        id: 'right-2',
        name: 'Right 2',
        type: 'container',
        box: { x: 185, y: 460, width: 145, height: 180 },
        layout: { type: 'absolute' },
        style: {},
        children: [],
      },
    ],
  };

  const laidOut = inferLayout(root);
  assert.equal(laidOut.layout.type, 'absolute');
});

test('pipeline end-to-end: react output', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'react' });
  assert.ok(result.generated.files.length >= 1);
  const tsx = result.generated.files[0].content;
  assert.ok(tsx.includes('import React'));
  assert.ok(tsx.includes('className='));
  // Should contain the text from our design
  assert.ok(tsx.includes('Ada Lovelace'));
  assert.ok(tsx.includes('Follow'));
});

test('pipeline end-to-end: vue output', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'vue' });
  const sfc = result.generated.files[0].content;
  assert.ok(sfc.includes('<template>'));
  assert.ok(sfc.includes('<style scoped>'));
  assert.ok(sfc.includes('Ada Lovelace'));
});

test('pipeline end-to-end: html output', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'html' });
  assert.equal(result.generated.files.length, 2);
  const html = result.generated.files.find((f) => f.path === 'index.html')!.content;
  const css = result.generated.files.find((f) => f.path === 'styles.css')!.content;
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('Ada Lovelace'));
  assert.ok(css.includes('display: flex'));
});

test('html codegen: clipped containers emit overflow hidden', () => {
  const doc: IRDocument = {
    name: 'Clipped Frame',
    width: 200,
    height: 120,
    root: {
      id: 'root',
      name: 'Root',
      type: 'container',
      box: { x: 0, y: 0, width: 200, height: 120 },
      layout: { type: 'absolute' },
      style: { overflow: 'hidden', borderRadius: 20, backgroundColor: '#ffffff' },
      children: [
        {
          id: 'drawer',
          name: 'Drawer',
          type: 'container',
          box: { x: -40, y: 10, width: 120, height: 80 },
          layout: { type: 'absolute' },
          style: { backgroundColor: '#3f8cff' },
          children: [],
        },
      ],
    },
  };

  const result = new HtmlGenerator().generate(doc);
  const css = result.files.find((file) => file.path === 'styles.css')!.content;

  assert.match(css, /overflow: hidden;/);
  assert.match(css, /border-radius: 20px;/);
});

test('html codegen: duplicate page names get unique filenames', () => {
  const makeDoc = (name: string): IRDocument => ({
    name,
    width: 100,
    height: 100,
    root: {
      id: `${name}-root`,
      name,
      type: 'container',
      box: { x: 0, y: 0, width: 100, height: 100 },
      layout: { type: 'absolute' },
      style: {},
      children: [],
    },
  });

  const result = new HtmlGenerator().generateMultiPage([
    makeDoc('Dashboard'),
    makeDoc('Dashboard'),
    makeDoc('Dashboard'),
  ]);

  const htmlFiles = result.files.filter((file) => file.path.endsWith('.html')).map((file) => file.path);
  assert.deepEqual(htmlFiles, ['Dashboard.html', 'Dashboard_2.html', 'Dashboard_3.html']);
  assert.equal(result.entryFile, 'Dashboard.html');
});

test('html codegen: multi-page nav stays single-row scrollable', () => {
  const makeDoc = (name: string): IRDocument => ({
    name,
    width: 100,
    height: 100,
    root: {
      id: `${name}-root`,
      name,
      type: 'container',
      box: { x: 0, y: 0, width: 100, height: 100 },
      layout: { type: 'absolute' },
      style: {},
      children: [],
    },
  });

  const result = new HtmlGenerator().generateMultiPage([
    makeDoc('Dashboard'),
    makeDoc('Dashboard - add'),
    makeDoc('Projects - List'),
  ]);
  const css = result.files.find((file) => file.path === 'styles.css')!.content;

  assert.match(css, /\.d2c-page-nav \{[^}]*flex-wrap:nowrap;/);
  assert.match(css, /\.d2c-page-nav \{[^}]*overflow-x:auto;/);
  assert.match(css, /\.d2c-page-nav a, \.d2c-page-nav span \{[^}]*white-space:nowrap;/);
});

test('html codegen: absolute visual inputs do not emit native input controls', () => {
  const doc: IRDocument = {
    name: 'Visual Input',
    width: 320,
    height: 200,
    root: {
      id: 'root',
      name: 'Root',
      type: 'container',
      box: { x: 0, y: 0, width: 320, height: 200 },
      layout: { type: 'absolute' },
      style: {},
      children: [
        {
          id: 'field',
          name: 'Input/withicon/right',
          type: 'input',
          box: { x: 20, y: 20, width: 280, height: 102 },
          layout: { type: 'absolute' },
          style: {},
          children: [],
          semantics: { componentName: 'InputWithiconRight', ariaLabel: 'Input with icon' },
        },
      ],
    },
  };

  const result = new HtmlGenerator().generate(doc);
  const html = result.files.find((file) => file.path === 'index.html')!.content;
  const css = result.files.find((file) => file.path === 'styles.css')!.content;

  assert.doesNotMatch(html, /<input[^>]*placeholder="Input with icon"/);
  assert.match(html, /<div class="d2c-input-withicon-right-\d+"><span class="d2c-input-placeholder-\d+">Input with icon<\/span><\/div>/);
  assert.match(css, /button, input \{[^}]*appearance: none;/);
});

test('html codegen: nested button-like nodes do not emit nested button tags', () => {
  const doc: IRDocument = {
    name: 'Nested Buttons',
    width: 280,
    height: 80,
    root: {
      id: 'root',
      name: 'Root',
      type: 'container',
      box: { x: 0, y: 0, width: 280, height: 80 },
      layout: { type: 'absolute' },
      style: {},
      children: [
        {
          id: 'outer',
          name: 'Main Button',
          type: 'container',
          box: { x: 0, y: 0, width: 280, height: 48 },
          layout: { type: 'absolute' },
          style: {},
          semantics: { role: 'button', componentName: 'MainButton', interactive: true },
          children: [
            {
              id: 'inner',
              name: 'elm/mainbutton',
              type: 'container',
              box: { x: 0, y: 0, width: 280, height: 48 },
              layout: { type: 'absolute' },
              style: { backgroundColor: '#3f8cff', borderRadius: 14 },
              semantics: { role: 'button', componentName: 'ElmMainbutton', interactive: true },
              children: [
                {
                  id: 'label',
                  name: 'Save Event',
                  type: 'text',
                  box: { x: 47, y: 13, width: 186, height: 22 },
                  layout: { type: 'absolute' },
                  style: {},
                  textStyle: {
                    content: 'Save Event',
                    fontSize: 16,
                    fontWeight: 700,
                    color: '#ffffff',
                  },
                  children: [],
                  semantics: { role: 'heading', componentName: 'SaveEvent' },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const result = new HtmlGenerator().generate(doc);
  const html = result.files.find((file) => file.path === 'index.html')!.content;

  assert.doesNotMatch(html, /<button[^>]*>\s*<button/);
  assert.match(html, /<div class="d2c-main-button-\d+">/);
  assert.match(html, /<button class="d2c-elm-mainbutton-\d+">Save Event<\/button>/);
});

test('multi-page pipeline preserves page order and merges output', async () => {
  const raw = buildMultiPageExample();
  const result = await runMultiPagePipeline(raw, {
    platform: 'html',
    multiPageConcurrency: 2,
  });

  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].ir.name, 'UserCard');
  assert.equal(result.pages[1].ir.name, 'UserCardMobile');
  assert.equal(result.generated.entryFile, 'UserCard.html');
  assert.ok(result.generated.files.some((file) => file.path === 'UserCard.html'));
  assert.ok(result.generated.files.some((file) => file.path === 'UserCardMobile.html'));
});

test('multi-page verified pipeline returns verification for every page', async () => {
  const raw = buildMultiPageExample();
  const result = await runMultiPagePipelineWithVerification(raw, {
    platform: 'html',
    multiPageConcurrency: 2,
  });

  assert.equal(result.pages.length, 2);
  assert.ok(result.pages.every((page) => page.verification.snapshots.length >= 4));
  assert.ok(result.pages.every((page) => page.verification.status));
});

test('semantic enhancer: tags list is detected', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'react' });
  const tags = findNode(result.ir.root, 'tags');
  assert.ok(tags, 'expected tags node');
  assert.equal(tags.type, 'list');
  assert.equal(tags.semantics?.role, 'list');
  assert.ok(tags.children.every((c) => c.type === 'list-item'));
});

test('semantic enhancer: follow button detected', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'react' });
  const follow = findNode(result.ir.root, 'followBtn');
  assert.ok(follow);
  assert.equal(follow.semantics?.role, 'button');
  assert.equal(follow.semantics?.interactive, true);
});

function findNode(root: IRNode, id: string): IRNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return undefined;
}
