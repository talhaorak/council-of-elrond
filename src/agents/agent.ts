import { nanoid } from 'nanoid';
import type {
  AgentConfig,
  AgentMessage,
  ChatMessage,
  LLMProvider,
  Phase,
  Stance,
  StreamChunk,
  Message,
  Blocker,
} from '../core/types.js';
import { createProvider } from '../providers/index.js';

/**
 * Represents an AI agent participating in the consensus discussion
 */
export class Agent {
  readonly id: string;
  readonly name: string;
  readonly config: AgentConfig;
  private provider: LLMProvider;
  private conversationHistory: ChatMessage[] = [];

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.provider = createProvider(config.provider, {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
  }

  /**
   * Build the system prompt for this agent
   */
  private buildSystemPrompt(topic: string, depth: number, currentRound: number): string {
    const { personality } = this.config;
    const traitsDescription = personality.traits
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');

    return `You are ${this.name}, participating in a structured consensus discussion.

TOPIC: ${topic}

YOUR PERSONALITY:
${personality.description}

YOUR TRAITS:
${traitsDescription}

COMMUNICATION STYLE:
- Tone: ${personality.communicationStyle.tone}
- Verbosity: ${personality.communicationStyle.verbosity}
- Formality: ${personality.communicationStyle.formality}

${personality.systemPromptAddition}

DISCUSSION CONTEXT:
- This is round ${currentRound} of ${depth} total rounds
- ${currentRound === 1 ? 'This is the opening round - share your initial perspective.' : ''}
- ${currentRound === depth ? 'This is the FINAL round - focus on synthesis and actionable conclusions.' : ''}
- ${currentRound > 1 && currentRound < depth ? 'Build on previous points, refine ideas, and address disagreements.' : ''}

RESPONSE FORMAT:
You MUST structure your response with these markers:
1. Start with your STANCE on a new line: [STANCE: PROPOSE|AGREE|DISAGREE|REFINE|CHALLENGE|PASS]
2. Then provide your RESPONSE
3. If you have serious concerns, raise BLOCKERS (structured objections):
   [BLOCKER: condition="when this fails" | impact="what breaks" | detection="how to notice" | mitigation="what to do" | severity=1-5 | confidence=1-5]
4. End with KEY POINTS on a new line: [KEY_POINTS: point1 | point2 | point3]

Example with BLOCKER:
[STANCE: CHALLENGE]
I see significant risks with this approach...
[BLOCKER: condition="API rate limits exceeded during peak" | impact="Service degradation for all users" | detection="Monitor 429 responses" | mitigation="Implement exponential backoff and queue" | severity=4 | confidence=4]
[KEY_POINTS: Rate limiting is critical | Need fallback strategy | Consider circuit breaker pattern]

BLOCKER Guidelines:
- severity 1-2: Minor concerns, can proceed
- severity 3: Moderate concern, should address before finalizing
- severity 4-5: Critical concern, must resolve before proceeding
- confidence 1-2: Speculation, needs validation
- confidence 3: Reasonable belief based on experience
- confidence 4-5: High certainty based on evidence

RULES:
- Stay in character according to your personality
- Reference other agents' points by name when responding
- Be constructive even when disagreeing
- Use BLOCKER format for serious objections (not minor preferences)
- Focus on the topic at hand
- Keep responses focused and avoid repetition`;
  }

  /**
   * Format the conversation context for the agent
   */
  private formatContext(
    messages: Message[],
    phase: Phase,
    moderatorSummary?: string
  ): string {
    let context = `\n--- DISCUSSION SO FAR ---\n`;

    if (moderatorSummary) {
      context += `\nMODERATOR SUMMARY:\n${moderatorSummary}\n`;
    }

    const agentMessages = messages.filter((m) => 'agentId' in m) as AgentMessage[];
    
    for (const msg of agentMessages.slice(-10)) { // Last 10 messages for context
      context += `\n[${msg.agentName}] (${msg.stance}):\n${msg.content}\n`;
      if (msg.keyPoints.length > 0) {
        context += `Key points: ${msg.keyPoints.join(', ')}\n`;
      }
    }

    context += `\n--- YOUR TURN ---\n`;
    context += `Current phase: ${phase}\n`;
    context += `Please provide your response:\n`;

    return context;
  }

  /**
   * Parse the agent's response to extract stance, key points, and blockers
   */
  private parseResponse(response: string): {
    stance: Stance;
    content: string;
    keyPoints: string[];
    blockers: Blocker[];
  } {
    let stance: Stance = 'PROPOSE';
    let content = response;
    let keyPoints: string[] = [];
    const blockers: Blocker[] = [];

    // Extract stance
    const stanceMatch = response.match(/\[STANCE:\s*(PROPOSE|AGREE|DISAGREE|REFINE|CHALLENGE|PASS)\]/i);
    if (stanceMatch) {
      stance = stanceMatch[1].toUpperCase() as Stance;
      content = content.replace(stanceMatch[0], '').trim();
    }

    // Extract blockers
    const blockerRegex = /\[BLOCKER:\s*condition="([^"]+)"\s*\|\s*impact="([^"]+)"\s*\|\s*detection="([^"]+)"\s*\|\s*mitigation="([^"]+)"\s*\|\s*severity=(\d)\s*\|\s*confidence=(\d)\s*\]/gi;
    let blockerMatch;
    while ((blockerMatch = blockerRegex.exec(response)) !== null) {
      blockers.push({
        id: nanoid(8),
        condition: blockerMatch[1],
        impact: blockerMatch[2],
        detection: blockerMatch[3],
        mitigation: blockerMatch[4],
        severity: Math.min(5, Math.max(1, parseInt(blockerMatch[5]))) as 1 | 2 | 3 | 4 | 5,
        confidence: Math.min(5, Math.max(1, parseInt(blockerMatch[6]))) as 1 | 2 | 3 | 4 | 5,
        raisedBy: this.id,
        status: 'open',
      });
      content = content.replace(blockerMatch[0], '').trim();
    }

    // Extract key points
    const keyPointsMatch = response.match(/\[KEY_POINTS:\s*([^\]]+)\]/i);
    if (keyPointsMatch) {
      keyPoints = keyPointsMatch[1]
        .split('|')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      content = content.replace(keyPointsMatch[0], '').trim();
    }

    return { stance, content, keyPoints, blockers };
  }

