/**
 * Figma (.fig) → Render Tree Converter
 *
 * Builds a RenderDocument from a decoded FigDocument, preserving every
 * Figma-specific visual detail needed for faithful SVG / HTML rendering:
 *
 *   - Solid and gradient fills (linear / radial / angular)
 *   - Real image fills (resolved to data URIs from the .fig ZIP's images/ entries)
 *   - Rotation (from the node's affine transform matrix)
 *   - Per-corner border radii
 *   - Drop shadow, inner shadow, layer blur, background blur
 *   - Multiple fills / multiple strokes per layer, with per-fill opacity
 *   - Auto-layout (stackMode) and legacy absolute positioning
 *   - Multi-page documents: each top-level FRAME becomes its own artboard
 *
 * This is the direct counterpart to sketchRenderTree.ts for Sketch files and
 * makeRenderTree.ts for Figma Make files.  It replaces the prior lossy path
 * which coerced .fig data into the MakeDocument shape.
 */

import type {
  RenderNode,
  RenderNodeType,
  RenderDocument,
  RenderArtboard,
  RenderFill,
  RenderBorder,
  RenderShadow,
  RenderBlur,
  RenderGradient,
  GradientStop,
  RenderText,
  RenderTextRun,
  RenderTextStyle,
  SketchRenderOptions,
} from './types';
import type {
  FigDocument,
  FigPage,
  FigNode,
  FigPaint,
  FigEffect,
  FigColor,
  FigImageAsset,
  FigGradientStop,
} from '../parser/figBinaryParser';
import { rgbaToCss } from '../utils/color';

/* ── Options ─────────────────────────────────────────────────────────── */

export interface FigRenderOptions extends SketchRenderOptions {
  /**
   * One artboard per top-level FRAME (Figma-style).  If false, each page
   * (CANVAS) becomes a single artboard containing all its children.
   * Default: true.
   */
  perFrameArtboards?: boolean;
}

function isPreviewArtboardNode(node: FigNode): boolean {
  return node.type === 'FRAME' || node.type === 'SECTION';
}

export interface FigRenderResult {
  renderDoc: RenderDocument;
}

/* ── Node Type Mapping ───────────────────────────────────────────────── */

function mapRenderType(node: FigNode): RenderNodeType {
  // Image-fill shapes render as images so the raster gets drawn
  if (node.fills?.some((f) => f.type === 'IMAGE' && f.imageRef)) return 'image';

  switch (node.type) {
    case 'TEXT':              return 'text';
    case 'RECTANGLE':         return 'rectangle';
    case 'ELLIPSE':           return 'oval';
    case 'IMAGE':             return 'image';
    case 'GROUP':             return 'group';
    case 'STAR':              return 'star';
    case 'POLYGON':           return 'polygon';
    case 'LINE':
    case 'VECTOR':
    case 'BOOLEAN_OPERATION': return 'path';
    case 'INSTANCE':
    case 'COMPONENT':
    case 'COMPONENT_SET':     return 'symbolInstance';
    // FRAME / SECTION / CANVAS / DOCUMENT and anything else → rectangle container
    default:                  return 'rectangle';
  }
}

/* ── Fill / Paint Conversion ─────────────────────────────────────────── */

function colorCss(c: FigColor, extraAlpha?: number): string {
  const a = (c.a ?? 1) * (extraAlpha ?? 1);
  return rgbaToCss({ r: c.r, g: c.g, b: c.b, a });
}

function gradientTypeFromPaint(type: string): RenderGradient['type'] | null {
  const t = type.toUpperCase();
  if (t === 'GRADIENT_LINEAR' || t === 'LINEAR') return 'linear';
  if (t === 'GRADIENT_RADIAL' || t === 'RADIAL' || t === 'GRADIENT_DIAMOND') return 'radial';
  if (t === 'GRADIENT_ANGULAR' || t === 'ANGULAR') return 'angular';
  return null;
}

