import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import type { Personality, PersonalityArchetype } from '../../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../../../templates/personalities');

// Cache for loaded personalities
const personalityCache = new Map<string, Personality>();

/**
 * Load a personality template by archetype name
 */
export async function loadPersonality(archetype: PersonalityArchetype | string): Promise<Personality> {
  // Check cache first
  const cached = personalityCache.get(archetype);
  if (cached) return cached;

  const filePath = join(TEMPLATES_DIR, `${archetype}.yaml`);
  
  try {
    const content = await readFile(filePath, 'utf-8');
    const personality = parseYaml(content) as Personality;
    
    // Validate required fields
    if (!personality.name || !personality.traits || !personality.systemPromptAddition) {
      throw new Error(`Invalid personality template: ${archetype}`);
    }

    personalityCache.set(archetype, personality);
    return personality;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Personality template not found: ${archetype}`);
    }
    throw error;
  }
}

/**
 * Get list of available personality templates
 */
export async function getPersonalityTemplates(): Promise<string[]> {
  try {
    const files = await readdir(TEMPLATES_DIR);
    return files
      .filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
      .map((f) => f.replace('.yaml', ''));
  } catch {
    return [];
  }
}

/**
 * Load a personality from a custom YAML file
 */
export async function loadCustomPersonality(filePath: string): Promise<Personality> {
  const content = await readFile(filePath, 'utf-8');
  const personality = parseYaml(content) as Personality;
  
  // Validate required fields
  if (!personality.name || !personality.traits || !personality.systemPromptAddition) {
    throw new Error(`Invalid personality file: ${filePath}`);
  }

  return personality;
}

/**
 * Create a personality from inline configuration
 */
export function createPersonality(config: {
  name: string;
  description?: string;
  baseArchetype?: PersonalityArchetype;
  traits?: { name: string; description: string; weight: number }[];
  systemPromptAddition?: string;
  communicationStyle?: {
    tone?: string;
    verbosity?: 'concise' | 'moderate' | 'detailed';
    formality?: 'casual' | 'balanced' | 'formal';
  };
}): Personality {
  return {
    archetype: config.baseArchetype,
    name: config.name,
    description: config.description || `Custom personality: ${config.name}`,
    traits: config.traits || [],
    systemPromptAddition: config.systemPromptAddition || '',
    communicationStyle: {
      tone: config.communicationStyle?.tone || 'neutral',
      verbosity: config.communicationStyle?.verbosity || 'moderate',
      formality: config.communicationStyle?.formality || 'balanced',
    },
  };
}

/**
 * Merge a base archetype with custom overrides
 */
export async function extendPersonality(
  baseArchetype: PersonalityArchetype,
  overrides: Partial<Personality>
): Promise<Personality> {
  const base = await loadPersonality(baseArchetype);
  
  return {
    ...base,
    ...overrides,
    archetype: baseArchetype,
    traits: overrides.traits ? [...base.traits, ...overrides.traits] : base.traits,
    communicationStyle: {
      ...base.communicationStyle,
      ...overrides.communicationStyle,
    },
    systemPromptAddition: overrides.systemPromptAddition
      ? `${base.systemPromptAddition}\n\nAdditional instructions:\n${overrides.systemPromptAddition}`
      : base.systemPromptAddition,
  };
}

/**
 * Generate a description of personality traits for display
 */
export function describePersonality(personality: Personality): string {
  const traitNames = personality.traits
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((t) => t.name)
    .join(', ');

  return `${personality.name} (${traitNames})`;
}
