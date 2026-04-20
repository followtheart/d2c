/**
 * Shared types for the compare/ fidelity evaluation module.
 *
 * The fidelity module compares a *reference rendering* (Figma image
 * export, Sketch preview, or any ground-truth PNG) against the
 * *candidate rendering* (generated-code HTML preview captured by
 * Playwright) and produces a multi-dimensional report.
 */

export interface RGBAImage {
  width: number;
  height: number;
  /** RGBA, row-major, 8-bit per channel (length = width*height*4). */
  data: Uint8Array;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FidelityDimensionName =
  | 'perceptual'
  | 'color'
  | 'edge'
  | 'region'
  | 'text'
  | 'llm';

export interface DimensionScore {
  /** 0..1 — higher is better. undefined means "skipped / unavailable". */
  value: number | undefined;
  /** Base weight (renormalized across available dimensions). */
  weight: number;
  /** Human-readable one-line summary. */
  summary: string;
  /** Optional structured diagnostics. */
  details?: Record<string, unknown>;
}

export interface RegionScore {
  nodeId: string;
  name: string;
  type: string;
  bbox: BBox;
  area: number;
  ssim: number;
  deltaE: number;
  /** Aggregated per-region fidelity 0..1. */
  aggregated: number;
}

export interface TextFidelityItem {
  nodeId: string;
  content: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  /** 0..1 match score — currently structural (font/size/weight presence in generated CSS). */
  score: number;
  /** Reason if not 1.0. */
  reason?: string;
}

export interface LlmDimensionScores {
  layoutFidelity: number;
  spacingFidelity: number;
  colorFidelity: number;
  typographyFidelity: number;
  imageryFidelity: number;
  completeness: number;
  defects: string[];
  raw?: string;
}

export interface FidelityDiagnostics {
  heatmapPath?: string;
  regionTablePath?: string;
  reportPath?: string;
  referenceAlignedPath?: string;
  candidateAlignedPath?: string;
}

export interface FidelityWarning {
  code: string;
  message: string;
}

export interface AlignmentInfo {
  /** Final aligned canvas size (both images are resized to this). */
  width: number;
  height: number;
  /** Scale factors applied to the source images. */
  referenceScale: number;
  candidateScale: number;
  /** If the candidate overflowed, portion of height that was truncated (0..1). */
  candidateOverflow: number;
}

export interface FidelityReport {
  /** Version of the fidelity scoring algorithm (for report compatibility). */
  version: string;
  /** ISO timestamp. */
  generatedAt: string;
  /** Source files used. */
  inputs: {
    reference: string;
    candidate: string;
    irSnapshot?: string;
    domSnapshot?: string;
  };
  alignment: AlignmentInfo;
  dimensions: Record<FidelityDimensionName, DimensionScore>;
  /** 0..10 composite score. */
  overall: number;
  /** The weakest dimension among those that ran. */
  weakestDimension?: FidelityDimensionName;
  /** Top-N worst regions (if region layer ran). */
  worstRegions: RegionScore[];
  /** All regions (if region layer ran). */
  regions?: RegionScore[];
  /** Text-fidelity per-node breakdown. */
  texts?: TextFidelityItem[];
  /** LLM sub-scores, if LLM layer ran. */
  llm?: LlmDimensionScores;
  /** Diagnostic file paths written to disk (relative or absolute). */
  diagnostics: FidelityDiagnostics;
  warnings: FidelityWarning[];
}

export const FIDELITY_VERSION = '1.0.0';
