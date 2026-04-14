# Plan: 流水线阶段快照渲染与多模态比对

## TL;DR
为 d2c 流水线的 5 个快照阶段（parse / layout / semantics / tokens / codegen）各设计一种专用 HTML/SVG 可视化渲染器，通过 Playwright 截图后，调用多模态大模型对相邻阶段的渲染结果进行差异分析，输出结构化的阶段演变报告。

---

## Phase 1: 阶段渲染器设计与实现

### Step 1 — 公共渲染基础 `src/renderer/snapshotRenderer.ts`
- 定义 `SnapshotRenderer` 接口：`render(snapshot: StageSnapshot): string`（返回 standalone HTML string）
- 公共工具函数：`boxToCSS(box)`, `colorString(style)`, `nodeLabelHtml(node)`
- 统一 HTML 模板：viewport 视口、缩放、标题栏、图例区

### Step 2 — parse 渲染器 `src/renderer/parseRenderer.ts`
- **目的**：展示原始几何结构（盒模型 + 嵌套层级）
- **方案**：将 IRNode 树递归转为 absolutely-positioned `<div>` 线框图
  - 每个节点绘制边框 + 节点名称标签（`node.name`）
  - 按节点 type 着色边框：container=蓝, text=绿, image=橙, icon=紫, button=红 等
  - text 节点内显示实际文案
  - 标注关键数值：width×height
- **输入**：`snapshot.ir`（IRDocument）
- **输出**：HTML string

### Step 3 — layout 渲染器 `src/renderer/layoutRenderer.ts`
- **目的**：可视化布局推断结果（flex/grid/absolute 分布）
- **方案**：基于 parse 渲染器扩展
  - 在每个容器上叠加布局类型标签（flex→方向箭头, grid→网格线, absolute→坐标轴标记）
  - flex 容器用虚线箭头标注 direction + justifyContent + alignItems
  - grid 容器用网格线叠加
  - gap 值用间距标注线显示
  - 底部统计面板：flex / grid / absolute 各多少个节点
- **输入**：`snapshot.ir`
- **输出**：HTML string

### Step 4 — semantics 渲染器 `src/renderer/semanticsRenderer.ts`
- **目的**：可视化语义增强结果（角色分配、组件命名）
- **方案**：在 layout 渲染器基础上
  - 按 `semantics.role` 分色填充半透明背景（header=蓝, nav=绿, card=黄, button=红, list=紫 等）
  - 角色标签 badge 显示在节点左上角
  - `componentName` 显示在节点右上角
  - `interactive` 节点加闪烁/虚线边框
  - `ariaLabel` 以 tooltip 显示
  - 右侧面板：语义角色分布饼图（纯 CSS/SVG）
- **输入**：`snapshot.ir`
- **输出**：HTML string

### Step 5 — tokens 渲染器 `src/renderer/tokensRenderer.ts`
- **目的**：可视化提取出的设计令牌
- **方案**：类似设计规范展示页
  - **颜色区**：色块网格，每个色块显示 hex/rgba 值 + 使用频次
  - **字体区**：各字号/字重的示例文本行
  - **间距区**：间距条形图（不同 gap/padding/margin 值的可视化）
  - **圆角区**：不同 borderRadius 值的示例矩形
  - **阴影区**：不同 shadow 值的示例卡片
- **输入**：`snapshot.tokens`（TokenSet）
- **输出**：HTML string

### Step 6 — codegen 渲染器 `src/renderer/codegenRenderer.ts`
- **目的**：预览生成代码的可视效果
- **方案**：
  - 对 HTML 平台：直接渲染 index.html + styles.css 为 iframe
  - 对 React/Vue 平台：提取 JSX/template 中的结构，转为静态 HTML 预览
  - 左侧代码面板（语法高亮 via CSS）+ 右侧可视预览
  - 文件列表 + 文件大小指标
- **输入**：`snapshot.generated`（GenerateResult）
- **输出**：HTML string

