/**
 * Semantics stage renderer.
 *
 * Builds on the layout wireframe and overlays semantic-enhancement info:
 *   - Semi-transparent background colour per `semantics.role`
 *   - Role badge (top-left) + componentName badge (top-right)
 *   - Dashed border for interactive nodes
 *   - Right-side panel with role distribution
 */
import type { IRNode } from '../ir/types';
import type { StageSnapshot } from '../pipeline/verify';
import {
  type SnapshotRenderer,
  NODE_TYPE_COLORS,
  ROLE_COLORS,
  LAYOUT_ICONS,
  numericWidth,
  numericHeight,
  escHtml,
  wrapHtmlPage,
  buildLegend,
} from './snapshotRenderer';

// ── Recursive render ──────────────────────────────────────────────────

function renderSemNode(node: IRNode, depth: number): string {
  const w = numericWidth(node.box.width);
  const h = numericHeight(node.box.height);
  const borderColor = NODE_TYPE_COLORS[node.type] ?? '#888';

  const sem = node.semantics;
  const roleColor = sem?.role ? ROLE_COLORS[sem.role] ?? '#888' : undefined;
  const bgOverlay = roleColor ? `background:${roleColor}20;` : '';
  const interactive = sem?.interactive ? 'sem-interactive' : '';

  const roleBadge = sem?.role
    ? `<span class="sem-role" style="background:${roleColor};">${escHtml(sem.role)}</span>`
    : '';

  const compBadge = sem?.componentName
    ? `<span class="sem-comp">${escHtml(sem.componentName)}</span>`
    : '';

  const layoutIcon =
    node.children.length > 0 && node.layout
      ? LAYOUT_ICONS[node.layout.type] ?? ''
      : '';
  const layoutLabel = layoutIcon
    ? `<span class="sem-layout">${layoutIcon}</span>`
    : '';

  const textContent =
    node.type === 'text' && node.textStyle
      ? `<span class="sem-text">${escHtml(node.textStyle.content)}</span>`
      : '';

  const ariaTitle = sem?.ariaLabel ? ` aria-label: ${sem.ariaLabel}` : '';

  const childrenHtml = node.children
    .map((c) => renderSemNode(c, depth + 1))
    .join('');

  return `<div class="sem-node ${interactive}" style="left:${node.box.x}px;top:${node.box.y}px;width:${w}px;height:${h}px;border-color:${borderColor};${bgOverlay}" title="${escHtml(node.name)}${ariaTitle}">
  ${roleBadge}${compBadge}${layoutLabel}
  ${textContent}
  ${childrenHtml}
</div>`;
}

// ── Stats ─────────────────────────────────────────────────────────────

function collectRoleCounts(root: IRNode): Record<string, number> {
  const counts: Record<string, number> = {};
  const stack: IRNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    const r = n.semantics?.role;
    if (r) counts[r] = (counts[r] ?? 0) + 1;
    stack.push(...n.children);
  }
  return counts;
}

function countInteractive(root: IRNode): number {
  let c = 0;
  const stack: IRNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.semantics?.interactive) c++;
    stack.push(...n.children);
  }
  return c;
}

function countComponentNames(root: IRNode): number {
  let c = 0;
  const stack: IRNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.semantics?.componentName) c++;
    stack.push(...n.children);
  }
  return c;
}

// ── CSS ───────────────────────────────────────────────────────────────

const EXTRA_CSS = `
  .sem-node {
    position: absolute;
    border: 1.5px solid;
    border-radius: 2px;
    overflow: visible;
  }
  .sem-node.sem-interactive { border-style: dashed !important; border-width: 2px; }
  .sem-role {
    position: absolute; top: -1px; left: -1px; z-index: 2;
    font-size: 8px; line-height: 1;
    padding: 1px 4px; border-radius: 0 0 3px 0;
    color: #fff; white-space: nowrap; pointer-events: none;
  }
  .sem-comp {
    position: absolute; top: -1px; right: -1px; z-index: 2;
    font-size: 8px; line-height: 1;
    padding: 1px 4px; border-radius: 0 0 0 3px;
    background: #1e293b; color: #e2e8f0;
    white-space: nowrap; pointer-events: none;
  }
  .sem-layout {
    position: absolute; bottom: 1px; left: 3px;
    font-size: 9px; color: #999; pointer-events: none;
  }
  .sem-text {
    display: block; padding: 14px 4px 4px;
    font-size: 10px; color: #555;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .role-dist { margin-top: 16px; display: flex; gap: 16px; flex-wrap: wrap; }
  .role-dist-bar {
    display: flex; align-items: center; gap: 4px; font-size: 11px; color: #555;
  }
  .role-dist-swatch {
    display: inline-block; height: 10px; border-radius: 2px; min-width: 8px;
  }
`;

// ── Renderer ──────────────────────────────────────────────────────────

export const semanticsRenderer: SnapshotRenderer = {
  stage: 'semantics',

  render(snapshot: StageSnapshot): string {
    const doc = snapshot.ir!;
    const w = numericWidth(doc.root.box.width) || doc.width;
    const h = numericHeight(doc.root.box.height) || doc.height;

    const nodesHtml = renderSemNode(doc.root, 0);

    const roleCounts = collectRoleCounts(doc.root);
    const interactiveCount = countInteractive(doc.root);
    const compCount = countComponentNames(doc.root);
    const totalRoles = Object.values(roleCounts).reduce((a, b) => a + b, 0);

    // role distribution bars
    const maxCount = Math.max(1, ...Object.values(roleCounts));
    const roleBars = Object.entries(roleCounts)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([role, cnt]) =>
          `<span class="role-dist-bar"><span class="role-dist-swatch" style="width:${Math.round((cnt / maxCount) * 60)}px;background:${ROLE_COLORS[role] ?? '#888'};"></span>${escHtml(role)}: ${cnt}</span>`,
      )
      .join('');

    const legendItems = Object.entries(roleCounts).map(([role]) => ({
      label: role,
      color: ROLE_COLORS[role] ?? '#888',
    }));

    const body = `
      <div class="canvas-wrapper" style="width:${w}px;height:${h}px;">
        ${nodesHtml}
      </div>
      ${buildLegend(legendItems)}
      <div class="stats-panel">
        <h3>Semantics summary</h3>
        <div class="stats-row">
          <span class="stats-item">Roles assigned: <span class="stats-value">${totalRoles}</span></span>
          <span class="stats-item">Components named: <span class="stats-value">${compCount}</span></span>
          <span class="stats-item">Interactive: <span class="stats-value">${interactiveCount}</span></span>
          <span class="stats-item">Duration: <span class="stats-value">${snapshot.durationMs}ms</span></span>
        </div>
      </div>
      <div class="stats-panel">
        <h3>Role distribution</h3>
        <div class="role-dist">${roleBars}</div>
      </div>`;

    return wrapHtmlPage(doc.name, 'semantics', body, EXTRA_CSS);
  },
};
