/**
 * Codegen stage renderer.
 *
 * Outputs the raw HTML codegen result (the entry `index.html` with its
 * linked stylesheet inlined) so downstream screenshots reflect the
 * actual generated page instead of a wrapper preview page.
 *
 * This keeps `render-snapshots --format png` → `codegen.png` a true
 * pixel-level candidate for the fidelity comparison against the
 * reference design rendering (B of the codegen preview options).
 */
import type { StageSnapshot } from '../pipeline/verify';
import type { GeneratedFile } from '../codegen/base';
import { type SnapshotRenderer } from './snapshotRenderer';

// 最小占位页：当 codegen 产物里找不到 HTML 入口时回退
function fallbackEmptyPage(reason: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>codegen (no preview)</title>
<style>body{font:14px sans-serif;color:#64748b;padding:40px;}</style>
</head>
<body>${reason}</body>
</html>`;
}

// 把 <link rel="stylesheet" href="..."> 替换为内联 <style>，以便单文件截图
function inlineStylesheets(html: string, files: GeneratedFile[]): string {
  return html.replace(
    /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi,
    (match, href: string) => {
      const css = files.find((f) => f.path === href || f.path.endsWith(`/${href}`));
      if (!css) return match;
      return `<style>\n${css.content}\n</style>`;
    },
  );
}

export const codegenRenderer: SnapshotRenderer = {
  stage: 'codegen',

  render(snapshot: StageSnapshot): string {
    const gen = snapshot.generated;
    if (!gen || !gen.files?.length) {
      return fallbackEmptyPage('No codegen output found in snapshot.');
    }

    // 归一化：snapshot 里的文件项可能用 `content` 或 `preview` 字段
    const files: GeneratedFile[] = gen.files.map((f) => ({
      path: f.path,
      content:
        (f as { content?: string; preview?: string }).content ??
        (f as { preview?: string }).preview ??
        '',
    }));

    // 优先使用 entryFile；否则回退到第一个 .html 文件
    const entry =
      files.find((f) => f.path === gen.entryFile) ??
      files.find((f) => f.path.endsWith('.html'));

    if (!entry) {
      return fallbackEmptyPage('Codegen produced no HTML entry file.');
    }

    return `<!-- stage: codegen -->\n${inlineStylesheets(entry.content, files)}`;
  },
};
