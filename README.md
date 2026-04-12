# d2c — Design-to-Code Converter

An end-to-end **Design-to-Code (D2C)** pipeline that converts design files
(Figma REST API, Sketch JSON, or a simpler "native" design JSON) into working
**React + Tailwind**, **Vue 3 SFC**, **HTML + CSS**, **React Native**, or
**Flutter** source code — with design-token extraction, Tailwind preset
generation, antd / MUI component matching, responsive breakpoint inference,
and protected `// ai:ignore` regions for safe regeneration.

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
5. **Component matching** (`src/ai/componentMatch.ts`, optional) — rule-based
   detector that maps IR nodes to known component-library components
   (`antd`, `mui`) so codegen can emit `<Button type="primary">` instead of
   bespoke divs.
6. **Responsive inference** (`src/layout/responsive.ts`, optional) — diffs
   one or more secondary IR documents (different viewports of the same
   design) against the base and stamps `node.responsive[breakpoint]`
   overrides on the matching nodes.
7. **Protected region merge** (`src/diff/merge.ts`, optional) — preserves
   subtrees marked `semantics.aiIgnore = true` from a previous IR across
   regenerations and emits a structural diff for CI logs.
8. **Token extraction** (`src/tokens/extract.ts`) — walks the IR, collects
   recurring colors, font sizes, spacings, radii and shadows into a
   deduplicated `TokenSet`, then exposes a `style-dictionary`-shaped JSON
   and a generated **Tailwind preset** (`src/tokens/tailwindPreset.ts`).
9. **Code generation** (`src/codegen`) — platform-specific renderer that
   walks the enhanced IR and produces the target code. Ships with:
   - `ReactGenerator` — React + Tailwind CSS (arbitrary values)
   - `VueGenerator` — Vue 3 SFC with `<script setup>` and scoped CSS
   - `HtmlGenerator` — HTML + external stylesheet (with class deduplication)
   - `ReactNativeGenerator` — `View` / `Text` / `Image` / `Pressable` +
     `StyleSheet.create`
   - `FlutterGenerator` — `StatelessWidget` with `Container` / `Row` /
     `Column` / `Text` / `Image.network`

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

# Use any provider supported by @node-llm/core (OpenRouter / DeepSeek / OpenAI /
# Gemini / Mistral / xAI / Bedrock / local Ollama). The relevant *_API_KEY env
# var is read automatically. Requires `npm install @node-llm/core` first.
OPENROUTER_API_KEY=sk-or-... node dist/cli.js \
    --input examples/sample-design.json --platform react --out out/react \
    --llm-provider openrouter --llm-model anthropic/claude-3.5-sonnet

DEEPSEEK_API_KEY=sk-... node dist/cli.js \
    --input examples/sample-design.json --platform react --out out/react \
    --llm-provider deepseek --llm-model deepseek-chat
```

## CLI options

```
  -i, --input <file>             Input design file (JSON)
  -o, --out <dir|->              Output directory, or '-' for stdout
  -p, --platform <name>          Target platform: react | vue | html |
                                 react-native | flutter (default: react)
  -f, --format <name>            Input format: figma | sketch | native | auto
      --emit-ir <file>           Also write the intermediate IR JSON
      --emit-tokens <file>       Write design tokens (style-dictionary JSON)
      --emit-tailwind <file>     Write a Tailwind preset (theme.extend) module
      --emit-diff <file>         Write a structural IR diff against --prev-ir
      --component-library <lib>  Match nodes to a component library: antd | mui
      --responsive <bp>=<file>   Add a responsive variant for breakpoint <bp>
                                 (repeatable, e.g. --responsive sm=mobile.json)
      --prev-ir <file>           Previous IR JSON for ai:ignore region merge
      --use-claude               Use Claude for the semantic LLM pass
      --llm-provider <name>      Use @node-llm/core: openai | anthropic |
                                 gemini | deepseek | openrouter | ollama |
                                 mistral | xai | bedrock
      --llm-model <id>           Model id for --llm-provider
      --llm-base-url <url>       Override base URL (gateways / Ollama)
  -v, --verbose
  -h, --help
```

### Examples

```bash
# Flutter widget from the same input
node dist/cli.js -i examples/sample-design.json -p flutter -o out/flutter

