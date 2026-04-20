/**
 * Text fidelity — compares text-node content + typography against
 * the generated code.
 *
 * We intentionally avoid OCR: it's heavy and unreliable for UI
 * screenshots at small font sizes.  Instead we verify that every
 * text node in the IR:
 *   1. Has its `content` string embedded verbatim in the generated
 *      files (HTML/JSX/Vue template).
 *   2. Has its `fontSize` / `fontWeight` values present in the
 *      generated CSS.
 *
 * This is a cheap proxy that catches the most common codegen
 * regressions: dropped characters, escaped entities, wrong weights.
 */
import type { IRDocument, IRNode } from '../ir/types';
import type { TextFidelityItem } from './types';
import type { GenerateResult } from '../codegen/base';
import { walk } from '../utils/tree';

export interface TextEvaluation {
  items: TextFidelityItem[];
  /** Aggregate 0..1 score. */
  aggregate: number;
}

function collectText(doc: IRDocument): IRNode[] {
  const out: IRNode[] = [];
  walk(doc.root, (n) => {
    if (n.type === 'text' && n.textStyle?.content) out.push(n);
  });
  return out;
}

/** Normalize whitespace and common HTML entity escapes for content search. */
function normalize(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function evaluateText(
  doc: IRDocument,
  generated: GenerateResult,
): TextEvaluation {
  const nodes = collectText(doc);
  if (nodes.length === 0) return { items: [], aggregate: 1 };

  const combinedCode = generated.files.map((f) => f.content).join('\n');
  const normalizedCode = normalize(combinedCode);

  const items: TextFidelityItem[] = [];
  let sum = 0;
  for (const n of nodes) {
    const ts = n.textStyle!;
    const content = ts.content;
    const needle = normalize(content);

    let score = 1;
    const reasons: string[] = [];

    // Content presence
    if (needle && !normalizedCode.includes(needle)) {
      // Try substring of longest word
      const words = needle.split(/\s+/).filter((w) => w.length >= 4);
      const anyWord = words.some((w) => normalizedCode.includes(w));
      score -= anyWord ? 0.4 : 0.8;
      reasons.push(anyWord ? 'partial content match' : 'content missing');
    }

    // Font size presence (robust across px / rem output)
    const sizeStr = `${ts.fontSize}px`;
    const sizeAltRem = `${(ts.fontSize / 16).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}rem`;
    if (
      !combinedCode.includes(sizeStr) &&
      !combinedCode.includes(sizeAltRem)
    ) {
      score -= 0.1;
      reasons.push(`fontSize ${ts.fontSize}px not found`);
    }

    // Font weight presence (numeric or named)
    const weight = ts.fontWeight;
    const weightNames: Record<number, string[]> = {
      100: ['thin'],
      200: ['extralight', 'ultralight'],
      300: ['light'],
      400: ['normal', 'regular'],
      500: ['medium'],
      600: ['semibold', 'demibold'],
      700: ['bold'],
      800: ['extrabold', 'ultrabold'],
      900: ['black', 'heavy'],
    };
    const names = weightNames[weight] ?? [];
    const weightHit =
      combinedCode.includes(`font-weight:${weight}`) ||
      combinedCode.includes(`font-weight: ${weight}`) ||
      combinedCode.includes(`fontWeight: ${weight}`) ||
      names.some((nm) => combinedCode.toLowerCase().includes(nm));
    if (!weightHit && weight && weight !== 400) {
      score -= 0.1;
      reasons.push(`fontWeight ${weight} not found`);
    }

    score = Math.max(0, Math.min(1, score));
    items.push({
      nodeId: n.id,
      content,
      fontSize: ts.fontSize,
      fontWeight: ts.fontWeight,
      color: ts.color,
      score,
      reason: reasons.length ? reasons.join(', ') : undefined,
    });
    sum += score;
  }

  return { items, aggregate: sum / items.length };
}
