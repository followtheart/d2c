/**
 * Optional Claude-backed LLM provider for semantic enhancement.
 *
 * Usage:
 *   import { ClaudeProvider } from './claudeProvider';
 *   const llm = new ClaudeProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
 *   const enhanced = await enhance(tree, { llm });
 *
 * Zero external deps: uses Node 22's built-in fetch.
 */
import type { IRNode, Semantics } from '../ir/types';
import type { LLMProvider } from './semanticEnhancer';

interface ClaudeProviderConfig {
  apiKey: string;
  model?: string;
  endpoint?: string;
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

export class ClaudeProvider implements LLMProvider {
  constructor(private config: ClaudeProviderConfig) {
    if (!config.apiKey) throw new Error('ClaudeProvider requires apiKey');
  }

  async annotate(tree: IRNode): Promise<Record<string, Semantics>> {
    const endpoint = this.config.endpoint ?? 'https://api.anthropic.com/v1/messages';
    const model = this.config.model ?? 'claude-opus-4-6';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Analyze this IR tree and return semantic annotations as JSON.\n\n' +
                  JSON.stringify(stripHeavy(tree), null, 2),
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Claude API error ${res.status}: ${text}`);
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const textBlock = json.content?.find((c) => c.type === 'text')?.text ?? '{}';
    try {
      return JSON.parse(extractJson(textBlock));
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
