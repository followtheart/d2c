/**
 * Figma Make (.make) File Parser
 *
 * Reads .make binary files produced by Figma Make (AI-powered code prototype
 * tool), decompresses the embedded Kiwi schema + data chunks, decodes them,
 * and converts the result into the d2c Intermediate Representation (IR).
 *
 * .make file binary layout:
 *   - Magic header (12 bytes): "fig-makee" + padding / version
 *   - Chunk table: per-chunk descriptors (type, sizes)
 *   - Schema chunk: zlib-compressed Kiwi schema definitions (~534 types)
 *   - Data chunk: zstd-compressed Kiwi-encoded document data
 *
 * Decompression strategy:
 *   - zlib: Node.js built-in `zlib` module (always available)
 *   - zstd: Node.js 22+ `zlib.constants.ZSTD_*` or optional `fzstd` package
 *
 * The parser also accepts pre-decoded JSON for testing and for pipelines
 * that have already extracted the .make contents externally.
 */
import * as zlib from 'zlib';
import type {
  Box,
  IRDocument,
  IRNode,
  IRNodeType,
  Layout,
  Style,
  TextStyle,
} from '../ir/types';
import { anyColorToCss } from '../utils/color';
import { validateIR } from '../ir/schema';
import { ByteBuffer, parseKiwiSchema, decodeKiwiMessage } from './kiwi';
import type { KiwiSchema, KiwiValue } from './kiwi';

/* ── .make Binary Magic ──────────────────────────────────────────────── */

const MAKE_MAGIC = 'fig-makee';
const ZSTD_MAGIC = new Uint8Array([0x28, 0xB5, 0x2F, 0xFD]);

/* ── Chunk Extraction ────────────────────────────────────────────────── */

interface MakeChunks {
  schemaBytes: Uint8Array;
  dataBytes: Uint8Array;
}

/**
 * Detect whether a Buffer starts with the .make magic header.
 */
export function isMakeBinary(buf: Buffer | Uint8Array): boolean {
  if (buf.length < 12) return false;
  const magic = new TextDecoder('ascii').decode(buf.slice(0, MAKE_MAGIC.length));
  return magic === MAKE_MAGIC;
}

/**
 * Find the byte offset of a 4-byte pattern in a buffer.
 */
