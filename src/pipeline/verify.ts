/**
 * Pipeline stage verification.
 *
 * Captures snapshots at each pipeline stage and runs configurable checks
 * to confirm correctness of the full flow:
 *
 *   Parse → Layout → Semantics → [ComponentMatch] → [Responsive] →
 *   [ProtectedMerge] → Tokens → Codegen
 *
 * Usage:
 *   const result = await runPipelineWithVerification(raw, opts);
 *   console.log(formatVerificationReport(result.verification));
 *
 * Each stage produces a StageSnapshot with:
 *   - The stage name and a deep-cloned copy of the IR at that point
 *   - A list of Check results (pass/warn/fail with a human-readable message)
 *   - Timing information (duration in ms)
 *
 * The check functions are intentionally conservative: they flag things
 * that are *likely* wrong but never block the pipeline. A "fail" check
 * means something is almost certainly wrong; a "warn" means it deserves
 * human review.
 */
import type { IRDocument, IRNode } from '../ir/types';
import type { GenerateResult } from '../codegen/base';
import type { TokenSet } from '../tokens/extract';
import { walk } from '../utils/tree';

// ── Types ─────────────────────────────────────────────────────────────

export type StageName =
  | 'parse'
  | 'layout'
  | 'semantics'
  | 'componentMatch'
  | 'responsive'
  | 'protectedMerge'
  | 'tokens'
  | 'codegen';

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface Check {
  level: CheckLevel;
  rule: string;
  message: string;
}

export interface StageSnapshot {
  stage: StageName;
  durationMs: number;
  /** Deep-cloned IR at this point (undefined for codegen/tokens). */
  ir?: IRDocument;
  /** Token set snapshot (only for 'tokens' stage). */
  tokens?: TokenSet;
  /** Generated files snapshot (only for 'codegen' stage). */
  generated?: GenerateResult;
  checks: Check[];
}

export interface VerificationResult {
  snapshots: StageSnapshot[];
  /** Overall status: worst check level across all stages. */
  status: CheckLevel;
  summary: string;
}

// ── Node counting helpers ─────────────────────────────────────────────

function countNodes(root: IRNode): number {
  let count = 0;
  walk(root, () => count++);
  return count;
}

function collectByField<T>(
  root: IRNode,
  fn: (n: IRNode) => T | undefined,
): T[] {
  const results: T[] = [];
  walk(root, (n) => {
    const v = fn(n);
    if (v !== undefined) results.push(v);
  });
  return results;
}

// ── Per-stage validators ──────────────────────────────────────────────

export function verifyParse(doc: IRDocument): Check[] {
  const checks: Check[] = [];

  // 1. Document-level fields
  if (!doc.name || doc.name.trim() === '') {
    checks.push({ level: 'fail', rule: 'parse.name', message: 'Document name is empty' });
  } else {
    checks.push({ level: 'pass', rule: 'parse.name', message: `Document name: "${doc.name}"` });
  }

  if (typeof doc.width !== 'number' || doc.width <= 0) {
    checks.push({ level: 'fail', rule: 'parse.width', message: `Invalid document width: ${doc.width}` });
  }
  if (typeof doc.height !== 'number' || doc.height <= 0) {
    checks.push({ level: 'fail', rule: 'parse.height', message: `Invalid document height: ${doc.height}` });
  }

  // 2. Root must exist and have an id
  if (!doc.root) {
    checks.push({ level: 'fail', rule: 'parse.root', message: 'Root node is missing' });
    return checks;
  }
  if (!doc.root.id) {
    checks.push({ level: 'fail', rule: 'parse.rootId', message: 'Root node has no id' });
  }

  // 3. Node count sanity
  const nodeCount = countNodes(doc.root);
  checks.push({ level: 'pass', rule: 'parse.nodeCount', message: `Total nodes: ${nodeCount}` });
  if (nodeCount === 0) {
    checks.push({ level: 'fail', rule: 'parse.empty', message: 'IR tree is empty (0 nodes)' });
  }
  if (doc.root.children.length === 0) {
    checks.push({ level: 'warn', rule: 'parse.noChildren', message: 'Root has no children' });
  }

  // 4. Unique IDs
  const ids = new Set<string>();
  let duplicateCount = 0;
  walk(doc.root, (n) => {
    if (ids.has(n.id)) duplicateCount++;
    ids.add(n.id);
  });
  if (duplicateCount > 0) {
    checks.push({ level: 'fail', rule: 'parse.duplicateIds', message: `${duplicateCount} duplicate node id(s) found` });
  } else {
    checks.push({ level: 'pass', rule: 'parse.uniqueIds', message: 'All node ids are unique' });
  }

  // 5. Every node has required fields
  let missingBox = 0;
  let missingLayout = 0;
  walk(doc.root, (n) => {
    if (!n.box) missingBox++;
    if (!n.layout) missingLayout++;
  });
  if (missingBox > 0) {
    checks.push({ level: 'fail', rule: 'parse.missingBox', message: `${missingBox} node(s) missing box` });
  }
  if (missingLayout > 0) {
    checks.push({ level: 'fail', rule: 'parse.missingLayout', message: `${missingLayout} node(s) missing layout` });
  }

  return checks;
}

