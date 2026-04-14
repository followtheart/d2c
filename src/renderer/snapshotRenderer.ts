/**
 * Snapshot Renderer — shared interface and utilities.
 *
 * Every per-stage renderer implements `SnapshotRenderer.render()` which
 * takes a `StageSnapshot` (from the verify pipeline) and returns a
 * self-contained HTML string suitable for screenshot or browser preview.
 */
import type { IRNode, IRDocument, Box, Style, Layout } from '../ir/types';
import type { StageSnapshot, StageName } from '../pipeline/verify';
import type { TokenSet } from '../tokens/extract';
import type { GenerateResult } from '../codegen/base';

// ── Public interface ──────────────────────────────────────────────────

export interface SnapshotRenderer {
  stage: StageName;
  render(snapshot: StageSnapshot): string;
}

// ── Node-type colour palette ──────────────────────────────────────────

export const NODE_TYPE_COLORS: Record<string, string> = {
  container: '#3b82f6',
  text: '#22c55e',
  image: '#f97316',
  icon: '#a855f7',
  button: '#ef4444',
  input: '#06b6d4',
  list: '#8b5cf6',
  'list-item': '#a78bfa',
};

// ── Semantic-role colour palette ──────────────────────────────────────

export const ROLE_COLORS: Record<string, string> = {
  header: '#3b82f6',
  nav: '#10b981',
  footer: '#6b7280',
  main: '#f59e0b',
  aside: '#8b5cf6',
  section: '#06b6d4',
  card: '#fbbf24',
  form: '#ec4899',
  list: '#a855f7',
  'list-item': '#c084fc',
  button: '#ef4444',
  link: '#2563eb',
  heading: '#1d4ed8',
  paragraph: '#64748b',
  label: '#84cc16',
  icon: '#d946ef',
  avatar: '#f43f5e',
  badge: '#fb923c',
  divider: '#9ca3af',
};

// ── Layout-type labels ────────────────────────────────────────────────

export const LAYOUT_ICONS: Record<string, string> = {
  flex: '⟷',
  grid: '⊞',
  absolute: '⊕',
};

// ── Utility helpers ───────────────────────────────────────────────────

export function numericWidth(w: number | 'auto' | 'fill'): number {
  return typeof w === 'number' ? w : 0;
}

export function numericHeight(h: number | 'auto' | 'fill'): number {
  return typeof h === 'number' ? h : 0;
}

export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function boxToPosition(box: Box): string {
  const w = typeof box.width === 'number' ? `${box.width}px` : box.width;
  const h = typeof box.height === 'number' ? `${box.height}px` : box.height;
  return `left:${box.x}px;top:${box.y}px;width:${w};height:${h};position:absolute;`;
}

export function bgFromStyle(style: Style): string {
  if (style.backgroundColor) return style.backgroundColor;
  return 'transparent';
}

// ── HTML page wrapper ─────────────────────────────────────────────────

export function wrapHtmlPage(
  title: string,
  stageName: string,
  bodyContent: string,
  extraCss = '',
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(title)} — ${escHtml(stageName)} stage</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f0f2f5;
    color: #333;
    padding: 24px;
  }
  .stage-header {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 20px;
  }
  .stage-header h1 { font-size: 18px; font-weight: 600; }
  .stage-badge {
    display: inline-block; padding: 2px 10px; border-radius: 12px;
    font-size: 12px; font-weight: 600; color: #fff;
    background: #6366f1; text-transform: uppercase; letter-spacing: .5px;
  }
  .canvas-wrapper {
    position: relative; background: #fff; border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,.1); overflow: hidden;
    display: inline-block;
  }
  .legend { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 10px; }
  .legend-item {
    display: flex; align-items: center; gap: 4px; font-size: 11px; color: #666;
  }
  .legend-swatch {
    width: 12px; height: 12px; border-radius: 3px; border: 1px solid rgba(0,0,0,.15);
  }
  .stats-panel {
    margin-top: 16px; padding: 12px 16px; background: #fff;
    border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1);
    font-size: 12px; color: #555;
  }
  .stats-panel h3 { font-size: 13px; margin-bottom: 6px; }
  .stats-row { display: flex; gap: 20px; flex-wrap: wrap; }
  .stats-item { display: flex; align-items: center; gap: 4px; }
  .stats-value { font-weight: 600; color: #333; }
  ${extraCss}
</style>
</head>
<body>
  <div class="stage-header">
    <span class="stage-badge">${escHtml(stageName)}</span>
    <h1>${escHtml(title)}</h1>
  </div>
  ${bodyContent}
</body>
</html>`;
}

// ── Legend builder ─────────────────────────────────────────────────────

export function buildLegend(
  items: { label: string; color: string }[],
): string {
  return `<div class="legend">${items
    .map(
      (it) =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${it.color}"></span>${escHtml(it.label)}</span>`,
    )
    .join('')}</div>`;
}
