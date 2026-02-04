/**
 * OpenRouter Provider
 * Uses OpenAI-compatible API to access multiple models
 * https://openrouter.ai/docs
 */

import { BaseProvider, ProviderConfigError, ProviderAPIError } from './base.js';
import type { ChatMessage, ChatOptions, StreamChunk, Provider } from '../core/types.js';

interface OpenRouterConfig {
  apiKey?: string;
  model?: string;
  siteUrl?: string;
  siteName?: string;
}

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
}

export class OpenRouterProvider extends BaseProvider {
  name: Provider = 'openrouter';
  private openRouterApiKey: string;
  private siteUrl: string;
  private siteName: string;

  constructor(config: OpenRouterConfig = {}) {
    const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || '';
    super({
      apiKey,
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: config.model || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5',
    });
    
    this.openRouterApiKey = apiKey;
    this.siteUrl = config.siteUrl || process.env.OPENROUTER_SITE_URL || 'http://localhost:3000';
    this.siteName = config.siteName || process.env.OPENROUTER_SITE_NAME || 'Bot Consensus';
  }

  async isAvailable(): Promise<boolean> {
    if (!this.openRouterApiKey) {
      return false;
    }
    
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${this.openRouterApiKey}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch available models from OpenRouter
   */
  async getAvailableModels(): Promise<OpenRouterModel[]> {
    if (!this.openRouterApiKey) {
      return [];
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${this.openRouterApiKey}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { data: OpenRouterModel[] };
      return data.data || [];
    } catch {
      return [];
    }
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    if (!this.openRouterApiKey) {
      throw new ProviderConfigError('OpenRouter', 'API key not configured. Set OPENROUTER_API_KEY.');
    }

    const model = this.defaultModel;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.siteUrl,
        'X-Title': this.siteName,
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature ?? 0.7,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ProviderAPIError('OpenRouter', `${response.status} - ${error}`, response.status);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
    };

    return data.choices[0]?.message?.content || '';
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    if (!this.openRouterApiKey) {
      throw new ProviderConfigError('OpenRouter', 'API key not configured. Set OPENROUTER_API_KEY.');
    }

    const model = this.defaultModel;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.siteUrl,
        'X-Title': this.siteName,
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature ?? 0.7,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ProviderAPIError('OpenRouter', `${response.status} - ${error}`, response.status);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new ProviderAPIError('OpenRouter', 'No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let hasEmittedDone = false; // Track if we've already emitted done

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Only emit done once
          if (!hasEmittedDone) {
            hasEmittedDone = true;
            yield { content: '', done: true };
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              // Only emit done once
              if (!hasEmittedDone) {
                hasEmittedDone = true;
                yield { content: '', done: true };
              }
              continue;
            }

            try {
              const parsed = JSON.parse(data) as {
                choices: { delta: { content?: string }; finish_reason?: string }[];
              };
              const content = parsed.choices[0]?.delta?.content || '';
              const isDone = parsed.choices[0]?.finish_reason !== null && parsed.choices[0]?.finish_reason !== undefined;
              
              if (content) {
                yield { content, done: false };
              }
              
              // If finish_reason is set, emit done only once
              if (isDone && !hasEmittedDone) {
                hasEmittedDone = true;
                yield { content: '', done: true };
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Popular OpenRouter models for quick selection (Updated Feb 2026)
 * Based on OpenRouter leaderboard: https://openrouter.ai/rankings
 */
export const OPENROUTER_POPULAR_MODELS = [
  // === TOP 10 from Leaderboard ===
  'anthropic/claude-4.5-sonnet-20250929',  // #1 - Claude Sonnet 4.5
  'google/gemini-3-flash-preview-20251217', // #2 - Gemini 3 Flash Preview
  'deepseek/deepseek-v3.2-20251201',       // #3 - Deepseek V3.2
  'moonshotai/kimi-k2.5-0127',             // #4 - Kimi K2.5 (NEW)
  'google/gemini-2.5-flash',               // #5 - Gemini 2.5 Flash
  'x-ai/grok-code-fast-1',                 // #6 - Grok Code Fast 1
  'anthropic/claude-4.5-opus-20251124',    // #7 - Claude Opus 4.5
  'x-ai/grok-4.1-fast',                    // #8 - Grok 4.1 Fast
  'google/gemini-2.5-flash-lite',          // #9 - Gemini 2.5 Flash Lite
  'openai/gpt-oss-120b',                   // #10 - GPT-OSS 120B
  
  // === Anthropic Claude ===
  'anthropic/claude-4.5-sonnet',
  'anthropic/claude-4.5-opus',
  'anthropic/claude-4.5-haiku',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-opus-4',
  
  // === OpenAI ===
  'openai/gpt-5.2',
  'openai/gpt-5.2-pro',
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'openai/o3',
  'openai/o3-mini',
  'openai/o1',
  'openai/o1-mini',
  'openai/gpt-4.1',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  
  // === Google Gemini ===
  'google/gemini-3-pro',
  'google/gemini-3-flash',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-pro-preview',
  'google/gemini-2.0-flash-exp',
  
  // === xAI Grok ===
  'x-ai/grok-4.1',
  'x-ai/grok-4',
  'x-ai/grok-3',
  'x-ai/grok-3-fast',
  'x-ai/grok-2',
  
  // === DeepSeek ===
  'deepseek/deepseek-r1',
  'deepseek/deepseek-r1-lite',
  'deepseek/deepseek-v3',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-coder',
  
  // === Moonshot Kimi ===
  'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2',
  'moonshotai/kimi-vl',
  
  // === Meta Llama ===
  'meta-llama/llama-4-maverick-405b',
  'meta-llama/llama-4-scout-70b',
  'meta-llama/llama-3.3-70b-instruct',
  'meta-llama/llama-3.1-405b-instruct',
  'meta-llama/llama-3.1-70b-instruct',
  
  // === Mistral ===
  'mistralai/mistral-large-2',
  'mistralai/mistral-medium-3',
  'mistralai/pixtral-large',
  'mistralai/codestral-latest',
  'mistralai/mixtral-8x22b-instruct',
  
  // === Qwen ===
  'qwen/qwen-3-235b-instruct',
  'qwen/qwen-3-72b-instruct',
  'qwen/qwen-2.5-coder-32b-instruct',
  'qwen/qwq-32b-preview',
  
  // === Cohere ===
  'cohere/command-r-plus-08-2024',
  'cohere/command-r-08-2024',
  'cohere/command-a',
  
  // === Perplexity ===
  'perplexity/sonar-pro',
  'perplexity/sonar',
  
  // === Free/Budget models ===
  'meta-llama/llama-3.1-8b-instruct:free',
  'google/gemma-2-9b-it:free',
  'mistralai/mistral-7b-instruct:free',
  'deepseek/deepseek-v3:free',
];
