/**
 * Clean API for programmatic usage and AI agent integration
 * 
 * This module provides a simple interface for other AI agents or programs
 * to run consensus discussions without dealing with the full configuration.
 */

import { buildConfig } from './config/loader.js';
import { ConsensusEngine } from './core/engine.js';
import { createInterruptController, type InterruptController } from './core/interrupts.js';
import { generateMarkdown, generateCompactSummary } from './output/markdown.js';
import { SessionManager } from './output/state.js';
import type {
  ConsensusOutput,
  ConsensusEvent,
  Provider,
  PersonalityArchetype,
  SessionState,
} from './core/types.js';

// Re-export useful types
export type {
  ConsensusOutput,
  ConsensusEvent,
  Provider,
  PersonalityArchetype,
  SessionState,
};

/**
 * Simple agent definition for the API
 */
export interface SimpleAgent {
  /** Personality archetype or custom personality name */
  personality: PersonalityArchetype | string;
  /** Optional: Override provider (defaults to lmstudio) */
  provider?: Provider;
  /** Optional: Override model */
  model?: string;
  /** Optional: Custom name for this agent */
  name?: string;
}

/**
 * Options for running a consensus discussion
 */
export interface ConsensusOptions {
  /** The topic to discuss */
  topic: string;
  /** Agents participating in the discussion */
  agents: SimpleAgent[];
  /** Number of discussion rounds (default: 3) */
  depth?: number;
  /** Provider for moderator (default: same as first agent) */
  moderatorProvider?: Provider;
  /** Model for moderator */
  moderatorModel?: string;
  /** Save output to this file path */
  outputPath?: string;
  /** Callback for real-time events */
  onEvent?: (event: ConsensusEvent) => void;
  /** Interrupt controller (for external control) */
  interruptController?: InterruptController;
}

/**
 * Result of a consensus discussion
 */
export interface ConsensusResult {
  /** Whether the discussion completed successfully */
  success: boolean;
  /** Session ID for continuation */
  sessionId: string;
  /** Whether consensus was reached */
  consensusReached: boolean;
  /** The final consensus statement */
  consensus: string;
  /** Key agreements from the discussion */
  keyAgreements: string[];
  /** Remaining disagreements */
  disagreements: string[];
  /** Full output object */
  output: ConsensusOutput;
  /** Markdown formatted output */
  markdown: string;
  /** Compact summary for display */
  summary: string;
  /** Whether the discussion was interrupted */
  interrupted: boolean;
  /** Type of interruption if any */
  interruptType?: 'soft' | 'hard';
}

/**
 * Run a consensus discussion with minimal configuration
 * 
 * @example
 * ```typescript
 * import { runConsensus } from 'bot-consensus/api';
 * 
 * const result = await runConsensus({
 *   topic: 'Best practices for REST API design',
 *   agents: [
 *     { personality: 'skeptic' },
 *     { personality: 'pragmatist' },
 *     { personality: 'innovator' },
 *   ],
 *   depth: 3,
 * });
 * 
 * console.log(result.consensus);
 * console.log(result.keyAgreements);
 * ```
 */
export async function runConsensus(options: ConsensusOptions): Promise<ConsensusResult> {
  const {
    topic,
    agents,
    depth = 3,
    moderatorProvider,
    moderatorModel,
    outputPath,
    onEvent,
    interruptController: externalController,
  } = options;

  // Build agent specs
  const agentSpecs = agents.map((a) => {
    const provider = a.provider || 'lmstudio';
    const model = a.model || 'qwen/qwen3-coder-30b';
    return `${provider}:${model}:${a.personality}`;
  });

  // Build config
  const config = await buildConfig({
    topic,
    depth,
    agents: agentSpecs,
    moderatorProvider: moderatorProvider || agents[0]?.provider || 'lmstudio',
    moderatorModel: moderatorModel || agents[0]?.model || 'qwen/qwen3-coder-30b',
    outputPath,
  });

  // Create engine with interrupt controller
  const interruptController = externalController || createInterruptController();
  const engine = new ConsensusEngine(config, interruptController);
  const sessionManager = new SessionManager();

  let output: ConsensusOutput | null = null;
  let interrupted = false;
  let interruptType: 'soft' | 'hard' | undefined;

  // Run with streaming
  for await (const event of engine.runStream()) {
    // Call event handler if provided
    onEvent?.(event);

    // Capture completion and interrupt events
    if (event.type === 'session_complete') {
      output = event.output;
    } else if (event.type === 'interrupt_soft') {
      interrupted = true;
      interruptType = 'soft';
    } else if (event.type === 'interrupt_hard') {
      interrupted = true;
      interruptType = 'hard';
    }
  }

  // Save session
  await sessionManager.save(engine.getSession());

  // Generate output if we have it
  if (!output) {
    // Generate partial output for interrupted sessions
    const session = engine.getSession();
    output = {
      session,
      summary: {
        topic: config.topic,
        participantCount: config.agents.length,
        roundCount: session.currentRound,
        consensusReached: false,
        finalConsensus: 'Discussion was interrupted before completion.',
        keyAgreements: [],
        remainingDisagreements: [],
        agentSummaries: [],
      },
      transcript: session.messages,
    };
  }

  // Save to file if requested
  if (outputPath) {
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, generateMarkdown(output), 'utf-8');
  }

  return {
    success: !interrupted || interruptType === 'soft',
    sessionId: engine.getSession().id,
    consensusReached: output.summary.consensusReached,
    consensus: output.summary.finalConsensus,
    keyAgreements: output.summary.keyAgreements,
    disagreements: output.summary.remainingDisagreements,
    output,
    markdown: generateMarkdown(output),
    summary: generateCompactSummary(output),
    interrupted,
    interruptType,
  };
}

