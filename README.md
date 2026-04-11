# d2c — Design-to-Code Converter

An end-to-end **Design-to-Code (D2C)** pipeline that converts design files
(Figma REST API responses or a simpler "native" design JSON) into working
**React + Tailwind**, **Vue 3 SFC**, or **HTML + CSS** source code.

Based on the architecture described in [`doc/opus4.6.md`](doc/opus4.6.md) and
[`doc/qwen3.6.md`](doc/qwen3.6.md):

> **Rules engine handles the deterministic work (layout calculation, style
> mapping). AI handles the ambiguous work (semantic understanding, component
> identification, responsive inference).**

## Architecture

```
┌───────────┐   ┌─────────┐   ┌────────┐   ┌──────────────┐   ┌───────────┐   ┌──────────┐
│ Design    │──▶│ Parser  │──▶│ IR     │──▶│ Layout       │──▶│ Semantic  │──▶│ Codegen  │
│ File(JSON)│   │ (Figma/ │   │ (tree) │   │ Inference    │   │ Enhancer  │   │ (React/  │
│           │   │ native) │   │        │   │ (abs → flex) │   │ (rules +  │   │  Vue/    │
│           │   │         │   │        │   │              │   │  LLM)     │   │  HTML)   │
└───────────┘   └─────────┘   └────────┘   └──────────────┘   └───────────┘   └──────────┘
```

### Pipeline stages

1. **Parser** (`src/parser`) — accepts Figma REST API shape or a native
   hand-authorable JSON; produces the IR tree.
2. **IR** (`src/ir`) — the tool/target-agnostic intermediate representation
   (node types, box, layout, style, text, semantics).
3. **Layout inference** (`src/layout`) — deterministic rule engine that
   analyzes child geometry and converts absolute positioning to flex/grid
   layouts (direction, gap, justify, align, space-between, grid columns).
4. **Semantic enhancement** (`src/ai`) — heuristic + optional LLM.
   Detects headers/nav/footer, buttons, headings, repeating list patterns,
   and assigns semantic roles / component names. Pluggable `LLMProvider`
   interface; a Claude provider is included out of the box.
5. **Code generation** (`src/codegen`) — platform-specific renderer that
   walks the enhanced IR and produces the target code. Ships with:
   - `ReactGenerator` — React + Tailwind CSS (arbitrary values)
   - `VueGenerator` — Vue 3 SFC with `<script setup>` and scoped CSS
   - `HtmlGenerator` — HTML + external stylesheet (with class deduplication)

## Quickstart

```bash
npm install        # installs only typescript + @types/node (zero runtime deps)
npm run build
npm test           # runs the node:test suite (9 tests, end-to-end)

# Generate React code from the sample design
node dist/cli.js --input examples/sample-design.json --platform react --out out/react

# Generate Vue
node dist/cli.js --input examples/sample-design.json --platform vue --out out/vue

# Generate plain HTML + CSS
node dist/cli.js --input examples/sample-design.json --platform html --out out/html

# From a Figma REST API response
node dist/cli.js --input examples/figma-sample.json --format figma --platform react --out out/figma-react

# Dump the post-enhancement IR for inspection
node dist/cli.js --input examples/sample-design.json --platform react --out - --emit-ir out/ir.json

# Use Claude to refine semantic annotations (requires ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-ant-... node dist/cli.js \
    --input examples/sample-design.json --platform react --out out/react --use-claude
```

## CLI options

```
  -i, --input <file>      Input design file (JSON)
  -o, --out <dir|->       Output directory, or '-' for stdout (default: stdout)
  -p, --platform <name>   Target platform: react | vue | html (default: react)
  -f, --format <name>     Input format: figma | native | auto (default: auto)
      --emit-ir <file>    Also write the intermediate IR JSON
      --use-claude        Use Claude for the semantic LLM pass
  -v, --verbose
  -h, --help
```

## Using as a library

