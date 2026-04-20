/**
 * SVG Renderer
 *
 * Converts a RenderNode tree into an SVG string that faithfully reproduces
 * the visual appearance of the original Sketch design.
 *
 * Supported features:
 *   - Rectangles (with per-corner radii), ovals, groups, artboards
 *   - Solid color fills, linear/radial/angular gradients
 *   - Multiple fills and borders per layer
 *   - Drop shadows and inner shadows via SVG filters
 *   - Gaussian and background blur
 *   - Opacity (layer-level and per-fill)
 *   - Rotation transforms
 *   - Clipping masks
 *   - Rich text rendering (multiple styled runs)
 *   - Placeholder images
 */

import type {
  RenderNode,
  RenderArtboard,
  RenderFill,
  RenderBorder,
  RenderShadow,
  RenderGradient,
  RenderText,
  RenderBlur,
  SketchRenderOptions,
} from './types';

/* ── SVG Build Context ────────────────────────────────────────────────── */

interface SvgContext {
  /** <defs> accumulator — gradients, filters, clip paths */
  defs: string[];
  /** Unique ID counter for defs */
  idCounter: number;
  /** Scale factor */
  scale: number;
}

function nextId(ctx: SvgContext, prefix: string): string {
  return `${prefix}_${++ctx.idCounter}`;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function px(n: number, scale: number): number {
  return Math.round(n * scale * 100) / 100;
}

function borderRadiusAttr(
  br: number | [number, number, number, number] | undefined,
  scale: number,
): string {
  if (br === undefined) return '';
  if (typeof br === 'number') {
    return ` rx="${px(br, scale)}" ry="${px(br, scale)}"`;
  }
  // SVG <rect> only supports uniform rx/ry.  For per-corner we use a <path>.
  return '';
}

function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
  scale: number,
): string {
  const [tl, tr, br, bl] = radii.map((r) => px(r, scale));
  const sx = px(x, scale);
  const sy = px(y, scale);
  const sw = px(w, scale);
  const sh = px(h, scale);
  // Clamp radii so they don't exceed half-dimensions
  const maxR = Math.min(sw / 2, sh / 2);
  const rtl = Math.min(tl, maxR);
  const rtr = Math.min(tr, maxR);
  const rbr = Math.min(br, maxR);
  const rbl = Math.min(bl, maxR);
  return [
    `M${sx + rtl},${sy}`,
    `H${sx + sw - rtr}`,
    rtr > 0 ? `A${rtr},${rtr} 0 0 1 ${sx + sw},${sy + rtr}` : '',
    `V${sy + sh - rbr}`,
    rbr > 0 ? `A${rbr},${rbr} 0 0 1 ${sx + sw - rbr},${sy + sh}` : '',
    `H${sx + rbl}`,
    rbl > 0 ? `A${rbl},${rbl} 0 0 1 ${sx},${sy + sh - rbl}` : '',
    `V${sy + rtl}`,
    rtl > 0 ? `A${rtl},${rtl} 0 0 1 ${sx + rtl},${sy}` : '',
    'Z',
  ].join(' ');
}

/* ── Gradient Defs ────────────────────────────────────────────────────── */

function renderGradientDef(
  grad: RenderGradient,
  id: string,
): string {
  const stops = grad.stops
    .map(
      (s) =>
        `<stop offset="${(s.position * 100).toFixed(1)}%" stop-color="${esc(s.color)}" />`,
    )
    .join('');

  if (grad.type === 'linear') {
    return `<linearGradient id="${id}" x1="${grad.from.x}" y1="${grad.from.y}" x2="${grad.to.x}" y2="${grad.to.y}" gradientUnits="objectBoundingBox">${stops}</linearGradient>`;
  }
  if (grad.type === 'radial') {
    const cx = grad.from.x;
    const cy = grad.from.y;
    const r = Math.max(
      Math.hypot(grad.to.x - grad.from.x, grad.to.y - grad.from.y),
      0.5,
    );
    return `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}" gradientUnits="objectBoundingBox">${stops}</radialGradient>`;
  }
  // Angular / conic: SVG1 doesn't support conic-gradient natively.
  // We approximate with a linear gradient for now.
  return `<linearGradient id="${id}" x1="${grad.from.x}" y1="${grad.from.y}" x2="${grad.to.x}" y2="${grad.to.y}" gradientUnits="objectBoundingBox">${stops}</linearGradient>`;
}

