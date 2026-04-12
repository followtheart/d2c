/**
 * Sketch parser (P1).
 *
 * A `.sketch` file is a ZIP archive containing:
 *   - document.json       — doc-wide references (shared styles, colors)
 *   - pages/<uuid>.json   — each page with nested layers
 *   - meta.json / user.json
 *
 * To keep d2c zero-dependency we don't ship a ZIP reader. Instead this
 * parser accepts one of:
 *   (a) the already-extracted JSON tree (object with `pages: {...}`), or
 *   (b) a single page JSON (object with top-level `layers: [...]`), or
 *   (c) the raw top-level document JSON with `{document, pages}`.
 *
 * The test suite exercises (b) — which is what you'd get from
 * `unzip -p design.sketch pages/<uuid>.json` — and that's enough to cover
 * the IR conversion logic. Shipping a ZIP reader is a trivial next step.
 *
 * The layer types mapped are the ones most common in UI designs:
 *   page, artboard, group, shapeGroup, rectangle, oval, text, bitmap,
 *   symbolInstance, slice.
 */
import type {
  Box,
  IRDocument,
  IRNode,
  IRNodeType,
  Style,
  TextStyle,
} from '../ir/types';
import { rgbaToCss } from '../utils/color';
import { validateIR } from '../ir/schema';

interface SketchFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SketchColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

interface SketchFillStyle {
  _class: 'fill';
  isEnabled?: boolean;
  fillType?: number; // 0 = color, 4 = pattern (image)
  color?: SketchColor;
}

interface SketchBorderStyle {
  _class: 'border';
  isEnabled?: boolean;
  thickness?: number;
  color?: SketchColor;
}

interface SketchShadowStyle {
  _class: 'shadow';
  isEnabled?: boolean;
  blurRadius?: number;
  offsetX?: number;
  offsetY?: number;
  spread?: number;
  color?: SketchColor;
}

interface SketchStyle {
  fills?: SketchFillStyle[];
  borders?: SketchBorderStyle[];
  shadows?: SketchShadowStyle[];
  contextSettings?: { opacity?: number };
  textStyle?: {
    encodedAttributes?: {
      MSAttributedStringFontAttribute?: {
        attributes?: { name?: string; size?: number };
      };
      MSAttributedStringColorAttribute?: SketchColor;
      paragraphStyle?: { alignment?: number };
    };
  };
}

interface SketchLayer {
  _class: string;
  do_objectID?: string;
  objectID?: string;
  name?: string;
  frame?: SketchFrame;
  style?: SketchStyle;
  fixedRadius?: number;
  stringValue?: string; // for text
  attributedString?: { string?: string };
  layers?: SketchLayer[];
  rotation?: number;
  isVisible?: boolean;
}

interface SketchPage extends SketchLayer {
  _class: 'page';
  layers: SketchLayer[];
}

interface SketchDocument {
  pages?: Record<string, SketchPage> | SketchPage[];
  document?: SketchDocument;
}

function sketchColor(c: SketchColor | undefined): string | undefined {
  if (!c) return undefined;
  return rgbaToCss({ r: c.red, g: c.green, b: c.blue, a: c.alpha });
}

function extractStyle(layer: SketchLayer): Style {
  const style: Style = {};
  const fill = (layer.style?.fills ?? []).find((f) => f.isEnabled !== false);
  if (fill?.fillType === 0 || fill?.fillType === undefined) {
    const c = sketchColor(fill?.color);
    if (c) style.backgroundColor = c;
  }
  const border = (layer.style?.borders ?? []).find(
    (b) => b.isEnabled !== false,
  );
  if (border?.thickness && border.color) {
    style.border = {
      width: border.thickness,
      color: sketchColor(border.color) ?? '#000000',
      style: 'solid',
    };
  }
  const shadows = (layer.style?.shadows ?? []).filter(
    (s) => s.isEnabled !== false,
  );
  if (shadows.length) {
    style.shadows = shadows.map((s) => ({
      x: s.offsetX ?? 0,
      y: s.offsetY ?? 0,
      blur: s.blurRadius ?? 0,
      spread: s.spread,
      color: sketchColor(s.color) ?? '#00000033',
    }));
  }
  if (layer.fixedRadius !== undefined) style.borderRadius = layer.fixedRadius;
  const opacity = layer.style?.contextSettings?.opacity;
  if (opacity !== undefined && opacity < 1) style.opacity = opacity;
  return style;
}

