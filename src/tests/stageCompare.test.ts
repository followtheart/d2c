/**
 * Tests for Phase 3: multimodal stage comparison.
 *
 * Uses mock VisionProvider responses to verify the comparison pipeline
 * and report generation without requiring actual API calls.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  VisionProvider,
  buildPairPrompt,
  buildOverallPrompt,
  type StageAnalysis,
} from '../ai/visionProvider';
import { reportToMarkdown, reportToHtml, reportToJson } from '../pipeline/compareReport';
import type { ComparisonReport, PairAnalysis, OverallAnalysis } from '../pipeline/stageCompare';

// ── VisionProvider construction ───────────────────────────────────────

test('VisionProvider: throws without apiKey', () => {
  assert.throws(() => new VisionProvider({ provider: 'openrouter', apiKey: '' }));
});

test('VisionProvider: constructs with valid config', () => {
  const vp = new VisionProvider({
    provider: 'openrouter',
    apiKey: 'test-key-123',
    model: 'openai/gpt-4o',
  });
  assert.ok(vp);
});

test('VisionProvider: constructs with anthropic backend', () => {
  const vp = new VisionProvider({
    provider: 'anthropic',
    apiKey: 'test-key-456',
  });
  assert.ok(vp);
});

// ── Prompt builders ──────────────────────────────────────────────────

test('buildPairPrompt: contains stage names and analysis instructions', () => {
  const prompt = buildPairPrompt('parse', 'layout');
  assert.ok(prompt.includes('parse'));
  assert.ok(prompt.includes('layout'));
  assert.ok(prompt.includes('visualDiff'));
  assert.ok(prompt.includes('qualityScore'));
  assert.ok(prompt.includes('JSON'));
});

test('buildOverallPrompt: contains first/last stage names', () => {
  const prompt = buildOverallPrompt('parse', 'codegen');
  assert.ok(prompt.includes('parse'));
  assert.ok(prompt.includes('codegen'));
  assert.ok(prompt.includes('overall'));
});

// ── Report generation ────────────────────────────────────────────────

function makeMockReport(): ComparisonReport {
  const pair: PairAnalysis = {
    from: 'parse',
    to: 'layout',
    visualDiff: 'Layout badges were added to container nodes.',
    infoGain: 'Flex/grid/absolute layout types are now visible.',
    dataLoss: 'none',
    qualityScore: 9,
  };
  const overall: OverallAnalysis = {
    from: 'parse',
    to: 'codegen',
    visualDiff: 'Raw wireframes evolved into styled code preview.',
    infoGain: 'Semantic roles, design tokens, and generated code were added.',
    dataLoss: 'Minor spacing differences.',
    qualityScore: 8,
  };
  return {
    pairs: [
      pair,
      { from: 'layout', to: 'semantics', visualDiff: 'Role colors added.', infoGain: 'Semantic roles.', dataLoss: 'none', qualityScore: 8 },
      { from: 'semantics', to: 'tokens', visualDiff: 'Switched to style guide view.', infoGain: 'Token extraction.', dataLoss: 'Tree structure hidden.', qualityScore: 7 },
      { from: 'tokens', to: 'codegen', visualDiff: 'Code preview with syntax highlighting.', infoGain: 'Actual code output.', dataLoss: 'none', qualityScore: 9 },
    ],
    overall,
  };
}

test('reportToMarkdown: produces valid markdown', () => {
  const report = makeMockReport();
  const md = reportToMarkdown(report);
  assert.ok(md.includes('# D2C Pipeline'));
  assert.ok(md.includes('Quality Summary'));
  assert.ok(md.includes('parse → layout'));
  assert.ok(md.includes('9/10'));
  assert.ok(md.includes('Overall'));
});

test('reportToMarkdown: includes image references when imageDir provided', () => {
  const report = makeMockReport();
  const md = reportToMarkdown(report, './images');
  assert.ok(md.includes('![parse]'));
  assert.ok(md.includes('./parse.png'));
});

test('reportToHtml: produces valid HTML document', () => {
  const report = makeMockReport();
  // Use a dummy imageDir (won't inline images but should still produce HTML)
  const html = reportToHtml(report, '/nonexistent');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('D2C Pipeline'));
  assert.ok(html.includes('parse'));
  assert.ok(html.includes('codegen'));
  assert.ok(html.includes('9/10'));
});

test('reportToJson: produces valid JSON with all fields', () => {
  const report = makeMockReport();
  const json = reportToJson(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.pairs.length, 4);
  assert.equal(parsed.overall.from, 'parse');
  assert.equal(parsed.overall.to, 'codegen');
  assert.equal(parsed.overall.qualityScore, 8);
});

// ── compareStages: requires at least 2 images ────────────────────────

test('compareStages: throws with empty image dir', async () => {
  const tmpDir = path.resolve(__dirname, '..', '..', 'tmp-test-compare');
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const { compareStages } = await import('../pipeline/stageCompare');
    const vp = new VisionProvider({ provider: 'openrouter', apiKey: 'test' });
    await assert.rejects(
      () => compareStages(vp, tmpDir),
      /at least 2 stage screenshots/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