```ts
import { runPipeline, ClaudeProvider } from 'd2c';
import designJson from './design.json';

const { ir, generated } = await runPipeline(designJson, {
  platform: 'react',
  // llm: new ClaudeProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
});

for (const file of generated.files) {
  console.log(file.path, file.content);
}
```

## The native design format

A small, hand-authorable schema used as the default input format. Minimal
example:

```json
{
  "name": "UserCard",
  "width": 360,
  "height": 200,
  "root": {
    "id": "root", "name": "card", "type": "container",
    "width": 360, "height": 200,
    "background": "#fff", "borderRadius": 16, "padding": 24,
    "children": [
      { "id": "title", "x": 24, "y": 24, "width": 312, "height": 32,
        "text": { "content": "Hello", "fontSize": 20, "fontWeight": 700 } }
    ]
  }
}
```

See [`examples/sample-design.json`](examples/sample-design.json) for a rich
example (avatar card with stats row, buttons, and tag list).

## What the layout inference does

Given absolute coordinates and sizes, the inference engine (`src/layout/inference.ts`):

- Detects **vertical stack** → `flex-col` (no Y overlap between children)
- Detects **horizontal stack** → `flex-row` (no X overlap)
- Detects **regular NxM grid** → `grid` + `grid-template-columns: repeat(N, …)`
- Computes `gap` as the median inter-child spacing along the main axis
- Computes `alignItems` by checking cross-axis anchoring (start/center/end)
- Upgrades `justifyContent` to `space-between` when children span the full
  container with even internal spacing
- Falls back to `absolute` only when children truly overlap

## What the semantic enhancer does

`src/ai/semanticEnhancer.ts` runs two passes:

1. **Rules pass** (always on, offline):
   - Name-based role hints (`header`, `nav`, `footer`, `card`, `button`, `avatar`, …)
   - Button detection: rounded pill + background + single text/icon child
   - Heading detection: large font-size or bold weight
   - List detection: 3+ siblings with identical structural signature →
     parent becomes `<ul>`, children become `<li>`
   - Auto-assigns `PascalCase` component names
2. **LLM pass** (optional, via `LLMProvider`):
   - Sends the IR to an LLM and merges returned per-id semantic annotations.
   - `ClaudeProvider` ships out of the box (`src/ai/claudeProvider.ts`).
   - Users can plug in OpenAI, Qwen-VL, local vLLM, etc. by implementing a
     one-method interface.

## Adding new targets

Implement `CodeGenerator` (`src/codegen/base.ts`) and register in
`src/codegen/factory.ts`. Each generator walks the same IR — the layout
inference and semantic enhancement phases are shared across targets, so a
new platform (Flutter, SwiftUI, React Native) mainly means writing a
renderer.

## Roadmap

Mapped to the phases described in the design docs:

- [x] **P0**: IR, native + Figma parsing, layout inference, React/Vue/HTML
      generation, end-to-end tests
- [ ] **P1**: Sketch `.sketch` ZIP parser, proper nested-group layout
      inference, Tailwind preset / theme extraction, visual regression
      via Playwright
- [ ] **P2**: Design tokens extraction (`style-dictionary`), IR diff +
      `// ai:ignore` protected regions, component library matching
      (antd / MUI)
- [ ] **P3**: Flutter / SwiftUI / React Native generators, responsive
      breakpoint inference

## Directory layout

```
src/
├── ir/            # Intermediate representation types & runtime validation
├── parser/        # Figma + native design JSON parsers
├── layout/        # Deterministic layout inference engine
├── ai/            # Rule-based + optional LLM semantic enhancer
├── codegen/       # React, Vue, HTML generators (pluggable)
├── pipeline/      # End-to-end orchestration
├── tests/         # node:test suite (no extra deps)
├── utils/         # Shared helpers (color, tree walking, case)
├── index.ts       # Library entry
└── cli.ts         # CLI entry
examples/
├── sample-design.json   # Native format example (UserCard)
└── figma-sample.json    # Figma REST API shape example
doc/
├── opus4.6.md     # Original design doc (English / Chinese)
└── qwen3.6.md     # Alternate design doc
```

## License

MIT
