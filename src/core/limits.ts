/**
 * Limits and Abort Conditions for Consensus Discussions
 * 
 * Implements hard limits to prevent runaway costs/time
 * and decision gates for evaluating discussion quality.
 */

import type {
  DiscussionLimits,
  AbortReason,
  ConsensusMetrics,
  DecisionGate,
  StructuredState,
  Blocker,
} from './types.js';
import type { CostTracker } from './cost-tracker.js';
import { logger } from './logger.js';

/**
 * Default limits if none specified
 */
export const DEFAULT_LIMITS: DiscussionLimits = {
  maxCostUsd: 15.0,                    // $15 max per discussion
  maxDurationMs: 45 * 60 * 1000,       // 45 minutes max (7 agents × 3 rounds need time)
  maxTokens: 500000,                   // 500k tokens (7 verbose agents)
  maxBlockers: 20,                     // 20 unresolved blockers triggers abort
  maxConsecutiveDisagreements: 3,      // 3 consecutive disagreements triggers arbitration
  requireHumanDecision: false,
};

/**
 * Check if any limits have been exceeded
 */
export function checkLimits(
  limits: DiscussionLimits,
  costTracker: CostTracker,
  openBlockers: Blocker[]
): AbortReason | null {
  // Check cost limit (0 means unlimited — skip check)
  if (limits.maxCostUsd !== undefined && limits.maxCostUsd > 0) {
    const currentCost = costTracker.getTotalCost();
    if (currentCost > limits.maxCostUsd) {
      logger.warn('Limits', `Cost limit exceeded: $${currentCost.toFixed(2)} > $${limits.maxCostUsd}`);
      return {
        type: 'cost_limit',
        spent: currentCost,
        limit: limits.maxCostUsd,
      };
    }
  }

  // Check time limit
  if (limits.maxDurationMs !== undefined) {
    const elapsed = costTracker.getElapsedMs();
    if (elapsed > limits.maxDurationMs) {
      logger.warn('Limits', `Time limit exceeded: ${elapsed}ms > ${limits.maxDurationMs}ms`);
      return {
        type: 'time_limit',
        elapsed,
        limit: limits.maxDurationMs,
      };
    }
  }

  // Check token limit
  if (limits.maxTokens !== undefined) {
    const tokens = costTracker.getTotalTokens().totalTokens;
    if (tokens > limits.maxTokens) {
      logger.warn('Limits', `Token limit exceeded: ${tokens} > ${limits.maxTokens}`);
      return {
        type: 'token_limit',
        used: tokens,
        limit: limits.maxTokens,
      };
    }
  }

  // Check blocker limit
  if (limits.maxBlockers !== undefined) {
    const blockerCount = openBlockers.filter(b => b.status === 'open' || b.status === 'disputed').length;
    if (blockerCount >= limits.maxBlockers) {
      logger.warn('Limits', `Blocker limit exceeded: ${blockerCount} >= ${limits.maxBlockers}`);
      return {
        type: 'blocker_limit',
        count: blockerCount,
        limit: limits.maxBlockers,
      };
    }
  }

  // Check for critical blockers that need human decision (optional)
  if (limits.requireHumanDecision) {
    const criticalBlockers = openBlockers.filter(
      b => (b.status === 'open' || b.status === 'escalated') && 
           b.severity >= 4 && b.confidence >= 4
    );
    if (criticalBlockers.length > 0) {
      logger.warn('Limits', `${criticalBlockers.length} critical blocker(s) need human decision`);
      return {
        type: 'needs_human',
        blockers: criticalBlockers,
      };
    }
  }

  return null;
}

/**
 * Calculate decision gate status
 * Based on the consensus protocol's pre-registered gates:
 * - GO: agreement >= 70%, cost <= limit, no critical blockers
 * - NO-GO: agreement <= 45% OR cost > limit
 * - EXPAND: agreement 46-69% OR unresolved questions
 * - NEEDS-HUMAN: critical blockers present
 */
