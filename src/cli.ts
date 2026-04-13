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
import { runPipeline } from './pipeline/d2cPipeline';
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
  /** Render mode: render Sketch design to SVG / HTML preview */
  render?: boolean;
  renderFormat?: 'svg' | 'html';
  renderScale?: number;
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
  -f, --format <name>            Input format: figma | sketch | native | auto
      --emit-ir <file>           Also write the intermediate IR JSON
      --emit-tokens <file>       Write design tokens (style-dictionary JSON)
      --emit-tailwind <file>     Write a Tailwind preset (theme.extend) module
      --emit-diff <file>         Write structural IR diff against --prev-ir
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
                                 mistral | xai | bedrock. The matching API
                                 key env var (e.g. OPENROUTER_API_KEY,
                                 DEEPSEEK_API_KEY) is read automatically.
                                 Requires "npm install @node-llm/core".
      --llm-model <id>           Model id passed to --llm-provider
                                 (e.g. deepseek-chat, openai/gpt-4o-mini)
      --llm-base-url <url>       Override the provider base URL (e.g. for
                                 self-hosted gateways or Ollama)
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
`;

/**
 * Resolve the --input path into a parsed JSON object.
 * Supports:
 *  - A regular JSON file (any format)
 *  - An extracted .sketch directory (contains pages/*.json)
 *  - A document.json with MSJSONFileReference page pointers
 */
function resolveInput(inputPath: string, format: DesignFormat): unknown {
  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) {
    return resolveSketchDir(inputPath);
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

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    process.exit(2);
  }

  if (args.help || !args.input) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const raw = resolveInput(args.input, args.format);

  // ─── Render mode: Sketch → SVG / HTML preview ─────────────────────
  if (args.render) {
    const { renderSketch } = await import('./renderer');
    const scale = args.renderScale ?? 1;
    const result = renderSketch(raw, { scale });
    const format = args.renderFormat ?? 'html';
    const out = args.out ?? '-';

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

  const result = await runPipeline(raw, {
    format: args.format,
    platform: args.platform,
    verbose: args.verbose,
    llm,
    componentLibrary: args.componentLibrary,
    responsiveVariants,
    previousIR,
    computeDiff: !!args.emitDiff,
  });
  const { ir, generated, tokens, styleDictionary, tailwindPreset, diff } = result;
  void tokens; // tokens are exposed via styleDictionary

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
