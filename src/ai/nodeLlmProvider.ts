/**
 * Optional `@node-llm/core`-backed LLM provider for semantic enhancement.
 *
 * `@node-llm/core` is a provider-agnostic LLM engine for Node.js that exposes
 * a single API across OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Ollama,
 * Mistral, xAI and Bedrock — so d2c users can plug in any of those providers
 * without writing a custom adapter.
 *
 * Usage:
 *   import { NodeLlmProvider } from 'd2c';
 *
 *   // OpenRouter (540+ models)
 *   const llm = new NodeLlmProvider({
 *     provider: 'openrouter',
 *     model: 'anthropic/claude-3.5-sonnet',
 *     apiKey: process.env.OPENROUTER_API_KEY!,
 *   });
 *
 *   // DeepSeek
 *   const llm = new NodeLlmProvider({
 *     provider: 'deepseek',
 *     model: 'deepseek-chat',
 *     apiKey: process.env.DEEPSEEK_API_KEY!,
 *   });
 *
 *   const enhanced = await enhance(tree, { llm });
 *
 * The `@node-llm/core` package is an *optional* peer dependency — install it
 * only if you actually want to use this provider:
 *
 *   npm install @node-llm/core
 */
import type { IRNode, Semantics } from '../ir/types';
import type { LLMProvider } from './semanticEnhancer';

/** Subset of providers supported by @node-llm/core that we surface here. */
export type NodeLlmProviderName =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'openrouter'
  | 'ollama'
  | 'mistral'
  | 'xai'
  | 'bedrock'
  | 'zhipuai'
  | 'siliconflow'
  | 'dashscope';

export interface NodeLlmProviderConfig {
  /** Which underlying provider @node-llm/core should route through. */
  provider: NodeLlmProviderName;
  /** Model id (provider-specific, e.g. `deepseek-chat`, `openai/gpt-4o-mini`). */
  model?: string;
  /** API key for the chosen provider (falls back to provider env var). */
  apiKey?: string;
  /** Optional base URL override (e.g. for self-hosted gateways or Ollama). */
  baseUrl?: string;
  /** Sampling temperature for the semantic-annotation call. Defaults to 0. */
  temperature?: number;
  /** Per-request timeout in milliseconds. Defaults to 60_000. */
  requestTimeout?: number;
  /** Cap output tokens. Defaults to 4096. */
  maxTokens?: number;
}

const SYSTEM_PROMPT = `You are a senior frontend engineer acting as a design-to-code semantic analyzer.

You will receive a JSON tree representing a UI design. Each node has an id, type, box, style, children, and optionally text.

Your task: return a JSON object whose keys are node ids and whose values are partial Semantics objects:

{
  "<nodeId>": {
    "role": "header" | "nav" | "footer" | "main" | "aside" | "section" | "card" | "form" | "list" | "list-item" | "button" | "link" | "heading" | "paragraph" | "label" | "icon" | "avatar" | "badge" | "divider",
    "interactive": true | false,
    "componentName": "<PascalCase>",
    "dataBinding": "<optional dot path e.g. user.name>",
    "ariaLabel": "<optional>"
  }
}

Only include nodes where you can add useful semantic information beyond what the type already conveys. Output strictly valid JSON with no commentary.`;

const DEFAULT_MODELS: Record<NodeLlmProviderName, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
  gemini: 'gemini-1.5-flash',
  deepseek: 'deepseek-chat',
  openrouter: 'openai/gpt-4o-mini',
  ollama: 'llama3.1',
  mistral: 'mistral-small-latest',
  xai: 'grok-2-latest',
  bedrock: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
  zhipuai: 'glm-5-turbo',
  siliconflow: 'Qwen/Qwen2.5-7B-Instruct',
  dashscope: 'qwen3.6-plus',
};

const DIRECT_OPENAI_COMPATIBLE_PROVIDERS = new Set<NodeLlmProviderName>([
  'siliconflow',
]);

const DEFAULT_REQUEST_TIMEOUT_MS: Record<NodeLlmProviderName, number> = {
  openai: 60_000,
  anthropic: 60_000,
  gemini: 60_000,
  deepseek: 60_000,
  openrouter: 60_000,
  ollama: 60_000,
  mistral: 60_000,
  xai: 60_000,
  bedrock: 60_000,
  zhipuai: 60_000,
  siliconflow: 120_000,
  dashscope: 60_000,
};

const DEFAULT_MAX_TOKENS: Record<NodeLlmProviderName, number> = {
  openai: 4096,
  anthropic: 4096,
  gemini: 4096,
  deepseek: 4096,
  openrouter: 4096,
  ollama: 4096,
  mistral: 4096,
  xai: 4096,
  bedrock: 4096,
  zhipuai: 4096,
  siliconflow: 1024,
  dashscope: 4096,
};

