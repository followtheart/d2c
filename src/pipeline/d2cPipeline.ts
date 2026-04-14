/**
 * End-to-end Design-to-Code pipeline.
 *
 *   Parse → IR → Layout Inference → Semantic Enhancement →
 *     [Component matching] → [Responsive merge] → [Protected merge] → Codegen
 *     ↓
 *   [Design tokens + optional Tailwind preset]
 */
import type { IRDocument, IRMultiPageDocument } from '../ir/types';
import { parseDesign, parseDesignMultiPage, DesignFormat } from '../parser';
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
import type { StageSnapshot, VerificationResult } from './verify';
import {
  verifyParse,
  verifyLayout,
  verifySemantics,
  verifyComponentMatch,
  verifyResponsive,
  verifyProtectedMerge,
  verifyTokens,
  verifyCodegen,
  buildVerificationResult,
} from './verify';

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

// ── Verified pipeline ──────────────────────────────────────────────────

export interface VerifiedPipelineResult extends PipelineResult {
  verification: VerificationResult;
}

function cloneIR(doc: IRDocument): IRDocument {
  return JSON.parse(JSON.stringify(doc));
}

/**
 * Runs the same pipeline as `runPipeline` but captures snapshots and runs
 * validation checks at every stage.
 */
export async function runPipelineWithVerification(
  rawInput: unknown,
  opts: PipelineOptions,
): Promise<VerifiedPipelineResult> {
  const snapshots: StageSnapshot[] = [];

  // [1] Parse
  let t0 = Date.now();
  log(opts.verbose, '[1/7] Parsing design file...');
  const parsed = parseDesign(rawInput, opts.format ?? 'auto');
  const parsedDoc: IRDocument = { ...parsed };
  snapshots.push({
    stage: 'parse',
    durationMs: Date.now() - t0,
    ir: cloneIR(parsedDoc),
    checks: verifyParse(parsedDoc),
  });

  // [2] Layout inference
  t0 = Date.now();
  log(opts.verbose, '[2/7] Inferring layouts...');
  const layoutTree = inferLayout(parsed.root);
  const layoutDoc: IRDocument = { ...parsed, root: layoutTree };
  snapshots.push({
    stage: 'layout',
    durationMs: Date.now() - t0,
    ir: cloneIR(layoutDoc),
    checks: verifyLayout(layoutDoc),
  });

  // [3] Semantic enhancement
  t0 = Date.now();
  log(opts.verbose, '[3/7] Semantic enhancement...');
  let enhancedTree = await enhance(layoutTree, { llm: opts.llm });

  if (opts.componentLibrary) {
    log(opts.verbose, `[3.5/7] Matching ${opts.componentLibrary} components...`);
    enhancedTree = matchComponents(enhancedTree, opts.componentLibrary);
  }
  let ir: IRDocument = { ...parsed, root: enhancedTree };
  const semanticsDuration = Date.now() - t0;

  snapshots.push({
    stage: 'semantics',
    durationMs: semanticsDuration,
    ir: cloneIR(ir),
    checks: verifySemantics(ir),
  });

  // [3.5] Component matching (report separately)
  if (opts.componentLibrary) {
    snapshots.push({
      stage: 'componentMatch',
      durationMs: 0, // included in semantics timing
      ir: cloneIR(ir),
      checks: verifyComponentMatch(ir),
    });
  }

  // [4] Responsive inference
  if (opts.responsiveVariants && opts.responsiveVariants.length) {
    t0 = Date.now();
    log(opts.verbose, '[4/7] Inferring responsive overrides...');
    ir = inferResponsive(ir, opts.responsiveVariants);
    snapshots.push({
      stage: 'responsive',
      durationMs: Date.now() - t0,
      ir: cloneIR(ir),
      checks: verifyResponsive(ir),
    });
  }

  // [5] Protected merge
  let diff: IRDiffEntry[] | undefined;
  if (opts.previousIR) {
    t0 = Date.now();
    log(opts.verbose, '[5/7] Merging protected regions from previous IR...');
    if (opts.computeDiff) diff = diffIR(opts.previousIR, ir);
    ir = mergeProtectedRegions(opts.previousIR, ir);
    snapshots.push({
      stage: 'protectedMerge',
      durationMs: Date.now() - t0,
      ir: cloneIR(ir),
      checks: verifyProtectedMerge(ir, opts.previousIR),
    });
  }

  // [6] Token extraction
  t0 = Date.now();
  log(opts.verbose, '[6/7] Extracting design tokens...');
  const tokens = extractTokens(ir);
  const styleDictionary = toStyleDictionary(tokens);
  const tailwindPreset = generateTailwindPreset(tokens);
  snapshots.push({
    stage: 'tokens',
    durationMs: Date.now() - t0,
    tokens,
    checks: verifyTokens(tokens),
  });

  // [7] Code generation
  t0 = Date.now();
  log(opts.verbose, `[7/7] Generating ${opts.platform} code...`);
  const generator = createGenerator(opts.platform);
  const generated = generator.generate(ir);
  snapshots.push({
    stage: 'codegen',
    durationMs: Date.now() - t0,
    generated,
    checks: verifyCodegen(generated, opts.platform),
  });

  log(opts.verbose, 'Done (with verification).');
  const verification = buildVerificationResult(snapshots);

  return {
    ir,
    generated,
    tokens,
    styleDictionary,
    tailwindPreset,
    diff,
    verification,
  };
}

// 多页面 pipeline 结果
export interface MultiPagePipelineResult {
  pages: PipelineResult[];
  // 所有页面合并后的代码输出
  generated: GenerateResult;
}

// 多页面 pipeline：对每个页面分别运行 pipeline，最后合并生成代码
export async function runMultiPagePipeline(
  rawInput: unknown,
  opts: PipelineOptions,
): Promise<MultiPagePipelineResult> {
  log(opts.verbose, '[multi] Parsing all pages...');
  const multiDoc = parseDesignMultiPage(rawInput, opts.format ?? 'auto');

  // 单页面退化为原流程
  if (multiDoc.pages.length <= 1) {
    const single = await runPipeline(rawInput, opts);
    return { pages: [single], generated: single.generated };
  }

  const pageResults: PipelineResult[] = [];
  for (let i = 0; i < multiDoc.pages.length; i++) {
    const page = multiDoc.pages[i];
    log(opts.verbose, `[multi] Processing page ${i + 1}/${multiDoc.pages.length}: ${page.name}`);
    // 将单页面 IRDocument 包装为 raw input 再投入 pipeline
    const pageRaw = {
      name: page.name,
      width: page.width,
      height: page.height,
      root: page.root,
    };
    const result = await runPipeline(pageRaw, { ...opts, format: 'native' });
    pageResults.push(result);
  }

  log(opts.verbose, '[multi] Merging multi-page output...');
  const generator = createGenerator(opts.platform);
  const irs = pageResults.map((r) => r.ir);
  const generated = generator.generateMultiPage(irs);

  log(opts.verbose, 'Done (multi-page).');
  return { pages: pageResults, generated };
}
