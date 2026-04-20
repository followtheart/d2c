/**
 * Composite score calculation.
 *
 * Weighted arithmetic mean across the six dimensions.  Missing
 * dimensions get their weight redistributed, so the overall score
 * stays meaningful even when (say) the LLM layer is disabled.
 */
import type { DimensionScore, FidelityDimensionName } from './types';

export const DEFAULT_WEIGHTS: Record<FidelityDimensionName, number> = {
  perceptual: 0.25,
  color: 0.15,
  edge: 0.1,
  region: 0.25,
  text: 0.1,
  llm: 0.15,
};

export interface CompositeInput {
  perceptual?: number;
  color?: number;
  edge?: number;
  region?: number;
  text?: number;
  llm?: number;
}

export interface CompositeResult {
  /** 0..10 overall score. */
  overall: number;
  /** Normalized weights actually used (sum to 1). */
  effectiveWeights: Record<FidelityDimensionName, number>;
  /** Name of the dimension with the lowest score among those present. */
  weakest?: FidelityDimensionName;
}

/**
 * Compose the final overall score from the per-dimension values.
 * Dimensions set to `undefined` are treated as unavailable and get
 * their weight redistributed proportionally.
 */
export function compose(
  values: CompositeInput,
  weights: Partial<Record<FidelityDimensionName, number>> = {},
): CompositeResult {
  const w: Record<FidelityDimensionName, number> = {
    ...DEFAULT_WEIGHTS,
    ...weights,
  };

  const present: FidelityDimensionName[] = [];
  for (const name of Object.keys(DEFAULT_WEIGHTS) as FidelityDimensionName[]) {
    if (typeof values[name] === 'number') present.push(name);
  }

  if (present.length === 0) {
    return { overall: 0, effectiveWeights: zeroWeights(), weakest: undefined };
  }

  const totalWeight = present.reduce((acc, n) => acc + w[n], 0);
  const effective: Record<FidelityDimensionName, number> = zeroWeights();
  for (const n of present) effective[n] = w[n] / totalWeight;

  let sum = 0;
  let weakest: FidelityDimensionName | undefined;
  let weakestVal = Infinity;
  for (const n of present) {
    const v = values[n] as number;
    sum += v * effective[n];
    if (v < weakestVal) {
      weakestVal = v;
      weakest = n;
    }
  }

  return {
    overall: Math.max(0, Math.min(10, sum * 10)),
    effectiveWeights: effective,
    weakest,
  };
}

function zeroWeights(): Record<FidelityDimensionName, number> {
  return {
    perceptual: 0,
    color: 0,
    edge: 0,
    region: 0,
    text: 0,
    llm: 0,
  };
}

/**
 * Produce a DimensionScore for a raw 0..1 value.  Used when building
 * the report dimensions from raw metric outputs.
 */
export function toDimension(
  name: FidelityDimensionName,
  value: number | undefined,
  summary: string,
  details?: Record<string, unknown>,
): DimensionScore {
  return {
    value: value === undefined ? undefined : clamp01(value),
    weight: DEFAULT_WEIGHTS[name],
    summary,
    details,
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
