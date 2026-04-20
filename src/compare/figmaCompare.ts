/**
 * Figma-vs-codegen fidelity orchestrator.
 *
 * Public entry point: `runFigmaFidelity()` — takes a reference PNG,
 * a candidate PNG, and optional IR/codegen context, and returns a
 * full FidelityReport.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { IRDocument } from '../ir/types';
import type { GenerateResult } from '../codegen/base';
import type { VisionProvider } from '../ai/visionProvider';
import type {
  FidelityReport,
  FidelityWarning,
  FidelityDimensionName,
  DimensionScore,
} from './types';
import { FIDELITY_VERSION } from './types';
import { isPngIOAvailable, readPng, writePng } from './pngIO';
import { alignImages } from './align';
import { msSSIM } from './metrics/ssim';
import { deltaEStats } from './metrics/deltaE';
import { phashSimilarity } from './metrics/phash';
import { edgeIoU } from './metrics/edges';
import { buildDiffHeatmap } from './metrics/heatmap';
import { evaluateRegions } from './region';
import { evaluateText } from './text';
import { evaluateWithLlm } from './llmPerceptual';
import { compose, toDimension } from './compose';

export interface FigmaFidelityOptions {
  referencePath: string;
  candidatePath: string;
  ir?: IRDocument;
  generated?: GenerateResult;
  vision?: VisionProvider;
  outputDir?: string;
  /** If true, write aligned images + heatmap PNGs to outputDir. */
  writeDiagnostics?: boolean;
  /** Override dimension weights. */
  weights?: Partial<Record<FidelityDimensionName, number>>;
  /** Progress callback. */
  onProgress?: (msg: string) => void;
  /** Skip specific layers (useful for speed). */
  skip?: Partial<Record<FidelityDimensionName, boolean>>;
}

/**
 * Run the full fidelity evaluation pipeline.
 */
