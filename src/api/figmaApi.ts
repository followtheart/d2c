/**
 * Figma REST API client.
 *
 * Wraps the Figma REST API endpoints needed for d2c:
 *   - GET /v1/files/:key           → full file JSON
 *   - GET /v1/files/:key/nodes     → specific node subtrees
 *   - GET /v1/images/:key          → rendered image URLs
 *   - GET /v1/files/:key/images    → image fill download URLs
 *
 * Authentication: personal access token via `X-Figma-Token` header,
 * or OAuth2 bearer token via `Authorization: Bearer <token>`.
 *
 * Zero external dependencies — uses Node built-in `https`.
 */
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

// ── Types ────────────────────────────────────────────────────────────

export interface FigmaApiConfig {
  // Personal access token or OAuth2 access token
  token: string;
  // Base URL override (default: https://api.figma.com)
  baseUrl?: string;
}

export interface GetFileOptions {
  // Specific version ID
  version?: string;
  // Comma-separated node IDs to include
  ids?: string;
  // Depth of document tree traversal
  depth?: number;
  // Set to "paths" to export vector data
  geometry?: string;
  // Plugin data IDs
  pluginData?: string;
  // Include branch metadata
  branchData?: boolean;
}

export interface GetFileNodesOptions {
  // Comma-separated node IDs to retrieve
  ids: string;
  // Specific version ID
  version?: string;
  // Depth limit
  depth?: number;
  // Set to "paths" for vector data
  geometry?: string;
  // Plugin data IDs
  pluginData?: string;
}

export type ImageFormat = 'jpg' | 'png' | 'svg' | 'pdf';

export interface GetImageOptions {
  // Comma-separated node IDs to render
  ids: string;
  // Scale factor 0.01–4
  scale?: number;
  // Output format
  format?: ImageFormat;
  // SVG: outline text
  svgOutlineText?: boolean;
  // SVG: include id attributes
  svgIncludeId?: boolean;
  // SVG: include node id
  svgIncludeNodeId?: boolean;
  // SVG: simplify strokes
  svgSimplifyStroke?: boolean;
  // Exclude overlapping content
  contentsOnly?: boolean;
  // Use absolute bounds
  useAbsoluteBounds?: boolean;
  // Specific version
  version?: string;
}

export interface FigmaFileResponse {
  name: string;
  role: string;
  lastModified: string;
  editorType: string;
  thumbnailUrl: string;
  version: string;
  document: FigmaNode;
  components: Record<string, unknown>;
  componentSets: Record<string, unknown>;
  schemaVersion: number;
  styles: Record<string, unknown>;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  effects?: FigmaEffect[];
  opacity?: number;
  characters?: string;
  style?: Record<string, unknown>;
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  [key: string]: unknown;
}

export interface FigmaPaint {
  type: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number; a?: number };
  opacity?: number;
  imageRef?: string;
}

export interface FigmaEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  offset?: { x: number; y: number };
  color?: { r: number; g: number; b: number; a?: number };
  spread?: number;
}

export interface FigmaImageResponse {
  err: string | null;
  images: Record<string, string | null>;
  status?: number;
}

export interface FigmaImageFillsResponse {
  meta?: { images: Record<string, string> };
  images?: Record<string, string>;
  error?: boolean;
  status?: number;
}

export interface FigmaFileNodesResponse {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  nodes: Record<string, { document: FigmaNode; components: Record<string, unknown> } | null>;
}

// ── Client ───────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://api.figma.com';

export class FigmaApiClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(config: FigmaApiConfig) {
    if (!config.token) {
      throw new Error('Figma API token is required');
    }
    this.token = config.token;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * GET /v1/files/:key — returns the full file JSON.
   */
  async getFile(fileKey: string, options?: GetFileOptions): Promise<FigmaFileResponse> {
    const params = new URLSearchParams();
    if (options?.version) params.set('version', options.version);
    if (options?.ids) params.set('ids', options.ids);
    if (options?.depth !== undefined) params.set('depth', String(options.depth));
    if (options?.geometry) params.set('geometry', options.geometry);
    if (options?.pluginData) params.set('plugin_data', options.pluginData);
    if (options?.branchData) params.set('branch_data', 'true');
    return this.request<FigmaFileResponse>(`/v1/files/${encodeURIComponent(fileKey)}`, params);
  }

