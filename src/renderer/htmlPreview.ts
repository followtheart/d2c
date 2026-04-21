/**
 * HTML Preview Renderer
 *
 * Produces a standalone HTML file that embeds the SVG renderings of all
 * artboards in an interactive preview page with:
 *   - Pan & zoom (mouse wheel + drag)
 *   - Artboard titles and navigation
 *   - Dark/light background toggle
 *   - Zoom percentage indicator
 *   - Layer info on hover
 *   - Keyboard shortcuts (Cmd/Ctrl+0 = fit, +/- zoom)
 */

import type { RenderDocument, SketchRenderOptions } from './types';
import { renderArtboardToSvg } from './svgRenderer';

/**
 * Generate a standalone HTML preview file from a RenderDocument.
 */
export function renderToHtmlPreview(
  doc: RenderDocument,
  options?: SketchRenderOptions,
): string {
  const opts: SketchRenderOptions = {
    scale: 1,
    pageBackground: '#f5f5f5',
    showArtboardTitles: true,
    ...options,
  };

  const artboardSvgs = doc.artboards.map((ab) => ({
    name: ab.name,
    width: ab.frame.width * (opts.scale ?? 1),
    height: ab.frame.height * (opts.scale ?? 1),
    svg: renderArtboardToSvg(ab, opts),
    bgColor: ab.backgroundColor ?? '#ffffff',
  }));

  const artboardCards = artboardSvgs
    .map(
      (ab, i) => `
      <div class="artboard-card" data-index="${i}">
        ${opts.showArtboardTitles ? `<div class="artboard-title">${escHtml(ab.name)}</div>` : ''}
        <div class="artboard-frame" style="width:${ab.width}px; height:${ab.height}px; background:${ab.bgColor};">
          ${ab.svg}
        </div>
      </div>`,
    )
    .join('\n');

  const artboardNav = artboardSvgs
    .map(
      (ab, i) =>
        `<button class="nav-btn" data-target="${i}" title="${escHtml(ab.name)}">${escHtml(ab.name)}</button>`,
    )
    .join('\n          ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(doc.name)} — Sketch Preview</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: ${opts.pageBackground};
    --surface: #ffffff;
    --text: #333;
    --text-secondary: #888;
    --border: #ddd;
    --toolbar-bg: rgba(255,255,255,0.95);
    --shadow: 0 2px 12px rgba(0,0,0,0.08);
  }
  .dark {
    --bg: #1a1a1a;
    --surface: #2a2a2a;
    --text: #e0e0e0;
    --text-secondary: #999;
    --border: #444;
    --toolbar-bg: rgba(40,40,40,0.95);
    --shadow: 0 2px 12px rgba(0,0,0,0.3);
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    background: var(--bg);
    color: var(--text);
    overflow: hidden;
    height: 100vh;
    width: 100vw;
    cursor: grab;
    user-select: none;
  }
  body.panning { cursor: grabbing; }

  /* Toolbar */
  .toolbar {
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    background: var(--toolbar-bg);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 6px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: var(--shadow);
    font-size: 13px;
  }
  .toolbar button {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    color: var(--text);
    font-size: 12px;
    transition: background 0.15s;
  }
  .toolbar button:hover { background: var(--border); }
  .toolbar .sep { width: 1px; height: 20px; background: var(--border); }
  .zoom-display {
    min-width: 52px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }

  /* Artboard navigation */
  .nav-bar {
    position: fixed;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    background: var(--toolbar-bg);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 6px 12px;
    display: flex;
    gap: 4px;
    box-shadow: var(--shadow);
    max-width: 90vw;
    overflow-x: auto;
  }
  .nav-btn {
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px 12px;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12px;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .nav-btn:hover { color: var(--text); border-color: var(--border); }
  .nav-btn.active { color: var(--text); border-color: var(--text); font-weight: 600; }

  /* Canvas viewport */
  #viewport {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    overflow: hidden;
  }
  #canvas {
    transform-origin: 0 0;
    position: absolute;
    display: flex;
    gap: 60px;
    padding: 80px;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .artboard-card {
    flex-shrink: 0;
  }
  .artboard-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 8px;
    padding-left: 2px;
  }
  .artboard-frame {
    box-shadow: 0 1px 4px rgba(0,0,0,0.1);
    overflow: hidden;
  }
  .artboard-frame svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* Info tooltip */
  .info-panel {
    position: fixed;
    bottom: 60px;
    right: 12px;
    z-index: 100;
    background: var(--toolbar-bg);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--text-secondary);
    box-shadow: var(--shadow);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .info-panel.visible { opacity: 1; }
</style>
</head>
<body>
  <!-- Toolbar -->
  <div class="toolbar">
    <button id="zoomOut" title="Zoom out (-)">-</button>
    <span class="zoom-display" id="zoomDisplay">100%</span>
    <button id="zoomIn" title="Zoom in (+)">+</button>
    <div class="sep"></div>
    <button id="fitAll" title="Fit all (Ctrl+0)">Fit</button>
    <button id="actual" title="Actual size (Ctrl+1)">1:1</button>
    <div class="sep"></div>
    <button id="toggleBg" title="Toggle background">BG</button>
  </div>

  ${artboardSvgs.length > 1 ? `
  <!-- Artboard navigation -->
  <div class="nav-bar">
    ${artboardNav}
  </div>` : ''}

  <!-- Info panel -->
  <div class="info-panel" id="infoPanel"></div>

  <!-- Viewport -->
  <div id="viewport">
    <div id="canvas">
      ${artboardCards}
    </div>
  </div>