/**
 * Run a quick 2-agent discussion with opposing views
 * 
 * @example
 * ```typescript
 * const result = await quickConsensus('Should we use microservices?');
 * ```
 */
export async function quickConsensus(
  topic: string,
  options?: {
    depth?: number;
    provider?: Provider;
    model?: string;
    onEvent?: (event: ConsensusEvent) => void;
  }
): Promise<ConsensusResult> {
  return runConsensus({
    topic,
    agents: [
      { personality: 'optimist', provider: options?.provider, model: options?.model },
      { personality: 'skeptic', provider: options?.provider, model: options?.model },
    ],
    depth: options?.depth || 2,
    onEvent: options?.onEvent,
  });
}

/**
 * Run a balanced team discussion (4 agents)
 */
export async function balancedConsensus(
  topic: string,
  options?: {
    depth?: number;
    provider?: Provider;
    model?: string;
    onEvent?: (event: ConsensusEvent) => void;
  }
): Promise<ConsensusResult> {
  return runConsensus({
    topic,
    agents: [
      { personality: 'pragmatist', provider: options?.provider, model: options?.model },
      { personality: 'innovator', provider: options?.provider, model: options?.model },
      { personality: 'skeptic', provider: options?.provider, model: options?.model },
      { personality: 'analyst', provider: options?.provider, model: options?.model },
    ],
    depth: options?.depth || 3,
    onEvent: options?.onEvent,
  });
}

/**
 * Continue a previous discussion
 */
export async function continueConsensus(
  sessionId: string,
  additionalRounds: number = 2,
  options?: {
    onEvent?: (event: ConsensusEvent) => void;
    outputPath?: string;
  }
): Promise<ConsensusResult> {
  const sessionManager = new SessionManager();
  const session = await sessionManager.load(sessionId);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const engine = await ConsensusEngine.resume(session, additionalRounds);
  
  let output: ConsensusOutput | null = null;

  for await (const event of engine.runStream()) {
    options?.onEvent?.(event);
    if (event.type === 'session_complete') {
      output = event.output;
    }
  }

  await sessionManager.save(engine.getSession());

  if (!output) {
    throw new Error('Discussion failed to complete');
  }

  if (options?.outputPath) {
    const { writeFile } = await import('fs/promises');
    await writeFile(options.outputPath, generateMarkdown(output), 'utf-8');
  }

  return {
    success: true,
    sessionId: engine.getSession().id,
    consensusReached: output.summary.consensusReached,
    consensus: output.summary.finalConsensus,
    keyAgreements: output.summary.keyAgreements,
    disagreements: output.summary.remainingDisagreements,
    output,
    markdown: generateMarkdown(output),
    summary: generateCompactSummary(output),
    interrupted: false,
  };
}

/**
 * List all saved sessions
 */
export async function listSessions(): Promise<{
  id: string;
  topic: string;
  createdAt: Date;
  isComplete: boolean;
}[]> {
  const sessionManager = new SessionManager();
  return sessionManager.list();
}

/**
 * Get a specific session
 */
export async function getSession(sessionId: string): Promise<SessionState | null> {
  const sessionManager = new SessionManager();
  return sessionManager.load(sessionId);
}

/**
 * Create an interrupt controller for external control
 * 
 * @example
 * ```typescript
 * const controller = createController();
 * 
 * // Start discussion in background
 * const resultPromise = runConsensus({
 *   topic: 'My topic',
 *   agents: [...],
 *   interruptController: controller,
 * });
 * 
 * // Later, interrupt it
 * controller.softInterrupt(); // Wrap up gracefully
 * // or
 * controller.hardInterrupt(); // Stop immediately
 * 
 * const result = await resultPromise;
 * ```
 */
export function createController(): InterruptController {
  return createInterruptController();
}

// Export the interrupt controller type
export type { InterruptController };

/**
 * JSON-friendly output for AI agents
 */
export interface JSONConsensusResult {
  success: boolean;
  sessionId: string;
  topic: string;
  consensusReached: boolean;
  consensus: string;
  keyAgreements: string[];
  disagreements: string[];
  participantCount: number;
  roundCount: number;
  interrupted: boolean;
}

/**
 * Run consensus and return JSON-friendly result (for AI tool integration)
 */
export async function runConsensusJSON(options: ConsensusOptions): Promise<JSONConsensusResult> {
  const result = await runConsensus(options);
  
  return {
    success: result.success,
    sessionId: result.sessionId,
    topic: options.topic,
    consensusReached: result.consensusReached,
    consensus: result.consensus,
    keyAgreements: result.keyAgreements,
    disagreements: result.disagreements,
    participantCount: options.agents.length,
    roundCount: result.output.summary.roundCount,
    interrupted: result.interrupted,
  };
}
