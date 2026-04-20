/**
 * Figma Native (.fig) Binary File Parser
 *
 * .fig files are ZIP archives containing:
 *   - canvas.fig — the design data in fig-kiwi binary format
 *   - meta.json  — file metadata
 *   - thumbnail.png / images/ — image assets
 *
 * canvas.fig internal layout (fig-kiwi archive):
 *   - Header: "fig-kiwi" (8 bytes) + version (uint32LE)
 *   - Chunk 0: size (uint32LE) + deflate-raw compressed Kiwi schema
 *   - Chunk 1: size (uint32LE) + zstd (or deflate-raw) compressed data
 *
 * The Kiwi schema uses null-terminated strings (variant of standard Kiwi).
 * The data decodes to a Message with nodeChanges[] — a flat list of all
 * nodes.  Each node carries a parentIndex.guid referencing its parent.
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

/* ── .fig Binary Detection ───────────────────────────────────────────── */

// .fig files are ZIP archives (PK header)
export function isFigBinary(buf: Buffer | Uint8Array): boolean {
  if (buf.length < 32) return false;
  return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
}

/* ── ZIP Extraction ──────────────────────────────────────────────────── */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

// Parse ZIP central directory to find entries
function readZipEntries(buf: Buffer): ZipEntry[] {
  // Find End-of-Central-Directory record (signature 0x06054B50)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054B50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('Not a valid ZIP file: EOCD not found');

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdCount = buf.readUInt16LE(eocdOffset + 10);
  const entries: ZipEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014B50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Extract file data from a ZIP entry
function extractZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const lhOffset = entry.localHeaderOffset;
  if (buf.readUInt32LE(lhOffset) !== 0x04034B50) {
    throw new Error(`Invalid local file header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lhOffset + 26);
  const extraLen = buf.readUInt16LE(lhOffset + 28);
  const dataOffset = lhOffset + 30 + nameLen + extraLen;

  if (entry.method === 0) {
    // Stored (no compression)
    return buf.slice(dataOffset, dataOffset + entry.uncompressedSize);
  } else if (entry.method === 8) {
    // Deflated
    return zlib.inflateRawSync(buf.slice(dataOffset, dataOffset + entry.compressedSize)) as Buffer;
  }
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/* ── fig-kiwi Archive Parsing ────────────────────────────────────────── */

const FIG_KIWI_MAGIC = 'fig-kiwi';

interface FigKiwiArchive {
  version: number;
  // chunk 0: schema (deflateRaw compressed), chunk 1: data (zstd or deflateRaw)
  chunks: Buffer[];
}

function parseFigKiwiArchive(canvasBuf: Buffer): FigKiwiArchive {
  const prelude = canvasBuf.slice(0, 8).toString('ascii');
  if (prelude !== FIG_KIWI_MAGIC) {
    throw new Error(`Invalid fig-kiwi archive: expected "${FIG_KIWI_MAGIC}", got "${prelude}"`);
  }
  const version = canvasBuf.readUInt32LE(8);
  const chunks: Buffer[] = [];
  let offset = 12;
  while (offset + 4 < canvasBuf.length) {
    const size = canvasBuf.readUInt32LE(offset);
    offset += 4;
    chunks.push(canvasBuf.slice(offset, offset + size));
    offset += size;
  }
  if (chunks.length < 2) {
    throw new Error('fig-kiwi archive must have at least 2 chunks (schema + data)');
  }
  return { version, chunks };
}

/* ── fig-kiwi Schema Parser (null-terminated strings) ────────────────── */

interface SchemaField {
  name: string;
  typeId: number;
  isArray: boolean;
  value: number;
}

interface SchemaDef {
  name: string;
  kind: number; // 0=enum, 1=struct, 2=message
  fields: SchemaField[];
}

// Read null-terminated UTF-8 string
function readNullTermString(data: Uint8Array, pos: number): { str: string; end: number } {
  let end = pos;
  while (end < data.length && data[end] !== 0) end++;
  const str = new TextDecoder().decode(data.slice(pos, end));
  return { str, end: end + 1 };
}

// Read LEB128 varuint
function readVarUint(data: Uint8Array, pos: number): { val: number; end: number } {
  let value = 0, shift = 0, byte: number;
  do {
    byte = data[pos++];
    value |= (byte & 0x7F) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { val: value >>> 0, end: pos };
}

// Read zigzag-encoded varint
function readVarInt(data: Uint8Array, pos: number): { val: number; end: number } {
  const r = readVarUint(data, pos);
  const n = r.val;
  return { val: (n >>> 1) ^ -(n & 1), end: r.end };
}

function parseFigKiwiSchema(raw: Uint8Array): SchemaDef[] {
  let pos = 0;
  const dc = readVarUint(raw, pos); pos = dc.end;
  const defs: SchemaDef[] = [];
  for (let i = 0; i < dc.val; i++) {
    const ns = readNullTermString(raw, pos); pos = ns.end;
    const kind = raw[pos++];
    const fc = readVarUint(raw, pos); pos = fc.end;
    const fields: SchemaField[] = [];
    for (let f = 0; f < fc.val; f++) {
      const fn = readNullTermString(raw, pos); pos = fn.end;
      const ti = readVarInt(raw, pos); pos = ti.end;
      const isArray = raw[pos++] !== 0;
      const vl = readVarUint(raw, pos); pos = vl.end;
      fields.push({ name: fn.str, typeId: ti.val, isArray, value: vl.val });
    }
    defs.push({ name: ns.str, kind, fields });
  }
  return defs;
}

// Type name for negative (built-in) type IDs
const BUILTIN_TYPE_NAMES: Record<number, string> = {
  [-1]: 'bool', [-2]: 'byte', [-3]: 'int', [-4]: 'uint',
  [-5]: 'float', [-6]: 'string',
  // Figma extensions: -7=float64 (read as float), -8=uint64 (read as uint)
  [-7]: 'float', [-8]: 'uint',
};

const KIND_NAMES = ['ENUM', 'STRUCT', 'MESSAGE'] as const;

// Convert parsed schema to kiwi-schema compatible format
function buildKiwiSchemaObject(defs: SchemaDef[]): { definitions: unknown[] } {
  return {
    definitions: defs.map((d) => ({
      name: d.name,
      kind: KIND_NAMES[d.kind],
      fields: d.fields.map((f) => ({
        name: f.name,
        type:
          KIND_NAMES[d.kind] === 'ENUM'
            ? null
            : f.typeId < 0
              ? BUILTIN_TYPE_NAMES[f.typeId]
              : defs[f.typeId]?.name ?? null,
        isArray: f.isArray,
        value: f.value,
      })),
    })),
  };
}

/* ── Zstandard Decompression ─────────────────────────────────────────── */

async function decompressZstd(compressed: Uint8Array): Promise<Uint8Array> {
  try {
    const fzstd = await import('fzstd' as string);
    if (typeof fzstd.decompress === 'function') return fzstd.decompress(compressed);
    if (fzstd.default && typeof fzstd.default.decompress === 'function') {
      return fzstd.default.decompress(compressed);
    }
  } catch { /* not installed */ }

  throw new Error(
    'Zstandard decompression is required to read .fig files.\n' +
    'Install the `fzstd` package:  npm install fzstd',
  );
}

function isZstd(data: Uint8Array): boolean {
  return data.length >= 4 &&
    data[0] === 0x28 && data[1] === 0xB5 && data[2] === 0x2F && data[3] === 0xFD;
}

/* ── Full Extraction Pipeline ────────────────────────────────────────── */

interface DecodedFigFile {
  schema: unknown;
  message: Record<string, unknown>;
}

async function decodeFigFile(zipBuf: Buffer): Promise<DecodedFigFile> {
  // 1. Extract canvas.fig from ZIP
  const entries = readZipEntries(zipBuf);
  const canvasEntry = entries.find((e) => e.name === 'canvas.fig');
  if (!canvasEntry) {
    throw new Error('.fig ZIP does not contain canvas.fig');
  }
  const canvasBuf = extractZipEntry(zipBuf, canvasEntry);

  // 2. Parse fig-kiwi archive (header + chunks)
  const archive = parseFigKiwiArchive(canvasBuf);

  // 3. Decompress schema (always deflate-raw)
  const schemaRaw = zlib.inflateRawSync(archive.chunks[0]);

  // 4. Parse schema (null-terminated string variant)
  const schemaDefs = parseFigKiwiSchema(new Uint8Array(schemaRaw));
  const schemaObj = buildKiwiSchemaObject(schemaDefs);

  // 5. Decompress data (zstd or deflate-raw)
  const dataChunk = archive.chunks[1];
  let dataRaw: Uint8Array;
  if (isZstd(dataChunk)) {
    dataRaw = await decompressZstd(new Uint8Array(dataChunk));
  } else {
    dataRaw = new Uint8Array(zlib.inflateRawSync(dataChunk));
  }

  // 6. Compile schema and decode Message
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kiwiSchema = require('kiwi-schema');
  const compiled = kiwiSchema.compileSchema(schemaObj);
  const message = compiled.decodeMessage(dataRaw) as Record<string, unknown>;

  return { schema: schemaObj, message };
}

/* ── Decoded Node Types ──────────────────────────────────────────────── */

// All values from decoded kiwi-schema message
type KObj = Record<string, unknown>;

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
function num(v: unknown): number { return typeof v === 'number' ? v : 0; }

function guidKey(guid: unknown): string {
  if (!guid || typeof guid !== 'object') return '';
  const g = guid as KObj;
  return `${num(g.sessionID)}:${num(g.localID)}`;
}

interface FigNode {
  id: string;
  type: string;
  name: string;
  visible?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  fills?: FigPaint[];
  strokes?: FigPaint[];
  strokeWeight?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
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
  effects?: FigEffect[];
  children?: FigNode[];
}

interface FigPaint {
  type: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number; a?: number };
  opacity?: number;
  imageRef?: string;
}

interface FigEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  offset?: { x: number; y: number };
  color?: { r: number; g: number; b: number; a?: number };
  spread?: number;
}

export interface FigDocument {
  name: string;
  pages: FigPage[];
  width: number;
  height: number;
}

export interface FigPage {
  id: string;
  name: string;
  children: FigNode[];
}

/* ── NodeChange → FigNode Tree ───────────────────────────────────────── */

// Map type enum strings to normalized type names
const NODE_TYPE_MAP: Record<string, string> = {
  DOCUMENT: 'DOCUMENT', CANVAS: 'CANVAS',
  FRAME: 'FRAME', GROUP: 'GROUP', SECTION: 'SECTION',
  RECTANGLE: 'RECTANGLE', ROUNDED_RECTANGLE: 'RECTANGLE',
  ELLIPSE: 'ELLIPSE', VECTOR: 'VECTOR', LINE: 'LINE', STAR: 'STAR',
  REGULAR_POLYGON: 'POLYGON', BOOLEAN_OPERATION: 'BOOLEAN_OPERATION',
  TEXT: 'TEXT', SLICE: 'SLICE',
  SYMBOL: 'COMPONENT', INSTANCE: 'INSTANCE',
  COMPONENT: 'COMPONENT', COMPONENT_SET: 'COMPONENT_SET',
  STICKY: 'FRAME', SHAPE_WITH_TEXT: 'FRAME', CONNECTOR: 'LINE',
  CODE_BLOCK: 'FRAME', WIDGET: 'FRAME', MEDIA: 'IMAGE',
};

function extractColor(v: unknown): { r: number; g: number; b: number; a?: number } | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as KObj;
  if ('r' in obj) {
    return { r: num(obj.r), g: num(obj.g), b: num(obj.b), a: obj.a !== undefined ? num(obj.a) : undefined };
  }
  return undefined;
}

function extractPaint(v: unknown): FigPaint | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as KObj;
  return {
    type: str(obj.type) || 'SOLID',
    visible: obj.visible !== undefined ? obj.visible === true : true,
    color: extractColor(obj.color),
    opacity: obj.opacity !== undefined ? num(obj.opacity) : undefined,
    imageRef: str(obj.imageRef),
  };
}

function extractEffect(v: unknown): FigEffect | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as KObj;
  const off = obj.offset && typeof obj.offset === 'object' && !Array.isArray(obj.offset)
    ? { x: num((obj.offset as KObj).x), y: num((obj.offset as KObj).y) }
    : undefined;
  return {
    type: str(obj.type) || 'DROP_SHADOW',
    visible: obj.visible !== undefined ? obj.visible === true : true,
    radius: obj.radius !== undefined ? num(obj.radius) : undefined,
    offset: off,
    color: extractColor(obj.color),
    spread: obj.spread !== undefined ? num(obj.spread) : undefined,
  };
}

// Font weight from style name
function fontWeightFromStyle(style: string): number {
  const s = style.toLowerCase();
  if (s.includes('thin') || s.includes('hairline')) return 100;
  if (s.includes('extralight') || s.includes('ultralight')) return 200;
  if (s.includes('light')) return 300;
  if (s.includes('medium')) return 500;
  if (s.includes('semibold') || s.includes('demibold')) return 600;
  if (s.includes('extrabold') || s.includes('ultrabold')) return 800;
  if (s.includes('black') || s.includes('heavy')) return 900;
  if (s.includes('bold')) return 700;
  return 400;
}

// Build a FigNode from a decoded NodeChange record
function nodeChangeToFigNode(nc: KObj): FigNode {
  const rawType = str(nc.type) || 'FRAME';
  const type = NODE_TYPE_MAP[rawType] ?? rawType;

  // Size from size.x / size.y
  const size = nc.size as KObj | undefined;
  const width = size ? num(size.x) : 0;
  const height = size ? num(size.y) : 0;

  // Position from transform.m02 / transform.m12
  const transform = nc.transform as KObj | undefined;
  const x = transform ? num(transform.m02) : 0;
  const y = transform ? num(transform.m12) : 0;

  const node: FigNode = {
    id: guidKey(nc.guid),
    type,
    name: str(nc.name) || type,
    visible: nc.visible !== undefined ? nc.visible === true : true,
    x, y,
    width: width || 100,
    height: height || 100,
    opacity: nc.opacity !== undefined ? num(nc.opacity) : undefined,
  };

  // Fills
  if (Array.isArray(nc.fillPaints)) {
    node.fills = (nc.fillPaints as unknown[]).map(extractPaint).filter((f): f is FigPaint => !!f);
  }

  // Strokes
  if (Array.isArray(nc.strokePaints)) {
    node.strokes = (nc.strokePaints as unknown[]).map(extractPaint).filter((f): f is FigPaint => !!f);
  }
  if (nc.strokeWeight !== undefined) node.strokeWeight = num(nc.strokeWeight);

  // Corner radius
  if (nc.cornerRadius !== undefined) node.cornerRadius = num(nc.cornerRadius);
  const tl = nc.rectangleTopLeftCornerRadius as number | undefined;
  const tr = nc.rectangleTopRightCornerRadius as number | undefined;
  const bl = nc.rectangleBottomLeftCornerRadius as number | undefined;
  const br = nc.rectangleBottomRightCornerRadius as number | undefined;
  if (tl !== undefined || tr !== undefined || bl !== undefined || br !== undefined) {
    node.rectangleCornerRadii = [tl ?? 0, tr ?? 0, br ?? 0, bl ?? 0];
  }

  // Text
  const textData = nc.textData as KObj | undefined;
  if (textData?.characters) {
    node.characters = str(textData.characters);
  }
  const fontName = nc.fontName as KObj | undefined;
  if (fontName || type === 'TEXT') {
    node.fontFamily = str(fontName?.family);
    node.fontSize = nc.fontSize !== undefined ? num(nc.fontSize) : 14;
    node.fontWeight = fontName?.style ? fontWeightFromStyle(str(fontName.style)) : 400;
    if (nc.lineHeight !== undefined) {
      const lh = nc.lineHeight as KObj;
      const lhUnits = str(lh.units);
      if (lhUnits === 'PERCENT') {
        // Convert percentage to pixels: fontSize × (value / 100)
        const fs = nc.fontSize !== undefined ? num(nc.fontSize) : 14;
        node.lineHeightPx = Math.round(fs * num(lh.value) / 100);
      } else if (lhUnits === 'AUTO' || lhUnits === 'auto') {
        // Auto line-height: omit to let browser use default
      } else if (lh.value !== undefined) {
        node.lineHeightPx = num(lh.value);
      }
    }
    if (nc.letterSpacing !== undefined) {
      const ls = nc.letterSpacing as KObj;
      if (ls.value !== undefined) node.letterSpacing = num(ls.value);
    }
    if (nc.textAlignHorizontal !== undefined) {
      node.textAlignHorizontal = str(nc.textAlignHorizontal);
    }
  }

  // Auto-layout (stack properties)
  if (nc.stackMode !== undefined) {
    const mode = str(nc.stackMode);
    if (mode === 'HORIZONTAL' || mode === 'VERTICAL') node.layoutMode = mode;
  }
  if (nc.stackPrimaryAlignItems !== undefined) node.primaryAxisAlignItems = str(nc.stackPrimaryAlignItems);
  if (nc.stackCounterAlignItems !== undefined) node.counterAxisAlignItems = str(nc.stackCounterAlignItems);
  if (nc.stackSpacing !== undefined) node.itemSpacing = num(nc.stackSpacing);
  if (nc.stackHorizontalPadding !== undefined) {
    node.paddingLeft = num(nc.stackHorizontalPadding);
    node.paddingRight = num(nc.stackPaddingRight ?? nc.stackHorizontalPadding);
  }
  if (nc.stackVerticalPadding !== undefined) {
    node.paddingTop = num(nc.stackVerticalPadding);
    node.paddingBottom = num(nc.stackPaddingBottom ?? nc.stackVerticalPadding);
  }
  if (nc.stackPadding !== undefined && node.paddingTop === undefined) {
    const p = num(nc.stackPadding);
    node.paddingLeft = p; node.paddingRight = p; node.paddingTop = p; node.paddingBottom = p;
  }

  // Effects
  if (Array.isArray(nc.effects)) {
    node.effects = (nc.effects as unknown[]).map(extractEffect).filter((e): e is FigEffect => !!e);
  }

  return node;
}

// Build a tree from flat nodeChanges using parentIndex GUIDs
function buildNodeTree(nodeChanges: KObj[]): FigDocument {
  // Phase flag: skip REMOVED nodes
  const liveNodes = nodeChanges.filter((nc) => str(nc.phase) !== 'REMOVED');

  // Build GUID → FigNode map
  const nodeMap = new Map<string, FigNode>();
  const rawMap = new Map<string, KObj>();
  for (const nc of liveNodes) {
    const key = guidKey(nc.guid);
    if (!key) continue;
    nodeMap.set(key, nodeChangeToFigNode(nc));
    rawMap.set(key, nc);
  }

  // Attach children to parents via parentIndex
  for (const nc of liveNodes) {
    const parentIdx = nc.parentIndex as KObj | undefined;
    if (!parentIdx?.guid) continue;
    const parentKey = guidKey(parentIdx.guid);
    const childKey = guidKey(nc.guid);
    const parent = nodeMap.get(parentKey);
    const child = nodeMap.get(childKey);
    if (parent && child && parentKey !== childKey) {
      if (!parent.children) parent.children = [];
      parent.children.push(child);
    }
  }

  // Sort children by parentIndex.position (lexicographic fractional index)
  for (const nc of liveNodes) {
    const key = guidKey(nc.guid);
    const node = nodeMap.get(key);
    if (node?.children && node.children.length > 1) {
      // Build position map for children
      const posMap = new Map<string, string>();
      for (const child of liveNodes) {
        const pi = child.parentIndex as KObj | undefined;
        if (pi?.guid && guidKey(pi.guid) === key) {
          posMap.set(guidKey(child.guid), str(pi.position));
        }
      }
      node.children.sort((a, b) => {
        const pa = posMap.get(a.id) ?? '';
        const pb = posMap.get(b.id) ?? '';
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
    }
  }

  // Find document and pages
  const docNode = liveNodes.find((nc) => str(nc.type) === 'DOCUMENT');
  const docName = docNode ? str(docNode.name) : 'Figma Design';
  const docKey = docNode ? guidKey(docNode.guid) : '';
  const docFigNode = docKey ? nodeMap.get(docKey) : undefined;
  const pages: FigPage[] = [];

  if (docFigNode?.children) {
    for (const pageNode of docFigNode.children) {
      if (pageNode.type === 'CANVAS') {
        // Figma binary transform.m02/m12 values are already parent-relative,
        // so no coordinate conversion is needed here.
        pages.push({
          id: pageNode.id,
          name: pageNode.name,
          children: pageNode.children ?? [],
        });
      }
    }
  }

  // Canvas size from first page's first frame
  let width = 1440, height = 900;
  if (pages.length > 0 && pages[0].children.length > 0) {
    const first = pages[0].children[0];
    if (first.width > 0) width = first.width;
    if (first.height > 0) height = first.height;
  }

  return { name: docName, pages, width, height };
}

/* ── FigNode → IR Conversion ─────────────────────────────────────────── */

function mapNodeType(node: FigNode): IRNodeType {
  switch (node.type) {
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
    case 'BOOLEAN_OPERATION':
      if (node.fills?.some((f) => f.type === 'IMAGE')) return 'image';
      return 'container';
    case 'FRAME':
    case 'GROUP':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
    case 'SECTION':
    case 'CANVAS':
    default:
      return 'container';
  }
}

function extractIRStyle(node: FigNode): Style {
  const style: Style = {};
  const solidFill = node.fills?.find((f) => f.visible !== false && (f.type === 'SOLID' || f.color));
  if (solidFill?.color) {
    const base = anyColorToCss({
      ...solidFill.color,
      a: (solidFill.color.a ?? 1) * (solidFill.opacity ?? 1),
    });
    if (base) style.backgroundColor = base;
  }
  if (node.cornerRadius !== undefined) style.borderRadius = node.cornerRadius;
  else if (node.rectangleCornerRadii) style.borderRadius = node.rectangleCornerRadii;

  const strokeFill = node.strokes?.find((f) => f.visible !== false && (f.type === 'SOLID' || f.color));
  if (strokeFill?.color && node.strokeWeight) {
    style.border = {
      width: node.strokeWeight,
      color: anyColorToCss(strokeFill.color) ?? '#000000',
      style: 'solid',
    };
  }

  const shadows = (node.effects ?? [])
    .filter((e) => e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'dropShadow'))
    .map((e) => ({
      x: e.offset?.x ?? 0,
      y: e.offset?.y ?? 0,
      blur: e.radius ?? 0,
      spread: e.spread,
      color: anyColorToCss(e.color ?? { r: 0, g: 0, b: 0, a: 0.2 }) ?? '#00000033',
    }));
  if (shadows.length) style.shadows = shadows;
  if (node.opacity !== undefined && node.opacity < 1) style.opacity = node.opacity;
  return style;
}

function extractIRTextStyle(node: FigNode): TextStyle | undefined {
  if (node.type !== 'TEXT' && !node.characters) return undefined;
  const fill = node.fills?.find((f) => f.visible !== false && (f.type === 'SOLID' || f.color));
  const alignMap: Record<string, 'left' | 'center' | 'right' | 'justify'> = {
    LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify',
  };
  return {
    content: node.characters ?? '',
    fontFamily: node.fontFamily,
    fontSize: node.fontSize ?? 14,
    fontWeight: node.fontWeight ?? 400,
    color: anyColorToCss(fill?.color) ?? '#111111',
    lineHeight: node.lineHeightPx,
    letterSpacing: node.letterSpacing,
    textAlign: node.textAlignHorizontal ? alignMap[node.textAlignHorizontal] : undefined,
  };
}

function extractIRLayout(node: FigNode): Layout {
  const layout: Layout = { type: 'absolute' };
  if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') {
    layout.type = 'flex';
    layout.direction = node.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
    layout.gap = node.itemSpacing;
    switch (node.primaryAxisAlignItems) {
      case 'MIN': layout.justifyContent = 'start'; break;
      case 'CENTER': layout.justifyContent = 'center'; break;
      case 'MAX': layout.justifyContent = 'end'; break;
      case 'SPACE_BETWEEN': layout.justifyContent = 'space-between'; break;
    }
    switch (node.counterAxisAlignItems) {
      case 'MIN': layout.alignItems = 'start'; break;
      case 'CENTER': layout.alignItems = 'center'; break;
      case 'MAX': layout.alignItems = 'end'; break;
    }
  }
  return layout;
}

function extractIRBox(node: FigNode): Box {
  const padding: [number, number, number, number] | undefined =
    node.paddingTop !== undefined || node.paddingRight !== undefined ||
    node.paddingBottom !== undefined || node.paddingLeft !== undefined
      ? [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0]
      : undefined;
  return { x: node.x, y: node.y, width: node.width, height: node.height, padding };
}

function figNodeToIR(node: FigNode): IRNode {
  const type = mapNodeType(node);
  const assetRef = node.fills?.find((f) => f.type === 'IMAGE')?.imageRef;
  const style = extractIRStyle(node);
  // Text nodes: the fill represents text color, not a background.
  // Remove the spurious backgroundColor so generated CSS doesn't paint
  // a solid rectangle behind every text element.
  if (type === 'text' && style.backgroundColor) {
    delete style.backgroundColor;
  }
  return {
    id: node.id,
    name: node.name,
    type,
    box: extractIRBox(node),
    layout: extractIRLayout(node),
    style,
    textStyle: extractIRTextStyle(node),
    assetRef,
    children: (node.children ?? [])
      .filter((c) => c.visible !== false)
      .map((c) => figNodeToIR(c)),
  };
}

function pageToIRDocument(page: FigPage, docName: string, defaultWidth: number, defaultHeight: number): IRDocument {
  let rootNode: IRNode;
  if (page.children.length === 1) {
    rootNode = figNodeToIR(page.children[0]);
    // Normalize root frame position to (0,0) — the canvas offset
    // is irrelevant for code generation.
    rootNode.box.x = 0;
    rootNode.box.y = 0;
  } else if (page.children.length > 1) {
    const maxW = Math.max(...page.children.map((c) => c.x + c.width), defaultWidth);
    const maxH = Math.max(...page.children.map((c) => c.y + c.height), defaultHeight);
    rootNode = {
      id: `fig-page-${page.id}`,
      name: page.name,
      type: 'container',
      box: { x: 0, y: 0, width: maxW, height: maxH },
      layout: { type: 'absolute' },
      style: {},
      children: page.children
        .filter((n) => n.visible !== false)
        .map((n) => figNodeToIR(n)),
    };
  } else {
    rootNode = {
      id: `fig-page-${page.id}`,
      name: page.name,
      type: 'container',
      box: { x: 0, y: 0, width: defaultWidth, height: defaultHeight },
      layout: { type: 'absolute' },
      style: {},
      children: [],
    };
  }

  const width = page.children.length === 1 ? page.children[0].width || defaultWidth : defaultWidth;
  const height = page.children.length === 1 ? page.children[0].height || defaultHeight : defaultHeight;

  const ir: IRDocument = {
    name: page.name || docName,
    width,
    height,
    root: rootNode,
  };
  validateIR(ir);
  return ir;
}

/* ── Public API ──────────────────────────────────────────────────────── */

export async function parseFigBinary(buf: Buffer): Promise<FigDocument> {
  const { message } = await decodeFigFile(buf);
  const nodeChanges = message.nodeChanges;
  if (!Array.isArray(nodeChanges) || nodeChanges.length === 0) {
    throw new Error('No node changes found in the .fig file');
  }
  return buildNodeTree(nodeChanges as KObj[]);
}

export async function parseFig(buf: Buffer): Promise<IRDocument> {
  const doc = await parseFigBinary(buf);
  if (doc.pages.length === 0) {
    throw new Error('No pages found in the .fig file');
  }
  return pageToIRDocument(doc.pages[0], doc.name, doc.width, doc.height);
}

export async function parseFigMultiPage(buf: Buffer): Promise<IRDocument[]> {
  const doc = await parseFigBinary(buf);
  if (doc.pages.length === 0) {
    throw new Error('No pages found in the .fig file');
  }
  return doc.pages.map((page) => pageToIRDocument(page, doc.name, doc.width, doc.height));
}

// Split by top-level FRAMEs: each FRAME on each CANVAS page becomes a separate IRDocument.
// This is the typical CRM / multi-screen design pattern where one Figma "page" (CANVAS)
// contains multiple top-level frames, each representing a distinct web page / screen.
export async function parseFigByFrames(buf: Buffer): Promise<IRDocument[]> {
  const doc = await parseFigBinary(buf);
  if (doc.pages.length === 0) {
    throw new Error('No pages found in the .fig file');
  }
  const results: IRDocument[] = [];
  for (const page of doc.pages) {
    const frames = (page.children ?? []).filter(
      (n) => n.type === 'FRAME' && n.visible !== false,
    );
    if (frames.length === 0) {
      // No top-level frames — fall back to treating the whole page as one document
      results.push(pageToIRDocument(page, doc.name, doc.width, doc.height));
    } else {
      for (const frame of frames) {
        results.push(frameToIRDocument(frame, page.name));
      }
    }
  }
  return results;
}

// Convert a single top-level FRAME into an IRDocument
function frameToIRDocument(frame: FigNode, pageName: string): IRDocument {
  const width = frame.width || 1440;
  const height = frame.height || 900;
  const rootNode = figNodeToIR(frame);
  // Normalize root frame position to (0,0) — the canvas offset
  // is irrelevant for code generation.
  rootNode.box.x = 0;
  rootNode.box.y = 0;
  const ir: IRDocument = {
    name: frame.name || pageName,
    width,
    height,
    root: rootNode,
  };
  validateIR(ir);
  return ir;
}
