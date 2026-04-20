#!/usr/bin/env node
/**
 * d2c CLI
 *
 * Usage:
 *   d2c --input design.json --platform react --out out/react
 *   d2c --input figma.json --format figma --platform vue --out out/vue
 *   d2c --input design.json --platform html --out - (stdout)
 *   d2c --input design.json --platform react --use-claude  (requires ANTHROPIC_API_KEY)
 */
import * as fs from 'fs';
import * as path from 'path';
import { runPipeline, runMultiPagePipeline, runPipelineWithVerification, runMultiPagePipelineWithVerification } from './pipeline/d2cPipeline';
import { formatVerificationReport, snapshotToJSON } from './pipeline/verify';
import type { Platform } from './codegen/factory';
import type { DesignFormat } from './parser';
import { ClaudeProvider } from './ai/claudeProvider';
import {
  NodeLlmProvider,
  type NodeLlmProviderName,
} from './ai/nodeLlmProvider';
import type { LLMProvider } from './ai/semanticEnhancer';
import { loadConfig, resolveApiKey, type D2CConfig } from './config';

interface Args {
  input?: string;
  out?: string;
  platform: Platform;
  format: DesignFormat;
  emitIR?: string;
  emitTokens?: string;
  emitTailwind?: string;
  emitDiff?: string;
  componentLibrary?: 'antd' | 'mui';
  responsive: { breakpoint: string; file: string }[];
  prevIR?: string;
  useClaude?: boolean;
  noLlm?: boolean;
  llmProvider?: NodeLlmProviderName;
  llmModel?: string;
  llmBaseUrl?: string;
  verbose?: boolean;
  help?: boolean;
  /** Render mode: render Sketch/Make design to SVG / HTML preview */
  render?: boolean;
  renderFormat?: 'svg' | 'html';
  renderScale?: number;
  // 多页面模式
  allPages?: boolean;
  /** Split by top-level frames: each FRAME on a Figma page becomes a separate output file. */
  splitFrames?: boolean;
  /** Run pipeline with stage-by-stage verification. */
  verify?: boolean;
  /** Directory to write per-stage snapshot JSON files. */
  verifyDir?: string;
  /** Directory containing per-stage snapshot JSON files to render. */
  renderSnapshots?: string;
  /** Output directory for rendered snapshot images / HTML files. */
  renderOutput?: string;
  /** Format for snapshot rendering: png | html (default: png). */
  snapshotFormat?: 'png' | 'html';
  /** Run multimodal stage comparison after rendering. */
  compareStages?: boolean;
  /** Output path for comparison report (default: <render-output>/report.md). */
  compareReport?: string;
  /** Vision provider backend: openrouter | anthropic (default: openrouter). */
  visionProvider?: 'openrouter' | 'anthropic' | 'zhipuai' | 'dashscope';
  /** Vision model id override. */
  visionModel?: string;
  /** Run the ground-truth-anchored fidelity comparison (Figma ↔ codegen). */
  compareFidelity?: boolean;
  /** Path to the reference rendering PNG (Figma export / Sketch preview). */
  referenceImage?: string;
  /** Path to the candidate rendering PNG (codegen HTML screenshot). */
  candidateImage?: string;
  /** Path to an IR JSON snapshot (enables region + text layers). */
  fidelityIR?: string;
  /** Path to a codegen JSON snapshot (enables text layer). */
  fidelityCodegen?: string;
  /** Output path for the fidelity report (md / html / json). */
  fidelityReport?: string;
  /** Directory for diagnostic images (heatmap, aligned PNGs). */
  fidelityDiagnosticsDir?: string;
  /** Also invoke the vision LLM for the perceptual-LLM dimension. */
  fidelityUseLlm?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { platform: 'react', format: 'auto', responsive: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--input':
      case '-i':
        args.input = next();
        break;
      case '--out':
      case '-o':
        args.out = next();
        break;
      case '--platform':
      case '-p':
        args.platform = next() as Platform;
        break;
      case '--format':
      case '-f':
        args.format = next() as DesignFormat;
        break;
      case '--emit-ir':
        args.emitIR = next();
        break;
      case '--emit-tokens':
        args.emitTokens = next();
        break;
      case '--emit-tailwind':
        args.emitTailwind = next();
        break;
      case '--emit-diff':
        args.emitDiff = next();
        break;
      case '--component-library':
        args.componentLibrary = next() as 'antd' | 'mui';
        break;
      case '--responsive': {
        // form: <breakpoint>=<file>
        const arg = next();
        const eq = arg.indexOf('=');
        if (eq < 0) throw new Error(`--responsive expects <bp>=<file>, got ${arg}`);
        args.responsive.push({ breakpoint: arg.slice(0, eq), file: arg.slice(eq + 1) });
        break;
      }
      case '--prev-ir':
        args.prevIR = next();
        break;
      case '--use-claude':
        args.useClaude = true;
        break;
      case '--no-llm':
        args.noLlm = true;
        break;
      case '--llm-provider':
        args.llmProvider = next() as NodeLlmProviderName;
        break;
      case '--llm-model':
        args.llmModel = next();
        break;
      case '--llm-base-url':
        args.llmBaseUrl = next();
        break;
      case '--all-pages':
        args.allPages = true;
        break;
      case '--split-frames':
        args.splitFrames = true;
        args.allPages = true; // implies --all-pages
        break;
      case '--render':
        args.render = true;
        break;
      case '--render-format':
        args.renderFormat = next() as 'svg' | 'html';
        break;
      case '--render-scale': {
        const s = next();
        args.renderScale = parseFloat(s);
        break;
      }
      case '--verify':
        args.verify = true;
        break;
      case '--verify-dir':
        args.verifyDir = next();
        args.verify = true; // implies --verify
        break;
      case '--render-snapshots':
        args.renderSnapshots = next();
        break;
      case '--render-output':
        args.renderOutput = next();
        break;
      case '--snapshot-format':
        args.snapshotFormat = next() as 'png' | 'html';
        break;
      case '--compare-stages':
        args.compareStages = true;
        break;
      case '--compare-report':
        args.compareReport = next();
        break;
      case '--vision-provider':
        args.visionProvider = next() as 'openrouter' | 'anthropic' | 'zhipuai' | 'dashscope';
        break;
      case '--vision-model':
        args.visionModel = next();
        break;
      case '--compare-fidelity':
        args.compareFidelity = true;
        break;
      case '--reference-image':
        args.referenceImage = next();
        break;
      case '--candidate-image':
        args.candidateImage = next();
        break;
      case '--fidelity-ir':
        args.fidelityIR = next();
        break;
      case '--fidelity-codegen':
        args.fidelityCodegen = next();
        break;
      case '--fidelity-report':
        args.fidelityReport = next();
        break;
      case '--fidelity-diagnostics-dir':
        args.fidelityDiagnosticsDir = next();
        break;
      case '--fidelity-use-llm':
        args.fidelityUseLlm = true;
        break;
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

const USAGE = `d2c — Design-to-Code converter

Usage:
  d2c --input <file> [options]

Options:
  -i, --input <file>             Input design file (JSON)
  -o, --out <dir|->              Output directory, or '-' for stdout
  -p, --platform <name>          Target platform: react | vue | html |
                                 react-native | flutter (default: react)
  -f, --format <name>            Input format: figma | sketch | native | make | fig | auto
      --emit-ir <path>           Also write the intermediate IR JSON.
                                 With --all-pages, <path> is treated as a
                                 directory and each page is written as
                                 <path>/<pageName>.json.
      --emit-tokens <path>       Write design tokens (style-dictionary JSON).
                                 With --all-pages, per-page files in <path>/.
      --emit-tailwind <path>     Write a Tailwind preset (theme.extend) module.
                                 With --all-pages, per-page files in <path>/.
      --emit-diff <path>         Write structural IR diff against --prev-ir.
                                 With --all-pages, per-page files in <path>/.
      --component-library <lib>  Match nodes to a component library: antd | mui
      --responsive <bp>=<file>   Add a responsive variant for breakpoint <bp>
                                 (repeatable, e.g. --responsive sm=mobile.json)
      --prev-ir <file>           Previous IR JSON for ai:ignore region merge
      --no-llm                   Skip LLM semantic enhancement entirely
      --use-claude               Use Claude as the semantic LLM provider
                                 (requires ANTHROPIC_API_KEY env var)
      --llm-provider <name>      Use @node-llm/core as the semantic LLM
                                 provider. Supports: openai | anthropic |
                                 gemini | deepseek | openrouter | ollama |
                                 mistral | xai | bedrock | zhipuai |
                                 siliconflow. The
                                 matching API key env var (e.g.
                                 OPENROUTER_API_KEY, ZHIPUAI_API_KEY,
                                 SILICONFLOW_API_KEY) is
                                 read automatically.
                                 Requires "npm install @node-llm/core".
      --llm-model <id>           Model id passed to --llm-provider
                                 (e.g. deepseek-chat, openai/gpt-4o-mini)
      --llm-base-url <url>       Override the provider base URL (e.g. for
                                 self-hosted gateways or Ollama)
      --all-pages                  Process all pages in the design (instead
                                 of only the first page). Generates one
                                 output per page plus a unified entry file.
      --split-frames               Split by top-level frames: each FRAME on
                                 a Figma page becomes a separate web page.
                                 Use for .fig files where one CANVAS
                                 contains multiple screens (e.g. CRM).
                                 Implies --all-pages.
      --verify                     Run pipeline with stage-by-stage verification.
                                 Prints a verification report to stderr.
      --verify-dir <dir>           Write per-stage snapshot JSON files to <dir>.
                                 Implies --verify.
      --render-snapshots <dir>     Render per-stage snapshot JSON files from
                                 <dir> into visual output (PNG or HTML).
      --render-output <dir>        Output directory for rendered snapshots
                                 (default: <render-snapshots>/rendered).
      --snapshot-format <fmt>      Snapshot render format: png | html
                                 (default: png). html does not require
                                 Playwright.
      --compare-stages             Run multimodal LLM comparison on
                                 rendered stage screenshots (PNG).
                                 Requires --render-output with PNGs and
                                 an API key (OPENROUTER_API_KEY etc.).
      --compare-report <file>      Output path for comparison report
                                 (default: <render-output>/report.md).
      --vision-provider <name>     Vision backend: openrouter | anthropic
                                 | zhipuai | dashscope (default: openrouter).
      --vision-model <id>          Override the vision model id.
      --compare-fidelity           Run ground-truth-anchored fidelity
                                 comparison between a reference PNG
                                 (Figma export) and the codegen PNG
                                 — replaces the old "overall" score.
                                 Outputs 6-dim breakdown + heatmap.
                                 Requires pngjs: npm install pngjs.
      --reference-image <file>     Reference rendering (Figma PNG export).
      --candidate-image <file>     Candidate rendering (codegen.png).
                                 If omitted, falls back to
                                 <render-output>/codegen.png.
      --fidelity-ir <file>         IR JSON snapshot (enables region +
                                 text layers).
      --fidelity-codegen <file>    Codegen JSON snapshot (enables text
                                 layer).
      --fidelity-report <file>     Report output (.md / .html / .json).
      --fidelity-diagnostics-dir <dir>  Directory for diagnostic images
                                 (heatmap, aligned PNGs).
      --fidelity-use-llm           Also run the 6-dim LLM perceptual
                                 judgment (needs --vision-provider).
      --render                     Render the design visually (SVG / HTML)
                                 instead of generating code. Implies
                                 --format sketch (or auto-detected).
      --render-format <fmt>       Render output format: svg | html
                                 (default: html)
      --render-scale <n>          Scale factor for rendered output
                                 (default: 1)
  -v, --verbose                  Verbose logging
  -h, --help                     Show this help

Examples:
  d2c -i design.json -p react -o out/react
  d2c -i figma-export.json -f figma -p vue -o out/vue
  d2c -i design.json -p flutter -o out/flutter
  d2c -i design.json -p react-native -o out/rn
  d2c -i design.json --component-library antd -p react -o out/antd
  d2c -i design.json --emit-tokens out/tokens.json --emit-tailwind out/preset.js
  d2c -i design.json --responsive sm=mobile.json --responsive lg=desktop.json -o out
  OPENROUTER_API_KEY=... d2c -i design.json --llm-provider openrouter \\
    --llm-model anthropic/claude-3.5-sonnet -o out/react
  DEEPSEEK_API_KEY=... d2c -i design.json --llm-provider deepseek \\
    --llm-model deepseek-chat -o out/react
  d2c -i ./extracted-sketch-dir/ -f sketch -p html -o out/html
  d2c -i design.json -p html --no-llm -o out/html
  d2c -i sketch.json --render -o out/preview
  d2c -i sketch.json --render --render-format svg -o out/svg
  d2c -i sketch.json --render --render-scale 2 -o out/preview
  d2c -i design.make --render -o out/make-preview
  d2c -i design.fig -p react -o out/react
  d2c -i design.fig --all-pages -p react -o out/react
  d2c -i design.fig --all-pages --emit-ir out/ir/ --emit-tokens out/tokens/
  d2c -i crm.fig --split-frames -p html -o out/crm  # each top-level frame → separate page
  d2c -i crm.fig --split-frames --verify-dir out/crm/snapshots -p html -o out/crm  # debug per-frame stages
  d2c -i design.fig --render -o out/fig-preview
  d2c -i make-decoded.json -f make -p react -o out/react
  d2c --render-snapshots snapshots/ --render-output images/
  d2c --render-snapshots snapshots/ --snapshot-format html --render-output out/html
  d2c --compare-stages --render-output images/ --compare-report report.md
  OPENROUTER_API_KEY=... d2c --compare-stages --render-output images/ --vision-model openai/gpt-4o
  d2c --compare-fidelity --reference-image figma.png --candidate-image codegen.png \\
      --fidelity-ir ir.json --fidelity-report report.md \\
      --fidelity-diagnostics-dir out/fidelity
`;

/**
 * Resolve the --input path into a parsed JSON object or binary Buffer.
 * Supports:
 *  - A regular JSON file (any format)
 *  - A .make binary file (returns Buffer — caller must handle async parsing)
 *  - An extracted .sketch directory (contains pages/*.json)
 *  - A document.json with MSJSONFileReference page pointers
 */
function resolveInput(inputPath: string, format: DesignFormat): unknown {
  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) {
    return resolveSketchDir(inputPath);
  }
  // .make binary files are read as Buffer for binary parsing
  if (format === 'make' || (format === 'auto' && inputPath.endsWith('.make'))) {
    return fs.readFileSync(inputPath); // returns Buffer
  }
  // .fig binary files are read as Buffer for binary parsing
  if (format === 'fig' || (format === 'auto' && inputPath.endsWith('.fig'))) {
    return fs.readFileSync(inputPath); // returns Buffer
  }
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (format === 'sketch' || format === 'auto') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.pages) && obj.pages.length > 0) {
      const first = obj.pages[0] as Record<string, unknown>;
      if (first._class === 'MSJSONFileReference' && typeof first._ref === 'string') {
        const baseDir = path.dirname(inputPath);
        return resolveSketchDocumentRefs(obj, baseDir);
      }
    }
  }
  return raw;
}

