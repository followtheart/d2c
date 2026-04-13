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

export { buildRenderTree } from './sketchRenderTree';
export { renderArtboardToSvg, renderDocumentToSvg } from './svgRenderer';
export { renderToHtmlPreview } from './htmlPreview';

import type { RenderDocument, SketchRenderOptions } from './types';
import { buildRenderTree } from './sketchRenderTree';
import { renderArtboardToSvg, renderDocumentToSvg } from './svgRenderer';
import { renderToHtmlPreview } from './htmlPreview';

export interface SketchRenderResult {
  /** The parsed render tree */
  renderDoc: RenderDocument;
  /** SVG strings keyed by artboard name */
  svgs: Map<string, string>;
  /** Standalone HTML preview */
  html: string;
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
