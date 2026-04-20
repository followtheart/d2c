/**
 * Figma API Renderer
 *
 * Fetches a Figma file via the REST API, parses it through the existing
 * Figma parser (figmaParser.ts), and produces rendered output.
 *
 * Two rendering paths:
 *
 * 1. **Server-side render** — Fetches the file JSON via GET /v1/files/:key,
 *    parses to IR, then runs through the d2c codegen pipeline.
 *
 * 2. **Image export render** — Uses GET /v1/images/:key to get Figma's own
 *    server-side rendering of specific nodes as PNG/SVG, then assembles
 *    an HTML preview from those images.
 *
 * Both modes resolve image fills (user-supplied images) via the
 * GET /v1/files/:key/images endpoint.
 */
import {
  FigmaApiClient,
  extractFileKey,
  collectImageRefs,
  type FigmaApiConfig,
  type FigmaFileResponse,
  type FigmaNode,
  type ImageFormat,
} from './figmaApi';
import { parseFigma, parseFigmaMultiPage } from '../parser/figmaParser';
import type { IRDocument } from '../ir/types';
import type { FigDocument, FigNode, FigPage, FigPaint, FigEffect, FigImageAsset } from '../parser/figBinaryParser';

// ── Types ────────────────────────────────────────────────────────────

export interface FigmaApiRenderConfig extends FigmaApiConfig {
  // Figma file key or URL
  fileKey: string;
  // Specific node IDs to render (comma-separated)
  nodeIds?: string;
  // Specific version to fetch
  version?: string;
}

export interface FigmaApiFetchResult {
  // Raw Figma API response
  fileResponse: FigmaFileResponse;
  // Parsed IR document (first page)
  ir: IRDocument;
  // Parsed IR documents (all pages)
  pages: IRDocument[];
  // Resolved image fills: imageRef → data URI
  imageFills: Map<string, string>;
}

export interface FigmaApiImageExportOptions {
  // Node IDs to render (defaults to top-level frame IDs)
  nodeIds?: string[];
  // Export format
  format?: ImageFormat;
  // Scale factor 0.01–4
  scale?: number;
  // Use absolute bounds (useful for text)
  useAbsoluteBounds?: boolean;
}

export interface FigmaApiImageExportResult {
  // Map of node ID → image URL (from Figma servers, expires in 30 days)
  imageUrls: Map<string, string>;
  // Map of node ID → downloaded image Buffer
  imageBuffers: Map<string, Buffer>;
  // Assembled HTML preview
  html: string;
}

// ── Main API Renderer ────────────────────────────────────────────────

/**
 * Fetch a Figma file via the REST API and parse it into IR documents.
 *
 * This is the core function that bridges the Figma REST API with the
 * existing d2c parser. It:
 *   1. Calls GET /v1/files/:key to get the file JSON
 *   2. Parses the response with parseFigma / parseFigmaMultiPage
 *   3. Resolves image fills via GET /v1/files/:key/images
 */
export async function fetchFigmaFile(
  config: FigmaApiRenderConfig,
  onProgress?: (msg: string) => void,
): Promise<FigmaApiFetchResult> {
  const client = new FigmaApiClient(config);
  const fileKey = extractFileKey(config.fileKey);

  onProgress?.(`Fetching Figma file ${fileKey}…`);
  const fileResponse = await client.getFile(fileKey, {
    version: config.version,
    ids: config.nodeIds,
    geometry: 'paths',
  });
  onProgress?.(`Received file "${fileResponse.name}" (v${fileResponse.version})`);

  // Parse to IR
  const ir = parseFigma(fileResponse);
  const pages = parseFigmaMultiPage(fileResponse);
  onProgress?.(`Parsed ${pages.length} page(s)`);

  // Resolve image fills
  const imageRefs = collectImageRefs(fileResponse.document);
  const imageFills = new Map<string, string>();

  if (imageRefs.size > 0) {
    onProgress?.(`Resolving ${imageRefs.size} image fill(s)…`);
    const fillURLs = await client.getImageFills(fileKey);
    const imageMap = fillURLs.meta?.images ?? fillURLs.images ?? {};
    for (const ref of imageRefs) {
      const url = imageMap[ref];
      if (url) {
        try {
          const buf = await client.downloadImage(url);
          const ext = url.includes('.png') ? 'png' : url.includes('.svg') ? 'svg+xml' : 'jpeg';
          const dataUri = `data:image/${ext};base64,${buf.toString('base64')}`;
          imageFills.set(ref, dataUri);
        } catch {
          onProgress?.(`  Warning: failed to download image fill ${ref}`);
        }
      }
    }
    onProgress?.(`Resolved ${imageFills.size}/${imageRefs.size} image fill(s)`);
  }

  return { fileResponse, ir, pages, imageFills };
}

