/**
 * Kiwi Binary Format Decoder
 *
 * Kiwi is a compact binary serialisation format created by Evan Wallace
 * (Figma co-founder).  Figma uses it for .fig and .make files.
 *
 * This module provides:
 *   1. ByteBuffer — low-level binary reader (varints, zigzag, strings)
 *   2. parseKiwiSchema() — decode a compiled Kiwi schema blob
 *   3. decodeKiwiMessage() — decode a message given a schema + root type
 *
 * Reference: https://github.com/nicolo-ribaudo/tc39-proposal-structs
 */

/* ── ByteBuffer ──────────────────────────────────────────────────────── */

export class ByteBuffer {
  private data: Uint8Array;
  private view: DataView;
  private pos: number;

  constructor(buf: Uint8Array) {
    this.data = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }

  get position(): number {
    return this.pos;
  }
  get length(): number {
    return this.data.length;
  }
  get remaining(): number {
    return this.data.length - this.pos;
  }

  seek(offset: number): void {
    this.pos = offset;
  }

  readByte(): number {
    if (this.pos >= this.data.length) throw new RangeError('Kiwi: unexpected end of data');
    return this.data[this.pos++];
  }

  readBytes(n: number): Uint8Array {
    if (this.pos + n > this.data.length) throw new RangeError('Kiwi: unexpected end of data');
    const slice = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readUint32LE(): number {
    if (this.pos + 4 > this.data.length) throw new RangeError('Kiwi: unexpected end of data');
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readFloat32(): number {
    if (this.pos + 4 > this.data.length) throw new RangeError('Kiwi: unexpected end of data');
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Variable-length unsigned integer (LEB128-style). */
  readVarUint(): number {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.readByte();
      value |= (byte & 0x7F) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value >>> 0; // ensure unsigned
  }

  /** Variable-length signed integer (ZigZag encoded). */
  readVarInt(): number {
    const n = this.readVarUint();
    return (n >>> 1) ^ -(n & 1);
  }

  /** Length-prefixed UTF-8 string. */
  readString(): string {
    const len = this.readVarUint();
    if (len === 0) return '';
    const bytes = this.readBytes(len);
    return new TextDecoder().decode(bytes);
  }

  readBool(): boolean {
    return this.readByte() !== 0;
  }
}

/* ── Schema Types ────────────────────────────────────────────────────── */

export type KiwiTypeKind = 'enum' | 'struct' | 'message';

/** Built-in scalar type IDs (negative in the wire format). */
export enum KiwiBuiltinType {
  Bool = -1,
  Byte = -2,
  Int = -3,
  UInt = -4,
  Float = -5,
  String = -6,
}

export interface KiwiField {
  name: string;
  /** Positive → index into definitions[]; negative → KiwiBuiltinType. */
  typeId: number;
  isArray: boolean;
  /** For messages: field ID on the wire.  For enums: the enum constant value. */
  value: number;
}

export interface KiwiDefinition {
  name: string;
  kind: KiwiTypeKind;
  fields: KiwiField[];
}

export interface KiwiSchema {
  definitions: KiwiDefinition[];
  /** name → index lookup. */
  definitionIndex: Map<string, number>;
}

/* ── Schema Parser ───────────────────────────────────────────────────── */

const KIND_MAP: Record<number, KiwiTypeKind> = {
  0: 'enum',
  1: 'struct',
  2: 'message',
};

/**
 * Parse a compiled Kiwi schema from raw bytes.
 *
 * Binary layout:
 *   definitionCount: varuint
 *   Definition[definitionCount]:
 *     name:       string (varuint length + UTF-8)
 *     kind:       byte   (0=enum, 1=struct, 2=message)
 *     fieldCount: varuint
 *     Field[fieldCount]:
 *       name:    string
 *       typeId:  varint  (negative = built-in, positive = definition index)
 *       isArray: bool
 *       value:   varuint (field ID / enum value)
 */
export function parseKiwiSchema(bytes: Uint8Array): KiwiSchema {
  const bb = new ByteBuffer(bytes);
  const defCount = bb.readVarUint();
  const definitions: KiwiDefinition[] = [];
  const definitionIndex = new Map<string, number>();

  for (let i = 0; i < defCount; i++) {
    const name = bb.readString();
    const kindByte = bb.readByte();
    const kind = KIND_MAP[kindByte];
    if (!kind) throw new Error(`Kiwi: unknown definition kind ${kindByte}`);

    const fieldCount = bb.readVarUint();
    const fields: KiwiField[] = [];
    for (let f = 0; f < fieldCount; f++) {
      const fieldName = bb.readString();
      const typeId = bb.readVarInt();
      const isArray = bb.readBool();
      const value = bb.readVarUint();
      fields.push({ name: fieldName, typeId, isArray, value });
    }

    definitions.push({ name, kind, fields });
    definitionIndex.set(name, i);
  }

  return { definitions, definitionIndex };
}

/* ── Data Decoder ────────────────────────────────────────────────────── */

export type KiwiValue =
  | boolean
  | number
  | string
  | Uint8Array
  | KiwiValue[]
  | { [key: string]: KiwiValue }
  | null;

/**
 * Decode a single Kiwi value from the buffer.
 *
 * @param bb        Active ByteBuffer positioned at the value
 * @param typeId    Type identifier (negative = built-in, positive = definition index)
 * @param schema    Parsed Kiwi schema
 */
function decodeValue(bb: ByteBuffer, typeId: number, schema: KiwiSchema): KiwiValue {
  // Built-in types
  if (typeId < 0) {
    switch (typeId) {
      case KiwiBuiltinType.Bool:
        return bb.readBool();
      case KiwiBuiltinType.Byte:
        return bb.readByte();
      case KiwiBuiltinType.Int:
        return bb.readVarInt();
      case KiwiBuiltinType.UInt:
        return bb.readVarUint();
      case KiwiBuiltinType.Float:
        return bb.readFloat32();
      case KiwiBuiltinType.String:
        return bb.readString();
      default:
        throw new Error(`Kiwi: unknown built-in type ${typeId}`);
    }
  }

  const def = schema.definitions[typeId];
  if (!def) throw new Error(`Kiwi: unknown definition index ${typeId}`);

  switch (def.kind) {
    case 'enum':
      return decodeEnum(bb, def);
    case 'struct':
      return decodeStruct(bb, def, schema);
    case 'message':
      return decodeMessage(bb, def, schema);
    default:
      throw new Error(`Kiwi: unexpected kind ${def.kind}`);
  }
}

function decodeEnum(bb: ByteBuffer, def: KiwiDefinition): KiwiValue {
  const raw = bb.readVarUint();
  // Try to map to the enum name
  for (const field of def.fields) {
    if (field.value === raw) return field.name;
  }
  return raw; // unknown enum value — return numeric
}

function decodeStruct(bb: ByteBuffer, def: KiwiDefinition, schema: KiwiSchema): KiwiValue {
  const result: Record<string, KiwiValue> = {};
  // Struct fields are encoded in schema order, no field IDs on the wire.
  for (const field of def.fields) {
    if (field.isArray) {
      const count = bb.readVarUint();
      const arr: KiwiValue[] = [];
      for (let i = 0; i < count; i++) {
        arr.push(decodeValue(bb, field.typeId, schema));
      }
      result[field.name] = arr;
    } else {
      result[field.name] = decodeValue(bb, field.typeId, schema);
    }
  }
  return result;
}

function decodeMessage(bb: ByteBuffer, def: KiwiDefinition, schema: KiwiSchema): KiwiValue {
  const result: Record<string, KiwiValue> = {};
  // Build field-id → field lookup
  const fieldById = new Map<number, KiwiField>();
  for (const field of def.fields) {
    fieldById.set(field.value, field);
  }

  // Message fields: repeated (fieldId:varuint, value) until fieldId === 0
  while (true) {
    const fieldId = bb.readVarUint();
    if (fieldId === 0) break;

    const field = fieldById.get(fieldId);
    if (!field) {
      // Unknown field — skip.  We don't know the wire size, so we can't
      // safely skip it.  In practice Figma files should always match the
      // embedded schema, so this indicates corruption.
      throw new Error(`Kiwi: unknown field id ${fieldId} in message ${def.name}`);
    }

    if (field.isArray) {
      const count = bb.readVarUint();
      const arr: KiwiValue[] = [];
      for (let i = 0; i < count; i++) {
        arr.push(decodeValue(bb, field.typeId, schema));
      }
      result[field.name] = arr;
    } else {
      result[field.name] = decodeValue(bb, field.typeId, schema);
    }
  }
  return result;
}

/**
 * Decode the root message from a Kiwi data blob.
 *
 * @param data      Raw Kiwi-encoded bytes (the decompressed data chunk)
 * @param schema    Parsed Kiwi schema
 * @param rootType  Name of the root message type (e.g. "Document", "NodeChange")
 */
export function decodeKiwiMessage(
  data: Uint8Array,
  schema: KiwiSchema,
  rootType: string,
): KiwiValue {
  const idx = schema.definitionIndex.get(rootType);
  if (idx === undefined) {
    throw new Error(`Kiwi: root type "${rootType}" not found in schema`);
  }
  const bb = new ByteBuffer(data);
  return decodeValue(bb, idx, schema);
}

/**
 * List all definition names in the schema — useful for exploration.
 */
export function listSchemaTypes(schema: KiwiSchema): string[] {
  return schema.definitions.map((d) => `${d.kind} ${d.name} (${d.fields.length} fields)`);
}

/**
 * Find a definition by name.
 */
export function findDefinition(schema: KiwiSchema, name: string): KiwiDefinition | undefined {
  const idx = schema.definitionIndex.get(name);
  return idx !== undefined ? schema.definitions[idx] : undefined;
}
