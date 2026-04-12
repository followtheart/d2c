/**
 * End-to-end Design-to-Code pipeline.
 *
 *   Parse → IR → Layout Inference → Semantic Enhancement →
 *     [Component matching] → [Responsive merge] → [Protected merge] → Codegen
 *     ↓
 *   [Design tokens + optional Tailwind preset]
 */
import type { IRDocument } from '../ir/types';
import { parseDesign, DesignFormat } from '../parser';
import { inferLayout } from '../layout/inference';
import { enhance, LLMProvider } from '../ai/semanticEnhancer';
import { createGenerator, Platform } from '../codegen/factory';
import type { GenerateResult } from '../codegen/base';
import { matchComponents, LibraryTarget } from '../ai/componentMatch';
import { extractTokens, TokenSet, toStyleDictionary } from '../tokens/extract';
import { generateTailwindPreset } from '../tokens/tailwindPreset';
import {
  inferResponsive,
  ResponsiveVariantInput,
} from '../layout/responsive';
import {
  mergeProtectedRegions,
  diffIR,
  IRDiffEntry,
} from '../diff/merge';

export interface PipelineOptions {
  format?: DesignFormat;
  platform: Platform;
  llm?: LLMProvider;
  verbose?: boolean;
  /** Match against a known component library (antd / mui). */
  componentLibrary?: LibraryTarget;
  /** Responsive variants (different viewports of the same design). */
  responsiveVariants?: ResponsiveVariantInput[];
  /** Previous IR to merge protected (`ai:ignore`) regions from. */
  previousIR?: IRDocument;
  /** Compute and return a structural diff against `previousIR`. */
  computeDiff?: boolean;
}

export interface PipelineResult {
  ir: IRDocument;
  generated: GenerateResult;
  tokens: TokenSet;
  styleDictionary: ReturnType<typeof toStyleDictionary>;
  tailwindPreset: string;
  diff?: IRDiffEntry[];
}

function log(verbose: boolean | undefined, msg: string): void {
  if (verbose) console.error(msg);
}

export async function runPipeline(
  rawInput: unknown,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  log(opts.verbose, '[1/7] Parsing design file...');
  const parsed = parseDesign(rawInput, opts.format ?? 'auto');

  log(opts.verbose, '[2/7] Inferring layouts...');
  const layoutTree = inferLayout(parsed.root);

  log(opts.verbose, '[3/7] Semantic enhancement...');
  let enhancedTree = await enhance(layoutTree, { llm: opts.llm });

  if (opts.componentLibrary) {
    log(opts.verbose, `[3.5/7] Matching ${opts.componentLibrary} components...`);
    enhancedTree = matchComponents(enhancedTree, opts.componentLibrary);
  }

  let ir: IRDocument = { ...parsed, root: enhancedTree };

  if (opts.responsiveVariants && opts.responsiveVariants.length) {
    log(opts.verbose, '[4/7] Inferring responsive overrides...');
    ir = inferResponsive(ir, opts.responsiveVariants);
  }

  let diff: IRDiffEntry[] | undefined;
  if (opts.previousIR) {
    log(opts.verbose, '[5/7] Merging protected regions from previous IR...');
    if (opts.computeDiff) diff = diffIR(opts.previousIR, ir);
    ir = mergeProtectedRegions(opts.previousIR, ir);
  }

  log(opts.verbose, '[6/7] Extracting design tokens...');
  const tokens = extractTokens(ir);
  const styleDictionary = toStyleDictionary(tokens);
  const tailwindPreset = generateTailwindPreset(tokens);

  log(opts.verbose, `[7/7] Generating ${opts.platform} code...`);
  const generator = createGenerator(opts.platform);
  const generated = generator.generate(ir);

  log(opts.verbose, 'Done.');
  return {
    ir,
    generated,
    tokens,
    styleDictionary,
    tailwindPreset,
    diff,
  };
}