function findPattern(buf: Uint8Array, pattern: Uint8Array, startOffset = 0): number {
  for (let i = startOffset; i <= buf.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (buf[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Try to decompress zstd-compressed data.
 *
 * Strategy:
 *   1. Node.js 22+ may support zstd natively  (zlib undocumented API)
 *   2. Optional peer dep `fzstd`  (pure-JS Zstandard)
 *   3. Fail with a helpful message
 */
async function decompressZstd(compressed: Uint8Array): Promise<Uint8Array> {
  // Strategy 1: Node.js 22+ native zstd (undocumented / experimental)
  try {
    const zlibAny = zlib as Record<string, unknown>;
    if (typeof zlibAny.zstdDecompress === 'function') {
      return await new Promise<Uint8Array>((resolve, reject) => {
        (zlibAny.zstdDecompress as Function)(
          Buffer.from(compressed),
          (err: Error | null, result: Buffer) => {
            if (err) reject(err);
            else resolve(new Uint8Array(result));
          },
        );
      });
    }
  } catch {
    // not available — fall through
  }

  // Strategy 2: optional `fzstd` package
  try {
    const fzstd = await import('fzstd' as string);
    if (typeof fzstd.decompress === 'function') {
      return fzstd.decompress(compressed);
    }
    if (fzstd.default && typeof fzstd.default.decompress === 'function') {
      return fzstd.default.decompress(compressed);
    }
  } catch {
    // not installed — fall through
  }

  throw new Error(
    'Zstandard decompression is required to read .make files.\n' +
    'Install the optional `fzstd` package:  npm install fzstd\n' +
    '(Or use Node.js 22+ which includes experimental zstd support.)',
  );
}

/**
 * Read a .make binary file and extract / decompress the schema + data chunks.
 *
 * Two parsing strategies:
 *   A. Structured header: parse chunk table at known offsets
 *   B. Signature scan: find zlib (0x78 xx) and zstd (0x28 B5 2F FD) headers
 */
async function extractChunks(buf: Buffer): Promise<MakeChunks> {
  if (!isMakeBinary(buf)) {
    throw new Error('Not a valid Figma Make file (missing "fig-makee" magic header)');
  }

  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  // ── Strategy A: Structured header parsing ────────────────────────────
  // After the 12-byte magic, try reading chunk count + descriptors.
  // Each descriptor: { type: u32, compressedSize: u32, uncompressedSize: u32 }
  try {
    const bb = new ByteBuffer(bytes);
    bb.seek(12); // skip magic + padding

    const headerSize = bb.readUint32LE();
    // The chunk table starts after the header block
    const chunkTableOffset = 12 + 4 + headerSize;
    if (chunkTableOffset < buf.length - 8) {
      bb.seek(chunkTableOffset);
      const numChunks = bb.readUint32LE();

      if (numChunks >= 2 && numChunks <= 16) {
        const descriptors: { type: number; compSize: number; rawSize: number }[] = [];
        for (let i = 0; i < numChunks; i++) {
          descriptors.push({
            type: bb.readUint32LE(),
            compSize: bb.readUint32LE(),
            rawSize: bb.readUint32LE(),
          });
        }

        // Read chunk data sequentially after descriptors
        let schemaBytes: Uint8Array | null = null;
        let dataBytes: Uint8Array | null = null;

        for (const desc of descriptors) {
          const chunkData = bb.readBytes(desc.compSize);
          if (desc.type === 0 && !schemaBytes) {
            // Schema chunk — zlib compressed
            schemaBytes = new Uint8Array(zlib.inflateSync(Buffer.from(chunkData)));
          } else if (desc.type === 1 && !dataBytes) {
            // Data chunk — zstd compressed
            dataBytes = await decompressZstd(chunkData);
          }
        }

        if (schemaBytes && dataBytes) {
          return { schemaBytes, dataBytes };
        }
      }
    }
  } catch {
    // Structured parse failed — fall through to scan
  }

  // ── Strategy B: Signature scan ───────────────────────────────────────
  // Find zlib header (0x78 followed by 0x01/0x5E/0x9C/0xDA)
  let schemaBytes: Uint8Array | null = null;
  let zlibEnd = 12;

  for (let i = 12; i < buf.length - 2; i++) {
    if (bytes[i] === 0x78 && (bytes[i + 1] === 0x01 || bytes[i + 1] === 0x5E ||
        bytes[i + 1] === 0x9C || bytes[i + 1] === 0xDA)) {
      try {
        const result = zlib.inflateSync(Buffer.from(bytes.slice(i)));
        schemaBytes = new Uint8Array(result);
        // inflateSync consumes exactly the right amount; estimate end
        zlibEnd = i + Math.max(result.length / 4, 64);
        break;
      } catch {
        // false positive — keep scanning
      }
    }
  }

  // Find zstd header (0x28 0xB5 0x2F 0xFD)
  const zstdOffset = findPattern(bytes, ZSTD_MAGIC, zlibEnd);
  let dataBytes: Uint8Array | null = null;
  if (zstdOffset >= 0) {
    const zstdData = bytes.slice(zstdOffset);
    dataBytes = await decompressZstd(zstdData);
  }

  if (!schemaBytes) {
    throw new Error(
      'Could not locate the Kiwi schema chunk in the .make file.\n' +
      'The file may be corrupted or use an unsupported format version.',
    );
  }
  if (!dataBytes) {
    throw new Error(
      'Could not locate or decompress the data chunk in the .make file.\n' +
      'Ensure `fzstd` is installed (npm install fzstd) for Zstandard support.',
    );
  }

  return { schemaBytes, dataBytes };
}

/* ── Decoded Make Document Types ─────────────────────────────────────── */

/** A decoded node from the .make Kiwi data. */
export interface MakeNode {
  id: string;
  type: string;
  name: string;
  visible?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  fills?: MakePaint[];
  strokes?: MakePaint[];
  strokeWeight?: number;
  cornerRadius?: number;
  opacity?: number;
  characters?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
  textAlignHorizontal?: string;
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  effects?: MakeEffect[];
  children?: MakeNode[];
}

export interface MakePaint {
  type: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number; a?: number };
  opacity?: number;
  imageRef?: string;
}

export interface MakeEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  offset?: { x: number; y: number };
  color?: { r: number; g: number; b: number; a?: number };
  spread?: number;
}

/** A code file extracted from a .make project. */
export interface MakeCodeFile {
  path: string;
  content: string;
  language: string;
}

/** Top-level decoded .make document. */
export interface MakeDocument {
  name: string;
  schemaVersion?: number;
  nodes: MakeNode[];
  codeFiles: MakeCodeFile[];
  width: number;
  height: number;
}

/* ── Kiwi Data → MakeDocument ────────────────────────────────────────── */

/** Map of Kiwi field names to likely semantic meanings. */
const NODE_TYPE_MAP: Record<string, string> = {
  FRAME: 'FRAME',
  GROUP: 'GROUP',
  COMPONENT: 'COMPONENT',
  COMPONENT_SET: 'COMPONENT_SET',
  INSTANCE: 'INSTANCE',
  RECTANGLE: 'RECTANGLE',
  TEXT: 'TEXT',
  VECTOR: 'VECTOR',
  ELLIPSE: 'ELLIPSE',
  LINE: 'LINE',
  STAR: 'STAR',
  POLYGON: 'POLYGON',
  IMAGE: 'IMAGE',
  SECTION: 'SECTION',
  CODE_FILE: 'CODE_FILE',
};

type KObj = Record<string, KiwiValue>;

function str(v: KiwiValue | undefined): string {
  return typeof v === 'string' ? v : '';
}
function num(v: KiwiValue | undefined): number {
  return typeof v === 'number' ? v : 0;
}
function bool(v: KiwiValue | undefined): boolean {
  return v === true;
}

function extractColor(v: KiwiValue | undefined): { r: number; g: number; b: number; a?: number } | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as KObj;
  if ('r' in obj || 'red' in obj) {
    return {
      r: num(obj.r ?? obj.red),
      g: num(obj.g ?? obj.green),
      b: num(obj.b ?? obj.blue),
      a: obj.a !== undefined ? num(obj.a) : obj.alpha !== undefined ? num(obj.alpha) : undefined,
    };
  }
  return undefined;
}

function extractPaint(v: KiwiValue): MakePaint | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as KObj;
  return {
    type: str(obj.type ?? obj.paintType) || 'SOLID',
    visible: obj.visible !== undefined ? bool(obj.visible) : true,
    color: extractColor(obj.color),
    opacity: obj.opacity !== undefined ? num(obj.opacity) : undefined,
    imageRef: str(obj.imageRef ?? obj.image),
  };
}