function convertGradient(paint: FigPaint): RenderGradient | null {
  const type = gradientTypeFromPaint(paint.type);
  if (!type) return null;
  const rawStops = paint.gradientStops ?? [];
  const stops: GradientStop[] = rawStops.map((s: FigGradientStop) => ({
    position: Math.max(0, Math.min(1, s.position)),
    color: colorCss(s.color),
  }));
  if (stops.length === 0) return null;

  // Figma gradient handle layout: [origin, end, widthAnchor] in unit-box space
  const handles = paint.gradientHandlePositions ?? [];
  const from = handles[0] ?? { x: 0.5, y: 0 };
  const to = handles[1] ?? { x: 0.5, y: 1 };
  return { type, from, to, stops };
}

function convertFill(
  paint: FigPaint,
  imageResolver: ImageResolver,
): RenderFill | null {
  if (paint.visible === false) return null;

  // Gradient
  const gradient = convertGradient(paint);
  if (gradient) {
    return {
      type: 'gradient',
      gradient,
      opacity: paint.opacity,
    };
  }

  // Image
  if (paint.type === 'IMAGE' && paint.imageRef) {
    const uri = imageResolver.resolve(paint.imageRef);
    if (uri) {
      return {
        type: 'pattern',
        patternRef: uri,
        opacity: paint.opacity,
      };
    }
    return null;
  }

  // Solid / fallback
  if (paint.color) {
    return {
      type: 'color',
      color: colorCss(paint.color),
      opacity: paint.opacity,
    };
  }
  return null;
}

function convertBorder(paint: FigPaint, strokeWeight: number): RenderBorder | null {
  if (paint.visible === false) return null;
  if (!paint.color) return null; // only solid borders for now
  return {
    color: colorCss(paint.color),
    thickness: strokeWeight,
    position: 'center',
    opacity: paint.opacity,
  };
}

/* ── Effects (shadows / blurs) ───────────────────────────────────────── */

function convertEffects(effects: FigEffect[] | undefined): {
  shadows: RenderShadow[];
  innerShadows: RenderShadow[];
  blur?: RenderBlur;
} {
  const shadows: RenderShadow[] = [];
  const innerShadows: RenderShadow[] = [];
  let blur: RenderBlur | undefined;

  for (const e of effects ?? []) {
    if (e.visible === false) continue;
    const t = e.type.toUpperCase();
    if (t === 'DROP_SHADOW' || t === 'DROPSHADOW') {
      shadows.push({
        x: e.offset?.x ?? 0,
        y: e.offset?.y ?? 0,
        blur: e.radius ?? 0,
        spread: e.spread ?? 0,
        color: e.color ? colorCss(e.color) : 'rgba(0,0,0,0.25)',
      });
    } else if (t === 'INNER_SHADOW' || t === 'INNERSHADOW') {
      innerShadows.push({
        x: e.offset?.x ?? 0,
        y: e.offset?.y ?? 0,
        blur: e.radius ?? 0,
        spread: e.spread ?? 0,
        color: e.color ? colorCss(e.color) : 'rgba(0,0,0,0.25)',
      });
    } else if (t === 'LAYER_BLUR' || t === 'BLUR' || t === 'FOREGROUND_BLUR') {
      blur = { type: 'gaussian', radius: e.radius ?? 0 };
    } else if (t === 'BACKGROUND_BLUR') {
      blur = { type: 'background', radius: e.radius ?? 0 };
    }
  }

  return { shadows, innerShadows, blur };
}

/* ── Text Conversion ─────────────────────────────────────────────────── */

function convertText(node: FigNode): RenderText | undefined {
  if (node.type !== 'TEXT' && !node.characters) return undefined;

  const content = node.characters ?? '';
  const fill = node.fills?.find((f) => f.visible !== false && f.color);
  const alignMap: Record<string, RenderTextStyle['textAlign']> = {
    LEFT: 'left',
    left: 'left',
    CENTER: 'center',
    center: 'center',
    RIGHT: 'right',
    right: 'right',
    JUSTIFIED: 'justify',
    justified: 'justify',
  };
  const decoMap: Record<string, RenderTextStyle['textDecoration']> = {
    UNDERLINE: 'underline',
    STRIKETHROUGH: 'line-through',
    NONE: 'none',
  };

  const style: RenderTextStyle = {
    fontFamily: node.fontFamily || 'Inter',
    fontSize: node.fontSize ?? 14,
    fontWeight: node.fontWeight ?? 400,
    color: fill?.color ? colorCss(fill.color) : '#111111',
    lineHeight: node.lineHeightPx,
    letterSpacing: node.letterSpacing,
    textAlign: alignMap[node.textAlignHorizontal ?? ''] ?? 'left',
    textDecoration: decoMap[node.textDecoration ?? 'NONE'] ?? 'none',
  };
  const run: RenderTextRun = { content, style };
  return { content, runs: [run] };
}

