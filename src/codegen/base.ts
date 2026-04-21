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
    const pageDirs = this.uniquePageDirs(docs.map((doc, index) => doc.name || `page_${index + 1}`));
    for (let index = 0; index < docs.length; index++) {
      const doc = docs[index];
      const result = this.generate(doc);
      const prefix = pageDirs[index];
      for (const f of result.files) {
        allFiles.push({ path: `${prefix}/${f.path}`, content: f.content });
      }
    }
    return { files: allFiles, entryFile: allFiles[0]?.path ?? 'index' };
  }

  protected safePageDir(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'page';
  }

  protected uniquePageDirs(names: string[]): string[] {
    const counts = new Map<string, number>();
    return names.map((name) => {
      const base = this.safePageDir(name);
      const nextCount = (counts.get(base) ?? 0) + 1;
      counts.set(base, nextCount);
      return nextCount === 1 ? base : `${base}_${nextCount}`;
    });
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
