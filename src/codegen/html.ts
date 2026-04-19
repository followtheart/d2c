import type { IRDocument, IRNode, SemanticRole } from '../ir/types';
import { CodeGenerator, GenerateResult, GeneratedFile } from './base';
import { buildCssProps, cssPropsToBlock } from './cssBuilder';
import { kebabCase } from '../utils/tree';

const HTML_TAG_BY_ROLE: Partial<Record<SemanticRole, string>> = {
  header: 'header',
  nav: 'nav',
  footer: 'footer',
  main: 'main',
  aside: 'aside',
  section: 'section',
  card: 'article',
  list: 'ul',
  'list-item': 'li',
  button: 'button',
  link: 'a',
  heading: 'h2',
  paragraph: 'p',
  label: 'label',
};

/**
 * Recognise interactive component patterns that semantics stage names in
 * PascalCase (e.g. `FloatingActionButton`, `SaveEvent`, `Switch`,
 * `ToggleSwitch`, `ElmMainbutton`). These frequently arrive without a
 * `semantics.role` tag yet should still render as interactive HTML
 * elements rather than generic `<div>`s.
 */
const BUTTON_NAME_RE = /(?:^|[^a-z])(button|btn|fab|cta|mainbutton)(?:[^a-z]|$)/i;
const SWITCH_NAME_RE = /(?:^|[^a-z])(switch|toggle)(?:[^a-z]|$)/i;

/** Convert "DateInput" / "date-input" / "date_input" -> "Date input". */
function humanise(s?: string): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Detect Figma's auto-generated vector-layer names (Fill 25, Path Copy 3,
 * Rectangle Copy 5, Group 12, Oval, Vector). These names leak into CSS
 * classes and muddy the generated output; we fall back to semantic role /
 * node type whenever a name matches this pattern.
 */
const JUNK_NAME_RE =
  /^(fill|path|rectangle|group|oval|ellipse|vector|shape|line|star|polygon|frame|subtract|union|intersect|clip|mask)(copy)?\d*$/i;

function isJunkName(s?: string): boolean {
  if (!s) return true;
  return JUNK_NAME_RE.test(s.replace(/[\s\-_]+/g, ''));
}

/**
 * True when a node is effectively a decorative vector leaf — a container
 * with no text/image, no interactive semantics, and a Figma-auto layer
 * name (Fill, Path, Rectangle, …). Leaves that recursively contain only
 * other such leaves also count, so an entire illustration subtree can be
 * identified as decorative.
 */
function isDecorativeVectorSubtree(node: IRNode): boolean {
  // Allow `list`/`list-item` types: the semantic enhancer's repeating-
  // sibling heuristic occasionally misfires on clusters of vector paths
  // (e.g. a bar chart built from four `Path` siblings). When the layer
  // name is clearly Figma-auto-generated we treat the misfired role as
  // noise and still collapse the subtree.
  if (node.type !== 'container' && node.type !== 'list' && node.type !== 'list-item') return false;
  if (node.textStyle || node.assetRef) return false;
  if (node.semantics?.interactive) return false;
  if (!isJunkName(node.name)) return false;
  return node.children.every(isDecorativeVectorSubtree);
}

/**
 * True when `node` is an illustration-like container (named "Illustration"
 * / "Graphic" / "EmptyState" / etc.) whose entire descendant subtree is
 * decorative vector paths. Rendering every path as a `<div>` produces
 * hundreds of empty boxes with ugly class names like `d2c-fill25-1170`;
 * collapsing them into a single aria-labelled placeholder keeps the
 * generated HTML readable without losing meaning.
 */
const ILLUSTRATION_NAME_RE =
  /illustration|graphic|ornament|decor|pattern|empty.?state.*illustration/i;

function isDecorativeIllustration(node: IRNode): boolean {
  if (node.type !== 'container') return false;
  if (node.children.length < 4) return false;
  if (node.textStyle || node.assetRef) return false;
  if (node.semantics?.interactive) return false;
  const nameish = `${node.semantics?.componentName ?? ''} ${node.name ?? ''}`;
  if (!ILLUSTRATION_NAME_RE.test(nameish)) return false;
  return node.children.every(isDecorativeVectorSubtree);
}