/* ── Image Resolver ──────────────────────────────────────────────────── */

class ImageResolver {
  private cache = new Map<string, string | undefined>();
  constructor(private images: Map<string, FigImageAsset>, private inlineImages: boolean) {}

  resolve(hash: string): string | undefined {
    if (!this.inlineImages) return undefined;
    if (this.cache.has(hash)) return this.cache.get(hash);
    const asset = this.images.get(hash);
    if (!asset) {
      this.cache.set(hash, undefined);
      return undefined;
    }
    const uri = `data:${asset.mime};base64,${asset.data.toString('base64')}`;
    this.cache.set(hash, uri);
    return uri;
  }
}

/* ── Border Radius ───────────────────────────────────────────────────── */

function resolveBorderRadius(
  node: FigNode,
): number | [number, number, number, number] | undefined {
  if (node.rectangleCornerRadii) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii;
    if (tl === tr && tr === br && br === bl) return tl || undefined;
    return [tl, tr, br, bl];
  }
  if (node.cornerRadius && node.cornerRadius > 0) return node.cornerRadius;
  return undefined;
}

/* ── FigNode → RenderNode ────────────────────────────────────────────── */

interface ConvertCtx {
  options: FigRenderOptions;
  resolver: ImageResolver;
  componentMasters: Map<string, FigNode>;
}