function extractEffect(v: KiwiValue): MakeEffect | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as KObj;
  const offset = obj.offset && typeof obj.offset === 'object' && !Array.isArray(obj.offset)
    ? { x: num((obj.offset as KObj).x), y: num((obj.offset as KObj).y) }
    : undefined;
  return {
    type: str(obj.type ?? obj.effectType) || 'DROP_SHADOW',
    visible: obj.visible !== undefined ? bool(obj.visible) : true,
    radius: obj.radius !== undefined ? num(obj.radius) : undefined,
    offset,
    color: extractColor(obj.color),
    spread: obj.spread !== undefined ? num(obj.spread) : undefined,
  };
}

function extractMakeNode(v: KiwiValue): MakeNode | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as KObj;

  const rawType = str(obj.type ?? obj.nodeType ?? obj._type) || 'FRAME';
  const type = NODE_TYPE_MAP[rawType] ?? rawType;

  // Bounding box: might be nested in a `boundingBox` or `absoluteBoundingBox` field
  const bb = (obj.absoluteBoundingBox ?? obj.boundingBox ?? obj.bounds ?? obj) as KObj;
  const frame = (obj.frame ?? obj) as KObj;

  const node: MakeNode = {
    id: str(obj.id ?? obj.guid ?? obj.nodeId) || `node_${Math.random().toString(36).slice(2, 8)}`,
    type,
    name: str(obj.name) || type,
    visible: obj.visible !== undefined ? bool(obj.visible) : true,
    x: num(bb.x ?? frame.x),
    y: num(bb.y ?? frame.y),
    width: num(bb.width ?? frame.width) || 100,
    height: num(bb.height ?? frame.height) || 100,
    opacity: obj.opacity !== undefined ? num(obj.opacity) : undefined,
  };

  // Fills
  const fills = obj.fills ?? obj.fillPaints;
  if (Array.isArray(fills)) {
    node.fills = fills.map(extractPaint).filter((f): f is MakePaint => !!f);
  }

  // Strokes
  const strokes = obj.strokes ?? obj.strokePaints;
  if (Array.isArray(strokes)) {
    node.strokes = strokes.map(extractPaint).filter((f): f is MakePaint => !!f);
  }

  if (obj.strokeWeight !== undefined) node.strokeWeight = num(obj.strokeWeight);
  if (obj.cornerRadius !== undefined) node.cornerRadius = num(obj.cornerRadius);

  // Text properties
  if (obj.characters !== undefined) node.characters = str(obj.characters);
  const textStyle = (obj.style ?? obj.textStyle ?? obj) as KObj;
  if (obj.characters !== undefined || type === 'TEXT') {
    node.fontFamily = str(textStyle.fontFamily ?? textStyle.fontPostScriptName);
    node.fontSize = num(textStyle.fontSize) || 14;
    node.fontWeight = num(textStyle.fontWeight) || 400;
    if (textStyle.lineHeightPx !== undefined) node.lineHeightPx = num(textStyle.lineHeightPx);
    if (textStyle.letterSpacing !== undefined) node.letterSpacing = num(textStyle.letterSpacing);
    if (textStyle.textAlignHorizontal !== undefined) {
      node.textAlignHorizontal = str(textStyle.textAlignHorizontal);
    }
  }

  // Layout (auto-layout)
  if (obj.layoutMode !== undefined) node.layoutMode = str(obj.layoutMode);
  if (obj.primaryAxisAlignItems !== undefined) node.primaryAxisAlignItems = str(obj.primaryAxisAlignItems);
  if (obj.counterAxisAlignItems !== undefined) node.counterAxisAlignItems = str(obj.counterAxisAlignItems);
  if (obj.itemSpacing !== undefined) node.itemSpacing = num(obj.itemSpacing);
  if (obj.paddingLeft !== undefined) node.paddingLeft = num(obj.paddingLeft);
  if (obj.paddingRight !== undefined) node.paddingRight = num(obj.paddingRight);
  if (obj.paddingTop !== undefined) node.paddingTop = num(obj.paddingTop);
  if (obj.paddingBottom !== undefined) node.paddingBottom = num(obj.paddingBottom);

  // Effects
  const effects = obj.effects;
  if (Array.isArray(effects)) {
    node.effects = effects.map(extractEffect).filter((e): e is MakeEffect => !!e);
  }

  // Children
  const children = obj.children ?? obj.layers ?? obj.nodes;
  if (Array.isArray(children)) {
    node.children = children.map(extractMakeNode).filter((c): c is MakeNode => !!c);
  }

  return node;
}