/* ── Filter Defs (shadows, blur) ──────────────────────────────────────── */

function buildFilterDef(
  shadows: RenderShadow[],
  innerShadows: RenderShadow[],
  blur: RenderBlur | undefined,
  id: string,
  scale: number,
): string | null {
  if (!shadows.length && !innerShadows.length && !blur) return null;

  const parts: string[] = [];
  let mergeInputs: string[] = ['SourceGraphic'];

  // Gaussian blur
  if (blur && blur.type === 'gaussian' && blur.radius > 0) {
    const std = px(blur.radius, scale);
    parts.push(
      `<feGaussianBlur in="SourceGraphic" stdDeviation="${std}" result="blur0" />`,
    );
    mergeInputs = ['blur0'];
  }

  // Drop shadows
  for (let i = 0; i < shadows.length; i++) {
    const s = shadows[i];
    const result = `shadow${i}`;
    parts.push(
      `<feDropShadow dx="${px(s.x, scale)}" dy="${px(s.y, scale)}" stdDeviation="${px(s.blur / 2, scale)}" flood-color="${esc(s.color)}" flood-opacity="1" result="${result}" />`,
    );
    mergeInputs.unshift(result);
  }

  // Inner shadows — composite technique
  for (let i = 0; i < innerShadows.length; i++) {
    const s = innerShadows[i];
    const idx = `inner${i}`;
    parts.push(
      `<feComponentTransfer in="SourceAlpha" result="${idx}_inv"><feFuncA type="table" tableValues="1 0" /></feComponentTransfer>`,
      `<feGaussianBlur in="${idx}_inv" stdDeviation="${px(s.blur / 2, scale)}" result="${idx}_blur" />`,
      `<feOffset dx="${px(s.x, scale)}" dy="${px(s.y, scale)}" in="${idx}_blur" result="${idx}_off" />`,
      `<feComposite in="${idx}_off" in2="SourceAlpha" operator="in" result="${idx}_clip" />`,
      `<feFlood flood-color="${esc(s.color)}" result="${idx}_color" />`,
      `<feComposite in="${idx}_color" in2="${idx}_clip" operator="in" result="${idx}_final" />`,
    );
    mergeInputs.push(`${idx}_final`);
  }

  if (parts.length === 0) return null;

  const merge =
    mergeInputs.length > 1
      ? `<feMerge>${mergeInputs.map((inp) => `<feMergeNode in="${inp}" />`).join('')}</feMerge>`
      : '';

  // Expand filter region for shadows
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" filterUnits="objectBoundingBox">${parts.join('')}${merge}</filter>`;
}

/* ── Shape Rendering ──────────────────────────────────────────────────── */

function shapeElement(
  node: RenderNode,
  fill: string,
  stroke: string,
  strokeWidth: number,
  ctx: SvgContext,
): string {
  const s = ctx.scale;
  const x = px(node.frame.x, s);
  const y = px(node.frame.y, s);
  const w = px(node.frame.width, s);
  const h = px(node.frame.height, s);

  const fillAttr = fill ? ` fill="${fill}"` : ' fill="none"';
  const strokeAttr = stroke
    ? ` stroke="${stroke}" stroke-width="${strokeWidth}"`
    : '';

  if (node.type === 'oval') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    return `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}"${fillAttr}${strokeAttr} />`;
  }

  // Per-corner radii → use <path>
  if (Array.isArray(node.borderRadius)) {
    const d = roundedRectPath(
      node.frame.x,
      node.frame.y,
      node.frame.width,
      node.frame.height,
      node.borderRadius,
      s,
    );
    return `<path d="${d}"${fillAttr}${strokeAttr} />`;
  }

  const brAttr = borderRadiusAttr(node.borderRadius, s);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}"${brAttr}${fillAttr}${strokeAttr} />`;
}

