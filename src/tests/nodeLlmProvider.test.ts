import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveNodeLlmRuntimeConfig } from '../ai/nodeLlmProvider';

test('NodeLlmProvider: siliconflow maps to openai-compatible runtime config', () => {
  const runtime = resolveNodeLlmRuntimeConfig({
    provider: 'siliconflow',
    apiKey: 'sk-test',
    model: 'Pro/moonshotai/Kimi-K2.5',
  });

  assert.equal(runtime.effectiveProvider, 'openai');
  assert.equal(runtime.clientConfig.provider, 'openai');
  assert.equal(runtime.clientConfig.openaiApiKey, 'sk-test');
  assert.equal(runtime.clientConfig.openaiApiBase, 'https://api.siliconflow.cn/v1');
});

test('NodeLlmProvider: siliconflow respects explicit baseUrl override', () => {
  const runtime = resolveNodeLlmRuntimeConfig({
    provider: 'siliconflow',
    apiKey: 'sk-test',
    baseUrl: 'https://example.gateway/v1',
  });

  assert.equal(runtime.clientConfig.openaiApiBase, 'https://example.gateway/v1');
});