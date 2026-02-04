import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type {
  DiscussionConfig,
  AgentConfig,
  ModeratorConfig,
  Provider,
  Personality,
} from '../core/types.js';
import { DiscussionConfigSchema } from '../core/types.js';
import { loadPersonality, extendPersonality } from '../agents/personalities/index.js';
import { getDefaultProvider, getDefaultModel } from '../providers/index.js';
import { nanoid } from 'nanoid';

/**
 * Configuration file schema (more flexible than runtime config)
 */
const ConfigFileSchema = z.object({
  topic: z.string().optional(),
  depth: z.number().int().min(1).max(10).optional().default(3),
  
  moderator: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
  }).optional(),

  agents: z.array(z.object({
    name: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().positive().optional(),
    personality: z.union([
      z.string(), // archetype name
      z.object({
        base: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        traits: z.array(z.object({
          name: z.string(),
          description: z.string(),
          weight: z.number().min(0).max(1),
        })).optional(),
        systemPromptAddition: z.string().optional(),
        communicationStyle: z.object({
          tone: z.string().optional(),
          verbosity: z.enum(['concise', 'moderate', 'detailed']).optional(),
          formality: z.enum(['casual', 'balanced', 'formal']).optional(),
        }).optional(),
      }),
    ]),
  })).optional(),

  defaults: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().positive().optional(),
  }).optional(),

  output: z.object({
    path: z.string().optional(),
    stdout: z.boolean().optional(),
  }).optional(),
});

type ConfigFile = z.infer<typeof ConfigFileSchema>;

/**
 * Load configuration from a YAML or JSON file
 */
export async function loadConfigFile(filepath: string): Promise<ConfigFile> {
  const content = await readFile(filepath, 'utf-8');
  
  let parsed: unknown;
  if (filepath.endsWith('.json')) {
    parsed = JSON.parse(content);
  } else {
    parsed = parseYaml(content);
  }

  return ConfigFileSchema.parse(parsed);
}

/**
 * Build full DiscussionConfig from file config + CLI overrides
 */
export async function buildConfig(options: {
  configFile?: string;
  topic?: string;
  depth?: number;
  agents?: string[]; // Format: "provider:model:personality" or "provider:personality"
  moderatorProvider?: string;
  moderatorModel?: string;
  outputPath?: string;
  outputStdout?: boolean;
}): Promise<DiscussionConfig> {
  // Load file config if provided
  let fileConfig: ConfigFile = { depth: 3 };
  if (options.configFile) {
    fileConfig = await loadConfigFile(options.configFile);
  }

  // Determine defaults
  const defaultProvider = (
    fileConfig.defaults?.provider ||
    process.env.DEFAULT_PROVIDER ||
    getDefaultProvider()
  ) as Provider;

  const defaultModel = fileConfig.defaults?.model || getDefaultModel(defaultProvider);

  // Build topic
  const topic = options.topic || fileConfig.topic;
  if (!topic) {
    throw new Error('Topic is required. Provide via --topic or config file.');
  }

  // Build depth
  const depth = options.depth ?? fileConfig.depth ?? 3;

  // Build agents
  let agentConfigs: AgentConfig[] = [];

  if (options.agents && options.agents.length > 0) {
    // Parse CLI agent specs
    agentConfigs = await Promise.all(
      options.agents.map((spec) => parseAgentSpec(spec, {
        defaultProvider,
        defaultModel,
        defaultApiKey: fileConfig.defaults?.apiKey,
        defaultBaseUrl: fileConfig.defaults?.baseUrl,
        defaultTemperature: fileConfig.defaults?.temperature,
        defaultMaxTokens: fileConfig.defaults?.maxTokens,
      }))
    );
  } else if (fileConfig.agents && fileConfig.agents.length > 0) {
    // Use file-defined agents
    agentConfigs = await Promise.all(
      fileConfig.agents.map((agent) => buildAgentConfig(agent, {
        defaultProvider,
        defaultModel,
        defaultApiKey: fileConfig.defaults?.apiKey,
        defaultBaseUrl: fileConfig.defaults?.baseUrl,
        defaultTemperature: fileConfig.defaults?.temperature,
        defaultMaxTokens: fileConfig.defaults?.maxTokens,
      }))
    );
  } else {
    throw new Error('At least 2 agents are required. Provide via --agent or config file.');
  }

  if (agentConfigs.length < 2) {
    throw new Error('At least 2 agents are required for a discussion.');
  }

  // Build moderator config
  const moderatorConfig: ModeratorConfig = {
    provider: (options.moderatorProvider || fileConfig.moderator?.provider || defaultProvider) as Provider,
    model: options.moderatorModel || fileConfig.moderator?.model || defaultModel,
    apiKey: fileConfig.moderator?.apiKey || fileConfig.defaults?.apiKey,
    baseUrl: fileConfig.moderator?.baseUrl || fileConfig.defaults?.baseUrl,
    temperature: fileConfig.moderator?.temperature ?? 0.5,
  };

  // Build output config
  const outputPath = options.outputPath ?? fileConfig.output?.path;
  const outputToStdout = options.outputStdout ?? fileConfig.output?.stdout ?? !outputPath;

  return {
    topic,
    depth,
    agents: agentConfigs,
    moderator: moderatorConfig,
    outputPath,
    outputToStdout,
  };
}

/**
 * Parse a CLI agent specification string
 * Formats:
 *   - "provider:model:personality"
 *   - "provider:personality" (uses default model)
 *   - "personality" (uses default provider and model)
 */
