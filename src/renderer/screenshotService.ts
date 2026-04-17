/**
 * Screenshot Service — captures HTML strings as PNG images via Playwright.
 *
 * Playwright is an optional dependency.  When it is not installed (or the
 * browser binary is missing) calling `captureScreenshot` will throw with a
 * clear message telling the user how to install it.
 *
 * Usage:
 *   import { captureScreenshot, captureScreenshots } from './screenshotService';
 *   await captureScreenshot(htmlString, 'out/parse.png');
 *   await captureScreenshots([
 *     { html: parseHtml, outputPath: 'out/parse.png' },
 *     { html: layoutHtml, outputPath: 'out/layout.png' },
 *   ]);
 */
import * as path from 'path';
import * as fs from 'fs';

export interface ScreenshotOptions {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  /** If true, capture the full scrollable page (default true). */
  fullPage?: boolean;
}

const DEFAULTS: Required<ScreenshotOptions> = {
  width: 1280,
  height: 960,
  deviceScaleFactor: 2,
  fullPage: true,
};

/**
 * Dynamically import Playwright.  Throws a friendly error when it is
 * not installed or the Chromium binary is missing.
 */
async function loadPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'Playwright is required for PNG screenshot rendering but is not installed.\n' +
        '  npm install playwright\n' +
        '  npx playwright install chromium',
    );
  }
}

// Chromium's max texture dimension is typically 16384px.  When the
// rendered page height × deviceScaleFactor exceeds this, the browser
// crashes or fails.  We measure the page first and pick a safe scale.
const MAX_TEXTURE = 16384;

/**
 * Pick the highest deviceScaleFactor (up to `desired`) that keeps
 * the rendered pixel height within Chromium's texture limit.
 */
function safeDpr(scrollHeight: number, scrollWidth: number, desired: number): number {
  const maxDim = Math.max(scrollHeight, scrollWidth);
  if (maxDim * desired <= MAX_TEXTURE) return desired;
  const safe = Math.floor(MAX_TEXTURE / maxDim);
  return Math.max(safe, 1);
}

/**
 * Render a single HTML string into a browser page and capture a PNG.
 * Launches its own browser so a crash in one job cannot affect others.
 */
async function screenshotWithOwnBrowser(
  pw: typeof import('playwright'),
  html: string,
  outputPath: string,
  o: Required<ScreenshotOptions>,
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // First pass: load at scale 1 to measure content dimensions
  const browser = await pw.chromium.launch();
  try {
    const measurePage = await browser.newPage({
      viewport: { width: o.width, height: o.height },
      deviceScaleFactor: 1,
    });
    await measurePage.setContent(html, { waitUntil: 'networkidle' });
    const dims: { h: number; w: number } = await measurePage.evaluate(
      '({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth })',
    );
    const dpr = safeDpr(dims.h, dims.w, o.deviceScaleFactor);
    if (dpr === 1) {
      // Already at scale 1 — capture directly from this page
      await measurePage.screenshot({ path: outputPath, fullPage: o.fullPage });
    } else {
      await measurePage.close();
      const page = await browser.newPage({
        viewport: { width: o.width, height: o.height },
        deviceScaleFactor: dpr,
      });
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.screenshot({ path: outputPath, fullPage: o.fullPage });
    }
  } finally {
    await browser.close();
  }
}

/**
 * Capture a single HTML string as a PNG screenshot.
 */
export async function captureScreenshot(
  html: string,
  outputPath: string,
  opts?: ScreenshotOptions,
): Promise<void> {
  const o = { ...DEFAULTS, ...opts };
  const pw = await loadPlaywright();
  await screenshotWithOwnBrowser(pw, html, outputPath, o);
}

export interface ScreenshotJob {
  html: string;
  outputPath: string;
}

/**
 * Capture multiple HTML strings as PNG screenshots.
 * Each job gets its own browser instance to prevent a single crash
 * from taking down the entire batch.
 */
export async function captureScreenshots(
  jobs: ScreenshotJob[],
  opts?: ScreenshotOptions,
): Promise<void> {
  if (jobs.length === 0) return;
  const o = { ...DEFAULTS, ...opts };
  const pw = await loadPlaywright();
  for (const job of jobs) {
    await screenshotWithOwnBrowser(pw, job.html, job.outputPath, o);
  }
}