---

## Phase 2: 截图与批量渲染

### Step 7 — 截图服务 `src/renderer/screenshotService.ts`
- 引入 `playwright`（dev dependency）或 `puppeteer`
- 函数 `captureScreenshot(html: string, outputPath: string, opts?: { width, height, deviceScaleFactor }): Promise<void>`
- 创建 headless browser → 加载 HTML string → 等待渲染 → 截图为 PNG
- 支持可配置视口尺寸（默认 1280×960）

### Step 8 — 批量渲染命令 `src/cli.ts` 扩展
- 新增 CLI flag：`--render-snapshots <snapshotDir>` + `--render-output <imageDir>`
- 流程：遍历 snapshotDir 中的 JSON → 匹配渲染器 → 生成 HTML → 截图 → 保存 PNG
- 输出文件命名：`<stage>.png`（如 `parse.png`, `layout.png` 等）
- 可选 `--render-format svg|png|html`（默认 png）
- 也支持仅输出 HTML（无需 Playwright）：`--render-format html`

---

## Phase 3: 多模态比对分析

### Step 9 — 多模态 Provider 扩展 `src/ai/visionProvider.ts`
- 新建 VisionProvider，复用 ClaudeProvider 的 API 调用结构
- 扩展 Anthropic Messages API 的 `content` 数组支持 `image` block：
  ```
  { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
  ```
- 同时支持 NodeLlmProvider 的多模态路径（如 GPT-4o、Gemini 等均支持 vision）
- 函数签名：`analyzeImages(images: { stage: string, data: Buffer }[], prompt: string): Promise<StageAnalysis>`

### Step 10 — 差异分析引擎 `src/pipeline/stageCompare.ts`
- 函数 `compareStages(snapshotDir: string, imageDir: string): Promise<ComparisonReport>`
- 流程：
  1. 加载所有阶段截图（parse → layout → semantics → tokens → codegen）
  2. 对相邻阶段两两配对：(parse,layout), (layout,semantics), (semantics,tokens), (tokens,codegen)
  3. 每对调用 VisionProvider，prompt 包含：
     - 两张图片
     - 阶段名称和阶段说明
     - 要求分析：a) 视觉差异描述 b) 信息增量分析 c) 数据丢失/畸变检测 d) 质量评分(1-10)
  4. 可选：除相邻比对，还生成 parse vs codegen 的全程对比
- 输出 `ComparisonReport` 结构：
  ```typescript
  interface ComparisonReport {
    pairs: PairAnalysis[];
    overall: OverallAnalysis;
  }
  interface PairAnalysis {
    from: string; to: string;
    visualDiff: string;
    infoGain: string;
    dataLoss: string;
    qualityScore: number;
  }
  ```

### Step 11 — CLI 集成
- 新增 CLI flag：`--compare-stages`
- 完整流程：`d2c -i design.json -p react --verify-dir snapshots/ --render-snapshots snapshots/ --render-output images/ --compare-stages`
- 或拆分为独立命令：`d2c compare --snapshot-dir snapshots/ --image-dir images/ -o report.json`
- 输出格式：JSON + 人类可读的 Markdown 报告

### Step 12 — 报告生成 `src/pipeline/compareReport.ts`
- 将 ComparisonReport 转为 Markdown 格式
- 包含：各阶段渲染缩略图引用 + 差异分析文本 + 质量评分表格 + 总体评估
- 可选生成 HTML 报告（含内联图片）

---

## Relevant Files