/* ── Fill Rendering ───────────────────────────────────────────────────── */

function isResolvableImageRef(ref: string | undefined): ref is string {
  if (!ref) return false;
  return ref.startsWith('data:') || ref.startsWith('http://') || ref.startsWith('https://') ||
         ref.startsWith('./') || ref.startsWith('/');
}

function resolveFillValue(fill: RenderFill, ctx: SvgContext, node?: RenderNode): string {
  if (fill.type === 'color' && fill.color) return esc(fill.color);
  if (fill.type === 'gradient' && fill.gradient) {
    const gradId = nextId(ctx, 'grad');
    ctx.defs.push(renderGradientDef(fill.gradient, gradId));
    return `url(#${gradId})`;
  }
  // Image / pattern fill: if we have a resolvable reference, emit a
  // <pattern> containing an <image> that fills the node's bounding box.
  if (fill.type === 'pattern' && isResolvableImageRef(fill.patternRef) && node) {
    const s = ctx.scale;
    const w = px(node.frame.width, s);
    const h = px(node.frame.height, s);
    const x = px(node.frame.x, s);
    const y = px(node.frame.y, s);
    const patId = nextId(ctx, 'imgfill');
    ctx.defs.push(
      `<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}">` +
      `<image href="${esc(fill.patternRef!)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" />` +
      `</pattern>`,
    );
    return `url(#${patId})`;
  }
  // Unresolvable pattern: light gray placeholder
  return '#e0e0e0';
}

/* ── Text Rendering ───────────────────────────────────────────────────── */

function renderText(node: RenderNode, ctx: SvgContext): string {
  if (!node.text) return '';
  const s = ctx.scale;
  const x = px(node.frame.x, s);
  const y = px(node.frame.y, s);
  const w = px(node.frame.width, s);
  const text = node.text;

  // Build styled <tspan> elements
  const runs = text.runs;
  if (runs.length === 0) return '';

  const firstStyle = runs[0].style;
  const anchor =
    firstStyle.textAlign === 'center' ? 'middle'
    : firstStyle.textAlign === 'right' ? 'end'
    : 'start';
  const textX =
    firstStyle.textAlign === 'center' ? x + w / 2
    : firstStyle.textAlign === 'right' ? x + w
    : x;
  // Approximate baseline offset
  const baselineY = y + px(firstStyle.fontSize * 0.85, s);

  const tspans = runs
    .map((run) => {
      const st = run.style;
      const attrs: string[] = [];
      attrs.push(`fill="${esc(st.color)}"`);
      attrs.push(`font-family="${esc(st.fontFamily)}, sans-serif"`);
      attrs.push(`font-size="${px(st.fontSize, s)}"`);
      attrs.push(`font-weight="${st.fontWeight}"`);
      if (st.letterSpacing) attrs.push(`letter-spacing="${px(st.letterSpacing, s)}"`);
      if (st.textDecoration === 'underline') attrs.push('text-decoration="underline"');
      if (st.textDecoration === 'line-through') attrs.push('text-decoration="line-through"');

      // Split multi-line text into <tspan> per line
      const lines = run.content.split('\n');
      if (lines.length <= 1) {
        return `<tspan ${attrs.join(' ')}>${esc(run.content)}</tspan>`;
      }
      return lines
        .map((line, idx) => {
          const lineAttrs = [...attrs];
          if (idx > 0) {
            lineAttrs.push(`x="${textX}"`);
            lineAttrs.push(`dy="${px(st.lineHeight ?? st.fontSize * 1.4, s)}"`);
          }
          return `<tspan ${lineAttrs.join(' ')}>${esc(line)}</tspan>`;
        })
        .join('');
    })
    .join('');

  return `<text x="${textX}" y="${baselineY}" text-anchor="${anchor}">${tspans}</text>`;
}

