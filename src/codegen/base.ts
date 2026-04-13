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

  // 多页面生成：默认实现将每个页面独立生成，文件放入子目录
  generateMultiPage(docs: IRDocument[]): GenerateResult {
    if (docs.length === 1) return this.generate(docs[0]);
    const allFiles: GeneratedFile[] = [];
    for (const doc of docs) {
      const result = this.generate(doc);
      const prefix = this.safePageDir(doc.name);
      for (const f of result.files) {
        allFiles.push({ path: `${prefix}/${f.path}`, content: f.content });
      }
    }
    return { files: allFiles, entryFile: allFiles[0]?.path ?? 'index' };
  }

  protected safePageDir(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'page';
  }

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