function resolveSketchDir(dirPath: string): unknown {
  const pagesDir = path.join(dirPath, 'pages');
  if (!fs.existsSync(pagesDir)) {
    throw new Error(`Sketch directory "${dirPath}" has no pages/ subdirectory`);
  }
  const pageFiles = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.json'));
  if (pageFiles.length === 0) {
    throw new Error(`No page JSON files found in "${pagesDir}"`);
  }
  const pages = pageFiles.map((f) =>
    JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf8')),
  );
  return pages.length === 1 ? pages[0] : { pages };
}

function resolveSketchDocumentRefs(
  doc: Record<string, unknown>,
  baseDir: string,
): unknown {
  const refs = doc.pages as { _class: string; _ref: string }[];
  const pages = refs.map((ref) => {
    const filePath = path.join(baseDir, ref._ref + '.json');
    if (!fs.existsSync(filePath)) {
      throw new Error(`Referenced page file not found: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  });
  return pages.length === 1 ? pages[0] : { pages };
}

/**
 * Run multimodal stage comparison on rendered PNG screenshots.
 */
async function compareStagesCommand(args: Args): Promise<void> {
  const imageDir = args.renderOutput;
  if (!imageDir || !fs.existsSync(imageDir)) {
    console.error('ERROR: --compare-stages requires --render-output <dir> with PNG screenshots.');
    process.exit(2);
  }

  const config = loadConfig();
  const visionBackend = args.visionProvider ?? 'openrouter';
  const envVar = apiKeyEnvVarFor(visionBackend);
  const apiKey = resolveApiKey(visionBackend, envVar, config);

  if (!apiKey) {
    console.error(
      `ERROR: --compare-stages with --vision-provider ${visionBackend} requires ${envVar} env var or apiKeys.${visionBackend} in .d2crc.json.`,
    );
    process.exit(2);
  }

  const { VisionProvider } = await import('./ai/visionProvider');
  const { compareStages } = await import('./pipeline/stageCompare');
  const { reportToMarkdown, reportToHtml, reportToJson } = await import('./pipeline/compareReport');

  const vision = new VisionProvider({
    provider: visionBackend,
    apiKey,
    model: args.visionModel,
  });

  console.error(`d2c compare-stages: analyzing screenshots in "${imageDir}"…`);
  const report = await compareStages(vision, imageDir, {
    onProgress: (msg) => console.error(msg),
  });

  const reportPath = args.compareReport ?? path.join(imageDir, 'report.md');
  const ext = path.extname(reportPath).toLowerCase();

  let content: string;
  if (ext === '.json') {
    content = reportToJson(report);
  } else if (ext === '.html') {
    content = reportToHtml(report, imageDir);
  } else {
    content = reportToMarkdown(report, imageDir);
  }

  fs.mkdirSync(path.dirname(reportPath) || '.', { recursive: true });
  fs.writeFileSync(reportPath, content);
  console.error(`d2c compare-stages: wrote report → ${reportPath}`);

  // Print quality summary
  console.error('\n  Quality Summary:');
  for (const p of report.pairs) {
    console.error(`    ${p.from} → ${p.to}: ${p.qualityScore}/10`);
  }
  console.error(`    Overall (${report.overall.from} → ${report.overall.to}): ${report.overall.qualityScore}/10\n`);
}

/**
 * Run ground-truth-anchored fidelity comparison (Figma rendering ↔
 * codegen rendering).  Replaces the deprecated overall-score path.
 */
async function compareFidelityCommand(args: Args): Promise<void> {
  const referencePath = args.referenceImage;
  const candidatePath =
    args.candidateImage ??
    (args.renderOutput ? path.join(args.renderOutput, 'codegen.png') : undefined);

  if (!referencePath) {
    console.error('ERROR: --compare-fidelity requires --reference-image <file>.');
    process.exit(2);
  }
  if (!candidatePath) {
    console.error(
      'ERROR: --compare-fidelity requires --candidate-image <file> or --render-output <dir>.',
    );
    process.exit(2);
  }

  // Optional IR + codegen snapshots
  let ir: import('./ir/types').IRDocument | undefined;
  let generated: import('./codegen/base').GenerateResult | undefined;
  if (args.fidelityIR) {
    const obj = JSON.parse(fs.readFileSync(args.fidelityIR, 'utf8'));
    // Accept either a raw IR or a stage snapshot with `ir` field
    ir = obj.ir ?? obj;
  }
  if (args.fidelityCodegen) {
    const obj = JSON.parse(fs.readFileSync(args.fidelityCodegen, 'utf8'));
    // Accept either a raw GenerateResult or a snapshot with `generated` field
    const gen = obj.generated ?? obj;
    if (gen && Array.isArray(gen.files)) {
      generated = {
        entryFile: gen.entryFile ?? gen.files[0]?.path ?? '',
        files: gen.files.map((f: { path: string; content?: string }) => ({
          path: f.path,
          content: f.content ?? '',
        })),
      };
    }
  }

  let vision;
  if (args.fidelityUseLlm) {
    const config = loadConfig();
    const backend = args.visionProvider ?? 'openrouter';
    const envVar = apiKeyEnvVarFor(backend);
    const apiKey = resolveApiKey(backend, envVar, config);
    if (!apiKey) {
      console.error(
        `ERROR: --fidelity-use-llm with --vision-provider ${backend} requires ${envVar} or apiKeys.${backend}.`,
      );
      process.exit(2);
    }
    const { VisionProvider } = await import('./ai/visionProvider');
    vision = new VisionProvider({
      provider: backend,
      apiKey,
      model: args.visionModel,
    });
  }

  const { runFigmaFidelity } = await import('./compare');
  const { writeReport } = await import('./compare');

  console.error(`d2c compare-fidelity: ${referencePath} ↔ ${candidatePath}`);
  const report = await runFigmaFidelity({
    referencePath,
    candidatePath,
    ir,
    generated,
    vision,
    outputDir: args.fidelityDiagnosticsDir,
    writeDiagnostics: !!args.fidelityDiagnosticsDir,
    onProgress: (msg) => console.error(msg),
  });

  const reportPath =
    args.fidelityReport ??
    (args.fidelityDiagnosticsDir
      ? path.join(args.fidelityDiagnosticsDir, 'fidelity_report.md')
      : 'fidelity_report.md');
  writeReport(report, reportPath, args.fidelityDiagnosticsDir);
  console.error(`d2c compare-fidelity: wrote report → ${reportPath}`);

  // Human-readable summary
  console.error('\n  Fidelity Summary:');
  for (const [name, dim] of Object.entries(report.dimensions)) {
    const val =
      dim.value === undefined ? '  N/A ' : `${(dim.value * 10).toFixed(1)}/10`;
    console.error(`    ${name.padEnd(12)} ${val}   ${dim.summary}`);
  }
  console.error(`    Overall      ${report.overall.toFixed(1)}/10`);
  if (report.weakestDimension) {
    console.error(`    weakest      ${report.weakestDimension}`);
  }
  if (report.warnings.length) {
    console.error('\n  Warnings:');
    for (const w of report.warnings) console.error(`    [${w.code}] ${w.message}`);
  }
  console.error('');
}

/**
 * Render per-stage snapshot JSON files to HTML or PNG.
 *
 * Reads every `<stage>.json` in `--render-snapshots <dir>`, passes
 * each through the matching SnapshotRenderer, then either writes
 * standalone HTML files or uses Playwright to capture PNG screenshots.
 */
async function renderSnapshotsCommand(args: Args): Promise<void> {
  const snapshotDir = args.renderSnapshots!;
  if (!fs.existsSync(snapshotDir)) {
    console.error(`ERROR: snapshot directory not found: ${snapshotDir}`);
    process.exit(2);
  }

  const outDir = args.renderOutput ?? path.join(snapshotDir, 'rendered');
  const format = args.snapshotFormat ?? 'png';

  const { getSnapshotRenderer } = await import('./renderer/snapshotRendererMap');
  const snapshotFiles = fs.readdirSync(snapshotDir).filter((f) => f.endsWith('.json'));

  if (snapshotFiles.length === 0) {
    console.error(`No snapshot JSON files found in "${snapshotDir}"`);
    process.exit(2);
  }

  type StageSnapshot = import('./pipeline/verify').StageSnapshot;

  const rendered: { stage: string; html: string; outPath: string }[] = [];

  for (const file of snapshotFiles) {
    const stage = path.basename(file, '.json');
    const renderer = getSnapshotRenderer(stage as import('./pipeline/verify').StageName);
    if (!renderer) {
      if (args.verbose) console.error(`  skip ${file} (no renderer for stage "${stage}")`);
      continue;
    }
    const snap: StageSnapshot = JSON.parse(
      fs.readFileSync(path.join(snapshotDir, file), 'utf8'),
    );
    const html = renderer.render(snap);
    const ext = format === 'html' ? 'html' : 'png';
    const outPath = path.join(outDir, `${stage}.${ext}`);
    rendered.push({ stage, html, outPath });
  }

  if (rendered.length === 0) {
    console.error('No renderable snapshots found.');
    process.exit(2);
  }

  fs.mkdirSync(outDir, { recursive: true });

  if (format === 'html') {
    for (const r of rendered) {
      fs.writeFileSync(r.outPath, r.html);
      if (args.verbose) console.error(`  wrote ${r.outPath}`);
    }
    console.error(`d2c render-snapshots: wrote ${rendered.length} HTML file(s) → ${outDir}`);
  } else {
    const { captureScreenshots } = await import('./renderer/screenshotService');
    const jobs = rendered.map((r) => ({ html: r.html, outputPath: r.outPath }));
    console.error(`d2c render-snapshots: capturing ${jobs.length} screenshot(s)…`);
    await captureScreenshots(jobs);
    console.error(`d2c render-snapshots: wrote ${jobs.length} PNG file(s) → ${outDir}`);
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    process.exit(2);
  }

  if (
    args.help ||
    (!args.input &&
      !args.renderSnapshots &&
      !args.compareStages &&
      !args.compareFidelity)
  ) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  // ─── Standalone modes (no --input required) ─────────────────────
  if (!args.input) {
    if (args.renderSnapshots) {
      await renderSnapshotsCommand(args);
    }
    if (args.compareStages) {
      await compareStagesCommand(args);
    }
    if (args.compareFidelity) {
      await compareFidelityCommand(args);
    }
    return;
  }

  const raw = resolveInput(args.input!, args.format);

  // ─── Render mode: Sketch / Make → SVG / HTML preview ────────────
  if (args.render) {
    const renderer = await import('./renderer');
    const scale = args.renderScale ?? 1;
    const format = args.renderFormat ?? 'html';
    const out = args.out ?? '-';

    // ── Figma .fig binary render ──────────────────────────────────────
    const isBinaryBuf = Buffer.isBuffer(raw) || (raw instanceof Uint8Array);
    const isFigFile = isBinaryBuf && (args.format === 'fig' || (args.format === 'auto' && args.input!.endsWith('.fig')));
    if (isFigFile) {
      const { parseFigBinary } = await import('./parser/figBinaryParser');
      const figDoc = await parseFigBinary(raw as Buffer);
      // Direct .fig → RenderDocument path (preserves gradients, rotation,
      // image assets, rich effects, per-corner radii).
      const result = renderer.renderFig(figDoc, { scale });

      if (format === 'html') {
        if (out === '-') {
          console.log(result.html);
        } else {
          fs.mkdirSync(out, { recursive: true });
          const htmlPath = path.join(out, 'preview.html');
          fs.writeFileSync(htmlPath, result.html);
          console.error(`d2c render (fig): wrote ${htmlPath}`);
        }
      } else {
        if (out === '-') {
          for (const [name, svg] of result.svgs) {
            console.log(`<!-- ===== ${name} ===== -->`);
            console.log(svg);
          }
        } else {
          fs.mkdirSync(out, { recursive: true });
          for (const [name, svg] of result.svgs) {
            const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
            const svgPath = path.join(out, `${safeName}.svg`);
            fs.writeFileSync(svgPath, svg);
            if (args.verbose) console.error(`wrote ${svgPath}`);
          }
          console.error(`d2c render (fig): wrote ${result.svgs.size} SVG file(s) → ${out}`);
        }
      }
      return;
    }

    // ── Figma Make binary render ──────────────────────────────────────
    const isMakeBuf = isBinaryBuf && !isFigFile;
    const isMakeJson = !isBinaryBuf && args.format === 'make';
    if (isMakeBuf || isMakeJson) {
      const { parseMakeBinary, parseMakeJsonToMakeDoc } = await import('./parser/makeParser');
      const makeDoc = isMakeBuf
        ? await parseMakeBinary(raw as Buffer)
        : parseMakeJsonToMakeDoc(raw);
      const result = renderer.renderMake(makeDoc, { scale });

      if (format === 'html') {
        if (out === '-') {
          console.log(result.html);
        } else {
          fs.mkdirSync(out, { recursive: true });
          const htmlPath = path.join(out, 'preview.html');
          fs.writeFileSync(htmlPath, result.html);
          if (args.verbose && result.codeFiles.length > 0) {
            for (const f of result.codeFiles) {
              const dest = path.join(out, 'code', f.path);
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, f.content);
              if (args.verbose) console.error(`wrote ${dest}`);
            }
          }
          console.error(`d2c render (make): wrote ${htmlPath}` +
            (result.codeFiles.length > 0 ? ` + ${result.codeFiles.length} code file(s)` : ''));
        }
      } else {
        if (out === '-') {
          for (const [name, svg] of result.svgs) {
            console.log(`<!-- ===== ${name} ===== -->`);
            console.log(svg);
          }
        } else {
          fs.mkdirSync(out, { recursive: true });
          for (const [name, svg] of result.svgs) {
            const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
            const svgPath = path.join(out, `${safeName}.svg`);
            fs.writeFileSync(svgPath, svg);
            if (args.verbose) console.error(`wrote ${svgPath}`);
          }
          console.error(`d2c render (make): wrote ${result.svgs.size} SVG file(s) → ${out}`);
        }
      }
      return;
    }

    // ── Sketch / JSON render ──────────────────────────────────────────
    const { renderSketch, renderSketchArtboards } = renderer;

    // 多页面（实际按 artboard 拆分）：每个 artboard 输出独立文件
    if (args.allPages) {
      const abResults = renderSketchArtboards(raw, { scale });
      if (format === 'html') {
        if (out === '-') {
          for (const { artboardName, result } of abResults) {
            console.log(`<!-- ===== ${artboardName} ===== -->`);
            console.log(result.html);
          }
        } else {
          fs.mkdirSync(out, { recursive: true });
          for (const { artboardName, result } of abResults) {
            const safeName = artboardName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const htmlPath = path.join(out, `${safeName}.html`);
            fs.writeFileSync(htmlPath, result.html);
            if (args.verbose) console.error(`wrote ${htmlPath}`);
          }
          console.error(`d2c render: wrote ${abResults.length} HTML file(s) → ${out}`);
        }
      } else {
        // SVG — one file per artboard
        if (out === '-') {
          for (const { artboardName, result } of abResults) {
            for (const [, svg] of result.svgs) {
              console.log(`<!-- ===== ${artboardName} ===== -->`);
              console.log(svg);
            }
          }
        } else {
          fs.mkdirSync(out, { recursive: true });
          for (const { artboardName, result } of abResults) {
            const safeName = artboardName.replace(/[^a-zA-Z0-9_-]/g, '_');
            for (const [, svg] of result.svgs) {
              const svgPath = path.join(out, `${safeName}.svg`);
              fs.writeFileSync(svgPath, svg);
              if (args.verbose) console.error(`wrote ${svgPath}`);
            }
          }
          console.error(`d2c render: wrote ${abResults.length} SVG file(s) → ${out}`);
        }
      }
      return;
    }

    // 单页面渲染（默认）
    const result = renderSketch(raw, { scale });

    if (format === 'html') {
      if (out === '-') {
        console.log(result.html);
      } else {
        fs.mkdirSync(out, { recursive: true });
        const htmlPath = path.join(out, 'preview.html');
        fs.writeFileSync(htmlPath, result.html);
        console.error(`d2c render: wrote ${htmlPath}`);
      }
    } else {
      // SVG — one file per artboard
      if (out === '-') {
        for (const [name, svg] of result.svgs) {
          console.log(`<!-- ===== ${name} ===== -->`);
          console.log(svg);
        }
      } else {
        fs.mkdirSync(out, { recursive: true });
        for (const [name, svg] of result.svgs) {
          const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
          const svgPath = path.join(out, `${safeName}.svg`);
          fs.writeFileSync(svgPath, svg);
          if (args.verbose) console.error(`wrote ${svgPath}`);
        }
        console.error(`d2c render: wrote ${result.svgs.size} SVG file(s) → ${out}`);
      }
    }
    return;
  }

  // Load config file (.d2crc.json) — values are used as fallbacks.
  const config = loadConfig();

  // CLI args override config-file defaults for provider / model / baseUrl.
  const effectiveProvider = args.llmProvider ?? config.llm?.provider;
  const effectiveModel = args.llmModel ?? config.llm?.model;
  const effectiveBaseUrl = args.llmBaseUrl ?? config.llm?.baseUrl;

  let llm: LLMProvider | undefined;
  if (args.noLlm) {
    // --no-llm: skip LLM regardless of config
  } else if (args.useClaude && effectiveProvider) {
    console.error('ERROR: --use-claude and --llm-provider are mutually exclusive.');
    process.exit(2);
  }
  if (args.useClaude) {
    const apiKey = resolveApiKey('anthropic', 'ANTHROPIC_API_KEY', config);
    if (!apiKey) {
      console.error('ERROR: --use-claude requires ANTHROPIC_API_KEY env var or apiKeys.anthropic in .d2crc.json.');
      process.exit(2);
    }
    llm = new ClaudeProvider({ apiKey });
  } else if (!args.noLlm && effectiveProvider) {
    const apiKey = pickApiKey(effectiveProvider, config);
    if (!apiKey && effectiveProvider !== 'ollama') {
      console.error(
        `ERROR: --llm-provider ${effectiveProvider} requires the matching API key ` +
          `env var (e.g. ${apiKeyEnvVarFor(effectiveProvider)}) or apiKeys.${effectiveProvider} in .d2crc.json.`,
      );
      process.exit(2);
    }
    llm = new NodeLlmProvider({
      provider: effectiveProvider,
      model: effectiveModel,
      apiKey,
      baseUrl: effectiveBaseUrl,
    });
  }

  // Pre-parse .fig binary → native IR so the pipeline can process it.
  let pipelineInput: unknown = raw;
  let pipelineFormat: DesignFormat = args.format;
  const isFigBuf = (Buffer.isBuffer(raw) || raw instanceof Uint8Array) &&
    (args.format === 'fig' || (args.format === 'auto' && args.input!.endsWith('.fig')));
  if (isFigBuf) {
    const { parseFig, parseFigMultiPage, parseFigByFrames } = await import('./parser/figBinaryParser');
    console.error(`d2c: parsing .fig binary (${(raw as Buffer).length} bytes)…`);
    if (args.splitFrames) {
      const pages = await parseFigByFrames(raw as Buffer);
      console.error(`d2c: extracted ${pages.length} frame(s) from .fig file`);
      pipelineInput = { name: pages[0]?.name ?? 'Figma Design', pages };
      pipelineFormat = 'native';
    } else if (args.allPages) {
      const pages = await parseFigMultiPage(raw as Buffer);
      console.error(`d2c: extracted ${pages.length} page(s) from .fig file`);
      pipelineInput = { name: pages[0]?.name ?? 'Figma Design', pages };
      pipelineFormat = 'native';
    } else {
      const ir = await parseFig(raw as Buffer);
      pipelineInput = { name: ir.name, width: ir.width, height: ir.height, root: ir.root };
      pipelineFormat = 'native';
    }
  }

  // Pre-parse responsive variants (each one runs through Parse + Layout
  // inference so the diff sees the same shape as the base IR).
  const { parseDesign } = await import('./parser');
  const { inferLayout } = await import('./layout/inference');
  const responsiveVariants = args.responsive.map((r) => {
    const variantRaw = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    const parsed = parseDesign(variantRaw, args.format);
    return {
      breakpoint: r.breakpoint,
      doc: { ...parsed, root: inferLayout(parsed.root) },
    };
  });

  let previousIR;
  if (args.prevIR) {
    previousIR = JSON.parse(fs.readFileSync(args.prevIR, 'utf8'));
  }

  const pipelineOpts = {
    format: pipelineFormat,
    platform: args.platform,
    verbose: args.verbose,
    llm,
    componentLibrary: args.componentLibrary,
    responsiveVariants,
    previousIR,
    computeDiff: !!args.emitDiff,
  };

  // 多页面模式
  if (args.allPages) {
    const multiResult = args.verify
      ? await runMultiPagePipelineWithVerification(pipelineInput, pipelineOpts)
      : await runMultiPagePipeline(pipelineInput, pipelineOpts);
    const { generated } = multiResult;
    const out = args.out ?? '-';
    if (out === '-') {
      for (const file of generated.files) {
        console.log(`// ===== ${file.path} =====`);
        console.log(file.content);
      }
    } else {
      fs.mkdirSync(out, { recursive: true });
      for (const file of generated.files) {
        const full = path.join(out, file.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, file.content);
        if (args.verbose) console.error(`wrote ${full}`);
      }
      console.error(
        `d2c: generated ${generated.files.length} file(s) for ${multiResult.pages.length} page(s) \u2192 ${out} (entry: ${generated.entryFile})`,
      );
    }

    // 多页面 --emit-ir / --emit-tokens / --emit-tailwind / --emit-diff
    const safePageName = (name: string) =>
      name.replace(/[^a-zA-Z0-9_\u4e00-\u9fff -]/g, '_').replace(/^_+|_+$/g, '') || 'page';

    if (args.emitIR) {
      const dir = args.emitIR;
      fs.mkdirSync(dir, { recursive: true });
      for (const page of multiResult.pages) {
        const safeName = safePageName(page.ir.name);
        const filePath = path.join(dir, `${safeName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(page.ir, null, 2));
        if (args.verbose) console.error(`IR written to ${filePath}`);
      }
      console.error(`d2c: wrote ${multiResult.pages.length} IR file(s) → ${dir}`);
    }
    if (args.emitTokens) {
      const dir = args.emitTokens;
      fs.mkdirSync(dir, { recursive: true });
      for (const page of multiResult.pages) {
        const safeName = safePageName(page.ir.name);
        const filePath = path.join(dir, `${safeName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(page.styleDictionary, null, 2));
        if (args.verbose) console.error(`tokens written to ${filePath}`);
      }
      console.error(`d2c: wrote ${multiResult.pages.length} token file(s) → ${dir}`);
    }
    if (args.emitTailwind) {
      const dir = args.emitTailwind;
      fs.mkdirSync(dir, { recursive: true });
      for (const page of multiResult.pages) {
        const safeName = safePageName(page.ir.name);
        const filePath = path.join(dir, `${safeName}.js`);
        fs.writeFileSync(filePath, page.tailwindPreset);
        if (args.verbose) console.error(`tailwind preset written to ${filePath}`);
      }
      console.error(`d2c: wrote ${multiResult.pages.length} tailwind file(s) → ${dir}`);
    }
    if (args.emitDiff) {
      const pagesWithDiff = multiResult.pages.filter((p) => p.diff);
      if (pagesWithDiff.length > 0) {
        const dir = args.emitDiff;
        fs.mkdirSync(dir, { recursive: true });
        for (const page of pagesWithDiff) {
          const safeName = safePageName(page.ir.name);
          const filePath = path.join(dir, `${safeName}.json`);
          fs.writeFileSync(filePath, JSON.stringify(page.diff, null, 2));
          if (args.verbose) console.error(`diff written to ${filePath}`);
        }
        console.error(`d2c: wrote ${pagesWithDiff.length} diff file(s) → ${dir}`);
      }
    }

    // 多页面验证报告 & 快照写入
    if (args.verify && 'pages' in multiResult) {
      const verifiedResult = multiResult as Awaited<ReturnType<typeof runMultiPagePipelineWithVerification>>;
      for (let i = 0; i < verifiedResult.pages.length; i++) {
        const page = verifiedResult.pages[i];
        const pageName = page.ir.name ?? `page_${i + 1}`;
        console.error(`\n── Verification: ${pageName} ──`);
        console.error(formatVerificationReport(page.verification));

        if (args.verifyDir) {
          const safeName = safePageName(pageName);
          const pageDir = path.join(args.verifyDir, safeName);
          fs.mkdirSync(pageDir, { recursive: true });
          for (const snap of page.verification.snapshots) {
            const filePath = path.join(pageDir, `${snap.stage}.json`);
            fs.writeFileSync(filePath, JSON.stringify(snapshotToJSON(snap), null, 2));
          }
          console.error(`d2c verify: wrote ${page.verification.snapshots.length} snapshot(s) → ${pageDir}`);
        }
      }

      if (args.verifyDir) {
        if (args.renderSnapshots) {
          await renderSnapshotsCommand(args);
        }
        if (args.compareStages) {
          await compareStagesCommand(args);
        }
        if (args.compareFidelity) {
          await compareFidelityCommand(args);
        }
      }
    }
    return;
  }

  // Choose verified or standard pipeline
  const result = args.verify
    ? await runPipelineWithVerification(pipelineInput, pipelineOpts)
    : await runPipeline(pipelineInput, pipelineOpts);
  const { ir, generated, tokens, styleDictionary, tailwindPreset, diff } = result;
  void tokens; // tokens are exposed via styleDictionary

  // Verification report
  if (args.verify && 'verification' in result) {
    const verification = (result as Awaited<ReturnType<typeof runPipelineWithVerification>>).verification;
    console.error(formatVerificationReport(verification));

    // Write per-stage snapshots
    if (args.verifyDir) {
      fs.mkdirSync(args.verifyDir, { recursive: true });
      for (const snap of verification.snapshots) {
        const filePath = path.join(args.verifyDir, `${snap.stage}.json`);
        fs.writeFileSync(filePath, JSON.stringify(snapshotToJSON(snap), null, 2));
      }
      console.error(`d2c verify: wrote ${verification.snapshots.length} snapshot(s) → ${args.verifyDir}`);

      // Auto-render snapshots if --render-snapshots points to the same dir
      if (args.renderSnapshots) {
        await renderSnapshotsCommand(args);
      }
      // Auto-compare stages if --compare-stages is also set
      if (args.compareStages) {
        await compareStagesCommand(args);
      }
    }
  }

  if (args.emitIR) {
    writeFile(args.emitIR, JSON.stringify(ir, null, 2));
    if (args.verbose) console.error(`IR written to ${args.emitIR}`);
  }
  if (args.emitTokens) {
    writeFile(args.emitTokens, JSON.stringify(styleDictionary, null, 2));
    if (args.verbose) console.error(`tokens written to ${args.emitTokens}`);
  }
  if (args.emitTailwind) {
    writeFile(args.emitTailwind, tailwindPreset);
    if (args.verbose) console.error(`tailwind preset written to ${args.emitTailwind}`);
  }
  if (args.emitDiff && diff) {
    writeFile(args.emitDiff, JSON.stringify(diff, null, 2));
    if (args.verbose) console.error(`diff written to ${args.emitDiff}`);
  }

  const out = args.out ?? '-';
  if (out === '-') {
    for (const file of generated.files) {
      console.log(`// ===== ${file.path} =====`);
      console.log(file.content);
    }
  } else {
    fs.mkdirSync(out, { recursive: true });
    for (const file of generated.files) {
      const full = path.join(out, file.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, file.content);
      if (args.verbose) console.error(`wrote ${full}`);
    }
    console.error(
      `d2c: generated ${generated.files.length} file(s) → ${out} (entry: ${generated.entryFile})`,
    );
  }
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p) || '.', { recursive: true });
  fs.writeFileSync(p, content);
}

function apiKeyEnvVarFor(provider: NodeLlmProviderName): string {
  switch (provider) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'deepseek':
      return 'DEEPSEEK_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'mistral':
      return 'MISTRAL_API_KEY';
    case 'xai':
      return 'XAI_API_KEY';
    case 'bedrock':
      return 'BEDROCK_API_KEY';
    case 'zhipuai':
      return 'ZHIPUAI_API_KEY';
    case 'siliconflow':
      return 'SILICONFLOW_API_KEY';
    case 'dashscope':
      return 'DASHSCOPE_API_KEY';
    case 'ollama':
      return '';
  }
}

function pickApiKey(provider: NodeLlmProviderName, config: D2CConfig): string | undefined {
  const envName = apiKeyEnvVarFor(provider);
  return resolveApiKey(provider, envName, config);
}

main().catch((e) => {
  console.error('d2c failed:', e);
  process.exit(1);
});