export function calculateDecisionGate(
  metrics: ConsensusMetrics,
  costTracker: CostTracker,
  limits: DiscussionLimits = DEFAULT_LIMITS,
  openBlockers: Blocker[] = []
): DecisionGate {
  const costSpent = costTracker.getTotalCost();
  const costLimit = limits.maxCostUsd || 5.0;
  const timeSpent = costTracker.getElapsedMs();
  const agreementLevel = metrics.agreementLevel * 100; // Convert to percentage

  // Check for critical blockers (only gates when requireHumanDecision is enabled)
  if (limits.requireHumanDecision) {
    const criticalBlockers = openBlockers.filter(
      b => (b.status === 'open' || b.status === 'escalated') &&
           b.severity >= 4 && b.confidence >= 4
    );

    if (criticalBlockers.length > 0) {
      return {
        name: 'Decision Gate',
        condition: 'needs-human',
        metrics: {
          agreementLevel,
          costSpent,
          costLimit,
          blockerCount: criticalBlockers.length,
          timeSpent,
        },
        recommendation: `${criticalBlockers.length} critical blocker(s) require human decision. Review blockers and provide guidance.`,
      };
    }
  }

  // NO-GO conditions
  if (agreementLevel <= 45 || costSpent > costLimit) {
    const reasons: string[] = [];
    if (agreementLevel <= 45) reasons.push(`low agreement (${agreementLevel.toFixed(0)}%)`);
    if (costSpent > costLimit) reasons.push(`over budget ($${costSpent.toFixed(2)})`);
    
    return {
      name: 'Decision Gate',
      condition: 'no-go',
      metrics: {
        agreementLevel,
        costSpent,
        costLimit,
        blockerCount: metrics.blockerCount,
        timeSpent,
      },
      recommendation: `Discussion did not meet success criteria: ${reasons.join(', ')}. Consider simplifying the topic or adjusting approach.`,
    };
  }

  // GO conditions
  if (agreementLevel >= 70 && costSpent <= costLimit && metrics.blockerCount === 0) {
    return {
      name: 'Decision Gate',
      condition: 'go',
      metrics: {
        agreementLevel,
        costSpent,
        costLimit,
        blockerCount: metrics.blockerCount,
        timeSpent,
      },
      recommendation: `Discussion successful! ${agreementLevel.toFixed(0)}% agreement achieved within budget ($${costSpent.toFixed(2)}).`,
    };
  }

  // EXPAND (ambiguous) - need more discussion or evaluation
  return {
    name: 'Decision Gate',
    condition: 'expand',
    metrics: {
      agreementLevel,
      costSpent,
      costLimit,
      blockerCount: metrics.blockerCount,
      timeSpent,
    },
    recommendation: `Results ambiguous (${agreementLevel.toFixed(0)}% agreement). Consider additional rounds or clarifying questions.`,
  };
}

/**
 * Format limits for display
 */
export function formatLimits(limits: DiscussionLimits): string {
  const parts: string[] = [];
  
  if (limits.maxCostUsd !== undefined) {
    parts.push(`Cost: $${limits.maxCostUsd.toFixed(2)}`);
  }
  if (limits.maxDurationMs !== undefined) {
    const mins = limits.maxDurationMs / 60000;
    parts.push(`Time: ${mins}min`);
  }
  if (limits.maxTokens !== undefined) {
    parts.push(`Tokens: ${limits.maxTokens.toLocaleString()}`);
  }
  if (limits.maxBlockers !== undefined) {
    parts.push(`Max Blockers: ${limits.maxBlockers}`);
  }

  return parts.join(' | ');
}

/**
 * Create a progress summary
 */
export function createProgressSummary(
  metrics: ConsensusMetrics,
  costTracker: CostTracker,
  limits: DiscussionLimits
): string {
  const cost = costTracker.getTotalCost();
  const tokens = costTracker.getTotalTokens();
  const elapsed = costTracker.getElapsedMs();
  
  const costPct = limits.maxCostUsd ? (cost / limits.maxCostUsd * 100) : 0;
  const timePct = limits.maxDurationMs ? (elapsed / limits.maxDurationMs * 100) : 0;
  const tokenPct = limits.maxTokens ? (tokens.totalTokens / limits.maxTokens * 100) : 0;

  return `
Progress Summary:
  Agreement: ${(metrics.agreementLevel * 100).toFixed(0)}%
  Cost: $${cost.toFixed(4)} (${costPct.toFixed(0)}% of limit)
  Time: ${(elapsed / 1000).toFixed(0)}s (${timePct.toFixed(0)}% of limit)
  Tokens: ${tokens.totalTokens.toLocaleString()} (${tokenPct.toFixed(0)}% of limit)
  Open Blockers: ${metrics.blockerCount}
  Resolved Blockers: ${metrics.resolvedBlockerCount}
  Convergence: ${metrics.convergenceRound ? `Round ${metrics.convergenceRound}` : 'Not yet'}
`.trim();
}
