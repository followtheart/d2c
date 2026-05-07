# d2c — Design-to-Code Converter

An end-to-end **Design-to-Code (D2C)** pipeline that converts design files
(Figma REST API, **Figma `.fig` binary**, Figma Make, Sketch JSON, or a
simpler "native" design JSON) into working **React + Tailwind**,
**Vue 3 SFC**, **HTML + CSS**, **React Native**, or **Flutter** source code
— with design-token extraction, Tailwind preset generation, antd / MUI
component matching, responsive breakpoint inference, protected
`// ai:ignore` regions for safe regeneration, **高保真 `.fig` 渲染引擎**,
**Figma REST API 集成**, **阶段快照可视化**, 以及 **多模态 LLM 阶段比对分析**。

Based on the architecture described in [`doc/opus4.6.md`](doc/opus4.6.md) and
[`doc/qwen3.6.md`](doc/qwen3.6.md):

> **Rules engine handles the deterministic work (layout calculation, style
> mapping). AI handles the ambiguous work (semantic understanding, component
> identification, responsive inference).**

## Architecture

```
┌───────────┐   ┌─────────┐   ┌────────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────┐   ┌──────────┐
│ Design    │──▶│ Parser  │──▶│ IR     │──▶│ Layout       │──▶│ Layout LLM   │──▶│ Semantic  │──▶│ Codegen  │
│ File(JSON)│   │ (Figma/ │   │ (tree+ │   │ Inference    │   │ Refiner      │   │ Enhancer  │   │ (token-  │
│           │   │ native) │   │ meta)  │   │ (abs → flex, │   │ (low-conf    │   │ (rules +  │   │  aware,  │
│           │   │         │   │        │   │  +confidence)│   │  containers, │   │  LLM)     │   │  React/  │
│           │   │         │   │        │   │              │   │  optional)   │   │           │   │  Vue/…)  │
└───────────┘   └─────────┘   └────┬───┘   └──────────────┘   └──────────────┘   └───────────┘   └────┬─────┘
                                   │                                                                  │
                                   │   ┌──────────────────────────────────────────────────────┐       │
                                   └──▶│ Visual feedback loop (optional)                      │◀──────┘
                                       │ render → score → mark low-fidelity → re-refine       │
                                       └──────────────────────────────────────────────────────┘
```

### Pipeline stages

1. **Parser** (`src/parser`) — accepts Figma REST API shape, **Figma `.fig`
   binary files (ZIP + fig-kiwi archive, with embedded image assets)**,
   Figma Make (`.make`), Sketch JSON, or native hand-authorable JSON;
   produces the IR tree.
2. **IR** (`src/ir`) — the tool/target-agnostic intermediate representation
   (node types, box, layout, style, text, semantics). Also carries
   **source-tool metadata** (`node.meta.figma`) — Figma constraints,
   auto-layout descriptor, sizing modes (`FIXED`/`HUG`/`FILL`), instance
   ↔ component links, per-side stroke widths, `textAutoResize` — so
   downstream stages can consult tool-specific information instead of
   working from a lossy generic shape.
3. **Layout inference** (`src/layout`) — deterministic rule engine that
   analyzes child geometry and converts absolute positioning to flex/grid
   layouts (direction, gap, justify, align, space-between, grid columns,
   `flex-wrap`). Each container's resulting layout carries
   `layout.confidence` (0-1) and `layout.source`
   (`figma-autolayout` | `rule-engine` | `llm-refined` | `vision-refined`)
   so later stages can selectively re-decide low-confidence containers.
4. **Layout LLM refiner** (`src/layout/llmRefiner.ts`, optional) —
   pluggable provider that re-runs layout inference on containers the
   rule engine flagged as low-confidence (or fell back to `absolute`).
   Inject any vision/structured-text model via the `LayoutLLMProvider`
   interface; default pipeline runs offline and skips this stage.
5. **Semantic enhancement** (`src/ai`) — heuristic + optional LLM.
   Detects headers/nav/footer, buttons, headings, repeating list patterns,
   and assigns semantic roles / component names. Pluggable `LLMProvider`
   interface; a Claude provider is included out of the box.
6. **Component matching** (`src/ai/componentMatch.ts`, optional) — rule-based
   detector that maps IR nodes to known component-library components
   (`antd`, `mui`) so codegen can emit `<Button type="primary">` instead of
   bespoke divs.
7. **Responsive inference** (`src/layout/responsive.ts`, optional) — diffs
   one or more secondary IR documents (different viewports of the same
   design) against the base and stamps `node.responsive[breakpoint]`
   overrides on the matching nodes.
