/**
 * Sketch Rendering Engine — Type Definitions
 *
 * These types form the "render tree", a richer representation than the IR
 * that preserves Sketch-specific visual details needed for faithful rendering:
 * multiple fills/borders, gradients, blur effects, inner shadows, clipping,
 * rotation, and per-corner radii.
 *
 * The render tree is consumed by the SVG and HTML preview renderers.
 */

/* ── Geometry ─────────────────────────────────────────────────────────── */

export interface RenderFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ── Color & Gradient ─────────────────────────────────────────────────── */

export interface GradientStop {
  position: number; // 0-1
  color: string;    // CSS color
}

export interface RenderGradient {
  type: 'linear' | 'radial' | 'angular';
  from: { x: number; y: number }; // 0-1 normalised within the layer
  to: { x: number; y: number };
  stops: GradientStop[];
}

/* ── Fill ──────────────────────────────────────────────────────────────── */

export type FillType = 'color' | 'gradient' | 'pattern';

export interface RenderFill {
  type: FillType;
  color?: string;         // CSS color (for type === 'color')
  gradient?: RenderGradient;
  opacity?: number;       // per-fill opacity (0-1)
  patternRef?: string;    // asset reference for pattern fills
}

/* ── Border ────────────────────────────────────────────────────────────── */

export type BorderPosition = 'center' | 'inside' | 'outside';

export interface RenderBorder {
  color: string;
  thickness: number;
  position: BorderPosition;
  opacity?: number;
}

/* ── Shadow ────────────────────────────────────────────────────────────── */

export interface RenderShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}

/* ── Blur ──────────────────────────────────────────────────────────────── */

export interface RenderBlur {
  type: 'gaussian' | 'motion' | 'zoom' | 'background';
  radius: number;
}

/* ── Text ──────────────────────────────────────────────────────────────── */

export interface RenderTextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign: 'left' | 'center' | 'right' | 'justify';
  textDecoration?: 'none' | 'underline' | 'line-through';
}

export interface RenderTextRun {
  content: string;
  style: RenderTextStyle;
}

export interface RenderText {
  /** Full plain-text content */
  content: string;
  /** Styled runs (for rich text). Falls back to a single run. */
  runs: RenderTextRun[];
}

/* ── Render Node ──────────────────────────────────────────────────────── */

export type RenderNodeType =
  | 'artboard'
  | 'group'
  | 'rectangle'
  | 'oval'
  | 'triangle'
  | 'star'
  | 'polygon'
  | 'path'
  | 'shapeGroup'
  | 'text'
  | 'image'
  | 'symbolInstance'
  | 'slice';

export interface RenderNode {
  id: string;
  name: string;
  type: RenderNodeType;
  /** Frame relative to parent */
  frame: RenderFrame;
  /** Rotation in degrees (clockwise) */
  rotation: number;
  /** Layer opacity (0-1) */
  opacity: number;
  /** Whether the layer is visible */
  isVisible: boolean;
  /** Whether children are clipped to this node's bounds */
  clipContent: boolean;
  /** Whether this layer acts as a clipping mask for the layer above */
  hasClippingMask: boolean;
  /** Fills applied bottom-to-top */
  fills: RenderFill[];
  /** Borders applied bottom-to-top */
  borders: RenderBorder[];
  /** Drop shadows */
  shadows: RenderShadow[];
  /** Inner shadows */
  innerShadows: RenderShadow[];
  /** Gaussian / background blur */
  blur?: RenderBlur;
  /** Border radius — single value or [topLeft, topRight, bottomRight, bottomLeft] */
  borderRadius?: number | [number, number, number, number];
  /** Child nodes */
  children: RenderNode[];
  /** Text content (only for type === 'text') */
  text?: RenderText;
  /** Image asset reference (only for type === 'image') */
  imageRef?: string;
  /** Original Sketch _class for rendering heuristics */
  sketchClass: string;
}

/* ── Render Document ──────────────────────────────────────────────────── */

export interface RenderDocument {
  name: string;
  /** All artboards / top-level layers to render */
  artboards: RenderArtboard[];
}

export interface RenderArtboard {
  name: string;
  frame: RenderFrame;
  backgroundColor?: string;
  root: RenderNode;
}

/* ── Render Options ───────────────────────────────────────────────────── */

export interface SketchRenderOptions {
  /** Scale factor (default 1) */
  scale?: number;
  /** Whether to include hidden layers (default false) */
  includeHidden?: boolean;
  /** Background color for the preview page (default '#f5f5f5') */
  pageBackground?: string;
  /** Whether to render artboard titles (default true) */
  showArtboardTitles?: boolean;
  /** Maximum width for the HTML preview viewport */
  maxPreviewWidth?: number;
}
