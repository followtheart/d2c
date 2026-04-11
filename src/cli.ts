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
import type { LLMProvider } from './ai/semanticEnhancer';

interface Args {
  input?: string;
  out?: string;
  platform: Platform;
  format: DesignFormat;
  emitIR?: string;
  useClaude?: boolean;
  verbose?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { platform: 'react', format: 'auto' };
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
      case '--use-claude':
        args.useClaude = true;
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
  -i, --input <file>        Input design file (JSON)
  -o, --out <dir|->         Output directory, or '-' for stdout (default: stdout)
  -p, --platform <name>     Target platform: react | vue | html (default: react)
  -f, --format <name>       Input format: figma | native | auto (default: auto)
      --emit-ir <file>      Also write the intermediate IR JSON to <file>
      --use-claude          Use Claude as the semantic LLM provider
                            (requires ANTHROPIC_API_KEY env var)
  -v, --verbose             Verbose logging
  -h, --help                Show this help

Examples:
  d2c -i design.json -p react -o out/react
  d2c -i figma-export.json -f figma -p vue -o out/vue --verbose
  d2c -i design.json -p html -o -          # print to stdout
`;

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

  const raw = JSON.parse(fs.readFileSync(args.input, 'utf8'));

  let llm: LLMProvider | undefined;
  if (args.useClaude) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ERROR: --use-claude requires ANTHROPIC_API_KEY env var.');
      process.exit(2);
    }
    llm = new ClaudeProvider({ apiKey });
  }

  const { ir, generated } = await runPipeline(raw, {
    format: args.format,
    platform: args.platform,
    verbose: args.verbose,
    llm,
  });

  if (args.emitIR) {
    writeFile(args.emitIR, JSON.stringify(ir, null, 2));
    if (args.verbose) console.error(`IR written to ${args.emitIR}`);
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

main().catch((e) => {
  console.error('d2c failed:', e);
  process.exit(1);
});
