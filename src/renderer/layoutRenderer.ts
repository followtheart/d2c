/**
 * Layout stage renderer.
 *
 * Builds on the parse wireframe and overlays layout-inference results:
 *   - Layout type badges (flex ⟷ / grid ⊞ / absolute ⊕)
 *   - Flex direction arrows + justify/align labels
 *   - Gap value annotations
 *   - Bottom statistics panel with layout distribution
 */
import type { IRNode } from '../ir/types';
import type { StageSnapshot } from '../pipeline/verify';
import {
  type SnapshotRenderer,
  NODE_TYPE_COLORS,
  LAYOUT_ICONS,
  numericWidth,
  numericHeight,
  escHtml,
  wrapHtmlPage,
  buildLegend,
} from './snapshotRenderer';

// ── Layout annotation text ────────────────────────────────────────────

function layoutAnnotation(node: IRNode): string {
  const lt = node.layout;
  if (!lt) return '';
  const icon = LAYOUT_ICONS[lt.type] ?? '';
  const parts: string[] = [icon, lt.type];

  if (lt.type === 'flex') {
    if (lt.direction) parts.push(lt.direction === 'row' ? '→' : '↓');
    if (lt.justifyContent) parts.push(`J:${lt.justifyContent}`);
    if (lt.alignItems) parts.push(`A:${lt.alignItems}`);
  }
  if (lt.type === 'grid' && lt.columns) {
    parts.push(`cols:${lt.columns}`);
  }
  if (lt.gap !== undefined && lt.gap > 0) {
    parts.push(`gap:${lt.gap}`);
  }
  return parts.join(' ');
}

// ── Recursive render ──────────────────────────────────────────────────

function renderLayoutNode(node: IRNode, depth: number): string {
  const w = numericWidth(node.box.width);
  const h = numericHeight(node.box.height);
  const borderColor = NODE_TYPE_COLORS[node.type] ?? '#888';

  const lt = node.layout;
  const layoutClass =
    lt?.type === 'flex'
      ? 'layout-flex'
      : lt?.type === 'grid'
        ? 'layout-grid'
        : 'layout-abs';

  const annotation = layoutAnnotation(node);

  const textContent =
    node.type === 'text' && node.textStyle
      ? `<span class="lt-text">${escHtml(node.textStyle.content)}</span>`
      : '';

  const childrenHtml = node.children
    .map((c) => renderLayoutNode(c, depth + 1))
    .join('');

  const hasChildren = node.children.length > 0;
  const annotationHtml = hasChildren && annotation
    ? `<span class="lt-annotation">${escHtml(annotation)}</span>`
    : '';

  return `<div class="lt-node ${layoutClass}" style="left:${node.box.x}px;top:${node.box.y}px;width:${w}px;height:${h}px;border-color:${borderColor};" title="${escHtml(node.name)}">
  <span class="lt-label" style="background:${borderColor};">${escHtml(node.name)}</span>
  ${annotationHtml}
  ${textContent}
  ${childrenHtml}
</div>`;
}

// ── Count helper ──────────────────────────────────────────────────────

function countLayouts(root: IRNode): Record<string, number> {
  const counts: Record<string, number> = { flex: 0, grid: 0, absolute: 0 };
  const queue: IRNode[] = [root];
  while (queue.length) {
    const n = queue.pop()!;
    const t = n.layout?.type;
    if (t && t in counts) counts[t]++;
    queue.push(...n.children);
  }
  return counts;
}

function countNodes(root: IRNode): number {
  let c = 0;
  const queue: IRNode[] = [root];
  while (queue.length) {
    queue.pop();
    c++;
    // pushed below
  }
  // redo properly
  c = 0;
  const stack: IRNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    c++;
    stack.push(...n.children);
  }
  return c;
}

// ── Layout-type colours for legend ────────────────────────────────────

const LAYOUT_COLORS: Record<string, string> = {
  flex: '#8b5cf6',
  grid: '#f59e0b',
  absolute: '#6b7280',
};

// ── CSS ───────────────────────────────────────────────────────────────

const EXTRA_CSS = `
  .lt-node {
    position: absolute;
    border: 1.5px solid;
    border-radius: 2px;
    overflow: visible;
  }
  .lt-node.layout-flex { border-style: solid; }
  .lt-node.layout-grid { border-style: dashed; }
  .lt-node.layout-abs  { border-style: dotted; }
  .lt-label {
    position: absolute; top: -1px; left: -1px;
    font-size: 9px; line-height: 1;
    padding: 1px 4px; border-radius: 0 0 3px 0;
    color: #fff; white-space: nowrap; pointer-events: none;
    max-width: 120px; overflow: hidden; text-overflow: ellipsis;
  }
  .lt-annotation {
    position: absolute; bottom: 1px; left: 3px;
    font-size: 8px; padding: 0 3px; border-radius: 2px;
    background: rgba(139,92,246,.15); color: #7c3aed;
    white-space: nowrap; pointer-events: none;
  }
  .lt-text {
    display: block; padding: 14px 4px 4px;
    font-size: 10px; color: #555;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
`;

// ── Renderer ──────────────────────────────────────────────────────────

export const layoutRenderer: SnapshotRenderer = {
  stage: 'layout',

  render(snapshot: StageSnapshot): string {
    const doc = snapshot.ir!;
    const w = numericWidth(doc.root.box.width) || doc.width;
    const h = numericHeight(doc.root.box.height) || doc.height;

    const nodesHtml = renderLayoutNode(doc.root, 0);

    const layoutCounts = countLayouts(doc.root);
    const total = countNodes(doc.root);

    const legendItems = Object.entries(LAYOUT_COLORS).map(([t, c]) => ({
      label: `${t}: ${layoutCounts[t] ?? 0}`,
      color: c,
    }));

    const body = `
      <div class="canvas-wrapper" style="width:${w}px;height:${h}px;">
        ${nodesHtml}
      </div>
      ${buildLegend(legendItems)}
      <div class="stats-panel">
        <h3>Layout summary</h3>
        <div class="stats-row">
          <span class="stats-item">Total nodes: <span class="stats-value">${total}</span></span>
          <span class="stats-item">flex: <span class="stats-value">${layoutCounts.flex}</span></span>
          <span class="stats-item">grid: <span class="stats-value">${layoutCounts.grid}</span></span>
          <span class="stats-item">absolute: <span class="stats-value">${layoutCounts.absolute}</span></span>
          <span class="stats-item">Duration: <span class="stats-value">${snapshot.durationMs}ms</span></span>
        </div>
      </div>`;

    return wrapHtmlPage(doc.name, 'layout', body, EXTRA_CSS);
  },
};