export function verifyLayout(doc: IRDocument): Check[] {
  const checks: Check[] = [];

  // 1. Count layout types
  const layoutTypes = { flex: 0, grid: 0, absolute: 0 };
  walk(doc.root, (n) => {
    if (n.layout?.type === 'flex') layoutTypes.flex++;
    else if (n.layout?.type === 'grid') layoutTypes.grid++;
    else if (n.layout?.type === 'absolute') layoutTypes.absolute++;
  });
  checks.push({
    level: 'pass',
    rule: 'layout.distribution',
    message: `Layout types — flex: ${layoutTypes.flex}, grid: ${layoutTypes.grid}, absolute: ${layoutTypes.absolute}`,
  });

  // 2. Warn if everything stayed absolute (layout inference probably failed)
  const total = layoutTypes.flex + layoutTypes.grid + layoutTypes.absolute;
  if (total > 1 && layoutTypes.absolute === total) {
    checks.push({
      level: 'warn',
      rule: 'layout.allAbsolute',
      message: 'All nodes remain absolute — layout inference may have failed',
    });
  }

  // 3. Flex containers should have direction
  let flexWithoutDirection = 0;
  walk(doc.root, (n) => {
    if (n.layout?.type === 'flex' && !n.layout.direction && n.children.length > 0) {
      flexWithoutDirection++;
    }
  });
  if (flexWithoutDirection > 0) {
    checks.push({
      level: 'warn',
      rule: 'layout.flexDirection',
      message: `${flexWithoutDirection} flex container(s) without explicit direction`,
    });
  }

  // 4. Gap values should be non-negative
  let negativeGaps = 0;
  walk(doc.root, (n) => {
    if (n.layout?.gap !== undefined && n.layout.gap < 0) negativeGaps++;
  });
  if (negativeGaps > 0) {
    checks.push({
      level: 'warn',
      rule: 'layout.negativeGap',
      message: `${negativeGaps} node(s) with negative gap value`,
    });
  } else {
    checks.push({ level: 'pass', rule: 'layout.gaps', message: 'All gap values are non-negative' });
  }

  // 5. Root should have been inferred to flex/grid (if it had children)
  if (doc.root.children.length >= 2 && doc.root.layout?.type === 'absolute') {
    checks.push({
      level: 'warn',
      rule: 'layout.rootAbsolute',
      message: 'Root with multiple children remained absolute',
    });
  }

  return checks;
}

export function verifySemantics(doc: IRDocument): Check[] {
  const checks: Check[] = [];

  // 1. Count semantic roles
  const roles = collectByField(doc.root, (n) => n.semantics?.role);
  const roleCounts = new Map<string, number>();
  for (const r of roles) roleCounts.set(r, (roleCounts.get(r) ?? 0) + 1);

  if (roles.length === 0) {
    checks.push({
      level: 'warn',
      rule: 'semantics.noRoles',
      message: 'No semantic roles assigned to any node',
    });
  } else {
    const roleBreakdown = [...roleCounts.entries()]
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    checks.push({
      level: 'pass',
      rule: 'semantics.roles',
      message: `Semantic roles assigned: ${roleBreakdown}`,
    });
  }

  // 2. Component names assigned
  const componentNames = collectByField(doc.root, (n) => n.semantics?.componentName);
  checks.push({
    level: componentNames.length > 0 ? 'pass' : 'warn',
    rule: 'semantics.componentNames',
    message: `${componentNames.length} node(s) have component names`,
  });

  // 3. Interactive elements should have interactive flag
  let interactiveMissing = 0;
  walk(doc.root, (n) => {
    const role = n.semantics?.role;
    if ((role === 'button' || role === 'link') && !n.semantics?.interactive) {
      interactiveMissing++;
    }
  });
  if (interactiveMissing > 0) {
    checks.push({
      level: 'warn',
      rule: 'semantics.interactive',
      message: `${interactiveMissing} button/link node(s) missing interactive flag`,
    });
  }

  // 4. List structure: list nodes should have list-item children
  walk(doc.root, (n) => {
    if (n.semantics?.role === 'list' || n.type === 'list') {
      const listItems = n.children.filter(
        (c) => c.type === 'list-item' || c.semantics?.role === 'list-item',
      );
      if (listItems.length === 0) {
        checks.push({
          level: 'warn',
          rule: 'semantics.listChildren',
          message: `List node "${n.name}" (${n.id}) has no list-item children`,
        });
      } else {
        checks.push({
          level: 'pass',
          rule: 'semantics.listChildren',
          message: `List "${n.name}" has ${listItems.length} list-item(s)`,
        });
      }
    }
  });

  return checks;
}

