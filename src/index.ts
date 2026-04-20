export * from './ir/types';
export { validateIR, IRValidationError } from './ir/schema';
export { parseDesign, parseDesignMultiPage, parseFigma, parseFigmaMultiPage, parseNativeDesign, parseNativeDesignMultiPage, parseSketch, parseSketchMultiPage, parseMakeJson, parseMakeJsonMultiPage, isMakeJson } from './parser';
export type { DesignFormat, MakeDocument, MakeNode, MakeCodeFile } from './parser';
export { parseMakeBinary, parseMake, parseMakeMultiPage } from './parser/makeParser';
export { inferLayout } from './layout/inference';
export { inferResponsive } from './layout/responsive';
export type { ResponsiveVariantInput } from './layout/responsive';
export { enhance, NoopLLMProvider } from './ai/semanticEnhancer';
export type { LLMProvider } from './ai/semanticEnhancer';
export { ClaudeProvider } from './ai/claudeProvider';
export { NodeLlmProvider } from './ai/nodeLlmProvider';
export type {
  NodeLlmProviderConfig,
  NodeLlmProviderName,
} from './ai/nodeLlmProvider';
export { VisionProvider, buildPairPrompt, buildOverallPrompt } from './ai/visionProvider';
export type {
  VisionBackend,
  VisionProviderConfig,
  ImageInput,
  StageAnalysis,
} from './ai/visionProvider';
export { matchComponents } from './ai/componentMatch';
export type { LibraryTarget, ComponentRule } from './ai/componentMatch';
export {
  createGenerator,
  HtmlGenerator,
  ReactGenerator,
  VueGenerator,
  ReactNativeGenerator,
  FlutterGenerator,
} from './codegen/factory';
export type { Platform } from './codegen/factory';
export type { GenerateResult, GeneratedFile } from './codegen/base';
export { extractTokens, toStyleDictionary } from './tokens/extract';
export type { TokenSet, StyleDictionaryFile } from './tokens/extract';
export {
  generateTailwindPreset,
  buildTailwindLookup,
} from './tokens/tailwindPreset';
export type { TailwindTokenLookup } from './tokens/tailwindPreset';
export { diffIR, mergeProtectedRegions, formatDiff } from './diff/merge';
export type { IRDiffEntry } from './diff/merge';
export { runPipeline, runMultiPagePipeline, runPipelineWithVerification, runMultiPagePipelineWithVerification } from './pipeline/d2cPipeline';
export type { PipelineOptions, PipelineResult, MultiPagePipelineResult, MultiPageVerifiedPipelineResult, VerifiedPipelineResult } from './pipeline/d2cPipeline';
export {
  verifyParse,
  verifyLayout,
  verifySemantics,
  verifyComponentMatch,
  verifyResponsive,
  verifyProtectedMerge,
  verifyTokens,
  verifyCodegen,
  buildVerificationResult,
  formatVerificationReport,
  snapshotToJSON,
} from './pipeline/verify';
export type {
  StageName,
  CheckLevel,
  Check,
  StageSnapshot,
  VerificationResult,
} from './pipeline/verify';
export { compareStages } from './pipeline/stageCompare';
export type {
  PairAnalysis,
  OverallAnalysis,
  ComparisonReport,
} from './pipeline/stageCompare';
export { reportToMarkdown, reportToHtml, reportToJson } from './pipeline/compareReport';
export { loadConfig, resolveApiKey, resolveFigmaToken } from './config';
export type { D2CConfig } from './config';
export { FigmaApiClient, extractFileKey, collectImageRefs } from './api/figmaApi';
export type {
  FigmaApiConfig,
  GetFileOptions,
  GetFileNodesOptions,
  GetImageOptions,
  ImageFormat,
  FigmaFileResponse as ApiFigmaFileResponse,
  FigmaImageResponse,
  FigmaImageFillsResponse,
  FigmaFileNodesResponse,
} from './api/figmaApi';
export { fetchFigmaFile, exportFigmaImages } from './api/figmaApiRenderer';
export type {
  FigmaApiRenderConfig,
  FigmaApiFetchResult,
  FigmaApiImageExportOptions,
  FigmaApiImageExportResult,
} from './api/figmaApiRenderer';
export {
  renderSketch,
  buildRenderTree,
  renderArtboardToSvg,
  renderDocumentToSvg,
  renderToHtmlPreview,
  renderMake,
  buildMakeRenderTree,
  renderMakeHtmlPreview,
} from './renderer';
export type {
  SketchRenderResult,
  RenderNode,
  RenderDocument,
  RenderArtboard,
  SketchRenderOptions,
  MakeRenderOptions,
  MakeRenderResult,
  MakeRenderFullResult,
} from './renderer';
export { isMakeBinary } from './parser/makeParser';
