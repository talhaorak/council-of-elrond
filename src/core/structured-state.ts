/**
 * Structured State Manager
 * Manages a compact JSON state instead of full transcript for context passing
 */

import { nanoid } from 'nanoid';
import type {
  StructuredState,
  DiscussionOption,
  Blocker,
  Message,
  AgentMessage,
  ConsensusMetrics,
} from './types.js';
import { logger } from './logger.js';

/**
 * Manages structured state for a discussion
 */
export class StructuredStateManager {
  private state: StructuredState;

  constructor(problem: string, constraints: string[] = []) {
    this.state = {
      problem,
      constraints,
      options: [],
      openQuestions: [],
      decisions: [],
      blockers: [],
      consensusLevel: 0,
    };
  }

  /**
   * Get current state
   */
  getState(): StructuredState {
    return { ...this.state };
  }

  /**
   * Add a proposal/option
   */
  addOption(option: Omit<DiscussionOption, 'id'>): DiscussionOption {
    const fullOption: DiscussionOption = {
      id: nanoid(8),
      ...option,
    };
    this.state.options.push(fullOption);
    logger.debug('StructuredState', `Added option: ${option.proposal.slice(0, 50)}...`);
    return fullOption;
  }

  /**
   * Update an existing option
   */
  updateOption(optionId: string, updates: Partial<DiscussionOption>): void {
    const index = this.state.options.findIndex(o => o.id === optionId);
    if (index !== -1) {
      this.state.options[index] = { ...this.state.options[index], ...updates };
    }
  }

  /**
   * Add support/opposition to an option
   */
  recordVote(optionId: string, agentId: string, support: boolean): void {
    const option = this.state.options.find(o => o.id === optionId);
    if (!option) return;

    if (support) {
      if (!option.supporters.includes(agentId)) {
        option.supporters.push(agentId);
      }
      option.opponents = option.opponents.filter(id => id !== agentId);
    } else {
      if (!option.opponents.includes(agentId)) {
        option.opponents.push(agentId);
      }
      option.supporters = option.supporters.filter(id => id !== agentId);
    }

    this.updateConsensusLevel();
  }

  /**
   * Add a blocker
   */
  addBlocker(blocker: Omit<Blocker, 'id' | 'status'>): Blocker {
    const fullBlocker: Blocker = {
      id: nanoid(8),
      status: 'open',
      ...blocker,
    };
    this.state.blockers.push(fullBlocker);
    logger.info('StructuredState', `Blocker raised: ${blocker.condition.slice(0, 50)}...`, {
      severity: blocker.severity,
      confidence: blocker.confidence,
    });
    return fullBlocker;
  }

  /**
   * Update blocker status
   */
  resolveBlocker(blockerId: string, resolution: string): void {
    const blocker = this.state.blockers.find(b => b.id === blockerId);
    if (blocker) {
      blocker.status = 'addressed';
      blocker.resolution = resolution;
      logger.info('StructuredState', `Blocker resolved: ${blockerId}`);
    }
  }

  /**
   * Escalate blocker
   */
  escalateBlocker(blockerId: string): void {
    const blocker = this.state.blockers.find(b => b.id === blockerId);
    if (blocker) {
      blocker.status = 'escalated';
      logger.warn('StructuredState', `Blocker escalated: ${blockerId}`);
    }
  }

  /**
   * Get open blockers
   */
  getOpenBlockers(): Blocker[] {
    return this.state.blockers.filter(b => b.status === 'open' || b.status === 'disputed');
  }

  /**
   * Get critical blockers (severity >= 4, confidence >= 4)
   */
  getCriticalBlockers(): Blocker[] {
    return this.state.blockers.filter(
      b => (b.status === 'open' || b.status === 'disputed') && 
           b.severity >= 4 && b.confidence >= 4
    );
  }

  /**
   * Add an open question
   */
  addOpenQuestion(question: string): void {
    if (!this.state.openQuestions.includes(question)) {
      this.state.openQuestions.push(question);
    }
  }

  /**
   * Remove an open question (when answered)
   */
  resolveQuestion(question: string): void {
    this.state.openQuestions = this.state.openQuestions.filter(q => q !== question);
  }

  /**
   * Record a decision
   */
  addDecision(decision: string, rationale: string, supporters: string[]): void {
    this.state.decisions.push({
      decision,
      rationale,
      madeAt: new Date(),
      supporters,
    });
    logger.info('StructuredState', `Decision recorded: ${decision.slice(0, 50)}...`);
  }

  /**
   * Update consensus level based on current state
   */
  private updateConsensusLevel(): void {
    if (this.state.options.length === 0) {
      this.state.consensusLevel = 0;
      return;
    }

    // Find the option with most support
    let maxSupport = 0;
    let totalAgents = 0;

    for (const option of this.state.options) {
      const support = option.supporters.length;
      if (support > maxSupport) maxSupport = support;
      totalAgents = Math.max(totalAgents, option.supporters.length + option.opponents.length);
    }

    // Consensus level = percentage of agents supporting the leading option
    this.state.consensusLevel = totalAgents > 0 ? (maxSupport / totalAgents) * 100 : 0;
  }