function extractCodeFiles(v: KiwiValue): MakeCodeFile[] {
  if (!v || typeof v !== 'object') return [];
  const files: MakeCodeFile[] = [];

  function walk(val: KiwiValue): void {
    if (!val || typeof val !== 'object') return;
    if (Array.isArray(val)) {
      for (const item of val) walk(item);
      return;
    }
    const obj = val as KObj;
    // Detect code file entries
    const type = str(obj.type ?? obj.nodeType ?? obj._type);
    if (type === 'CODE_FILE' || (obj.content !== undefined && obj.path !== undefined)) {
      const filePath = str(obj.path ?? obj.filePath ?? obj.name);
      const content = str(obj.content ?? obj.code ?? obj.sourceCode);
      if (filePath && content) {
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        const langMap: Record<string, string> = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          css: 'css', scss: 'scss', html: 'html', json: 'json', svg: 'svg',
          py: 'python', rs: 'rust', go: 'go', dart: 'dart', swift: 'swift',
          kt: 'kotlin', java: 'java', vue: 'vue', svelte: 'svelte',
        };
        files.push({ path: filePath, content, language: langMap[ext] ?? ext });
      }
    }
    // Recurse into object values
    for (const key of Object.keys(obj)) {
      walk(obj[key]);
    }
  }

  walk(v);
  return files;
}

