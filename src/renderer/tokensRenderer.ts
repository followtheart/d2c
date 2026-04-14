/**
 * Tokens stage renderer.
 *
 * Renders the extracted design tokens as a style-guide page:
 *   - Color swatches grid
 *   - Font size / weight sample rows
 *   - Spacing scale bar chart
 *   - Border-radius sample rectangles
 *   - Shadow sample cards
 */
import type { StageSnapshot } from '../pipeline/verify';
import type { TokenSet } from '../tokens/extract';
import {
  type SnapshotRenderer,
  escHtml,
  wrapHtmlPage,
} from './snapshotRenderer';

// ── Section builders ──────────────────────────────────────────────────

function renderColors(colors: Record<string, string>): string {
  const entries = Object.entries(colors);
  if (!entries.length) return '';
  const swatches = entries
    .map(
      ([name, value]) =>
        `<div class="tk-swatch"><div class="tk-swatch-color" style="background:${value};"></div><div class="tk-swatch-label">${escHtml(name)}</div><div class="tk-swatch-value">${escHtml(value)}</div></div>`,
    )
    .join('');
  return `<div class="tk-section"><h3>Colors <span class="tk-count">${entries.length}</span></h3><div class="tk-swatch-grid">${swatches}</div></div>`;
}

function renderFontSizes(sizes: Record<string, number>): string {
  const entries = Object.entries(sizes);
  if (!entries.length) return '';
  const rows = entries
    .map(
      ([name, px]) =>
        `<div class="tk-font-row"><span class="tk-font-sample" style="font-size:${px}px;">Aa</span><span class="tk-font-meta">${escHtml(name)} — ${px}px</span></div>`,
    )
    .join('');
  return `<div class="tk-section"><h3>Font Sizes <span class="tk-count">${entries.length}</span></h3>${rows}</div>`;
}

function renderFontWeights(weights: Record<string, number>): string {
  const entries = Object.entries(weights);
  if (!entries.length) return '';
  const rows = entries
    .map(
      ([name, w]) =>
        `<div class="tk-font-row"><span class="tk-font-sample" style="font-weight:${w};">The quick brown fox</span><span class="tk-font-meta">${escHtml(name)} — ${w}</span></div>`,
    )
    .join('');
  return `<div class="tk-section"><h3>Font Weights <span class="tk-count">${entries.length}</span></h3>${rows}</div>`;
}

function renderSpacings(spacings: Record<string, number>): string {
  const entries = Object.entries(spacings);
  if (!entries.length) return '';
  const maxVal = Math.max(1, ...entries.map(([, v]) => v));
  const bars = entries
    .map(
      ([name, v]) =>
        `<div class="tk-spacing-row"><span class="tk-spacing-bar" style="width:${Math.round((v / maxVal) * 200)}px;"></span><span class="tk-spacing-label">${escHtml(name)} — ${v}px</span></div>`,
    )
    .join('');
  return `<div class="tk-section"><h3>Spacings <span class="tk-count">${entries.length}</span></h3>${bars}</div>`;
}

function renderRadii(radii: Record<string, number>): string {
  const entries = Object.entries(radii);
  if (!entries.length) return '';
  const items = entries
    .map(
      ([name, r]) =>
        `<div class="tk-radius-item"><div class="tk-radius-box" style="border-radius:${r}px;"></div><span class="tk-radius-label">${escHtml(name)} — ${r}px</span></div>`,
    )
    .join('');
  return `<div class="tk-section"><h3>Radii <span class="tk-count">${entries.length}</span></h3><div class="tk-radius-grid">${items}</div></div>`;
}

