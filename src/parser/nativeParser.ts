/**
 * Native d2c design format parser.
 *
 * This is a friendly hand-authorable JSON schema that exercises the
 * whole pipeline without requiring an actual .fig / .sketch file. It
 * mirrors the IR fairly closely but accepts shorter shortcuts:
 *
 *   - `width`/`height` default to `auto`
 *   - `layout` defaults to absolute if children overlap, else flex
 *   - `type` defaults to `container`
 *   - `children` defaults to `[]`
 */
import type {
  Box,
  IRDocument,
  IRNode,
  IRNodeType,
  Layout,
  Style,
  TextStyle,
} from '../ir/types';
import { validateIR } from '../ir/schema';

interface NativeInputNode {
  id?: string;
  name?: string;
  type?: IRNodeType;
  x?: number;
  y?: number;
  width?: number | 'auto' | 'fill';
  height?: number | 'auto' | 'fill';
  padding?: number | [number, number, number, number];
  background?: string;
  backgroundColor?: string;
  borderRadius?: number;
  border?: { width: number; color: string; style?: 'solid' | 'dashed' | 'dotted' };
  shadow?: {
    x: number;
    y: number;
    blur: number;
    spread?: number;
    color: string;
  };
  opacity?: number;
  layout?: Partial<Layout>;
  text?:
    | string
    | {
        content: string;
        fontSize?: number;
        fontWeight?: number;
        color?: string;
        lineHeight?: number;
        align?: 'left' | 'center' | 'right';
        fontFamily?: string;
      };
  src?: string;
  children?: NativeInputNode[];
  role?: IRNode['semantics'] extends infer S
    ? S extends { role?: infer R }
      ? R
      : never
    : never;
}

interface NativeInputDoc {
  name?: string;
  width: number;
  height: number;
  root: NativeInputNode;
}

let nextId = 0;
function uid(prefix: string): string {
  return `${prefix}_${++nextId}`;
}

function normPadding(
  p?: number | [number, number, number, number],
): [number, number, number, number] | undefined {
  if (p === undefined) return undefined;
  if (typeof p === 'number') return [p, p, p, p];
  return p;
}

function toNode(input: NativeInputNode): IRNode {
  const type: IRNodeType = input.type ?? 'container';

  const box: Box = {
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: input.width ?? 'auto',
    height: input.height ?? 'auto',
    padding: normPadding(input.padding),
  };

  const style: Style = {
    backgroundColor: input.background ?? input.backgroundColor,
    borderRadius: input.borderRadius,
    border: input.border
      ? {
          width: input.border.width,
          color: input.border.color,
          style: input.border.style ?? 'solid',
        }
      : undefined,
    shadows: input.shadow ? [input.shadow] : undefined,
    opacity: input.opacity,
  };

  let textStyle: TextStyle | undefined;
  let resolvedType = type;
  if (input.text !== undefined) {
    resolvedType = 'text';
    if (typeof input.text === 'string') {
      textStyle = {
        content: input.text,
        fontSize: 14,
        fontWeight: 400,
        color: '#111111',
      };
    } else {
      textStyle = {
        content: input.text.content,
        fontSize: input.text.fontSize ?? 14,
        fontWeight: input.text.fontWeight ?? 400,
        color: input.text.color ?? '#111111',
        lineHeight: input.text.lineHeight,
        textAlign: input.text.align,
        fontFamily: input.text.fontFamily,
      };
    }
  }

  const layout: Layout = {
    type: input.layout?.type ?? 'absolute',
    direction: input.layout?.direction,
    justifyContent: input.layout?.justifyContent,
    alignItems: input.layout?.alignItems,
    gap: input.layout?.gap,
    columns: input.layout?.columns,
  };

  const node: IRNode = {
    id: input.id ?? uid(resolvedType),
    name: input.name ?? resolvedType,
    type: resolvedType,
    box,
    layout,
    style,
    textStyle,
    assetRef: input.src,
    children: (input.children ?? []).map(toNode),
    semantics: input.role ? { role: input.role as any } : undefined,
  };

  return node;
}

export function parseNativeDesign(raw: unknown): IRDocument {
  nextId = 0;
  if (!raw || typeof raw !== 'object')
    throw new Error('Native design input must be an object');
  const input = raw as NativeInputDoc;
  if (typeof input.width !== 'number' || typeof input.height !== 'number') {
    throw new Error('Native design input must have numeric width & height');
  }
  const doc: IRDocument = {
    name: input.name ?? 'Untitled',
    width: input.width,
    height: input.height,
    root: toNode(input.root),
  };
  validateIR(doc);
  return doc;
}
