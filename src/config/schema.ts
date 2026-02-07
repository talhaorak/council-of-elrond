import { z } from 'zod';
import type { Provider, PersonalityArchetype, DiscussionAlgorithmName } from '../core/types.js';

/**
 * All valid providers
 */
export const VALID_PROVIDERS: Provider[] = [
  'openai',
  'anthropic',
  'google',
  'ollama',
  'lmstudio',
  'openrouter',
];

/**
 * All built-in personality archetypes
 */
export const VALID_ARCHETYPES: PersonalityArchetype[] = [
  'skeptic',
  'optimist',
  'pessimist',
  'pragmatist',
  'innovator',
  'devils-advocate',
  'analyst',
  'mediator',
];

/**
 * All supported discussion algorithms
 */
export const VALID_ALGORITHMS: DiscussionAlgorithmName[] = [
  'sequential',
  'parallel-sequential',
  'six-hats',
  'debate',
  'delphi',
];

/**
 * Default models per provider
 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-5.2',
  anthropic: 'claude-sonnet-4-5-20250929',
  google: 'gemini-3-pro-preview',
  ollama: 'llama3.3',
  lmstudio: 'qwen/qwen3-coder-30b',
  openrouter: 'anthropic/claude-sonnet-4.5',
};

/**
 * Provider display names
 */
export const PROVIDER_NAMES: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google (Gemini)',
  ollama: 'Ollama (Local)',
  lmstudio: 'LM Studio (Local)',
  openrouter: 'OpenRouter',
};

/**
 * Personality archetype descriptions for wizard
 */
export const ARCHETYPE_DESCRIPTIONS: Record<PersonalityArchetype, string> = {
  skeptic: 'Questions assumptions, demands evidence',
  optimist: 'Sees potential, focuses on solutions',
  pessimist: 'Identifies risks, prepares for worst cases',
  pragmatist: 'Focuses on practical implementation',
  innovator: 'Proposes creative, novel solutions',
  'devils-advocate': 'Argues opposite positions to test ideas',
  analyst: 'Systematic, data-driven analysis',
  mediator: 'Bridges differences, finds common ground',
};

/**
 * CLI argument schemas
 */
export const CliArgsSchema = z.object({
  topic: z.string().optional(),
  config: z.string().optional(),
  depth: z.coerce.number().int().min(1).max(10).optional(),
  algorithm: z.string().optional(),
  agent: z.array(z.string()).optional(),
  moderatorProvider: z.string().optional(),
  moderatorModel: z.string().optional(),
  output: z.string().optional(),
  stdout: z.boolean().optional(),
  continue: z.string().optional(),
  tui: z.boolean().optional(),
  web: z.boolean().optional(),
  port: z.coerce.number().optional(),
  wizard: z.boolean().optional(),
  init: z.boolean().optional(),
  listPersonalities: z.boolean().optional(),
  listProviders: z.boolean().optional(),
});

export type CliArgs = z.infer<typeof CliArgsSchema>;

/**
 * Wizard state schema
 */
export const WizardStateSchema = z.object({
  topic: z.string(),
  depth: z.number().int().min(1).max(10),
  agents: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    personality: z.string(),
    name: z.string().optional(),
  })),
  moderator: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  outputPath: z.string().optional(),
});

export type WizardState = z.infer<typeof WizardStateSchema>;

/**
 * Suggested agent combinations for different scenarios
 */
export const SUGGESTED_TEAMS = {
  balanced: {
    name: 'Balanced Team',
    description: 'A well-rounded team for general discussions',
    archetypes: ['pragmatist', 'innovator', 'skeptic', 'analyst'] as PersonalityArchetype[],
  },
  creative: {
    name: 'Creative Team',
    description: 'For brainstorming and ideation',
    archetypes: ['innovator', 'optimist', 'devils-advocate', 'mediator'] as PersonalityArchetype[],
  },
  critical: {
    name: 'Critical Team',
    description: 'For thorough analysis and risk assessment',
    archetypes: ['skeptic', 'pessimist', 'analyst', 'pragmatist'] as PersonalityArchetype[],
  },
  minimal: {
    name: 'Minimal Team',
    description: 'Quick discussions with opposing views',
    archetypes: ['optimist', 'skeptic'] as PersonalityArchetype[],
  },
  comprehensive: {
    name: 'Comprehensive Team',
    description: 'All perspectives covered',
    archetypes: ['optimist', 'pessimist', 'pragmatist', 'innovator', 'skeptic', 'mediator'] as PersonalityArchetype[],
  },
};

/**
 * Validate provider string
 */
export function isValidProvider(provider: string): provider is Provider {
  return VALID_PROVIDERS.includes(provider as Provider);
}

/**
 * Validate archetype string
 */
export function isValidArchetype(archetype: string): archetype is PersonalityArchetype {
  return VALID_ARCHETYPES.includes(archetype as PersonalityArchetype);
}

/**
 * Validate algorithm string
 */
export function isValidAlgorithm(algorithm: string): algorithm is DiscussionAlgorithmName {
  return VALID_ALGORITHMS.includes(algorithm as DiscussionAlgorithmName);
}

/**
 * Get suggested models for a provider
 */
/**
 * Popular OpenRouter models (Updated Feb 2026)
 */
export const OPENROUTER_MODELS = [
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
];

export function getSuggestedModels(provider: Provider): string[] {
  switch (provider) {
    case 'openai':
      return ['gpt-5.2', 'gpt-5.2-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'];
    case 'anthropic':
      return ['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'];
    case 'google':
      return ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-1.5-pro'];
    case 'ollama':
      return ['llama3.3', 'llama3.3:70b', 'qwen2.5-coder', 'deepseek-r1', 'mistral', 'mixtral'];
    case 'lmstudio':
      return ['qwen/qwen3-coder-30b', 'local-model'];
    case 'openrouter':
      return OPENROUTER_MODELS;
    default:
      return [];
  }
}
