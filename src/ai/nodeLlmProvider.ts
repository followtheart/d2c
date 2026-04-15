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
  | 'zhipuai';

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
};

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

        const isZhipuai = this.config.provider === 'zhipuai';
        const effectiveProvider = isZhipuai ? 'openai' : this.config.provider;

        const cfg: Record<string, unknown> = {
          provider: effectiveProvider,
        };
        if (isZhipuai) {
          if (this.config.apiKey) {
            cfg['openaiApiKey'] = this.config.apiKey;
          }
          cfg['openaiApiBase'] = this.config.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4';
        } else {
          const keyField = API_KEY_FIELDS[this.config.provider];
          if (keyField && this.config.apiKey) {
            cfg[keyField] = this.config.apiKey;
          }
          if (this.config.baseUrl) {
            cfg[API_BASE_FIELDS[this.config.provider]] = this.config.baseUrl;
          }
        }
        return mod.createLLM(cfg);
      })();
    }
    return this.llmPromise;
  }

  async annotate(tree: IRNode): Promise<Record<string, Semantics>> {
    const llm = await this.getLLM();
    const model = this.config.model ?? DEFAULT_MODELS[this.config.provider];

    const userPrompt =
      'Analyze this IR tree and return semantic annotations as JSON.\n\n' +
      JSON.stringify(stripHeavy(tree), null, 2);

    let responseText: string;
    try {
      const chat = llm
        .chat(model)
        .withSystemPrompt(SYSTEM_PROMPT)
        .withTemperature(this.config.temperature ?? 0);
      const res = await chat.ask(userPrompt, {
        maxTokens: this.config.maxTokens ?? 4096,
        requestTimeout: this.config.requestTimeout ?? 60_000,
      });
      // ChatResponseString extends String — `.toString()` always works.
      responseText = res?.content ?? res?.toString() ?? '';
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