export function verifyComponentMatch(doc: IRDocument): Check[] {
  const checks: Check[] = [];

  const libraryNodes: Array<{ id: string; name: string; lib: string; comp: string }> = [];
  walk(doc.root, (n) => {
    if (n.semantics?.library) {
      libraryNodes.push({
        id: n.id,
        name: n.name,
        lib: n.semantics.library.name,
        comp: n.semantics.library.component,
      });
    }
  });

  if (libraryNodes.length === 0) {
    checks.push({
      level: 'pass',
      rule: 'componentMatch.count',
      message: 'No component library matches (component matching may be disabled)',
    });
  } else {
    const breakdown = libraryNodes
      .map((n) => `${n.name} → ${n.lib}:${n.comp}`)
      .join(', ');
    checks.push({
      level: 'pass',
      rule: 'componentMatch.matches',
      message: `${libraryNodes.length} component match(es): ${breakdown}`,
    });

    // Verify each match has a valid component name
    for (const n of libraryNodes) {
      if (!n.comp || n.comp.trim() === '') {
        checks.push({
          level: 'fail',
          rule: 'componentMatch.emptyComponent',
          message: `Node "${n.name}" (${n.id}) matched to library "${n.lib}" but component name is empty`,
        });
      }
    }
  }

  return checks;
}

export function verifyResponsive(doc: IRDocument): Check[] {
  const checks: Check[] = [];

  const responsiveNodes: Array<{ id: string; name: string; breakpoints: string[] }> = [];
  walk(doc.root, (n) => {
    if (n.responsive && Object.keys(n.responsive).length > 0) {
      responsiveNodes.push({
        id: n.id,
        name: n.name,
        breakpoints: Object.keys(n.responsive),
      });
    }
  });

  if (responsiveNodes.length === 0) {
    checks.push({
      level: 'pass',
      rule: 'responsive.count',
      message: 'No responsive overrides (responsive inference may be disabled)',
    });
  } else {
    const allBps = new Set<string>();
    for (const n of responsiveNodes) {
      for (const bp of n.breakpoints) allBps.add(bp);
    }
    checks.push({
      level: 'pass',
      rule: 'responsive.breakpoints',
      message: `Breakpoints: [${[...allBps].join(', ')}], ${responsiveNodes.length} node(s) with overrides`,
    });

    // Check for empty override objects
    let emptyOverrides = 0;
    walk(doc.root, (n) => {
      if (!n.responsive) return;
      for (const [bp, override] of Object.entries(n.responsive)) {
        const keys = Object.keys(override);
        if (keys.length === 0) emptyOverrides++;
      }
    });
    if (emptyOverrides > 0) {
      checks.push({
        level: 'warn',
        rule: 'responsive.emptyOverrides',
        message: `${emptyOverrides} responsive override(s) are empty (no-op)`,
      });
    }
  }

  return checks;
}

