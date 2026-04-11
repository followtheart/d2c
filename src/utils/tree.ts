import type { IRNode } from '../ir/types';

export function walk(node: IRNode, visitor: (node: IRNode, depth: number) => void, depth = 0): void {
  visitor(node, depth);
  for (const child of node.children) walk(child, visitor, depth + 1);
}

export function map(node: IRNode, mapper: (node: IRNode) => IRNode): IRNode {
  const mapped = mapper(node);
  return {
    ...mapped,
    children: mapped.children.map((c) => map(c, mapper)),
  };
}

export function pascalCase(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^[a-z]/, (c) => c.toUpperCase())
    .replace(/^[0-9]/, (c) => `_${c}`);
}

export function kebabCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');
}
