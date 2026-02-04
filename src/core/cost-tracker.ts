/**
 * Cost tracking for consensus discussions
 * Estimates API costs based on token usage
 */

import type {
  CostEntry,
  CostSummary,
  TokenUsage,
  Provider,
  Phase,
} from './types.js';
import { logger } from './logger.js';

// Pricing per 1M tokens (as of Feb 2026)
// These are estimates - actual prices may vary
const PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'openai/gpt-5.2': { input: 5.0, output: 15.0 },
  'openai/gpt-5.2-pro': { input: 10.0, output: 30.0 },
  'openai/gpt-5': { input: 3.0, output: 10.0 },
  'openai/gpt-5-mini': { input: 0.5, output: 1.5 },
  'openai/gpt-4o': { input: 2.5, output: 10.0 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/o3': { input: 15.0, output: 60.0 },
  'openai/o3-mini': { input: 3.0, output: 12.0 },
  
  // Anthropic
  'anthropic/claude-4.5-opus': { input: 15.0, output: 75.0 },
  'anthropic/claude-4.5-sonnet': { input: 3.0, output: 15.0 },
  'anthropic/claude-4.5-haiku': { input: 0.25, output: 1.25 },
  'anthropic/claude-sonnet-4': { input: 3.0, output: 15.0 },
  
  // Google
  'google/gemini-3-pro': { input: 1.25, output: 5.0 },
  'google/gemini-2.5-pro': { input: 1.25, output: 5.0 },
  'google/gemini-2.5-flash': { input: 0.075, output: 0.3 },
  'google/gemini-2.5-flash-lite': { input: 0.02, output: 0.08 },
  
  // DeepSeek
  'deepseek/deepseek-v3': { input: 0.14, output: 0.28 },
  'deepseek/deepseek-r1': { input: 0.55, output: 2.19 },
  
  // xAI
  'x-ai/grok-4': { input: 5.0, output: 15.0 },
  'x-ai/grok-3': { input: 3.0, output: 10.0 },
  
  // Moonshot
  'moonshotai/kimi-k2.5': { input: 0.5, output: 2.0 },
  
  // Meta (typically free via providers)
  'meta-llama/llama-3.3-70b': { input: 0.4, output: 0.4 },
  'meta-llama/llama-4-maverick-405b': { input: 2.0, output: 2.0 },
  
  // Default fallback
  '_default': { input: 1.0, output: 3.0 },
};

/**
 * Get pricing for a model
 */
function getPricing(provider: Provider, model: string): { input: number; output: number } {
  // Try exact match first
  const key = `${provider}/${model}`;
  if (PRICING[key]) return PRICING[key];
  
  // Try provider prefix match
  for (const [pricingKey, pricing] of Object.entries(PRICING)) {
    if (pricingKey.startsWith(`${provider}/`) && model.includes(pricingKey.split('/')[1])) {
      return pricing;
    }
  }
  
  // Try model name match (for OpenRouter)
  if (PRICING[model]) return PRICING[model];
  
  // Fallback
  return PRICING['_default'];
}

/**
 * Estimate cost in USD from token usage
 */
export function estimateCost(
  provider: Provider,
  model: string,
  tokens: TokenUsage
): number {
  const pricing = getPricing(provider, model);
  const inputCost = (tokens.promptTokens / 1_000_000) * pricing.input;
  const outputCost = (tokens.completionTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Cost tracker for a discussion session
 */
export class CostTracker {
  private entries: CostEntry[] = [];
  private startTime: Date;

  constructor(startTime: Date = new Date()) {
    this.startTime = startTime;
  }

  /**
   * Record a cost entry
   */
  record(entry: Omit<CostEntry, 'estimatedCost'>): CostEntry {
    const estimatedCost = estimateCost(entry.provider, entry.model, entry.tokens);
    const fullEntry: CostEntry = { ...entry, estimatedCost };
    this.entries.push(fullEntry);
    
    logger.debug('CostTracker', `Recorded cost: $${estimatedCost.toFixed(4)} for ${entry.agentName}`, {
      tokens: entry.tokens,
      model: entry.model,
    });
    
    return fullEntry;
  }

  /**
   * Load pre-existing cost entries (e.g., when resuming a session)
   */
  loadEntries(entries: CostEntry[]): void {
    this.entries = entries.map((entry) => ({ ...entry }));
  }

  /**
   * Create a tracker from existing entries
   */
  static fromEntries(entries: CostEntry[], startTime: Date = new Date()): CostTracker {
    const tracker = new CostTracker(startTime);
    tracker.loadEntries(entries);
    return tracker;
  }

  /**
   * Get total cost so far
   */
  getTotalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.estimatedCost, 0);
  }

  /**
   * Get total tokens used
   */
  getTotalTokens(): TokenUsage {
    return this.entries.reduce(
      (acc, e) => ({
        promptTokens: acc.promptTokens + e.tokens.promptTokens,
        completionTokens: acc.completionTokens + e.tokens.completionTokens,
        totalTokens: acc.totalTokens + e.tokens.totalTokens,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    );
  }

  /**
   * Get all entries
   */
  getEntries(): CostEntry[] {
    return [...this.entries];
  }

  /**
   * Get cost summary
   */
  getSummary(): CostSummary {
    const costByAgent: Record<string, number> = {};
    const costByPhase: Record<Phase, number> = {
      OPENING: 0,
      DISCUSSION: 0,
      SYNTHESIS: 0,
      CONSENSUS: 0,
    };
    const costByRound: Record<number, number> = {};

    for (const entry of this.entries) {
      // By agent
      costByAgent[entry.agentId] = (costByAgent[entry.agentId] || 0) + entry.estimatedCost;
      
      // By phase
      costByPhase[entry.phase] = (costByPhase[entry.phase] || 0) + entry.estimatedCost;
      
      // By round
      costByRound[entry.round] = (costByRound[entry.round] || 0) + entry.estimatedCost;
    }

    const totalCost = this.getTotalCost();
    const messageCount = this.entries.length;

    return {
      totalTokens: this.getTotalTokens(),
      totalCost,
      costByAgent,
      costByPhase,
      costByRound,
      averageCostPerMessage: messageCount > 0 ? totalCost / messageCount : 0,
    };
  }

  /**
   * Check if cost limit exceeded
   */
  isOverBudget(maxCostUsd: number): boolean {
    return this.getTotalCost() > maxCostUsd;
  }

  /**
   * Get elapsed time in milliseconds
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime.getTime();
  }

  /**
   * Format cost as string
   */
  static formatCost(cost: number): string {
    if (cost < 0.01) {
      return `$${(cost * 100).toFixed(2)}¢`;
    }
    return `$${cost.toFixed(4)}`;
  }

  /**
   * Format summary as string for display
   */
  formatSummary(): string {
    const summary = this.getSummary();
    const lines = [
      `Total Cost: ${CostTracker.formatCost(summary.totalCost)}`,
      `Total Tokens: ${summary.totalTokens.totalTokens.toLocaleString()} (${summary.totalTokens.promptTokens.toLocaleString()} in, ${summary.totalTokens.completionTokens.toLocaleString()} out)`,
      `Messages: ${this.entries.length}`,
      `Avg Cost/Message: ${CostTracker.formatCost(summary.averageCostPerMessage)}`,
      '',
      'By Phase:',
      ...Object.entries(summary.costByPhase)
        .filter(([, cost]) => cost > 0)
        .map(([phase, cost]) => `  ${phase}: ${CostTracker.formatCost(cost)}`),
    ];
    return lines.join('\n');
  }
}
