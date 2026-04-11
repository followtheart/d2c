/**
 * End-to-end Design-to-Code pipeline.
 *
 *   Parse → IR → Layout Inference → Semantic Enhancement → Codegen
 */
import type { IRDocument } from '../ir/types';
import { parseDesign, DesignFormat } from '../parser';
import { inferLayout } from '../layout/inference';
import { enhance, LLMProvider } from '../ai/semanticEnhancer';
import { createGenerator, Platform } from '../codegen/factory';
import type { GenerateResult } from '../codegen/base';

export interface PipelineOptions {
  format?: DesignFormat;
  platform: Platform;
  llm?: LLMProvider;
  verbose?: boolean;
}

export interface PipelineResult {
  ir: IRDocument;
  generated: GenerateResult;
}

function log(verbose: boolean | undefined, msg: string): void {
  if (verbose) console.error(msg);
}

export async function runPipeline(
  rawInput: unknown,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  log(opts.verbose, '[1/5] Parsing design file...');
  const parsed = parseDesign(rawInput, opts.format ?? 'auto');

  log(opts.verbose, '[2/5] Inferring layouts...');
  const layoutTree = inferLayout(parsed.root);

  log(opts.verbose, '[3/5] Semantic enhancement...');
  const enhancedTree = await enhance(layoutTree, { llm: opts.llm });

  const ir: IRDocument = { ...parsed, root: enhancedTree };

  log(opts.verbose, `[4/5] Generating ${opts.platform} code...`);
  const generator = createGenerator(opts.platform);
  const generated = generator.generate(ir);

  log(opts.verbose, '[5/5] Done.');
  return { ir, generated };
}