function renderShadows(shadows: Record<string, string>): string {
  const entries = Object.entries(shadows);
  if (!entries.length) return '';
  const cards = entries
    .map(
      ([name, s]) =>
        `<div class="tk-shadow-card" style="box-shadow:${s};"><span class="tk-shadow-name">${escHtml(name)}</span><span class="tk-shadow-value">${escHtml(s)}</span></div>`,
    )
    .join('');
  return `<div class="tk-section"><h3>Shadows <span class="tk-count">${entries.length}</span></h3><div class="tk-shadow-grid">${cards}</div></div>`;
}

// ── CSS ───────────────────────────────────────────────────────────────

const EXTRA_CSS = `
  .tk-section { margin-bottom: 24px; }
  .tk-section h3 { font-size: 14px; margin-bottom: 10px; color: #334155; }
  .tk-count { font-size: 11px; color: #94a3b8; font-weight: 400; }

  /* colors */
  .tk-swatch-grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .tk-swatch { width: 100px; text-align: center; }
  .tk-swatch-color { width: 100%; height: 56px; border-radius: 6px; border: 1px solid rgba(0,0,0,.08); }
  .tk-swatch-label { font-size: 11px; font-weight: 600; margin-top: 4px; color: #334155; }
  .tk-swatch-value { font-size: 10px; color: #94a3b8; word-break: break-all; }

  /* fonts */
  .tk-font-row { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; }
  .tk-font-sample { color: #1e293b; }
  .tk-font-meta { font-size: 11px; color: #64748b; }

  /* spacings */
  .tk-spacing-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .tk-spacing-bar { height: 10px; background: #818cf8; border-radius: 3px; }
  .tk-spacing-label { font-size: 11px; color: #64748b; }

  /* radii */
  .tk-radius-grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .tk-radius-item { text-align: center; }
  .tk-radius-box { width: 56px; height: 56px; border: 2px solid #818cf8; margin-bottom: 4px; }
  .tk-radius-label { font-size: 11px; color: #64748b; }

  /* shadows */
  .tk-shadow-grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .tk-shadow-card {
    width: 160px; height: 80px; border-radius: 8px; background: #fff;
    display: flex; flex-direction: column; justify-content: center;
    align-items: center; padding: 8px;
  }
  .tk-shadow-name { font-size: 12px; font-weight: 600; color: #334155; }
  .tk-shadow-value { font-size: 9px; color: #94a3b8; margin-top: 2px; text-align: center; word-break: break-all; }
`;

// ── Renderer ──────────────────────────────────────────────────────────

export const tokensRenderer: SnapshotRenderer = {
  stage: 'tokens',

  render(snapshot: StageSnapshot): string {
    const tokens = snapshot.tokens!;

    const sections = [
      renderColors(tokens.colors),
      renderFontSizes(tokens.fontSizes),
      renderFontWeights(tokens.fontWeights),
      renderSpacings(tokens.spacings),
      renderRadii(tokens.radii),
      renderShadows(tokens.shadows),
    ].join('');

    const totalTokens =
      Object.keys(tokens.colors).length +
      Object.keys(tokens.fontSizes).length +
      Object.keys(tokens.fontWeights).length +
      Object.keys(tokens.spacings).length +
      Object.keys(tokens.radii).length +
      Object.keys(tokens.shadows).length;

    const body = `
      <div class="stats-panel" style="margin-bottom:16px;">
        <h3>Token summary</h3>
        <div class="stats-row">
          <span class="stats-item">Total tokens: <span class="stats-value">${totalTokens}</span></span>
          <span class="stats-item">Colors: <span class="stats-value">${Object.keys(tokens.colors).length}</span></span>
          <span class="stats-item">Font sizes: <span class="stats-value">${Object.keys(tokens.fontSizes).length}</span></span>
          <span class="stats-item">Shadows: <span class="stats-value">${Object.keys(tokens.shadows).length}</span></span>
          <span class="stats-item">Duration: <span class="stats-value">${snapshot.durationMs}ms</span></span>
        </div>
      </div>
      ${sections}`;

    return wrapHtmlPage('Design Tokens', 'tokens', body, EXTRA_CSS);
  },
};
