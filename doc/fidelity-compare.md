# D2C Figma Fidelity Compare

A ground-truth-anchored, multi-dimensional evaluation of how well the
codegen output matches the original Figma design — replacing the old
`parse → codegen` wireframe-vs-rendered-HTML overall score that was
systematically depressed by the medium mismatch.

## Problem

The legacy pipeline renders each stage snapshot for visual diff:

| Stage | Visualization |
|-------|---------------|
| parse | wireframe with node labels |
| layout | wireframe + layout badges |
| semantics | wireframe + role overlay |
| tokens | style-guide swatch view |
| codegen | real HTML in iframe |

The overall score used to compare `parse.png` vs `codegen.png`.
These two images live in different visual media (wireframe vs
styled render), so the vision LLM consistently penalized "data
loss" for what was really a rendering-form change. Adjacent
pair scores stayed high (8–9/10), but overall collapsed to 2/10.

## Solution

Anchor overall fidelity to the **real design rendering** (Figma
image export or equivalent) vs the **real codegen rendering**
(Playwright screenshot of generated HTML). Both sit in the same
raster medium, so pixel-level comparison is meaningful.

Score across six orthogonal dimensions:

| # | Dimension | What it measures | Method |
|---|-----------|------------------|--------|
| 1 | **perceptual** | Overall shape similarity | MS-SSIM + pHash |
| 2 | **color** | Fill / border / shadow colors | CIEDE2000 (ΔE₀₀) |
| 3 | **edge** | Borders, dividers, icon shapes | Sobel edge IoU |
| 4 | **region** | Per-node fidelity | IR bbox crop → SSIM + ΔE |
| 5 | **text** | Content & typography | String + CSS presence match |
| 6 | **llm** | Semantic perceptual audit | 6-dim vision LLM prompt |

Each dimension is a deterministic 0..1 value (except `llm`).
Missing dimensions have their weight redistributed.

Composite:

```
overall = 10 × Σ(weight_i × value_i)  (normalized over available i)

default weights
  perceptual 0.25
  color      0.15
  edge       0.10
  region     0.25
  text       0.10
  llm        0.15
```

## Usage

### Prerequisites

```bash
npm install pngjs      # required for all pixel dimensions
npm install playwright # required to capture the codegen screenshot
```

### End-to-end example

```bash
# 1. Run the d2c pipeline with verification + render snapshots to PNG
d2c -i design.fig --verify-dir out/snap \
    --render-snapshots out/snap --render-output out/png -p html -o out/code

# 2. Export the Figma frame as PNG (or pull via Figma REST API)
#    …save it to figma.png

# 3. Run the fidelity compare
d2c --compare-fidelity \
    --reference-image figma.png \
    --candidate-image out/png/codegen.png \
    --fidelity-ir out/snap/parse.json \
    --fidelity-codegen out/snap/codegen.json \
    --fidelity-diagnostics-dir out/fidelity \
    --fidelity-report out/fidelity/report.md

# Optional — add the LLM layer
OPENROUTER_API_KEY=... d2c --compare-fidelity \
    --reference-image figma.png \
    --candidate-image out/png/codegen.png \
    --fidelity-ir out/snap/parse.json \
    --fidelity-use-llm \
    --fidelity-diagnostics-dir out/fidelity \
    --fidelity-report out/fidelity/report.html
```

### Output

```
out/fidelity/
├── diff_heatmap.png          ΔE₀₀ heatmap (red = large color drift)
├── reference_aligned.png     Resized reference rendering
├── candidate_aligned.png     Resized candidate rendering
└── report.md (or .html / .json)
```

## Programmatic API

```ts
import { runFigmaFidelity, writeReport } from 'd2c/compare';

const report = await runFigmaFidelity({
  referencePath: 'figma.png',
  candidatePath: 'codegen.png',
  ir: loadedIR,              // optional — enables region + text
  generated: loadedGenerated, // optional — enables text layer
  vision,                    // optional — enables LLM layer
  writeDiagnostics: true,
  outputDir: 'out/fidelity',
  onProgress: (m) => console.error(m),
});

console.log(report.overall); // 0..10
console.log(report.weakestDimension);
writeReport(report, 'report.md');
```

## Graceful degradation

| Missing input | What still runs |
|---------------|-----------------|
| `pngjs` | Only **text** layer (structural string match) |
| `ir` | All pixel layers + text layer |
| `generated` | All pixel layers + region layer |
| `vision` | All deterministic layers |
| `playwright` | Skip screenshot capture; pass `--candidate-image` manually |

Warnings are recorded on the report and in stderr.

## Why it's scientifically sounder

1. **Same-medium comparison** — both inputs are raster renderings of
   the same frame at the same scale.
2. **Multi-granularity** — global SSIM/ΔE catches big drift; region
   metrics pinpoint offenders; text layer catches codegen text
   regressions.
3. **Determinism ≥ 60%** — only the `llm` dimension is stochastic;
   the others are reproducible math.
4. **Diagnostic** — output includes a pixel heatmap and a sorted list
   of worst-scoring regions, not just a bare number.
5. **Fail-soft** — each layer can be skipped independently without
   poisoning other dimensions; weights are renormalized automatically.

## Limitations

- Playwright webfont rendering differs slightly from Figma's native
  font rasterizer. The text layer sidesteps this by comparing content
  and CSS rather than pixels; pixel layers tolerate some drift
  (SSIM window + ΔE threshold).
- Region layer uses parent-relative IR bboxes, accumulated at walk
  time. If the codegen reflows the layout (e.g., auto-grid at a
  different viewport) regions may mismatch; run with matching
  viewport widths.
- No OCR. Dropped characters are caught by text-layer string
  search, not by comparing rendered pixels of the text.