/* ── Image Rendering ──────────────────────────────────────────────────── */

function renderImage(node: RenderNode, ctx: SvgContext): string {
  const s = ctx.scale;
  const x = px(node.frame.x, s);
  const y = px(node.frame.y, s);
  const w = px(node.frame.width, s);
  const h = px(node.frame.height, s);

  // If we have a real image reference (data URI, URL), render it directly.
  if (isResolvableImageRef(node.imageRef)) {
    const radiusClip = resolveClipForImage(node, ctx);
    const imgTag = `<image href="${esc(node.imageRef!)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"${radiusClip} />`;
    return imgTag;
  }

  // Crosshatch placeholder for images (since we don't have the actual bitmap)
  const patId = nextId(ctx, 'imgpat');
  ctx.defs.push(
    `<pattern id="${patId}" width="8" height="8" patternUnits="userSpaceOnUse">` +
    `<rect width="8" height="8" fill="#e8e8e8" />` +
    `<path d="M0,8 L8,0 M-1,1 L1,-1 M7,9 L9,7" stroke="#ccc" stroke-width="0.5" />` +
    `</pattern>`,
  );

  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${patId})" stroke="#ccc" stroke-width="0.5" />`;
}

function resolveClipForImage(node: RenderNode, ctx: SvgContext): string {
  if (node.borderRadius === undefined) return '';
  const s = ctx.scale;
  const clipId = nextId(ctx, 'imgclip');
  if (typeof node.borderRadius === 'number') {
    ctx.defs.push(
      `<clipPath id="${clipId}"><rect x="${px(node.frame.x, s)}" y="${px(node.frame.y, s)}" width="${px(node.frame.width, s)}" height="${px(node.frame.height, s)}" rx="${px(node.borderRadius, s)}" ry="${px(node.borderRadius, s)}" /></clipPath>`,
    );
  } else {
    const d = roundedRectPath(
      node.frame.x, node.frame.y, node.frame.width, node.frame.height,
      node.borderRadius, s,
    );
    ctx.defs.push(`<clipPath id="${clipId}"><path d="${d}" /></clipPath>`);
  }
  return ` clip-path="url(#${clipId})"`;
}

/* ── Node Rendering (recursive) ───────────────────────────────────────── */

