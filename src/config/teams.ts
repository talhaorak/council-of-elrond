import { z } from 'zod';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import type { Provider, PersonalityArchetype, Personality, AgentConfig, ModeratorConfig, ArbiterConfig, DiscussionLimits } from '../core/types.js';

// Schema for team agent in YAML
const TeamAgentSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  personality: z.union([
    z.string(), // archetype name
    z.object({
      base: z.string().optional(),
      name: z.string().optional(),
      traits: z.array(z.object({
        name: z.string(),
        description: z.string(),
        weight: z.number(),
      })).optional(),
      systemPromptAddition: z.string().optional(),
      communicationStyle: z.object({
        tone: z.string(),
        verbosity: z.enum(['concise', 'moderate', 'detailed']),
        formality: z.enum(['casual', 'balanced', 'formal']),
      }).optional(),
    }),
  ]),
});

// Schema for team template YAML
const TeamTemplateSchema = z.object({
  name: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  tags: z.array(z.string()).optional(),
  recommended_depth: z.number().optional(),
  agents: z.array(TeamAgentSchema),
  moderator: z.object({
    provider: z.string(),
    model: z.string(),
    temperature: z.number().optional(),
    system_prompt_addition: z.string().optional(),
  }).optional(),
  arbiter: z.object({
    provider: z.string(),
    model: z.string(),
  }).optional(),
  limits: z.object({
    maxCostUsd: z.number().optional(),
    maxDurationMs: z.number().optional(),
    maxTokens: z.number().optional(),
    maxBlockers: z.number().optional(),
    maxConsecutiveDisagreements: z.number().optional(),
    requireHumanDecision: z.boolean().optional(),
  }).optional(),
});

export type TeamTemplate = z.infer<typeof TeamTemplateSchema>;

// LoadedTeam extends TeamTemplate with id and filePath
export interface LoadedTeam extends TeamTemplate {
  id: string;
  filePath: string;
}

/**
 * Get the templates directory path
 */
function getTemplatesDir(): string {
  // Handle both ESM and development scenarios
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // Go up from src/config to project root, then to templates
    return join(__dirname, '..', '..', 'templates', 'teams');
  } catch {
    // Fallback for Bun direct execution
    return join(process.cwd(), 'templates', 'teams');
  }
}

/**
 * Load all team templates from the templates/teams directory
 */
export async function loadTeamTemplates(): Promise<LoadedTeam[]> {
  const teamsDir = getTemplatesDir();
  const teams: LoadedTeam[] = [];

  try {
    const files = await readdir(teamsDir);
    
    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      
      const filePath = join(teamsDir, file);
      const content = await readFile(filePath, 'utf-8');
      
      try {
        const parsed = parseYaml(content);
        const validated = TeamTemplateSchema.parse(parsed);
        
        // Generate ID from filename (remove extension)
        const id = file.replace(/\.(yaml|yml)$/, '');
        
        teams.push({
          id,
          filePath,
          ...validated,
        });
      } catch (error) {
        console.warn(`Warning: Failed to parse team template ${file}:`, error);
      }
    }
  } catch (error) {
    // Templates directory doesn't exist or can't be read
    console.warn('Warning: Could not load team templates:', error);
  }

  return teams;
}

/**
 * Get a specific team by ID
 */
export async function getTeam(teamId: string): Promise<LoadedTeam | null> {
  const teams = await loadTeamTemplates();
  return teams.find(t => t.id === teamId) || null;
}

/**
 * Alias for getTeam (for compatibility)
 */
export const getTeamById = getTeam;

/**
 * List available team IDs and names
 */
export async function listTeams(): Promise<Array<{ id: string; name: string; description: string; icon?: string; agentCount: number }>> {
  const teams = await loadTeamTemplates();
  return teams.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description.split('\n')[0], // First line only
    icon: t.icon,
    agentCount: t.agents.length,
  }));
}

/**
 * Convert team template to discussion config components
 */
export function teamToConfig(team: TeamTemplate): {
  agents: Partial<AgentConfig>[];
  moderator: Partial<ModeratorConfig>;
  arbiter?: Partial<ArbiterConfig>;
  limits?: DiscussionLimits;
  depth: number;
} {
  const agents = team.agents.map((agent, index) => {
    const personality: Partial<Personality> = typeof agent.personality === 'string'
      ? { archetype: agent.personality as PersonalityArchetype, name: agent.personality }
      : {
          archetype: agent.personality.base as PersonalityArchetype | undefined,
          name: agent.personality.name || agent.name,
          traits: agent.personality.traits || [],
          systemPromptAddition: agent.personality.systemPromptAddition || '',
          communicationStyle: agent.personality.communicationStyle || {
            tone: 'balanced',
            verbosity: 'moderate',
            formality: 'balanced',
          },
        };

    return {
      id: `agent-${index}`,
      name: agent.name,
      provider: agent.provider as Provider,
      model: agent.model,
      personality: personality as Personality,
    };
  });

  const moderator: Partial<ModeratorConfig> = team.moderator
    ? {
        provider: team.moderator.provider as Provider,
        model: team.moderator.model,
        temperature: team.moderator.temperature,
      }
    : {
        provider: 'lmstudio' as Provider,
        model: 'qwen/qwen3-coder-30b',
      };

  const arbiter = team.arbiter
    ? {
        provider: team.arbiter.provider as Provider,
        model: team.arbiter.model,
      }
    : undefined;

  return {
    agents,
    moderator,
    arbiter,
    limits: team.limits,
    depth: team.recommended_depth || 3,
  };
}

// Export built-in team IDs for convenience
export const BUILTIN_TEAMS = [
  'council-of-elrond',
  'free-council',
  'pro-council',
  'local-council',
] as const;

export type BuiltinTeamId = typeof BUILTIN_TEAMS[number];