  /**
   * GET /v1/files/:key/nodes — returns specific node subtrees.
   */
  async getFileNodes(fileKey: string, options: GetFileNodesOptions): Promise<FigmaFileNodesResponse> {
    const params = new URLSearchParams();
    params.set('ids', options.ids);
    if (options.version) params.set('version', options.version);
    if (options.depth !== undefined) params.set('depth', String(options.depth));
    if (options.geometry) params.set('geometry', options.geometry);
    if (options.pluginData) params.set('plugin_data', options.pluginData);
    return this.request<FigmaFileNodesResponse>(`/v1/files/${encodeURIComponent(fileKey)}/nodes`, params);
  }

  /**
   * GET /v1/images/:key — renders nodes as images (PNG/JPG/SVG/PDF).
   * Returns a map of node ID → temporary image URL (expires in 30 days).
   */
  async getImage(fileKey: string, options: GetImageOptions): Promise<FigmaImageResponse> {
    const params = new URLSearchParams();
    params.set('ids', options.ids);
    if (options.scale !== undefined) params.set('scale', String(options.scale));
    if (options.format) params.set('format', options.format);
    if (options.svgOutlineText !== undefined) params.set('svg_outline_text', String(options.svgOutlineText));
    if (options.svgIncludeId !== undefined) params.set('svg_include_id', String(options.svgIncludeId));
    if (options.svgIncludeNodeId !== undefined) params.set('svg_include_node_id', String(options.svgIncludeNodeId));
    if (options.svgSimplifyStroke !== undefined) params.set('svg_simplify_stroke', String(options.svgSimplifyStroke));
    if (options.contentsOnly !== undefined) params.set('contents_only', String(options.contentsOnly));
    if (options.useAbsoluteBounds !== undefined) params.set('use_absolute_bounds', String(options.useAbsoluteBounds));
    if (options.version) params.set('version', options.version);
    return this.request<FigmaImageResponse>(`/v1/images/${encodeURIComponent(fileKey)}`, params);
  }

  /**
   * GET /v1/files/:key/images — returns download URLs for all image fills.
   * Maps imageRef → URL for every user-supplied image in the file.
   */
  async getImageFills(fileKey: string): Promise<FigmaImageFillsResponse> {
    return this.request<FigmaImageFillsResponse>(`/v1/files/${encodeURIComponent(fileKey)}/images`);
  }

  /**
   * Download a binary resource (image URL) and return it as a Buffer.
   */
  async downloadImage(url: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.get(url, { headers: { 'User-Agent': 'd2c/1.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          this.downloadImage(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Image download failed: HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  // ── Internal HTTP helper ───────────────────────────────────────────

  private request<T>(path: string, params?: URLSearchParams): Promise<T> {
    const qs = params?.toString();
    const fullPath = qs ? `${path}?${qs}` : path;
    const url = `${this.baseUrl}${fullPath}`;
    const parsed = new URL(url);

    return new Promise<T>((resolve, reject) => {
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.get(
        url,
        {
          headers: {
            'X-Figma-Token': this.token,
            'Accept': 'application/json',
            'User-Agent': 'd2c/1.0',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(
                `Figma API error ${res.statusCode}: ${body.slice(0, 500)}`,
              ));
              return;
            }
            try {
              resolve(JSON.parse(body) as T);
            } catch {
              reject(new Error(`Failed to parse Figma API response: ${body.slice(0, 200)}`));
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
}

// ── Convenience helpers ──────────────────────────────────────────────

/**
 * Extract the file key from a Figma URL.
 * Supports: https://www.figma.com/file/ABC123/...
 *           https://www.figma.com/design/ABC123/...
 */
export function extractFileKey(urlOrKey: string): string {
  // Already a plain key (no slashes, no protocol)
  if (/^[a-zA-Z0-9]+$/.test(urlOrKey)) return urlOrKey;
  const match = urlOrKey.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
  if (match) return match[1];
  return urlOrKey;
}

/**
 * Collect all imageRef values from the node tree.
 */
export function collectImageRefs(node: FigmaNode): Set<string> {
  const refs = new Set<string>();
  function walk(n: FigmaNode): void {
    for (const fill of n.fills ?? []) {
      if (fill.imageRef) refs.add(fill.imageRef);
    }
    for (const child of n.children ?? []) {
      walk(child);
    }
  }
  walk(node);
  return refs;
}
