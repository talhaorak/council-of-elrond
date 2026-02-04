import { mkdir, readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import type { SessionState, ConsensusOutput } from '../core/types.js';

const STATE_DIR = '.consensus';

/**
 * Manages session state persistence
 */
export class SessionManager {
  private baseDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = join(baseDir, STATE_DIR);
  }

  /**
   * Ensure the state directory exists
   */
  private async ensureDir(): Promise<void> {
    try {
      await mkdir(this.baseDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Save a session state
   */
  async save(session: SessionState): Promise<string> {
    await this.ensureDir();
    
    const filename = `${session.id}.json`;
    const filepath = join(this.baseDir, filename);
    
    await writeFile(filepath, JSON.stringify(session, null, 2), 'utf-8');
    
    return filepath;
  }

  /**
   * Load a session by ID
   */
  async load(sessionId: string): Promise<SessionState | null> {
    try {
      const filepath = join(this.baseDir, `${sessionId}.json`);
      const content = await readFile(filepath, 'utf-8');
      return JSON.parse(content) as SessionState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * List all saved sessions
   */
  async list(): Promise<{ id: string; topic: string; createdAt: Date; isComplete: boolean }[]> {
    try {
      await this.ensureDir();
      const files = await readdir(this.baseDir);
      const sessions: { id: string; topic: string; createdAt: Date; isComplete: boolean }[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        try {
          const content = await readFile(join(this.baseDir, file), 'utf-8');
          const session = JSON.parse(content) as SessionState;
          sessions.push({
            id: session.id,
            topic: session.config.topic,
            createdAt: new Date(session.createdAt),
            isComplete: session.isComplete,
          });
        } catch {
          // Skip malformed files
        }
      }

      return sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } catch {
      return [];
    }
  }

  /**
   * Delete a session
   */
  async delete(sessionId: string): Promise<boolean> {
    try {
      const { unlink } = await import('fs/promises');
      await unlink(join(this.baseDir, `${sessionId}.json`));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Auto-save during discussion (for recovery)
   */
  createAutoSaver(session: SessionState, intervalMs: number = 30000): {
    start: () => void;
    stop: () => void;
    saveNow: () => Promise<void>;
  } {
    let intervalId: Timer | null = null;

    const saveNow = async () => {
      await this.save(session);
    };

    return {
      start: () => {
        if (intervalId) return;
        intervalId = setInterval(saveNow, intervalMs);
      },
      stop: () => {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      },
      saveNow,
    };
  }
}

/**
 * Export session to a portable format
 */
export function exportSession(session: SessionState): string {
  return JSON.stringify({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    session,
  }, null, 2);
}

/**
 * Import session from exported format
 */
export function importSession(data: string): SessionState {
  const parsed = JSON.parse(data);
  
  if (!parsed.session) {
    throw new Error('Invalid session export format');
  }
  
  return parsed.session as SessionState;
}

/**
 * Get session summary for display
 */
export function getSessionSummary(session: SessionState): string {
  const agentCount = session.config.agents.length;
  const messageCount = session.messages.length;
  const status = session.isComplete ? 'Complete' : `In Progress (${session.currentPhase})`;
  
  return `
Session: ${session.id}
Topic: ${session.config.topic}
Status: ${status}
Agents: ${agentCount}
Messages: ${messageCount}
Created: ${new Date(session.createdAt).toLocaleString()}
Updated: ${new Date(session.updatedAt).toLocaleString()}
`.trim();
}
