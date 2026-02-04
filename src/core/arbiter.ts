/**
 * Arbiter - Tie-breaking mechanism for deadlocked discussions
 * 
 * The Arbiter is invoked when:
 * 1. Critical blockers remain unresolved after multiple rounds
 * 2. Specialists are gridlocked on a decision
 * 3. Consensus cannot be reached within limits
 * 
 * The Arbiter makes a one-shot decision to break the deadlock.
 */

import { nanoid } from 'nanoid';
import type {
  ArbiterConfig,
  ArbiterDecision,
  Blocker,
  StructuredState,
  LLMProvider,
  ChatMessage,
} from './types.js';
import { createProvider } from '../providers/index.js';
import { logger } from './logger.js';

export class Arbiter {
  private provider: LLMProvider;
  private config: ArbiterConfig;

  constructor(config: ArbiterConfig) {
    this.config = config;
    this.provider = createProvider(config.provider, {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
  }

  /**
   * Check if arbiter provider is available
   */
  async isAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }

  /**
   * Build the system prompt for the arbiter
   */
  private buildSystemPrompt(): string {
    return `You are an ARBITER in a multi-agent consensus discussion. Your role is to make final, binding decisions when agents reach a deadlock.

YOUR RESPONSIBILITIES:
- Review conflicting positions objectively
- Make a clear, reasoned decision
- Provide justification that acknowledges both sides
- Keep decisions actionable and specific

DECISION OPTIONS:
- ACCEPT: The blocker/concern is valid and should be addressed
- REJECT: The blocker/concern is not critical enough to block progress
- MERGE: Combine elements from both positions into a resolution

OUTPUT FORMAT:
You must respond with a JSON object:
{
  "decision": "accept" | "reject" | "merge",
  "rationale": "Clear explanation of your reasoning (2-3 sentences)",
  "mergedResolution": "If merge, the combined solution (required for merge, optional otherwise)"
}

Be decisive. Your goal is to unblock progress, not to achieve perfect consensus.`;
  }

  /**
   * Resolve a disputed blocker
   */
  async resolveBlocker(
    blocker: Blocker,
    context: StructuredState,
    disputeContext?: string
  ): Promise<ArbiterDecision> {
    logger.info('Arbiter', `Resolving blocker: ${blocker.id}`, {
      condition: blocker.condition,
      severity: blocker.severity,
    });

    const prompt = `A blocker has been raised that cannot be resolved through normal discussion.

BLOCKER DETAILS:
- Condition: ${blocker.condition}
- Impact: ${blocker.impact}
- Detection: ${blocker.detection}
- Proposed Mitigation: ${blocker.mitigation}
- Severity: ${blocker.severity}/5
- Confidence: ${blocker.confidence}/5
- Raised by: ${blocker.raisedBy}

CURRENT DISCUSSION STATE:
Problem: ${context.problem}
Consensus Level: ${Math.round(context.consensusLevel)}%
Open Questions: ${context.openQuestions.length}
Other Blockers: ${context.blockers.filter(b => b.id !== blocker.id && b.status === 'open').length}

${disputeContext ? `DISPUTE CONTEXT:\n${disputeContext}\n` : ''}

Please make a decision on this blocker. Should it be accepted (blocking progress until resolved), rejected (allowing progress despite the concern), or merged (combining the concern with the current approach)?`;

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: prompt },
    ];

