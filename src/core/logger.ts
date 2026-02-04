/**
 * Logging system for Bot Consensus
 * Supports console output and file logging
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: unknown;
}

interface LoggerConfig {
  level: LogLevel;
  console: boolean;
  file: boolean;
  filePath?: string;
  workspace?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m',  // green
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
};

const RESET = '\x1b[0m';

class Logger {
  private config: LoggerConfig = {
    level: 'info',
    console: true,
    file: false,
  };

  private logBuffer: LogEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
    
    if (this.config.file && !this.flushInterval) {
      // Start periodic flush for file logging
      this.flushInterval = setInterval(() => this.flushToFile(), 1000);
    }
  }

  setWorkspace(workspace: string): void {
    this.config.workspace = workspace;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  private formatEntry(entry: LogEntry, useColors: boolean): string {
    const color = useColors ? LOG_COLORS[entry.level] : '';
    const reset = useColors ? RESET : '';
    const levelStr = entry.level.toUpperCase().padEnd(5);
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    
    return `${entry.timestamp} ${color}[${levelStr}]${reset} [${entry.category}] ${entry.message}${dataStr}`;
  }

  private log(level: LogLevel, category: string, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data,
    };

    if (this.config.console) {
      console.log(this.formatEntry(entry, true));
    }

    if (this.config.file) {
      this.logBuffer.push(entry);
    }
  }

  private async flushToFile(): Promise<void> {
    if (this.logBuffer.length === 0) return;

    const entries = this.logBuffer.splice(0, this.logBuffer.length);
    const workspace = this.config.workspace || process.cwd();
    const logDir = join(workspace, '.consensus', 'logs');
    const logFile = this.config.filePath || join(logDir, `consensus-${new Date().toISOString().split('T')[0]}.log`);

    try {
      await mkdir(logDir, { recursive: true });
      const content = entries.map(e => this.formatEntry(e, false)).join('\n') + '\n';
      await appendFile(logFile, content, 'utf-8');
    } catch (error) {
      // Fallback to console if file writing fails
      console.error('Failed to write to log file:', error);
    }
  }

  async flush(): Promise<void> {
    await this.flushToFile();
  }

  debug(category: string, message: string, data?: unknown): void {
    this.log('debug', category, message, data);
  }

  info(category: string, message: string, data?: unknown): void {
    this.log('info', category, message, data);
  }

  warn(category: string, message: string, data?: unknown): void {
    this.log('warn', category, message, data);
  }

  error(category: string, message: string, data?: unknown): void {
    this.log('error', category, message, data);
  }

  // Convenience methods for specific categories
  engine(message: string, data?: unknown): void {
    this.debug('Engine', message, data);
  }

  agent(agentName: string, message: string, data?: unknown): void {
    this.debug(`Agent:${agentName}`, message, data);
  }

  moderator(message: string, data?: unknown): void {
    this.debug('Moderator', message, data);
  }

  provider(providerName: string, message: string, data?: unknown): void {
    this.debug(`Provider:${providerName}`, message, data);
  }

  api(message: string, data?: unknown): void {
    this.debug('API', message, data);
  }

  session(message: string, data?: unknown): void {
    this.info('Session', message, data);
  }

  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flushToFile();
  }
}

// Global logger instance
export const logger = new Logger();

// Enable debug mode from environment
if (process.env.DEBUG === 'true' || process.env.CONSENSUS_DEBUG === 'true') {
  logger.configure({ level: 'debug', file: true });
}
