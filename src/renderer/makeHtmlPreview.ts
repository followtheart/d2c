/**
 * Figma Make HTML Preview Renderer
 *
 * Generates a standalone HTML file that shows .make project contents:
 *   - Left panel:  visual design preview (SVG artboards with pan/zoom)
 *   - Right panel: code files with syntax highlighting and tabs
 *
 * The preview is self-contained (no external dependencies) and includes
 * interactive features: dark/light theme toggle, zoom controls, file
 * navigation tabs, and responsive layout.
 */
import type { MakeCodeFile } from '../parser/makeParser';
import type { RenderDocument, SketchRenderOptions } from './types';
import { renderArtboardToSvg } from './svgRenderer';

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate a standalone HTML preview showing design artboards and code files.
 */
export function renderMakeHtmlPreview(
  doc: RenderDocument,
  codeFiles: MakeCodeFile[],
  options?: SketchRenderOptions,
): string {
  const opts: SketchRenderOptions = {
    scale: 1,
    pageBackground: '#f5f5f5',
    showArtboardTitles: true,
    ...options,
  };

  const scale = opts.scale ?? 1;

  // Render artboards to SVG
  const artboardSvgs = doc.artboards.map((ab) => ({
    name: ab.name,
    width: ab.frame.width * scale,
    height: ab.frame.height * scale,
    svg: renderArtboardToSvg(ab, opts),
    bgColor: ab.backgroundColor ?? '#ffffff',
  }));

  const artboardCards = artboardSvgs
    .map(
      (ab, i) => `
      <div class="artboard-card" data-index="${i}">
        ${opts.showArtboardTitles ? `<div class="artboard-title">${escHtml(ab.name)}</div>` : ''}
        <div class="artboard-frame" style="width:${ab.width}px;height:${ab.height}px;background:${ab.bgColor};">
          ${ab.svg}
        </div>
      </div>`,
    )
    .join('\n');

  // Code file tabs and panels
  const hasCode = codeFiles.length > 0;
  const codeTabs = codeFiles
    .map(
      (f, i) =>
        `<button class="code-tab${i === 0 ? ' active' : ''}" data-file="${i}" title="${escHtml(f.path)}">${escHtml(f.path.split('/').pop() ?? f.path)}</button>`,
    )
    .join('\n            ');

  const codePanels = codeFiles
    .map(
      (f, i) =>
        `<div class="code-panel${i === 0 ? ' active' : ''}" data-file="${i}">
          <div class="code-path">${escHtml(f.path)}</div>
          <pre class="code-block" data-lang="${escHtml(f.language)}"><code>${escHtml(f.content)}</code></pre>
        </div>`,
    )
    .join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(doc.name)} — Figma Make Preview</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: ${opts.pageBackground};
    --surface: #ffffff;
    --text: #333;
    --text-secondary: #888;
    --border: #e0e0e0;
    --toolbar-bg: rgba(255,255,255,0.96);
    --code-bg: #1e1e2e;
    --code-text: #cdd6f4;
    --code-keyword: #cba6f7;
    --code-string: #a6e3a1;
    --code-comment: #6c7086;
    --code-number: #fab387;
    --tab-active: #007aff;
    --shadow: 0 2px 12px rgba(0,0,0,0.08);
  }

  .dark {
    --bg: #1a1a1a;
    --surface: #2a2a2a;
    --text: #e0e0e0;
    --text-secondary: #999;
    --border: #444;
    --toolbar-bg: rgba(42,42,42,0.96);
  }

  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
  }

  /* ── Toolbar ─────────────────────────────────────────────────────── */
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: var(--toolbar-bg);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    box-shadow: var(--shadow);
  }
  .toolbar h1 {
    font-size: 14px;
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toolbar .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--tab-active);
    color: #fff;
    font-weight: 500;
  }
  .btn {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
    transition: background .15s;
  }
  .btn:hover { background: var(--bg); }

  /* ── Main Layout ─────────────────────────────────────────────────── */
  .main {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  /* ── Design Panel ────────────────────────────────────────────────── */
  .design-panel {
    flex: ${hasCode ? '1 1 55%' : '1 1 100%'};
    overflow: auto;
    padding: 24px;
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    align-content: flex-start;
    justify-content: center;
  }
  .artboard-card {
    background: var(--surface);
    border-radius: 8px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .artboard-title {
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border);
  }
  .artboard-frame {
    overflow: hidden;
  }
  .artboard-frame svg {
    display: block;
  }

  /* ── Code Panel ──────────────────────────────────────────────────── */
  .code-panel-container {
    flex: 0 0 45%;
    max-width: 700px;
    display: ${hasCode ? 'flex' : 'none'};
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--code-bg);
  }
  .code-tabs {
    display: flex;
    gap: 0;
    overflow-x: auto;
    background: #181825;
    border-bottom: 1px solid #313244;
    flex-shrink: 0;
  }
  .code-tab {
    padding: 8px 16px;
    border: none;
    background: transparent;
    color: #6c7086;
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    cursor: pointer;
    white-space: nowrap;
    border-bottom: 2px solid transparent;
    transition: all .15s;
  }
  .code-tab:hover { color: #cdd6f4; background: rgba(255,255,255,0.03); }
  .code-tab.active {
    color: #cdd6f4;
    border-bottom-color: var(--tab-active);
    background: rgba(255,255,255,0.05);
  }
  .code-panel {
    display: none;
    flex-direction: column;
    flex: 1;
    overflow: auto;
  }
  .code-panel.active { display: flex; }
  .code-path {
    padding: 8px 16px;
    font-size: 11px;
    color: #6c7086;
    font-family: 'SF Mono', 'Fira Code', monospace;
    border-bottom: 1px solid #313244;
    flex-shrink: 0;
  }
  .code-block {
    flex: 1;
    margin: 0;
    padding: 16px;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace;
    font-size: 13px;
    line-height: 1.6;
    color: var(--code-text);
    overflow: auto;
    tab-size: 2;
    white-space: pre;
  }

  /* ── Responsive ──────────────────────────────────────────────────── */
  @media (max-width: 900px) {
    .main { flex-direction: column; }
    .design-panel { flex: 0 0 auto; max-height: 50vh; }
    .code-panel-container { flex: 1; max-width: none; border-left: none; border-top: 1px solid var(--border); }
  }

  /* ── No-design state ─────────────────────────────────────────────── */
  .empty-design {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-secondary);
    font-size: 14px;
    padding: 48px;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <h1>${escHtml(doc.name)}</h1>
    <span class="badge">Figma Make</span>
    ${artboardSvgs.length > 0 ? `<span class="badge" style="background:#34c759">${artboardSvgs.length} artboard${artboardSvgs.length > 1 ? 's' : ''}</span>` : ''}
    ${codeFiles.length > 0 ? `<span class="badge" style="background:#ff9500">${codeFiles.length} file${codeFiles.length > 1 ? 's' : ''}</span>` : ''}
    <button class="btn" id="themeToggle" title="Toggle dark/light theme">Theme</button>
  </div>

  <div class="main">
    <div class="design-panel">
      ${artboardSvgs.length > 0 ? artboardCards : '<div class="empty-design">No visual design nodes in this .make file.<br>Code files are shown in the right panel.</div>'}
    </div>
    <div class="code-panel-container">
      <div class="code-tabs">
        ${codeTabs}
      </div>
      ${codePanels}
    </div>
  </div>

<script>
(function(){
  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', function() {
    document.body.classList.toggle('dark');
  });

  // Code file tabs
  document.querySelectorAll('.code-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var idx = this.dataset.file;
      document.querySelectorAll('.code-tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.code-panel').forEach(function(p) { p.classList.remove('active'); });
      this.classList.add('active');
      var panel = document.querySelector('.code-panel[data-file="' + idx + '"]');
      if (panel) panel.classList.add('active');
    });
  });

  // Basic syntax highlighting (keywords, strings, comments, numbers)
  document.querySelectorAll('.code-block code').forEach(function(el) {
    var lang = el.parentElement.dataset.lang || '';
    var text = el.textContent || '';
    if (/^(typescript|javascript|tsx|jsx)$/.test(lang)) {
      text = text
        .replace(/(\\/\\/[^\\n]*)/g, '<span style="color:#6c7086">$1</span>')
        .replace(/(\\/\\*[\\s\\S]*?\\*\\/)/g, '<span style="color:#6c7086">$1</span>')
        .replace(/(["'\`])(?:(?!\\1)[^\\\\]|\\\\.)*?\\1/g, '<span style="color:#a6e3a1">$&</span>')
        .replace(/\\b(import|export|from|const|let|var|function|return|if|else|class|interface|type|async|await|new|this|extends|implements|default|switch|case|break|throw|try|catch|for|while|of|in|as|typeof|void|null|undefined|true|false)\\b/g,
          '<span style="color:#cba6f7">$&</span>')
        .replace(/\\b(\\d+\\.?\\d*)\\b/g, '<span style="color:#fab387">$&</span>');
      el.innerHTML = text;
    } else if (/^(css|scss)$/.test(lang)) {
      text = text
        .replace(/(\\/\\*[\\s\\S]*?\\*\\/)/g, '<span style="color:#6c7086">$1</span>')
        .replace(/(["'])(?:(?!\\1)[^\\\\]|\\\\.)*?\\1/g, '<span style="color:#a6e3a1">$&</span>')
        .replace(/(#[0-9a-fA-F]{3,8})\\b/g, '<span style="color:#f9e2af">$&</span>')
        .replace(/\\b(\\d+\\.?\\d*)(px|rem|em|%|vh|vw|deg|s|ms)?\\b/g,
          '<span style="color:#fab387">$&</span>');
      el.innerHTML = text;
    } else if (/^(html|svg)$/.test(lang)) {
      text = text
        .replace(/(<!--[\\s\\S]*?-->)/g, '<span style="color:#6c7086">$1</span>')
        .replace(/(&lt;\\/?)(\\w+)/g, '$1<span style="color:#89b4fa">$2</span>')
        .replace(/(\\s)(\\w+)(=)/g, '$1<span style="color:#cba6f7">$2</span>$3')
        .replace(/(["'])(?:(?!\\1)[^\\\\]|\\\\.)*?\\1/g, '<span style="color:#a6e3a1">$&</span>');
      el.innerHTML = text;
    }
  });
})();
</script>
</body>
</html>`;
}