    try {
      const response = await this.provider.chat(messages, {
        temperature: 0.3, // Lower temperature for more consistent decisions
        maxTokens: 500,
      });

      // Parse the response
      const decision = this.parseDecision(response, blocker.id);
      logger.info('Arbiter', `Decision: ${decision.decision}`, { rationale: decision.rationale });
      return decision;
    } catch (error) {
      logger.error('Arbiter', 'Failed to resolve blocker', { error });
      // Default to merge on error to avoid blocking
      return {
        blockerId: blocker.id,
        decision: 'merge',
        rationale: 'Arbiter encountered an error; defaulting to merge to maintain progress.',
        mergedResolution: blocker.mitigation,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Resolve a deadlock between multiple options
   */
  async resolveDeadlock(
    options: Array<{ id: string; proposal: string; supporters: string[]; opponents: string[] }>,
    context: StructuredState
  ): Promise<{ winnerId: string; rationale: string }> {
    logger.info('Arbiter', `Resolving deadlock between ${options.length} options`);

    const optionsText = options.map((opt, i) => 
      `Option ${i + 1} [${opt.id}]: ${opt.proposal}
   Supporters: ${opt.supporters.length} | Opponents: ${opt.opponents.length}`
    ).join('\n\n');

    const prompt = `Multiple options are deadlocked with no clear winner.

OPTIONS:
${optionsText}

CONTEXT:
Problem: ${context.problem}
Constraints: ${context.constraints.join(', ')}
Open Blockers: ${context.blockers.filter(b => b.status === 'open').length}

Which option should be selected? Consider:
1. Alignment with the problem statement
2. Feasibility given constraints
3. Risk profile
4. Potential for addressing open blockers

Respond with JSON:
{
  "winnerId": "the ID of the winning option",
  "rationale": "2-3 sentence explanation"
}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: prompt },
    ];

    try {
      const response = await this.provider.chat(messages, {
        temperature: 0.3,
        maxTokens: 300,
      });

      // Parse response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          winnerId: parsed.winnerId || options[0].id,
          rationale: parsed.rationale || 'Arbiter selected this option.',
        };
      }
    } catch (error) {
      logger.error('Arbiter', 'Failed to resolve deadlock', { error });
    }

    // Default to first option with most supporters
    const sorted = [...options].sort((a, b) => b.supporters.length - a.supporters.length);
    return {
      winnerId: sorted[0].id,
      rationale: 'Arbiter defaulted to option with most support.',
    };
  }

  /**
   * Parse arbiter response into decision
   */
  private parseDecision(response: string, blockerId: string): ArbiterDecision {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          blockerId,
          decision: parsed.decision || 'merge',
          rationale: parsed.rationale || 'Decision made by arbiter.',
          mergedResolution: parsed.mergedResolution,
          timestamp: new Date(),
        };
      }
    } catch {
      // If JSON parsing fails, try to infer decision from text
      const lower = response.toLowerCase();
      let decision: 'accept' | 'reject' | 'merge' = 'merge';
      if (lower.includes('accept') || lower.includes('valid concern')) {
        decision = 'accept';
      } else if (lower.includes('reject') || lower.includes('not critical')) {
        decision = 'reject';
      }

      return {
        blockerId,
        decision,
        rationale: response.slice(0, 200),
        timestamp: new Date(),
      };
    }

    return {
      blockerId,
      decision: 'merge',
      rationale: 'Unable to parse decision; defaulting to merge.',
      timestamp: new Date(),
    };
  }

  /**
   * Determine if arbitration is needed
   */
  static needsArbitration(state: StructuredState, maxOpenBlockers: number = 3): boolean {
    const criticalBlockers = state.blockers.filter(
      b => (b.status === 'open' || b.status === 'disputed') && 
           b.severity >= 4 && b.confidence >= 4
    );

    // Need arbitration if:
    // 1. Too many critical blockers
    if (criticalBlockers.length >= maxOpenBlockers) return true;

    // 2. Consensus too low with no progress
    if (state.consensusLevel < 30 && state.decisions.length === 0) return true;

    // 3. Options are deadlocked (equal support)
    const topOptions = state.options
      .filter(o => o.supporters.length > 0)
      .sort((a, b) => b.supporters.length - a.supporters.length);
    
    if (topOptions.length >= 2 && 
        topOptions[0].supporters.length === topOptions[1].supporters.length) {
      return true;
    }

    return false;
  }
}
