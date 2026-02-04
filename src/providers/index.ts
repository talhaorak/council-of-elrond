import type { LLMProvider, Provider } from '../core/types.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { LMStudioProvider } from './lmstudio.js';
import { OpenRouterProvider } from './openrouter.js';

export { BaseProvider, ProviderConfigError, ProviderAPIError } from './base.js';
export { OpenAIProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { GoogleProvider } from './google.js';
export { OllamaProvider } from './ollama.js';
export { LMStudioProvider } from './lmstudio.js';
export { OpenRouterProvider, OPENROUTER_POPULAR_MODELS } from './openrouter.js';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * Factory function to create a provider instance
 */
export function createProvider(
  provider: Provider,
  config: ProviderConfig = {}
): LLMProvider {
  switch (provider) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'google':
      return new GoogleProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'lmstudio':
      return new LMStudioProvider(config);
    case 'openrouter':
      return new OpenRouterProvider(config);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Check which providers are available
 */
export async function checkAvailableProviders(): Promise<{
  provider: Provider;
  available: boolean;
  error?: string;
}[]> {
  const results: { provider: Provider; available: boolean; error?: string }[] = [];
  
  const providers: { name: Provider; factory: () => LLMProvider }[] = [
    { 
      name: 'openai', 
      factory: () => new OpenAIProvider() 
    },
    { 
      name: 'anthropic', 
      factory: () => new AnthropicProvider() 
    },
    { 
      name: 'google', 
      factory: () => new GoogleProvider() 
    },
    { 
      name: 'ollama', 
      factory: () => new OllamaProvider() 
    },
    { 
      name: 'lmstudio', 
      factory: () => new LMStudioProvider() 
    },
    { 
      name: 'openrouter', 
      factory: () => new OpenRouterProvider() 
    },
  ];

  for (const { name, factory } of providers) {
    try {
      const provider = factory();
      const available = await provider.isAvailable();
      results.push({ provider: name, available });
    } catch (error) {
      results.push({
        provider: name,
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}

/**
 * Get default provider based on available environment variables
 */
export function getDefaultProvider(): Provider {
  if (process.env.DEFAULT_PROVIDER) {
    return process.env.DEFAULT_PROVIDER as Provider;
  }
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GOOGLE_API_KEY) return 'google';
  return 'lmstudio'; // Default to LM Studio local
}

/**
 * Get default model for a provider
 */
export function getDefaultModel(provider: Provider): string {
  if (process.env.DEFAULT_MODEL) {
    return process.env.DEFAULT_MODEL;
  }
  
  switch (provider) {
    case 'openai':
      return 'gpt-5.2';
    case 'anthropic':
      return 'claude-sonnet-4-5-20250929';
    case 'google':
      return 'gemini-3-pro-preview';
    case 'ollama':
      return 'llama3.3';
    case 'lmstudio':
      return 'qwen/qwen3-coder-30b';
    case 'openrouter':
      return 'anthropic/claude-sonnet-4.5';
    default:
      return 'qwen/qwen3-coder-30b';
  }
}
