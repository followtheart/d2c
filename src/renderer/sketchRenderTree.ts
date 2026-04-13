/**
 * Sketch → Render Tree converter
 *
 * Builds a RenderDocument from raw Sketch JSON, preserving all visual details
 * that the IR purposely strips (multiple fills, gradients, blur, inner shadows,
 * rotation, per-corner radii, etc.).
 *
 * Accepts the same input shapes as the IR-level sketchParser:
 *   (a) full document with pages,
 *   (b) a single page,
 *   (c) a single artboard / layer.
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
  RenderText,
  RenderTextRun,
  RenderTextStyle,
  RenderGradient,
  GradientStop,
  FillType,
  BorderPosition,
  SketchRenderOptions,
} from './types';
import { rgbaToCss } from '../utils/color';

/* ── Raw Sketch JSON shapes ───────────────────────────────────────────── */

interface SketchColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

interface SketchGradientStop {
  position: number;
  color: SketchColor;
}

interface SketchGradient {
  gradientType: number; // 0=linear, 1=radial, 2=angular
  from: string;         // "{x, y}" normalised
  to: string;
  stops: SketchGradientStop[];
}

interface SketchFill {
  _class: string;
  isEnabled?: boolean;
  fillType?: number;    // 0=color, 1=gradient, 4=pattern
  color?: SketchColor;
  gradient?: SketchGradient;
  noiseIndex?: number;
  noiseIntensity?: number;
  patternFillType?: number;
  patternTileScale?: number;
  image?: { _ref?: string };
  contextSettings?: { opacity?: number };
}

interface SketchBorderRaw {
  _class: string;
  isEnabled?: boolean;
  color?: SketchColor;
  thickness?: number;
  position?: number;  // 0=center, 1=inside, 2=outside
  contextSettings?: { opacity?: number };
}

interface SketchShadowRaw {
  _class: string;
  isEnabled?: boolean;
  blurRadius?: number;
  offsetX?: number;
  offsetY?: number;
  spread?: number;
  color?: SketchColor;
  contextSettings?: { opacity?: number };
}

interface SketchBlurRaw {
  _class: string;
  isEnabled?: boolean;
  type?: number;     // 0=gaussian, 1=motion, 2=zoom, 3=background
  radius?: number;
  center?: string;
}

interface SketchStyle {
  fills?: SketchFill[];
  borders?: SketchBorderRaw[];
  shadows?: SketchShadowRaw[];
  innerShadows?: SketchShadowRaw[];
  blur?: SketchBlurRaw;
  contextSettings?: { opacity?: number; blendMode?: number };
  textStyle?: {
    encodedAttributes?: {
      MSAttributedStringFontAttribute?: {
        attributes?: { name?: string; size?: number };
      };
      MSAttributedStringColorAttribute?: SketchColor;
      paragraphStyle?: {
        alignment?: number;
        maximumLineHeight?: number;
        minimumLineHeight?: number;
      };
      kerning?: number;
      underlineStyle?: number;
      strikethroughStyle?: number;
    };
  };
}

interface SketchFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SketchLayer {
  _class: string;
  do_objectID?: string;
  objectID?: string;
  name?: string;
  frame?: SketchFrame;
  style?: SketchStyle;
  fixedRadius?: number;
  points?: { curveFrom?: string; curveTo?: string; cornerRadius?: number; point?: string }[];
  stringValue?: string;
  attributedString?: {
    string?: string;
    attributes?: {
      location: number;
      length: number;
      attributes?: {
        MSAttributedStringFontAttribute?: { attributes?: { name?: string; size?: number } };
        MSAttributedStringColorAttribute?: SketchColor;
        paragraphStyle?: { alignment?: number; maximumLineHeight?: number };
        kerning?: number;
        underlineStyle?: number;
        strikethroughStyle?: number;
      };
    }[];
  };
  layers?: SketchLayer[];
  rotation?: number;
  isVisible?: boolean;
  isFlippedHorizontal?: boolean;
  isFlippedVertical?: boolean;
  hasClippingMask?: boolean;
  clippingMaskMode?: number;
  shouldBreakMaskChain?: boolean;
  resizingConstraint?: number;
  image?: { _ref?: string };
  /** Artboard-specific */
  backgroundColor?: SketchColor;
  hasBackgroundColor?: boolean;
}

interface SketchPage {
  _class: 'page';
  do_objectID?: string;
  name?: string;
  layers: SketchLayer[];
}

