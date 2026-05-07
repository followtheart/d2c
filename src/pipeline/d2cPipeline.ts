/**
 * End-to-end Design-to-Code pipeline.
 *
 *   Parse → IR → Layout Inference → Semantic Enhancement →
 *     [Component matching] → [Responsive merge] → [Protected merge] → Codegen
 *     ↓
 *   [Design tokens + optional Tailwind preset]
 */
import type { IRDocument, IRMultiPageDocument } from '../ir/types';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { parseDesign, parseDesignMultiPage, DesignFormat } from '../parser';
import { inferLayout } from '../layout/inference';
import {
  refineLayoutWithLLM,
  LayoutLLMProvider,
  RefineOptions,
} from '../layout/llmRefiner';
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
  /** Max concurrent workers used by multi-page pipeline. Defaults to CPU count. */
  multiPageConcurrency?: number;
  /** Match against a known component library (antd / mui). */
  componentLibrary?: LibraryTarget;
  /** Responsive variants (different viewports of the same design). */
  responsiveVariants?: ResponsiveVariantInput[];
  /** Previous IR to merge protected (`ai:ignore`) regions from. */
  previousIR?: IRDocument;
  /** Compute and return a structural diff against `previousIR`. */
  computeDiff?: boolean;
  /**
   * Optional vision/LLM provider that re-runs layout inference for
   * containers the rule engine flagged as low-confidence. When omitted,
   * the rule engine's output is used as-is and the pipeline stays offline.
   */
  layoutRefiner?: LayoutLLMProvider;
  /** Threshold + min-children settings for the layout refiner. */
  layoutRefineOptions?: RefineOptions;
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

type WorkerPipelineOptions = Omit<PipelineOptions, 'llm' | 'layoutRefiner'> & {
  llm?: undefined;
  layoutRefiner?: undefined;
};

type MultiPageWorkerResult = PipelineResult | VerifiedPipelineResult;

interface MultiPageWorkerSuccess {
  ok: true;
  result: MultiPageWorkerResult;
}

interface SerializedWorkerError {
  name?: string;
  message: string;
  stack?: string;
}

interface MultiPageWorkerFailure {
  ok: false;
  error: SerializedWorkerError;
}

type MultiPageWorkerMessage = MultiPageWorkerSuccess | MultiPageWorkerFailure;

function createPageRaw(page: IRDocument): IRDocument {
  return {
    name: page.name,
    width: page.width,
    height: page.height,
    root: page.root,
  };
}

function resolveMultiPageConcurrency(
  opts: PipelineOptions,
  pageCount: number,
): number {
  if (pageCount <= 1) return 1;
  if (
    typeof opts.multiPageConcurrency === 'number' &&
    Number.isFinite(opts.multiPageConcurrency)
  ) {
    return Math.max(1, Math.min(pageCount, Math.floor(opts.multiPageConcurrency)));
  }
  const parallelism = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Math.min(pageCount, Math.max(1, parallelism - 1)));
}

function canUseMultiPageWorkers(opts: PipelineOptions): opts is WorkerPipelineOptions {
  return opts.llm === undefined && opts.layoutRefiner === undefined;
}

function toWorkerPipelineOptions(opts: PipelineOptions): WorkerPipelineOptions {
  const { llm: _llm, layoutRefiner: _layoutRefiner, ...rest } = opts;
  return {
    ...rest,
    format: 'native',
  };
}

function toWorkerError(error: SerializedWorkerError): Error {
  const restored = new Error(error.message);
  restored.name = error.name ?? 'Error';
  if (error.stack) restored.stack = error.stack;
  return restored;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runLoop(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const loops = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => runLoop(),
  );
  await Promise.all(loops);
  return results;
}

async function runPagePipelineInWorker(
  pageRaw: IRDocument,
  opts: WorkerPipelineOptions,
  verify: boolean,
): Promise<MultiPageWorkerResult> {
  const workerPath = path.resolve(__dirname, 'multiPageWorker.js');
  return new Promise<MultiPageWorkerResult>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: { pageRaw, opts, verify },
    });

    worker.once('message', (message: MultiPageWorkerMessage) => {
      settled = true;
      if (message.ok) {
        resolve(message.result);
        return;
      }
      reject(toWorkerError(message.error));
    });

    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });

    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`Multi-page worker exited with code ${code}`));
      }
    });
  });
}

