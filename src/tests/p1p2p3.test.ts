/**
 * Tests for P1/P2/P3 features:
 *   P1: Sketch parser, design tokens extraction, Tailwind preset
 *   P2: ai:ignore protected regions + IR diff, antd/MUI matching
 *   P3: React Native + Flutter generators, responsive inference
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPipeline } from '../pipeline/d2cPipeline';
import { parseSketch, parseNativeDesign } from '../parser';
import { extractTokens, toStyleDictionary } from '../tokens/extract';
import { generateTailwindPreset } from '../tokens/tailwindPreset';
import { matchComponents } from '../ai/componentMatch';
import { diffIR, mergeProtectedRegions, formatDiff } from '../diff/merge';
import { inferLayout } from '../layout/inference';
import { inferResponsive } from '../layout/responsive';
import type { IRDocument, IRNode } from '../ir/types';

function loadExample(name: string): unknown {
  const p = path.resolve(__dirname, '..', '..', 'examples', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function findNode(root: IRNode, id: string): IRNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return undefined;
}

// ─────────────────────────────────── P1 ───────────────────────────────────

test('P1: Sketch parser produces a valid IR tree', () => {
  const raw = loadExample('sketch-sample.json');
  const ir = parseSketch(raw);
  assert.equal(ir.name, 'HomeScreen');
  assert.equal(ir.width, 320);
  assert.equal(ir.height, 240);
  assert.equal(ir.root.children.length, 3);
  const header = findNode(ir.root, 'header')!;
  assert.equal(header.style.backgroundColor, '#0f1729');
  const card = findNode(ir.root, 'card')!;
  assert.equal(card.style.borderRadius, 12);
  const title = findNode(ir.root, 'title')!;
  assert.equal(title.type, 'text');
  assert.equal(title.textStyle?.content, 'Welcome');
  assert.equal(title.textStyle?.fontWeight, 700); // Inter-Bold → 700
});

test('P1: Sketch IR runs through layout inference', () => {
  const raw = loadExample('sketch-sample.json');
  const ir = parseSketch(raw);
  const laidOut = inferLayout(ir.root);
  assert.equal(laidOut.layout.type, 'flex');
  // header (y=0) above title (y=16) above card (y=80) → vertical stack
  assert.equal(laidOut.layout.direction, 'column');
});

test('P1: Design tokens extracted from IR', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'react' });
  const tokens = result.tokens;
  // Sample design uses #0f172a, #ffffff, #64748b, etc.
  const colorValues = new Set(Object.values(tokens.colors));
  assert.ok(colorValues.has('#0f172a'));
  assert.ok(colorValues.has('#ffffff'));
  // Font sizes from sample: 12, 14, 16, 18, 20
  assert.ok(Object.values(tokens.fontSizes).includes(20));
  assert.ok(Object.values(tokens.fontSizes).includes(12));
  // Spacing — padding 24, 12, 6 from sample
  assert.ok(Object.values(tokens.spacings).includes(24));
});

test('P1: Style-dictionary shape', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'react' });
  const sd = result.styleDictionary;
  // Each token slot should expose `value` + `type`
  const firstColor = Object.values(sd.color)[0];
  assert.ok(firstColor);
  assert.equal(firstColor.type, 'color');
  assert.ok(typeof firstColor.value === 'string');
});

test('P1: Tailwind preset generation', () => {
  const raw = loadExample('sample-design.json');
  const ir = parseNativeDesign(raw);
  const tokens = extractTokens(ir);
  const preset = generateTailwindPreset(tokens);
  assert.match(preset, /module\.exports = \{/);
  assert.match(preset, /theme: \{/);
  assert.match(preset, /extend: \{/);
  assert.match(preset, /colors:/);
  assert.match(preset, /fontSize:/);
  assert.match(preset, /spacing:/);
});

// ─────────────────────────────────── P2 ───────────────────────────────────

test('P2: ai:ignore protected regions are preserved on regeneration', () => {
  const raw = loadExample('sample-design.json');
  const ir1 = parseNativeDesign(raw);
  // Mark the followBtn as protected with custom annotation
  const followBtn = findNode(ir1.root, 'followBtn')!;
  followBtn.semantics = {
    ...followBtn.semantics,
    aiIgnore: true,
    componentName: 'CustomFollowButton',
    dataBinding: 'profile.followAction',
  };

  // Simulate a regeneration: parse again to get a fresh tree
  const ir2 = parseNativeDesign(raw);
  const merged = mergeProtectedRegions(ir1, ir2);
  const protectedNode = findNode(merged.root, 'followBtn')!;
  assert.equal(protectedNode.semantics?.aiIgnore, true);
  assert.equal(protectedNode.semantics?.componentName, 'CustomFollowButton');
  assert.equal(protectedNode.semantics?.dataBinding, 'profile.followAction');
});

test('P2: IR diff reports added / removed / changed nodes', () => {
  const raw = loadExample('sample-design.json');
  const a = parseNativeDesign(raw);
  const b = parseNativeDesign(raw);
  // Mutate the second tree
  const bio = findNode(b.root, 'bio')!;
  bio.textStyle!.content = 'Updated bio';
  // Drop the last tag
  const tags = findNode(b.root, 'tags')!;
  tags.children.pop();

  const entries = diffIR(a, b);
  const changed = entries.find((e) => e.id === 'bio');
  assert.ok(changed, 'expected bio to be in diff');
  assert.equal(changed.kind, 'changed');
  assert.ok(changed.fields?.includes('textStyle'));
  // tag3 plus its text child should be removed
  const removed = entries.find((e) => e.id === 'tag3');
  assert.ok(removed);
  assert.equal(removed.kind, 'removed');
  // formatDiff should be a multi-line string
  const formatted = formatDiff(entries);
  assert.match(formatted, /tag3/);
});

test('P2: antd component matching', () => {
  const raw = loadExample('sample-design.json');
  const ir = parseNativeDesign(raw);
  const laidOut = inferLayout(ir.root);
  const matched = matchComponents(laidOut, 'antd');
  const followBtn = findNode(matched, 'followBtn')!;
  assert.equal(followBtn.semantics?.library?.name, 'antd');
  assert.equal(followBtn.semantics?.library?.component, 'Button');
  assert.equal(followBtn.semantics?.library?.props?.type, 'primary');
  // Avatar should match
  const avatar = findNode(matched, 'avatar')!;
  assert.equal(avatar.semantics?.library?.component, 'Avatar');
});

test('P2: MUI component matching', () => {
  const raw = loadExample('sample-design.json');
  const ir = parseNativeDesign(raw);
  const laidOut = inferLayout(ir.root);
  const matched = matchComponents(laidOut, 'mui');
  const followBtn = findNode(matched, 'followBtn')!;
  assert.equal(followBtn.semantics?.library?.name, 'mui');
  assert.equal(followBtn.semantics?.library?.component, 'Button');
  assert.equal(followBtn.semantics?.library?.props?.variant, 'contained');
});

test('P2: pipeline plumbs componentLibrary option', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, {
    platform: 'react',
    componentLibrary: 'antd',
  });
  const followBtn = findNode(result.ir.root, 'followBtn')!;
  assert.equal(followBtn.semantics?.library?.component, 'Button');
});

// ─────────────────────────────────── P3 ───────────────────────────────────

test('P3: React Native generator emits a compilable .tsx', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'react-native' });
  assert.equal(result.generated.files.length, 1);
  const tsx = result.generated.files[0].content;
  assert.match(tsx, /from 'react-native'/);
  assert.match(tsx, /StyleSheet\.create\({/);
  assert.match(tsx, /<View/);
  assert.match(tsx, /<Text/);
  // Image gets a uri source
  assert.match(tsx, /Image source=\{\{ uri:/);
  // The bio text should be present
  assert.match(tsx, /Ada Lovelace/);
});

test('P3: Flutter generator emits Dart widget', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipeline(raw, { platform: 'flutter' });
  assert.equal(result.generated.files.length, 1);
  const dart = result.generated.files[0].content;
  assert.match(dart, /import 'package:flutter\/material\.dart';/);
  assert.match(dart, /class UserCard extends StatelessWidget/);
  assert.match(dart, /Container\(/);
  assert.match(dart, /Column\(|Row\(/);
  // Text widget
  assert.match(dart, /Text\(/);
  // Color conversion
  assert.match(dart, /Color\(0xFF[0-9A-F]{6}\)/);
});

test('P3: Responsive variants stamped on the base IR', () => {
  const baseRaw = loadExample('sample-design.json');
  const mobileRaw = loadExample('sample-design-mobile.json');
  const base = parseNativeDesign(baseRaw);
  const mobile = parseNativeDesign(mobileRaw);
  const baseLaid: IRDocument = { ...base, root: inferLayout(base.root) };
  const mobileLaid: IRDocument = { ...mobile, root: inferLayout(mobile.root) };
  const merged = inferResponsive(baseLaid, [
    { breakpoint: 'sm', doc: mobileLaid },
  ]);
  // The root has a different width on mobile
  assert.ok(merged.root.responsive);
  assert.ok(merged.root.responsive!.sm);
  // The bio font size differs between desktop (14) and mobile (13)
  const bio = findNode(merged.root, 'bio')!;
  assert.ok(bio.responsive?.sm?.textStyle);
  assert.equal(bio.responsive!.sm!.textStyle!.fontSize, 13);
});

test('P3: Pipeline accepts responsive variants end-to-end', async () => {
  const baseRaw = loadExample('sample-design.json');
  const mobileRaw = loadExample('sample-design-mobile.json');
  const mobileParsed = parseNativeDesign(mobileRaw);
  const result = await runPipeline(baseRaw, {
    platform: 'react',
    responsiveVariants: [
      {
        breakpoint: 'sm',
        doc: { ...mobileParsed, root: inferLayout(mobileParsed.root) },
      },
    ],
  });
  // The IR should carry responsive overrides somewhere
  let found = false;
  const visit = (n: IRNode) => {
    if (n.responsive && Object.keys(n.responsive).length) found = true;
    for (const c of n.children) visit(c);
  };
  visit(result.ir.root);
  assert.ok(found, 'expected at least one node with responsive overrides');
});
