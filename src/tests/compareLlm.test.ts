/**
 * Unit tests for the LLM perceptual-judgment layer.
 * Only local prompt + parser logic is exercised — no network calls.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildFidelityPrompt,
  averageLlmScore,
} from '../compare/llmPerceptual';
import type { LlmDimensionScores } from '../compare/types';

test('buildFidelityPrompt: contains the six required dimension keys', () => {
  const p = buildFidelityPrompt();
  for (const k of [
    'layoutFidelity',
    'spacingFidelity',
    'colorFidelity',
    'typographyFidelity',
    'imageryFidelity',
    'completeness',
  ]) {
    assert.ok(p.includes(k), `prompt missing ${k}`);
  }
  assert.ok(p.includes('strict JSON'));
});

test('averageLlmScore: all 10s → 1.0', () => {
  const s: LlmDimensionScores = {
    layoutFidelity: 10,
    spacingFidelity: 10,
    colorFidelity: 10,
    typographyFidelity: 10,
    imageryFidelity: 10,
    completeness: 10,
    defects: [],
  };
  assert.equal(averageLlmScore(s), 1);
});

test('averageLlmScore: all 0s → 0', () => {
  const s: LlmDimensionScores = {
    layoutFidelity: 0,
    spacingFidelity: 0,
    colorFidelity: 0,
    typographyFidelity: 0,
    imageryFidelity: 0,
    completeness: 0,
    defects: [],
  };
  assert.equal(averageLlmScore(s), 0);
});

test('averageLlmScore: mixed → mean/10', () => {
  const s: LlmDimensionScores = {
    layoutFidelity: 8,
    spacingFidelity: 8,
    colorFidelity: 8,
    typographyFidelity: 8,
    imageryFidelity: 8,
    completeness: 8,
    defects: [],
  };
  assert.equal(averageLlmScore(s), 0.8);
});
