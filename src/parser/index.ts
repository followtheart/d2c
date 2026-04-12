import type { IRDocument } from '../ir/types';
import { parseFigma } from './figmaParser';
import { parseNativeDesign } from './nativeParser';
import { parseSketch } from './sketchParser';

export type DesignFormat = 'figma' | 'native' | 'sketch' | 'auto';

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
    default:
      throw new Error(`Unsupported design format: ${fmt}`);
  }
}

function detect(raw: unknown): DesignFormat {
  if (!raw || typeof raw !== 'object') return 'native';
  const r = raw as Record<string, unknown>;
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

export { parseFigma, parseNativeDesign, parseSketch };
