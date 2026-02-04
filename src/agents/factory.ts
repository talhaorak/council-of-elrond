import { nanoid } from 'nanoid';
import type { AgentConfig, Provider, Personality, PersonalityArchetype } from '../core/types.js';
import { Agent } from './agent.js';
import { loadPersonality, createPersonality, extendPersonality } from './personalities/index.js';
import { getDefaultModel } from '../providers/index.js';

export { Agent } from './agent.js';

export interface AgentDefinition {
  name?: string;
  provider: Provider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  personality: PersonalityArchetype | string | Partial<Personality> | {
    base?: PersonalityArchetype;
    custom: Partial<Personality>;
  };
}

/**
 * Factory for creating agents with various configurations
 */
export class AgentFactory {
  /**
   * Create an agent from a definition
   */
  static async create(definition: AgentDefinition): Promise<Agent> {
    const config = await this.buildConfig(definition);
    return new Agent(config);
  }

  /**
   * Create multiple agents from definitions
   */
  static async createMany(definitions: AgentDefinition[]): Promise<Agent[]> {
    return Promise.all(definitions.map((d) => this.create(d)));
  }

  /**
   * Build a full AgentConfig from a definition
   */
  private static async buildConfig(definition: AgentDefinition): Promise<AgentConfig> {
    const personality = await this.resolvePersonality(definition.personality);
    const id = nanoid(8);
    
    return {
      id,
      name: definition.name || `Agent-${personality.name.replace(/\s+/g, '-')}-${id.slice(0, 4)}`,
      provider: definition.provider,
      model: definition.model || getDefaultModel(definition.provider),
      personality,
      apiKey: definition.apiKey,
      baseUrl: definition.baseUrl,
      temperature: definition.temperature,
      maxTokens: definition.maxTokens,
    };
  }

  /**
   * Resolve personality from various input formats
   */
  private static async resolvePersonality(
    input: PersonalityArchetype | string | Partial<Personality> | { base?: PersonalityArchetype; custom: Partial<Personality> }
  ): Promise<Personality> {
    // String archetype name
    if (typeof input === 'string') {
      return loadPersonality(input);
    }

    // Object with base + custom
    if ('custom' in input && input.custom) {
      if (input.base) {
        return extendPersonality(input.base, input.custom);
      }
      return createPersonality({
        name: input.custom.name || 'Custom Agent',
        ...input.custom,
      });
    }

    // Full or partial personality object
    if ('name' in input && input.name) {
      return createPersonality({
        name: input.name,
        description: input.description,
        traits: input.traits,
        systemPromptAddition: input.systemPromptAddition,
        communicationStyle: input.communicationStyle,
      });
    }

    // Fallback to pragmatist
    return loadPersonality('pragmatist');
  }
}

/**
 * Convenience function to create a single agent
 */
export async function createAgent(definition: AgentDefinition): Promise<Agent> {
  return AgentFactory.create(definition);
}

/**
 * Quick agent creation with minimal config
 */
export async function quickAgent(
  provider: Provider,
  archetype: PersonalityArchetype,
  options?: {
    name?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Agent> {
  return AgentFactory.create({
    provider,
    personality: archetype,
    ...options,
  });
}

/**
 * Create a preset team of agents for balanced discussion
 */
export async function createBalancedTeam(
  provider: Provider,
  options?: {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Agent[]> {
  const archetypes: PersonalityArchetype[] = [
    'pragmatist',
    'innovator',
    'skeptic',
    'analyst',
  ];

  return AgentFactory.createMany(
    archetypes.map((archetype) => ({
      provider,
      personality: archetype,
      ...options,
    }))
  );
}

/**
 * Create a diverse team covering multiple perspectives
 */
export async function createDiverseTeam(
  provider: Provider,
  options?: {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<Agent[]> {
  const archetypes: PersonalityArchetype[] = [
    'optimist',
    'pessimist',
    'pragmatist',
    'innovator',
    'devils-advocate',
    'mediator',
  ];

  return AgentFactory.createMany(
    archetypes.map((archetype) => ({
      provider,
      personality: archetype,
      ...options,
    }))
  );
}
