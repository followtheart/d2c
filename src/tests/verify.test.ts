/**
 * Tests for the pipeline verification system.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPipelineWithVerification } from '../pipeline/d2cPipeline';
import {
  verifyParse,
  verifyLayout,
  verifySemantics,
  verifyTokens,
  verifyCodegen,
  verifyProtectedMerge,
  formatVerificationReport,
  snapshotToJSON,
} from '../pipeline/verify';
import { parseNativeDesign } from '../parser';
import { inferLayout } from '../layout/inference';
import { enhance } from '../ai/semanticEnhancer';
import { extractTokens } from '../tokens/extract';
import type { IRDocument, IRNode } from '../ir/types';
import type { GenerateResult } from '../codegen/base';

function loadExample(name: string): unknown {
  const p = path.resolve(__dirname, '..', '..', 'examples', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── verifyParse ─────────────────────────────────────────────────────

test('verifyParse: valid document passes all checks', () => {
  const raw = loadExample('sample-design.json');
  const doc = parseNativeDesign(raw);
  const checks = verifyParse(doc);
  const fails = checks.filter((c) => c.level === 'fail');
  assert.equal(fails.length, 0, `Unexpected failures: ${JSON.stringify(fails)}`);
  assert.ok(checks.some((c) => c.rule === 'parse.name' && c.level === 'pass'));
  assert.ok(checks.some((c) => c.rule === 'parse.uniqueIds' && c.level === 'pass'));
});

test('verifyParse: empty name is flagged as fail', () => {
  const doc: IRDocument = {
    name: '',
    width: 100,
    height: 100,
    root: {
      id: 'r',
      type: 'container',
      name: 'root',
      box: { x: 0, y: 0, width: 100, height: 100 },
      layout: { type: 'flex' },
      style: {},
      children: [],
    },
  };
  const checks = verifyParse(doc);
  assert.ok(checks.some((c) => c.rule === 'parse.name' && c.level === 'fail'));
});

test('verifyParse: duplicate ids are flagged as fail', () => {
  const doc: IRDocument = {
    name: 'Test',
    width: 100,
    height: 100,
    root: {
      id: 'dup',
      type: 'container',
      name: 'root',
      box: { x: 0, y: 0, width: 100, height: 100 },
      layout: { type: 'flex' },
      style: {},
      children: [
        {
          id: 'dup', // duplicate
          type: 'text',
          name: 'child',
          box: { x: 0, y: 0, width: 50, height: 20 },
          layout: { type: 'flex' },
          style: {},
          textStyle: { content: 'hi', fontSize: 14, fontWeight: 400, color: '#000' },
          children: [],
        },
      ],
    },
  };
  const checks = verifyParse(doc);
  assert.ok(checks.some((c) => c.rule === 'parse.duplicateIds' && c.level === 'fail'));
});

// ── verifyLayout ────────────────────────────────────────────────────

test('verifyLayout: inferred layout has flex nodes', () => {
  const raw = loadExample('sample-design.json');
  const doc = parseNativeDesign(raw);
  const layoutRoot = inferLayout(doc.root);
  const layoutDoc: IRDocument = { ...doc, root: layoutRoot };
  const checks = verifyLayout(layoutDoc);
  const distCheck = checks.find((c) => c.rule === 'layout.distribution');
  assert.ok(distCheck);
  assert.ok(distCheck.message.includes('flex:'));
});

// ── verifySemantics ─────────────────────────────────────────────────

test('verifySemantics: enhanced tree has roles', async () => {
  const raw = loadExample('sample-design.json');
  const doc = parseNativeDesign(raw);
  const layoutRoot = inferLayout(doc.root);
  const enhanced = await enhance(layoutRoot);
  const semanticDoc: IRDocument = { ...doc, root: enhanced };
  const checks = verifySemantics(semanticDoc);
  assert.ok(checks.some((c) => c.rule === 'semantics.roles' && c.level === 'pass'));
  assert.ok(checks.some((c) => c.rule === 'semantics.componentNames' && c.level === 'pass'));
});

// ── verifyTokens ────────────────────────────────────────────────────

test('verifyTokens: tokens from sample design are valid', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipelineWithVerification(raw, { platform: 'react' });
  const checks = verifyTokens(result.tokens);
  const fails = checks.filter((c) => c.level === 'fail');
  assert.equal(fails.length, 0);
  assert.ok(checks.some((c) => c.rule === 'tokens.summary'));
});

// ── verifyCodegen ───────────────────────────────────────────────────

test('verifyCodegen: react output passes', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipelineWithVerification(raw, { platform: 'react' });
  const checks = verifyCodegen(result.generated, 'react');
  const fails = checks.filter((c) => c.level === 'fail');
  assert.equal(fails.length, 0);
  assert.ok(checks.some((c) => c.rule === 'codegen.fileCount' && c.level === 'pass'));
});

test('verifyCodegen: empty output is flagged as fail', () => {
  const empty: GenerateResult = { files: [], entryFile: 'index.tsx' };
  const checks = verifyCodegen(empty, 'react');
  assert.ok(checks.some((c) => c.rule === 'codegen.noFiles' && c.level === 'fail'));
});

// ── verifyProtectedMerge ────────────────────────────────────────────

test('verifyProtectedMerge: no previous IR is ok', () => {
  const doc: IRDocument = {
    name: 'Test',
    width: 100,
    height: 100,
    root: {
      id: 'r',
      type: 'container',
      name: 'root',
      box: { x: 0, y: 0, width: 100, height: 100 },
      layout: { type: 'flex' },
      style: {},
      children: [],
    },
  };
  const checks = verifyProtectedMerge(doc);
  assert.ok(checks.some((c) => c.rule === 'protectedMerge.skipped'));
});

// ── End-to-end verified pipeline ────────────────────────────────────

test('runPipelineWithVerification: produces snapshots for all stages', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipelineWithVerification(raw, { platform: 'react' });
  const { verification } = result;

  // Should have at least parse + layout + semantics + tokens + codegen
  assert.ok(verification.snapshots.length >= 5);

  const stageNames = verification.snapshots.map((s) => s.stage);
  assert.ok(stageNames.includes('parse'));
  assert.ok(stageNames.includes('layout'));
  assert.ok(stageNames.includes('semantics'));
  assert.ok(stageNames.includes('tokens'));
  assert.ok(stageNames.includes('codegen'));

  // No failures expected for sample design
  assert.notEqual(verification.status, 'fail');
  assert.ok(verification.summary.includes('passed'));
});

test('runPipelineWithVerification: snapshots carry IR data', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipelineWithVerification(raw, { platform: 'react' });
  const { verification } = result;

  const parseSnap = verification.snapshots.find((s) => s.stage === 'parse');
  assert.ok(parseSnap?.ir, 'parse snapshot should include IR');
  assert.equal(parseSnap!.ir!.name, 'UserCard');

  const layoutSnap = verification.snapshots.find((s) => s.stage === 'layout');
  assert.ok(layoutSnap?.ir, 'layout snapshot should include IR');

  const tokenSnap = verification.snapshots.find((s) => s.stage === 'tokens');
  assert.ok(tokenSnap?.tokens, 'tokens snapshot should include token set');

  const codegenSnap = verification.snapshots.find((s) => s.stage === 'codegen');
  assert.ok(codegenSnap?.generated, 'codegen snapshot should include generated files');
});

// ── formatVerificationReport ────────────────────────────────────────

test('formatVerificationReport: produces readable output', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipelineWithVerification(raw, { platform: 'react' });
  const report = formatVerificationReport(result.verification);

  assert.ok(report.includes('Pipeline Verification Report'));
  assert.ok(report.includes('Parse'));
  assert.ok(report.includes('Layout Inference'));
  assert.ok(report.includes('Semantic Enhancement'));
  assert.ok(report.includes('Token Extraction'));
  assert.ok(report.includes('Code Generation'));
  assert.ok(report.includes('Summary:'));
});

// ── snapshotToJSON ──────────────────────────────────────────────────

test('snapshotToJSON: codegen snapshot truncates content', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipelineWithVerification(raw, { platform: 'react' });
  const codegenSnap = result.verification.snapshots.find((s) => s.stage === 'codegen');
  assert.ok(codegenSnap);

  const json = snapshotToJSON(codegenSnap!) as Record<string, unknown>;
  assert.equal(json.stage, 'codegen');
  const gen = json.generated as { files: Array<{ path: string; size: number; preview: string }> };
  assert.ok(gen.files.length > 0);
  assert.ok(typeof gen.files[0].size === 'number');
  assert.ok(typeof gen.files[0].preview === 'string');
});

// ── Multi-platform verification ─────────────────────────────────────

test('runPipelineWithVerification: vue output passes', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipelineWithVerification(raw, { platform: 'vue' });
  assert.notEqual(result.verification.status, 'fail');
});

test('runPipelineWithVerification: html output passes', async () => {
  const raw = loadExample('sample-design.json');
  const result = await runPipelineWithVerification(raw, { platform: 'html' });
  assert.notEqual(result.verification.status, 'fail');
});
