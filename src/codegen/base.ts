import type { IRDocument, IRNode } from '../ir/types';

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GenerateResult {
  files: GeneratedFile[];
  entryFile: string;
}

export abstract class CodeGenerator {
  abstract readonly platform: string;
  abstract generate(doc: IRDocument): GenerateResult;

  protected escapeText(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\{/g, '&#123;')
      .replace(/\}/g, '&#125;');
  }

  protected collectComponents(root: IRNode): IRNode[] {
    // For now, the root is the only component. A future version could
    // split list-items or cards into sub-components.
    return [root];
  }
}
