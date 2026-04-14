/**
 * Vision Provider — multimodal LLM image analysis.
 *
 * Supports two backends:
 *   1. **OpenRouter** (default) — OpenAI-compatible chat/completions API
 *      with image_url content blocks (base64 data URIs).
 *   2. **Anthropic** — Anthropic Messages API with native image blocks.
 *
 * Both use Node 22's built-in `fetch` — zero external deps.
 *
 * Usage:
 *   const vision = new VisionProvider({ provider: 'openrouter', apiKey: '...' });
 *   const analysis = await vision.analyzeImages(
 *     [{ stage: 'parse', data: pngBuffer }, { stage: 'layout', data: pngBuffer }],
 *     'Compare these two pipeline stage screenshots and describe differences.',
 *   );
 */

// ── Types ─────────────────────────────────────────────────────────────

export type VisionBackend = 'openrouter' | 'anthropic';

export interface VisionProviderConfig {
  provider: VisionBackend;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ImageInput {
  stage: string;
  data: Buffer;
}

export interface StageAnalysis {
  visualDiff: string;
  infoGain: string;
  dataLoss: string;
  qualityScore: number;
  raw?: string;
}

// ── Default models ────────────────────────────────────────────────────

const DEFAULT_MODELS: Record<VisionBackend, string> = {
  openrouter: 'openai/gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
};

const DEFAULT_ENDPOINTS: Record<VisionBackend, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

// ── VisionProvider ────────────────────────────────────────────────────

export class VisionProvider {
  private readonly config: Required<
    Pick<VisionProviderConfig, 'provider' | 'apiKey' | 'model' | 'maxTokens' | 'temperature'>
  > & { baseUrl: string };

  constructor(cfg: VisionProviderConfig) {
    if (!cfg.apiKey) {
      throw new Error('VisionProvider requires an apiKey');
    }
    this.config = {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      model: cfg.model ?? DEFAULT_MODELS[cfg.provider],
      baseUrl: cfg.baseUrl ?? DEFAULT_ENDPOINTS[cfg.provider],
      maxTokens: cfg.maxTokens ?? 4096,
      temperature: cfg.temperature ?? 0,
    };
  }

  /**
   * Send one or more images plus a text prompt to the multimodal LLM
   * and return a parsed `StageAnalysis`.
   */
  async analyzeImages(
    images: ImageInput[],
    prompt: string,
  ): Promise<StageAnalysis> {
    const responseText =
      this.config.provider === 'anthropic'
        ? await this.callAnthropic(images, prompt)
        : await this.callOpenRouter(images, prompt);

    return parseAnalysis(responseText);
  }

  // ── OpenRouter / OpenAI-compatible ──────────────────────────────────

  private async callOpenRouter(
    images: ImageInput[],
    prompt: string,
  ): Promise<string> {
    const content: unknown[] = [];

    for (const img of images) {
      content.push({
        type: 'text',
        text: `[Stage: ${img.stage}]`,
      });
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${img.data.toString('base64')}`,
        },
      });
    }

    content.push({ type: 'text', text: prompt });

    const res = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? '';
  }

  // ── Anthropic Messages API ─────────────────────────────────────────

  private async callAnthropic(
    images: ImageInput[],
    prompt: string,
  ): Promise<string> {
    const content: unknown[] = [];

    for (const img of images) {
      content.push({
        type: 'text',
        text: `[Stage: ${img.stage}]`,
      });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: img.data.toString('base64'),
        },
      });
    }

    content.push({ type: 'text', text: prompt });

    const res = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return json.content?.find((c) => c.type === 'text')?.text ?? '';
  }
}

// ── Response parsing ──────────────────────────────────────────────────

const ANALYSIS_PROMPT_SUFFIX = `

Respond in **strict JSON** with this structure — no extra text before or after:
{
  "visualDiff": "<describe visual differences>",
  "infoGain": "<describe what information was added in the second stage>",
  "dataLoss": "<describe any data loss or distortion, or 'none'>",
  "qualityScore": <integer 1-10>
}`;

/**
 * Build the comparison prompt for a pair of stages.
 */
export function buildPairPrompt(from: string, to: string): string {
  return (
    `You are a design-to-code pipeline quality analyst.\n\n` +
    `You are shown two screenshots from adjacent pipeline stages:\n` +
    `  1. **${from}** — the earlier stage\n` +
    `  2. **${to}** — the later stage\n\n` +
    `Analyze the visual evolution between these two stages:\n` +
    `  a) Describe the visual differences you see.\n` +
    `  b) What information was *added* or *enhanced* in the second stage?\n` +
    `  c) Was any information *lost* or *distorted*?\n` +
    `  d) Rate the quality of this transition on a 1-10 scale ` +
    `(10 = perfect preservation + meaningful enrichment).` +
    ANALYSIS_PROMPT_SUFFIX
  );
}

/**
 * Build the overall comparison prompt (first vs last stage).
 */
export function buildOverallPrompt(from: string, to: string): string {
  return (
    `You are a design-to-code pipeline quality analyst.\n\n` +
    `You are shown two screenshots from the *first* and *last* stages of the pipeline:\n` +
    `  1. **${from}** — the initial input representation\n` +
    `  2. **${to}** — the final code output preview\n\n` +
    `Evaluate the overall pipeline fidelity:\n` +
    `  a) How well does the final output preserve the original design intent?\n` +
    `  b) What key information was enriched through the pipeline?\n` +
    `  c) What was lost or distorted during the full pipeline run?\n` +
    `  d) Rate the overall pipeline quality on a 1-10 scale.` +
    ANALYSIS_PROMPT_SUFFIX
  );
}

function parseAnalysis(text: string): StageAnalysis {
  const jsonStr = extractJson(text);
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      visualDiff: String(obj.visualDiff ?? ''),
      infoGain: String(obj.infoGain ?? ''),
      dataLoss: String(obj.dataLoss ?? 'none'),
      qualityScore: clampScore(obj.qualityScore),
      raw: text,
    };
  } catch {
    return {
      visualDiff: text,
      infoGain: '',
      dataLoss: '',
      qualityScore: 0,
      raw: text,
    };
  }
}

function extractJson(s: string): string {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return '{}';
  return s.slice(start, end + 1);
}

function clampScore(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (isNaN(n)) return 0;
  return Math.max(1, Math.min(10, n));
}