<script>
(function() {
  const viewport = document.getElementById('viewport');
  const canvas = document.getElementById('canvas');
  const zoomDisplay = document.getElementById('zoomDisplay');
  const infoPanel = document.getElementById('infoPanel');
  const artboardCards = Array.from(document.querySelectorAll('.artboard-card'));
  const navButtons = Array.from(document.querySelectorAll('.nav-btn'));
  const largeDocumentThreshold = 6;

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let startX = 0;
  let startY = 0;

  function applyTransform() {
    canvas.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
    zoomDisplay.textContent = Math.round(zoom * 100) + '%';
  }

  function fitAll() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    // Measure unscaled canvas size
    canvas.style.transform = 'translate(0px, 0px) scale(1)';
    const cw = canvas.scrollWidth;
    const ch = canvas.scrollHeight;
    zoom = Math.min(vw / cw, vh / ch, 1) * 0.9;
    panX = (vw - cw * zoom) / 2;
    panY = (vh - ch * zoom) / 2;
    applyTransform();
  }

  function setActiveArtboard(index) {
    navButtons.forEach(function(btn, btnIndex) {
      btn.classList.toggle('active', btnIndex === index);
    });
  }

  function fitArtboard(index) {
    const card = artboardCards[index];
    if (!card) {
      fitAll();
      return;
    }
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    canvas.style.transform = 'translate(0px, 0px) scale(1)';
    const canvasRect = canvas.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardX = cardRect.left - canvasRect.left;
    const cardY = cardRect.top - canvasRect.top;
    const cardW = Math.max(cardRect.width, 1);
    const cardH = Math.max(cardRect.height, 1);
    zoom = Math.min(vw / cardW, vh / cardH, 1) * 0.9;
    panX = (vw - cardW * zoom) / 2 - cardX * zoom;
    panY = (vh - cardH * zoom) / 2 - cardY * zoom;
    applyTransform();
    setActiveArtboard(index);
  }

  function setZoom(newZoom, cx, cy) {
    cx = cx || viewport.clientWidth / 2;
    cy = cy || viewport.clientHeight / 2;
    var ratio = newZoom / zoom;
    panX = cx - ratio * (cx - panX);
    panY = cy - ratio * (cy - panY);
    zoom = newZoom;
    applyTransform();
  }

  // Mouse wheel zoom
  viewport.addEventListener('wheel', function(e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? 0.9 : 1.1;
    var newZoom = Math.min(Math.max(zoom * delta, 0.05), 20);
    setZoom(newZoom, e.clientX, e.clientY);
  }, { passive: false });

  // Pan
  viewport.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    isPanning = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    document.body.classList.add('panning');
  });
  window.addEventListener('mousemove', function(e) {
    if (!isPanning) return;
    panX = e.clientX - startX;
    panY = e.clientY - startY;
    applyTransform();
  });
  window.addEventListener('mouseup', function() {
    isPanning = false;
    document.body.classList.remove('panning');
  });

  // Toolbar buttons
  document.getElementById('zoomIn').onclick = function() { setZoom(zoom * 1.2); };
  document.getElementById('zoomOut').onclick = function() { setZoom(zoom / 1.2); };
  document.getElementById('fitAll').onclick = fitAll;
  document.getElementById('actual').onclick = function() {
    setZoom(1, viewport.clientWidth / 2, viewport.clientHeight / 2);
  };
  document.getElementById('toggleBg').onclick = function() {
    document.body.classList.toggle('dark');
  };

  // Artboard navigation
  navButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(btn.dataset.target);
      fitArtboard(idx);
    });
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', function(e) {
    var ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === '0') { e.preventDefault(); fitAll(); }
    if (ctrl && e.key === '1') { e.preventDefault(); setZoom(1); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom * 1.2); }
    if (e.key === '-') { e.preventDefault(); setZoom(zoom / 1.2); }
  });

  // Hover info for SVG elements
  viewport.addEventListener('mouseover', function(e) {
    var el = e.target;
    if (el.tagName === 'rect' || el.tagName === 'ellipse' || el.tagName === 'text' || el.tagName === 'path') {
      var parent = el.closest('g');
      var title = el.getAttribute('data-name') ||
                  (parent && parent.getAttribute('data-name')) || '';
      if (title) {
        infoPanel.textContent = title;
        infoPanel.classList.add('visible');
      }
    }
  });
  viewport.addEventListener('mouseout', function() {
    infoPanel.classList.remove('visible');
  });

  // Initial fit
  requestAnimationFrame(function() {
    if (artboardCards.length > largeDocumentThreshold) {
      fitArtboard(0);
      return;
    }
    fitAll();
    if (artboardCards.length > 0) setActiveArtboard(0);
  });
})();
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
