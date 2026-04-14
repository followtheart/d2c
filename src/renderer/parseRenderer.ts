/**
 * Parse stage renderer.
 *
 * Renders the raw IRDocument as an absolutely-positioned wireframe.
 * Each node is drawn as a div with a coloured border keyed to its
 * `type` — container (blue), text (green), image (orange), etc.
 * Text nodes display their actual content; all nodes show name + size.
 */
import type { IRNode, IRDocument } from '../ir/types';
import type { StageSnapshot } from '../pipeline/verify';
import {
  type SnapshotRenderer,
  NODE_TYPE_COLORS,
  numericWidth,
  numericHeight,
  escHtml,
  wrapHtmlPage,
  buildLegend,
} from './snapshotRenderer';

// ── Recursive node → HTML ─────────────────────────────────────────────

export function renderParseNode(node: IRNode, depth: number): string {
  const w = numericWidth(node.box.width);
  const h = numericHeight(node.box.height);
  const color = NODE_TYPE_COLORS[node.type] ?? '#888';

  const label = `${escHtml(node.name)} (${node.type})`;
  const dims = `${w}×${h}`;

  const textContent =
    node.type === 'text' && node.textStyle
      ? `<span class="parse-text">${escHtml(node.textStyle.content)}</span>`
      : '';

  const childrenHtml = node.children
    .map((c) => renderParseNode(c, depth + 1))
    .join('');

  return `<div class="parse-node" style="left:${node.box.x}px;top:${node.box.y}px;width:${w}px;height:${h}px;border-color:${color};" title="${escHtml(label)}">
  <span class="parse-label" style="background:${color};">${escHtml(node.name)}</span>
  <span class="parse-dims">${dims}</span>
  ${textContent}
  ${childrenHtml}
</div>`;
}

// ── Count helper ──────────────────────────────────────────────────────

function countByType(root: IRNode): Record<string, number> {
  const counts: Record<string, number> = {};
  const queue: IRNode[] = [root];
  while (queue.length) {
    const n = queue.pop()!;
    counts[n.type] = (counts[n.type] ?? 0) + 1;
    queue.push(...n.children);
  }
  return counts;
}

// ── Renderer ──────────────────────────────────────────────────────────

const EXTRA_CSS = `
  .parse-node {
    position: absolute;
    border: 1.5px solid;
    border-radius: 2px;
    overflow: visible;
  }
  .parse-label {
    position: absolute; top: -1px; left: -1px;
    font-size: 9px; line-height: 1;
    padding: 1px 4px; border-radius: 0 0 3px 0;
    color: #fff; white-space: nowrap; pointer-events: none;
    max-width: 120px; overflow: hidden; text-overflow: ellipsis;
  }
  .parse-dims {
    position: absolute; bottom: 1px; right: 3px;
    font-size: 8px; color: #999; pointer-events: none;
  }
  .parse-text {
    display: block; padding: 14px 4px 4px;
    font-size: 10px; color: #555;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
`;

export const parseRenderer: SnapshotRenderer = {
  stage: 'parse',

  render(snapshot: StageSnapshot): string {
    const doc = snapshot.ir!;
    const w = numericWidth(doc.root.box.width) || doc.width;
    const h = numericHeight(doc.root.box.height) || doc.height;

    const nodesHtml = renderParseNode(doc.root, 0);

    const counts = countByType(doc.root);
    const legendItems = Object.entries(NODE_TYPE_COLORS)
      .filter(([t]) => counts[t])
      .map(([t, c]) => ({ label: `${t} (${counts[t]})`, color: c }));

    const totalNodes = Object.values(counts).reduce((a, b) => a + b, 0);

    const body = `
      <div class="canvas-wrapper" style="width:${w}px;height:${h}px;">
        ${nodesHtml}
      </div>
      ${buildLegend(legendItems)}
      <div class="stats-panel">
        <h3>Parse summary</h3>
        <div class="stats-row">
          <span class="stats-item">Nodes: <span class="stats-value">${totalNodes}</span></span>
          <span class="stats-item">Document: <span class="stats-value">${w}×${h}</span></span>
          <span class="stats-item">Duration: <span class="stats-value">${snapshot.durationMs}ms</span></span>
        </div>
      </div>`;

    return wrapHtmlPage(doc.name, 'parse', body, EXTRA_CSS);
  },
};
