import { writeFile } from 'fs/promises';
import type {
  ConsensusOutput,
  Message,
  AgentMessage,
  ModeratorMessage,
  SessionState,
  Blocker,
  CostSummary,
  ConsensusMetrics,
} from '../core/types.js';
import { CostTracker } from '../core/cost-tracker.js';

/**
 * Generate markdown output from consensus discussion
 */
export function generateMarkdown(output: ConsensusOutput): string {
  const { session, summary, transcript } = output;
  const lines: string[] = [];

  // YAML Frontmatter (for continuation support)
  lines.push('---');
  lines.push(`session_id: "${session.id}"`);
  lines.push(`topic: "${escapeYaml(summary.topic)}"`);
  lines.push(`created_at: "${session.createdAt}"`);
  lines.push(`completed_at: "${session.updatedAt}"`);
  lines.push(`participants: ${summary.participantCount}`);
  lines.push(`rounds: ${summary.roundCount}`);
  lines.push(`consensus_reached: ${summary.consensusReached}`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# Consensus Discussion: ${summary.topic}`);
  lines.push('');

  // Executive Summary
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(summary.finalConsensus);
  lines.push('');

  // Participants
  lines.push('## Participants');
  lines.push('');
  lines.push('| Agent | Personality | Key Contributions |');
  lines.push('|-------|-------------|-------------------|');
  for (const agent of summary.agentSummaries) {
    const contributions = agent.keyContributions.slice(0, 3).join('; ') || 'N/A';
    lines.push(`| ${agent.agentName} | ${agent.personality} | ${contributions} |`);
  }
  lines.push('');

  // Key Agreements
  if (summary.keyAgreements.length > 0) {
    lines.push('## Key Agreements');
    lines.push('');
    for (const agreement of summary.keyAgreements) {
      lines.push(`- ${agreement}`);
    }
    lines.push('');
  }

  // Remaining Disagreements
  if (summary.remainingDisagreements.length > 0) {
    lines.push('## Areas of Disagreement');
    lines.push('');
    for (const disagreement of summary.remainingDisagreements) {
      lines.push(`- ${disagreement}`);
    }
    lines.push('');
  }

  // Blockers (if any)
  const blockers = session.structuredState?.blockers || [];
  if (blockers.length > 0) {
    lines.push('## Blockers & Concerns');
    lines.push('');
    
    const openBlockers = blockers.filter(b => b.status === 'open' || b.status === 'disputed');
    const resolvedBlockers = blockers.filter(b => b.status === 'addressed');
    
    if (openBlockers.length > 0) {
      lines.push('### Open Blockers');
      lines.push('');
      for (const blocker of openBlockers) {
        lines.push(`#### ⚠️ [${blocker.severity}/5] ${blocker.condition}`);
        lines.push('');
        lines.push(`- **Impact:** ${blocker.impact}`);
        lines.push(`- **Detection:** ${blocker.detection}`);
        lines.push(`- **Mitigation:** ${blocker.mitigation}`);
        lines.push(`- **Confidence:** ${blocker.confidence}/5`);
        lines.push(`- **Raised by:** ${blocker.raisedBy}`);
        lines.push('');
      }
    }
    
    if (resolvedBlockers.length > 0) {
      lines.push('### Resolved Blockers');
      lines.push('');
      for (const blocker of resolvedBlockers) {
        lines.push(`- ✅ ${blocker.condition} — *${blocker.resolution || 'Resolved'}*`);
      }
      lines.push('');
    }
  }

  // Consensus Metrics
  if (session.metrics) {
    lines.push('## Discussion Metrics');
    lines.push('');
    lines.push(`- **Agreement Level:** ${(session.metrics.agreementLevel * 100).toFixed(0)}%`);
    lines.push(`- **Blockers Raised:** ${session.metrics.blockerCount}`);
    lines.push(`- **Blockers Resolved:** ${session.metrics.resolvedBlockerCount}`);
    if (session.metrics.convergenceRound) {
      lines.push(`- **Convergence Round:** ${session.metrics.convergenceRound}`);
    }
    lines.push('');
  }

  // Cost Summary
  if (session.costSummary) {
    lines.push('## Cost Summary');
    lines.push('');
    lines.push(`- **Total Cost:** ${CostTracker.formatCost(session.costSummary.totalCost)}`);
    lines.push(`- **Total Tokens:** ${session.costSummary.totalTokens.totalTokens.toLocaleString()}`);
    lines.push(`  - Input: ${session.costSummary.totalTokens.promptTokens.toLocaleString()}`);
    lines.push(`  - Output: ${session.costSummary.totalTokens.completionTokens.toLocaleString()}`);
    lines.push(`- **Avg Cost/Message:** ${CostTracker.formatCost(session.costSummary.averageCostPerMessage)}`);
    lines.push('');
    
    // Cost by agent
    if (Object.keys(session.costSummary.costByAgent).length > 0) {
      lines.push('### Cost by Agent');
      lines.push('');
      lines.push('| Agent | Cost |');
      lines.push('|-------|------|');
      for (const [agentId, cost] of Object.entries(session.costSummary.costByAgent)) {
        const agent = summary.agentSummaries.find(a => a.agentName.includes(agentId.slice(0, 8)));
        const name = agent?.agentName || agentId.slice(0, 8);
        lines.push(`| ${name} | ${CostTracker.formatCost(cost)} |`);
      }
      lines.push('');
    }
  }

  // Full Transcript
  lines.push('## Full Transcript');
  lines.push('');
  lines.push('<details>');
  lines.push('<summary>Click to expand full discussion</summary>');
  lines.push('');

  let currentPhase = '';
  let currentRound = 0;

  for (const message of transcript) {
    // Phase/Round headers
    const phase = 'phase' in message ? message.phase : '';
    const round = 'round' in message ? message.round : 0;

    if (phase !== currentPhase) {
      currentPhase = phase;
      lines.push(`### Phase: ${phase}`);
      lines.push('');
    }

    if (round !== currentRound && round > 0) {
      currentRound = round;
      lines.push(`#### Round ${round}`);
      lines.push('');
    }

    // Message content
    if (isAgentMessage(message)) {
      lines.push(`**${message.agentName}** _(${message.stance})_:`);
      lines.push('');
      lines.push(message.content);
      lines.push('');
      if (message.keyPoints.length > 0) {
        lines.push('> **Key Points:**');
        for (const point of message.keyPoints) {
          lines.push(`> - ${point}`);
        }
        lines.push('');
      }
      if (message.blockers && message.blockers.length > 0) {
        lines.push('> **⚠️ Blockers Raised:**');
        for (const blocker of message.blockers) {
          lines.push(`> - [Severity ${blocker.severity}/5] ${blocker.condition}`);
        }
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    } else if (isModeratorMessage(message)) {
      lines.push(`**🎯 Moderator** _(${message.type})_:`);
      lines.push('');
      lines.push(message.content);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  lines.push('</details>');
  lines.push('');

  // Footer
  lines.push('---');
  lines.push(`*Generated by Bot Consensus on ${new Date().toLocaleString()}*`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a compact summary (for stdout)
 */
export function generateCompactSummary(output: ConsensusOutput): string {
  const { summary, session } = output;
  const lines: string[] = [];

  lines.push('═'.repeat(60));
  lines.push(`CONSENSUS DISCUSSION: ${summary.topic}`);
  lines.push('═'.repeat(60));
  lines.push('');
  
  lines.push(`Participants: ${summary.participantCount} | Rounds: ${summary.roundCount}`);
  lines.push(`Consensus Reached: ${summary.consensusReached ? 'Yes ✓' : 'Partial'}`);
  
  // Add metrics and cost
  if (session.metrics) {
    lines.push(`Agreement Level: ${(session.metrics.agreementLevel * 100).toFixed(0)}%`);
  }
  if (session.costSummary) {
    lines.push(`Total Cost: ${CostTracker.formatCost(session.costSummary.totalCost)} (${session.costSummary.totalTokens.totalTokens.toLocaleString()} tokens)`);
  }
  lines.push('');
  
  lines.push('─'.repeat(60));
  lines.push('SUMMARY');
  lines.push('─'.repeat(60));
  lines.push(summary.finalConsensus);
  lines.push('');

  if (summary.keyAgreements.length > 0) {
    lines.push('─'.repeat(60));
    lines.push('KEY AGREEMENTS');
    lines.push('─'.repeat(60));
    for (const agreement of summary.keyAgreements) {
      lines.push(`  ✓ ${agreement}`);
    }
    lines.push('');
  }

  if (summary.remainingDisagreements.length > 0) {
    lines.push('─'.repeat(60));
    lines.push('OPEN QUESTIONS');
    lines.push('─'.repeat(60));
    for (const disagreement of summary.remainingDisagreements) {
      lines.push(`  ? ${disagreement}`);
    }
    lines.push('');
  }

  // Show blockers if any open
  const openBlockers = session.structuredState?.blockers?.filter(
    b => b.status === 'open' || b.status === 'disputed'
  ) || [];
  if (openBlockers.length > 0) {
    lines.push('─'.repeat(60));
    lines.push('OPEN BLOCKERS');
    lines.push('─'.repeat(60));
    for (const blocker of openBlockers) {
      lines.push(`  ⚠️ [${blocker.severity}/5] ${blocker.condition}`);
    }
    lines.push('');
  }

  lines.push('═'.repeat(60));

  return lines.join('\n');
}

/**
 * Write markdown to file
 */
export async function writeMarkdownFile(
  output: ConsensusOutput,
  filepath: string
): Promise<void> {
  const markdown = generateMarkdown(output);
  await writeFile(filepath, markdown, 'utf-8');
}

/**
 * Generate filename from topic and timestamp
 */
export function generateFilename(topic: string, sessionId: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  return `consensus-${slug}-${sessionId.slice(0, 8)}.md`;
}

// Type guards
function isAgentMessage(msg: Message): msg is AgentMessage {
  return 'agentId' in msg;
}

function isModeratorMessage(msg: Message): msg is ModeratorMessage {
  return 'type' in msg;
}

// Helper to escape YAML strings
function escapeYaml(str: string): string {
  return str.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/**
 * Generate a live-updating markdown during discussion
 */
export class LiveMarkdownGenerator {
  private output: Partial<ConsensusOutput>;
  private lines: string[] = [];

  constructor(topic: string, agents: { name: string; personality: string }[]) {
    this.output = {
      summary: {
        topic,
        participantCount: agents.length,
        roundCount: 0,
        consensusReached: false,
        finalConsensus: '',
        keyAgreements: [],
        remainingDisagreements: [],
        agentSummaries: agents.map((a) => ({
          agentName: a.name,
          personality: a.personality,
          keyContributions: [],
        })),
      },
      transcript: [],
    };

    // Initialize header
    this.lines.push(`# Live Discussion: ${topic}`);
    this.lines.push('');
    this.lines.push('*Discussion in progress...*');
    this.lines.push('');
  }

  /**
   * Add a message to the live output
   */
  addMessage(message: Message): string {
    this.output.transcript!.push(message);

    if (isAgentMessage(message)) {
      this.lines.push(`### ${message.agentName} (${message.stance})`);
      this.lines.push('');
      this.lines.push(message.content);
      this.lines.push('');
    } else if (isModeratorMessage(message)) {
      this.lines.push(`### 🎯 Moderator (${message.type})`);
      this.lines.push('');
      this.lines.push(message.content);
      this.lines.push('');
    }

    return this.getCurrentMarkdown();
  }

  /**
   * Get current markdown content
   */
  getCurrentMarkdown(): string {
    return this.lines.join('\n');
  }

  /**
   * Finalize with complete output
   */
  finalize(output: ConsensusOutput): string {
    return generateMarkdown(output);
  }
}
