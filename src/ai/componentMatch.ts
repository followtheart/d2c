/**
 * Component library matching (P2).
 *
 * Walks an enhanced IR tree and, when a node matches the signature of a
 * well-known component library component (antd / MUI), stamps
 * `semantics.library` so the codegen can emit `<Button type="primary">`
 * instead of a bespoke `<button class="...">`.
 *
 * This is a pluggable rules engine — each library ships with a small
 * list of `ComponentRule`s. New libraries just mean new rule lists.
 */
import type { IRNode, Semantics } from '../ir/types';
import { map } from '../utils/tree';
import { luminance } from '../utils/color';

export type LibraryTarget = 'antd' | 'mui';

export interface ComponentRule {
  component: string;
  /** Return a props object on a match, or null to skip. */
  match(node: IRNode): Record<string, unknown> | null;
}

function isButton(node: IRNode): boolean {
  return (
    node.semantics?.role === 'button' ||
    node.type === 'button' ||
    (node.type === 'container' &&
      typeof node.style.borderRadius === 'number' &&
      node.style.borderRadius >= 4 &&
      !!node.style.backgroundColor &&
      node.children.length <= 3)
  );
}

function buttonLabel(node: IRNode): string | undefined {
  if (node.textStyle) return node.textStyle.content;
  for (const c of node.children) {
    if (c.textStyle) return c.textStyle.content;
  }
  return undefined;
}

function isInputLike(node: IRNode): boolean {
  if (node.type === 'input') return true;
  if (node.type !== 'container') return false;
  const h = typeof node.box.height === 'number' ? node.box.height : 0;
  return (
    !!node.style.border &&
    h >= 28 &&
    h <= 64 &&
    (typeof node.style.borderRadius !== 'number' ||
      node.style.borderRadius <= 12) &&
    node.children.length <= 1
  );
}

function isAvatar(node: IRNode): boolean {
  if (node.semantics?.role === 'avatar') return true;
  if (node.type !== 'image') return false;
  const r = node.style.borderRadius;
  const w = typeof node.box.width === 'number' ? node.box.width : 0;
  const h = typeof node.box.height === 'number' ? node.box.height : 0;
  return (
    typeof r === 'number' &&
    Math.abs(w - h) <= 2 &&
    r >= w / 2 - 2 &&
    w > 0 &&
    w <= 128
  );
}

function isCard(node: IRNode): boolean {
  if (node.semantics?.role === 'card') return true;
  return (
    node.type === 'container' &&
    !!node.style.backgroundColor &&
    ((typeof node.style.borderRadius === 'number' &&
      node.style.borderRadius >= 8) ||
      (node.style.shadows?.length ?? 0) > 0) &&
    node.children.length >= 2
  );
}

function isBadge(node: IRNode): boolean {
  if (node.semantics?.role === 'badge') return true;
  const w = typeof node.box.width === 'number' ? node.box.width : 0;
  const h = typeof node.box.height === 'number' ? node.box.height : 0;
  return (
    node.type === 'container' &&
    !!node.style.backgroundColor &&
    typeof node.style.borderRadius === 'number' &&
    node.style.borderRadius >= h / 2 - 2 &&
    w <= 120 &&
    h <= 32
  );
}

function isPrimary(node: IRNode): boolean {
  const bg = node.style.backgroundColor;
  if (!bg) return false;
  // Dark filled button → likely primary
  if (/^#[0-9a-f]{6}$/i.test(bg)) return luminance(bg) < 0.55;
  return true;
}

const ANTD_RULES: ComponentRule[] = [
  {
    component: 'Button',
    match(n) {
      if (!isButton(n)) return null;
      const props: Record<string, unknown> = {};
      if (n.style.border && !n.style.backgroundColor) props.type = 'default';
      else if (isPrimary(n)) props.type = 'primary';
      const label = buttonLabel(n);
      if (label) props.children = label;
      return props;
    },
  },
  {
    component: 'Input',
    match(n) {
      if (!isInputLike(n)) return null;
      return { placeholder: n.name };
    },
  },
  {
    component: 'Avatar',
    match(n) {
      if (!isAvatar(n)) return null;
      const size =
        typeof n.box.width === 'number' ? Math.round(n.box.width) : undefined;
      return {
        src: n.assetRef,
        size,
      };
    },
  },
  {
    component: 'Card',
    match(n) {
      if (!isCard(n)) return null;
      // Only top-level card-like containers, not nested
      return { bordered: !!n.style.border };
    },
  },
  {
    component: 'Tag',
    match(n) {
      if (!isBadge(n)) return null;
      return { color: n.style.backgroundColor };
    },
  },
];

const MUI_RULES: ComponentRule[] = [
  {
    component: 'Button',
    match(n) {
      if (!isButton(n)) return null;
      const props: Record<string, unknown> = {};
      props.variant =
        n.style.border && !n.style.backgroundColor ? 'outlined' : 'contained';
      if (isPrimary(n)) props.color = 'primary';
      const label = buttonLabel(n);
      if (label) props.children = label;
      return props;
    },
  },
  {
    component: 'TextField',
    match(n) {
      if (!isInputLike(n)) return null;
      return { label: n.name, variant: 'outlined' };
    },
  },
  {
    component: 'Avatar',
    match(n) {
      if (!isAvatar(n)) return null;
      return { src: n.assetRef, alt: n.name };
    },
  },
  {
    component: 'Card',
    match(n) {
      if (!isCard(n)) return null;
      return {};
    },
  },
  {
    component: 'Chip',
    match(n) {
      if (!isBadge(n)) return null;
      return { label: buttonLabel(n) ?? n.name };
    },
  },
];

const RULESETS: Record<LibraryTarget, ComponentRule[]> = {
  antd: ANTD_RULES,
  mui: MUI_RULES,
};

/**
 * Annotate every matching node in the tree with `semantics.library`. A
 * node that already has `library` set is left alone so a manual hint
 * always wins.
 */
export function matchComponents(
  root: IRNode,
  target: LibraryTarget,
): IRNode {
  const rules = RULESETS[target];
  if (!rules) return root;
  return map(root, (n) => {
    if (n.semantics?.library) return n;
    for (const rule of rules) {
      const props = rule.match(n);
      if (props) {
        const semantics: Semantics = {
          ...(n.semantics ?? {}),
          library: { name: target, component: rule.component, props },
        };
        return { ...n, semantics };
      }
    }
    return n;
  });
}