function tagFor(node: IRNode): string {
  const role = node.semantics?.role;
  if (role && HTML_TAG_BY_ROLE[role]) return HTML_TAG_BY_ROLE[role]!;
  const nameHint = `${node.semantics?.componentName ?? ''} ${node.name ?? ''}`;
  if (role === undefined) {
    if (BUTTON_NAME_RE.test(nameHint)) return 'button';
    if (SWITCH_NAME_RE.test(nameHint)) return 'button';
  }
  switch (node.type) {
    case 'text':
      return 'span';
    case 'image':
      return 'img';
    case 'icon':
      return 'span';
    case 'button':
      return 'button';
    case 'input':
      return 'input';
    case 'list':
      return 'ul';
    case 'list-item':
      return 'li';
    default:
      return 'div';
  }
}

export class HtmlGenerator extends CodeGenerator {
  readonly platform = 'html';
  private classIndex = new Map<string, string>();
  private classCss: string[] = [];
  private classCounter = 0;

  generate(doc: IRDocument): GenerateResult {
    this.classIndex.clear();
    this.classCss = [];
    this.classCounter = 0;

    const body = this.renderNode(doc.root, 4, undefined, { isRoot: true });
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${this.escapeText(doc.name)}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
${body}
  </body>
</html>
`;

    const css = `/* Generated by d2c */
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow-x: hidden; }
img { display: block; max-width: 100%; }

${this.classCss.join('\n\n')}
`;

    return {
      entryFile: 'index.html',
      files: [
        { path: 'index.html', content: html },
        { path: 'styles.css', content: css },
      ],
    };
  }

  // 多页面：每页一个独立 HTML + 共享导航
  generateMultiPage(docs: IRDocument[]): GenerateResult {
    if (docs.length === 1) return this.generate(docs[0]);
    const allFiles: GeneratedFile[] = [];
    const pageNames = docs.map((d, i) => ({
      name: d.name || `Page ${i + 1}`,
      file: `${this.safePageDir(d.name || `page_${i + 1}`)}.html`,
    }));

    // 所有页面共享一个 classIndex，生成共享 styles.css
    this.classIndex.clear();
    this.classCss = [];
    this.classCounter = 0;

    const pageBodies: string[] = [];
    for (let i = 0; i < docs.length; i++) {
      pageBodies.push(this.renderNode(docs[i].root, 4, undefined, { isRoot: true }));
    }

    const css = `/* Generated by d2c */
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow-x: hidden; }
img { display: block; max-width: 100%; }
.d2c-page-nav { display:flex; gap:16px; padding:12px 16px; background:#f5f5f5; border-bottom:1px solid #ddd; font-family:sans-serif; }
.d2c-page-nav a { text-decoration:none; color:#0066cc; }

${this.classCss.join('\n\n')}
`;
    allFiles.push({ path: 'styles.css', content: css });

    for (let i = 0; i < docs.length; i++) {
      const navItems = pageNames
        .map((p, j) =>
          j === i
            ? `      <span style="font-weight:bold">${this.escapeText(p.name)}</span>`
            : `      <a href="${p.file}">${this.escapeText(p.name)}</a>`,
        )
        .join('\n');
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${this.escapeText(pageNames[i].name)}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <nav class="d2c-page-nav">
${navItems}
    </nav>
${pageBodies[i]}
  </body>
</html>
`;
      allFiles.push({ path: pageNames[i].file, content: html });
    }

    return { files: allFiles, entryFile: pageNames[0].file };
  }

  private classFor(
    node: IRNode,
    parentLayout?: 'flex' | 'grid' | 'absolute',
    opts?: { parentDirection?: 'row' | 'column'; isRoot?: boolean },
  ): string {
    const props = buildCssProps(node, parentLayout, opts);
    const key = JSON.stringify(props);
    if (this.classIndex.has(key)) return this.classIndex.get(key)!;
    // Pick a human-readable slug for the class name, but skip Figma's auto
    // layer names (Fill 25, Path Copy 3, Rectangle, …) so CSS classes stay
    // semantic rather than echoing design-tool scaffolding.
    const candidate = !isJunkName(node.semantics?.componentName)
      ? node.semantics?.componentName
      : !isJunkName(node.name)
        ? node.name
        : node.semantics?.role ?? node.type;
    const base = kebabCase(candidate || node.type);
    const name = `d2c-${base}-${++this.classCounter}`;
    this.classIndex.set(key, name);
    this.classCss.push(`.${name} {\n${cssPropsToBlock(props, 2)}\n}`);
    return name;
  }

  // 为 input 元素中的文本输入框生成样式类
  private classForInput(parent: IRNode, valueChild?: IRNode): string {
    const props: Record<string, string> = {
      width: '100%',
      border: 'none',
      outline: 'none',
      'background-color': 'transparent',
    };
    if (valueChild?.textStyle) {
      props['font-size'] = `${Math.round(valueChild.textStyle.fontSize)}px`;
      props['font-weight'] = String(valueChild.textStyle.fontWeight);
      props.color = valueChild.textStyle.color;
    }
    const key = JSON.stringify(props);
    if (this.classIndex.has(key)) return this.classIndex.get(key)!;
    const name = `d2c-input-field-${++this.classCounter}`;
    this.classIndex.set(key, name);
    this.classCss.push(`.${name} {\n${cssPropsToBlock(props, 2)}\n}`);
    return name;
  }

  private renderNode(
    node: IRNode,
    indent: number,
    parentLayout?: 'flex' | 'grid' | 'absolute',
    opts?: { parentDirection?: 'row' | 'column'; isRoot?: boolean },
  ): string {
    // Drop fully-transparent nodes entirely — Figma exports frequently keep
    // hidden helper layers at opacity 0, and rendering them (plus their whole
    // subtree of decorative paths) produces hundreds of empty `<div>`s that
    // clutter the preview and visually overlay real content.
    if (node.style?.opacity === 0) return '';
    const pad = ' '.repeat(indent);

    // Collapse Figma illustration subtrees — rendering every vector path as
    // a nested `<div>` produces hundreds of empty boxes that clutter the
    // preview. A single aria-labelled placeholder preserves bounds and
    // semantic intent without the noise.
    if (isDecorativeIllustration(node)) {
      const leafNode: IRNode = { ...node, children: [] };
      const leafClass = this.classFor(leafNode, parentLayout, opts);
      const alt = this.escapeText(node.semantics?.ariaLabel ?? node.name ?? 'illustration');
      return `${pad}<div class="${leafClass}" role="img" aria-label="${alt}"></div>`;
    }

    const tag = tagFor(node);
    const className = this.classFor(node, parentLayout, opts);

    // input 元素: 包含 label 和 input 子元素
    if (node.type === 'input') {
      const label = node.semantics?.ariaLabel ?? '';
      // 从子节点提取标签和值
      const labelChild = node.children.find((c) => c.textStyle && c.textStyle.fontWeight >= 500);
      const valueChild = node.children.find((c) => c.textStyle && c.textStyle.fontWeight < 500);
      // 从子节点的 input 元素继承 border 样式
      const inputChild = node.children.find((c) => c.type === 'input');
      const borderNode = inputChild ?? valueChild;
      const labelText = this.escapeText(labelChild?.textStyle?.content ?? label);
      const valueText = this.escapeText(valueChild?.textStyle?.content ?? node.textStyle?.content ?? '');
      // Placeholder falls back to the inferred component name when the node
      // has no captured label text so generated `<input>`s still communicate
      // their purpose instead of rendering as an empty rectangle. Humanise
      // PascalCase component names (e.g. "DateInput" -> "Date Input").
      const placeholderRaw = label || labelText || humanise(node.semantics?.componentName) || node.name || '';
      const placeholder = this.escapeText(placeholderRaw);
      if (labelChild) {
        // 合并 border 样式到容器节点
        const wrapperNode = borderNode?.style?.border
          ? { ...node, style: { ...node.style, border: borderNode.style.border, borderRadius: borderNode.style.borderRadius },
              box: { ...node.box, padding: node.box.padding ?? [12, 16, 12, 16] } }
          : node;
        const wrapperClass = this.classFor(wrapperNode, parentLayout, opts);
        const labelClass = this.classFor(labelChild, node.layout.type);
        const inputType = label.toLowerCase().includes('email') ? 'email' : 'text';
        // 如果语义角色是 list-item，使用 <li> 包裹
        const wrapTag = node.semantics?.role === 'list-item' ? 'li' : 'div';
        const valueAttr = valueText ? ` value="${valueText}"` : '';
        const placeholderAttr = placeholder ? ` placeholder="${placeholder}"` : '';
        return `${pad}<${wrapTag} class="${wrapperClass}">
${pad}  <label class="${labelClass}">${labelText}</label>
${pad}  <input type="${inputType}" class="${this.classForInput(node, valueChild)}"${placeholderAttr}${valueAttr} />
${pad}</${wrapTag}>`;
      }
      const valueAttr = valueText ? ` value="${valueText}"` : '';
      const placeholderAttr = placeholder ? ` placeholder="${placeholder}"` : '';
      return `${pad}<input class="${className}"${placeholderAttr}${valueAttr} />`;
    }

    if (node.type === 'image') {
      const src = node.assetRef ?? '';
      const alt = this.escapeText(node.semantics?.ariaLabel ?? node.name);
      return `${pad}<img class="${className}" src="${src}" alt="${alt}" />`;
    }

    if (node.type === 'text' || node.textStyle) {
      const content = this.escapeText(node.textStyle?.content ?? '');
      return `${pad}<${tag} class="${className}">${content}</${tag}>`;
    }

    // 按钮等交互元素: 如果只有一个文本子节点, 将文本内联
    if ((tag === 'button' || tag === 'a') && node.children.length === 1 &&
        (node.children[0].type === 'text' || node.children[0].textStyle)) {
      const child = node.children[0];
      const content = this.escapeText(child.textStyle?.content ?? '');
      // 合并子节点文本样式到按钮节点，保留文本颜色和字体
      const merged = { ...node, textStyle: child.textStyle };
      const mergedClass = this.classFor(merged, parentLayout, opts);
      return `${pad}<${tag} class="${mergedClass}">${content}</${tag}>`;
    }

    if (node.children.length === 0) {
      return `${pad}<${tag} class="${className}"></${tag}>`;
    }

    const childLayout = node.layout.type;
    const childDirection = node.layout.direction;

    // <ul>/<ol> 只能包含 <li> 子节点，其他子节点提升到列表外
    if (tag === 'ul' || tag === 'ol') {
      const isListItem = (c: IRNode) => c.type === 'list-item' || c.semantics?.role === 'list-item';
      const listItems = node.children.filter(isListItem);
      const nonListItems = node.children.filter((c) => !isListItem(c));

      // 如果同时含有列表项和非列表项，用 <div> 容器避免非法 HTML
      if (nonListItems.length > 0 && listItems.length > 0) {
        const childrenHtml = node.children
          .map((c) => this.renderNode(c, indent + 2, childLayout, { parentDirection: childDirection }))
          .join('\n');
        return `${pad}<div class="${className}">
${childrenHtml}
${pad}</div>`;
      }

      if (listItems.length > 0) {
        const liHtml = listItems
          .map((c) => this.renderNode(c, indent + 2, childLayout, { parentDirection: childDirection }))
          .join('\n');
        return `${pad}<${tag} class="${className}">\n${liHtml}\n${pad}</${tag}>`;
      }

      // 无列表项，按普通容器渲染
      const parts: string[] = [];
      for (const c of nonListItems) {
        parts.push(this.renderNode(c, indent, parentLayout, { parentDirection: opts?.parentDirection }));
      }
      return parts.join('\n');
    }

    const childrenHtml = node.children
      .map((c) => this.renderNode(c, indent + 2, childLayout, { parentDirection: childDirection }))
      .join('\n');
    return `${pad}<${tag} class="${className}">
${childrenHtml}
${pad}</${tag}>`;
  }
}
