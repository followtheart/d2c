import type { IRDocument } from '../ir/types';
import { parseFigma } from './figmaParser';
import { parseNativeDesign } from './nativeParser';

export type DesignFormat = 'figma' | 'native' | 'auto';

/**
 * Dispatch a raw design JSON to the right parser.
 * - "figma": Figma REST API shape ({document: {children: [...]}})
 * - "native": d2c's own simplified JSON (canonical design schema)
 * - "auto":   detect by shape
 */
export function parseDesign(raw: unknown, format: DesignFormat = 'auto'): IRDocument {
  const fmt = format === 'auto' ? detect(raw) : format;
  switch (fmt) {
    case 'figma':
      return parseFigma(raw);
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
  if (r.document && typeof r.document === 'object') return 'figma';
  if (r.schemaVersion && r.pages) return 'figma';
  // Our own "native" format has a top-level root + width/height
  if (r.root && typeof r.width === 'number') return 'native';
  return 'native';
}

export { parseFigma, parseNativeDesign };