function collectComponentMasters(nodes: FigNode[] | undefined, out: Map<string, FigNode>): void {
  for (const node of nodes ?? []) {
    if ((node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.name && !out.has(node.name)) {
      out.set(node.name, node);
    }
    collectComponentMasters(node.children, out);
  }
}

function scaleRenderNode(node: RenderNode, scaleX: number, scaleY: number): RenderNode {
  const uniformScale = (scaleX + scaleY) / 2;
  return {
    ...node,
    frame: {
      x: node.frame.x * scaleX,
      y: node.frame.y * scaleY,
      width: node.frame.width * scaleX,
      height: node.frame.height * scaleY,
    },
    borderRadius: Array.isArray(node.borderRadius)
      ? [
          node.borderRadius[0] * uniformScale,
          node.borderRadius[1] * uniformScale,
          node.borderRadius[2] * uniformScale,
          node.borderRadius[3] * uniformScale,
        ]
      : typeof node.borderRadius === 'number'
        ? node.borderRadius * uniformScale
        : undefined,
    borders: node.borders.map((border) => ({
      ...border,
      thickness: border.thickness * uniformScale,
    })),
    shadows: node.shadows.map((shadow) => ({
      ...shadow,
      x: shadow.x * scaleX,
      y: shadow.y * scaleY,
      blur: shadow.blur * uniformScale,
      spread: shadow.spread * uniformScale,
    })),
    innerShadows: node.innerShadows.map((shadow) => ({
      ...shadow,
      x: shadow.x * scaleX,
      y: shadow.y * scaleY,
      blur: shadow.blur * uniformScale,
      spread: shadow.spread * uniformScale,
    })),
    blur: node.blur
      ? { ...node.blur, radius: node.blur.radius * uniformScale }
      : undefined,
    text: node.text
      ? {
          ...node.text,
          runs: node.text.runs.map((run) => ({
            ...run,
            style: {
              ...run.style,
              fontSize: run.style.fontSize * uniformScale,
              lineHeight: run.style.lineHeight !== undefined
                ? run.style.lineHeight * uniformScale
                : undefined,
              letterSpacing: run.style.letterSpacing !== undefined
                ? run.style.letterSpacing * uniformScale
                : undefined,
            },
          })),
        }
      : undefined,
    children: node.children.map((child) => scaleRenderNode(child, scaleX, scaleY)),
  };
}

function resolveInstanceChildren(node: FigNode, ctx: ConvertCtx): FigNode[] {
  if ((node.children?.length ?? 0) > 0) return node.children ?? [];
  if (node.type !== 'INSTANCE') return [];
  const master = ctx.componentMasters.get(node.name);
  if (!master || master === node) return [];
  return master.children ?? [];
}

function absolutizeNode(node: RenderNode, parentX = 0, parentY = 0): RenderNode {
  const absoluteX = parentX + node.frame.x;
  const absoluteY = parentY + node.frame.y;
  return {
    ...node,
    frame: {
      ...node.frame,
      x: absoluteX,
      y: absoluteY,
    },
    children: node.children.map((child) => absolutizeNode(child, absoluteX, absoluteY)),
  };
}

function convertNode(node: FigNode, ctx: ConvertCtx, isRoot: boolean): RenderNode {
  const renderType = mapRenderType(node);

  // Fills
  const fills: RenderFill[] = [];
  for (const p of node.fills ?? []) {
    const f = convertFill(p, ctx.resolver);
    if (f) fills.push(f);
  }

  // Borders
  const borders: RenderBorder[] = [];
  const strokeWeight = node.strokeWeight ?? 1;
  for (const s of node.strokes ?? []) {
    const b = convertBorder(s, strokeWeight);
    if (b) borders.push(b);
  }

  // Effects
  const { shadows, innerShadows, blur } = convertEffects(node.effects);

  // Children
  const sourceChildren = resolveInstanceChildren(node, ctx);
  const children: RenderNode[] = [];
  for (const c of sourceChildren) {
    if (!ctx.options.includeHidden && c.visible === false) continue;
    children.push(convertNode(c, ctx, false));
  }

  const scaledChildren =
    node.type === 'INSTANCE' && (node.children?.length ?? 0) === 0 && sourceChildren.length > 0
      ? (() => {
          const master = ctx.componentMasters.get(node.name);
          const masterWidth = Math.max(master?.width ?? node.width, 1);
          const masterHeight = Math.max(master?.height ?? node.height, 1);
          const scaleX = node.width / masterWidth;
          const scaleY = node.height / masterHeight;
          return children.map((child) => scaleRenderNode(child, scaleX, scaleY));
        })()
      : children;

  // Root frames are normalized to the artboard origin. Descendants keep the
  // parent-relative coordinates from the .fig transform and are converted to
  // artboard-local absolute coordinates after the tree is built.
  const frame = isRoot
    ? { x: 0, y: 0, width: node.width, height: node.height }
    : { x: node.x, y: node.y, width: node.width, height: node.height };

  // Image ref — explicit hash wins; otherwise look in image fills.
  const imgFill = node.fills?.find((f) => f.type === 'IMAGE' && f.imageRef);
  const imageRef = imgFill?.imageRef
    ? ctx.resolver.resolve(imgFill.imageRef) ?? imgFill.imageRef
    : undefined;

  // Auto-layout / clipsContent heuristic — frames with layoutMode should clip.
  const clipContent = node.clipsContent ?? (
    node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE'
  );

  return {
    id: node.id,
    name: node.name || node.type,
    type: renderType,
    frame,
    rotation: node.rotation ?? 0,
    opacity: node.opacity ?? 1,
    isVisible: node.visible !== false,
    clipContent: clipContent ?? false,
    hasClippingMask: node.isMask === true,
    fills,
    borders,
    shadows,
    innerShadows,
    blur,
    borderRadius: resolveBorderRadius(node),
    children: scaledChildren,
    text: convertText(node),
    imageRef,
    sketchClass: node.type.toLowerCase(),
  };
}

/* ── Artboard Assembly ───────────────────────────────────────────────── */

function frameBackgroundColor(node: FigNode): string | undefined {
  const fill = node.fills?.find(
    (f) => f.visible !== false && f.type !== 'GRADIENT_LINEAR' && f.color,
  );
  if (!fill?.color) return '#ffffff';
  return colorCss(fill.color);
}

function pageToArtboards(
  page: FigPage,
  ctx: ConvertCtx,
  perFrame: boolean,
): RenderArtboard[] {
  const topLevel = (page.children ?? []).filter(
    (n) => ctx.options.includeHidden || n.visible !== false,
  );
  if (topLevel.length === 0) return [];

  if (perFrame) {
    // Each page-level FRAME / SECTION becomes its own artboard. Components
    // and loose asset fragments are ignored by default so preview.html shows
    // real screens rather than the entire asset library.
    const artboards: RenderArtboard[] = [];
    const loose: FigNode[] = [];
    for (const child of topLevel) {
      if (isPreviewArtboardNode(child)) {
        const root = absolutizeNode(convertNode(child, ctx, true));
        artboards.push({
          name: child.name || page.name,
          frame: { x: child.x, y: child.y, width: child.width || 1, height: child.height || 1 },
          backgroundColor: frameBackgroundColor(child),
          root,
        });
      } else {
        loose.push(child);
      }
    }

    if (artboards.length === 0 && loose.length > 0) {
      const minX = Math.min(...loose.map((n) => n.x));
      const minY = Math.min(...loose.map((n) => n.y));
      const maxX = Math.max(...loose.map((n) => n.x + n.width));
      const maxY = Math.max(...loose.map((n) => n.y + n.height));
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      const rootChildren = loose.map((n) =>
        absolutizeNode(convertNode(n, ctx, false), -minX, -minY),
      );
      artboards.push({
        name: page.name,
        frame: { x: minX, y: minY, width: w, height: h },
        backgroundColor: '#ffffff',
        root: {
          id: `fig-loose-${page.id}`,
          name: page.name,
          type: 'artboard',
          frame: { x: 0, y: 0, width: w, height: h },
          rotation: 0,
          opacity: 1,
          isVisible: true,
          clipContent: true,
          hasClippingMask: false,
          fills: [],
          borders: [],
          shadows: [],
          innerShadows: [],
          children: rootChildren,
          sketchClass: 'artboard',
        },
      });
    }
    return artboards;
  }

  // Per-page artboard: pack all children in the smallest enclosing box.
  const minX = Math.min(...topLevel.map((n) => n.x));
  const minY = Math.min(...topLevel.map((n) => n.y));
  const maxX = Math.max(...topLevel.map((n) => n.x + n.width));
  const maxY = Math.max(...topLevel.map((n) => n.y + n.height));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const rootChildren = topLevel.map((n) =>
    absolutizeNode(convertNode(n, ctx, false), -minX, -minY),
  );
  return [{
    name: page.name,
    frame: { x: minX, y: minY, width: w, height: h },
    backgroundColor: '#ffffff',
    root: {
      id: `fig-page-${page.id}`,
      name: page.name,
      type: 'artboard',
      frame: { x: 0, y: 0, width: w, height: h },
      rotation: 0,
      opacity: 1,
      isVisible: true,
      clipContent: true,
      hasClippingMask: false,
      fills: [],
      borders: [],
      shadows: [],
      innerShadows: [],
      children: rootChildren,
      sketchClass: 'artboard',
    },
  }];
}

/* ── Public API ──────────────────────────────────────────────────────── */

/**
 * Convert a parsed FigDocument to a RenderDocument.
 */
export function buildFigRenderTree(
  doc: FigDocument,
  options?: FigRenderOptions,
): FigRenderResult {
  const opts: FigRenderOptions = {
    scale: 1,
    includeHidden: false,
    perFrameArtboards: true,
    ...options,
  };
  const resolver = new ImageResolver(doc.images ?? new Map(), true);
  const perFrame = opts.perFrameArtboards !== false;
  const componentMasters = new Map<string, FigNode>();
  for (const page of doc.pages) {
    collectComponentMasters(page.children, componentMasters);
  }

  const artboards: RenderArtboard[] = [];
  for (const page of doc.pages) {
    const ctx: ConvertCtx = {
      options: opts,
      resolver,
      componentMasters,
    };
    artboards.push(...pageToArtboards(page, ctx, perFrame));
  }

  return { renderDoc: { name: doc.name, artboards } };
}
