/**
 * Unit tests for the pixel-level fidelity metrics.
 *
 * These tests work directly on synthetic RGBAImage buffers so they
 * do NOT require pngjs / playwright to be installed.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { RGBAImage } from '../compare/types';
import { ssim, msSSIM, luminance } from '../compare/metrics/ssim';
import { deltaE2000, deltaEStats, rgbToLab } from '../compare/metrics/deltaE';
import { phash, phashSimilarity, hammingDistance } from '../compare/metrics/phash';
import { edgeIoU, edgeMask, maskIoU } from '../compare/metrics/edges';
import { buildDiffHeatmap } from '../compare/metrics/heatmap';
import { resizeRGBA, alignImages } from '../compare/align';
import { compose, toDimension, DEFAULT_WEIGHTS } from '../compare/compose';

// ── Synthetic image helpers ──────────────────────────────────────────

function solid(width: number, height: number, r: number, g: number, b: number): RGBAImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function checkerboard(width: number, height: number, size: number): RGBAImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const on = ((Math.floor(x / size) + Math.floor(y / size)) & 1) === 0;
      const v = on ? 255 : 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function noisyCopy(img: RGBAImage, amt: number): RGBAImage {
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.max(0, Math.min(255, data[i] + (Math.random() * 2 - 1) * amt));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + (Math.random() * 2 - 1) * amt));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + (Math.random() * 2 - 1) * amt));
  }
  return { width: img.width, height: img.height, data };
}

// ── luminance ────────────────────────────────────────────────────────

test('luminance: pure red gives ~76', () => {
  const img = solid(2, 2, 255, 0, 0);
  const lum = luminance(img);
  for (const v of lum) assert.ok(Math.abs(v - 76.245) < 0.1);
});

// ── SSIM ─────────────────────────────────────────────────────────────

test('ssim: identical images → 1.0', () => {
  const a = checkerboard(64, 64, 8);
  const b: RGBAImage = { ...a, data: new Uint8Array(a.data) };
  const s = ssim(a, b);
  assert.ok(s > 0.999, `expected ~1, got ${s}`);
});

test('ssim: solid white vs solid black is low', () => {
  const a = solid(64, 64, 255, 255, 255);
  const b = solid(64, 64, 0, 0, 0);
  const s = ssim(a, b);
  assert.ok(s < 0.1, `expected <0.1, got ${s}`);
});

test('ssim: mild noise keeps score high', () => {
  const a = checkerboard(64, 64, 8);
  const b = noisyCopy(a, 12);
  const s = ssim(a, b);
  assert.ok(s > 0.5, `expected >0.5, got ${s}`);
});

test('msSSIM: identical images → 1.0', () => {
  const a = checkerboard(64, 64, 8);
  const b: RGBAImage = { ...a, data: new Uint8Array(a.data) };
  const s = msSSIM(a, b);
  assert.ok(s > 0.999);
});

test('ssim: size mismatch throws', () => {
  const a = solid(10, 10, 0, 0, 0);
  const b = solid(20, 20, 0, 0, 0);
  assert.throws(() => ssim(a, b));
});

// ── ΔE2000 ───────────────────────────────────────────────────────────

test('rgbToLab: white ≈ L100', () => {
  const [L] = rgbToLab(255, 255, 255);
  assert.ok(Math.abs(L - 100) < 0.5);
});

test('rgbToLab: black ≈ L0', () => {
  const [L] = rgbToLab(0, 0, 0);
  assert.ok(Math.abs(L) < 0.5);
});

test('deltaE2000: identical colors → 0', () => {
  const [L1, a1, b1] = rgbToLab(120, 40, 60);
  const dE = deltaE2000(L1, a1, b1, L1, a1, b1);
  assert.ok(dE < 1e-6);
});

test('deltaE2000: white vs black ≈ 100', () => {
  const [L1, a1, b1] = rgbToLab(255, 255, 255);
  const [L2, a2, b2] = rgbToLab(0, 0, 0);
  const dE = deltaE2000(L1, a1, b1, L2, a2, b2);
  assert.ok(dE > 90 && dE < 110, `expected ~100, got ${dE}`);
});

test('deltaEStats: identical image pair → 0 mean', () => {
  const a = solid(20, 20, 128, 64, 32);
  const b = solid(20, 20, 128, 64, 32);
  const s = deltaEStats(a, b, 1);
  assert.ok(s.mean < 1e-6);
  assert.ok(s.max < 1e-6);
});

test('deltaEStats: small RGB shift gives small ΔE', () => {
  const a = solid(20, 20, 100, 100, 100);
  const b = solid(20, 20, 105, 100, 100);
  const s = deltaEStats(a, b, 1);
  assert.ok(s.mean < 3);
});

// ── pHash ────────────────────────────────────────────────────────────

test('phash: identical images → Hamming distance 0', () => {
  const a = checkerboard(64, 64, 8);
  const b: RGBAImage = { ...a, data: new Uint8Array(a.data) };
  const ha = phash(a);
  const hb = phash(b);
  assert.equal(hammingDistance(ha, hb), 0);
});

test('phash: similarity of identical images is 1', () => {
  const a = checkerboard(64, 64, 8);
  const b: RGBAImage = { ...a, data: new Uint8Array(a.data) };
  assert.equal(phashSimilarity(a, b), 1);
});

test('phash: very different images produce >10 Hamming distance', () => {
  const a = solid(64, 64, 0, 0, 0);
  const b = checkerboard(64, 64, 4);
  const d = hammingDistance(phash(a), phash(b));
  assert.ok(d > 10, `expected >10, got ${d}`);
});

// ── Edge IoU ─────────────────────────────────────────────────────────

test('edgeMask: solid image has no edges', () => {
  const a = solid(32, 32, 200, 200, 200);
  const mask = edgeMask(a);
  const count = mask.reduce((s, v) => s + v, 0);
  assert.equal(count, 0);
});

test('maskIoU: identical masks → 1', () => {
  const m = new Uint8Array(100);
  for (let i = 0; i < 100; i += 3) m[i] = 1;
  assert.equal(maskIoU(m, m), 1);
});

test('maskIoU: disjoint masks → 0', () => {
  const a = new Uint8Array(10);
  const b = new Uint8Array(10);
  a[0] = 1;
  b[9] = 1;
  assert.equal(maskIoU(a, b), 0);
});

test('edgeIoU: identical checkerboards → ~1', () => {
  const a = checkerboard(64, 64, 8);
  const b: RGBAImage = { ...a, data: new Uint8Array(a.data) };
  const iou = edgeIoU(a, b);
  assert.ok(iou > 0.99);
});

test('edgeIoU: solid vs checkerboard → 0', () => {
  const a = solid(64, 64, 128, 128, 128);
  const b = checkerboard(64, 64, 8);
  const iou = edgeIoU(a, b);
  assert.ok(iou < 0.01);
});

// ── Heatmap ──────────────────────────────────────────────────────────

test('buildDiffHeatmap: produces same-size RGBA output', () => {
  const a = solid(32, 32, 100, 100, 100);
  const b = solid(32, 32, 100, 100, 100);
  const h = buildDiffHeatmap(a, b);
  assert.equal(h.width, 32);
  assert.equal(h.height, 32);
  assert.equal(h.data.length, 32 * 32 * 4);
  // All alphas should be 255
  for (let i = 3; i < h.data.length; i += 4) assert.equal(h.data[i], 255);
});

// ── Align ────────────────────────────────────────────────────────────

test('resizeRGBA: identity preserves data', () => {
  const a = checkerboard(16, 16, 4);
  const r = resizeRGBA(a, 16, 16);
  assert.deepEqual(r.data, a.data);
});

test('resizeRGBA: shrink preserves dimensions', () => {
  const a = checkerboard(32, 32, 4);
  const r = resizeRGBA(a, 16, 16);
  assert.equal(r.width, 16);
  assert.equal(r.height, 16);
});

test('alignImages: same-size inputs produce same-size output', () => {
  const a = solid(40, 60, 10, 10, 10);
  const b = solid(40, 60, 20, 20, 20);
  const { reference, candidate, info } = alignImages(a, b);
  assert.equal(reference.width, candidate.width);
  assert.equal(reference.height, candidate.height);
  assert.equal(info.width, 40);
  assert.equal(info.height, 60);
  assert.equal(info.candidateOverflow, 0);
});

test('alignImages: taller candidate records overflow', () => {
  const a = solid(40, 40, 10, 10, 10);
  const b = solid(40, 80, 10, 10, 10);
  const { info } = alignImages(a, b);
  assert.ok(info.candidateOverflow > 0);
});

// ── Compose ──────────────────────────────────────────────────────────

test('compose: all dimensions @ 1.0 → 10/10', () => {
  const result = compose({
    perceptual: 1,
    color: 1,
    edge: 1,
    region: 1,
    text: 1,
    llm: 1,
  });
  assert.equal(result.overall, 10);
});

test('compose: missing dimensions redistribute weights', () => {
  const result = compose({ perceptual: 1, color: 1 });
  assert.equal(result.overall, 10);
  // Only perceptual + color got weight
  assert.ok(result.effectiveWeights.perceptual > 0);
  assert.ok(result.effectiveWeights.color > 0);
  assert.equal(result.effectiveWeights.region, 0);
});

test('compose: weakest dimension detected', () => {
  const result = compose({
    perceptual: 0.9,
    color: 0.9,
    region: 0.3,
    edge: 0.9,
    text: 0.9,
    llm: 0.9,
  });
  assert.equal(result.weakest, 'region');
});

test('toDimension: undefined value', () => {
  const d = toDimension('llm', undefined, 'not run');
  assert.equal(d.value, undefined);
  assert.equal(d.weight, DEFAULT_WEIGHTS.llm);
});

test('toDimension: clamps value', () => {
  const d = toDimension('color', 1.5, 'ok');
  assert.equal(d.value, 1);
  const d2 = toDimension('color', -0.5, 'ok');
  assert.equal(d2.value, 0);
});