export function verifyProtectedMerge(doc: IRDocument, previousIR?: IRDocument): Check[] {
  const checks: Check[] = [];

  if (!previousIR) {
    checks.push({
      level: 'pass',
      rule: 'protectedMerge.skipped',
      message: 'No previous IR provided — protected merge skipped',
    });
    return checks;
  }

  // Count aiIgnore nodes in previous IR
  let prevProtected = 0;
  walk(previousIR.root, (n) => {
    if (n.semantics?.aiIgnore) prevProtected++;
  });

  // Count aiIgnore nodes in output
  let outProtected = 0;
  walk(doc.root, (n) => {
    if (n.semantics?.aiIgnore) outProtected++;
  });

  checks.push({
    level: 'pass',
    rule: 'protectedMerge.count',
    message: `Protected regions — prev: ${prevProtected}, output: ${outProtected}`,
  });

  if (prevProtected > 0 && outProtected === 0) {
    checks.push({
      level: 'fail',
      rule: 'protectedMerge.lost',
      message: 'Protected regions from previous IR were lost during merge',
    });
  } else if (prevProtected > 0 && outProtected < prevProtected) {
    checks.push({
      level: 'warn',
      rule: 'protectedMerge.partial',
      message: `Only ${outProtected} of ${prevProtected} protected regions survived`,
    });
  }

  return checks;
}

export function verifyTokens(tokens: TokenSet): Check[] {
  const checks: Check[] = [];

  const colorCount = Object.keys(tokens.colors).length;
  const fontSizeCount = Object.keys(tokens.fontSizes).length;
  const fontWeightCount = Object.keys(tokens.fontWeights).length;
  const spacingCount = Object.keys(tokens.spacings).length;
  const radiiCount = Object.keys(tokens.radii).length;
  const shadowCount = Object.keys(tokens.shadows).length;

  checks.push({
    level: 'pass',
    rule: 'tokens.summary',
    message: `Tokens — colors: ${colorCount}, fontSizes: ${fontSizeCount}, fontWeights: ${fontWeightCount}, spacings: ${spacingCount}, radii: ${radiiCount}, shadows: ${shadowCount}`,
  });

  if (colorCount === 0) {
    checks.push({ level: 'warn', rule: 'tokens.noColors', message: 'No color tokens extracted' });
  }
  if (fontSizeCount === 0) {
    checks.push({ level: 'warn', rule: 'tokens.noFontSizes', message: 'No font size tokens extracted' });
  }

  // Validate color format
  let invalidColors = 0;
  for (const [name, value] of Object.entries(tokens.colors)) {
    if (!/^(#[0-9a-f]{3,8}|rgba?\(.+\))$/i.test(value)) {
      invalidColors++;
      checks.push({
        level: 'warn',
        rule: 'tokens.colorFormat',
        message: `Color "${name}" has unusual format: "${value}"`,
      });
    }
  }
  if (invalidColors === 0 && colorCount > 0) {
    checks.push({ level: 'pass', rule: 'tokens.colorFormat', message: 'All color values are well-formed' });
  }

  return checks;
}

export function verifyCodegen(generated: GenerateResult, platform: string): Check[] {
  const checks: Check[] = [];

  // 1. Must produce at least one file
  if (generated.files.length === 0) {
    checks.push({ level: 'fail', rule: 'codegen.noFiles', message: 'Code generation produced no files' });
    return checks;
  }
  checks.push({
    level: 'pass',
    rule: 'codegen.fileCount',
    message: `Generated ${generated.files.length} file(s): ${generated.files.map((f) => f.path).join(', ')}`,
  });

  // 2. Entry file should exist in the output
  const entryExists = generated.files.some((f) => f.path === generated.entryFile);
  if (!entryExists) {
    checks.push({
      level: 'warn',
      rule: 'codegen.entryFile',
      message: `Entry file "${generated.entryFile}" not found in generated files`,
    });
  } else {
    checks.push({
      level: 'pass',
      rule: 'codegen.entryFile',
      message: `Entry file: ${generated.entryFile}`,
    });
  }

  // 3. No empty files
  const emptyFiles = generated.files.filter((f) => f.content.trim() === '');
  if (emptyFiles.length > 0) {
    checks.push({
      level: 'fail',
      rule: 'codegen.emptyFiles',
      message: `${emptyFiles.length} empty file(s): ${emptyFiles.map((f) => f.path).join(', ')}`,
    });
  }

  // 4. Platform-specific checks
  for (const file of generated.files) {
    const content = file.content;

    if (platform === 'react') {
      if (file.path.endsWith('.tsx') && !content.includes('import React')) {
        checks.push({
          level: 'warn',
          rule: 'codegen.react.import',
          message: `${file.path}: missing "import React"`,
        });
      }
      if (file.path.endsWith('.tsx') && !content.includes('className=')) {
        checks.push({
          level: 'warn',
          rule: 'codegen.react.className',
          message: `${file.path}: no className attributes found`,
        });
      }
    }

    if (platform === 'vue') {
      if (file.path.endsWith('.vue')) {
        if (!content.includes('<template>')) {
          checks.push({
            level: 'fail',
            rule: 'codegen.vue.template',
            message: `${file.path}: missing <template> section`,
          });
        }
        if (!content.includes('<style')) {
          checks.push({
            level: 'warn',
            rule: 'codegen.vue.style',
            message: `${file.path}: missing <style> section`,
          });
        }
      }
    }

    if (platform === 'html') {
      if (file.path.endsWith('.html') && !content.includes('<!doctype html>') && !content.includes('<!DOCTYPE html>')) {
        checks.push({
          level: 'warn',
          rule: 'codegen.html.doctype',
          message: `${file.path}: missing DOCTYPE`,
        });
      }
    }

    if (platform === 'flutter') {
      if (file.path.endsWith('.dart') && !content.includes('Widget')) {
        checks.push({
          level: 'warn',
          rule: 'codegen.flutter.widget',
          message: `${file.path}: no Widget class found`,
        });
      }
    }

    if (platform === 'react-native') {
      if (file.path.endsWith('.tsx') && !content.includes("from 'react-native'")) {
        checks.push({
          level: 'warn',
          rule: 'codegen.rn.import',
          message: `${file.path}: missing react-native import`,
        });
      }
    }
  }

  return checks;
}

// ── Report formatting ─────────────────────────────────────────────────

const STAGE_LABELS: Record<StageName, string> = {
  parse: 'Parse',
  layout: 'Layout Inference',
  semantics: 'Semantic Enhancement',
  componentMatch: 'Component Matching',
  responsive: 'Responsive Inference',
  protectedMerge: 'Protected Region Merge',
  tokens: 'Token Extraction',
  codegen: 'Code Generation',
};

const LEVEL_SYMBOLS: Record<CheckLevel, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
};

