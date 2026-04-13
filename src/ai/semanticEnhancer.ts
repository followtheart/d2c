/**
 * Semantic enhancer.
 *
 * Hybrid approach (as both docs recommend):
 *   - Rules engine handles deterministic cases (hero/header/footer, icon,
 *     text-as-heading, button-like pills, repeating list items, etc.).
 *   - Optional LLM provider (plug-in) refines ambiguous nodes.
 *
 * The rules engine alone produces reasonable output so d2c remains
 * 100% offline-capable. Pass an LLMProvider to `enhance` to augment.
 */
import type { IRNode, SemanticRole, Semantics } from '../ir/types';
import { map, pascalCase } from '../utils/tree';

export interface LLMProvider {
  /** Takes the IR tree (JSON) and returns a partial semantic annotation map keyed by node id. */
  annotate(
    tree: IRNode,
  ): Promise<Record<string, Semantics>>;
}

interface EnhanceOptions {
  llm?: LLMProvider;
}

/** Word boundary for design-tool names: non-letter or string boundary. */
const B = '(^|[^a-z])';
const E = '([^a-z]|$)';

function pickRoleByName(name: string): SemanticRole | undefined {
  const n = name.toLowerCase();
  if (new RegExp(`${B}header${E}`).test(n)) return 'header';
  if (new RegExp(`${B}(nav|menu|sidebar)${E}`).test(n)) return 'nav';
  if (new RegExp(`${B}footer${E}`).test(n)) return 'footer';
  if (new RegExp(`${B}(hero|banner)${E}`).test(n)) return 'section';
  if (new RegExp(`${B}card${E}`).test(n)) return 'card';
  if (new RegExp(`${B}form${E}`).test(n)) return 'form';
  if (new RegExp(`${B}(list|items)${E}`).test(n)) return 'list';
  if (new RegExp(`${B}(button|btn|cta)${E}`).test(n)) return 'button';
  if (new RegExp(`${B}(avatar|profile.?pic)${E}`).test(n)) return 'avatar';
  if (new RegExp(`${B}(badge|tag|chip)${E}`).test(n)) return 'badge';
  if (new RegExp(`${B}icon${E}`).test(n)) return 'icon';
  if (new RegExp(`${B}(divider|separator)${E}`).test(n)) return 'divider';
  if (new RegExp(`${B}(title|heading|h[1-6])${E}`).test(n)) return 'heading';
  return undefined;
}

// 检查文本节点是否在容器范围内
function boxContains(outer: { x: number; y: number; width: number | 'auto' | 'fill'; height: number | 'auto' | 'fill' },
  inner: { x: number; y: number; width: number | 'auto' | 'fill'; height: number | 'auto' | 'fill' }): boolean {
  const ow = typeof outer.width === 'number' ? outer.width : 0;
  const oh = typeof outer.height === 'number' ? outer.height : 0;
  const iw = typeof inner.width === 'number' ? inner.width : 0;
  const ih = typeof inner.height === 'number' ? inner.height : 0;
  const tol = 2;
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol &&
    inner.x + iw <= outer.x + ow + tol && inner.y + ih <= outer.y + oh + tol;
}

function boxArea(box: { width: number | 'auto' | 'fill'; height: number | 'auto' | 'fill' }): number {
  const w = typeof box.width === 'number' ? box.width : 0;
  const h = typeof box.height === 'number' ? box.height : 0;
  return w * h;
}

// 将空间上包含在兄弟容器内的文本节点重新归入容器中
function mergeOverlappingSiblings(node: IRNode): IRNode {
  if (node.children.length < 2) return node;
  const textIndices: number[] = [];
  const containerIndices: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    if (c.type === 'text' || c.textStyle) textIndices.push(i);
    else containerIndices.push(i);
  }
  if (!textIndices.length || !containerIndices.length) return node;

  // 为每个文本节点找到最小的包含它的容器兄弟
  const mergeMap = new Map<number, number[]>();
  const mergedTextIndices = new Set<number>();
  for (const ti of textIndices) {
    const text = node.children[ti];
    let bestIdx = -1;
    let bestArea = Infinity;
    for (const ci of containerIndices) {
      const container = node.children[ci];
      if (boxContains(container.box, text.box)) {
        const area = boxArea(container.box);
        if (area < bestArea) {
          bestArea = area;
          bestIdx = ci;
        }
      }
    }
    if (bestIdx >= 0) {
      if (!mergeMap.has(bestIdx)) mergeMap.set(bestIdx, []);
      mergeMap.get(bestIdx)!.push(ti);
      mergedTextIndices.add(ti);
    }
  }
  if (!mergedTextIndices.size) return node;

  // 重建子节点列表
  const newChildren: IRNode[] = [];
  for (let i = 0; i < node.children.length; i++) {
    if (mergedTextIndices.has(i)) continue;
    let child = node.children[i];
    const texts = mergeMap.get(i);
    if (texts) {
      // 将文本重新归入该容器, 并调整坐标为相对坐标
      const adjusted = texts.map((ti) => {
        const t = node.children[ti];
        return { ...t, box: { ...t.box, x: t.box.x - child.box.x, y: t.box.y - child.box.y } };
      });
      child = { ...child, children: [...child.children, ...adjusted] };
    }
    newChildren.push(child);
  }
  return { ...node, children: newChildren };
}

