/**
 * Provider configuration and API key management
 * Supports extracting keys from Claude Code CLI and OpenAI Codex CLI
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { Provider } from '../core/types.js';

export interface ProviderCredentials {
  provider: Provider;
  apiKey?: string;
  baseUrl?: string;
  models: string[];
  defaultModel: string;
  isConfigured: boolean;
  source?: 'manual' | 'env' | 'claude-cli' | 'openai-cli' | 'local';
}

export interface ProvidersConfig {
  providers: Record<Provider, ProviderCredentials>;
  defaultProvider: Provider;
  defaultModel: string;
}

const CONFIG_DIR = join(homedir(), '.config', 'bot-consensus');
const CONFIG_FILE = join(CONFIG_DIR, 'providers.json');

/**
 * Default provider configurations
 */
const DEFAULT_PROVIDER_CONFIG: Record<Provider, Omit<ProviderCredentials, 'isConfigured' | 'source'>> = {
  openai: {
    provider: 'openai',
    models: ['gpt-5.2', 'gpt-5.2-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
    defaultModel: 'gpt-5.2',
  },
  anthropic: {
    provider: 'anthropic',
    models: ['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
    defaultModel: 'claude-sonnet-4-5-20250929',
  },
  google: {
    provider: 'google',
    models: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-1.5-pro'],
    defaultModel: 'gemini-3-pro-preview',
  },
  ollama: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    models: ['llama3.3', 'llama3.3:70b', 'qwen2.5-coder', 'deepseek-r1', 'mistral', 'mixtral'],
    defaultModel: 'llama3.3',
  },
  lmstudio: {
    provider: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    models: ['qwen/qwen3-coder-30b', 'local-model'],
    defaultModel: 'qwen/qwen3-coder-30b',
  },
  openrouter: {
    provider: 'openrouter',
    models: [
      // === TOP 10 from Leaderboard (Feb 2026) ===
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
    ],
    defaultModel: 'anthropic/claude-4.5-sonnet-20250929',
  },
};

/**
 * Try to extract API key from Claude Code CLI config
 */
async function extractClaudeCliKey(): Promise<string | null> {
  const possiblePaths = [
    join(homedir(), '.claude', 'config.json'),
    join(homedir(), '.config', 'claude', 'config.json'),
    join(homedir(), '.claude.json'),
  ];

  for (const configPath of possiblePaths) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const config = JSON.parse(content);
      
      // Try various possible key locations
      const key = config.apiKey || 
                  config.api_key || 
                  config.anthropic?.apiKey ||
                  config.anthropic?.api_key ||
                  config.ANTHROPIC_API_KEY;
      
      if (key && typeof key === 'string' && key.startsWith('sk-ant-')) {
        return key;
      }
    } catch {
      // File doesn't exist or invalid, try next
    }
  }

  return null;
}

/**
 * Try to extract API key from OpenAI Codex CLI / OpenAI CLI config
 */
async function extractOpenAICliKey(): Promise<string | null> {
  const possiblePaths = [
    join(homedir(), '.openai', 'config.json'),
    join(homedir(), '.config', 'openai', 'config.json'),
    join(homedir(), '.openai.json'),
    join(homedir(), '.codex', 'config.json'),
    join(homedir(), '.config', 'codex', 'config.json'),
  ];

  for (const configPath of possiblePaths) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const config = JSON.parse(content);
      
      const key = config.apiKey || 
                  config.api_key || 
                  config.openai?.apiKey ||
                  config.openai?.api_key ||
                  config.OPENAI_API_KEY;
      
      if (key && typeof key === 'string' && key.startsWith('sk-')) {
        return key;
      }
    } catch {
      // File doesn't exist or invalid, try next
    }
  }

  return null;
}

/**
 * Check if Ollama is running locally
 */
async function checkOllamaAvailable(baseUrl: string = 'http://localhost:11434'): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { 
      signal: AbortSignal.timeout(2000) 
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get available Ollama models
 */
async function getOllamaModels(baseUrl: string = 'http://localhost:11434'): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return [];
    const data = await response.json() as { models: { name: string }[] };
    return data.models?.map(m => m.name) || [];
  } catch {
    return [];
  }
}

/**
 * Check if LM Studio is running locally
 */
async function checkLMStudioAvailable(baseUrl: string = 'http://localhost:1234'): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get available LM Studio models
 */
async function getLMStudioModels(baseUrl: string = 'http://localhost:1234'): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return [];
    const data = await response.json() as { data: { id: string }[] };
    return data.data?.map(m => m.id) || [];
  } catch {
    return [];
  }
}