interface SketchDoc {
  pages?: Record<string, SketchPage> | SketchPage[];
  document?: SketchDoc;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function cssColor(c: SketchColor | undefined): string {
  if (!c) return '#000000';
  return rgbaToCss({ r: c.red, g: c.green, b: c.blue, a: c.alpha });
}

function parsePoint(s: string | undefined): { x: number; y: number } {
  if (!s) return { x: 0, y: 0 };
  const m = s.match(/\{?\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*\}?/);
  if (!m) return { x: 0, y: 0 };
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

function gradientTypeStr(n: number): 'linear' | 'radial' | 'angular' {
  switch (n) {
    case 1: return 'radial';
    case 2: return 'angular';
    default: return 'linear';
  }
}

function borderPosStr(n: number | undefined): BorderPosition {
  switch (n) {
    case 1: return 'inside';
    case 2: return 'outside';
    default: return 'center';
  }
}

function blurTypeStr(n: number | undefined): RenderBlur['type'] {
  switch (n) {
    case 1: return 'motion';
    case 2: return 'zoom';
    case 3: return 'background';
    default: return 'gaussian';
  }
}

function alignStr(n: number | undefined): RenderTextStyle['textAlign'] {
  switch (n) {
    case 1: return 'right';
    case 2: return 'center';
    case 3: return 'justify';
    default: return 'left';
  }
}

function fontWeight(name: string | undefined): number {
  if (!name) return 400;
  const n = name.toLowerCase();
  if (/black|heavy/i.test(n)) return 900;
  if (/extrabold|ultrabold/i.test(n)) return 800;
  if (/bold/i.test(n)) return 700;
  if (/semibold|demibold/i.test(n)) return 600;
  if (/medium/i.test(n)) return 500;
  if (/light/i.test(n)) return 300;
  if (/thin|hairline/i.test(n)) return 100;
  return 400;
}

/* ── Conversion: fills, borders, shadows ──────────────────────────────── */

function convertFill(f: SketchFill): RenderFill | null {
  if (f.isEnabled === false) return null;

  const fillType: FillType =
    f.fillType === 1 || f.fillType === 2 || f.fillType === 3
      ? 'gradient'
      : f.fillType === 4
        ? 'pattern'
        : 'color';

  const result: RenderFill = { type: fillType };

  if (fillType === 'color') {
    result.color = cssColor(f.color);
  } else if (fillType === 'gradient' && f.gradient) {
    const g = f.gradient;
    const stops: GradientStop[] = (g.stops ?? []).map((s) => ({
      position: s.position,
      color: cssColor(s.color),
    }));
    result.gradient = {
      type: gradientTypeStr(g.gradientType),
      from: parsePoint(g.from),
      to: parsePoint(g.to),
      stops,
    };
  } else if (fillType === 'pattern') {
    result.patternRef = f.image?._ref;
  }

  if (f.contextSettings?.opacity !== undefined) {
    result.opacity = f.contextSettings.opacity;
  }

  return result;
}

function convertBorder(b: SketchBorderRaw): RenderBorder | null {
  if (b.isEnabled === false) return null;
  return {
    color: cssColor(b.color),
    thickness: b.thickness ?? 1,
    position: borderPosStr(b.position),
    opacity: b.contextSettings?.opacity,
  };
}

function convertShadow(s: SketchShadowRaw): RenderShadow | null {
  if (s.isEnabled === false) return null;
  return {
    x: s.offsetX ?? 0,
    y: s.offsetY ?? 0,
    blur: s.blurRadius ?? 0,
    spread: s.spread ?? 0,
    color: cssColor(s.color),
  };
}

function convertBlur(b: SketchBlurRaw | undefined): RenderBlur | undefined {
  if (!b || b.isEnabled === false) return undefined;
  return {
    type: blurTypeStr(b.type),
    radius: b.radius ?? 0,
  };
}

/* ── Conversion: text ─────────────────────────────────────────────────── */

function defaultTextStyle(layer: SketchLayer): RenderTextStyle {
  const enc = layer.style?.textStyle?.encodedAttributes;
  const font = enc?.MSAttributedStringFontAttribute?.attributes;
  return {
    fontFamily: font?.name ?? 'Helvetica',
    fontSize: font?.size ?? 14,
    fontWeight: fontWeight(font?.name),
    color: cssColor(enc?.MSAttributedStringColorAttribute),
    lineHeight: enc?.paragraphStyle?.maximumLineHeight || undefined,
    letterSpacing: enc?.kerning || undefined,
    textAlign: alignStr(enc?.paragraphStyle?.alignment),
    textDecoration:
      enc?.underlineStyle ? 'underline'
      : enc?.strikethroughStyle ? 'line-through'
      : 'none',
  };
}

function convertText(layer: SketchLayer): RenderText | undefined {
  if (layer._class !== 'text') return undefined;
  const content =
    layer.stringValue ?? layer.attributedString?.string ?? '';

  const baseStyle = defaultTextStyle(layer);

  // Try to build rich text runs from attributedString
  const attrs = layer.attributedString?.attributes;
  if (attrs && attrs.length > 1 && layer.attributedString?.string) {
    const fullStr = layer.attributedString.string;
    const runs: RenderTextRun[] = attrs.map((attr) => {
      const runContent = fullStr.substring(
        attr.location,
        attr.location + attr.length,
      );
      const a = attr.attributes;
      const font = a?.MSAttributedStringFontAttribute?.attributes;
      const style: RenderTextStyle = {
        fontFamily: font?.name ?? baseStyle.fontFamily,
        fontSize: font?.size ?? baseStyle.fontSize,
        fontWeight: fontWeight(font?.name) || baseStyle.fontWeight,
        color: a?.MSAttributedStringColorAttribute
          ? cssColor(a.MSAttributedStringColorAttribute)
          : baseStyle.color,
        lineHeight: a?.paragraphStyle?.maximumLineHeight || baseStyle.lineHeight,
        letterSpacing: a?.kerning || baseStyle.letterSpacing,
        textAlign: a?.paragraphStyle?.alignment !== undefined
          ? alignStr(a.paragraphStyle.alignment)
          : baseStyle.textAlign,
        textDecoration:
          a?.underlineStyle ? 'underline'
          : a?.strikethroughStyle ? 'line-through'
          : 'none',
      };
      return { content: runContent, style };
    });
    return { content, runs };
  }

  // Single run
  return {
    content,
    runs: [{ content, style: baseStyle }],
  };
}

/* ── Conversion: layer → RenderNode ───────────────────────────────────── */

function mapNodeType(cls: string): RenderNodeType {
  switch (cls) {
    case 'artboard': return 'artboard';
    case 'group': return 'group';
    case 'rectangle': return 'rectangle';
    case 'oval': return 'oval';
    case 'triangle': return 'triangle';
    case 'star': return 'star';
    case 'polygon': return 'polygon';
    case 'shapePath': return 'path';
    case 'shapeGroup': return 'shapeGroup';
    case 'text': return 'text';
    case 'bitmap': return 'image';
    case 'symbolInstance': return 'symbolInstance';
    case 'slice': return 'slice';
    default: return 'group';
  }
}

function extractBorderRadius(
  layer: SketchLayer,
): number | [number, number, number, number] | undefined {
  // Check per-corner radii from points array (Sketch rectangles)
  if (layer.points && layer.points.length === 4) {
    const radii = layer.points.map((p) => p.cornerRadius ?? 0);
    if (radii.some((r) => r > 0)) {
      const allSame = radii.every((r) => r === radii[0]);
      return allSame ? radii[0] : [radii[0], radii[1], radii[2], radii[3]];
    }
  }
  // Fallback to fixedRadius
  if (layer.fixedRadius !== undefined && layer.fixedRadius > 0) {
    return layer.fixedRadius;
  }
  return undefined;
}

function convertLayer(
  layer: SketchLayer,
  opts: SketchRenderOptions,
): RenderNode {
  const frame = layer.frame ?? { x: 0, y: 0, width: 0, height: 0 };
  const style = layer.style;

  const fills = (style?.fills ?? [])
    .map(convertFill)
    .filter((f): f is RenderFill => f !== null);

  const borders = (style?.borders ?? [])
    .map(convertBorder)
    .filter((b): b is RenderBorder => b !== null);

  const shadows = (style?.shadows ?? [])
    .map(convertShadow)
    .filter((s): s is RenderShadow => s !== null);

  const innerShadows = (style?.innerShadows ?? [])
    .map(convertShadow)
    .filter((s): s is RenderShadow => s !== null);

  // Artboard background color
  if (layer._class === 'artboard' && layer.hasBackgroundColor && layer.backgroundColor) {
    fills.unshift({ type: 'color', color: cssColor(layer.backgroundColor) });
  }

  const children = (layer.layers ?? [])
    .filter((child) => opts.includeHidden || child.isVisible !== false)
    .map((child) => convertLayer(child, opts));

  const contextOpacity = style?.contextSettings?.opacity;

  const node: RenderNode = {
    id: layer.do_objectID ?? layer.objectID ??
      `render_${Math.random().toString(36).slice(2, 8)}`,
    name: layer.name ?? layer._class,
    type: mapNodeType(layer._class),
    frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    rotation: layer.rotation ?? 0,
    opacity: contextOpacity !== undefined ? contextOpacity : 1,
    isVisible: layer.isVisible !== false,
    clipContent: layer._class === 'artboard' || layer._class === 'group',
    hasClippingMask: layer.hasClippingMask ?? false,
    fills,
    borders,
    shadows,
    innerShadows,
    blur: convertBlur(style?.blur),
    borderRadius: extractBorderRadius(layer),
    children,
    text: convertText(layer),
    imageRef: layer.image?._ref || (layer._class === 'bitmap' ? 'placeholder' : undefined),
    sketchClass: layer._class,
  };

  return node;
}

/* ── Top-level: extract artboards / pages ─────────────────────────────── */

export function extractPages(raw: unknown): SketchPage[] {
  const obj = raw as Record<string, unknown>;

  // Shape (a): { document: { pages: ... } }
  const docWrap = obj.document as Record<string, unknown> | undefined;
  const pageSource = (docWrap?.pages ?? obj.pages) as
    | Record<string, SketchPage>
    | SketchPage[]
    | undefined;

  if (pageSource) {
    return Array.isArray(pageSource)
      ? pageSource
      : Object.values(pageSource);
  }

  // Shape (b): single page
  if (obj._class === 'page' && Array.isArray(obj.layers)) {
    return [obj as unknown as SketchPage];
  }

  // Shape (c): single artboard / layer — wrap in a virtual page
  if (obj._class && obj.frame) {
    const layer = obj as unknown as SketchLayer;
    return [{
      _class: 'page',
      name: layer.name ?? 'Page',
      layers: [layer],
    } as SketchPage];
  }

  throw new Error('Sketch render: could not find pages or layers in input');
}

/**
 * Build a RenderDocument from raw Sketch JSON.
 *
 * The document contains one or more artboards, each with its own render tree.
 * Non-artboard top-level layers on a page are grouped into a synthetic artboard.
 */
export function buildRenderTree(
  raw: unknown,
  options?: SketchRenderOptions,
): RenderDocument {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Sketch render input must be an object');
  }

  const opts: SketchRenderOptions = {
    scale: 1,
    includeHidden: false,
    pageBackground: '#f5f5f5',
    showArtboardTitles: true,
    ...options,
  };

  const pages = extractPages(raw);
  const artboards: RenderArtboard[] = [];

  for (const page of pages) {
    const artboardLayers: SketchLayer[] = [];
    const looseLayers: SketchLayer[] = [];

    for (const layer of page.layers ?? []) {
      if (!opts.includeHidden && layer.isVisible === false) continue;
      if (layer._class === 'artboard') {
        artboardLayers.push(layer);
      } else {
        looseLayers.push(layer);
      }
    }

    // Convert each artboard
    for (const ab of artboardLayers) {
      const rootNode = convertLayer(ab, opts);
      const bgFill = rootNode.fills.find((f) => f.type === 'color');
      artboards.push({
        name: ab.name ?? 'Artboard',
        frame: rootNode.frame,
        backgroundColor: bgFill?.color ?? '#ffffff',
        root: rootNode,
      });
    }

    // Wrap loose layers in a synthetic artboard
    if (looseLayers.length > 0) {
      let maxW = 0;
      let maxH = 0;
      for (const l of looseLayers) {
        const f = l.frame ?? { x: 0, y: 0, width: 0, height: 0 };
        maxW = Math.max(maxW, f.x + f.width);
        maxH = Math.max(maxH, f.y + f.height);
      }
      const syntheticArtboard: SketchLayer = {
        _class: 'artboard',
        name: page.name ?? 'Page',
        frame: { x: 0, y: 0, width: maxW, height: maxH },
        layers: looseLayers,
        hasBackgroundColor: true,
        backgroundColor: { red: 1, green: 1, blue: 1, alpha: 1 },
      };
      const rootNode = convertLayer(syntheticArtboard, opts);
      artboards.push({
        name: syntheticArtboard.name!,
        frame: rootNode.frame,
        backgroundColor: '#ffffff',
        root: rootNode,
      });
    }
  }

  return {
    name: pages[0]?.name ?? 'SketchDocument',
    artboards,
  };
}
