/**
 * Configuration file loader for d2c.
 *
 * Lookup order (first found wins):
 *   1. .d2crc.json  in the current working directory
 *   2. .d2crc.json  in the user's home directory
 *
 * The config file is optional — environment variables and CLI flags still
 * take precedence over values read from the file.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Provider name union reused from nodeLlmProvider
type ProviderName =
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

export interface D2CConfig {
  apiKeys?: Partial<Record<ProviderName, string>>;
  llm?: {
    provider?: ProviderName;
    model?: string;
    baseUrl?: string;
  };
  // Figma personal access token (or set FIGMA_TOKEN env var)
  figmaToken?: string;
  // Figma API base URL override (default: https://api.figma.com)
  figmaBaseUrl?: string;
}

// Resolve Figma API token: env var → config file.
export function resolveFigmaToken(config: D2CConfig): string | undefined {
  return process.env.FIGMA_TOKEN ?? config.figmaToken;
}

const CONFIG_FILENAME = '.d2crc.json';

function tryReadJson(filePath: string): D2CConfig | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as D2CConfig;
  } catch {
    return undefined;
  }
}

// Load the first config file found in CWD → HOME.
export function loadConfig(): D2CConfig {
  const candidates = [
    path.join(process.cwd(), CONFIG_FILENAME),
    path.join(os.homedir(), CONFIG_FILENAME),
  ];
  for (const p of candidates) {
    const cfg = tryReadJson(p);
    if (cfg) return cfg;
  }
  return {};
}

// Resolve an API key for a given provider.
// Priority: env var → config file.
export function resolveApiKey(
  provider: ProviderName,
  envVarName: string,
  config: D2CConfig,
): string | undefined {
  const fromEnv = envVarName ? process.env[envVarName] : undefined;
  if (fromEnv) return fromEnv;
  return config.apiKeys?.[provider];
}