# React Native component
node dist/cli.js -i examples/sample-design.json -p react-native -o out/rn

# Match antd components and emit React + Tailwind
node dist/cli.js -i examples/sample-design.json --component-library antd \
    -p react -o out/antd

# Extract design tokens + Tailwind preset alongside the React output
node dist/cli.js -i examples/sample-design.json -p react -o out/react \
    --emit-tokens out/tokens.json --emit-tailwind out/tailwind.preset.js

# Responsive — base + mobile variant → merged IR with sm: overrides
node dist/cli.js -i examples/sample-design.json \
    --responsive sm=examples/sample-design-mobile.json -p react -o out/responsive

# Sketch (pre-extracted page JSON from a .sketch ZIP)
node dist/cli.js -i examples/sketch-sample.json -f sketch -p react -o out/sketch
```

## Using as a library

```ts
import { runPipeline, ClaudeProvider, NodeLlmProvider } from 'd2c';
import designJson from './design.json';

const { ir, generated } = await runPipeline(designJson, {
  platform: 'react',
  // Pick any provider supported by @node-llm/core:
  // llm: new ClaudeProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  // llm: new NodeLlmProvider({
  //   provider: 'openrouter',
  //   model: 'anthropic/claude-3.5-sonnet',
  //   apiKey: process.env.OPENROUTER_API_KEY!,
  // }),
  // llm: new NodeLlmProvider({
  //   provider: 'deepseek',
  //   model: 'deepseek-chat',
  //   apiKey: process.env.DEEPSEEK_API_KEY!,
  // }),
});

for (const file of generated.files) {
  console.log(file.path, file.content);
}
```

> The `NodeLlmProvider` route uses [`@node-llm/core`](https://www.npmjs.com/package/@node-llm/core),
> a provider-agnostic LLM engine for Node.js. It is declared as an **optional**
> peer dependency — install it with `npm install @node-llm/core` only if you
> actually plan to call OpenRouter, DeepSeek, Gemini, Ollama, etc. from d2c.

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
   - `ClaudeProvider` ships out of the box (`src/ai/claudeProvider.ts`),
     hand-rolled on top of Node 22's `fetch` (zero deps).
   - `NodeLlmProvider` (`src/ai/nodeLlmProvider.ts`) bridges to
     [`@node-llm/core`](https://www.npmjs.com/package/@node-llm/core), giving
     d2c instant access to **OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter
     (540+ models), Ollama, Mistral, xAI and Bedrock** through a single API.
     `@node-llm/core` is an *optional* peer dependency — install it on demand.
   - Users can also plug in any custom backend (Qwen-VL, local vLLM, etc.) by
     implementing the one-method `LLMProvider` interface.

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
- [x] **P1**: Sketch parser (pre-extracted JSON), Tailwind preset / theme
      extraction. _Open: ZIP-level `.sketch` reader, Playwright visual
      regression._
- [x] **P2**: Design tokens extraction (`style-dictionary` shape),
      IR diff + `// ai:ignore` protected regions, component library
      matching (antd / MUI).
- [x] **P3**: React Native + Flutter generators, responsive breakpoint
      inference (multi-viewport diff). _Open: SwiftUI generator._

## Directory layout

```
src/
├── ir/            # Intermediate representation types & runtime validation
├── parser/        # Figma + Sketch + native design JSON parsers
├── layout/        # Deterministic layout inference + responsive merge
├── ai/            # Rule-based + optional LLM semantic enhancer +
│                  # antd/MUI component matching
├── tokens/        # Design token extraction + Tailwind preset generator
├── diff/          # IR diff + ai:ignore protected region merge
├── codegen/       # React, Vue, HTML, React Native, Flutter generators
├── pipeline/      # End-to-end orchestration
├── tests/         # node:test suite (no extra deps)
├── utils/         # Shared helpers (color, tree walking, case)
├── index.ts       # Library entry
└── cli.ts         # CLI entry
examples/
├── sample-design.json         # Native format example (UserCard, desktop)
├── sample-design-mobile.json  # Same UserCard at the sm breakpoint
├── figma-sample.json          # Figma REST API shape example
└── sketch-sample.json         # Pre-extracted Sketch page JSON
doc/
├── opus4.6.md     # Original design doc (English / Chinese)
└── qwen3.6.md     # Alternate design doc
```

## License

MIT
