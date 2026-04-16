import type { IRDocument, IRMultiPageDocument } from '../ir/types';
import { parseFigma, parseFigmaMultiPage } from './figmaParser';
import { parseNativeDesign, parseNativeDesignMultiPage } from './nativeParser';
import { parseSketch, parseSketchMultiPage } from './sketchParser';
import { parseMakeJson, parseMakeJsonMultiPage, isMakeJson } from './makeParser';

export type DesignFormat = 'figma' | 'native' | 'sketch' | 'make' | 'fig' | 'auto';

/**
 * Dispatch a raw design JSON to the right parser.
 * - "figma":  Figma REST API shape ({document: {children: [...]}})
 * - "sketch": Sketch document JSON (pre-extracted from .sketch ZIP)
 * - "native": d2c's own simplified JSON (canonical design schema)
 * - "auto":   detect by shape
 */
export function parseDesign(raw: unknown, format: DesignFormat = 'auto'): IRDocument {
  const fmt = format === 'auto' ? detect(raw) : format;
  switch (fmt) {
    case 'figma':
      return parseFigma(raw);
    case 'sketch':
      return parseSketch(raw);
    case 'native':
      return parseNativeDesign(raw);
    case 'make':
      return parseMakeJson(raw);
    case 'fig':
      throw new Error(
        'The .fig binary format requires async parsing. ' +
        'Use parseFig() from parser/figBinaryParser instead, ' +
        'or let the CLI handle .fig files automatically.',
      );
    default:
      throw new Error(`Unsupported design format: ${fmt}`);
  }
}

function detect(raw: unknown): DesignFormat {
  if (!raw || typeof raw !== 'object') return 'native';
  const r = raw as Record<string, unknown>;
  // Figma Make decoded JSON — nodes[] with Figma node types + optional codeFiles[]
  if (isMakeJson(raw)) return 'make';
  // Figma REST API shape
  if (r.document && typeof r.document === 'object' &&
      !(r.document as Record<string, unknown>)._class) {
    return 'figma';
  }
  if (r.schemaVersion && r.pages) return 'figma';
  // Sketch — top-level objects always carry a `_class` discriminator
  if (typeof r._class === 'string') return 'sketch';
  if (r.pages && typeof r.pages === 'object') {
    const first = Array.isArray(r.pages)
      ? (r.pages as unknown[])[0]
      : Object.values(r.pages as Record<string, unknown>)[0];
    if (first && typeof first === 'object' && '_class' in (first as object))
      return 'sketch';
  }
  // Our own "native" format has a top-level root + width/height
  if (r.root && typeof r.width === 'number') return 'native';
  return 'native';
}

// 解析为多页面文档：提取所有页面
export function parseDesignMultiPage(raw: unknown, format: DesignFormat = 'auto'): IRMultiPageDocument {
  const fmt = format === 'auto' ? detect(raw) : format;
  let pages: IRDocument[];
  switch (fmt) {
    case 'figma':
      pages = parseFigmaMultiPage(raw);
      break;
    case 'sketch':
      pages = parseSketchMultiPage(raw);
      break;
    case 'native':
      pages = parseNativeDesignMultiPage(raw);
      break;
    case 'make':
      pages = parseMakeJsonMultiPage(raw);
      break;
    case 'fig':
      throw new Error(
        'The .fig binary format requires async parsing. ' +
        'Use parseFigMultiPage() from parser/figBinaryParser instead, ' +
        'or let the CLI handle .fig files automatically.',
      );
    default:
      throw new Error(`Unsupported design format: ${fmt}`);
  }
  const docName = pages[0]?.name ?? 'Untitled';
  return { name: docName, pages };
}

export { parseFigma, parseFigmaMultiPage, parseNativeDesign, parseNativeDesignMultiPage, parseSketch, parseSketchMultiPage };
export { parseMakeJson, parseMakeJsonMultiPage, isMakeJson } from './makeParser';
export type { MakeDocument, MakeNode, MakeCodeFile } from './makeParser';
export { parseFig, parseFigMultiPage, parseFigByFrames, parseFigBinary, isFigBinary } from './figBinaryParser';
export type { FigDocument, FigPage } from './figBinaryParser';
