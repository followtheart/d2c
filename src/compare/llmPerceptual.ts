/**
 * LLM-assisted perceptual judgment (Layer 4).
 *
 * Unlike the old single-score overall prompt, this layer asks the
 * vision model to judge *six orthogonal dimensions* and to list
 * concrete defects — making its contribution interpretable and
 * bounded.
 *
 * Input: reference rendering + candidate rendering + pixel diff
 * heatmap (as an anchor for the LLM to reason about).
 */
import type { VisionProvider } from '../ai/visionProvider';
import type { LlmDimensionScores } from './types';

const SYSTEM_PROMPT =
  'You are an expert UI visual-quality auditor.  You will receive ' +
  'a reference rendering (left) and a code-generated rendering ' +
  '(candidate, right), plus an optional pixel-diff heatmap.\n' +
  'Ignore subtle font anti-aliasing differences and minor 1-2 px ' +
  'layout jitter.  Focus on whether the UI looks like the same ' +
  'page.\n';

const INSTRUCTIONS = `
For each dimension, give an integer score 0-10:
  - layoutFidelity:     Positions/sizes of major regions.
  - spacingFidelity:    Padding, gaps, alignment.
  - colorFidelity:      Fills, borders, shadows.
  - typographyFidelity: Font face, size, weight, line height.
  - imageryFidelity:    Icons / photos / illustrations present & correct.
  - completeness:       Missing or extra elements.

Then list up to 5 specific defects with short phrases and
approximate location tags (top-left / top / top-right / left /
center / right / bottom-left / bottom / bottom-right / full).

Respond in **strict JSON** only, no extra text:
{
  "layoutFidelity": <0-10>,
  "spacingFidelity": <0-10>,
  "colorFidelity": <0-10>,
  "typographyFidelity": <0-10>,
  "imageryFidelity": <0-10>,
  "completeness": <0-10>,
  "defects": ["<description> @ <location>", ...]
}`;

export function buildFidelityPrompt(): string {
  return SYSTEM_PROMPT + INSTRUCTIONS;
}

function extractJson(s: string): string {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return '{}';
  return s.slice(start, end + 1);
}

function clamp10(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

function parseLlmResponse(text: string): LlmDimensionScores {
  const jsonStr = extractJson(text);
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      layoutFidelity: clamp10(obj.layoutFidelity),
      spacingFidelity: clamp10(obj.spacingFidelity),
      colorFidelity: clamp10(obj.colorFidelity),
      typographyFidelity: clamp10(obj.typographyFidelity),
      imageryFidelity: clamp10(obj.imageryFidelity),
      completeness: clamp10(obj.completeness),
      defects: Array.isArray(obj.defects)
        ? obj.defects.slice(0, 8).map((d) => String(d))
        : [],
      raw: text,
    };
  } catch {
    return {
      layoutFidelity: 0,
      spacingFidelity: 0,
      colorFidelity: 0,
      typographyFidelity: 0,
      imageryFidelity: 0,
      completeness: 0,
      defects: [],
      raw: text,
    };
  }
}

/**
 * Average of the six dimensions, normalized to 0..1.
 */
export function averageLlmScore(scores: LlmDimensionScores): number {
  const vals = [
    scores.layoutFidelity,
    scores.spacingFidelity,
    scores.colorFidelity,
    scores.typographyFidelity,
    scores.imageryFidelity,
    scores.completeness,
  ];
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.max(0, Math.min(1, avg / 10));
}

export interface LlmEvaluation {
  scores: LlmDimensionScores;
  normalized: number;
}

/**
 * Run the LLM judge on reference vs candidate (+ optional heatmap).
 * All images must already be PNG buffers.
 */
export async function evaluateWithLlm(
  vision: VisionProvider,
  reference: Buffer,
  candidate: Buffer,
  heatmap?: Buffer,
): Promise<LlmEvaluation> {
  const images = [
    { stage: 'reference', data: reference },
    { stage: 'candidate', data: candidate },
  ];
  if (heatmap) images.push({ stage: 'diff-heatmap', data: heatmap });

  const prompt = buildFidelityPrompt();
  // VisionProvider.analyzeImages parses its own StageAnalysis; we
  // want the raw text for our own JSON parser.  Reuse its `raw`.
  const analysis = await vision.analyzeImages(images, prompt);
  const raw = analysis.raw ?? JSON.stringify(analysis);
  const scores = parseLlmResponse(raw);
  return { scores, normalized: averageLlmScore(scores) };
}