const DIRECT_PROVIDER_MAX_RETRIES: Partial<Record<NodeLlmProviderName, number>> = {
  siliconflow: 2,
};

/**
 * `@node-llm/core` is published as ESM only, but d2c is built as CommonJS.
 * Use a Function-wrapped `import()` so TypeScript does not transpile it into
 * a `require(...)` (which would fail for ESM-only packages at runtime).
 */
const esmImport = new Function('m', 'return import(m)') as <T = unknown>(
  m: string,
) => Promise<T>;

interface NodeLlmCoreModule {
  createLLM: (options: Record<string, unknown>) => {
    chat: (model?: string) => {
      withSystemPrompt: (s: string) => {
        withTemperature: (t: number) => {
          ask: (
            content: string,
            options?: { maxTokens?: number; requestTimeout?: number },
          ) => Promise<{ toString(): string; content?: string }>;
        };
      };
    };
  };
}

/**
 * Map our provider name → the NodeLLMConfig key that holds its API key.
 */
const API_KEY_FIELDS: Record<NodeLlmProviderName, string | null> = {
  openai: 'openaiApiKey',
  anthropic: 'anthropicApiKey',
  gemini: 'geminiApiKey',
  deepseek: 'deepseekApiKey',
  openrouter: 'openrouterApiKey',
  ollama: null, // Ollama uses no API key.
  mistral: 'mistralApiKey',
  xai: 'xaiApiKey',
  bedrock: 'bedrockApiKey',
  zhipuai: 'zhipuaiApiKey',
  siliconflow: 'openaiApiKey',
  dashscope: 'openaiApiKey',
};

/**
 * Map provider name → the NodeLLMConfig key that overrides its base URL.
 */
const API_BASE_FIELDS: Record<NodeLlmProviderName, string> = {
  openai: 'openaiApiBase',
  anthropic: 'anthropicApiBase',
  gemini: 'geminiApiBase',
  deepseek: 'deepseekApiBase',
  openrouter: 'openrouterApiBase',
  ollama: 'ollamaApiBase',
  mistral: 'mistralApiBase',
  xai: 'xaiApiBase',
  bedrock: 'bedrockApiBase',
  zhipuai: 'zhipuaiApiBase',
  siliconflow: 'openaiApiBase',
  dashscope: 'openaiApiBase',
};

interface RuntimeProviderConfig {
  effectiveProvider: Exclude<NodeLlmProviderName, 'zhipuai' | 'siliconflow' | 'dashscope'> | 'openai';
  clientConfig: Record<string, unknown>;
}

export function resolveNodeLlmRuntimeConfig(
  config: NodeLlmProviderConfig,
): RuntimeProviderConfig {
  const isOpenAiCompatibleAlias =
    config.provider === 'zhipuai' || config.provider === 'siliconflow' || config.provider === 'dashscope';
  const effectiveProvider: RuntimeProviderConfig['effectiveProvider'] =
    isOpenAiCompatibleAlias
      ? 'openai'
      : (config.provider as Exclude<NodeLlmProviderName, 'zhipuai' | 'siliconflow' | 'dashscope'>);

  const clientConfig: Record<string, unknown> = {
    provider: effectiveProvider,
  };

  if (config.provider === 'zhipuai') {
    if (config.apiKey) {
      clientConfig['openaiApiKey'] = config.apiKey;
    }
    clientConfig['openaiApiBase'] =
      config.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4';
    return { effectiveProvider, clientConfig };
  }

  if (config.provider === 'siliconflow') {
    if (config.apiKey) {
      clientConfig['openaiApiKey'] = config.apiKey;
    }
    clientConfig['openaiApiBase'] =
      config.baseUrl ?? 'https://api.siliconflow.cn/v1';
    return { effectiveProvider, clientConfig };
  }

  if (config.provider === 'dashscope') {
    if (config.apiKey) {
      clientConfig['openaiApiKey'] = config.apiKey;
    }
    clientConfig['openaiApiBase'] =
      config.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    return { effectiveProvider, clientConfig };
  }

  const keyField = API_KEY_FIELDS[config.provider];
  if (keyField && config.apiKey) {
    clientConfig[keyField] = config.apiKey;
  }
  if (config.baseUrl) {
    clientConfig[API_BASE_FIELDS[config.provider]] = config.baseUrl;
  }
  return { effectiveProvider, clientConfig };
}

export class NodeLlmProvider implements LLMProvider {
  private llmPromise?: Promise<NodeLlmCoreModule['createLLM'] extends (
    o: infer _O,
  ) => infer R
    ? R
    : never>;