8. **Protected region merge** (`src/diff/merge.ts`, optional) — preserves
   subtrees marked `semantics.aiIgnore = true` from a previous IR across
   regenerations and emits a structural diff for CI logs.
9. **Token extraction** (`src/tokens/extract.ts`) — walks the IR, collects
   recurring colors, font sizes, spacings, radii and shadows into a
   deduplicated `TokenSet`, then exposes a `style-dictionary`-shaped JSON
   and a generated **Tailwind preset** (`src/tokens/tailwindPreset.ts`).
   The full `TokenSet` is also stamped onto `IRDocument.tokenSet` so the
   code generator can emit semantic class names.
10. **Code generation** (`src/codegen`) — platform-specific renderer that
    walks the enhanced IR and produces the target code. The React generator
    is **token-aware** — it consults a reverse lookup
    (`src/tokens/resolver.ts`) and emits semantic Tailwind classes
    (`bg-blue-500`, `gap-3`, `text-base`, `rounded-md`) when a value
    matches a token, falling back to arbitrary literals
    (`bg-[#3f8cff]`, `gap-[12px]`) only for unique values. Ships with:
    - `ReactGenerator` — React + Tailwind CSS (token-aware + arbitrary)
    - `VueGenerator` — Vue 3 SFC with `<script setup>` and scoped CSS
    - `HtmlGenerator` — HTML + external stylesheet (with class deduplication)
    - `ReactNativeGenerator` — `View` / `Text` / `Image` / `Pressable` +
      `StyleSheet.create`
    - `FlutterGenerator` — `StatelessWidget` with `Container` / `Row` /
      `Column` / `Text` / `Image.network`
11. **Visual feedback loop** (`src/pipeline/visualFeedback.ts`, optional) —
    closes the back-edge from output to input. Given a renderer + a
    fidelity scorer, it runs `render → score → mark → refine` as a
    fixed-point iteration: low-region-score nodes have their
    `layout.confidence` stamped low so the next refine pass picks them up.
    Stops when scores plateau or the iteration budget is exhausted.

## Quickstart

```bash
npm install        # installs only typescript + @types/node (zero runtime deps)
npm run build
npm test           # runs the node:test suite (end-to-end)

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
# var is read automatically. @node-llm/core is auto-installed as optional dep.
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
  -f, --format <name>            Input format: figma | sketch | native | make |
                                 fig | auto
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
                                 mistral | xai | bedrock | zhipuai |
                                 siliconflow
      --llm-model <id>           Model id for --llm-provider
      --llm-base-url <url>       Override base URL (gateways / Ollama)
      --all-pages                Process all pages in the design
      --verify                   Run pipeline with stage-by-stage verification
      --verify-dir <dir>         Write per-stage snapshot JSON files to <dir>
      --render-snapshots <dir>   Render per-stage snapshot JSON files from
                                 <dir> into visual output (PNG or HTML)
      --render-output <dir>      Output directory for rendered snapshots
      --snapshot-format <fmt>    Snapshot render format: png | html (default: png)
      --compare-stages           Run multimodal LLM comparison on rendered
                                 stage screenshots (PNG)
      --compare-report <file>    Output path for comparison report
      --vision-provider <name>   Vision backend: openrouter | anthropic
                                 (default: openrouter)
      --vision-model <id>        Override the vision model id
      --render                   Render the design visually (SVG / HTML)
      --render-format <fmt>      Render output format: svg | html
      --render-scale <n>         Scale factor for rendered output
      --figma-token <token>      Figma personal access token (or FIGMA_TOKEN)
      --figma-file-key <key>     Figma file key or full URL to fetch via API
      --figma-node-ids <ids>     Comma-separated node IDs to fetch/export
      --figma-export-images      Export images via Figma server-side rendering
      --figma-export-format <f>  Export format: png | jpg | svg | pdf
      --figma-export-scale <n>   Export scale (0.01–4, default: 2)
  -v, --verbose                  Verbose logging
  -h, --help                     Show this help
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

# .fig (Figma native binary) — high-fidelity visual preview
node dist/cli.js -i examples/CRM.fig --render --render-format html \
    -o out/crm-preview

# .fig → React code (one component per top-level FRAME)
node dist/cli.js -i examples/website.fig -p react -o out/website

# Pipeline verification with stage snapshots
node dist/cli.js -i examples/sample-design.json -p react -o out/react \
    --verify-dir snapshots/

# Render stage snapshots to visual HTML
node dist/cli.js --render-snapshots snapshots/ --snapshot-format html \
    --render-output out/rendered/

# Full pipeline: verify → render → multimodal comparison
OPENROUTER_API_KEY=... node dist/cli.js -i examples/sample-design.json -p react \
    -o out/react --verify-dir snap/ --render-snapshots snap/ --render-output img/ \
    --compare-stages --compare-report report.html

# Standalone stage comparison on existing screenshots
node dist/cli.js --compare-stages --render-output img/ --compare-report report.md

# Use Anthropic as the vision backend
ANTHROPIC_API_KEY=... node dist/cli.js --compare-stages --render-output img/ \
    --vision-provider anthropic --compare-report report.json

# ── Figma REST API ─────────────────────────────────────────────────
# Fetch a Figma cloud file → React code
node dist/cli.js --figma-file-key abc123DEF --figma-token figd_xxx \
    -p react -o out/figma-react

# Figma URL also works as file key
node dist/cli.js --figma-file-key https://www.figma.com/design/abc123DEF/MyFile \
    -p react -o out/figma-react

# Export specific nodes as PNG from Figma servers
node dist/cli.js --figma-file-key abc123DEF --figma-export-images \
    --figma-node-ids "1:2,3:4" --figma-export-format png -o out/images

# Render Figma cloud file as HTML preview (no code generation)
node dist/cli.js --figma-file-key abc123DEF --render --render-format html -o out/preview

# Use .d2crc.json for token (figmaToken field)
node dist/cli.js --figma-file-key abc123DEF -p vue -o out/vue
```