async function runMultiPageTasks<Result extends MultiPageWorkerResult>(
  pages: IRDocument[],
  opts: PipelineOptions,
  verify: boolean,
): Promise<Result[]> {
  const concurrency = resolveMultiPageConcurrency(opts, pages.length);
  const useWorkers = canUseMultiPageWorkers(opts);

  if (useWorkers) {
    log(
      opts.verbose,
      `[multi] Running ${pages.length} page(s) with ${concurrency} worker thread(s)...`,
    );
    const workerOpts = toWorkerPipelineOptions(opts);
    return mapWithConcurrency(pages, concurrency, async (page, index) => {
      console.error(`d2c: [${index + 1}/${pages.length}] ${page.name}`);
      const result = await runPagePipelineInWorker(createPageRaw(page), workerOpts, verify);
      return result as Result;
    });
  }

  log(
    opts.verbose,
    `[multi] LLM provider is not worker-serializable; running ${pages.length} page(s) with main-thread concurrency ${concurrency}...`,
  );
  return mapWithConcurrency(pages, concurrency, async (page, index) => {
    console.error(`d2c: [${index + 1}/${pages.length}] ${page.name}`);
    const pageRaw = createPageRaw(page);
    const pageOpts = { ...opts, format: 'native' as DesignFormat };
    const result = verify
      ? await runPipelineWithVerification(pageRaw, pageOpts)
      : await runPipeline(pageRaw, pageOpts);
    return result as Result;
  });
}

export async function runPipeline(
  rawInput: unknown,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  log(opts.verbose, '[1/7] Parsing design file...');
  const parsed = parseDesign(rawInput, opts.format ?? 'auto');

  log(opts.verbose, '[2/7] Inferring layouts...');
  let layoutTree = inferLayout(parsed.root);

  if (opts.layoutRefiner) {
    log(opts.verbose, '[2.5/7] Refining low-confidence layouts via LLM...');
    layoutTree = await refineLayoutWithLLM(
      layoutTree,
      opts.layoutRefiner,
      opts.layoutRefineOptions,
    );
  }

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
  // Make the tokens available on the IR document so the code generator
  // can substitute hardcoded literals with token references.
  ir = {
    ...ir,
    tokens: irTokensFromExtracted(tokens),
    tokenSet: tokens,
  };

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

function irTokensFromExtracted(tokens: TokenSet): IRDocument['tokens'] {
  // The IR's `DesignTokens` shape is a small subset of the rich `TokenSet`
  // — translate the fields it knows about so downstream generators can
  // also access tokens via the IR (rather than re-running extraction).
  const typography: NonNullable<IRDocument['tokens']>['typography'] = {};
  for (const [name, size] of Object.entries(tokens.fontSizes)) {
    typography[name] = { fontSize: size, fontWeight: 400 };
  }
  return {
    colors: { ...tokens.colors },
    spacing: { ...tokens.spacings },
    typography,
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
  let layoutTree = inferLayout(parsed.root);
  if (opts.layoutRefiner) {
    log(opts.verbose, '[2.5/7] Refining low-confidence layouts via LLM...');
    layoutTree = await refineLayoutWithLLM(
      layoutTree,
      opts.layoutRefiner,
      opts.layoutRefineOptions,
    );
  }
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
  // Attach tokens to the IR so the codegen layer can substitute them.
  ir = {
    ...ir,
    tokens: irTokensFromExtracted(tokens),
    tokenSet: tokens,
  };
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

// 多页面 pipeline 带验证的结果
export interface MultiPageVerifiedPipelineResult {
  pages: VerifiedPipelineResult[];
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

  const pageResults = await runMultiPageTasks<PipelineResult>(
    multiDoc.pages,
    opts,
    false,
  );

  log(opts.verbose, '[multi] Merging multi-page output...');
  const generator = createGenerator(opts.platform);
  const irs = pageResults.map((r) => r.ir);
  const generated = generator.generateMultiPage(irs);

  log(opts.verbose, 'Done (multi-page).');
  return { pages: pageResults, generated };
}

// 多页面 pipeline（带验证）：对每个页面分别运行带验证的 pipeline，最后合并生成代码
export async function runMultiPagePipelineWithVerification(
  rawInput: unknown,
  opts: PipelineOptions,
): Promise<MultiPageVerifiedPipelineResult> {
  log(opts.verbose, '[multi-verify] Parsing all pages...');
  const multiDoc = parseDesignMultiPage(rawInput, opts.format ?? 'auto');

  // 单页面退化为原流程
  if (multiDoc.pages.length <= 1) {
    const single = await runPipelineWithVerification(rawInput, opts);
    return { pages: [single], generated: single.generated };
  }

  const pageResults = await runMultiPageTasks<VerifiedPipelineResult>(
    multiDoc.pages,
    opts,
    true,
  );

  log(opts.verbose, '[multi-verify] Merging multi-page output...');
  const generator = createGenerator(opts.platform);
  const irs = pageResults.map((r) => r.ir);
  const generated = generator.generateMultiPage(irs);

  log(opts.verbose, 'Done (multi-page with verification).');
  return { pages: pageResults, generated };
}