function buildMakeDocument(decoded: KiwiValue, schema?: KiwiSchema): MakeDocument {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Invalid decoded .make data: expected an object');
  }
  const root = decoded as KObj;

  // Extract document name
  const name = str(root.name ?? root.title ?? root.fileName) || 'Figma Make Design';

  // Extract nodes — look in common places
  const nodesSource = root.document ?? root.root ?? root.nodes ?? root.children ?? root;
  let topNodes: MakeNode[] = [];

  if (Array.isArray(nodesSource)) {
    topNodes = nodesSource.map(extractMakeNode).filter((n): n is MakeNode => !!n);
  } else if (typeof nodesSource === 'object' && nodesSource !== null) {
    const nsObj = nodesSource as KObj;
    const children = nsObj.children ?? nsObj.layers ?? nsObj.nodes;
    if (Array.isArray(children)) {
      topNodes = children.map(extractMakeNode).filter((n): n is MakeNode => !!n);
    } else {
      const node = extractMakeNode(nodesSource);
      if (node) topNodes = [node];
    }
  }

  // Extract code files
  const codeFiles = extractCodeFiles(decoded);

  // Determine canvas size from the top-level node
  let width = 1440;
  let height = 900;
  if (topNodes.length > 0) {
    const first = topNodes[0];
    if (first.width > 0) width = first.width;
    if (first.height > 0) height = first.height;
  }

  return {
    name,
    nodes: topNodes,
    codeFiles,
    width,
    height,
  };
}

/* ── MakeNode → IR Conversion ────────────────────────────────────────── */

function mapNodeType(mk: MakeNode): IRNodeType {
  switch (mk.type) {
    case 'TEXT':
      return 'text';
    case 'IMAGE':
      return 'image';
    case 'RECTANGLE':
    case 'ELLIPSE':
    case 'VECTOR':
    case 'LINE':
    case 'STAR':
    case 'POLYGON':
      if (mk.fills?.some((f) => f.type === 'IMAGE')) return 'image';
      return 'container';
    case 'FRAME':
    case 'GROUP':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
    case 'SECTION':
    default:
      return 'container';
  }
}

function extractIRStyle(mk: MakeNode): Style {
  const style: Style = {};
  const solidFill = mk.fills?.find((f) => f.visible !== false && (f.type === 'SOLID' || f.color));
  if (solidFill?.color) {
    const base = anyColorToCss({
      ...solidFill.color,
      a: (solidFill.color.a ?? 1) * (solidFill.opacity ?? 1),
    });
    if (base) style.backgroundColor = base;
  }
  if (mk.cornerRadius !== undefined) style.borderRadius = mk.cornerRadius;

  const strokeFill = mk.strokes?.find((f) => f.visible !== false && (f.type === 'SOLID' || f.color));
  if (strokeFill?.color && mk.strokeWeight) {
    style.border = {
      width: mk.strokeWeight,
      color: anyColorToCss(strokeFill.color) ?? '#000000',
      style: 'solid',
    };
  }

  const shadows = (mk.effects ?? [])
    .filter((e) => e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'dropShadow'))
    .map((e) => ({
      x: e.offset?.x ?? 0,
      y: e.offset?.y ?? 0,
      blur: e.radius ?? 0,
      spread: e.spread,
      color: anyColorToCss(e.color ?? { r: 0, g: 0, b: 0, a: 0.2 }) ?? '#00000033',
    }));
  if (shadows.length) style.shadows = shadows;
  if (mk.opacity !== undefined && mk.opacity < 1) style.opacity = mk.opacity;
  return style;
}

function extractIRTextStyle(mk: MakeNode): TextStyle | undefined {
  if (mk.type !== 'TEXT' && !mk.characters) return undefined;
  const fill = mk.fills?.find((f) => f.visible !== false && (f.type === 'SOLID' || f.color));
  const alignMap: Record<string, 'left' | 'center' | 'right' | 'justify'> = {
    LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify',
  };
  return {
    content: mk.characters ?? '',
    fontFamily: mk.fontFamily,
    fontSize: mk.fontSize ?? 14,
    fontWeight: mk.fontWeight ?? 400,
    color: anyColorToCss(fill?.color) ?? '#111111',
    lineHeight: mk.lineHeightPx,
    letterSpacing: mk.letterSpacing,
    textAlign: mk.textAlignHorizontal ? alignMap[mk.textAlignHorizontal] : undefined,
  };
}

