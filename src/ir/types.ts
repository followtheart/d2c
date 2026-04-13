/**
 * Design-to-Code Intermediate Representation (IR)
 *
 * The IR is a design-tool-agnostic and target-platform-agnostic tree of nodes
 * that captures geometry, style, text, and semantics. Parsers produce IR;
 * code generators consume IR.
 */

export type IRNodeType =
  | 'container' // generic frame / group / div-like
  | 'text'
  | 'image'
  | 'icon'
  | 'button'
  | 'input'
  | 'list'
  | 'list-item';

export type LayoutType = 'flex' | 'grid' | 'absolute';
export type FlexDirection = 'row' | 'column';
export type AlignValue = 'start' | 'center' | 'end' | 'stretch';
export type JustifyValue =
  | 'start'
  | 'center'
  | 'end'
  | 'space-between'
  | 'space-around'
  | 'space-evenly';

export interface Box {
  x: number;
  y: number;
  width: number | 'auto' | 'fill';
  height: number | 'auto' | 'fill';
  /** top, right, bottom, left */
  padding?: [number, number, number, number];
  margin?: [number, number, number, number];
}

export interface Layout {
  type: LayoutType;
  direction?: FlexDirection;
  justifyContent?: JustifyValue;
  alignItems?: AlignValue;
  gap?: number;
  /** number of columns if grid */
  columns?: number;
}

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread?: number;
  color: string;
}

export interface Border {
  width: number;
  color: string;
  style: 'solid' | 'dashed' | 'dotted';
}

export interface Style {
  backgroundColor?: string;
  backgroundImage?: string;
  borderRadius?: number | [number, number, number, number];
  border?: Border;
  shadows?: Shadow[];
  opacity?: number;
}

export interface TextStyle {
  content: string;
  fontFamily?: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
}

export type SemanticRole =
  | 'header'
  | 'nav'
  | 'footer'
  | 'main'
  | 'aside'
  | 'section'
  | 'card'
  | 'form'
  | 'list'
  | 'list-item'
  | 'button'
  | 'link'
  | 'heading'
  | 'paragraph'
  | 'label'
  | 'icon'
  | 'avatar'
  | 'badge'
  | 'divider';

export interface Semantics {
  role?: SemanticRole;
  interactive?: boolean;
  /** Inferred component name e.g. "UserCard" */
  componentName?: string;
  /** Hint for data binding e.g. "user.name" */
  dataBinding?: string;
  /** Whether this node maps to a known component library component */
  library?: {
    name: string; // 'antd' | 'mui' | ...
    component: string; // 'Button' | 'Card' | ...
    props?: Record<string, unknown>;
  };
  /** Accessible label */
  ariaLabel?: string;
  /**
   * Protected region marker — the IR diff + merge utility will preserve
   * subtrees marked with `aiIgnore: true` across regenerations so user
   * edits and hand-tuned layout don't get clobbered by the next build.
   * Emitted in generated code as a "// ai:ignore" comment.
   */
  aiIgnore?: boolean;
}

/**
 * Responsive variants for a node at different breakpoints. Keyed by
 * breakpoint name (e.g. `sm`, `md`, `lg`). Only properties that differ
 * from the base node need to be listed.
 */
export interface ResponsiveVariants {
  [breakpoint: string]: Partial<{
    box: Partial<Box>;
    layout: Partial<Layout>;
    style: Partial<Style>;
    textStyle: Partial<TextStyle>;
    /** hide this node at the breakpoint */
    hidden: boolean;
  }>;
}

export interface IRNode {
  id: string;
  type: IRNodeType;
  name: string;
  box: Box;
  layout: Layout;
  style: Style;
  textStyle?: TextStyle;
  /** External asset reference (image URL / icon name) */
  assetRef?: string;
  children: IRNode[];
  semantics?: Semantics;
  /** Per-breakpoint overrides (set by responsive inference). */
  responsive?: ResponsiveVariants;
}

export interface IRDocument {
  name: string;
  width: number;
  height: number;
  root: IRNode;
  /** Design tokens extracted during parsing */
  tokens?: DesignTokens;
}

// 多页面文档：包含多个 IRDocument（页面）
export interface IRMultiPageDocument {
  name: string;
  pages: IRDocument[];
}

export interface DesignTokens {
  colors: Record<string, string>;
  spacing: Record<string, number>;
  typography: Record<
    string,
    { fontSize: number; fontWeight: number; lineHeight?: number }
  >;
}