function renderNode(node: RenderNode, ctx: SvgContext, indent: number): string {
  if (!node.isVisible) return '';

  const pad = '  '.repeat(indent);
  const s = ctx.scale;
  const parts: string[] = [];

  // Build transform
  const transforms: string[] = [];
  if (node.rotation !== 0) {
    const cx = px(node.frame.x + node.frame.width / 2, s);
    const cy = px(node.frame.y + node.frame.height / 2, s);
    transforms.push(`rotate(${-node.rotation}, ${cx}, ${cy})`);
  }
  const transformAttr = transforms.length
    ? ` transform="${transforms.join(' ')}"`
    : '';

  // Build filter
  let filterAttr = '';
  if (node.shadows.length || node.innerShadows.length || node.blur) {
    const filterId = nextId(ctx, 'filter');
    const filterDef = buildFilterDef(
      node.shadows,
      node.innerShadows,
      node.blur,
      filterId,
      s,
    );
    if (filterDef) {
      ctx.defs.push(filterDef);
      filterAttr = ` filter="url(#${filterId})"`;
    }
  }

  // Opacity
  const opacityAttr = node.opacity < 1 ? ` opacity="${node.opacity}"` : '';

  // Clipping
  let clipAttr = '';
  if (node.clipContent && node.children.length > 0) {
    const clipId = nextId(ctx, 'clip');
    // Simple rectangular clip matching the node bounds
    const cx = px(node.frame.x, s);
    const cy = px(node.frame.y, s);
    const cw = px(node.frame.width, s);
    const ch = px(node.frame.height, s);
    let clipShape: string;
    if (node.borderRadius && typeof node.borderRadius === 'number') {
      clipShape = `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="${px(node.borderRadius, s)}" ry="${px(node.borderRadius, s)}" />`;
    } else if (Array.isArray(node.borderRadius)) {
      const d = roundedRectPath(
        node.frame.x,
        node.frame.y,
        node.frame.width,
        node.frame.height,
        node.borderRadius,
        s,
      );
      clipShape = `<path d="${d}" />`;
    } else {
      clipShape = `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" />`;
    }
    ctx.defs.push(`<clipPath id="${clipId}">${clipShape}</clipPath>`);
    clipAttr = ` clip-path="url(#${clipId})"`;
  }

  // Open group
  const gAttrs = `${transformAttr}${filterAttr}${opacityAttr}${clipAttr}`;
  const needsGroup =
    gAttrs.length > 0 || node.children.length > 0 || node.type === 'group';

  if (needsGroup) {
    parts.push(`${pad}<g${gAttrs}>`);
  }

  // Render shape with fills
  if (node.type === 'text') {
    parts.push(`${pad}  ${renderText(node, ctx)}`);
  } else if (node.type === 'image') {
    parts.push(`${pad}  ${renderImage(node, ctx)}`);
  } else if (
    node.type === 'rectangle' ||
    node.type === 'oval' ||
    node.type === 'artboard' ||
    node.type === 'shapeGroup' ||
    node.type === 'symbolInstance' ||
    node.type === 'triangle' ||
    node.type === 'star' ||
    node.type === 'polygon'
  ) {
    // Render each fill as a separate shape element (bottom to top)
    if (node.fills.length === 0 && node.borders.length === 0) {
      // Invisible shape — render transparent for structure
      parts.push(`${pad}  ${shapeElement(node, 'none', '', 0, ctx)}`);
    } else {
      for (const fill of node.fills) {
        const fillVal = resolveFillValue(fill, ctx, node);
        const fillOpacity =
          fill.opacity !== undefined && fill.opacity < 1
            ? ` opacity="${fill.opacity}"`
            : '';
        parts.push(
          `${pad}  ${shapeElement(node, fillVal, '', 0, ctx).replace('/>', `${fillOpacity} />`)}`,
        );
      }
      // Render borders
      for (const border of node.borders) {
        const bOpacity =
          border.opacity !== undefined && border.opacity < 1
            ? ` opacity="${border.opacity}"`
            : '';
        parts.push(
          `${pad}  ${shapeElement(node, 'none', esc(border.color), px(border.thickness, s), ctx).replace('/>', `${bOpacity} />`)}`,
        );
      }
    }
  }

  // Render children
  for (const child of node.children) {
    const childSvg = renderNode(child, ctx, indent + 1);
    if (childSvg) parts.push(childSvg);
  }

  if (needsGroup) {
    parts.push(`${pad}</g>`);
  }

  return parts.join('\n');
}

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * Render a single artboard's render tree to an SVG string.
 */
export function renderArtboardToSvg(
  artboard: RenderArtboard,
  options?: SketchRenderOptions,
): string {
  const scale = options?.scale ?? 1;
  const ctx: SvgContext = { defs: [], idCounter: 0, scale };

  const w = px(artboard.frame.width, scale);
  const h = px(artboard.frame.height, scale);

  // artboard 的 frame.x/y 是页面级坐标，但子元素使用相对于 artboard 的局部坐标，
  // 所以渲染时需要将 root 的 frame 归零以保持坐标一致
  const root: RenderNode = {
    ...artboard.root,
    frame: { ...artboard.root.frame, x: 0, y: 0 },
  };
  const body = renderNode(root, ctx, 1);

  const defs = ctx.defs.length
    ? `  <defs>\n    ${ctx.defs.join('\n    ')}\n  </defs>\n`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${defs}${body}
</svg>`;
}

/**
 * Render all artboards in a RenderDocument to a map of { name → SVG string }.
 */
export function renderDocumentToSvg(
  artboards: RenderArtboard[],
  options?: SketchRenderOptions,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const ab of artboards) {
    result.set(ab.name, renderArtboardToSvg(ab, options));
  }
  return result;
}
