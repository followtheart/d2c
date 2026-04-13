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
