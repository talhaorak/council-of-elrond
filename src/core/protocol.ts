import type {
  Phase,
  Message,
  AgentMessage,
  ModeratorMessage,
  Stance,
} from './types.js';

/**
 * Protocol rules and state machine for the consensus discussion
 */
export class DiscussionProtocol {
  private currentPhase: Phase = 'OPENING';
  private currentRound: number = 0;
  private totalRounds: number;
  private agentCount: number;
  private messagesThisRound: number = 0;

  constructor(totalRounds: number, agentCount: number) {
    this.totalRounds = totalRounds;
    this.agentCount = agentCount;
  }

  /**
   * Get current protocol state
   */
  getState(): { phase: Phase; round: number } {
    return {
      phase: this.currentPhase,
      round: this.currentRound,
    };
  }

  /**
   * Start the discussion
   */
  start(): void {
    this.currentPhase = 'OPENING';
    this.currentRound = 1;
    this.messagesThisRound = 0;
  }

  /**
   * Record that an agent has spoken
   */
  recordAgentMessage(): void {
    this.messagesThisRound++;
  }

  /**
   * Check if all agents have spoken this round
   */
  isRoundComplete(): boolean {
    return this.messagesThisRound >= this.agentCount;
  }

  /**
   * Advance to the next round or phase
   */
  advance(): { newPhase: Phase; newRound: number; phaseChanged: boolean } {
    const oldPhase = this.currentPhase;
    this.messagesThisRound = 0;

    switch (this.currentPhase) {
      case 'OPENING':
        this.currentPhase = 'DISCUSSION';
        break;

      case 'DISCUSSION':
        if (this.currentRound >= this.totalRounds - 1) {
          this.currentPhase = 'SYNTHESIS';
        }
        this.currentRound++;
        break;

      case 'SYNTHESIS':
        this.currentPhase = 'CONSENSUS';
        this.currentRound++;
        break;

      case 'CONSENSUS':
        // Discussion complete
        break;
    }

    return {
      newPhase: this.currentPhase,
      newRound: this.currentRound,
      phaseChanged: oldPhase !== this.currentPhase,
    };
  }

  /**
   * Check if discussion is complete
   */
  isComplete(): boolean {
    return this.currentPhase === 'CONSENSUS' && this.isRoundComplete();
  }

  /**
   * Get guidance for the current phase
   */
  getPhaseGuidance(): string {
    switch (this.currentPhase) {
      case 'OPENING':
        return 'Share your initial perspective on the topic. What are the key considerations from your viewpoint?';
      
      case 'DISCUSSION':
        return 'Engage with other perspectives. Agree, disagree, or refine ideas. Reference specific points made by others.';
      
      case 'SYNTHESIS':
        return 'Work toward integrating the best ideas. Propose unified solutions that address multiple concerns.';
      
      case 'CONSENSUS':
        return 'State your final position. Confirm agreements or clearly note remaining disagreements.';
      
      default:
        return '';
    }
  }

