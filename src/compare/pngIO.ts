/**
 * PNG I/O helpers — wraps `pngjs` (optional dep) behind a friendly
 * error message so the rest of the compare/ module can assume 8-bit
 * RGBA buffers are available whenever the caller has pngjs installed.
 */
import * as fs from 'fs';
import type { RGBAImage } from './types';

let pngjsCache: any | null | undefined;

function loadPngjs(): any {
  if (pngjsCache === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pngjsCache = require('pngjs');
    } catch {
      pngjsCache = null;
    }
  }
  if (!pngjsCache) {
    throw new Error(
      'pngjs is required for fidelity comparison image I/O but is not installed.\n' +
        '  npm install pngjs',
    );
  }
  return pngjsCache;
}

/** Probe whether pngjs is available without throwing. */
export function isPngIOAvailable(): boolean {
  try {
    loadPngjs();
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode an 8-bit RGBA PNG from disk into a plain RGBAImage.
 * Color conversion to RGBA is handled by pngjs.
 */
export function readPng(filePath: string): RGBAImage {
  const { PNG } = loadPngjs();
  const buf = fs.readFileSync(filePath);
  // PNG.sync.read returns PNG instance with .data as Buffer in RGBA order.
  const png = PNG.sync.read(buf);
  const data = new Uint8Array(
    png.data.buffer,
    png.data.byteOffset,
    png.data.byteLength,
  );
  return { width: png.width, height: png.height, data };
}

/**
 * Write an RGBAImage to disk as an 8-bit RGBA PNG.
 */
export function writePng(img: RGBAImage, filePath: string): void {
  const { PNG } = loadPngjs();
  const png = new PNG({
    width: img.width,
    height: img.height,
    colorType: 6, // RGBA
    inputColorType: 6,
    bitDepth: 8,
  });
  // Copy image data into the PNG's internal buffer.
  const dest = png.data as unknown as Buffer;
  dest.set(img.data);
  const out = PNG.sync.write(png);
  fs.writeFileSync(filePath, out);
}

/**
 * Allocate a new RGBA image filled with transparent black.
 */
export function createImage(width: number, height: number): RGBAImage {
  return {
    width,
    height,
    data: new Uint8Array(width * height * 4),
  };
}
