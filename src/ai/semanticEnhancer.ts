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

function pickRoleByName(name: string): SemanticRole | undefined {
  const n = name.toLowerCase();
  if (/(^|[^a-z])header([^a-z]|$)/.test(n)) return 'header';
  if (/(^|[^a-z])nav([^a-z]|$)|menu|sidebar/.test(n)) return 'nav';
  if (/footer/.test(n)) return 'footer';
  if (/hero|banner/.test(n)) return 'section';
  if (/card/.test(n)) return 'card';
  if (/form/.test(n)) return 'form';
  if (/list|items/.test(n)) return 'list';
  if (/button|btn|cta/.test(n)) return 'button';
  if (/avatar|profile.?pic/.test(n)) return 'avatar';
  if (/badge|tag|chip/.test(n)) return 'badge';
  if (/icon/.test(n)) return 'icon';
  if (/divider|separator/.test(n)) return 'divider';
  if (/title|heading|h[1-6]/.test(n)) return 'heading';
  return undefined;
}

function isButtonLike(node: IRNode): boolean {
  if (node.type === 'button') return true;
  if (node.type !== 'container') return false;
  // small rounded pill with at most text + icon inside
  const { style } = node;
  const radius =
    typeof style.borderRadius === 'number' ? style.borderRadius : undefined;
  const h = typeof node.box.height === 'number' ? node.box.height : Infinity;
  if (radius !== undefined && radius >= 4 && h <= 56 && node.children.length <= 3) {
    const hasText = node.children.some((c) => c.type === 'text');
    if (hasText && style.backgroundColor) return true;
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
  // Two passes: first list detection (needs structural view), then per-node annotation.
  const withLists = map(root, (n) => detectLists(n));
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
