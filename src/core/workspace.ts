/**
 * Workspace management for Bot Consensus
 * Handles config files, API keys, session state, and auto-save
 */

import { readFile, writeFile, mkdir, access, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';
import type { Provider, SessionState } from './types.js';

const CONSENSUS_DIR = '.consensus';
const GLOBAL_DIR = join(homedir(), '.consensus');
const CONFIG_FILE = 'config.json';
const KEYS_FILE = 'keys.json';
const STATE_FILE = 'current-state.json';

export interface WorkspaceConfig {
  topic?: string;
  depth?: number;
  agents?: Array<{
    provider: string;
    model: string;
    personality: string;
    name?: string;
  }>;
  moderator?: {
    provider: string;
    model: string;
  };
  defaultProvider?: string;
  defaultModel?: string;
  lastModified?: string;
}

export interface StoredApiKeys {
  openai?: string;
  anthropic?: string;
  google?: string;
  openrouter?: string;
  [key: string]: string | undefined;
}

export interface CurrentState {
  sessionId: string;
  topic: string;
  phase: string;
  round: number;
  totalRounds: number;
  agentIndex: number;
  lastUpdate: string;
  messages: Array<{
    agentId?: string;
    agentName?: string;
    content: string;
    timestamp: string;
  }>;
  completed: boolean;
}

export class WorkspaceManager {
  private workspace: string;
  private consensusDir: string;

  constructor(workspace?: string) {
    this.workspace = workspace || process.cwd();
    this.consensusDir = join(this.workspace, CONSENSUS_DIR);
  }

  /**
   * Initialize workspace directory
   */
  async init(): Promise<void> {
    await mkdir(this.consensusDir, { recursive: true });
    await mkdir(join(this.consensusDir, 'sessions'), { recursive: true });
    await mkdir(join(this.consensusDir, 'logs'), { recursive: true });
    logger.setWorkspace(this.workspace);
    logger.info('Workspace', `Initialized workspace: ${this.workspace}`);
  }

  /**
   * Check if a config file exists in the workspace
   */
  async hasConfig(): Promise<boolean> {
    try {
      await access(join(this.consensusDir, CONFIG_FILE));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load workspace config
   */
  async loadConfig(): Promise<WorkspaceConfig | null> {
    try {
      const content = await readFile(join(this.consensusDir, CONFIG_FILE), 'utf-8');
      const config = JSON.parse(content) as WorkspaceConfig;
      logger.info('Workspace', 'Loaded config from workspace');
      return config;
    } catch {
      return null;
    }
  }

  /**
   * Save workspace config
   */
  async saveConfig(config: WorkspaceConfig): Promise<void> {
    await this.init();
    config.lastModified = new Date().toISOString();
    await writeFile(
      join(this.consensusDir, CONFIG_FILE),
      JSON.stringify(config, null, 2),
      'utf-8'
    );
    logger.info('Workspace', 'Saved config to workspace');
  }

  /**
   * Load API keys (checks workspace first, then global)
   */
  async loadApiKeys(): Promise<StoredApiKeys> {
    const keys: StoredApiKeys = {};

    // Load global keys first
    try {
      const globalContent = await readFile(join(GLOBAL_DIR, KEYS_FILE), 'utf-8');
      const globalKeys = JSON.parse(globalContent) as StoredApiKeys;
      Object.assign(keys, globalKeys);
      logger.debug('Workspace', 'Loaded global API keys');
    } catch {
      // No global keys
    }

    // Load workspace keys (override global)
    try {
      const localContent = await readFile(join(this.consensusDir, KEYS_FILE), 'utf-8');
      const localKeys = JSON.parse(localContent) as StoredApiKeys;
      Object.assign(keys, localKeys);
      logger.debug('Workspace', 'Loaded workspace API keys');
    } catch {
      // No local keys
    }

    return keys;
  }

  /**
   * Save API key
   */
  async saveApiKey(provider: Provider, apiKey: string, global: boolean = false): Promise<void> {
    const dir = global ? GLOBAL_DIR : this.consensusDir;
    const filePath = join(dir, KEYS_FILE);

    await mkdir(dir, { recursive: true });

    let keys: StoredApiKeys = {};
    try {
      const content = await readFile(filePath, 'utf-8');
      keys = JSON.parse(content);
    } catch {
      // No existing file
    }

    keys[provider] = apiKey;

    await writeFile(filePath, JSON.stringify(keys, null, 2), 'utf-8');
    logger.info('Workspace', `Saved ${provider} API key ${global ? 'globally' : 'to workspace'}`);
  }

  /**
   * Apply stored API keys to environment
   */
  async applyApiKeys(): Promise<void> {
    const keys = await this.loadApiKeys();
    
    if (keys.openai && !process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = keys.openai;
    }
    if (keys.anthropic && !process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = keys.anthropic;
    }
    if (keys.google && !process.env.GOOGLE_API_KEY) {
      process.env.GOOGLE_API_KEY = keys.google;
    }
    if (keys.openrouter && !process.env.OPENROUTER_API_KEY) {
      process.env.OPENROUTER_API_KEY = keys.openrouter;
    }
  }

  /**
   * Check if there's an incomplete session
   */
  async hasIncompleteSession(): Promise<boolean> {
    try {
      await access(join(this.consensusDir, STATE_FILE));
      const state = await this.loadCurrentState();
      return state !== null && !state.completed;
    } catch {
      return false;
    }
  }

  /**
   * Load current session state
   */
  async loadCurrentState(): Promise<CurrentState | null> {
    try {
      const content = await readFile(join(this.consensusDir, STATE_FILE), 'utf-8');
      return JSON.parse(content) as CurrentState;
    } catch {
      return null;
    }
  }

  /**
   * Save current session state (auto-save after each agent response)
   */
  async saveCurrentState(state: CurrentState): Promise<void> {
    await this.init();
    state.lastUpdate = new Date().toISOString();
    await writeFile(
      join(this.consensusDir, STATE_FILE),
      JSON.stringify(state, null, 2),
      'utf-8'
    );
    logger.debug('Workspace', 'Auto-saved current state');
  }

  /**
   * Mark session as completed and clear current state
   */
  async markCompleted(sessionId: string): Promise<void> {
    const state = await this.loadCurrentState();
    if (state && state.sessionId === sessionId) {
      state.completed = true;
      await this.saveCurrentState(state);
    }
  }

  /**
   * Clear current state (after successful completion or manual clear)
   */
  async clearCurrentState(): Promise<void> {
    try {
      const { unlink } = await import('fs/promises');
      await unlink(join(this.consensusDir, STATE_FILE));
      logger.info('Workspace', 'Cleared current state');
    } catch {
      // File doesn't exist
    }
  }

  /**
   * List all saved sessions
   */
  async listSessions(): Promise<string[]> {
    try {
      const sessionsDir = join(this.consensusDir, 'sessions');
      const files = await readdir(sessionsDir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  /**
   * Get workspace path
   */
  getPath(): string {
    return this.workspace;
  }

  /**
   * Get consensus directory path
   */
  getConsensusDir(): string {
    return this.consensusDir;
  }
}

/**
 * Initialize global config directory
 */
export async function initGlobalConfig(): Promise<void> {
  await mkdir(GLOBAL_DIR, { recursive: true });
}

/**
 * Get global API keys
 */
export async function getGlobalApiKeys(): Promise<StoredApiKeys> {
  try {
    const content = await readFile(join(GLOBAL_DIR, KEYS_FILE), 'utf-8');
    return JSON.parse(content) as StoredApiKeys;
  } catch {
    return {};
  }
}

/**
 * Save global API key
 */
export async function saveGlobalApiKey(provider: Provider, apiKey: string): Promise<void> {
  await initGlobalConfig();
  const keys = await getGlobalApiKeys();
  keys[provider] = apiKey;
  await writeFile(join(GLOBAL_DIR, KEYS_FILE), JSON.stringify(keys, null, 2), 'utf-8');
}
