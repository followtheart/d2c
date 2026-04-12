/**
 * IR diff + protected region merge (P2).
 *
 * Problem: when a design is re-exported, the code generator would
 * clobber any hand-tuning a developer (or an LLM pass) has applied.
 *
 * Solution: mark subtrees with `semantics.aiIgnore = true` (either
 * manually or via a comment in generated code). When regenerating, pass
 * the previous IR into `mergeProtectedRegions(prev, next)` and any node
 * in `prev` whose id is marked `aiIgnore` will be preserved in `next`,
 * including its whole subtree.
 *
 * The diff utility (`diffIR`) is a simple structural diff keyed by
 * node id, useful for CI logs and change reports.
 */
import type { IRDocument, IRNode } from '../ir/types';
import { map } from '../utils/tree';

export interface IRDiffEntry {
  id: string;
  kind: 'added' | 'removed' | 'changed';
  path: string;
  fields?: string[];
}

function indexById(root: IRNode): Map<string, IRNode> {
  const out = new Map<string, IRNode>();
  const visit = (n: IRNode) => {
    out.set(n.id, n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

function pathOf(root: IRNode, id: string): string {
  const stack: Array<{ node: IRNode; path: string }> = [
    { node: root, path: root.name || root.id },
  ];
  while (stack.length) {
    const { node, path } = stack.pop()!;
    if (node.id === id) return path;
    for (const c of node.children) {
      stack.push({ node: c, path: `${path} > ${c.name || c.id}` });
    }
  }
  return id;
}

function shallowFieldsChanged(a: IRNode, b: IRNode): string[] {
  const changed: string[] = [];
  if (a.type !== b.type) changed.push('type');
  if (a.name !== b.name) changed.push('name');
  if (JSON.stringify(a.box) !== JSON.stringify(b.box)) changed.push('box');
  if (JSON.stringify(a.layout) !== JSON.stringify(b.layout))
    changed.push('layout');
  if (JSON.stringify(a.style) !== JSON.stringify(b.style))
    changed.push('style');
  if (JSON.stringify(a.textStyle) !== JSON.stringify(b.textStyle))
    changed.push('textStyle');
  if (a.assetRef !== b.assetRef) changed.push('assetRef');
  return changed;
}

/**
 * Structural diff between two IR trees, keyed by node id. Returns an
 * ordered list of added / removed / changed entries. Used for "what
 * changed since the last export?" reports and CI visibility.
 */
export function diffIR(prev: IRDocument, next: IRDocument): IRDiffEntry[] {
  const prevIx = indexById(prev.root);
  const nextIx = indexById(next.root);
  const entries: IRDiffEntry[] = [];

  for (const [id, p] of prevIx) {
    const n = nextIx.get(id);
    if (!n) {
      entries.push({ id, kind: 'removed', path: pathOf(prev.root, id) });
      continue;
    }
    const fields = shallowFieldsChanged(p, n);
    if (fields.length) {
      entries.push({
        id,
        kind: 'changed',
        path: pathOf(next.root, id),
        fields,
      });
    }
  }
  for (const [id] of nextIx) {
    if (!prevIx.has(id)) {
      entries.push({ id, kind: 'added', path: pathOf(next.root, id) });
    }
  }
  return entries;
}

/**
 * For each node in `next` whose id also exists in `prev` and whose `prev`
 * counterpart has `semantics.aiIgnore === true`, replace it with the
 * `prev` subtree. This protects hand-tuned regions across regenerations.
 *
 * Runs as a tree map so it composes with the rest of the pipeline cleanly.
 */
export function mergeProtectedRegions(
  prev: IRDocument,
  next: IRDocument,
): IRDocument {
  const protectedNodes = new Map<string, IRNode>();
  const visit = (n: IRNode) => {
    if (n.semantics?.aiIgnore) protectedNodes.set(n.id, n);
    for (const c of n.children) visit(c);
  };
  visit(prev.root);
  if (protectedNodes.size === 0) return next;

  const replacedRoot = map(next.root, (n) => {
    const prot = protectedNodes.get(n.id);
    if (prot) return prot;
    return n;
  });
  return { ...next, root: replacedRoot };
}

/** Pretty-print a diff for CI logs. */
export function formatDiff(entries: IRDiffEntry[]): string {
  if (!entries.length) return '(no changes)';
  return entries
    .map((e) => {
      const mark = e.kind === 'added' ? '+' : e.kind === 'removed' ? '-' : '~';
      const extra = e.fields?.length ? ` [${e.fields.join(', ')}]` : '';
      return `${mark} ${e.path} (#${e.id})${extra}`;
    })
    .join('\n');
}