/**
 * Check if OpenRouter API key is valid
 */
async function checkOpenRouterAvailable(apiKey: string): Promise<boolean> {
  if (!apiKey) return false;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get available OpenRouter models
 */
async function getOpenRouterModels(apiKey: string): Promise<string[]> {
  if (!apiKey) return [];
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return DEFAULT_PROVIDER_CONFIG.openrouter.models;
    const data = await response.json() as { data: { id: string }[] };
    const apiModels = new Set(data.data?.map(m => m.id) || []);
    
    // Start with curated models (these are always first, in order)
    const curatedModels = DEFAULT_PROVIDER_CONFIG.openrouter.models;
    
    // Filter curated models to only include those available in API
    const availableCurated = curatedModels.filter(m => apiModels.has(m));
    
    // Filter API models to popular providers not already in curated
    const popularPrefixes = [
      'anthropic/', 'openai/', 'google/', 'x-ai/',
      'deepseek/', 'moonshotai/', 'meta-llama/', 'mistralai/', 
      'qwen/', 'cohere/', 'perplexity/'
    ];
    const curatedSet = new Set(availableCurated);
    const additionalFromApi = [...apiModels]
      .filter(m => !curatedSet.has(m))
      .filter(m => popularPrefixes.some(p => m.startsWith(p)));
    
    // Combine: curated first (preserving order), then additional from API
    const result = [...availableCurated, ...additionalFromApi];
    
    return result.slice(0, 120); // Limit to 120 models
  } catch {
    return DEFAULT_PROVIDER_CONFIG.openrouter.models;
  }
}

/**
 * Detect all available providers and their configurations
 */
export async function detectProviders(): Promise<ProvidersConfig> {
  const providers: Record<Provider, ProviderCredentials> = {} as any;

  // OpenAI
  const openaiKey = process.env.OPENAI_API_KEY || await extractOpenAICliKey();
  providers.openai = {
    ...DEFAULT_PROVIDER_CONFIG.openai,
    apiKey: openaiKey || undefined,
    isConfigured: !!openaiKey,
    source: process.env.OPENAI_API_KEY ? 'env' : openaiKey ? 'openai-cli' : undefined,
  };

  // Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY || await extractClaudeCliKey();
  providers.anthropic = {
    ...DEFAULT_PROVIDER_CONFIG.anthropic,
    apiKey: anthropicKey || undefined,
    isConfigured: !!anthropicKey,
    source: process.env.ANTHROPIC_API_KEY ? 'env' : anthropicKey ? 'claude-cli' : undefined,
  };

  // Google
  const googleKey = process.env.GOOGLE_API_KEY;
  providers.google = {
    ...DEFAULT_PROVIDER_CONFIG.google,
    apiKey: googleKey || undefined,
    isConfigured: !!googleKey,
    source: googleKey ? 'env' : undefined,
  };

  // Ollama
  const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const ollamaAvailable = await checkOllamaAvailable(ollamaUrl);
  const ollamaModels = ollamaAvailable ? await getOllamaModels(ollamaUrl) : [];
  providers.ollama = {
    ...DEFAULT_PROVIDER_CONFIG.ollama,
    baseUrl: ollamaUrl,
    models: ollamaModels.length > 0 ? ollamaModels : DEFAULT_PROVIDER_CONFIG.ollama.models,
    defaultModel: ollamaModels[0] || DEFAULT_PROVIDER_CONFIG.ollama.defaultModel,
    isConfigured: ollamaAvailable,
    source: ollamaAvailable ? 'local' : undefined,
  };

  // LM Studio
  const lmstudioUrl = process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234';
  const lmstudioAvailable = await checkLMStudioAvailable(lmstudioUrl);
  const lmstudioModels = lmstudioAvailable ? await getLMStudioModels(lmstudioUrl) : [];
  providers.lmstudio = {
    ...DEFAULT_PROVIDER_CONFIG.lmstudio,
    baseUrl: lmstudioUrl,
    models: lmstudioModels.length > 0 ? lmstudioModels : DEFAULT_PROVIDER_CONFIG.lmstudio.models,
    defaultModel: lmstudioModels[0] || DEFAULT_PROVIDER_CONFIG.lmstudio.defaultModel,
    isConfigured: lmstudioAvailable,
    source: lmstudioAvailable ? 'local' : undefined,
  };

  // OpenRouter
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const openrouterAvailable = openrouterKey ? await checkOpenRouterAvailable(openrouterKey) : false;
  const openrouterModels = openrouterAvailable ? await getOpenRouterModels(openrouterKey!) : [];
  providers.openrouter = {
    ...DEFAULT_PROVIDER_CONFIG.openrouter,
    apiKey: openrouterKey || undefined,
    models: openrouterModels.length > 0 ? openrouterModels : DEFAULT_PROVIDER_CONFIG.openrouter.models,
    defaultModel: DEFAULT_PROVIDER_CONFIG.openrouter.defaultModel,
    isConfigured: openrouterAvailable,
    source: openrouterKey ? 'env' : undefined,
  };

  // Determine default provider
  let defaultProvider: Provider = 'lmstudio';
  if (providers.lmstudio.isConfigured) {
    defaultProvider = 'lmstudio';
  } else if (providers.ollama.isConfigured) {
    defaultProvider = 'ollama';
  } else if (providers.openrouter.isConfigured) {
    defaultProvider = 'openrouter';
  } else if (providers.anthropic.isConfigured) {
    defaultProvider = 'anthropic';
  } else if (providers.openai.isConfigured) {
    defaultProvider = 'openai';
  } else if (providers.google.isConfigured) {
    defaultProvider = 'google';
  }

  return {
    providers,
    defaultProvider,
    defaultModel: providers[defaultProvider].defaultModel,
  };
}

