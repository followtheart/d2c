/**
 * Stage Comparison Engine.
 *
 * Loads rendered stage screenshots (PNG) from disk and sends adjacent
 * pairs to a VisionProvider for multimodal diff analysis.  Also
 * generates a first-vs-last overall comparison.
 *
 * Usage:
 *   const report = await compareStages(vision, imageDir);
 */
import * as fs from 'fs';
import * as path from 'path';
import type { StageName } from './verify';
import {
  VisionProvider,
  buildPairPrompt,
  buildOverallPrompt,
  type StageAnalysis,
} from '../ai/visionProvider';

// ── Types ─────────────────────────────────────────────────────────────

export interface PairAnalysis {
  from: string;
  to: string;
  visualDiff: string;
  infoGain: string;
  dataLoss: string;
  qualityScore: number;
}

export interface OverallAnalysis {
  from: string;
  to: string;
  visualDiff: string;
  infoGain: string;
  dataLoss: string;
  qualityScore: number;
}

export interface ComparisonReport {
  pairs: PairAnalysis[];
  overall: OverallAnalysis;
}

// ── Ordered stage list ────────────────────────────────────────────────

const PIPELINE_STAGES: StageName[] = [
  'parse',
  'layout',
  'semantics',
  'tokens',
  'codegen',
];

// ── Core ──────────────────────────────────────────────────────────────

/**
 * Run multimodal comparison across all available stage screenshots.
 *
 * @param vision   Configured VisionProvider instance
 * @param imageDir Directory containing `<stage>.png` files
 * @param opts     Optional progress callback
 */
export async function compareStages(
  vision: VisionProvider,
  imageDir: string,
  opts?: { onProgress?: (msg: string) => void },
): Promise<ComparisonReport> {
  const log = opts?.onProgress ?? (() => {});

  // Discover available stage images
  const available = PIPELINE_STAGES.filter((s) =>
    fs.existsSync(path.join(imageDir, `${s}.png`)),
  );

  if (available.length < 2) {
    throw new Error(
      `compareStages requires at least 2 stage screenshots in "${imageDir}", ` +
        `found: [${available.join(', ')}]`,
    );
  }

  // Build adjacent pairs
  const adjacentPairs: [StageName, StageName][] = [];
  for (let i = 0; i < available.length - 1; i++) {
    adjacentPairs.push([available[i], available[i + 1]]);
  }

  // Analyze adjacent pairs sequentially (to respect rate limits)
  const pairs: PairAnalysis[] = [];
  for (const [from, to] of adjacentPairs) {
    log(`  comparing ${from} → ${to}…`);
    const fromBuf = fs.readFileSync(path.join(imageDir, `${from}.png`));
    const toBuf = fs.readFileSync(path.join(imageDir, `${to}.png`));
    const prompt = buildPairPrompt(from, to);

    const analysis = await vision.analyzeImages(
      [
        { stage: from, data: fromBuf },
        { stage: to, data: toBuf },
      ],
      prompt,
    );

    pairs.push(toPairAnalysis(from, to, analysis));
  }

  // Overall: first vs last
  const first = available[0];
  const last = available[available.length - 1];
  log(`  comparing ${first} → ${last} (overall)…`);
  const firstBuf = fs.readFileSync(path.join(imageDir, `${first}.png`));
  const lastBuf = fs.readFileSync(path.join(imageDir, `${last}.png`));
  const overallAnalysis = await vision.analyzeImages(
    [
      { stage: first, data: firstBuf },
      { stage: last, data: lastBuf },
    ],
    buildOverallPrompt(first, last),
  );

  return {
    pairs,
    overall: {
      from: first,
      to: last,
      ...pick(overallAnalysis),
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function toPairAnalysis(
  from: string,
  to: string,
  a: StageAnalysis,
): PairAnalysis {
  return { from, to, ...pick(a) };
}

function pick(a: StageAnalysis) {
  return {
    visualDiff: a.visualDiff,
    infoGain: a.infoGain,
    dataLoss: a.dataLoss,
    qualityScore: a.qualityScore,
  };
}