function extractTextStyle(layer: SketchLayer): TextStyle | undefined {
  if (layer._class !== 'text') return undefined;
  const enc = layer.style?.textStyle?.encodedAttributes;
  const font = enc?.MSAttributedStringFontAttribute?.attributes;
  const color = sketchColor(enc?.MSAttributedStringColorAttribute);
  const alignMap: Record<number, 'left' | 'center' | 'right' | 'justify'> = {
    0: 'left',
    1: 'right',
    2: 'center',
    3: 'justify',
  };
  const alignment = enc?.paragraphStyle?.alignment;
  return {
    content: layer.stringValue ?? layer.attributedString?.string ?? '',
    fontFamily: font?.name,
    fontSize: font?.size ?? 14,
    fontWeight: /bold/i.test(font?.name ?? '')
      ? 700
      : /semibold/i.test(font?.name ?? '')
        ? 600
        : 400,
    color: color ?? '#111111',
    textAlign: alignment !== undefined ? alignMap[alignment] : undefined,
  };
}

function mapType(layer: SketchLayer): IRNodeType {
  switch (layer._class) {
    case 'text':
      return 'text';
    case 'bitmap':
      return 'image';
    case 'artboard':
    case 'group':
    case 'shapeGroup':
    case 'symbolInstance':
    case 'rectangle':
    case 'oval':
      return 'container';
    default:
      return 'container';
  }
}

function toIRNode(layer: SketchLayer): IRNode {
  const frame = layer.frame ?? { x: 0, y: 0, width: 0, height: 0 };
  const box: Box = {
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
  };

  const node: IRNode = {
    id:
      layer.do_objectID ??
      layer.objectID ??
      `sketch_${Math.random().toString(36).slice(2, 8)}`,
    name: layer.name ?? layer._class,
    type: mapType(layer),
    box,
    layout: { type: 'absolute' },
    style: extractStyle(layer),
    textStyle: extractTextStyle(layer),
    children: (layer.layers ?? [])
      .filter((l) => l.isVisible !== false)
      .map((l) => toIRNode(l)),
  };
  return node;
}

function pickRootLayer(raw: SketchDocument | SketchPage | SketchLayer): SketchLayer {
  // (a) raw document with pages
  const doc = (raw as SketchDocument).document ?? (raw as SketchDocument);
  const pages = (doc as SketchDocument).pages;
  if (pages) {
    const arr = Array.isArray(pages) ? pages : Object.values(pages);
    if (arr.length) {
      const page = arr[0];
      // An artboard inside the page is preferred as root
      const artboard = (page.layers ?? []).find((l) => l._class === 'artboard');
      return artboard ?? page;
    }
  }
  // (b) a single page / artboard / layer directly
  const layerLike = raw as SketchLayer;
  if (layerLike._class && layerLike.layers) {
    if (layerLike._class === 'page') {
      const artboard = layerLike.layers.find((l) => l._class === 'artboard');
      return artboard ?? layerLike;
    }
    return layerLike;
  }
  throw new Error('Sketch input: could not find a page/artboard root');
}

export function parseSketch(raw: unknown): IRDocument {
  if (!raw || typeof raw !== 'object')
    throw new Error('Sketch input must be an object');
  const root = pickRootLayer(raw as SketchDocument);
  const rootIR = toIRNode(root);
  const width =
    typeof rootIR.box.width === 'number' ? rootIR.box.width : 0;
  const height =
    typeof rootIR.box.height === 'number' ? rootIR.box.height : 0;
  // Normalize root position to 0,0 so downstream layout inference doesn't
  // get confused by artboard origins.
  rootIR.box.x = 0;
  rootIR.box.y = 0;
  // Sketch child frames are relative to their parent. Our layout inference
  // expects absolute coordinates within the root, so flatten them.
  flattenCoordinates(rootIR, 0, 0);
  const doc: IRDocument = {
    name: root.name ?? 'SketchDesign',
    width,
    height,
    root: rootIR,
  };
  validateIR(doc);
  return doc;
}

function flattenCoordinates(node: IRNode, ox: number, oy: number): void {
  node.box.x = ox + node.box.x;
  node.box.y = oy + node.box.y;
  for (const c of node.children) {
    flattenCoordinates(c, node.box.x, node.box.y);
  }
}