/**
 * Save provider configuration
 */
export async function saveProvidersConfig(config: ProvidersConfig): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    
    // Don't save API keys to file for security - just save preferences
    const safeConfig = {
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
      providerPreferences: Object.fromEntries(
        Object.entries(config.providers).map(([key, value]) => [
          key,
          {
            defaultModel: value.defaultModel,
            baseUrl: value.baseUrl,
          },
        ])
      ),
    };
    
    await writeFile(CONFIG_FILE, JSON.stringify(safeConfig, null, 2), 'utf-8');
  } catch (error) {
    // Silently fail if we can't save config
    console.error('Warning: Could not save provider config:', error);
  }
}

/**
 * Load saved provider preferences and merge with detected config
 */
export async function loadProvidersConfig(): Promise<ProvidersConfig> {
  const detected = await detectProviders();
  
  try {
    const content = await readFile(CONFIG_FILE, 'utf-8');
    const saved = JSON.parse(content);
    
    // Merge saved preferences with detected config
    if (saved.defaultProvider && detected.providers[saved.defaultProvider as Provider]?.isConfigured) {
      detected.defaultProvider = saved.defaultProvider;
    }
    if (saved.defaultModel) {
      detected.defaultModel = saved.defaultModel;
    }
    
    // Merge provider-specific preferences
    if (saved.providerPreferences) {
      for (const [key, prefs] of Object.entries(saved.providerPreferences)) {
        const provider = key as Provider;
        if (detected.providers[provider]) {
          if ((prefs as any).defaultModel) {
            detected.providers[provider].defaultModel = (prefs as any).defaultModel;
          }
          if ((prefs as any).baseUrl) {
            detected.providers[provider].baseUrl = (prefs as any).baseUrl;
          }
        }
      }
    }
  } catch {
    // No saved config, use detected
  }
  
  return detected;
}

/**
 * Update a provider's API key
 */
export function updateProviderKey(
  config: ProvidersConfig,
  provider: Provider,
  apiKey: string
): ProvidersConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      [provider]: {
        ...config.providers[provider],
        apiKey,
        isConfigured: true,
        source: 'manual',
      },
    },
  };
}

/**
 * Update a provider's base URL (for local providers)
 */
export function updateProviderBaseUrl(
  config: ProvidersConfig,
  provider: Provider,
  baseUrl: string
): ProvidersConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      [provider]: {
        ...config.providers[provider],
        baseUrl,
      },
    },
  };
}

/**
 * Get list of configured providers
 */
export function getConfiguredProviders(config: ProvidersConfig): ProviderCredentials[] {
  return Object.values(config.providers).filter(p => p.isConfigured);
}

/**
 * Get provider display info
 */
export function getProviderDisplayName(provider: Provider): string {
  const names: Record<Provider, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic (Claude)',
    google: 'Google (Gemini)',
    ollama: 'Ollama (Local)',
    lmstudio: 'LM Studio (Local)',
    openrouter: 'OpenRouter',
  };
  return names[provider];
}

/**
 * Get source display text
 */
export function getSourceDisplayText(source?: string): string {
  switch (source) {
    case 'env': return 'from environment variable';
    case 'claude-cli': return 'from Claude CLI';
    case 'openai-cli': return 'from OpenAI CLI';
    case 'local': return 'running locally';
    case 'manual': return 'manually configured';
    default: return 'not configured';
  }
}
