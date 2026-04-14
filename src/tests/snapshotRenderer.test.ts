/**
 * Tests for snapshot stage renderers.
 *
 * Loads the real snapshot JSON files under `snapshots/` and verifies
 * that each renderer produces valid standalone HTML containing the
 * expected structural elements.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StageSnapshot } from '../pipeline/verify';
import { parseRenderer } from '../renderer/parseRenderer';
import { layoutRenderer } from '../renderer/layoutRenderer';
import { semanticsRenderer } from '../renderer/semanticsRenderer';
import { tokensRenderer } from '../renderer/tokensRenderer';
import { codegenRenderer } from '../renderer/codegenRenderer';
import { getSnapshotRenderer } from '../renderer/snapshotRendererMap';

function loadSnapshot(stage: string): StageSnapshot {
  const p = path.resolve(__dirname, '..', '..', 'snapshots', `${stage}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as StageSnapshot;
}

// ── Parse renderer ────────────────────────────────────────────────────

test('parseRenderer: produces valid HTML from parse snapshot', () => {
  const snap = loadSnapshot('parse');
  const html = parseRenderer.render(snap);
  assert.ok(html.includes('<!DOCTYPE html>'), 'should be a full HTML page');
  assert.ok(html.includes('parse'), 'should contain stage name');
  assert.ok(html.includes('LoginScreen'), 'should contain document name');
  assert.ok(html.includes('parse-node'), 'should contain wireframe nodes');
  assert.ok(html.includes('Parse summary'), 'should contain stats panel');
});

// ── Layout renderer ───────────────────────────────────────────────────

test('layoutRenderer: produces valid HTML from layout snapshot', () => {
  const snap = loadSnapshot('layout');
  const html = layoutRenderer.render(snap);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('layout'));
  assert.ok(html.includes('lt-node'), 'should contain layout nodes');
  assert.ok(html.includes('Layout summary'), 'should contain stats panel');
  // should show layout type counts
  assert.ok(html.includes('flex:') || html.includes('absolute:'));
});

// ── Semantics renderer ───────────────────────────────────────────────

test('semanticsRenderer: produces valid HTML from semantics snapshot', () => {
  const snap = loadSnapshot('semantics');
  const html = semanticsRenderer.render(snap);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('semantics'));
  assert.ok(html.includes('sem-node'), 'should contain semantic nodes');
  assert.ok(html.includes('Semantics summary'), 'should contain stats');
  assert.ok(html.includes('Role distribution'), 'should show role distribution');
});

// ── Tokens renderer ──────────────────────────────────────────────────

test('tokensRenderer: produces valid HTML from tokens snapshot', () => {
  const snap = loadSnapshot('tokens');
  const html = tokensRenderer.render(snap);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('tokens'));
  assert.ok(html.includes('Token summary'), 'should contain summary');
  assert.ok(html.includes('tk-swatch'), 'should contain color swatches');
  assert.ok(html.includes('Colors'), 'should have colors section');
});

// ── Codegen renderer ─────────────────────────────────────────────────

test('codegenRenderer: produces valid HTML from codegen snapshot', () => {
  const snap = loadSnapshot('codegen');
  const html = codegenRenderer.render(snap);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('codegen'));
  assert.ok(html.includes('Codegen summary'), 'should contain summary');
  assert.ok(html.includes('cg-tab'), 'should contain file tabs');
  assert.ok(html.includes('index.html'), 'should list entry file');
});

// ── Renderer map ─────────────────────────────────────────────────────

test('getSnapshotRenderer: returns correct renderer for each stage', () => {
  assert.strictEqual(getSnapshotRenderer('parse'), parseRenderer);
  assert.strictEqual(getSnapshotRenderer('layout'), layoutRenderer);
  assert.strictEqual(getSnapshotRenderer('semantics'), semanticsRenderer);
  assert.strictEqual(getSnapshotRenderer('tokens'), tokensRenderer);
  assert.strictEqual(getSnapshotRenderer('codegen'), codegenRenderer);
  assert.strictEqual(getSnapshotRenderer('componentMatch'), undefined);
});

// ── All renderers produce non-empty HTML ─────────────────────────────

test('all snapshot renderers: output length is reasonable', () => {
  const stages = ['parse', 'layout', 'semantics', 'tokens', 'codegen'] as const;
  for (const stage of stages) {
    const snap = loadSnapshot(stage);
    const renderer = getSnapshotRenderer(stage);
    assert.ok(renderer, `renderer for ${stage} should exist`);
    const html = renderer!.render(snap);
    assert.ok(html.length > 500, `${stage} renderer output should be substantial (got ${html.length})`);
  }
});
