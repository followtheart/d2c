/**
 * Sketch Rendering Engine — Public API
 *
 * The rendering engine converts raw Sketch JSON into visual output:
 *
 *   1. buildRenderTree(sketchJson)     → RenderDocument (rich render tree)
 *   2. renderArtboardToSvg(artboard)   → SVG string (single artboard)
 *   3. renderDocumentToSvg(artboards)  → Map<name, SVG> (all artboards)
 *   4. renderToHtmlPreview(doc)        → standalone HTML with pan/zoom
 *   5. renderSketch(sketchJson, opts)  → { renderDoc, svgs, html } (one-shot)
 *
 * Usage:
 *   import { renderSketch } from 'd2c/renderer';
 *   const result = renderSketch(sketchJson, { scale: 2 });
 *   fs.writeFileSync('preview.html', result.html);
 */

export type {
  RenderNode,
  RenderNodeType,
  RenderDocument,
  RenderArtboard,
  RenderFrame,
  RenderFill,
  FillType,
  RenderBorder,
  BorderPosition,
  RenderShadow,
  RenderBlur,
  RenderGradient,
  GradientStop,
  RenderText,
  RenderTextRun,
  RenderTextStyle,
  SketchRenderOptions,
} from './types';

export { buildMakeRenderTree } from './makeRenderTree';
export type { MakeRenderOptions, MakeRenderResult } from './makeRenderTree';
export { renderMakeHtmlPreview } from './makeHtmlPreview';

export { buildFigRenderTree } from './figRenderTree';
export type { FigRenderOptions, FigRenderResult } from './figRenderTree';

// ── Snapshot stage renderers ────────────────────────────────────────
export type { SnapshotRenderer } from './snapshotRenderer';
export { parseRenderer } from './parseRenderer';
export { layoutRenderer } from './layoutRenderer';
export { semanticsRenderer } from './semanticsRenderer';
export { tokensRenderer } from './tokensRenderer';
export { codegenRenderer } from './codegenRenderer';
export { getSnapshotRenderer, snapshotRenderers } from './snapshotRendererMap';
export { captureScreenshot, captureScreenshots } from './screenshotService';
export type { ScreenshotOptions, ScreenshotJob } from './screenshotService';

export { buildRenderTree, extractPages } from './sketchRenderTree';
export { renderArtboardToSvg, renderDocumentToSvg } from './svgRenderer';
export { renderToHtmlPreview } from './htmlPreview';

import type { RenderDocument, SketchRenderOptions } from './types';
import { buildRenderTree, extractPages } from './sketchRenderTree';
import { renderArtboardToSvg, renderDocumentToSvg } from './svgRenderer';
import { renderToHtmlPreview } from './htmlPreview';
import { buildMakeRenderTree } from './makeRenderTree';
import type { MakeRenderOptions } from './makeRenderTree';
import { renderMakeHtmlPreview } from './makeHtmlPreview';
import type { MakeDocument } from '../parser/makeParser';
import { buildFigRenderTree } from './figRenderTree';
import type { FigRenderOptions } from './figRenderTree';
import type { FigDocument } from '../parser/figBinaryParser';

export interface SketchRenderResult {
  /** The parsed render tree */
  renderDoc: RenderDocument;
  /** SVG strings keyed by artboard name */
  svgs: Map<string, string>;
  /** Standalone HTML preview */
  html: string;
}

export interface SketchPageRenderResult {
  pageName: string;
  result: SketchRenderResult;
}

export interface SketchArtboardRenderResult {
  artboardName: string;
  result: SketchRenderResult;
}

/**
 * One-shot render: parse Sketch JSON → render tree → SVG + HTML preview.
 */
export function renderSketch(
  sketchJson: unknown,
  options?: SketchRenderOptions,
): SketchRenderResult {
  const renderDoc = buildRenderTree(sketchJson, options);
  const svgs = renderDocumentToSvg(renderDoc.artboards, options);
  const html = renderToHtmlPreview(renderDoc, options);
  return { renderDoc, svgs, html };
}

/**
 * Per-page render: split multi-page Sketch JSON and render each page separately.
 */
export function renderSketchPages(
  sketchJson: unknown,
  options?: SketchRenderOptions,
): SketchPageRenderResult[] {
  const pages = extractPages(sketchJson);
  return pages.map((page) => {
    const pageInput = { _class: 'page', name: page.name, layers: page.layers };
    const result = renderSketch(pageInput, options);
    return { pageName: page.name ?? 'Page', result };
  });
}

/**
 * Per-artboard render: every artboard gets its own standalone HTML preview.
 */
export function renderSketchArtboards(
  sketchJson: unknown,
  options?: SketchRenderOptions,
): SketchArtboardRenderResult[] {
  const fullDoc = buildRenderTree(sketchJson, options);
  return fullDoc.artboards.map((ab) => {
    const singleDoc: RenderDocument = { name: ab.name, artboards: [ab] };
    const svgs = renderDocumentToSvg([ab], options);
    const html = renderToHtmlPreview(singleDoc, options);
    return {
      artboardName: ab.name,
      result: { renderDoc: singleDoc, svgs, html },
    };
  });
}

/* ── Figma Make Renderer ─────────────────────────────────────────────── */

export interface MakeRenderFullResult {
  /** The parsed render tree */
  renderDoc: RenderDocument;
  /** SVG strings keyed by artboard name */
  svgs: Map<string, string>;
  /** Standalone HTML preview (design + code side-by-side) */
  html: string;
  /** Extracted code files from the .make project */
  codeFiles: { path: string; content: string; language: string }[];
}

