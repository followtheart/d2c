/**
 * Figma Make → Render Tree Converter
 *
 * Builds a RenderDocument from a decoded MakeDocument, preserving visual
 * details for faithful SVG / HTML rendering.  Similar in spirit to
 * sketchRenderTree.ts but for .make files.
 *
 * .make files may contain both design nodes (visual frames) and code file
 * entries.  This module handles the design node → RenderNode conversion;
 * the code files are surfaced separately through MakeRenderResult.
 */
import type {
  RenderNode,
  RenderNodeType,
  RenderDocument,
  RenderArtboard,
  RenderFill,
  RenderBorder,
  RenderShadow,
  RenderText,
  RenderTextRun,
  SketchRenderOptions,
} from './types';
import type { MakeNode, MakeDocument, MakeCodeFile, MakePaint, MakeEffect } from '../parser/makeParser';

/* ── Options ─────────────────────────────────────────────────────────── */

export interface MakeRenderOptions extends SketchRenderOptions {
  /** Whether to include code files in the result (default true). */
  includeCode?: boolean;
}

/* ── Result ──────────────────────────────────────────────────────────── */

export interface MakeRenderResult {
  renderDoc: RenderDocument;
  codeFiles: MakeCodeFile[];
}

/* ── Node Type Mapping ───────────────────────────────────────────────── */

function mapRenderType(type: string): RenderNodeType {
  switch (type) {
    case 'TEXT':        return 'text';
    case 'RECTANGLE':  return 'rectangle';
    case 'ELLIPSE':    return 'oval';
    case 'IMAGE':      return 'image';
    case 'GROUP':      return 'group';
    case 'STAR':       return 'star';
    case 'POLYGON':    return 'polygon';
    case 'VECTOR':
    case 'LINE':       return 'path';
    case 'INSTANCE':   return 'symbolInstance';
    default:           return 'rectangle'; // FRAME, COMPONENT, SECTION, etc.
  }
}

/* ── Color Helpers ───────────────────────────────────────────────────── */

function colorToCss(c: { r: number; g: number; b: number; a?: number }): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const a = c.a ?? 1;
  if (a >= 1) return `#${hex(r)}${hex(g)}${hex(b)}`;
  return `rgba(${r},${g},${b},${round(a)})`;
}

function hex(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
}

