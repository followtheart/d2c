/**
 * Comparison Report Generator.
 *
 * Converts a `ComparisonReport` into human-readable Markdown or
 * machine-readable JSON, optionally inlining stage screenshots as
 * base64 data URIs in an HTML report.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ComparisonReport, PairAnalysis, OverallAnalysis } from './stageCompare';

// ── Markdown ──────────────────────────────────────────────────────────

export function reportToMarkdown(
  report: ComparisonReport,
  imageDir?: string,
): string {
  const lines: string[] = [];
  lines.push('# D2C Pipeline — Stage Comparison Report\n');

  // Quality summary table
  lines.push('## Quality Summary\n');
  lines.push('| Transition | Score | Info Gain | Data Loss |');
  lines.push('|:-----------|:-----:|:----------|:----------|');
  for (const p of report.pairs) {
    lines.push(
      `| ${p.from} → ${p.to} | **${p.qualityScore}/10** | ${truncate(p.infoGain, 60)} | ${truncate(p.dataLoss, 60)} |`,
    );
  }
  lines.push(
    `| **Overall** (${report.overall.from} → ${report.overall.to}) | **${report.overall.qualityScore}/10** | ${truncate(report.overall.infoGain, 60)} | ${truncate(report.overall.dataLoss, 60)} |`,
  );
  lines.push('');

  // Pair details
  lines.push('## Pair Analysis\n');
  for (const p of report.pairs) {
    lines.push(`### ${p.from} → ${p.to}\n`);
    if (imageDir) {
      lines.push(
        `| ![${p.from}](./${p.from}.png) | → | ![${p.to}](./${p.to}.png) |`,
      );
      lines.push('|:---:|:---:|:---:|');
      lines.push('');
    }
    lines.push(`**Visual Differences:** ${p.visualDiff}\n`);
    lines.push(`**Information Gain:** ${p.infoGain}\n`);
    lines.push(`**Data Loss / Distortion:** ${p.dataLoss}\n`);
    lines.push(`**Quality Score:** ${p.qualityScore}/10\n`);
    lines.push('---\n');
  }

  // Overall
  lines.push('## Overall Pipeline Assessment\n');
  lines.push(
    `**${report.overall.from} → ${report.overall.to}**\n`,
  );
  lines.push(`**Visual Differences:** ${report.overall.visualDiff}\n`);
  lines.push(`**Information Gain:** ${report.overall.infoGain}\n`);
  lines.push(`**Data Loss / Distortion:** ${report.overall.dataLoss}\n`);
  lines.push(`**Quality Score:** ${report.overall.qualityScore}/10\n`);

  return lines.join('\n');
}

// ── HTML report (inline images) ───────────────────────────────────────

export function reportToHtml(
  report: ComparisonReport,
  imageDir: string,
): string {
  const css = `
body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;color:#1e293b;line-height:1.6}
h1{border-bottom:2px solid #3b82f6;padding-bottom:.5rem}
h2{margin-top:2rem;color:#334155}
h3{color:#475569}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid #cbd5e1;padding:.5rem .75rem;text-align:left}
th{background:#f1f5f9}
.pair{display:flex;gap:1rem;align-items:flex-start;margin:1rem 0}
.pair img{max-width:400px;border:1px solid #e2e8f0;border-radius:4px}
.score{font-size:1.5rem;font-weight:700;color:#3b82f6}
.label{font-weight:600;color:#475569}
hr{border:none;border-top:1px solid #e2e8f0;margin:1.5rem 0}
`;

  const pairSections = report.pairs
    .map((p) => {
      const fromImg = tryInlineImage(imageDir, `${p.from}.png`);
      const toImg = tryInlineImage(imageDir, `${p.to}.png`);
      return `
<h3>${esc(p.from)} → ${esc(p.to)}</h3>
<div class="pair">
  ${fromImg ? `<img src="${fromImg}" alt="${esc(p.from)}">` : ''}
  ${toImg ? `<img src="${toImg}" alt="${esc(p.to)}">` : ''}
</div>
<p><span class="label">Visual Differences:</span> ${esc(p.visualDiff)}</p>
<p><span class="label">Information Gain:</span> ${esc(p.infoGain)}</p>
<p><span class="label">Data Loss:</span> ${esc(p.dataLoss)}</p>
<p><span class="label">Quality Score:</span> <span class="score">${p.qualityScore}/10</span></p>
<hr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>D2C Stage Comparison Report</title><style>${css}</style></head>
<body>
<h1>D2C Pipeline — Stage Comparison Report</h1>

<h2>Quality Summary</h2>
<table>
<tr><th>Transition</th><th>Score</th><th>Info Gain</th><th>Data Loss</th></tr>
${report.pairs.map((p) => `<tr><td>${esc(p.from)} → ${esc(p.to)}</td><td><strong>${p.qualityScore}/10</strong></td><td>${esc(truncate(p.infoGain, 80))}</td><td>${esc(truncate(p.dataLoss, 80))}</td></tr>`).join('\n')}
<tr><td><strong>Overall</strong> (${esc(report.overall.from)} → ${esc(report.overall.to)})</td><td><strong>${report.overall.qualityScore}/10</strong></td><td>${esc(truncate(report.overall.infoGain, 80))}</td><td>${esc(truncate(report.overall.dataLoss, 80))}</td></tr>
</table>

<h2>Pair Analysis</h2>
${pairSections}

<h2>Overall Pipeline Assessment</h2>
<p><strong>${esc(report.overall.from)} → ${esc(report.overall.to)}</strong></p>
<p><span class="label">Visual Differences:</span> ${esc(report.overall.visualDiff)}</p>
<p><span class="label">Information Gain:</span> ${esc(report.overall.infoGain)}</p>
<p><span class="label">Data Loss:</span> ${esc(report.overall.dataLoss)}</p>
<p><span class="label">Quality Score:</span> <span class="score">${report.overall.qualityScore}/10</span></p>
</body></html>`;
}

// ── JSON ──────────────────────────────────────────────────────────────

export function reportToJson(report: ComparisonReport): string {
  return JSON.stringify(report, null, 2);
}

// ── Utilities ─────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tryInlineImage(dir: string, filename: string): string | null {
  const p = path.join(dir, filename);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return `data:image/png;base64,${buf.toString('base64')}`;
}
