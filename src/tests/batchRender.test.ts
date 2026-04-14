/**
 * Tests for the snapshot batch rendering pipeline (Phase 2).
 *
 * Tests the HTML rendering path end-to-end (no Playwright needed).
 * Screenshot tests are skipped when Chromium is not installed.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StageSnapshot, StageName } from '../pipeline/verify';
import { getSnapshotRenderer } from '../renderer/snapshotRendererMap';

const SNAPSHOTS_DIR = path.resolve(__dirname, '..', '..', 'snapshots');
const STAGES: StageName[] = ['parse', 'layout', 'semantics', 'tokens', 'codegen'];

function loadSnapshot(stage: string): StageSnapshot {
  const p = path.join(SNAPSHOTS_DIR, `${stage}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as StageSnapshot;
}

// ── Batch HTML rendering ──────────────────────────────────────────────

test('batch render: all stages produce HTML files', () => {
  const outDir = path.resolve(__dirname, '..', '..', 'tmp-test-render');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    for (const stage of STAGES) {
      const snap = loadSnapshot(stage);
      const renderer = getSnapshotRenderer(stage);
      assert.ok(renderer, `renderer for ${stage}`);
      const html = renderer!.render(snap);
      const outPath = path.join(outDir, `${stage}.html`);
      fs.writeFileSync(outPath, html);
      const stat = fs.statSync(outPath);
      assert.ok(stat.size > 500, `${stage}.html should be non-trivial (got ${stat.size})`);
    }
    // Verify all files exist
    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.html'));
    assert.equal(files.length, STAGES.length, 'should have one HTML per stage');
  } finally {
    // Cleanup
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// ── screenshotService module loads ────────────────────────────────────

test('screenshotService: module exports are accessible', async () => {
  const mod = await import('../renderer/screenshotService');
  assert.equal(typeof mod.captureScreenshot, 'function');
  assert.equal(typeof mod.captureScreenshots, 'function');
});

// ── captureScreenshots: empty jobs completes immediately ─────────────

test('captureScreenshots: empty jobs array resolves', async () => {
  const { captureScreenshots } = await import('../renderer/screenshotService');
  // Should not throw for empty array (no browser launched)
  await captureScreenshots([]);
});

// ── Rendering produces consistent stage names ────────────────────────

test('batch render: rendered HTML contains correct stage badge', () => {
  for (const stage of STAGES) {
    const snap = loadSnapshot(stage);
    const renderer = getSnapshotRenderer(stage)!;
    const html = renderer.render(snap);
    // The wrapHtmlPage utility inserts a stage badge with the stage name
    assert.ok(
      html.includes(stage),
      `${stage} renderer output should reference its own stage name`,
    );
  }
});
