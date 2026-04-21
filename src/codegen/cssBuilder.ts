/**
 * Shared CSS property builder used by HTML and Vue generators.
 * Maps IR → inline style declarations.
 */
import type { IRNode } from '../ir/types';

function px(n: number): string {
  return `${Math.round(n)}px`;
}

// 判断颜色是否为深色（亮度 < 128）
function isDarkColor(hex: string): boolean {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return false;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

function numOr(n: number | 'auto' | 'fill', fallback: string): string {
  if (typeof n === 'number') return px(n);
  if (n === 'fill') return '100%';
  return fallback;
}

export function buildCssProps(
  node: IRNode,
  parentLayout?: 'flex' | 'grid' | 'absolute',
  opts?: { parentDirection?: 'row' | 'column'; isRoot?: boolean },
): Record<string, string> {
  const css: Record<string, string> = {};
  const { box, layout, style, textStyle } = node;
  const parentDirection = opts?.parentDirection;
  const isRoot = opts?.isRoot;

  // Absolute-positioned child: add absolute + left/top
  if (parentLayout === 'absolute') {
    css.position = 'absolute';
    if (box.x) css.left = px(box.x);
    if (box.y) css.top = px(box.y);
  }

  // Box sizing
  if (isRoot && typeof box.width === 'number') {
    // Root container: responsive max-width instead of fixed width
    css['max-width'] = px(box.width);
    css.width = '100%';
    css['margin-left'] = 'auto';
    css['margin-right'] = 'auto';
  } else if (box.width === 'fill') {
    if (parentLayout === 'flex' && (parentDirection === 'row' || !parentDirection)) {
      css.flex = '1 1 0%';
      css['min-width'] = '0';
    } else {
      css.width = '100%';
    }
  } else if (box.width !== 'auto') {
    css.width = numOr(box.width, 'auto');
  }

  if (box.height === 'fill') {
    if (parentLayout === 'flex' && parentDirection === 'column') {
      css.flex = '1 1 0%';
      css['min-height'] = '0';
    } else {
      css.height = '100%';
    }
  } else if (box.height !== 'auto') {
    css.height = numOr(box.height, 'auto');
  }
  if (box.padding) {
    const [t, r, b, l] = box.padding;
    css.padding = `${px(t)} ${px(r)} ${px(b)} ${px(l)}`;
  }

  // Layout
  if (layout.type === 'flex') {
    css.display = 'flex';
    css['flex-direction'] = layout.direction ?? 'row';
    if (layout.gap) css.gap = px(layout.gap);
    if (layout.alignItems) {
      const map: Record<string, string> = {
        start: 'flex-start',
        center: 'center',
        end: 'flex-end',
        stretch: 'stretch',
      };
      css['align-items'] = map[layout.alignItems] ?? layout.alignItems;
    }
    if (layout.justifyContent) {
      const map: Record<string, string> = {
        start: 'flex-start',
        center: 'center',
        end: 'flex-end',
        'space-between': 'space-between',
        'space-around': 'space-around',
        'space-evenly': 'space-evenly',
      };
      css['justify-content'] = map[layout.justifyContent] ?? layout.justifyContent;
    }
  } else if (layout.type === 'grid') {
    css.display = 'grid';
    if (layout.columns) css['grid-template-columns'] = `repeat(${layout.columns}, minmax(0, 1fr))`;
    if (layout.gap) css.gap = px(layout.gap);
  } else if (layout.type === 'absolute' && parentLayout !== 'absolute') {
    css.position = 'relative';
  }

  // Style
  if (style.backgroundColor) css['background-color'] = style.backgroundColor;
  if (style.backgroundImage) css['background-image'] = style.backgroundImage;

  // 列表去除默认样式
  if (node.type === 'list' || node.semantics?.role === 'list') {
    css['list-style'] = 'none';
  }

  // Button centering
  if (node.type === 'button') {
    if (!css.display) css.display = 'flex';
    if (!css['align-items']) css['align-items'] = 'center';
    if (!css['justify-content']) css['justify-content'] = 'center';
  }

  // Avatar placeholder
  if (node.semantics?.role === 'avatar' && !style.backgroundColor && !style.backgroundImage && !node.assetRef) {
    css['background-color'] = '#e0e0e0';
    css['border-radius'] = '50%';
  }
  if (style.borderRadius !== undefined) {
    if (Array.isArray(style.borderRadius)) {
      const [tl, tr, br, bl] = style.borderRadius;
      css['border-radius'] = `${px(tl)} ${px(tr)} ${px(br)} ${px(bl)}`;
    } else {
      css['border-radius'] = px(style.borderRadius);
    }
  }
  if (style.border) {
    css.border = `${px(style.border.width)} ${style.border.style} ${style.border.color}`;
  }
  if (style.shadows && style.shadows.length) {
    css['box-shadow'] = style.shadows
      .map(
        (s) =>
          `${px(s.x)} ${px(s.y)} ${px(s.blur)}${s.spread ? ' ' + px(s.spread) : ''} ${s.color}`,
      )
      .join(', ');
  }
  if (style.opacity !== undefined && style.opacity < 1) {
    css.opacity = String(style.opacity);
  }
  if (style.overflow) {
    css.overflow = style.overflow;
  }

  // Text
  if (textStyle) {
    css['font-size'] = px(textStyle.fontSize);
    css['font-weight'] = String(textStyle.fontWeight);
    css.color = textStyle.color;
    if (textStyle.lineHeight) css['line-height'] = px(textStyle.lineHeight);
    if (textStyle.letterSpacing) css['letter-spacing'] = px(textStyle.letterSpacing);
    if (textStyle.fontFamily) css['font-family'] = `"${textStyle.fontFamily}", sans-serif`;
    if (textStyle.textAlign) css['text-align'] = textStyle.textAlign;
  }

  // 按钮文字对比度修正：深色背景上确保文字可读
  if (node.type === 'button' && style.backgroundColor && textStyle) {
    const bg = style.backgroundColor;
    const fg = textStyle.color;
    if (isDarkColor(bg) && isDarkColor(fg)) {
      css.color = '#ffffff';
    }
  }

  return css;
}

export function cssPropsToInline(props: Record<string, string>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

export function cssPropsToBlock(props: Record<string, string>, indent = 2): string {
  const pad = ' '.repeat(indent);
  return Object.entries(props)
    .map(([k, v]) => `${pad}${k}: ${v};`)
    .join('\n');
}
