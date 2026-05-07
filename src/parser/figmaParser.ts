/**
 * Figma REST API parser → IR.
 *
 * Implements a practical subset of the Figma REST response
 * (GET /v1/files/:key) focusing on the node types most commonly
 * seen in UI designs: FRAME, GROUP, COMPONENT, INSTANCE, RECTANGLE,
 * TEXT, VECTOR, ELLIPSE, LINE, IMAGE.
 *
 * Only the shape of the response is validated at runtime — we
 * intentionally do not depend on @figma/rest-api-spec so that d2c
 * stays zero-dependency.
 */
import type {
  Box,
  IRDocument,
  IRNode,
  IRNodeType,
  Layout,
  SourceMeta,
  Style,
  TextStyle,
} from '../ir/types';
import { anyColorToCss } from '../utils/color';
import { validateIR } from '../ir/schema';

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  effects?: FigmaEffect[];
  opacity?: number;
  characters?: string;
  style?: {
    fontFamily?: string;
    fontWeight?: number;
    fontSize?: number;
    lineHeightPx?: number;
    letterSpacing?: number;
    textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  };
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  itemSpacing?: number;
  counterAxisSpacing?: number;
  layoutWrap?: 'NO_WRAP' | 'WRAP';
  primaryAxisSizingMode?: 'FIXED' | 'AUTO';
  counterAxisSizingMode?: 'FIXED' | 'AUTO';
  layoutSizingHorizontal?: 'FIXED' | 'HUG' | 'FILL';
  layoutSizingVertical?: 'FIXED' | 'HUG' | 'FILL';
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  /** Figma constraints describing how a child reacts when its parent resizes. */
  constraints?: {
    horizontal?: 'LEFT' | 'RIGHT' | 'CENTER' | 'LEFT_RIGHT' | 'SCALE';
    vertical?: 'TOP' | 'BOTTOM' | 'CENTER' | 'TOP_BOTTOM' | 'SCALE';
  };
  /** Per-side stroke widths (when Figma sets individualStrokeWeights). */
  individualStrokeWeights?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  /** Auto-truncate / auto-resize behaviour for TEXT nodes. */
  textAutoResize?: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
  /** Set on INSTANCE nodes — references the master COMPONENT. */
  componentId?: string;
  /** Set on COMPONENT nodes that belong to a COMPONENT_SET. */
  componentSetId?: string;
  /**
   * Override list emitted on INSTANCE nodes — Figma reports the path of
   * properties the instance has changed from its master (e.g. text content,
   * fill color overrides). We forward the raw paths so codegen can decide
   * which props to surface.
   */
  overrides?: Array<{ id: string; overriddenFields?: string[] }>;
  /** Variant property values on COMPONENT nodes inside a COMPONENT_SET. */
  componentPropertyDefinitions?: Record<string, { type: string; defaultValue?: unknown }>;
  componentProperties?: Record<string, { type: string; value: unknown }>;
  children?: FigmaNode[];
}

interface FigmaPaint {
  type: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number; a?: number };
  opacity?: number;
  imageRef?: string;
}

interface FigmaEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  offset?: { x: number; y: number };
  color?: { r: number; g: number; b: number; a?: number };
  spread?: number;
}

interface FigmaFileResponse {
  name?: string;
  document: FigmaNode;
}

function mapType(figma: FigmaNode): IRNodeType {
  switch (figma.type) {
    case 'TEXT':
      return 'text';
    case 'RECTANGLE':
    case 'ELLIPSE':
    case 'VECTOR':
    case 'LINE':
    case 'STAR':
    case 'POLYGON':
      // If filled with an image → image. Otherwise treat shapes as containers.
      if ((figma.fills ?? []).some((f) => f.type === 'IMAGE')) return 'image';
      return 'container';
    case 'FRAME':
    case 'GROUP':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
    case 'SECTION':
      return 'container';
    default:
      return 'container';
  }
}