// ── Figma API → FigDocument converter ────────────────────────────────

/**
 * Convert a Figma REST API response + resolved image fills into a
 * FigDocument that can be passed to `renderFig()`.
 */
export function toFigDocument(
  fileResponse: FigmaFileResponse,
  imageFills: Map<string, string>,
): FigDocument {
  const doc = fileResponse.document;
  const pages: FigPage[] = [];

  for (const child of doc.children ?? []) {
    if (child.type === 'CANVAS') {
      pages.push({
        id: child.id,
        name: child.name,
        children: (child.children ?? []).map(c => convertNode(c)),
      });
    }
  }

  // Build images map from resolved data URIs
  const images = new Map<string, FigImageAsset>();
  for (const [ref, dataUri] of imageFills) {
    const match = dataUri.match(/^data:image\/([^;]+);base64,(.+)$/);
    if (match) {
      const mime = `image/${match[1]}`;
      const data = Buffer.from(match[2], 'base64');
      images.set(ref, { hash: ref, data, mime });
    }
  }

  // Compute bounding box across all pages
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const page of pages) {
    for (const node of page.children) {
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x + node.width > maxX) maxX = node.x + node.width;
      if (node.y + node.height > maxY) maxY = node.y + node.height;
    }
  }

  return {
    name: fileResponse.name,
    pages,
    width: maxX === -Infinity ? 0 : maxX - minX,
    height: maxY === -Infinity ? 0 : maxY - minY,
    images,
  };
}

function convertNode(apiNode: FigmaNode, parentX = 0, parentY = 0): FigNode {
  const bb = apiNode.absoluteBoundingBox;
  const style = apiNode.style as Record<string, unknown> | undefined;

  // 子节点坐标需要相对于父节点，absoluteBoundingBox 是画布绝对坐标
  const absX = bb?.x ?? 0;
  const absY = bb?.y ?? 0;

  const node: FigNode = {
    id: apiNode.id,
    type: apiNode.type,
    name: apiNode.name,
    visible: apiNode.visible,
    x: absX - parentX,
    y: absY - parentY,
    width: bb?.width ?? 0,
    height: bb?.height ?? 0,
    fills: apiNode.fills?.map(convertPaint),
    strokes: apiNode.strokes?.map(convertPaint),
    strokeWeight: apiNode.strokeWeight as number | undefined,
    strokeAlign: apiNode.strokeAlign as FigNode['strokeAlign'],
    cornerRadius: apiNode.cornerRadius,
    rectangleCornerRadii: apiNode.rectangleCornerRadii,
    opacity: apiNode.opacity,
    blendMode: apiNode.blendMode as string | undefined,
    clipsContent: apiNode.clipsContent as boolean | undefined,
    characters: apiNode.characters,
    fontSize: style?.fontSize as number | undefined ?? apiNode.fontSize as number | undefined,
    fontFamily: style?.fontFamily as string | undefined ?? apiNode.fontFamily as string | undefined,
    fontWeight: style?.fontWeight as number | undefined ?? apiNode.fontWeight as number | undefined,
    italic: style?.italic as boolean | undefined,
    textAlignHorizontal: style?.textAlignHorizontal as string | undefined ?? apiNode.textAlignHorizontal as string | undefined,
    textAlignVertical: style?.textAlignVertical as string | undefined ?? apiNode.textAlignVertical as string | undefined,
    lineHeightPx: style?.lineHeightPx as number | undefined ?? apiNode.lineHeightPx as number | undefined,
    letterSpacing: style?.letterSpacing as number | undefined ?? apiNode.letterSpacing as number | undefined,
    layoutMode: apiNode.layoutMode,
    primaryAxisAlignItems: apiNode.primaryAxisAlignItems,
    counterAxisAlignItems: apiNode.counterAxisAlignItems,
    itemSpacing: apiNode.itemSpacing,
    paddingLeft: apiNode.paddingLeft,
    paddingRight: apiNode.paddingRight,
    paddingTop: apiNode.paddingTop,
    paddingBottom: apiNode.paddingBottom,
    effects: apiNode.effects?.map(convertEffect),
    children: apiNode.children?.map(c => convertNode(c, absX, absY)),
  };

  return node;
}

function convertPaint(p: { type: string; visible?: boolean; color?: { r: number; g: number; b: number; a?: number }; opacity?: number; imageRef?: string; gradientStops?: unknown[]; gradientHandlePositions?: unknown[] }): FigPaint {
  return {
    type: p.type,
    visible: p.visible,
    color: p.color ? { r: p.color.r, g: p.color.g, b: p.color.b, a: p.color.a } : undefined,
    opacity: p.opacity,
    imageRef: p.imageRef,
    gradientStops: p.gradientStops as FigPaint['gradientStops'],
    gradientHandlePositions: p.gradientHandlePositions as FigPaint['gradientHandlePositions'],
  };
}

