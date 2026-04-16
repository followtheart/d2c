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
 * Chrome CDP limits the screenshot bitmap to ~16384px per dimension.
 * With deviceScaleFactor = 2, the max content height is 16384 / 2 = 8192.
 */
const MAX_CAPTURE_HEIGHT = 16384;

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

/**
 * Take a screenshot with automatic fallback: if `fullPage: true` fails
 * (e.g. page exceeds CDP bitmap limits), retry with a height-clipped capture.
 */
async function safeScreenshot(
  page: import('playwright').Page,
  outputPath: string,
  fullPage: boolean,
  scaleFactor: number,
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    await page.screenshot({ path: outputPath, fullPage });
  } catch (err: unknown) {
    if (!fullPage) throw err;
    // fullPage failed — clip to the max safe height
    const maxH = Math.floor(MAX_CAPTURE_HEIGHT / scaleFactor);
    const vp = page.viewportSize();
    const clipW = vp?.width ?? 1280;
    await page.screenshot({
      path: outputPath,
      clip: { x: 0, y: 0, width: clipW, height: maxH },
    });
    console.error(
      `  warning: page too tall for fullPage screenshot, clipped to ${maxH}px → ${path.basename(outputPath)}`,
    );
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
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: o.width, height: o.height },
      deviceScaleFactor: o.deviceScaleFactor,
    });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await safeScreenshot(page, outputPath, o.fullPage, o.deviceScaleFactor);
  } finally {
    await browser.close();
  }
}

export interface ScreenshotJob {
  html: string;
  outputPath: string;
}

/**
 * Capture multiple HTML strings as PNG screenshots using a single
 * browser instance (parallel pages for speed).
 */
export async function captureScreenshots(
  jobs: ScreenshotJob[],
  opts?: ScreenshotOptions,
): Promise<void> {
  if (jobs.length === 0) return;
  const o = { ...DEFAULTS, ...opts };
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch();
  try {
    // Process pages in parallel batches of up to 4
    const BATCH = 4;
    for (let i = 0; i < jobs.length; i += BATCH) {
      const batch = jobs.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (job) => {
          const page = await browser.newPage({
            viewport: { width: o.width, height: o.height },
            deviceScaleFactor: o.deviceScaleFactor,
          });
          try {
            await page.setContent(job.html, { waitUntil: 'networkidle' });
            await safeScreenshot(page, job.outputPath, o.fullPage, o.deviceScaleFactor);
          } finally {
            await page.close();
          }
        }),
      );
    }
  } finally {
    await browser.close();
  }
}
