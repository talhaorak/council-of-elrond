import { nanoid } from 'nanoid';
import type {
  ModeratorConfig,
  ModeratorMessage,
  Message,
  AgentMessage,
  Phase,
  LLMProvider,
  ChatMessage,
  StreamChunk,
  AgentConfig,
} from './types.js';
import { createProvider } from '../providers/index.js';
import { logger } from './logger.js';

/**
 * The Moderator orchestrates the discussion, summarizes progress,
 * and guides agents toward consensus
 */
export class Moderator {
  private provider: LLMProvider;
  private config: ModeratorConfig;

  constructor(config: ModeratorConfig) {
    this.config = config;
    this.provider = createProvider(config.provider, {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
  }

  /**
   * Build the system prompt for the moderator
   */
  private buildSystemPrompt(): string {
    return `You are a MODERATOR facilitating a structured consensus discussion between AI agents.

YOUR ROLE:
- Guide the discussion professionally and neutrally
- Summarize key points and areas of agreement/disagreement
- Help agents build on each other's ideas
- Identify when consensus is forming or when positions are irreconcilable
- Keep the discussion focused and productive
- Transition between phases smoothly

COMMUNICATION STYLE:
- Professional and neutral
- Clear and structured
- Encouraging but objective
- Focus on substance over personalities

OUTPUT FORMAT:
When providing summaries or transitions, structure your response clearly:
1. Brief overview of discussion state
2. Key agreements identified (if any)
3. Key disagreements or open questions (if any)
4. Guidance for next phase/round`;
  }

  /**
   * Format messages for moderator context
   */
  private formatMessagesForContext(messages: Message[]): string {
    return messages
      .map((msg) => {
        if ('agentId' in msg) {
          const agentMsg = msg as AgentMessage;
          return `[${agentMsg.agentName}] (${agentMsg.stance}):\n${agentMsg.content}\nKey points: ${agentMsg.keyPoints.join(', ')}`;
        } else {
          const modMsg = msg as ModeratorMessage;
          return `[MODERATOR] (${modMsg.type}):\n${modMsg.content}`;
        }
      })
      .join('\n\n');
  }

  /**
   * Helper: call provider with timeout
   */
  private async chatWithTimeout(
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
    timeoutMs: number = 180_000
  ): Promise<string> {
    return Promise.race([
      this.provider.chat(messages, options),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Moderator timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      ),
    ]);
  }

  /**
   * Generate the opening introduction
   */
  async introduce(
    topic: string,
    agents: AgentConfig[],
    depth: number
  ): Promise<ModeratorMessage> {
    const agentDescriptions = agents
      .map((a) => `- ${a.name}: ${a.personality.name} - ${a.personality.description.slice(0, 100)}...`)
      .join('\n');

    const prompt = `You are opening a consensus discussion.

TOPIC: ${topic}

PARTICIPANTS:
${agentDescriptions}

DISCUSSION STRUCTURE:
- ${depth} rounds of discussion
- Phases: Opening → Discussion → Synthesis → Consensus

Please provide an opening statement that:
1. Introduces the topic clearly
2. Briefly acknowledges the diverse perspectives present
3. Sets expectations for constructive dialogue
4. Encourages agents to share their initial positions

Keep it concise (2-3 paragraphs).`;

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: prompt },
    ];

    logger.moderator(`Calling provider for introduction (model: ${this.config.model})`);
    const startTime = Date.now();
    
    const response = await this.chatWithTimeout(messages, {
      temperature: this.config.temperature ?? 0.5,
    });

    logger.moderator(`Introduction completed in ${Date.now() - startTime}ms`);

