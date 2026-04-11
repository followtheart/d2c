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
}

export interface IRDocument {
  name: string;
  width: number;
  height: number;
  root: IRNode;
  /** Design tokens extracted during parsing */
  tokens?: DesignTokens;
}

export interface DesignTokens {
  colors: Record<string, string>;
  spacing: Record<string, number>;
  typography: Record<
    string,
    { fontSize: number; fontWeight: number; lineHeight?: number }
  >;
}