## LLM API Token 配置

语义增强（Semantic Enhancement）是可选步骤，需要配置 LLM API Key 才能启用。
d2c 提供两条 LLM 接入路径：**内置 Claude Provider** 和 **NodeLlmProvider（多厂商）**，
二者互斥，不能同时使用。

API Key 的读取优先级为：**CLI 参数 / 环境变量 > 配置文件（`.d2crc.json`）**。

### 配置文件（`.d2crc.json`）

d2c 会按以下顺序查找配置文件（找到第一个即停止）：

1. 当前工作目录下的 `.d2crc.json`
2. 用户主目录下的 `~/.d2crc.json`

配置文件格式：

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-api03-xxxxx",
    "openrouter": "sk-or-xxxxx",
    "deepseek": "sk-xxxxx",
    "openai": "sk-xxxxx",
    "siliconflow": "sk-xxxxx",
    "gemini": "AIza-xxxxx",
    "mistral": "xxxxx",
    "xai": "xxxxx",
    "bedrock": "xxxxx"
  },
  "llm": {
    "provider": "siliconflow",
    "model": "Pro/moonshotai/Kimi-K2.5",
    "baseUrl": "https://custom-gateway.example.com/v1"
  },
  "figmaToken": "figd_xxxxxxxxxxxxxxxxxxxx"
}
```

| 字段 | 说明 |
|------|------|
| `apiKeys.<provider>` | 各厂商的 API Key，可只填需要的 |
| `llm.provider` | 默认 LLM 供应商（可被 `--llm-provider` 覆盖） |
| `llm.model` | 默认模型 id（可被 `--llm-model` 覆盖） |
| `llm.baseUrl` | 默认端点 URL（可被 `--llm-base-url` 覆盖） |
| `figmaToken` | Figma 个人访问令牌（可被 `--figma-token` 或 `FIGMA_TOKEN` 环境变量覆盖） |

> `siliconflow` 按 OpenAI 兼容接口接入；未显式指定 `llm.baseUrl` 时默认使用 `https://api.siliconflow.cn/v1`。

配置完成后，只需运行：

```bash
# 无需在命令行传 provider / key，全部从 .d2crc.json 读取
node dist/cli.js -i examples/sample-design.json -p react -o out/react
```

> **安全提示：** `.d2crc.json` 包含敏感密钥，请勿提交到版本控制。
> 建议将 `.d2crc.json` 加入 `.gitignore`。

### 方式一：内置 Claude Provider（`--use-claude`）

仅支持 Anthropic Claude，从环境变量 `ANTHROPIC_API_KEY` 或配置文件
`apiKeys.anthropic` 读取密钥。

```bash
# 通过环境变量
export ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
node dist/cli.js -i examples/sample-design.json -p react -o out/react --use-claude

# 或通过 .d2crc.json（apiKeys.anthropic 已配置）
node dist/cli.js -i examples/sample-design.json -p react -o out/react --use-claude
```