  /**
   * Analyze consensus state from messages
   */
  static analyzeConsensus(messages: Message[]): {
    agreementLevel: number;
    dominantStance: Stance;
    keyAgreements: string[];
    keyDisagreements: string[];
  } {
    const agentMessages = messages.filter((m) => 'agentId' in m) as AgentMessage[];
    
    if (agentMessages.length === 0) {
      return {
        agreementLevel: 0,
        dominantStance: 'PROPOSE',
        keyAgreements: [],
        keyDisagreements: [],
      };
    }

    // Count stances
    const stanceCounts: Record<Stance, number> = {
      PROPOSE: 0,
      AGREE: 0,
      DISAGREE: 0,
      REFINE: 0,
      CHALLENGE: 0,
      PASS: 0,
    };

    for (const msg of agentMessages) {
      stanceCounts[msg.stance]++;
    }

    // Calculate agreement level (0-1)
    const positiveStances = stanceCounts.AGREE + stanceCounts.REFINE;
    const negativeStances = stanceCounts.DISAGREE + stanceCounts.CHALLENGE;
    const total = agentMessages.length;
    
    const agreementLevel = total > 0 
      ? (positiveStances - negativeStances * 0.5 + total) / (2 * total)
      : 0;

    // Find dominant stance
    const dominantStance = (Object.entries(stanceCounts) as [Stance, number][])
      .sort((a, b) => b[1] - a[1])[0][0];

    // Extract key points
    const allKeyPoints = agentMessages.flatMap((m) => m.keyPoints);
    const pointCounts = new Map<string, number>();
    
    for (const point of allKeyPoints) {
      const normalized = point.toLowerCase().trim();
      pointCounts.set(normalized, (pointCounts.get(normalized) || 0) + 1);
    }

    // Points mentioned by multiple agents are agreements
    const keyAgreements = [...pointCounts.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([point]) => point);

    // Extract disagreements from DISAGREE/CHALLENGE messages
    const keyDisagreements = agentMessages
      .filter((m) => m.stance === 'DISAGREE' || m.stance === 'CHALLENGE')
      .flatMap((m) => m.keyPoints)
      .slice(0, 5);

    return {
      agreementLevel: Math.max(0, Math.min(1, agreementLevel)),
      dominantStance,
      keyAgreements,
      keyDisagreements,
    };
  }

  /**
   * Determine speaking order for a round
   * Can be round-robin, random, or based on previous engagement
   */
  static determineSpeakingOrder(
    agentIds: string[],
    messages: Message[],
    strategy: 'round-robin' | 'random' | 'engagement' = 'round-robin'
  ): string[] {
    switch (strategy) {
      case 'random':
        return [...agentIds].sort(() => Math.random() - 0.5);

      case 'engagement': {
        // Agents who were referenced more speak later (respond to critiques)
        const referenceCounts = new Map<string, number>();
        for (const id of agentIds) {
          referenceCounts.set(id, 0);
        }
        
        const agentMessages = messages.filter((m) => 'agentId' in m) as AgentMessage[];
        for (const msg of agentMessages) {
          // Simple heuristic: count name mentions in content
          for (const id of agentIds) {
            if (msg.content.includes(id)) {
              referenceCounts.set(id, (referenceCounts.get(id) || 0) + 1);
            }
          }
        }
        
        return [...agentIds].sort(
          (a, b) => (referenceCounts.get(a) || 0) - (referenceCounts.get(b) || 0)
        );
      }

      case 'round-robin':
      default:
        return [...agentIds];
    }
  }

  /**
   * Validate that a message follows protocol rules
   */
  static validateMessage(
    message: AgentMessage,
    phase: Phase,
    previousMessages: Message[]
  ): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check content length
    if (message.content.length < 50) {
      issues.push('Response too short - please provide more substantive input');
    }

    if (message.content.length > 5000) {
      issues.push('Response too long - please be more concise');
    }

    // Check for required elements
    if (message.keyPoints.length === 0) {
      issues.push('No key points extracted - please structure response with [KEY_POINTS: ...]');
    }

    // Phase-specific validation
    if (phase === 'CONSENSUS' && message.stance === 'PASS') {
      issues.push('Cannot PASS during consensus phase - please state your final position');
    }

    // Check for engagement with others (except in opening)
    if (phase !== 'OPENING' && previousMessages.length > 0) {
      const otherAgentNames = [...new Set(
        previousMessages
          .filter((m) => 'agentId' in m && m.agentId !== message.agentId)
          .map((m) => (m as AgentMessage).agentName)
      )];

      const mentionsOthers = otherAgentNames.some((name) =>
        message.content.toLowerCase().includes(name.toLowerCase())
      );

      if (!mentionsOthers && otherAgentNames.length > 0) {
        issues.push('Consider engaging with other participants\' points');
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }
}