  /**
   * Generate a response (non-streaming)
   */
  async respond(
    topic: string,
    depth: number,
    currentRound: number,
    phase: Phase,
    messages: Message[],
    moderatorSummary?: string
  ): Promise<AgentMessage> {
    const systemPrompt = this.buildSystemPrompt(topic, depth, currentRound);
    const context = this.formatContext(messages, phase, moderatorSummary);

    this.conversationHistory = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
    ];

    const response = await this.provider.chat(this.conversationHistory, {
      temperature: this.config.temperature ?? 0.7,
      maxTokens: this.config.maxTokens ?? 1024,
    });

    const { stance, content, keyPoints, blockers } = this.parseResponse(response);

    return {
      id: nanoid(),
      agentId: this.id,
      agentName: this.name,
      timestamp: new Date(),
      phase,
      round: currentRound,
      stance,
      content,
      referencedMessageIds: [], // Could be enhanced to detect references
      keyPoints,
      blockers: blockers.length > 0 ? blockers : undefined,
    };
  }

  /**
   * Generate a streaming response
   */
  async *respondStream(
    topic: string,
    depth: number,
    currentRound: number,
    phase: Phase,
    messages: Message[],
    moderatorSummary?: string
  ): AsyncIterable<{ chunk: StreamChunk; partialMessage?: AgentMessage }> {
    const systemPrompt = this.buildSystemPrompt(topic, depth, currentRound);
    const context = this.formatContext(messages, phase, moderatorSummary);

    this.conversationHistory = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
    ];

    let fullResponse = '';

    for await (const chunk of this.provider.chatStream(this.conversationHistory, {
      temperature: this.config.temperature ?? 0.7,
      maxTokens: this.config.maxTokens ?? 1024,
    })) {
      fullResponse += chunk.content;

      if (chunk.done) {
        const { stance, content, keyPoints, blockers } = this.parseResponse(fullResponse);
        
        yield {
          chunk,
          partialMessage: {
            id: nanoid(),
            agentId: this.id,
            agentName: this.name,
            timestamp: new Date(),
            phase,
            round: currentRound,
            stance,
            content,
            referencedMessageIds: [],
            keyPoints,
            blockers: blockers.length > 0 ? blockers : undefined,
          },
        };
      } else {
        yield { chunk };
      }
    }
  }

  /**
   * Check if the provider is available
   */
  async isAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }

  /**
   * Get a description of this agent
   */
  describe(): string {
    return `${this.name} (${this.config.provider}:${this.config.model}) - ${this.config.personality.name}`;
  }
}