function extractStyle(figma: FigmaNode): Style {
  const style: Style = {};
  const solidFill = (figma.fills ?? []).find(
    (f) => f.visible !== false && f.type === 'SOLID',
  );
  if (solidFill?.color) {
    const base = anyColorToCss({
      ...solidFill.color,
      a: (solidFill.color.a ?? 1) * (solidFill.opacity ?? 1),
    });
    if (base) style.backgroundColor = base;
  }
  if (figma.cornerRadius !== undefined) style.borderRadius = figma.cornerRadius;
  else if (figma.rectangleCornerRadii) style.borderRadius = figma.rectangleCornerRadii;

  const strokeFill = (figma.strokes ?? []).find(
    (f) => f.visible !== false && f.type === 'SOLID',
  );
  if (strokeFill?.color && figma.strokeWeight) {
    style.border = {
      width: figma.strokeWeight,
      color: anyColorToCss(strokeFill.color) ?? '#000000',
      style: 'solid',
    };
  }

  const shadows = (figma.effects ?? [])
    .filter((e) => e.visible !== false && e.type === 'DROP_SHADOW')
    .map((e) => ({
      x: e.offset?.x ?? 0,
      y: e.offset?.y ?? 0,
      blur: e.radius ?? 0,
      spread: e.spread,
      color: anyColorToCss(e.color ?? { r: 0, g: 0, b: 0, a: 0.2 }) ?? '#00000033',
    }));
  if (shadows.length) style.shadows = shadows;
  if (figma.opacity !== undefined && figma.opacity < 1) style.opacity = figma.opacity;
  return style;
}

function extractTextStyle(figma: FigmaNode): TextStyle | undefined {
  if (figma.type !== 'TEXT') return undefined;
  const s = figma.style ?? {};
  const fill = (figma.fills ?? []).find(
    (f) => f.visible !== false && f.type === 'SOLID',
  );
  const alignMap: Record<string, 'left' | 'center' | 'right' | 'justify'> = {
    LEFT: 'left',
    CENTER: 'center',
    RIGHT: 'right',
    JUSTIFIED: 'justify',
  };
  return {
    content: figma.characters ?? '',
    fontFamily: s.fontFamily,
    fontSize: s.fontSize ?? 14,
    fontWeight: s.fontWeight ?? 400,
    color: anyColorToCss(fill?.color) ?? '#111111',
    lineHeight: s.lineHeightPx,
    letterSpacing: s.letterSpacing,
    textAlign: s.textAlignHorizontal
      ? alignMap[s.textAlignHorizontal]
      : undefined,
  };
}

function extractLayout(figma: FigmaNode): Layout {
  const layout: Layout = { type: 'absolute' };
  if (figma.layoutMode === 'HORIZONTAL' || figma.layoutMode === 'VERTICAL') {
    layout.type = 'flex';
    layout.direction = figma.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
    layout.gap = figma.itemSpacing;
    layout.wrap = figma.layoutWrap === 'WRAP';
    // Auto-layout from the source tool: full confidence.
    layout.confidence = 1;
    layout.source = 'figma-autolayout';
    switch (figma.primaryAxisAlignItems) {
      case 'MIN':
        layout.justifyContent = 'start';
        break;
      case 'CENTER':
        layout.justifyContent = 'center';
        break;
      case 'MAX':
        layout.justifyContent = 'end';
        break;
      case 'SPACE_BETWEEN':
        layout.justifyContent = 'space-between';
        break;
    }
    switch (figma.counterAxisAlignItems) {
      case 'MIN':
        layout.alignItems = 'start';
        break;
      case 'CENTER':
        layout.alignItems = 'center';
        break;
      case 'MAX':
        layout.alignItems = 'end';
        break;
    }
  }
  return layout;
}

function extractMeta(figma: FigmaNode): SourceMeta | undefined {
  const meta: NonNullable<SourceMeta['figma']> = {};

  if (figma.constraints) {
    meta.constraints = {
      horizontal: figma.constraints.horizontal,
      vertical: figma.constraints.vertical,
    };
  }
  if (figma.layoutMode === 'HORIZONTAL' || figma.layoutMode === 'VERTICAL') {
    meta.autoLayout = {
      direction: figma.layoutMode,
      primaryAlign: figma.primaryAxisAlignItems,
      counterAlign: figma.counterAxisAlignItems,
      itemSpacing: figma.itemSpacing,
      counterAxisSpacing: figma.counterAxisSpacing,
      layoutWrap: figma.layoutWrap,
      primarySizing: figma.primaryAxisSizingMode,
      counterSizing: figma.counterAxisSizingMode,
    };
  }
  if (figma.layoutSizingHorizontal || figma.layoutSizingVertical) {
    meta.sizing = {
      horizontal: figma.layoutSizingHorizontal,
      vertical: figma.layoutSizingVertical,
    };
  }
  if (figma.individualStrokeWeights) {
    meta.strokeWeights = figma.individualStrokeWeights;
  }
  if (figma.textAutoResize) {
    meta.textAutoResize = figma.textAutoResize;
  }
  if (figma.type === 'INSTANCE' && figma.componentId) {
    meta.instance = {
      componentId: figma.componentId,
      componentSetId: figma.componentSetId,
      componentName: figma.name,
      overrides: (figma.overrides ?? []).flatMap((o) => o.overriddenFields ?? []),
    };
  }
  if (figma.type === 'COMPONENT' || figma.type === 'COMPONENT_SET') {
    const variantProps: Record<string, string> = {};
    if (figma.componentProperties) {
      for (const [k, v] of Object.entries(figma.componentProperties)) {
        if (v && (v.type === 'VARIANT' || typeof v.value === 'string')) {
          variantProps[k] = String(v.value);
        }
      }
    }
    meta.component = {
      key: figma.id,
      name: figma.name,
      setKey: figma.componentSetId,
      variantProps: Object.keys(variantProps).length ? variantProps : undefined,
    };
  }

  return Object.keys(meta).length ? { figma: meta } : undefined;
}