  constructor(private readonly config: NodeLlmProviderConfig) {
    if (!config.provider) {
      throw new Error('NodeLlmProvider requires `provider`');
    }
  }

  /** Lazily import `@node-llm/core` and build a singleton LLM instance. */
  private async getLLM(): Promise<{
    chat: (model?: string) => {
      withSystemPrompt: (s: string) => {
        withTemperature: (t: number) => {
          ask: (
            content: string,
            options?: { maxTokens?: number; requestTimeout?: number },
          ) => Promise<{ toString(): string; content?: string }>;
        };
      };
    };
  }> {
    if (!this.llmPromise) {
      this.llmPromise = (async () => {
        let mod: NodeLlmCoreModule;
        try {
          mod = await esmImport<NodeLlmCoreModule>('@node-llm/core');
        } catch (e) {
          throw new Error(
            "NodeLlmProvider requires the optional peer dependency '@node-llm/core'. " +
              "Install it with `npm install @node-llm/core`. Original error: " +
              ((e as Error).message ?? String(e)),
          );
        }

          const runtimeConfig = resolveNodeLlmRuntimeConfig(this.config);
          return mod.createLLM(runtimeConfig.clientConfig);
      })();
    }
    return this.llmPromise;
  }

  async annotate(tree: IRNode): Promise<Record<string, Semantics>> {
    const model = this.config.model ?? DEFAULT_MODELS[this.config.provider];

    const userPrompt =
      'Analyze this IR tree and return semantic annotations as JSON.\n\n' +
      JSON.stringify(stripHeavy(tree), null, 2);

    let responseText: string;
    try {
      if (DIRECT_OPENAI_COMPATIBLE_PROVIDERS.has(this.config.provider)) {
        responseText = await this.callDirectOpenAiCompatible(model, userPrompt);
      } else {
        const llm = await this.getLLM();
        const chat = llm
          .chat(model)
          .withSystemPrompt(SYSTEM_PROMPT)
          .withTemperature(this.config.temperature ?? 0);
        const res = await chat.ask(userPrompt, {
          maxTokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS[this.config.provider],
          requestTimeout:
            this.config.requestTimeout ??
            DEFAULT_REQUEST_TIMEOUT_MS[this.config.provider],
        });
        // ChatResponseString extends String — `.toString()` always works.
        responseText = res?.content ?? res?.toString() ?? '';
      }
    } catch (e) {
      throw new Error(
        `NodeLlmProvider (${this.config.provider}/${model}) request failed: ${
          (e as Error).message ?? String(e)
        }`,
      );
    }

    try {
      return JSON.parse(extractJson(responseText));
    } catch {
      return {};
    }
  }

  private async callDirectOpenAiCompatible(
    model: string,
    userPrompt: string,
  ): Promise<string> {
    const runtimeConfig = resolveNodeLlmRuntimeConfig(this.config);
    const baseUrl = String(runtimeConfig.clientConfig.openaiApiBase ?? '');
    const apiKey = String(runtimeConfig.clientConfig.openaiApiKey ?? '');
    if (!baseUrl || !apiKey) {
      throw new Error(
        `Missing OpenAI-compatible runtime config for ${this.config.provider}`,
      );
    }

    const timeoutMs =
      this.config.requestTimeout ??
      DEFAULT_REQUEST_TIMEOUT_MS[this.config.provider];
    const maxRetries = DIRECT_PROVIDER_MAX_RETRIES[this.config.provider] ?? 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: this.config.temperature ?? 0,
            max_tokens:
              this.config.maxTokens ?? DEFAULT_MAX_TOKENS[this.config.provider],
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          if (attempt < maxRetries && isRetryableStatus(res.status)) {
            await delay(backoffMs(attempt));
            continue;
          }
          throw new Error(`HTTP ${res.status}: ${text}`);
        }

        const json = (await res.json()) as {
          choices?: Array<{
            message?: { content?: string };
          }>;
        };
        return json.choices?.[0]?.message?.content ?? '';
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          if (attempt < maxRetries) {
            await delay(backoffMs(attempt));
            continue;
          }
          throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        if (attempt < maxRetries && isRetryableError(e)) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`Request timeout after ${timeoutMs}ms`);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  const message = (error as Error)?.message ?? '';
  return /timeout|econnreset|socket hang up|temporarily unavailable/i.test(message);
}

function backoffMs(attempt: number): number {
  return 1000 * Math.pow(2, attempt);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJson(s: string): string {
  // Grab the first {...} block if the model added prose.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return '{}';
  return s.slice(start, end + 1);
}

/** Remove large fields that inflate the prompt without adding semantic signal. */
function stripHeavy(node: IRNode): unknown {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    box: node.box,
    text: node.textStyle?.content,
    style: node.style,
    children: node.children.map(stripHeavy),
  };
}