export async function runFigmaFidelity(
  opts: FigmaFidelityOptions,
): Promise<FidelityReport> {
  const log = opts.onProgress ?? (() => {});
  const skip = opts.skip ?? {};
  const warnings: FidelityWarning[] = [];

  if (!fs.existsSync(opts.referencePath)) {
    throw new Error(`Reference image not found: ${opts.referencePath}`);
  }
  if (!fs.existsSync(opts.candidatePath)) {
    throw new Error(`Candidate image not found: ${opts.candidatePath}`);
  }

  const dimensions: Record<FidelityDimensionName, DimensionScore> = {
    perceptual: toDimension('perceptual', undefined, 'not run'),
    color: toDimension('color', undefined, 'not run'),
    edge: toDimension('edge', undefined, 'not run'),
    region: toDimension('region', undefined, 'not run'),
    text: toDimension('text', undefined, 'not run'),
    llm: toDimension('llm', undefined, 'not run'),
  };

  const report: FidelityReport = {
    version: FIDELITY_VERSION,
    generatedAt: new Date().toISOString(),
    inputs: {
      reference: opts.referencePath,
      candidate: opts.candidatePath,
    },
    alignment: {
      width: 0,
      height: 0,
      referenceScale: 1,
      candidateScale: 1,
      candidateOverflow: 0,
    },
    dimensions,
    overall: 0,
    worstRegions: [],
    diagnostics: {},
    warnings,
  };

  // ── Text fidelity does not need pixel decoding ────────────────────
  if (opts.ir && opts.generated && !skip.text) {
    log('  text fidelity…');
    const tx = evaluateText(opts.ir, opts.generated);
    const bad = tx.items.filter((i) => i.score < 1).length;
    dimensions.text = toDimension(
      'text',
      tx.aggregate,
      `${tx.items.length} text nodes, ${bad} issue(s)`,
      { count: tx.items.length, issues: bad },
    );
    report.texts = tx.items;
  } else if (skip.text) {
    warnings.push({ code: 'text.skipped', message: 'text layer skipped by options' });
  } else if (!opts.ir || !opts.generated) {
    warnings.push({
      code: 'text.unavailable',
      message: 'text layer needs both IR and generated code; skipped',
    });
  }

  // ── Pixel-based layers require pngjs ──────────────────────────────
  if (!isPngIOAvailable()) {
    warnings.push({
      code: 'pngio.missing',
      message:
        'pngjs not installed — skipping pixel-based dimensions. Run `npm install pngjs`.',
    });
    const composite = compose(
      { text: dimensions.text.value },
      opts.weights,
    );
    report.overall = composite.overall;
    report.weakestDimension = composite.weakest;
    return report;
  }

  log('  decoding PNGs…');
  const refImg = readPng(opts.referencePath);
  const candImg = readPng(opts.candidatePath);

  log('  aligning…');
  const { reference, candidate, info } = alignImages(refImg, candImg);
  report.alignment = info;
  if (info.candidateOverflow > 0.1) {
    warnings.push({
      code: 'alignment.overflow',
      message: `Candidate overflowed reference by ${(info.candidateOverflow * 100).toFixed(1)}%`,
    });
  }

  // ── Layer 1: global pixel metrics ─────────────────────────────────
  if (!skip.perceptual) {
    log('  SSIM + pHash…');
    const ssimScore = msSSIM(reference, candidate);
    const phashScore = phashSimilarity(reference, candidate);
    const perceptual = 0.7 * ssimScore + 0.3 * phashScore;
    dimensions.perceptual = toDimension(
      'perceptual',
      perceptual,
      `SSIM ${ssimScore.toFixed(3)} · pHash ${phashScore.toFixed(3)}`,
      { ssim: ssimScore, phash: phashScore },
    );
  }

  if (!skip.color) {
    log('  ΔE2000…');
    const de = deltaEStats(reference, candidate, 2);
    const color = Math.max(0, 1 - Math.min(1, de.mean / 30));
    dimensions.color = toDimension(
      'color',
      color,
      `ΔE mean ${de.mean.toFixed(1)}, p95 ${de.p95.toFixed(1)}`,
      { ...de },
    );
  }

  if (!skip.edge) {
    log('  edge IoU…');
    const iou = edgeIoU(reference, candidate);
    dimensions.edge = toDimension(
      'edge',
      iou,
      `Sobel edge IoU ${iou.toFixed(3)}`,
      { iou },
    );
  }

  // ── Layer 2: region-level ─────────────────────────────────────────
  if (opts.ir && !skip.region) {
    log('  region metrics…');
    const regionEval = evaluateRegions(opts.ir, reference, candidate);
    dimensions.region = toDimension(
      'region',
      regionEval.aggregate,
      `${regionEval.regions.length} regions evaluated`,
      { count: regionEval.regions.length },
    );
    report.worstRegions = regionEval.worst;
    report.regions = regionEval.regions;
  } else if (!opts.ir) {
    warnings.push({
      code: 'region.noIR',
      message: 'no IR passed — region layer skipped',
    });
  }

  // ── Write diagnostics ─────────────────────────────────────────────
  let heatmapBuf: Buffer | undefined;
  if (opts.writeDiagnostics && opts.outputDir) {
    log('  heatmap…');
    fs.mkdirSync(opts.outputDir, { recursive: true });
    const heat = buildDiffHeatmap(reference, candidate);
    const heatPath = path.join(opts.outputDir, 'diff_heatmap.png');
    writePng(heat, heatPath);
    const refAligned = path.join(opts.outputDir, 'reference_aligned.png');
    const candAligned = path.join(opts.outputDir, 'candidate_aligned.png');
    writePng(reference, refAligned);
    writePng(candidate, candAligned);
    report.diagnostics.heatmapPath = heatPath;
    report.diagnostics.referenceAlignedPath = refAligned;
    report.diagnostics.candidateAlignedPath = candAligned;
    heatmapBuf = fs.readFileSync(heatPath);
  }

  // ── Layer 4: LLM multi-dim ────────────────────────────────────────
  if (opts.vision && !skip.llm) {
    try {
      log('  LLM perceptual judgment…');
      const refBuf = fs.readFileSync(opts.referencePath);
      const candBuf = fs.readFileSync(opts.candidatePath);
      const llmEval = await evaluateWithLlm(opts.vision, refBuf, candBuf, heatmapBuf);
      report.llm = llmEval.scores;
      dimensions.llm = toDimension(
        'llm',
        llmEval.normalized,
        `6-dim avg ${(llmEval.normalized * 10).toFixed(1)}/10 (${llmEval.scores.defects.length} defects)`,
        { defects: llmEval.scores.defects.length },
      );
    } catch (e) {
      warnings.push({
        code: 'llm.error',
        message: (e as Error).message,
      });
    }
  } else if (!opts.vision) {
    warnings.push({
      code: 'llm.noProvider',
      message: 'no VisionProvider passed — LLM layer skipped',
    });
  }

  // ── Compose ───────────────────────────────────────────────────────
  const composite = compose(
    {
      perceptual: dimensions.perceptual.value,
      color: dimensions.color.value,
      edge: dimensions.edge.value,
      region: dimensions.region.value,
      text: dimensions.text.value,
      llm: dimensions.llm.value,
    },
    opts.weights,
  );
  report.overall = composite.overall;
  report.weakestDimension = composite.weakest;

  log(`  overall ${report.overall.toFixed(1)}/10 (weakest: ${composite.weakest ?? 'n/a'})`);
  return report;
}
