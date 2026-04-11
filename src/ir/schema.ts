/**
 * Minimal runtime validation for the IR tree.
 * Keeps d2c zero-dependency while still catching malformed input.
 */
import type { IRDocument, IRNode } from './types';

export class IRValidationError extends Error {
  constructor(message: string, public path: string) {
    super(`[IR] ${message} at ${path}`);
  }
}

const VALID_TYPES = new Set([
  'container',
  'text',
  'image',
  'icon',
  'button',
  'input',
  'list',
  'list-item',
]);

export function validateIR(doc: unknown): asserts doc is IRDocument {
  if (!doc || typeof doc !== 'object')
    throw new IRValidationError('Document must be an object', '$');
  const d = doc as Partial<IRDocument>;
  if (typeof d.name !== 'string')
    throw new IRValidationError('name must be a string', '$.name');
  if (typeof d.width !== 'number')
    throw new IRValidationError('width must be a number', '$.width');
  if (typeof d.height !== 'number')
    throw new IRValidationError('height must be a number', '$.height');
  if (!d.root)
    throw new IRValidationError('root is required', '$.root');
  validateNode(d.root, '$.root');
}

function validateNode(node: unknown, path: string): asserts node is IRNode {
  if (!node || typeof node !== 'object')
    throw new IRValidationError('Node must be an object', path);
  const n = node as Partial<IRNode>;
  if (typeof n.id !== 'string')
    throw new IRValidationError('id must be a string', `${path}.id`);
  if (typeof n.name !== 'string')
    throw new IRValidationError('name must be a string', `${path}.name`);
  if (typeof n.type !== 'string' || !VALID_TYPES.has(n.type))
    throw new IRValidationError(
      `type must be one of ${[...VALID_TYPES].join(', ')}`,
      `${path}.type`,
    );
  if (!n.box || typeof n.box !== 'object')
    throw new IRValidationError('box is required', `${path}.box`);
  if (!n.layout || typeof n.layout !== 'object')
    throw new IRValidationError('layout is required', `${path}.layout`);
  if (!n.style || typeof n.style !== 'object')
    throw new IRValidationError('style is required', `${path}.style`);
  if (!Array.isArray(n.children))
    throw new IRValidationError('children must be an array', `${path}.children`);
  n.children.forEach((child, i) => validateNode(child, `${path}.children[${i}]`));
}