/**
 * One-shot render: MakeDocument → render tree → SVG + HTML preview (with code).
 *
 * Usage:
 *   import { renderMake } from 'd2c/renderer';
 *   const result = renderMake(makeDoc);
 *   fs.writeFileSync('preview.html', result.html);
 */
export function renderMake(
  makeDoc: MakeDocument,
  options?: MakeRenderOptions,
): MakeRenderFullResult {
  const { renderDoc, codeFiles } = buildMakeRenderTree(makeDoc, options);
  const svgs = renderDocumentToSvg(renderDoc.artboards, options);
  const html = renderMakeHtmlPreview(renderDoc, codeFiles, options);
  return { renderDoc, svgs, html, codeFiles };
}

/* ── Figma (.fig) Renderer ───────────────────────────────────────────── */

export interface FigRenderFullResult {
  /** The built render tree (one artboard per top-level frame). */
  renderDoc: RenderDocument;
  /** SVG string per artboard, keyed by artboard name. */
  svgs: Map<string, string>;
  /** Interactive standalone HTML preview. */
  html: string;
}

/**
 * One-shot render: FigDocument → render tree → SVG + HTML preview.
 *
 * The FigDocument is expected to come from `parseFigBinary()`.  Image fills
 * are resolved against the document's embedded images map, so the preview
 * shows real raster assets rather than placeholders.
 *
 * Usage:
 *   import { parseFigBinary } from 'd2c/parser/figBinaryParser';
 *   import { renderFig } from 'd2c/renderer';
 *
 *   const figDoc = await parseFigBinary(fs.readFileSync('design.fig'));
 *   const { html, svgs } = renderFig(figDoc);
 *   fs.writeFileSync('preview.html', html);
 */
export function renderFig(
  figDoc: FigDocument,
  options?: FigRenderOptions,
): FigRenderFullResult {
  const { renderDoc } = buildFigRenderTree(figDoc, options);
  const svgs = renderDocumentToSvg(renderDoc.artboards, options);
  const html = renderToHtmlPreview(renderDoc, options);
  return { renderDoc, svgs, html };
}

export interface FigArtboardHtmlFile {
  /** File name ending in .html (unique, filesystem-safe). */
  fileName: string;
  /** Original artboard/frame name as it appears in Figma. */
  artboardName: string;
  /** Self-contained HTML body that embeds the SVG for this frame. */
  html: string;
  /** The raw SVG string (without the outer HTML shell). */
  svg: string;
}

function sanitizeFrameFileName(name: string): string {
  return (name || 'frame')
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fff -]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '') || 'frame';
}

function escHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Split-frames renderer: produces one standalone HTML file per top-level
 * FRAME/SECTION, each embedding the high-fidelity SVG used by the preview
 * flow. A shared top nav bar cross-links between frames.
 *
 * This is the fidelity-preserving counterpart to the `--split-frames`
 * codegen path: it bypasses semantic enhancement and emits pixel-faithful
 * output that matches `renderFig()`'s preview quality.
 */
export function renderFigArtboards(
  figDoc: FigDocument,
  options?: FigRenderOptions,
): FigArtboardHtmlFile[] {
  const { renderDoc } = buildFigRenderTree(figDoc, options);
  const scale = options?.scale ?? 1;

  const nameCounts = new Map<string, number>();
  const entries = renderDoc.artboards.map((ab) => {
    const base = sanitizeFrameFileName(ab.name);
    const count = (nameCounts.get(base) ?? 0) + 1;
    nameCounts.set(base, count);
    const fileName = count === 1 ? `${base}.html` : `${base}_${count}.html`;
    const svg = renderArtboardToSvg(ab, options);
    return { ab, fileName, svg };
  });

  const results: FigArtboardHtmlFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const { ab, fileName, svg } = entries[i];
    const w = Math.round(ab.frame.width * scale);
    const h = Math.round(ab.frame.height * scale);
    const nav = entries
      .map((e, j) =>
        j === i
          ? `      <span class="current">${escHtmlAttr(e.ab.name)}</span>`
          : `      <a href="${e.fileName}">${escHtmlAttr(e.ab.name)}</a>`,
      )
      .join('\n');
    const bg = ab.backgroundColor ?? '#ffffff';
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtmlAttr(ab.name)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #222; }
  .d2c-frame-nav { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: nowrap; gap: 12px; padding: 10px 16px; background: #ffffff; border-bottom: 1px solid #e4e4e4; overflow-x: auto; white-space: nowrap; font-size: 13px; }
  .d2c-frame-nav a { color: #0066cc; text-decoration: none; flex: 0 0 auto; }
  .d2c-frame-nav a:hover { text-decoration: underline; }
  .d2c-frame-nav .current { font-weight: 600; color: #222; flex: 0 0 auto; }
  .d2c-frame-stage { display: flex; justify-content: center; padding: 32px 16px; }
  .d2c-frame-canvas { width: ${w}px; height: ${h}px; background: ${bg}; box-shadow: 0 1px 4px rgba(0,0,0,0.1); overflow: hidden; }
  .d2c-frame-canvas > svg { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>
  <nav class="d2c-frame-nav">
${nav}
  </nav>
  <main class="d2c-frame-stage">
    <div class="d2c-frame-canvas">
      ${svg}
    </div>
  </main>
</body>
</html>
`;
    results.push({ fileName, artboardName: ab.name, html, svg });
  }
  return results;
}
