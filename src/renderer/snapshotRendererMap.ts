/**
 * Maps stage names to their snapshot renderers.
 */
import type { StageName } from '../pipeline/verify';
import type { SnapshotRenderer } from './snapshotRenderer';
import { parseRenderer } from './parseRenderer';
import { layoutRenderer } from './layoutRenderer';
import { semanticsRenderer } from './semanticsRenderer';
import { tokensRenderer } from './tokensRenderer';
import { codegenRenderer } from './codegenRenderer';

export const snapshotRenderers: ReadonlyMap<StageName, SnapshotRenderer> =
  new Map<StageName, SnapshotRenderer>([
    ['parse', parseRenderer],
    ['layout', layoutRenderer],
    ['semantics', semanticsRenderer],
    ['tokens', tokensRenderer],
    ['codegen', codegenRenderer],
  ]);

export function getSnapshotRenderer(
  stage: StageName,
): SnapshotRenderer | undefined {
  return snapshotRenderers.get(stage);
}