function worstLevel(checks: Check[]): CheckLevel {
  if (checks.some((c) => c.level === 'fail')) return 'fail';
  if (checks.some((c) => c.level === 'warn')) return 'warn';
  return 'pass';
}

export function buildVerificationResult(snapshots: StageSnapshot[]): VerificationResult {
  const allChecks = snapshots.flatMap((s) => s.checks);
  const status = worstLevel(allChecks);
  const failCount = allChecks.filter((c) => c.level === 'fail').length;
  const warnCount = allChecks.filter((c) => c.level === 'warn').length;
  const passCount = allChecks.filter((c) => c.level === 'pass').length;
  const summary = `${passCount} passed, ${warnCount} warnings, ${failCount} failures`;
  return { snapshots, status, summary };
}

export function formatVerificationReport(result: VerificationResult): string {
  const lines: string[] = [];
  lines.push('=== d2c Pipeline Verification Report ===');
  lines.push('');

  for (const snap of result.snapshots) {
    const stageStatus = worstLevel(snap.checks);
    const label = STAGE_LABELS[snap.stage] || snap.stage;
    lines.push(`--- [${LEVEL_SYMBOLS[stageStatus]}] ${label} (${snap.durationMs}ms) ---`);

    for (const check of snap.checks) {
      lines.push(`  [${LEVEL_SYMBOLS[check.level]}] ${check.rule}: ${check.message}`);
    }
    lines.push('');
  }

  lines.push(`=== Summary: ${result.summary} | Overall: ${LEVEL_SYMBOLS[result.status]} ===`);
  return lines.join('\n');
}

/**
 * Serialize a stage snapshot to a JSON-safe object for writing to disk.
 * The IR is included in full; generated file contents are truncated for
 * readability in large projects.
 */
export function snapshotToJSON(snap: StageSnapshot): Record<string, unknown> {
  return {
    stage: snap.stage,
    durationMs: snap.durationMs,
    checks: snap.checks,
    ...(snap.ir ? { ir: snap.ir } : {}),
    ...(snap.tokens ? { tokens: snap.tokens } : {}),
    ...(snap.generated
      ? {
          generated: {
            entryFile: snap.generated.entryFile,
            files: snap.generated.files.map((f) => ({
              path: f.path,
              size: f.content.length,
              preview: f.content.slice(0, 500) + (f.content.length > 500 ? '...' : ''),
            })),
          },
        }
      : {}),
  };
}