async function parseAgentSpec(
  spec: string,
  defaults: {
    defaultProvider: Provider;
    defaultModel: string;
    defaultApiKey?: string;
    defaultBaseUrl?: string;
    defaultTemperature?: number;
    defaultMaxTokens?: number;
  }
): Promise<AgentConfig> {
  const parts = spec.split(':');
  
  let provider: Provider;
  let model: string;
  let personalityName: string;

  if (parts.length === 1) {
    // Just personality
    provider = defaults.defaultProvider;
    model = defaults.defaultModel;
    personalityName = parts[0];
  } else if (parts.length === 2) {
    // provider:personality
    provider = parts[0] as Provider;
    model = getDefaultModel(provider);
    personalityName = parts[1];
  } else {
    // provider:model:personality
    provider = parts[0] as Provider;
    model = parts[1];
    personalityName = parts.slice(2).join(':'); // In case personality has colons
  }

  const personality = await loadPersonality(personalityName);
  const id = nanoid(8);

  return {
    id,
    name: `${personality.name}-${id.slice(0, 4)}`,
    provider,
    model,
    personality,
    apiKey: defaults.defaultApiKey,
    baseUrl: defaults.defaultBaseUrl,
    temperature: defaults.defaultTemperature,
    maxTokens: defaults.defaultMaxTokens,
  };
}

/**
 * Build AgentConfig from file agent definition
 */
async function buildAgentConfig(
  agent: NonNullable<ConfigFile['agents']>[number],
  defaults: {
    defaultProvider: Provider;
    defaultModel: string;
    defaultApiKey?: string;
    defaultBaseUrl?: string;
    defaultTemperature?: number;
    defaultMaxTokens?: number;
  }
): Promise<AgentConfig> {
  const provider = (agent.provider || defaults.defaultProvider) as Provider;
  const model = agent.model || getDefaultModel(provider);
  
  let personality: Personality;
  
  if (typeof agent.personality === 'string') {
    personality = await loadPersonality(agent.personality);
  } else {
    // Custom personality definition
    const customDef = agent.personality;
    if (customDef.base) {
      personality = await extendPersonality(customDef.base as any, {
        name: customDef.name,
        description: customDef.description,
        traits: customDef.traits,
        systemPromptAddition: customDef.systemPromptAddition,
        communicationStyle: customDef.communicationStyle as any,
      });
    } else {
      personality = {
        name: customDef.name || 'Custom Agent',
        description: customDef.description || 'A custom personality',
        traits: customDef.traits || [],
        systemPromptAddition: customDef.systemPromptAddition || '',
        communicationStyle: {
          tone: customDef.communicationStyle?.tone || 'neutral',
          verbosity: customDef.communicationStyle?.verbosity || 'moderate',
          formality: customDef.communicationStyle?.formality || 'balanced',
        },
      };
    }
  }

  const id = nanoid(8);

  return {
    id,
    name: agent.name || `${personality.name}-${id.slice(0, 4)}`,
    provider,
    model,
    personality,
    apiKey: agent.apiKey || defaults.defaultApiKey,
    baseUrl: agent.baseUrl || defaults.defaultBaseUrl,
    temperature: agent.temperature ?? defaults.defaultTemperature,
    maxTokens: agent.maxTokens ?? defaults.defaultMaxTokens,
  };
}

/**
 * Validate a complete DiscussionConfig
 */
export function validateConfig(config: unknown): DiscussionConfig {
  return DiscussionConfigSchema.parse(config);
}

/**
 * Load environment variables and merge with config
 */
export function loadEnvConfig(): {
  openaiKey?: string;
  anthropicKey?: string;
  googleKey?: string;
  ollamaUrl?: string;
  lmstudioUrl?: string;
  defaultProvider?: string;
  defaultModel?: string;
} {
  return {
    openaiKey: process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    googleKey: process.env.GOOGLE_API_KEY,
    ollamaUrl: process.env.OLLAMA_BASE_URL,
    lmstudioUrl: process.env.LMSTUDIO_BASE_URL,
    defaultProvider: process.env.DEFAULT_PROVIDER,
    defaultModel: process.env.DEFAULT_MODEL,
  };
}

/**
 * Generate a sample config file
 */
export function generateSampleConfig(): string {
  return `# Bot Consensus Configuration
# Copy this file to consensus.yaml and customize

# Discussion topic (can be overridden via CLI)
topic: "The most feasible and performant REST API architecture for Go applications"

# Number of discussion rounds (1-10)
depth: 3

# Default settings for all agents
defaults:
  provider: lmstudio
  model: qwen/qwen3-coder-30b
  # baseUrl: http://localhost:1234  # LM Studio default
  temperature: 0.7

# Moderator configuration
moderator:
  provider: lmstudio
  model: qwen/qwen3-coder-30b
  temperature: 0.5

# Agent definitions
agents:
  - name: "The Pragmatist"
    personality: pragmatist
    
  - name: "The Innovator"
    personality: innovator
    
  - name: "The Skeptic"
    personality: skeptic
    
  - name: "The Analyst"
    personality: analyst

  # Example of custom personality
  # - name: "Custom Expert"
  #   personality:
  #     base: pragmatist  # Optional: extend existing
  #     name: "Domain Expert"
  #     description: "Deep expertise in the specific domain"
  #     traits:
  #       - name: domain-knowledge
  #         description: "Has deep knowledge of the specific area"
  #         weight: 0.9
  #     systemPromptAddition: |
  #       You have extensive experience in this domain.
  #       Reference specific real-world examples when possible.

# Output configuration
output:
  path: ./consensus-output.md
  # stdout: true  # Also print to console
`;
}