function extractIRLayout(mk: MakeNode): Layout {
  const layout: Layout = { type: 'absolute' };
  if (mk.layoutMode === 'HORIZONTAL' || mk.layoutMode === 'VERTICAL') {
    layout.type = 'flex';
    layout.direction = mk.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
    layout.gap = mk.itemSpacing;
    switch (mk.primaryAxisAlignItems) {
      case 'MIN': layout.justifyContent = 'start'; break;
      case 'CENTER': layout.justifyContent = 'center'; break;
      case 'MAX': layout.justifyContent = 'end'; break;
      case 'SPACE_BETWEEN': layout.justifyContent = 'space-between'; break;
    }
    switch (mk.counterAxisAlignItems) {
      case 'MIN': layout.alignItems = 'start'; break;
      case 'CENTER': layout.alignItems = 'center'; break;
      case 'MAX': layout.alignItems = 'end'; break;
    }
  }
  return layout;
}

function extractIRBox(mk: MakeNode, parent?: MakeNode): Box {
  const relX = parent ? mk.x - parent.x : mk.x;
  const relY = parent ? mk.y - parent.y : mk.y;
  const padding: [number, number, number, number] | undefined =
    mk.paddingTop !== undefined || mk.paddingRight !== undefined ||
    mk.paddingBottom !== undefined || mk.paddingLeft !== undefined
      ? [mk.paddingTop ?? 0, mk.paddingRight ?? 0, mk.paddingBottom ?? 0, mk.paddingLeft ?? 0]
      : undefined;
  return { x: relX, y: relY, width: mk.width, height: mk.height, padding };
}

function makeNodeToIR(mk: MakeNode, parent?: MakeNode): IRNode {
  const type = mapNodeType(mk);
  const assetRef = mk.fills?.find((f) => f.type === 'IMAGE')?.imageRef;
  return {
    id: mk.id,
    name: mk.name,
    type,
    box: extractIRBox(mk, parent),
    layout: extractIRLayout(mk),
    style: extractIRStyle(mk),
    textStyle: extractIRTextStyle(mk),
    assetRef,
    children: (mk.children ?? [])
      .filter((c) => c.visible !== false)
      .map((c) => makeNodeToIR(c, mk)),
  };
}

function makeDocToIR(doc: MakeDocument): IRDocument {
  // Use first top-level node as root (or wrap all in a container)
  let rootNode: IRNode;
  if (doc.nodes.length === 1) {
    rootNode = makeNodeToIR(doc.nodes[0]);
  } else if (doc.nodes.length > 1) {
    rootNode = {
      id: 'make-root',
      name: doc.name,
      type: 'container',
      box: { x: 0, y: 0, width: doc.width, height: doc.height },
      layout: { type: 'absolute' },
      style: {},
      children: doc.nodes.filter((n) => n.visible !== false).map((n) => makeNodeToIR(n)),
    };
  } else {
    // No visual nodes — create a minimal placeholder from the first code file
    rootNode = {
      id: 'make-root',
      name: doc.name,
      type: 'container',
      box: { x: 0, y: 0, width: doc.width, height: doc.height },
      layout: { type: 'absolute' },
      style: {},
      children: [],
    };
  }

  const ir: IRDocument = {
    name: doc.name,
    width: doc.width,
    height: doc.height,
    root: rootNode,
  };
  validateIR(ir);
  return ir;
}

/* ── Public API ──────────────────────────────────────────────────────── */

/**
 * Parse a .make binary buffer into a single-page IRDocument.
 */
export async function parseMakeBinary(buf: Buffer): Promise<MakeDocument> {
  const { schemaBytes, dataBytes } = await extractChunks(buf);
  const schema = parseKiwiSchema(schemaBytes);

  // Find the root message type — typically "Message", "Document", or the
  // last message type in the schema.
  const rootCandidates = ['Message', 'Document', 'Fig', 'Root', 'NodeChanges'];
  let rootType = rootCandidates.find((n) => schema.definitionIndex.has(n));
  if (!rootType) {
    // Fall back to the last message-type definition
    for (let i = schema.definitions.length - 1; i >= 0; i--) {
      if (schema.definitions[i].kind === 'message') {
        rootType = schema.definitions[i].name;
        break;
      }
    }
  }
  if (!rootType) {
    throw new Error('Could not determine root message type from the Kiwi schema');
  }

  const decoded = decodeKiwiMessage(dataBytes, schema, rootType);
  return buildMakeDocument(decoded, schema);
}

/**
 * Parse a .make binary buffer → IRDocument.
 */
export async function parseMake(buf: Buffer): Promise<IRDocument> {
  const doc = await parseMakeBinary(buf);
  return makeDocToIR(doc);
}