// 检测名称中包含 input / field 的容器
function isInputLike(node: IRNode): boolean {
  if (node.type !== 'container') return false;
  return /input|textfield|text.?field/i.test(node.name);
}

function isButtonLike(node: IRNode): boolean {
  if (node.type === 'button') return true;
  if (node.type !== 'container') return false;
  const { style } = node;
  const radius =
    typeof style.borderRadius === 'number' ? style.borderRadius : undefined;
  const h = typeof node.box.height === 'number' ? node.box.height : Infinity;
  if (radius !== undefined && radius >= 4 && h <= 56 && node.children.length <= 3) {
    const hasText = node.children.some((c) => c.type === 'text');
    if (hasText && (style.backgroundColor || style.backgroundImage)) return true;
  }
  return false;
}

function isHeadingText(node: IRNode): boolean {
  if (node.type !== 'text' || !node.textStyle) return false;
  return node.textStyle.fontSize >= 20 || node.textStyle.fontWeight >= 600;
}

/**
 * Detect repeating-pattern siblings → mark parent as list and children as list-item.
 * Heuristic: 3+ siblings with the same structural signature (same type, ~same size).
 */
function structuralSignature(node: IRNode): string {
  const w = typeof node.box.width === 'number' ? Math.round(node.box.width / 4) : 'x';
  const h = typeof node.box.height === 'number' ? Math.round(node.box.height / 4) : 'x';
  const kids = node.children.map((c) => c.type).join(',');
  return `${node.type}|${w}x${h}|${kids}`;
}

function detectLists(node: IRNode): IRNode {
  if (node.children.length < 3) return node;
  const sigs = node.children.map(structuralSignature);
  const counts = new Map<string, number>();
  for (const s of sigs) counts.set(s, (counts.get(s) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] >= 3 && dominant[1] / node.children.length >= 0.6) {
    return {
      ...node,
      type: 'list',
      semantics: { ...node.semantics, role: 'list' },
      children: node.children.map((c, i) =>
        sigs[i] === dominant[0]
          ? {
              ...c,
              type: 'list-item',
              semantics: { ...c.semantics, role: 'list-item' },
            }
          : c,
      ),
    };
  }
  return node;
}

// 将名称含 input/field 的容器转换为 input 节点
function convertInputNodes(node: IRNode): IRNode {
  if (isInputLike(node)) {
    const textChild = node.children.find((c) => c.type === 'text');
    const placeholder = textChild?.textStyle?.content;
    return {
      ...node,
      type: 'input',
      children: [],
      semantics: { ...node.semantics, ariaLabel: placeholder, componentName: pascalCase(node.name || 'input') },
    };
  }
  return node;
}

function ruleEnhanceNode(node: IRNode, depth: number): IRNode {
  const semantics: Semantics = { ...(node.semantics ?? {}) };

  if (!semantics.role) {
    const roleByName = pickRoleByName(node.name);
    if (roleByName) semantics.role = roleByName;
  }

  if (!semantics.role) {
    if (isButtonLike(node)) semantics.role = 'button';
    else if (isHeadingText(node)) semantics.role = 'heading';
    else if (node.type === 'text') semantics.role = 'paragraph';
    else if (node.type === 'image') semantics.role = undefined;
  }

  // Top-most container in the tree has special slots
  if (depth === 0 && node.type === 'container') {
    // leave as-is, semantics filled in by children
  }

  if (semantics.role === 'button') {
    semantics.interactive = true;
  }

  if (!semantics.componentName) {
    semantics.componentName = pascalCase(node.name || node.type);
  }

  return { ...node, semantics };
}

function ruleEnhance(root: IRNode): IRNode {
  // 四个阶段: 合并重叠兄弟 → 转换 input 节点 → 检测列表 → 逐节点标注
  const merged = map(root, (n) => mergeOverlappingSiblings(n));
  const withInputs = map(merged, (n) => convertInputNodes(n));
  const withLists = map(withInputs, (n) => detectLists(n));
  return walkWithDepth(withLists, 0);
}

function walkWithDepth(node: IRNode, depth: number): IRNode {
  const annotated = ruleEnhanceNode(node, depth);
  return {
    ...annotated,
    children: annotated.children.map((c) => walkWithDepth(c, depth + 1)),
  };
}

export async function enhance(
  root: IRNode,
  opts: EnhanceOptions = {},
): Promise<IRNode> {
  const ruleOut = ruleEnhance(root);
  if (!opts.llm) return ruleOut;

  const llmAnnotations = await opts.llm.annotate(ruleOut);
  return map(ruleOut, (n) =>
    llmAnnotations[n.id]
      ? { ...n, semantics: { ...n.semantics, ...llmAnnotations[n.id] } }
      : n,
  );
}

/**
 * Mock LLM provider for demos. Returns empty annotations but exercises the
 * plug-in interface so users can swap in their own provider (OpenAI, Claude,
 * Qwen-VL, vLLM, etc.) without touching pipeline code.
 */
export class NoopLLMProvider implements LLMProvider {
  async annotate(): Promise<Record<string, Semantics>> {
    return {};
  }
}
