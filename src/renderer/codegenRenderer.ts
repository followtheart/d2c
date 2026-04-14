/**
 * Codegen stage renderer.
 *
 * Renders the generated code output as a split-pane preview:
 *   - Left: syntax-highlighted code listing for each file
 *   - Right: live HTML preview (if HTML platform) or static preview
 *   - File list with sizes
 */
import type { StageSnapshot } from '../pipeline/verify';
import type { GenerateResult, GeneratedFile } from '../codegen/base';
import {
  type SnapshotRenderer,
  escHtml,
  wrapHtmlPage,
} from './snapshotRenderer';

// ── Minimal CSS syntax colouring ──────────────────────────────────────

function highlightCode(code: string, ext: string): string {
  let escaped = escHtml(code);

  if (ext === 'css') {
    // property names
    escaped = escaped.replace(
      /^(\s*)([\w-]+)(\s*:\s*)/gm,
      '$1<span class="cg-prop">$2</span>$3',
    );
    // comments
    escaped = escaped.replace(
      /(\/\*[\s\S]*?\*\/)/g,
      '<span class="cg-comment">$1</span>',
    );
  } else if (ext === 'html' || ext === 'tsx' || ext === 'vue') {
    // tags
    escaped = escaped.replace(
      /(&lt;\/?)([\w-]+)/g,
      '$1<span class="cg-tag">$2</span>',
    );
    // attribute names
    escaped = escaped.replace(
      /\s([\w-]+)(=)/g,
      ' <span class="cg-attr">$1</span>$2',
    );
    // strings
    escaped = escaped.replace(
      /(&quot;[^&]*?&quot;)/g,
      '<span class="cg-str">$1</span>',
    );
    // comments
    escaped = escaped.replace(
      /(&lt;!--[\s\S]*?--&gt;)/g,
      '<span class="cg-comment">$1</span>',
    );
  }

  return escaped;
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1) : '';
}

// ── Build file tabs + code panels ─────────────────────────────────────

function renderFilePanels(files: GeneratedFile[]): string {
  const tabs = files
    .map(
      (f, i) =>
        `<button class="cg-tab${i === 0 ? ' active' : ''}" onclick="showFile(${i})">${escHtml(f.path)} <span class="cg-size">${f.content.length}b</span></button>`,
    )
    .join('');

  const panels = files
    .map((f, i) => {
      const ext = fileExtension(f.path);
      const highlighted = highlightCode(f.content, ext);
      return `<pre class="cg-code${i === 0 ? ' active' : ''}" data-idx="${i}"><code>${highlighted}</code></pre>`;
    })
    .join('');

  return `<div class="cg-tabs">${tabs}</div>${panels}`;
}

// ── Build live preview (iframe with inline HTML+CSS) ──────────────────

function buildPreviewHtml(files: GeneratedFile[]): string {
  const htmlFile = files.find((f) => f.path.endsWith('.html'));
  const cssFile = files.find((f) => f.path.endsWith('.css'));

  if (!htmlFile) return '<div class="cg-no-preview">No HTML file for preview</div>';

  let html = htmlFile.content;
  // inject CSS inline if linked
  if (cssFile) {
    const linkPattern = /<link\s+rel="stylesheet"\s+href="[^"]*"\s*\/?>/gi;
    html = html.replace(linkPattern, `<style>${cssFile.content}</style>`);
  }

  // base64 encode for srcdoc-like approach
  return html;
}

// ── CSS ───────────────────────────────────────────────────────────────

const EXTRA_CSS = `
  .cg-split { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  .cg-code-panel { flex: 1; min-width: 320px; max-width: 640px; }
  .cg-preview-panel { flex: 1; min-width: 320px; }
  .cg-tabs { display: flex; gap: 2px; margin-bottom: 0; }
  .cg-tab {
    padding: 5px 12px; font-size: 11px; background: #e2e8f0; border: none;
    border-radius: 6px 6px 0 0; cursor: pointer; color: #475569;
  }
  .cg-tab.active { background: #1e293b; color: #e2e8f0; }
  .cg-size { font-size: 9px; color: #94a3b8; }
  .cg-code {
    display: none; background: #1e293b; color: #e2e8f0;
    padding: 12px; border-radius: 0 0 8px 8px; font-size: 11px;
    line-height: 1.5; overflow-x: auto; max-height: 600px; overflow-y: auto;
    tab-size: 2; white-space: pre;
  }
  .cg-code.active { display: block; }
  .cg-prop { color: #7dd3fc; }
  .cg-comment { color: #64748b; }
  .cg-tag { color: #f472b6; }
  .cg-attr { color: #a5b4fc; }
  .cg-str { color: #86efac; }
  .cg-preview-frame {
    border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;
    background: #fff;
  }
  .cg-preview-frame iframe {
    width: 100%; height: 700px; border: none;
  }
  .cg-no-preview {
    padding: 40px; text-align: center; color: #94a3b8; font-size: 13px;
  }
`;

// ── Renderer ──────────────────────────────────────────────────────────

export const codegenRenderer: SnapshotRenderer = {
  stage: 'codegen',

  render(snapshot: StageSnapshot): string {
    const gen = snapshot.generated!;
    const files = gen.files.map((f) => ({
      path: f.path,
      content: (f as { content?: string; preview?: string }).content ?? (f as { preview?: string }).preview ?? '',
    }));

    const filePanels = renderFilePanels(files);
    const previewHtml = buildPreviewHtml(files);
    const hasPreview = files.some((f) => f.path.endsWith('.html'));

    const previewSection = hasPreview
      ? `<div class="cg-preview-panel"><div class="cg-preview-frame"><iframe srcdoc="${escHtml(previewHtml)}"></iframe></div></div>`
      : '';

    const totalSize = files.reduce((s, f) => s + f.content.length, 0);

    const body = `
      <div class="stats-panel" style="margin-bottom:16px;">
        <h3>Codegen summary</h3>
        <div class="stats-row">
          <span class="stats-item">Files: <span class="stats-value">${files.length}</span></span>
          <span class="stats-item">Entry: <span class="stats-value">${escHtml(gen.entryFile)}</span></span>
          <span class="stats-item">Total size: <span class="stats-value">${totalSize}b</span></span>
          <span class="stats-item">Duration: <span class="stats-value">${snapshot.durationMs}ms</span></span>
        </div>
      </div>
      <div class="cg-split">
        <div class="cg-code-panel">${filePanels}</div>
        ${previewSection}
      </div>
      <script>
        function showFile(idx) {
          document.querySelectorAll('.cg-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
          document.querySelectorAll('.cg-code').forEach((p) => p.classList.toggle('active', Number(p.dataset.idx) === idx));
        }
      </script>`;

    return wrapHtmlPage('Generated Code', 'codegen', body, EXTRA_CSS);
  },
};