/**
 * Parse a .make binary buffer → multiple IRDocuments (one per top-level frame).
 */
export async function parseMakeMultiPage(buf: Buffer): Promise<IRDocument[]> {
  const doc = await parseMakeBinary(buf);
  if (doc.nodes.length <= 1) return [makeDocToIR(doc)];

  return doc.nodes
    .filter((n) => n.visible !== false)
    .map((node) => {
      const pageDoc: MakeDocument = {
        name: node.name,
        nodes: [node],
        codeFiles: doc.codeFiles,
        width: node.width || doc.width,
        height: node.height || doc.height,
      };
      return makeDocToIR(pageDoc);
    });
}

/**
 * Parse a pre-decoded .make JSON representation (for testing / external tools
 * that have already extracted .make contents).
 *
 * Expected shape:
 * ```json
 * {
 *   "name": "My Make Project",
 *   "nodes": [ { "id": "...", "type": "FRAME", ... } ],
 *   "codeFiles": [ { "path": "src/App.tsx", "content": "...", "language": "typescript" } ]
 * }
 * ```
 */
export function parseMakeJsonToMakeDoc(raw: unknown): MakeDocument {
  if (!raw || typeof raw !== 'object') {
    throw new Error('parseMakeJson: input must be an object');
  }
  const obj = raw as Record<string, unknown>;

  const nodes: MakeNode[] = [];
  if (Array.isArray(obj.nodes)) {
    for (const n of obj.nodes) {
      const mk = extractMakeNode(n as KiwiValue);
      if (mk) nodes.push(mk);
    }
  }

  const codeFiles: MakeCodeFile[] = [];
  if (Array.isArray(obj.codeFiles)) {
    for (const cf of obj.codeFiles as Record<string, string>[]) {
      if (cf.path && cf.content) {
        codeFiles.push({ path: cf.path, content: cf.content, language: cf.language ?? '' });
      }
    }
  }

  return {
    name: (obj.name as string) ?? 'Make Design',
    nodes,
    codeFiles,
    width: typeof obj.width === 'number' ? obj.width : 1440,
    height: typeof obj.height === 'number' ? obj.height : 900,
  };
}

export function parseMakeJson(raw: unknown): IRDocument {
  return makeDocToIR(parseMakeJsonToMakeDoc(raw));
}

/**
 * Parse a pre-decoded .make JSON → multiple IRDocuments.
 */
export function parseMakeJsonMultiPage(raw: unknown): IRDocument[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('parseMakeJsonMultiPage: input must be an object');
  }
  const obj = raw as Record<string, unknown>;

  const nodes: MakeNode[] = [];
  if (Array.isArray(obj.nodes)) {
    for (const n of obj.nodes) {
      const mk = extractMakeNode(n as KiwiValue);
      if (mk) nodes.push(mk);
    }
  }
  if (nodes.length <= 1) {
    // For single root, use the node name (not document name) as page name
    if (nodes.length === 1) {
      const node = nodes[0];
      return [parseMakeJson({
        name: node.name,
        nodes: [node],
        codeFiles: obj.codeFiles ?? [],
        width: node.width,
        height: node.height,
      })];
    }
    return [parseMakeJson(raw)];
  }

  return nodes
    .filter((n) => n.visible !== false)
    .map((node) => {
      const json = {
        name: node.name,
        nodes: [node],
        codeFiles: obj.codeFiles ?? [],
        width: node.width,
        height: node.height,
      };
      return parseMakeJson(json);
    });
}

/**
 * Detect whether an object looks like a decoded .make JSON.
 */
export function isMakeJson(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return (Array.isArray(obj.nodes) && (Array.isArray(obj.codeFiles) || obj.codeFiles === undefined)) &&
    obj.nodes.length > 0 &&
    typeof (obj.nodes as unknown[])[0] === 'object' &&
    'type' in ((obj.nodes as Record<string, unknown>[])[0]) &&
    typeof ((obj.nodes as Record<string, unknown>[])[0]).type === 'string' &&
    /^(FRAME|GROUP|COMPONENT|TEXT|RECTANGLE|IMAGE|INSTANCE|SECTION|CODE_FILE)$/.test(
      ((obj.nodes as Record<string, unknown>[])[0]).type as string,
    );
}

export { type KiwiSchema };