  /**
   * Calculate consensus metrics
   */
  calculateMetrics(totalAgents: number): ConsensusMetrics {
    const openBlockers = this.getOpenBlockers();
    const resolvedBlockers = this.state.blockers.filter(b => b.status === 'addressed');

    // Calculate average confidence from blockers
    const allBlockerConfidences = this.state.blockers.map(b => b.confidence);
    const avgConfidence = allBlockerConfidences.length > 0
      ? allBlockerConfidences.reduce((a, b) => a + b, 0) / allBlockerConfidences.length
      : 5; // Default to high confidence if no blockers

    // Find leading option
    let leadingOption: DiscussionOption | null = null;
    for (const option of this.state.options) {
      if (!leadingOption || option.supporters.length > leadingOption.supporters.length) {
        leadingOption = option;
      }
    }

    // Key agreements = leading option's pros that have support
    const keyAgreements: string[] = leadingOption?.pros.slice(0, 3) || [];

    // Key disagreements = open blocker conditions
    const keyDisagreements: string[] = openBlockers.slice(0, 3).map(b => b.condition);

    // Convergence round = if consensus > 70%, note when it happened
    const convergenceRound = this.state.consensusLevel >= 70 ? this.state.decisions.length : null;

    return {
      agreementLevel: this.state.consensusLevel / 100,
      keyAgreements,
      keyDisagreements,
      blockerCount: openBlockers.length,
      resolvedBlockerCount: resolvedBlockers.length,
      averageConfidence: avgConfidence,
      convergenceRound,
    };
  }

  /**
   * Convert state to compact context string for LLM
   */
  toContextString(): string {
    const lines: string[] = [
      '=== DISCUSSION STATE ===',
      '',
      `PROBLEM: ${this.state.problem}`,
      '',
    ];

    if (this.state.constraints.length > 0) {
      lines.push('CONSTRAINTS:');
      this.state.constraints.forEach(c => lines.push(`  - ${c}`));
      lines.push('');
    }

    if (this.state.options.length > 0) {
      lines.push('PROPOSED OPTIONS:');
      for (const opt of this.state.options) {
        lines.push(`  [${opt.id}] ${opt.proposal}`);
        lines.push(`      Proposed by: ${opt.proposedBy}`);
        lines.push(`      Support: ${opt.supporters.length} | Oppose: ${opt.opponents.length}`);
        if (opt.pros.length > 0) {
          lines.push(`      Pros: ${opt.pros.join('; ')}`);
        }
        if (opt.cons.length > 0) {
          lines.push(`      Cons: ${opt.cons.join('; ')}`);
        }
        if (opt.risks.length > 0) {
          lines.push(`      Risks: ${opt.risks.join('; ')}`);
        }
      }
      lines.push('');
    }

    const openBlockers = this.getOpenBlockers();
    if (openBlockers.length > 0) {
      lines.push('OPEN BLOCKERS:');
      for (const b of openBlockers) {
        lines.push(`  [${b.id}] Severity: ${b.severity}/5, Confidence: ${b.confidence}/5`);
        lines.push(`      Condition: ${b.condition}`);
        lines.push(`      Impact: ${b.impact}`);
        lines.push(`      Detection: ${b.detection}`);
        lines.push(`      Mitigation: ${b.mitigation}`);
      }
      lines.push('');
    }

    if (this.state.openQuestions.length > 0) {
      lines.push('OPEN QUESTIONS:');
      this.state.openQuestions.forEach(q => lines.push(`  - ${q}`));
      lines.push('');
    }

    if (this.state.decisions.length > 0) {
      lines.push('DECISIONS MADE:');
      for (const d of this.state.decisions) {
        lines.push(`  ✓ ${d.decision}`);
        lines.push(`    Rationale: ${d.rationale}`);
      }
      lines.push('');
    }

    lines.push(`CONSENSUS LEVEL: ${Math.round(this.state.consensusLevel)}%`);
    lines.push('=== END STATE ===');

    return lines.join('\n');
  }

  /**
   * Extract structured info from agent message and update state
   */
  processAgentMessage(message: AgentMessage): void {
    // Process blockers if present
    if (message.blockers) {
      for (const blocker of message.blockers) {
        // Check if this blocker already exists (similar condition)
        const existing = this.state.blockers.find(
          b => b.condition.toLowerCase() === blocker.condition.toLowerCase()
        );
        if (!existing) {
          this.addBlocker(blocker);
        }
      }
    }

    // Process proposal if present
    if (message.proposal) {
      const existing = this.state.options.find(
        o => o.proposal.toLowerCase() === message.proposal!.proposal.toLowerCase()
      );
      if (!existing) {
        this.addOption(message.proposal);
      }
    }

    // Update support/opposition based on stance
    if (message.stance === 'AGREE') {
      // Find the most recent option and add support
      const latestOption = this.state.options[this.state.options.length - 1];
      if (latestOption) {
        this.recordVote(latestOption.id, message.agentId, true);
      }
    } else if (message.stance === 'DISAGREE' || message.stance === 'CHALLENGE') {
      // Find the most recent option and add opposition
      const latestOption = this.state.options[this.state.options.length - 1];
      if (latestOption) {
        this.recordVote(latestOption.id, message.agentId, false);
      }
    }
  }

  /**
   * Create state from existing messages (for resuming sessions)
   */
  static fromMessages(problem: string, messages: Message[]): StructuredStateManager {
    const manager = new StructuredStateManager(problem);

    for (const msg of messages) {
      if ('agentId' in msg) {
        manager.processAgentMessage(msg as AgentMessage);
      }
    }

    return manager;
  }
}
