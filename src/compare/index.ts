/**
 * Public entry for the fidelity-compare module.
 *
 * Usage:
 *   import { runFigmaFidelity, writeReport } from 'd2c/compare';
 */
export { runFigmaFidelity } from './figmaCompare';
export type { FigmaFidelityOptions } from './figmaCompare';
export { reportToMarkdown, reportToHtml, reportToJson, writeReport } from './report';
export { compose, toDimension, DEFAULT_WEIGHTS } from './compose';
export { alignImages, resizeRGBA } from './align';
export { evaluateRegions, collectAbsoluteBoxes } from './region';
export { evaluateText } from './text';
export { evaluateWithLlm, buildFidelityPrompt, averageLlmScore } from './llmPerceptual';
export { isPngIOAvailable, readPng, writePng, createImage } from './pngIO';
export { ssim, msSSIM, luminance } from './metrics/ssim';
export { deltaE2000, deltaEStats, rgbToLab } from './metrics/deltaE';
export { phash, phashSimilarity, hammingDistance } from './metrics/phash';
export { edgeIoU, edgeMask, maskIoU } from './metrics/edges';
export { buildDiffHeatmap } from './metrics/heatmap';
export * from './types';