**新增文件：**
- `src/renderer/snapshotRenderer.ts` — 公共渲染接口与工具函数
- `src/renderer/parseRenderer.ts` — parse 阶段线框渲染器
- `src/renderer/layoutRenderer.ts` — layout 阶段布局可视化
- `src/renderer/semanticsRenderer.ts` — semantics 阶段语义角色可视化
- `src/renderer/tokensRenderer.ts` — tokens 阶段设计令牌展示
- `src/renderer/codegenRenderer.ts` — codegen 阶段代码预览
- `src/renderer/screenshotService.ts` — Playwright 截图服务
- `src/ai/visionProvider.ts` — 多模态 LLM 图片分析 Provider
- `src/pipeline/stageCompare.ts` — 阶段比对引擎
- `src/pipeline/compareReport.ts` — 比对报告生成
- `src/tests/snapshotRenderer.test.ts` — 渲染器单元测试
- `src/tests/stageCompare.test.ts` — 比对逻辑测试

**修改文件：**
- `src/cli.ts` — 新增 `--render-snapshots`、`--render-output`、`--compare-stages` 参数
- `src/index.ts` — 导出新增模块的公共 API
- `src/ai/nodeLlmProvider.ts` — 扩展支持多模态消息（添加 image content block）
- `src/ai/claudeProvider.ts` — 扩展支持 vision（添加 image content block）
- `package.json` — 添加 playwright 为 optionalDependencies
- `src/renderer/index.ts` — 导出新渲染器

**参考文件（不修改，仅参考实现模式）：**
- `src/renderer/htmlPreview.ts` — 参考 `renderToHtmlPreview()` 的 standalone HTML 生成模式
- `src/renderer/svgRenderer.ts` — 参考 `renderNode()` 的 SVG 节点渲染逻辑
- `src/pipeline/verify.ts` — 参考 `snapshotToJSON()` 的快照序列化 + `verifyXxx()` 函数签名模式
- `src/ir/types.ts` — IRNode / Box / Layout / Semantics / TokenSet 类型定义
- `src/codegen/html.ts` — 参考 `HtmlGenerator.nodeToHtml()` 的 IR→HTML 转换

---

## Verification

1. **单元测试**：用 snapshots/ 下现有 JSON 文件作为输入，验证各渲染器输出合法 HTML（`assert.ok(html.includes('<html'))` 等）
2. **渲染测试**：`--render-format html` 模式生成 HTML 文件，手动浏览器打开检查
3. **截图测试**：用 Playwright 截图验证 PNG 文件生成且尺寸 > 0
4. **比对测试**：mock VisionProvider 返回固定分析结果，验证 ComparisonReport 结构完整
5. **E2E 测试**：完整流程——`d2c -i examples/sample-design.json -p html --verify-dir tmp/snap --render-snapshots tmp/snap --render-output tmp/img --compare-stages`，验证 report.json 生成

---

## Decisions

- **渲染方案**：使用纯 HTML+CSS（非 Canvas）生成渲染结果，避免引入重依赖，且便于调试
- **截图工具**：Playwright 作为 `optionalDependencies`，`--render-format html` 不需要安装它
- **多模态模型**：扩展现有 ClaudeProvider + NodeLlmProvider，复用用户已配置的 API key；Claude 支持 vision（claude-opus-4-6）、GPT-4o 和 Gemini 也支持
- **比对策略**：相邻阶段两两比较 + parse-vs-codegen 全程对比（共 5 对）
- **tokens 阶段**：tokens 截图与其他阶段的 IR 树截图视觉差异很大（令牌展示 vs 布局图），比对时需在 prompt 中说明这是不同性质的可视化
- **scope 限制**：componentMatch / responsive / protectedMerge 为可选阶段，如果快照中存在则也渲染，不存在则跳过

## Further Considerations

1. **渲染器的递进关系**：parse → layout → semantics 三个渲染器逐层叠加信息（线框→布局标注→语义着色），还是各自独立渲染？建议递进叠加，这样更直观体现每个阶段的"增量"。
2. **并发截图**：5 个阶段的截图可以并行执行，以提高效率。Playwright 支持多 page 并行。
3. **离线模式**：如果用户没有配置 LLM API key，`--compare-stages` 应该报错退出并提示配置，还是仅输出截图不做分析？建议报错提示。