| 配置项 | 值 |
|--------|---|
| 环境变量 | `ANTHROPIC_API_KEY` |
| 配置文件字段 | `apiKeys.anthropic` |
| 默认模型 | `claude-opus-4-6` |
| 默认端点 | `https://api.anthropic.com/v1/messages` |

### 方式二：NodeLlmProvider（`--llm-provider`）

通过 [`@node-llm/core`](https://www.npmjs.com/package/@node-llm/core) 接入
9 种 LLM 厂商。`@node-llm/core` 已作为可选依赖（`optionalDependencies`），
执行 `npm install` 时会自动安装。

各厂商对应的**环境变量**、**配置文件字段**与**默认模型**如下：

| `--llm-provider` | 环境变量 | `.d2crc.json` 字段 | 默认模型 |
|-------------------|----------|---------------------|----------|
| `openai` | `OPENAI_API_KEY` | `apiKeys.openai` | `gpt-4o-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | `apiKeys.anthropic` | `claude-3-5-sonnet-latest` |
| `gemini` | `GEMINI_API_KEY` | `apiKeys.gemini` | `gemini-1.5-flash` |
| `deepseek` | `DEEPSEEK_API_KEY` | `apiKeys.deepseek` | `deepseek-chat` |
| `openrouter` | `OPENROUTER_API_KEY` | `apiKeys.openrouter` | `openai/gpt-4o-mini` |
| `mistral` | `MISTRAL_API_KEY` | `apiKeys.mistral` | `mistral-small-latest` |
| `xai` | `XAI_API_KEY` | `apiKeys.xai` | `grok-2-latest` |
| `bedrock` | `BEDROCK_API_KEY` | `apiKeys.bedrock` | `anthropic.claude-3-5-sonnet-20240620-v1:0` |
| `ollama` | 不需要 | 不需要 | `llama3.1` |

使用示例：

```bash
# 纯命令行 + 环境变量
export OPENROUTER_API_KEY=sk-or-xxxxx
node dist/cli.js -i examples/sample-design.json -p react -o out/react \
    --llm-provider openrouter --llm-model anthropic/claude-3.5-sonnet

# 使用 .d2crc.json（provider / model / apiKey 已在配置文件中）
node dist/cli.js -i examples/sample-design.json -p react -o out/react

# 配置文件中设了 provider=deepseek，命令行覆盖 model
node dist/cli.js -i examples/sample-design.json -p react -o out/react \
    --llm-model deepseek-reasoner

# 本地 Ollama（无需 API Key）
node dist/cli.js -i examples/sample-design.json -p react -o out/react \
    --llm-provider ollama --llm-model llama3.1 --llm-base-url http://localhost:11434

# 自定义网关 / 代理
node dist/cli.js -i examples/sample-design.json -p react -o out/react \
    --llm-provider openai --llm-base-url https://your-gateway.example.com/v1
```

### 作为库使用时传入 API Key

```ts
import { runPipeline, ClaudeProvider, NodeLlmProvider, loadConfig, resolveApiKey } from 'd2c';

// 直接传入 API Key
const { ir, generated } = await runPipeline(designJson, {
  platform: 'react',
  llm: new ClaudeProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
});

// 从 .d2crc.json 读取
const config = loadConfig();
const apiKey = resolveApiKey('openrouter', 'OPENROUTER_API_KEY', config);
const result = await runPipeline(designJson, {
  platform: 'react',
  llm: new NodeLlmProvider({
    provider: 'openrouter',
    model: 'anthropic/claude-3.5-sonnet',
    apiKey,
  }),
});
```

> **注意：** `--use-claude` 和 `--llm-provider` 不能同时使用，CLI 会报错退出。
> 如果不传任何 LLM 参数且配置文件中也未设置 `llm.provider`，d2c 仍会运行，
> 只是跳过 LLM 语义增强步骤，仅使用规则引擎。

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
> a provider-agnostic LLM engine for Node.js。它作为 `optionalDependencies` 声明，
> `npm install` 时会自动安装。如需跳过，可执行 `npm install --omit=optional`。

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

## Figma REST API 集成

d2c 支持通过 **Figma REST API** 直接从 Figma 云端获取设计文件并生成代码，
无需手动导出 JSON 或下载 `.fig` 文件。

### Token 配置

Figma API 需要一个个人访问令牌（Personal Access Token），支持三种配置方式
（按优先级从高到低）：

1. CLI 参数：`--figma-token figd_xxx`
2. 环境变量：`FIGMA_TOKEN=figd_xxx`
3. 配置文件：`.d2crc.json` 中的 `figmaToken` 字段

### 功能说明

| 模式 | 说明 | 关键参数 |
|------|------|----------|
| **代码生成** | 获取文件 JSON → 解析为 IR → 运行流水线 → 输出代码 | `--figma-file-key` + `-p react` |
| **HTML/SVG 预览** | 获取文件 JSON → 渲染为可视化预览 | `--figma-file-key` + `--render` |
| **图片导出** | 调用 Figma 服务端渲染接口导出节点为图片 | `--figma-export-images` |

### CLI 使用

```bash
# 从 Figma 云端文件生成 React 代码
node dist/cli.js --figma-file-key abc123DEF -p react -o out/figma-react

# 支持完整 Figma URL
node dist/cli.js --figma-file-key https://www.figma.com/design/abc123DEF/MyFile \
    -p react -o out/figma-react

# 仅获取特定节点
node dist/cli.js --figma-file-key abc123DEF --figma-node-ids "1:2,3:4" \
    -p react -o out/nodes

# 多页面模式
node dist/cli.js --figma-file-key abc123DEF --all-pages -p react -o out/all

# 渲染为 HTML 预览（不生成代码）
node dist/cli.js --figma-file-key abc123DEF --render --render-format html -o out/preview

# 通过 Figma 服务端导出节点为 PNG
node dist/cli.js --figma-file-key abc123DEF --figma-export-images \
    --figma-node-ids "1:2,3:4" --figma-export-format png --figma-export-scale 2 \
    -o out/images

# 导出为 SVG
node dist/cli.js --figma-file-key abc123DEF --figma-export-images \
    --figma-export-format svg -o out/svgs
```

### 作为库使用

```ts
import { FigmaApiClient, fetchFigmaFile, exportFigmaImages, extractFileKey } from 'd2c';

// 从 URL 提取 file key
const fileKey = extractFileKey('https://www.figma.com/design/abc123DEF/MyFile');

// 获取文件并解析为 IR
const result = await fetchFigmaFile({
  token: process.env.FIGMA_TOKEN!,
  fileKey: fileKey!,
});
console.log(result.ir.name, result.pages.length);

// 导出指定节点为图片
const images = await exportFigmaImages(
  { token: process.env.FIGMA_TOKEN!, fileKey: fileKey! },
  { nodeIds: ['1:2', '3:4'], format: 'png', scale: 2 },
);
console.log(`exported ${images.imageBuffers.size} image(s)`);
```

> **注意：** Figma REST API 仅支持**云端文件**。本地 `.fig` 二进制文件请使用
> `.fig` 渲染引擎（`--input design.fig`），二者互补、不冲突。

## `.fig` 高保真渲染引擎

d2c 支持**直接渲染 Figma 原生 `.fig` 二进制文件**为可视化的 SVG / HTML 预览。
区别于许多 `.fig → HTML` 转换器（会先降级到中间格式从而丢失视觉细节），d2c
的 `.fig` 渲染管线保留了 Figma 特有的视觉特性：

- **线性 / 径向 / 角度渐变** — 保留 `gradientStops` 与 `gradientHandlePositions`
- **旋转** — 从节点的 2×3 仿射矩阵（`m00/m01/m10/m11`）反推角度
- **四角独立圆角** — `rectangleCornerRadii: [tl, tr, br, bl]`
- **内阴影 / 投影 / 图层模糊 / 背景模糊** — `INNER_SHADOW`、`DROP_SHADOW`、
  `LAYER_BLUR`、`BACKGROUND_BLUR`
- **真实图片填充** — 从 `.fig` ZIP 内的 `images/` 目录抽取栅格资源并内联为
  data URI，而不是占位图
- **多页面 / 多画板** — 每个顶层 `FRAME` 渲染为独立 artboard（CRM 风格的多屏
  设计一键导出）
- **多填充 / 多描边 / 混合模式 / 每像素 opacity** — 逐项按栈序叠加

### 数据流

```
┌───────────────┐   ┌─────────────────────┐   ┌──────────────────┐   ┌──────────┐
│ design.fig    │──▶│ parseFigBinary()    │──▶│ buildFigRenderTree│──▶│ SVG +    │
│ (ZIP+fig-kiwi │   │ → FigDocument       │   │ → RenderDocument │   │ HTML     │
│  + images/)   │   │   (nodes + assets)  │   │                  │   │ preview  │
└───────────────┘   └─────────────────────┘   └──────────────────┘   └──────────┘
```

`.fig` 的解码链（ZIP → `canvas.fig` → fig-kiwi schema + message → 节点树）由
`src/parser/figBinaryParser.ts` 完成，依赖运行时可选装的 `fzstd`（用于 zstd
解压）和 `kiwi-schema`（用于 Kiwi 消息解码）。

### CLI 使用

```bash
# 交互式 HTML 预览（支持 pan / zoom，每个顶层 FRAME 一张画板）
node dist/cli.js --input examples/CRM.fig --render --render-format html \
    --out out/crm-preview

# 按画板导出独立 SVG 文件
node dist/cli.js --input examples/website.fig --render --render-format svg \
    --out out/website-svg

# 高清 2× 预览
node dist/cli.js --input examples/CRM.fig --render --render-scale 2 \
    --out out/crm-2x
```

`examples/CRM.fig`（多屏 CRM 设计）与 `examples/website.fig`（营销站）是内置
的两个真实 `.fig` 样例。

### 作为库使用

```ts
import * as fs from 'node:fs';
import { parseFigBinary } from 'd2c/parser/figBinaryParser';
import { renderFig } from 'd2c/renderer';

const figDoc = await parseFigBinary(fs.readFileSync('design.fig'));

// 一次性拿到 SVG Map + 独立 HTML 预览
const { svgs, html, renderDoc } = renderFig(figDoc, {
  scale: 1,
  perFrameArtboards: true, // 每个顶层 FRAME 渲染为独立 artboard（默认 true）
  includeHidden: false,
});

fs.writeFileSync('preview.html', html);
for (const [name, svg] of svgs) {
  fs.writeFileSync(`${name}.svg`, svg);
}
```

### `FigRenderOptions`

| 字段 | 默认 | 说明 |
|------|------|------|
| `scale` | `1` | 渲染缩放（影响 SVG viewBox 与像素尺寸） |
| `includeHidden` | `false` | 是否渲染 `visible: false` 的节点 |
| `perFrameArtboards` | `true` | 每个顶层 FRAME 一张 artboard；`false` 则每页合成一张 |
| `pageBackground` | `'#f5f5f5'` | HTML 预览页底色 |
| `showArtboardTitles` | `true` | HTML 预览中是否显示画板标题 |
| `maxPreviewWidth` | — | HTML 视口最大宽度 |

### 端到端：`.fig` → React 代码

直接复用通用流水线，`.fig` 也能生成代码（经 `FigDocument → IRDocument`）：

```bash
# 单帧 → React 组件
node dist/cli.js -i examples/website.fig -p react -o out/website

# 每个顶层 FRAME 分别导出为独立 React 组件（CRM 多屏场景）
node dist/cli.js -i examples/CRM.fig -p react -o out/crm --all-pages
```

## 阶段快照渲染与多模态比对

d2c 支持将流水线各阶段的中间结果**可视化**，并通过**多模态 LLM**自动比对
相邻阶段的渲染结果，分析信息增益与损失。

### 1. 阶段快照（Stage Snapshots）

使用 `--verify-dir` 可将每个流水线阶段的 IR / tokens / codegen 结果保存为 JSON：

```bash
node dist/cli.js -i design.json -p react -o out/react --verify-dir snapshots/
# → snapshots/parse.json, layout.json, semantics.json, tokens.json, codegen.json
```

### 2. 快照渲染（Snapshot Rendering）

每个阶段有一个专属渲染器，将 JSON 快照转为可视化 HTML/PNG：

| 阶段 | 渲染器 | 可视化内容 |
|------|--------|------------|
| parse | `parseRenderer` | 线框图——节点层级、尺寸标注 |
| layout | `layoutRenderer` | 布局标注——flex 方向、gap、对齐方式 |
| semantics | `semanticsRenderer` | 语义角色——按角色着色、aria 标签 |
| tokens | `tokensRenderer` | 设计令牌——色板、字体、间距一览 |
| codegen | `codegenRenderer` | 生成代码——语法高亮 + 实时预览 |

```bash
# 渲染为 HTML（无需 Playwright）
node dist/cli.js --render-snapshots snapshots/ --snapshot-format html --render-output out/

# 渲染为 PNG（需要 Playwright + Chromium）
node dist/cli.js --render-snapshots snapshots/ --snapshot-format png --render-output out/
```

### 3. 多模态比对分析（Vision Comparison）

通过 `--compare-stages` 启用多模态 LLM 比对。支持 **OpenRouter**（默认）和
**Anthropic** 两种视觉后端：

```bash
# OpenRouter（默认使用 gpt-4o）
OPENROUTER_API_KEY=sk-or-xxx node dist/cli.js --compare-stages --render-output img/ --compare-report report.md

# aliyun 默认qwen3.6-plus
node dist/cli.js --compare-stages --render-output out/png --vision-provider dashscope
```

比对引擎会：
- 按 parse → layout → semantics → tokens → codegen 顺序两两比较相邻阶段
- 额外进行首尾阶段（parse vs codegen）的总体评估
- 为每对输出 `visualDiff`、`infoGain`、`dataLoss`、`qualityScore`
- 生成 Markdown / HTML（含内嵌截图）/ JSON 格式的报告

### 作为库使用

```ts
import {
  VisionProvider,
  compareStages,
  reportToMarkdown,
  reportToHtml,
} from 'd2c';

const vision = new VisionProvider({
  backend: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const report = await compareStages(vision, './rendered-images/');
console.log(reportToMarkdown(report));
```

## Fidelity engineering — closing the five loss paths

设计稿 → 代码的还原度损失通常出现在五个固定的位置。d2c 针对每条损失路径都提供了对应的工程化手段：

| # | 损失路径 | 风险点 | 项目中的对策 |
|---|---------|--------|--------------|
| 1 | **IR 抽象降级** | Figma autolayout / constraints / variants / instances 在解析阶段被丢弃 | `IRNode.meta.figma` 保留 autoLayout / constraints / sizing (`FIXED`/`HUG`/`FILL`) / instance ↔ component / 四边描边 / `textAutoResize`；解析器原样转写，下游可读 |
| 2 | **布局启发式误差** | 规则引擎一旦判错，下游全部基于错误布局 | `Layout.confidence` (0-1) + `Layout.source` 标注每个容器的判定来源；混合重叠/绝对回退被打低分以便后续重判 |
| 3 | **LLM 用错位置** | 智能资源给了语义标注，最需要智能的布局推断却纯靠规则 | `refineLayoutWithLLM` 阶段：仅把 `confidence < threshold` 或 `absolute` 兜底的容器送给视觉/结构化模型重判，结果回写为 `source: llm-refined` |
| 4 | **无视觉反馈回路** | 一锤定音，pipeline 不会回头看原稿 | `runVisualFeedback`：`render → score → mark → refine` 定点迭代；区域分低于阈值的节点被打低 `confidence`，下一轮 refiner 自动捡回 |
| 5 | **CSS 映射粗糙** | token 与生成代码脱节，硬编码 hex/像素值 | `IRDocument.tokenSet` + `buildTokenLookup` 反查表；React 代码生成器优先输出 `bg-blue-500` / `gap-3` / `text-base` / `rounded-md`，独有值才回退到 arbitrary |

### 1. 启用 LLM 布局重判

```ts
import { runPipeline, type LayoutLLMProvider } from 'd2c';

const layoutRefiner: LayoutLLMProvider = {
  async refine(candidates) {
    // candidates: 含低 confidence 的容器 + 子节点 box；交给视觉/结构化模型
    return candidates.map((c) => ({
      nodeId: c.node.id,
      layout: { type: 'flex', direction: 'row', gap: 12, confidence: 0.9 },
    }));
  },
};

const result = await runPipeline(designJson, {
  platform: 'react',
  layoutRefiner,
  layoutRefineOptions: { threshold: 0.5, minChildren: 2 },
});
```

`buildRefinePayload(node)` 与 `DEFAULT_REFINE_PROMPT` 也在公共 API 中导出，
便于自定义 provider 复用同一份提示词格式。

### 2. 启用视觉反馈回路

```ts
import {
  runVisualFeedback,
  type VisualFeedbackRenderer,
  type VisualFeedbackScorer,
} from 'd2c';

const renderer: VisualFeedbackRenderer = {
  async render(doc) { /* Playwright 截图 / 任意你信得过的渲染器 */ },
};
const scorer: VisualFeedbackScorer = {
  async score(reference, candidate, doc) {
    // 复用 src/compare 模块（SSIM + ΔE 区域评分）
    // 返回 RegionScore[]
  },
};

const { ir, iterations } = await runVisualFeedback(
  initialIR, designPng, renderer, scorer, layoutRefiner,
  { fidelityThreshold: 0.7, maxIterations: 2 },
);
```

返回的 `iterations[]` 含每轮的 `meanFidelity` / `belowThreshold`，便于在 CI 中
观察迭代是否收敛。

### 3. 让设计 token 真正承载样式

```ts
const result = await runPipeline(designJson, { platform: 'react' });
// result.ir.tokenSet → 完整 TokenSet（colors / fontSizes / spacings / radii / shadows）
// 生成的 React 代码会优先引用 token 名，而非裸 hex / 像素值
```

> 没有 LLM Key、没有 Playwright 时，第 3、5 条仍然全程生效；第 1、2 条
> 是纯解析/规则改造，离线即可受益；第 3、4 条是可选注入点，按需启用。

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
      extraction. _Open: ZIP-level `.sketch` reader._
- [x] **P2**: Design tokens extraction (`style-dictionary` shape),
      IR diff + `// ai:ignore` protected regions, component library
      matching (antd / MUI).
- [x] **P3**: React Native + Flutter generators, responsive breakpoint
      inference (multi-viewport diff). _Open: SwiftUI generator._
- [x] **P4**: 阶段快照渲染器（parse / layout / semantics / tokens / codegen
      五个阶段各有专属可视化渲染器），Playwright 截图服务，批量渲染 CLI。
- [x] **P5**: 多模态阶段比对分析 — VisionProvider 支持 OpenRouter / Anthropic
      视觉后端，自动两两比较相邻阶段渲染结果并生成 Markdown / HTML / JSON 报告。
- [x] **P6**: `.fig` 高保真渲染引擎 — Figma 原生二进制文件直接渲染为 SVG / HTML
      预览，保留渐变、旋转、四角圆角、内阴影 / 模糊、真实图片填充、多画板。
- [x] **P7**: Figma REST API 集成 — 通过 Figma API 直接从云端获取设计文件，
      支持文件解析→代码生成、HTML/SVG 预览、服务端图片导出三种模式。
- [x] **P8**: 还原度工程化 — IR 保留源工具语义（`meta.figma`：autolayout/
      constraints/sizing/instance/component/strokeWeights/textAutoResize），
      布局推断输出 `confidence` + `source`，新增可注入的 `LayoutLLMProvider`
      只重判低置信容器，新增 `runVisualFeedback` 视觉反馈定点迭代，
      代码生成器接入 `tokenSet` 反查表自动用 `bg-blue-500` / `gap-3` 替换裸值。

## Directory layout

```
src/
├── ir/            # Intermediate representation types (incl. SourceMeta /
│                  # ExtendedTokenSet) & runtime validation
├── api/           # Figma REST API client + API renderer
├── parser/        # Figma REST + .fig binary + Figma Make + Sketch + native
│                  # parsers; figmaParser preserves autolayout/constraints/
│                  # instance/component metadata onto IRNode.meta
├── layout/        # Deterministic layout inference (with confidence + source)
│                  # + responsive merge + LayoutLLMProvider refiner
├── ai/            # Rule-based + optional LLM semantic enhancer +
│                  # antd/MUI component matching + VisionProvider
├── tokens/        # Design token extraction + Tailwind preset +
│                  # token resolver (reverse lookup for codegen)
├── diff/          # IR diff + ai:ignore protected region merge
├── codegen/       # React, Vue, HTML, React Native, Flutter generators
│                  # (React generator is token-aware)
├── renderer/      # High-fidelity .fig/Sketch/Make → SVG/HTML preview +
│                  # stage snapshot renderers + Playwright screenshot service
├── pipeline/      # End-to-end orchestration + verification +
│                  # multimodal stage comparison + visual feedback loop +
│                  # report generation
├── tests/         # node:test suite (no extra deps)
├── utils/         # Shared helpers (color, tree walking, case)
├── index.ts       # Library entry
└── cli.ts         # CLI entry
examples/
├── sample-design.json         # Native format example (UserCard, desktop)
├── sample-design-mobile.json  # Same UserCard at the sm breakpoint
├── figma-sample.json          # Figma REST API shape example
├── figma-make-sample.json     # Figma Make format example
├── sketch-sample.json         # Pre-extracted Sketch page JSON
├── CRM.fig                    # Real Figma binary — multi-screen CRM design
└── website.fig                # Real Figma binary — marketing site
snapshots/
├── parse.json                 # Stage snapshot examples
├── layout.json
├── semantics.json
├── tokens.json
└── codegen.json
doc/
├── opus4.6.md     # Original design doc (English / Chinese)
└── qwen3.6.md     # Alternate design doc
```

## License

MIT