function extractBox(figma: FigmaNode, parent?: FigmaNode): Box {
  const bb = figma.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const parentBB = parent?.absoluteBoundingBox;
  const relX = parentBB ? bb.x - parentBB.x : bb.x;
  const relY = parentBB ? bb.y - parentBB.y : bb.y;
  const padding: [number, number, number, number] | undefined =
    figma.paddingTop !== undefined ||
    figma.paddingRight !== undefined ||
    figma.paddingBottom !== undefined ||
    figma.paddingLeft !== undefined
      ? [
          figma.paddingTop ?? 0,
          figma.paddingRight ?? 0,
          figma.paddingBottom ?? 0,
          figma.paddingLeft ?? 0,
        ]
      : undefined;
  return {
    x: relX,
    y: relY,
    width: bb.width,
    height: bb.height,
    padding,
  };
}

function toIRNode(figma: FigmaNode, parent?: FigmaNode): IRNode {
  const type = mapType(figma);
  const assetRef = (figma.fills ?? []).find((f) => f.type === 'IMAGE')?.imageRef;
  const style = extractStyle(figma);
  // Text nodes: the fill represents text color, not a background.
  if (type === 'text' && style.backgroundColor) {
    delete style.backgroundColor;
  }
  const meta = extractMeta(figma);
  const node: IRNode = {
    id: figma.id,
    name: figma.name,
    type,
    box: extractBox(figma, parent),
    layout: extractLayout(figma),
    style,
    textStyle: extractTextStyle(figma),
    assetRef,
    children: (figma.children ?? [])
      .filter((c) => c.visible !== false)
      .map((c) => toIRNode(c, figma)),
  };
  if (meta) node.meta = meta;
  return node;
}

// 将一个 Canvas（页面）下的内容转为 IRDocument
function canvasToIRDocument(canvas: FigmaNode, docName?: string): IRDocument {
  const frame = canvas.children?.[0] ?? canvas;
  const bb = frame.absoluteBoundingBox ?? { x: 0, y: 0, width: 1440, height: 900 };
  const ir: IRDocument = {
    name: canvas.name ?? docName ?? 'Figma Design',
    width: bb.width,
    height: bb.height,
    root: toIRNode(frame),
  };
  validateIR(ir);
  return ir;
}

export function parseFigma(raw: unknown): IRDocument {
  if (!raw || typeof raw !== 'object')
    throw new Error('Figma input must be an object');
  const r = raw as FigmaFileResponse;
  if (!r.document) throw new Error('Figma response missing `document`');
  const doc = r.document;
  const firstCanvas = doc.children?.[0];
  const firstFrame = firstCanvas?.children?.[0] ?? firstCanvas ?? doc;
  const bb = firstFrame.absoluteBoundingBox ?? { x: 0, y: 0, width: 1440, height: 900 };
  const ir: IRDocument = {
    name: r.name ?? firstFrame.name ?? 'Figma Design',
    width: bb.width,
    height: bb.height,
    root: toIRNode(firstFrame),
  };
  validateIR(ir);
  return ir;
}

// 提取所有页面（Canvas），每个 Canvas 对应一个 IRDocument
export function parseFigmaMultiPage(raw: unknown): IRDocument[] {
  if (!raw || typeof raw !== 'object')
    throw new Error('Figma input must be an object');
  const r = raw as FigmaFileResponse;
  if (!r.document) throw new Error('Figma response missing `document`');
  const canvases = r.document.children ?? [];
  if (canvases.length === 0) return [parseFigma(raw)];
  return canvases.map((canvas) => canvasToIRDocument(canvas, r.name));
}
