/**
 * Fidelity report serializers — Markdown / JSON / HTML.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  FidelityReport,
  FidelityDimensionName,
  RegionScore,
} from './types';

// ── Markdown ──────────────────────────────────────────────────────────

function pct(v: number | undefined): string {
  return v === undefined ? 'N/A' : `${(v * 100).toFixed(1)}%`;
}

function score10(v: number | undefined): string {
  return v === undefined ? 'N/A' : `${(v * 10).toFixed(1)}/10`;
}

export function reportToMarkdown(report: FidelityReport): string {
  const lines: string[] = [];
  lines.push('# D2C Figma Fidelity Report\n');
  lines.push(`_Generated: ${report.generatedAt} · v${report.version}_\n`);

  lines.push('## Inputs\n');
  lines.push(`- Reference: \`${report.inputs.reference}\``);
  lines.push(`- Candidate: \`${report.inputs.candidate}\``);
  if (report.inputs.irSnapshot) {
    lines.push(`- IR: \`${report.inputs.irSnapshot}\``);
  }
  lines.push(
    `- Aligned canvas: ${report.alignment.width}×${report.alignment.height}px ` +
      `(ref scale ${report.alignment.referenceScale.toFixed(3)}, ` +
      `cand scale ${report.alignment.candidateScale.toFixed(3)})`,
  );
  if (report.alignment.candidateOverflow > 0) {
    lines.push(
      `- Candidate overflow: ${(report.alignment.candidateOverflow * 100).toFixed(1)}%`,
    );
  }
  lines.push('');

  lines.push('## Overall\n');
  lines.push(`**Overall fidelity: ${report.overall.toFixed(1)} / 10**\n`);
  if (report.weakestDimension) {
    lines.push(
      `_Weakest dimension: **${report.weakestDimension}** — ` +
        `${report.dimensions[report.weakestDimension].summary}_\n`,
    );
  }

  lines.push('## Dimensions\n');
  lines.push('| Dimension | Score | Weight | Summary |');
  lines.push('|:----------|:-----:|:------:|:--------|');
  for (const name of orderedDims()) {
    const d = report.dimensions[name];
    lines.push(
      `| ${name} | ${score10(d.value)} | ${(d.weight * 100).toFixed(0)}% | ${escapeMd(d.summary)} |`,
    );
  }
  lines.push('');

  if (report.llm) {
    lines.push('## LLM Sub-Dimensions (0–10)\n');
    lines.push('| layout | spacing | color | typography | imagery | completeness |');
    lines.push('|:---:|:---:|:---:|:---:|:---:|:---:|');
    lines.push(
      `| ${report.llm.layoutFidelity} | ${report.llm.spacingFidelity} | ${report.llm.colorFidelity} | ${report.llm.typographyFidelity} | ${report.llm.imageryFidelity} | ${report.llm.completeness} |`,
    );
    if (report.llm.defects.length) {
      lines.push('\n### Defects\n');
      for (const d of report.llm.defects) lines.push(`- ${escapeMd(d)}`);
    }
    lines.push('');
  }

  if (report.worstRegions.length > 0) {
    lines.push('## Worst Regions\n');
    lines.push('| Node | Type | Area (px²) | SSIM | ΔE | Score |');
    lines.push('|:-----|:-----|:---------:|:----:|:--:|:-----:|');
    for (const r of report.worstRegions) {
      lines.push(
        `| ${escapeMd(r.name)} | ${r.type} | ${r.area} | ${r.ssim.toFixed(3)} | ${r.deltaE.toFixed(1)} | ${pct(r.aggregated)} |`,
      );
    }
    lines.push('');
  }

  if (report.texts && report.texts.length > 0) {
    const bad = report.texts.filter((t) => t.score < 1);
    if (bad.length) {
      lines.push('## Text Nodes With Issues\n');
      lines.push('| Content | Size | Weight | Score | Reason |');
      lines.push('|:--------|:----:|:------:|:-----:|:-------|');
      for (const t of bad) {
        lines.push(
          `| ${escapeMd(truncate(t.content, 40))} | ${t.fontSize} | ${t.fontWeight} | ${pct(t.score)} | ${escapeMd(t.reason ?? '')} |`,
        );
      }
      lines.push('');
    }
  }

  if (report.warnings.length > 0) {
    lines.push('## Warnings\n');
    for (const w of report.warnings) {
      lines.push(`- [${w.code}] ${escapeMd(w.message)}`);
    }
    lines.push('');
  }

  if (report.diagnostics.heatmapPath) {
    lines.push('## Diagnostics\n');
    lines.push(`- Heatmap: \`${report.diagnostics.heatmapPath}\``);
    if (report.diagnostics.referenceAlignedPath) {
      lines.push(
        `- Aligned reference: \`${report.diagnostics.referenceAlignedPath}\``,
      );
    }
    if (report.diagnostics.candidateAlignedPath) {
      lines.push(
        `- Aligned candidate: \`${report.diagnostics.candidateAlignedPath}\``,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── JSON ─────────────────────────────────────────────────────────────

export function reportToJson(report: FidelityReport): string {
  return JSON.stringify(report, null, 2);
}

// ── HTML ─────────────────────────────────────────────────────────────

export function reportToHtml(
  report: FidelityReport,
  imageDir?: string,
): string {
  const css = `
body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;color:#1e293b;line-height:1.6;padding:0 1rem}
h1{border-bottom:2px solid #3b82f6;padding-bottom:.5rem}
h2{margin-top:2rem;color:#334155}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid #cbd5e1;padding:.4rem .6rem;text-align:left;font-size:14px}
th{background:#f1f5f9}
.score{font-size:1.8rem;font-weight:700;color:#3b82f6}
.bad{color:#dc2626}
.ok{color:#16a34a}
.label{font-weight:600;color:#475569}
.image-row{display:flex;gap:12px;flex-wrap:wrap;margin:1rem 0}
.image-row figure{margin:0;flex:1;min-width:280px}
.image-row img{width:100%;border:1px solid #e2e8f0;border-radius:6px}
.image-row figcaption{font-size:12px;color:#64748b;text-align:center;margin-top:4px}
.dim-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin:1rem 0}
.dim-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px}
.dim-card .name{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b}
.dim-card .val{font-size:24px;font-weight:700;color:#3b82f6}
.dim-card .sub{font-size:12px;color:#64748b}
`;

  const dims = orderedDims()
    .map((n) => {
      const d = report.dimensions[n];
      const val = d.value === undefined ? 'N/A' : (d.value * 10).toFixed(1);
      return `<div class="dim-card">
<div class="name">${n}</div>
<div class="val">${val}</div>
<div class="sub">weight ${(d.weight * 100).toFixed(0)}% · ${esc(d.summary)}</div>
</div>`;
    })
    .join('\n');

  const images = imageDir
    ? `<div class="image-row">
${report.diagnostics.referenceAlignedPath ? `<figure><img src="${rel(imageDir, report.diagnostics.referenceAlignedPath)}"><figcaption>reference (aligned)</figcaption></figure>` : ''}
${report.diagnostics.candidateAlignedPath ? `<figure><img src="${rel(imageDir, report.diagnostics.candidateAlignedPath)}"><figcaption>candidate (aligned)</figcaption></figure>` : ''}
${report.diagnostics.heatmapPath ? `<figure><img src="${rel(imageDir, report.diagnostics.heatmapPath)}"><figcaption>ΔE heatmap</figcaption></figure>` : ''}
</div>`
    : '';

  const worstRows = report.worstRegions
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td>${r.type}</td><td>${r.area}</td><td>${r.ssim.toFixed(3)}</td><td>${r.deltaE.toFixed(1)}</td><td class="${r.aggregated < 0.6 ? 'bad' : 'ok'}">${pct(r.aggregated)}</td></tr>`,
    )
    .join('\n');

  const llmBlock = report.llm
    ? `<h2>LLM Sub-Dimensions</h2>
<table>
<tr><th>layout</th><th>spacing</th><th>color</th><th>typography</th><th>imagery</th><th>completeness</th></tr>
<tr><td>${report.llm.layoutFidelity}</td><td>${report.llm.spacingFidelity}</td><td>${report.llm.colorFidelity}</td><td>${report.llm.typographyFidelity}</td><td>${report.llm.imageryFidelity}</td><td>${report.llm.completeness}</td></tr>
</table>
${report.llm.defects.length ? `<h3>Defects</h3><ul>${report.llm.defects.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>D2C Fidelity Report</title><style>${css}</style></head><body>
<h1>D2C Figma Fidelity Report</h1>
<p class="label">Overall: <span class="score">${report.overall.toFixed(1)} / 10</span></p>
${report.weakestDimension ? `<p>Weakest dimension: <strong>${report.weakestDimension}</strong> — ${esc(report.dimensions[report.weakestDimension].summary)}</p>` : ''}
${images}
<h2>Dimensions</h2>
<div class="dim-grid">${dims}</div>
${llmBlock}
${worstRows ? `<h2>Worst Regions</h2>
<table>
<tr><th>Node</th><th>Type</th><th>Area</th><th>SSIM</th><th>ΔE</th><th>Score</th></tr>
${worstRows}
</table>` : ''}
${report.warnings.length ? `<h2>Warnings</h2><ul>${report.warnings.map((w) => `<li><code>${w.code}</code>: ${esc(w.message)}</li>`).join('')}</ul>` : ''}
</body></html>`;
}

export function writeReport(
  report: FidelityReport,
  filePath: string,
  imageDir?: string,
): void {
  const ext = path.extname(filePath).toLowerCase();
  fs.mkdirSync(path.dirname(filePath) || '.', { recursive: true });
  let content: string;
  if (ext === '.json') content = reportToJson(report);
  else if (ext === '.html') content = reportToHtml(report, imageDir ?? path.dirname(filePath));
  else content = reportToMarkdown(report);
  fs.writeFileSync(filePath, content);
}

// ── Helpers ──────────────────────────────────────────────────────────

function orderedDims(): FidelityDimensionName[] {
  return ['perceptual', 'color', 'edge', 'region', 'text', 'llm'];
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function rel(fromDir: string, to: string): string {
  if (path.isAbsolute(to)) {
    return path.relative(fromDir, to).replace(/\\/g, '/');
  }
  return to.replace(/\\/g, '/');
}

// Suppress unused-type lint.
type _Unused = RegionScore;