function round(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/* ── Paint / Effect → Render Types ───────────────────────────────────── */

function convertFill(paint: MakePaint): RenderFill | null {
  if (paint.visible === false) return null;
  if (paint.color) {
    return {
      type: 'color',
      color: colorToCss(paint.color),
      opacity: paint.opacity,
    };
  }
  // Pattern / image fills
  if (paint.imageRef) {
    return { type: 'pattern', patternRef: paint.imageRef };
  }
  return null;
}

function convertShadow(effect: MakeEffect): RenderShadow | null {
  if (effect.visible === false) return null;
  if (effect.type !== 'DROP_SHADOW' && effect.type !== 'dropShadow' &&
      effect.type !== 'INNER_SHADOW' && effect.type !== 'innerShadow') return null;
  return {
    x: effect.offset?.x ?? 0,
    y: effect.offset?.y ?? 0,
    blur: effect.radius ?? 0,
    spread: effect.spread ?? 0,
    color: effect.color ? colorToCss(effect.color) : 'rgba(0,0,0,0.25)',
  };
}

/* ── MakeNode → RenderNode ───────────────────────────────────────────── */

function convertNode(mk: MakeNode, opts: MakeRenderOptions): RenderNode {
  const fills: RenderFill[] = (mk.fills ?? [])
    .map(convertFill)
    .filter((f): f is RenderFill => f !== null);

  const borders: RenderBorder[] = (mk.strokes ?? [])
    .filter((s) => s.visible !== false && s.color)
    .map((s) => ({
      color: colorToCss(s.color!),
      thickness: mk.strokeWeight ?? 1,
      position: 'center' as const,
      opacity: s.opacity,
    }));

  const shadows: RenderShadow[] = [];
  const innerShadows: RenderShadow[] = [];
  for (const eff of mk.effects ?? []) {
    const s = convertShadow(eff);
    if (!s) continue;
    if (eff.type === 'INNER_SHADOW' || eff.type === 'innerShadow') {
      innerShadows.push(s);
    } else {
      shadows.push(s);
    }
  }

  // Text
  let text: RenderText | undefined;
  if (mk.type === 'TEXT' || mk.characters) {
    const content = mk.characters ?? '';
    const textFill = mk.fills?.find((f) => f.visible !== false && f.color);
    const run: RenderTextRun = {
      content,
      style: {
        fontFamily: mk.fontFamily ?? 'Inter',
        fontSize: mk.fontSize ?? 14,
        fontWeight: mk.fontWeight ?? 400,
        color: textFill?.color ? colorToCss(textFill.color) : '#111111',
        lineHeight: mk.lineHeightPx,
        letterSpacing: mk.letterSpacing,
        textAlign: (mk.textAlignHorizontal?.toLowerCase() ?? 'left') as 'left' | 'center' | 'right' | 'justify',
      },
    };
    text = { content, runs: [run] };
  }

  // Children
  const children = (mk.children ?? [])
    .filter((c) => opts.includeHidden || c.visible !== false)
    .map((c) => convertNode(c, opts));

  return {
    id: mk.id,
    name: mk.name,
    type: mapRenderType(mk.type),
    frame: { x: mk.x, y: mk.y, width: mk.width, height: mk.height },
    rotation: 0,
    opacity: mk.opacity ?? 1,
    isVisible: mk.visible !== false,
    clipContent: false,
    hasClippingMask: false,
    fills,
    borders,
    shadows,
    innerShadows,
    borderRadius: mk.cornerRadius,
    children,
    text,
    imageRef: mk.fills?.find((f) => f.type === 'IMAGE')?.imageRef,
    sketchClass: mk.type.toLowerCase(),
  };
}

/* ── Public API ──────────────────────────────────────────────────────── */

/**
 * Build a RenderDocument from a decoded MakeDocument.
 */
export function buildMakeRenderTree(
  doc: MakeDocument,
  options?: MakeRenderOptions,
): MakeRenderResult {
  const opts: MakeRenderOptions = {
    scale: 1,
    includeHidden: false,
    includeCode: true,
    ...options,
  };

  const artboards: RenderArtboard[] = doc.nodes
    .filter((n) => opts.includeHidden || n.visible !== false)
    .map((node) => {
      const root = convertNode(node, opts);
      // Determine background colour from fills
      const bgFill = node.fills?.find((f) => f.visible !== false && f.color);
      return {
        name: node.name,
        frame: { x: 0, y: 0, width: node.width, height: node.height },
        backgroundColor: bgFill?.color ? colorToCss(bgFill.color) : '#ffffff',
        root,
      };
    });

  // If no artboard-level nodes, create a synthetic one wrapping everything
  if (artboards.length === 0 && doc.nodes.length > 0) {
    const allChildren = doc.nodes
      .filter((n) => opts.includeHidden || n.visible !== false)
      .map((n) => convertNode(n, opts));
    artboards.push({
      name: doc.name,
      frame: { x: 0, y: 0, width: doc.width, height: doc.height },
      backgroundColor: '#ffffff',
      root: {
        id: 'make-artboard-root',
        name: doc.name,
        type: 'rectangle',
        frame: { x: 0, y: 0, width: doc.width, height: doc.height },
        rotation: 0,
        opacity: 1,
        isVisible: true,
        clipContent: true,
        hasClippingMask: false,
        fills: [],
        borders: [],
        shadows: [],
        innerShadows: [],
        children: allChildren,
        sketchClass: 'artboard',
      },
    });
  }

  return {
    renderDoc: { name: doc.name, artboards },
    codeFiles: opts.includeCode !== false ? doc.codeFiles : [],
  };
}
