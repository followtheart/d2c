/**
 * Shared CSS property builder used by HTML and Vue generators.
 * Maps IR → inline style declarations.
 */
import type { IRNode } from '../ir/types';

function px(n: number): string {
  return `${Math.round(n)}px`;
}

function numOr(n: number | 'auto' | 'fill', fallback: string): string {
  if (typeof n === 'number') return px(n);
  if (n === 'fill') return '100%';
  return fallback;
}

export function buildCssProps(node: IRNode): Record<string, string> {
  const css: Record<string, string> = {};
  const { box, layout, style, textStyle } = node;

  // Box sizing
  if (box.width !== 'auto') css.width = numOr(box.width, 'auto');
  if (box.height !== 'auto') css.height = numOr(box.height, 'auto');
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
  } else if (layout.type === 'absolute') {
    css.position = 'relative';
  }

  // Style
  if (style.backgroundColor) css['background-color'] = style.backgroundColor;
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
