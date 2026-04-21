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
import { inferLayout } from '../layout/inference';
import { parseNativeDesign, parseFigma } from '../parser';
import type { IRNode } from '../ir/types';

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