    return {
      id: nanoid(),
      timestamp: new Date(),
      phase: 'OPENING',
      round: 0,
      type: 'introduction',
      content: response,
    };
  }

  /**
   * Generate a round summary
   */
  async summarizeRound(
    topic: string,
    messages: Message[],
    currentRound: number,
    totalRounds: number
  ): Promise<ModeratorMessage> {
    const context = this.formatMessagesForContext(messages);

    const prompt = `Please summarize round ${currentRound} of ${totalRounds} on the topic: "${topic}"

DISCUSSION SO FAR:
${context}

Provide:
1. A brief summary of what was discussed this round
2. Key AGREEMENTS that emerged (list them clearly)
3. Key DISAGREEMENTS or unresolved questions (list them clearly)
4. Specific guidance for round ${currentRound + 1} (what should agents focus on?)

Format your response with clear sections.`;

    const messages_: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: prompt },
    ];

    const response = await this.chatWithTimeout(messages_, {
      temperature: this.config.temperature ?? 0.5,
    });

    // Extract agreements and disagreements
    const agreements = this.extractListItems(response, /agreements?:?\s*\n([\s\S]*?)(?=\n\n|\nkey disagreements?|\ndisagreements?|$)/i);
    const disagreements = this.extractListItems(response, /disagreements?:?\s*\n([\s\S]*?)(?=\n\n|\nguidance|$)/i);

    return {
      id: nanoid(),
      timestamp: new Date(),
      phase: 'DISCUSSION',
      round: currentRound,
      type: 'summary',
      content: response,
      identifiedAgreements: agreements,
      identifiedDisagreements: disagreements,
    };
  }

  /**
   * Generate a phase transition message
   */
  async transitionPhase(
    topic: string,
    messages: Message[],
    fromPhase: Phase,
    toPhase: Phase,
    currentRound: number
  ): Promise<ModeratorMessage> {
    const context = this.formatMessagesForContext(messages.slice(-10)); // Last 10 messages

    const prompt = `The discussion is transitioning from ${fromPhase} to ${toPhase}.

TOPIC: ${topic}

RECENT DISCUSSION:
${context}

Please provide a brief transition statement that:
1. Acknowledges what was accomplished in ${fromPhase}
2. Explains what ${toPhase} will focus on
3. Gives clear instructions for how agents should approach ${toPhase}

Keep it concise (1-2 paragraphs).`;

    const messages_: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: prompt },
    ];

    const response = await this.chatWithTimeout(messages_, {
      temperature: this.config.temperature ?? 0.5,
    });

    return {
      id: nanoid(),
      timestamp: new Date(),
      phase: toPhase,
      round: currentRound,
      type: 'transition',
      content: response,
    };
  }

  /**
   * Generate the final conclusion
   */
  async conclude(
    topic: string,
    messages: Message[],
    totalRounds: number
  ): Promise<ModeratorMessage> {
    const context = this.formatMessagesForContext(messages);

    const prompt = `The discussion on "${topic}" has concluded after ${totalRounds} rounds.

FULL DISCUSSION:
${context}

Please provide a comprehensive conclusion that includes:

1. EXECUTIVE SUMMARY (2-3 sentences capturing the main outcome)

2. CONSENSUS REACHED (clearly state what the group agreed on)

3. KEY INSIGHTS (the most valuable ideas that emerged)

4. REMAINING QUESTIONS (any unresolved disagreements or areas for future exploration)

5. ACTIONABLE RECOMMENDATIONS (if applicable, concrete next steps)

Be thorough but structured. This will be the primary output of the discussion.`;

    const messages_: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: prompt },
    ];

    const response = await this.chatWithTimeout(messages_, {
      temperature: this.config.temperature ?? 0.3,
      maxTokens: 2048,
    });

    const agreements = this.extractListItems(response, /consensus reached:?\s*\n([\s\S]*?)(?=\n\n|\nkey insights?|$)/i);
    const disagreements = this.extractListItems(response, /remaining questions?:?\s*\n([\s\S]*?)(?=\n\n|\nactionable|$)/i);

    return {
      id: nanoid(),
      timestamp: new Date(),
      phase: 'CONSENSUS',
      round: totalRounds,
      type: 'conclusion',
      content: response,
      identifiedAgreements: agreements,
      identifiedDisagreements: disagreements,
    };
  }

  /**
   * Streaming version of summarizeRound
   */
  async *summarizeRoundStream(
    topic: string,
    messages: Message[],
    currentRound: number,
    totalRounds: number
  ): AsyncIterable<{ chunk: StreamChunk; message?: ModeratorMessage }> {
    const context = this.formatMessagesForContext(messages);

    const prompt = `Please summarize round ${currentRound} of ${totalRounds} on the topic: "${topic}"

DISCUSSION SO FAR:
${context}

Provide:
1. A brief summary of what was discussed this round
2. Key AGREEMENTS that emerged (list them clearly)
3. Key DISAGREEMENTS or unresolved questions (list them clearly)
4. Specific guidance for round ${currentRound + 1} (what should agents focus on?)`;

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: prompt },
    ];

    let fullResponse = '';

    for await (const chunk of this.provider.chatStream(chatMessages, {
      temperature: this.config.temperature ?? 0.5,
    })) {
      fullResponse += chunk.content;

      if (chunk.done) {
        const agreements = this.extractListItems(fullResponse, /agreements?:?\s*\n([\s\S]*?)(?=\n\n|\ndisagreements?|$)/i);
        const disagreements = this.extractListItems(fullResponse, /disagreements?:?\s*\n([\s\S]*?)(?=\n\n|\nguidance|$)/i);

        yield {
          chunk,
          message: {
            id: nanoid(),
            timestamp: new Date(),
            phase: 'DISCUSSION',
            round: currentRound,
            type: 'summary',
            content: fullResponse,
            identifiedAgreements: agreements,
            identifiedDisagreements: disagreements,
          },
        };
      } else {
        yield { chunk };
      }
    }
  }

  /**
   * Extract list items from moderator response
   */
  private extractListItems(text: string, pattern: RegExp): string[] {
    const match = text.match(pattern);
    if (!match || !match[1]) return [];

    return match[1]
      .split('\n')
      .map((line) => line.replace(/^[\s-•*]+/, '').trim())
      .filter((line) => line.length > 0 && !line.match(/^(key|remaining|disagreements?|agreements?)/i));
  }

  /**
   * Check if provider is available
   */
  async isAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }
}