function convertEffect(e: { type: string; visible?: boolean; radius?: number; offset?: { x: number; y: number }; color?: { r: number; g: number; b: number; a?: number }; spread?: number }): FigEffect {
  return {
    type: e.type,
    visible: e.visible,
    radius: e.radius,
    offset: e.offset,
    color: e.color ? { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a } : undefined,
    spread: e.spread,
  };
}

/**
 * Export specific nodes from a Figma file as rendered images.
 *
 * Uses GET /v1/images/:key to ask Figma's servers to render the nodes,
 * then downloads the resulting images and assembles an HTML preview.
 */
export async function exportFigmaImages(
  config: FigmaApiRenderConfig,
  options?: FigmaApiImageExportOptions,
  onProgress?: (msg: string) => void,
): Promise<FigmaApiImageExportResult> {
  const client = new FigmaApiClient(config);
  const fileKey = extractFileKey(config.fileKey);
  const format = options?.format ?? 'png';
  const scale = options?.scale ?? 2;

  // Determine which nodes to export
  let nodeIds = options?.nodeIds;
  if (!nodeIds || nodeIds.length === 0) {
    onProgress?.('No node IDs specified, fetching file to find top-level frames…');
    const file = await client.getFile(fileKey, { depth: 2, version: config.version });
    nodeIds = collectTopLevelFrameIds(file.document);
    onProgress?.(`Found ${nodeIds.length} top-level frame(s)`);
  }

  if (nodeIds.length === 0) {
    throw new Error('No renderable nodes found in the Figma file');
  }

  onProgress?.(`Requesting ${format.toUpperCase()} export of ${nodeIds.length} node(s) at ${scale}x…`);
  const imgResponse = await client.getImage(fileKey, {
    ids: nodeIds.join(','),
    format,
    scale,
    useAbsoluteBounds: options?.useAbsoluteBounds,
    version: config.version,
  });

  if (imgResponse.err) {
    throw new Error(`Figma image export error: ${imgResponse.err}`);
  }

  // Download all images
  const imageUrls = new Map<string, string>();
  const imageBuffers = new Map<string, Buffer>();

  for (const [nodeId, url] of Object.entries(imgResponse.images)) {
    if (!url) {
      onProgress?.(`  Warning: node ${nodeId} returned null (not renderable)`);
      continue;
    }
    imageUrls.set(nodeId, url);
    try {
      const buf = await client.downloadImage(url);
      imageBuffers.set(nodeId, buf);
      onProgress?.(`  Downloaded ${nodeId} (${(buf.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      onProgress?.(`  Warning: failed to download image for node ${nodeId}`);
    }
  }

  // Assemble HTML preview
  const html = buildImageExportHtml(imageBuffers, format, fileKey);

  return { imageUrls, imageBuffers, html };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Collect IDs of top-level frames (children of CANVAS pages).
 */
function collectTopLevelFrameIds(doc: FigmaNode): string[] {
  const ids: string[] = [];
  for (const page of doc.children ?? []) {
    if (page.type === 'CANVAS') {
      for (const child of page.children ?? []) {
        if (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'COMPONENT_SET') {
          ids.push(child.id);
        }
      }
    }
  }
  return ids;
}

/**
 * Build a standalone HTML preview from exported images.
 */
function buildImageExportHtml(
  imageBuffers: Map<string, Buffer>,
  format: ImageFormat,
  fileKey: string,
): string {
  const mimeType = format === 'svg' ? 'image/svg+xml' : format === 'pdf' ? 'application/pdf' : `image/${format}`;

  const images = Array.from(imageBuffers.entries()).map(([nodeId, buf]) => {
    const dataUri = `data:${mimeType};base64,${buf.toString('base64')}`;
    return { nodeId, dataUri };
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Figma Export — ${escapeHtml(fileKey)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px;
      gap: 32px;
    }
    h1 { font-size: 18px; font-weight: 500; opacity: 0.7; }
    .frame-card {
      background: #fff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
      max-width: 100%;
    }
    .frame-card img {
      display: block;
      max-width: 100%;
      height: auto;
    }
    .frame-label {
      padding: 8px 12px;
      font-size: 12px;
      color: #666;
      background: #f8f8f8;
      border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <h1>Figma API Export — ${escapeHtml(fileKey)}</h1>
  ${images
    .map(
      (img) => `
  <div class="frame-card">
    <img src="${img.dataUri}" alt="Node ${escapeHtml(img.nodeId)}">
    <div class="frame-label">Node: ${escapeHtml(img.nodeId)}</div>
  </div>`,
    )
    .join('\n')}
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
