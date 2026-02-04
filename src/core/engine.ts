import { nanoid } from 'nanoid';
import type {
  DiscussionConfig,
  SessionState,
  ConsensusOutput,
  ConsensusEvent,
  Message,
  AgentMessage,
  ModeratorMessage,
  Phase,
  AbortReason,
  Blocker,
  ConsensusMetrics,
  TokenUsage,
} from './types.js';
import { DiscussionProtocol } from './protocol.js';
import { Moderator } from './moderator.js';
import { Agent } from '../agents/agent.js';
import { AgentFactory, type AgentDefinition } from '../agents/factory.js';
import { type InterruptController, createInterruptController } from './interrupts.js';
import { logger } from './logger.js';
import { WorkspaceManager, type CurrentState } from './workspace.js';
import { SessionManager } from '../output/state.js';
import { CostTracker } from './cost-tracker.js';
import { StructuredStateManager } from './structured-state.js';
import { Arbiter } from './arbiter.js';
import { checkLimits, calculateDecisionGate, DEFAULT_LIMITS } from './limits.js';

export type EventHandler = (event: ConsensusEvent) => void | Promise<void>;

/** Callback for auto-save after each agent response */
export type AutoSaveCallback = (state: CurrentState) => Promise<void>;

/**
 * Main orchestration engine for consensus discussions
 */
export class ConsensusEngine {
  private config: DiscussionConfig;
  private session: SessionState;
  private protocol: DiscussionProtocol;
  private moderator: Moderator;
  private agents: Agent[] = [];
  private eventHandlers: EventHandler[] = [];
  private interruptController: InterruptController;
  private isWrappingUp: boolean = false;
  private workspace?: WorkspaceManager;
  private sessionManager: SessionManager;
  private autoSaveCallback?: AutoSaveCallback;
  private currentAgentIndex: number = 0;
  private abortRequested: boolean = false;
  private resumeInfo?: { skipOpening: boolean; startDiscussionRound: number };
  
  // New feature instances
  private costTracker: CostTracker;
  private structuredState: StructuredStateManager;
  private arbiter?: Arbiter;
  private consecutiveDisagreements: number = 0;

  constructor(config: DiscussionConfig, interruptController?: InterruptController, workspace?: WorkspaceManager) {
    this.config = config;
    this.protocol = new DiscussionProtocol(config.depth, config.agents.length);
    this.moderator = new Moderator(config.moderator);
    this.interruptController = interruptController || createInterruptController();
    this.workspace = workspace;
    this.sessionManager = new SessionManager();
    
    // Initialize cost tracker
    this.costTracker = new CostTracker();
    
    // Initialize structured state
    this.structuredState = new StructuredStateManager(config.topic);
    
    // Initialize arbiter if configured
    if (config.arbiter) {
      this.arbiter = new Arbiter(config.arbiter);
    }
    
    this.session = {
      id: nanoid(),
      createdAt: new Date(),
      updatedAt: new Date(),
      config,
      currentPhase: 'OPENING',
      currentRound: 0,
      messages: [],
      isComplete: false,
      consensusReached: false,
      structuredState: this.structuredState.getState(),
      costEntries: [],
      metrics: {
        agreementLevel: 0,
        keyAgreements: [],
        keyDisagreements: [],
        blockerCount: 0,
        resolvedBlockerCount: 0,
        averageConfidence: 0,
        convergenceRound: null,
      },
    };

    logger.engine('Engine created', { sessionId: this.session.id, topic: config.topic });
  }

  /**
   * Set auto-save callback
   */
  setAutoSave(callback: AutoSaveCallback): void {
    this.autoSaveCallback = callback;
  }

  /**
   * Auto-save current state
   */
  private async autoSave(): Promise<void> {
    if (!this.autoSaveCallback && !this.workspace) return;

    const state: CurrentState = {
      sessionId: this.session.id,
      topic: this.config.topic,
      phase: this.session.currentPhase,
      round: this.session.currentRound,
      totalRounds: this.config.depth,
      agentIndex: this.currentAgentIndex,
      lastUpdate: new Date().toISOString(),
      messages: this.session.messages.map(m => ({
        agentId: 'agentId' in m ? m.agentId : undefined,
        agentName: 'agentName' in m ? m.agentName : ('type' in m ? 'Moderator' : undefined),
        content: m.content,
        timestamp: m.timestamp.toISOString(),
      })),
      completed: this.session.isComplete,
    };

    if (this.autoSaveCallback) {
      await this.autoSaveCallback(state);
    }
    if (this.workspace) {
      await this.workspace.saveCurrentState(state);
    }

    logger.debug('Engine', 'Auto-saved state', { phase: state.phase, round: state.round });
  }

  /**
   * Save session to file (persists to .consensus/<sessionId>.json)
   */
  private async saveSessionToFile(): Promise<void> {
    try {
      await this.sessionManager.save(this.session);
      logger.debug('Engine', 'Saved session to file', { sessionId: this.session.id });
    } catch (error) {
      logger.error('Engine', 'Failed to save session', { error: error instanceof Error ? error.message : error });
    }
  }

  /**
   * Check if skip is requested for current agent
   */
  private checkSkip(): boolean {
    if (this.interruptController.skipRequested) {
      this.interruptController.clearSkip();
      return true;
    }
    return false;
  }

  /**
   * Create a thinking indicator that emits events while waiting
   */
  private createThinkingIndicator(
    type: 'agent' | 'moderator',
    agentId?: string,
    agentName?: string
  ): { stop: () => void; getElapsed: () => number } {
    const startTime = Date.now();
    let stopped = false;

    // Emit thinking event every 3 seconds
    const interval = setInterval(() => {
      if (stopped) return;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      
      if (type === 'agent' && agentId && agentName) {
        logger.debug('Engine', `${agentName} still thinking... (${elapsed}s)`);
      } else {
        logger.debug('Engine', `Moderator still thinking... (${elapsed}s)`);
      }
    }, 3000);

    return {
      stop: () => {
        stopped = true;
        clearInterval(interval);
      },
      getElapsed: () => Math.floor((Date.now() - startTime) / 1000),
    };
  }

  /**
   * Create an async generator that emits thinking events while waiting
   */
  private async *withThinkingEvents<T>(
    promise: Promise<T>,
    type: 'agent' | 'moderator',
    agentId?: string,
    agentName?: string
  ): AsyncGenerator<ConsensusEvent, T, unknown> {
    const startTime = Date.now();
    let resolved = false;
    let result: T;
    let error: Error | undefined;

    // Start the promise
    promise
      .then((r) => { result = r; resolved = true; })
      .catch((e) => { error = e; resolved = true; });

    // Emit thinking events every 5 seconds while waiting
    while (!resolved) {
      await new Promise((r) => setTimeout(r, 1000));
      
      if (!resolved) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        
        // Emit every 5 seconds
        if (elapsed > 0 && elapsed % 5 === 0) {
          if (type === 'agent' && agentId && agentName) {
            logger.info('Engine', `${agentName} thinking... (${elapsed}s)`);
            yield { type: 'agent_thinking', agentId, agentName, elapsed };
          } else {
            logger.info('Engine', `Moderator thinking... (${elapsed}s)`);
            yield { type: 'moderator_thinking', elapsed };
          }
        }
      }
    }

    if (error) throw error;
    return result!;
  }

  /**
   * Get the interrupt controller
   */
  getInterruptController(): InterruptController {
    return this.interruptController;
  }

  /**
   * Check if we should stop due to interrupt
   */
  private shouldStop(): boolean {
    return this.interruptController.isHardInterrupt();
  }

  /**
   * Check if we should wrap up due to soft interrupt
   */
  private shouldWrapUp(): boolean {
    return this.interruptController.isSoftInterrupt() && !this.isWrappingUp;
  }

  /**
   * Initialize agents from config
   */
  async initialize(): Promise<void> {
    logger.info('Engine', 'Initializing discussion', { 
      topic: this.config.topic, 
      agentCount: this.config.agents.length,
      depth: this.config.depth 
    });

    // Create agents from config
    this.agents = await Promise.all(
      this.config.agents.map((agentConfig) =>
        new Agent(agentConfig)
      )
    );

    // Verify all agents are available
    const availability = await Promise.all(
      this.agents.map(async (agent) => ({
        agent,
        available: await agent.isAvailable(),
      }))
    );

    const unavailable = availability.filter((a) => !a.available);
    if (unavailable.length > 0) {
      const names = unavailable.map((a) => a.agent.name).join(', ');
      logger.error('Engine', 'Some agents unavailable', { agents: names });
      throw new Error(`Some agents are unavailable: ${names}`);
    }

    // Verify moderator is available
    if (!(await this.moderator.isAvailable())) {
      logger.error('Engine', 'Moderator unavailable');
      throw new Error('Moderator provider is unavailable');
    }

    logger.info('Engine', 'All agents initialized successfully');
    await this.emit({ type: 'session_start', session: this.session });
  }

  /**
   * Subscribe to engine events
   */
  on(handler: EventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const index = this.eventHandlers.indexOf(handler);
      if (index > -1) this.eventHandlers.splice(index, 1);
    };
  }

  /**
   * Emit an event to all handlers
   */
  private async emit(event: ConsensusEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      await handler(event);
    }
  }

  /**
   * Add a message to the session
   */
  private addMessage(message: Message): void {
    this.session.messages.push(message);
    this.session.updatedAt = new Date();
  }

  /**
   * Record cost from an agent message
   */
  private async recordCost(
    agentId: string,
    agentName: string,
    provider: string,
    model: string,
    tokenUsage?: TokenUsage
  ): Promise<void> {
    // Estimate tokens if not provided (rough estimate based on content length)
    const lastMessage = this.session.messages[this.session.messages.length - 1];
    const usage = tokenUsage || {
      promptTokens: Math.ceil((lastMessage?.content.length || 0) / 4),
      completionTokens: Math.ceil((lastMessage?.content.length || 0) / 4),
      totalTokens: Math.ceil((lastMessage?.content.length || 0) / 2),
    };

    const entry = this.costTracker.record({
      agentId,
      agentName,
      provider: provider as any,
      model,
      timestamp: new Date(),
      tokens: usage,
      phase: this.session.currentPhase,
      round: this.session.currentRound,
    });

    // Update session
    this.session.costEntries = this.costTracker.getEntries();
    this.session.costSummary = this.costTracker.getSummary();

    // Emit cost update event
    await this.emit({
      type: 'cost_update',
      cost: entry,
      totalCost: this.costTracker.getTotalCost(),
    });

    logger.debug('Engine', `Cost recorded: ${CostTracker.formatCost(entry.estimatedCost)}`, {
      agent: agentName,
      total: CostTracker.formatCost(this.costTracker.getTotalCost()),
    });
  }

  /**
   * Record cost for moderator messages
   */
  private async recordModeratorCost(): Promise<void> {
    await this.recordCost(
      'moderator',
      'Moderator',
      this.config.moderator.provider,
      this.config.moderator.model,
      undefined
    );
  }

  /**
   * Process blockers from an agent message
   */
  private async processBlockers(message: AgentMessage): Promise<void> {
    if (!message.blockers || message.blockers.length === 0) return;

    for (const blocker of message.blockers) {
      // Add to structured state
      this.structuredState.addBlocker(blocker);
      
      // Emit blocker event
      await this.emit({ type: 'blocker_raised', blocker });
      
      logger.info('Engine', `Blocker raised by ${message.agentName}`, {
        severity: blocker.severity,
        confidence: blocker.confidence,
        condition: blocker.condition.slice(0, 50),
      });
    }

    // Update session state
    this.session.structuredState = this.structuredState.getState();
  }

  /**
   * Finalize agent message side effects (costs, blockers, structured state, autosave)
   */
  private async finalizeAgentMessage(
    agent: Agent,
    message: AgentMessage,
    options?: { trackDisagreements?: boolean }
  ): Promise<void> {
    await this.recordCost(agent.id, agent.name, agent.config.provider, agent.config.model, message.tokenUsage);
    await this.processBlockers(message);
    if (options?.trackDisagreements) {
      this.trackDisagreements(message);
    }
    this.structuredState.processAgentMessage(message);
    await this.autoSave();
  }

  /**
   * Finalize moderator message side effects (costs, autosave)
   */
  private async finalizeModeratorMessage(message: ModeratorMessage): Promise<void> {
    await this.recordModeratorCost();
    await this.autoSave();
  }

  /**
   * Check if limits have been exceeded
   */
  private async checkLimitsAndAbort(): Promise<AbortReason | null> {
    const limits = this.config.limits || DEFAULT_LIMITS;
    const openBlockers = this.structuredState.getOpenBlockers();
    
    const abortReason = checkLimits(limits, this.costTracker, openBlockers);
    
    if (abortReason) {
      this.session.abortReason = abortReason;
      if (abortReason.type !== 'needs_human') {
        this.abortRequested = true;
        if (!this.session.finalConsensus) {
          this.session.finalConsensus = this.formatAbortSummary(abortReason);
        }
      }
      await this.emit({ type: 'abort', reason: abortReason });
      logger.warn('Engine', `Abort triggered: ${abortReason.type}`, abortReason);
    }
    
    return abortReason;
  }

  private formatAbortSummary(reason: AbortReason): string {
    switch (reason.type) {
      case 'cost_limit':
        return `Discussion aborted: cost limit exceeded ($${reason.spent.toFixed(2)} > $${reason.limit.toFixed(2)}).`;
      case 'time_limit':
        return `Discussion aborted: time limit exceeded (${Math.round(reason.elapsed / 1000)}s > ${Math.round(reason.limit / 1000)}s).`;
      case 'token_limit':
        return `Discussion aborted: token limit exceeded (${reason.used} > ${reason.limit}).`;
      case 'blocker_limit':
        return `Discussion aborted: blocker limit exceeded (${reason.count} >= ${reason.limit}).`;
      case 'deadlock':
        return `Discussion aborted: deadlock detected (${reason.description}).`;
      case 'needs_human':
        return `Discussion paused: human decision required to resolve critical blockers.`;
      case 'user_interrupt':
        return `Discussion interrupted by user (${reason.interruptType}).`;
      default:
        return 'Discussion aborted due to limit conditions.';
    }
  }

  /**
   * Update consensus metrics
   */
  private async updateMetrics(): Promise<ConsensusMetrics> {
    const metrics = this.structuredState.calculateMetrics(this.agents.length);
    this.session.metrics = metrics;
    
    await this.emit({ type: 'metrics_update', metrics });
    await this.emit({ type: 'state_update', state: this.structuredState.getState() });
    
    return metrics;
  }

  /**
   * Invoke arbiter if needed
   */
  private async invokeArbiterIfNeeded(): Promise<boolean> {
    if (!this.arbiter) return false;
    
    const state = this.structuredState.getState();
    
    // Check if arbitration is needed
    if (!Arbiter.needsArbitration(state)) return false;
    
    logger.info('Engine', 'Invoking arbiter for deadlock resolution');
    await this.emit({ type: 'arbiter_invoked', reason: 'Deadlock detected' });
    
    // Get critical blockers to resolve
    const criticalBlockers = this.structuredState.getCriticalBlockers();
    
    for (const blocker of criticalBlockers) {
      try {
        const decision = await this.arbiter.resolveBlocker(blocker, state);
        
        // Apply decision
        if (decision.decision === 'accept') {
          this.structuredState.escalateBlocker(blocker.id);
        } else if (decision.decision === 'reject' || decision.decision === 'merge') {
          this.structuredState.resolveBlocker(
            blocker.id,
            decision.mergedResolution || decision.rationale
          );
          await this.emit({
            type: 'blocker_resolved',
            blockerId: blocker.id,
            resolution: decision.mergedResolution || decision.rationale,
          });
        }
        
        // Record arbiter decision
        if (!this.session.arbiterDecisions) {
          this.session.arbiterDecisions = [];
        }
        this.session.arbiterDecisions.push(decision);
        
        await this.emit({ type: 'arbiter_decision', decision });
      } catch (error) {
        logger.error('Engine', 'Arbiter failed to resolve blocker', { error, blockerId: blocker.id });
      }
    }
    
    return true;
  }

  /**
   * Track consecutive disagreements for deadlock detection
   */
  private trackDisagreements(message: AgentMessage): void {
    if (message.stance === 'DISAGREE' || message.stance === 'CHALLENGE') {
      this.consecutiveDisagreements++;
      
      const maxDisagreements = this.config.limits?.maxConsecutiveDisagreements || 3;
      if (this.consecutiveDisagreements >= maxDisagreements && this.arbiter) {
        logger.warn('Engine', `${this.consecutiveDisagreements} consecutive disagreements - may trigger arbitration`);
      }
    } else if (message.stance === 'AGREE' || message.stance === 'PROPOSE') {
      this.consecutiveDisagreements = 0;
    }
  }

  /**
   * Emit decision gate at end of round
   */
  private async emitDecisionGate(): Promise<void> {
    const limits = this.config.limits || DEFAULT_LIMITS;
    const openBlockers = this.structuredState.getOpenBlockers();
    const metrics = this.session.metrics || this.structuredState.calculateMetrics(this.agents.length);
    
    const gate = calculateDecisionGate(metrics, this.costTracker, limits, openBlockers);
    await this.emit({ type: 'decision_gate', gate });
    
    logger.info('Engine', `Decision gate: ${gate.condition}`, {
      agreement: `${(gate.metrics.agreementLevel).toFixed(0)}%`,
      cost: `$${gate.metrics.costSpent.toFixed(4)}`,
    });
  }

  private getResumeInfo(): { skipOpening: boolean; startDiscussionRound: number } {
    if (this.resumeInfo) return this.resumeInfo;

    const hasOpening = this.session.messages.some((m) => 'phase' in m && m.phase === 'OPENING');
    const discussionRounds = this.session.messages
      .filter((m) => 'phase' in m && m.phase === 'DISCUSSION')
      .map((m) => ('round' in m ? m.round : 0))
      .filter((round) => round > 0);
    const lastDiscussionRound = discussionRounds.length > 0 ? Math.max(...discussionRounds) : 0;

    this.resumeInfo = {
      skipOpening: hasOpening,
      startDiscussionRound: Math.max(1, lastDiscussionRound + 1),
    };

    return this.resumeInfo;
  }

  /**
   * Get cost tracker for external access
   */
  getCostTracker(): CostTracker {
    return this.costTracker;
  }

  /**
   * Get structured state for external access
   */
  getStructuredState(): StructuredStateManager {
    return this.structuredState;
  }

  /**
   * Run the complete discussion (non-streaming)
   */
  async run(): Promise<ConsensusOutput> {
    await this.initialize();
    this.protocol.start();
    const resume = this.getResumeInfo();
    if (resume.skipOpening) {
      this.protocol.advance();
    }

    // OPENING PHASE
    if (!this.shouldStop() && !resume.skipOpening) {
      await this.runOpeningPhase();
      if (this.abortRequested) return this.generateOutput();
    }

    // DISCUSSION PHASE
    if (!this.shouldStop() && !this.shouldWrapUp()) {
      await this.runDiscussionPhase(resume.startDiscussionRound);
      if (this.abortRequested) return this.generateOutput();
    }

    // Handle soft interrupt - go directly to consensus
    if (this.shouldWrapUp()) {
      this.isWrappingUp = true;
      await this.emit({ type: 'wrapping_up' });
    }

    // SYNTHESIS PHASE (skip if hard interrupt)
    if (!this.shouldStop()) {
      await this.runSynthesisPhase();
      if (this.abortRequested) return this.generateOutput();
    }

    // CONSENSUS PHASE (always try to run unless hard interrupt)
    if (!this.shouldStop()) {
      await this.runConsensusPhase();
      if (this.abortRequested) return this.generateOutput();
    }

    return this.generateOutput();
  }

  /**
   * Run the discussion with streaming output
   */
  async *runStream(): AsyncIterable<ConsensusEvent> {
    await this.initialize();
    yield { type: 'session_start', session: this.session };
    
    this.protocol.start();
    const resume = this.getResumeInfo();
    if (resume.skipOpening) {
      this.protocol.advance();
    }

    // OPENING PHASE
    if (!this.shouldStop() && !resume.skipOpening) {
      yield* this.runOpeningPhaseStream();
      if (this.abortRequested) {
        const output = this.generateOutput();
        yield { type: 'session_complete', output };
        return;
      }
    }

    // DISCUSSION PHASE
    if (!this.shouldStop() && !this.shouldWrapUp()) {
      yield* this.runDiscussionPhaseStream(resume.startDiscussionRound);
      if (this.abortRequested) {
        const output = this.generateOutput();
        yield { type: 'session_complete', output };
        return;
      }
    }

    // Handle soft interrupt - go directly to wrap up
    if (this.shouldWrapUp()) {
      this.isWrappingUp = true;
      yield { type: 'wrapping_up' };
      yield { type: 'interrupt_soft', reason: 'User requested wrap-up' };
    }

    // Handle hard interrupt
    if (this.shouldStop()) {
      yield { type: 'interrupt_hard', reason: 'User requested immediate stop' };
      const output = this.generateOutput();
      yield { type: 'session_complete', output };
      return;
    }

    // SYNTHESIS PHASE
    if (!this.shouldStop()) {
      yield* this.runSynthesisPhaseStream();
      if (this.abortRequested) {
        const output = this.generateOutput();
        yield { type: 'session_complete', output };
        return;
      }
    }

    // CONSENSUS PHASE
    if (!this.shouldStop()) {
      yield* this.runConsensusPhaseStream();
      if (this.abortRequested) {
        const output = this.generateOutput();
        yield { type: 'session_complete', output };
        return;
      }
    }

    const output = this.generateOutput();
    yield { type: 'session_complete', output };
  }

  /**
   * Opening phase - moderator intro + initial positions
   */
  private async runOpeningPhase(): Promise<void> {
    this.session.currentPhase = 'OPENING';
    this.session.currentRound = 1;
    await this.emit({ type: 'phase_change', phase: 'OPENING', round: 1 });

    // Moderator introduction
    await this.emit({ type: 'moderator_speaking' });
    const intro = await this.moderator.introduce(
      this.config.topic,
      this.config.agents,
      this.config.depth
    );
    this.addMessage(intro);
    await this.emit({ type: 'moderator_message_complete', message: intro });
    await this.finalizeModeratorMessage(intro);
    await this.checkLimitsAndAbort();
    if (this.abortRequested) return;

    // Each agent gives initial position
    for (const agent of this.agents) {
      await this.emit({ type: 'agent_speaking', agentId: agent.id, agentName: agent.name });
      
      const message = await agent.respond(
        this.config.topic,
        this.config.depth,
        1,
        'OPENING',
        this.session.messages
      );
      
      this.addMessage(message);
      this.protocol.recordAgentMessage();
      await this.emit({ type: 'agent_message_complete', message });
      await this.finalizeAgentMessage(agent, message);
      
      const abortReason = await this.checkLimitsAndAbort();
      if (abortReason && abortReason.type !== 'needs_human') return;
    }

    await this.updateMetrics();
    
    // Save session after opening phase (Bug fix #1)
    await this.saveSessionToFile();
    
    this.protocol.advance();
  }

  /**
   * Opening phase with streaming
   */
  private async *runOpeningPhaseStream(): AsyncIterable<ConsensusEvent> {
    this.session.currentPhase = 'OPENING';
    this.session.currentRound = 1;
    logger.info('Engine', 'Starting OPENING phase');
    yield { type: 'phase_change', phase: 'OPENING', round: 1 };

    // Moderator introduction
    logger.moderator('Introducing discussion');
    yield { type: 'moderator_speaking' };
    const intro = await this.moderator.introduce(
      this.config.topic,
      this.config.agents,
      this.config.depth
    );
    this.addMessage(intro);
    yield { type: 'moderator_message_complete', message: intro };
    await this.finalizeModeratorMessage(intro);
    await this.checkLimitsAndAbort();
    if (this.abortRequested) return;

    // Each agent gives initial position (streaming)
    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      this.currentAgentIndex = i;
      
      // Check for skip before agent starts
      if (this.checkSkip()) {
        logger.agent(agent.name, 'Skipped by user');
        yield { type: 'agent_skipped', agentId: agent.id, agentName: agent.name };
        continue;
      }

      logger.agent(agent.name, 'Starting opening statement');
      yield { type: 'agent_speaking', agentId: agent.id, agentName: agent.name };
      
      let wasSkipped = false;
      for await (const { chunk, partialMessage } of agent.respondStream(
        this.config.topic,
        this.config.depth,
        1,
        'OPENING',
        this.session.messages
      )) {
        // Check for skip during streaming
        if (this.checkSkip()) {
          logger.agent(agent.name, 'Skipped during response');
          wasSkipped = true;
          break;
        }
        // Check for hard interrupt
        if (this.shouldStop()) return;

        if (chunk.content) {
          yield { type: 'agent_message_chunk', agentId: agent.id, content: chunk.content };
        }
        if (partialMessage) {
          this.addMessage(partialMessage);
          this.protocol.recordAgentMessage();
          logger.agent(agent.name, 'Completed opening statement');
          yield { type: 'agent_message_complete', message: partialMessage };
          
          await this.finalizeAgentMessage(agent, partialMessage);
          const abortReason = await this.checkLimitsAndAbort();
          if (abortReason && abortReason.type !== 'needs_human') {
            return;
          }
        }
      }

      if (wasSkipped) {
        yield { type: 'agent_skipped', agentId: agent.id, agentName: agent.name };
      }
    }

    // NEW: Update metrics after opening phase
    await this.updateMetrics();

    // Save session after opening phase (Bug fix #1)
    await this.saveSessionToFile();

    this.protocol.advance();
  }

  /**
   * Discussion phase - multiple rounds of debate
   */
  private async runDiscussionPhase(startRound: number = 1): Promise<void> {
    this.session.currentPhase = 'DISCUSSION';
    
    const discussionRounds = this.config.depth - 1; // Reserve last round for synthesis
    
    for (let round = startRound; round <= discussionRounds; round++) {
      // Check for interrupts at start of each round
      if (this.shouldStop() || this.shouldWrapUp()) break;

      this.session.currentRound = round;
      await this.emit({ type: 'phase_change', phase: 'DISCUSSION', round });

      // Get speaking order
      const speakingOrder = DiscussionProtocol.determineSpeakingOrder(
        this.agents.map((a) => a.id),
        this.session.messages,
        'round-robin'
      );

      // Get last moderator summary if available
      const lastSummary = this.session.messages
        .filter((m): m is ModeratorMessage => 'type' in m && m.type === 'summary')
        .pop();

      // Each agent speaks
      for (const agentId of speakingOrder) {
        // Check for interrupts before each agent
        if (this.shouldStop() || this.shouldWrapUp()) break;

        const agent = this.agents.find((a) => a.id === agentId)!;
        await this.emit({ type: 'agent_speaking', agentId: agent.id, agentName: agent.name });
        
        const message = await agent.respond(
          this.config.topic,
          this.config.depth,
          round,
          'DISCUSSION',
          this.session.messages,
          lastSummary?.content
        );
        
        this.addMessage(message);
        this.protocol.recordAgentMessage();
        await this.emit({ type: 'agent_message_complete', message });
        await this.finalizeAgentMessage(agent, message, { trackDisagreements: true });
        
        const abortReason = await this.checkLimitsAndAbort();
        if (abortReason && abortReason.type !== 'needs_human') return;
      }

      // Skip summary if interrupted
      if (this.shouldStop() || this.shouldWrapUp()) break;

      // Update metrics and arbitration before summary
      await this.updateMetrics();
      if (this.arbiter && Arbiter.needsArbitration(this.structuredState.getState())) {
        await this.invokeArbiterIfNeeded();
      }

      // Moderator summarizes the round
      await this.emit({ type: 'moderator_speaking' });
      const summary = await this.moderator.summarizeRound(
        this.config.topic,
        this.session.messages,
        round,
        this.config.depth
      );
      this.addMessage(summary);
      await this.emit({ type: 'moderator_message_complete', message: summary });
      await this.finalizeModeratorMessage(summary);
      await this.emit({ type: 'round_complete', round, summary: summary.content });
      await this.emitDecisionGate();
      
      // Save session to file after each round (Bug fix #1)
      await this.saveSessionToFile();
      
      const abortReason = await this.checkLimitsAndAbort();
      if (abortReason && abortReason.type !== 'needs_human') return;

      this.protocol.advance();
    }
  }

  /**
   * Discussion phase with streaming
   */
  private async *runDiscussionPhaseStream(startRound: number = 1): AsyncIterable<ConsensusEvent> {
    this.session.currentPhase = 'DISCUSSION';
    logger.info('Engine', 'Starting DISCUSSION phase');
    
    const discussionRounds = this.config.depth - 1;
    
    for (let round = startRound; round <= discussionRounds; round++) {
      // Check for interrupts at start of each round
      if (this.shouldStop() || this.shouldWrapUp()) return;

      this.session.currentRound = round;
      logger.info('Engine', `Starting round ${round}/${discussionRounds}`);
      yield { type: 'phase_change', phase: 'DISCUSSION', round };

      const speakingOrder = DiscussionProtocol.determineSpeakingOrder(
        this.agents.map((a) => a.id),
        this.session.messages,
        'round-robin'
      );

      const lastSummary = this.session.messages
        .filter((m): m is ModeratorMessage => 'type' in m && m.type === 'summary')
        .pop();

      for (let i = 0; i < speakingOrder.length; i++) {
        const agentId = speakingOrder[i];
        this.currentAgentIndex = i;
        
        // Check for interrupts before each agent
        if (this.shouldStop() || this.shouldWrapUp()) return;

        // Check for skip
        if (this.checkSkip()) {
          const agent = this.agents.find((a) => a.id === agentId)!;
          logger.agent(agent.name, 'Skipped by user');
          yield { type: 'agent_skipped', agentId: agent.id, agentName: agent.name };
          continue;
        }

        const agent = this.agents.find((a) => a.id === agentId)!;
        logger.info('Engine', `Waiting for ${agent.name} to respond... (${agent.config.provider}:${agent.config.model})`);
        yield { type: 'agent_speaking', agentId: agent.id, agentName: agent.name };
        
        let wasSkipped = false;
        let hasReceivedContent = false;
        const thinkingStart = Date.now();
        let lastThinkingEmit = 0;
        
        for await (const { chunk, partialMessage } of agent.respondStream(
          this.config.topic,
          this.config.depth,
          round,
          'DISCUSSION',
          this.session.messages,
          lastSummary?.content
        )) {
          // Check for hard interrupt during streaming
          if (this.shouldStop()) return;
          
          // Check for skip during streaming
          if (this.checkSkip()) {
            logger.agent(agent.name, 'Skipped during response');
            wasSkipped = true;
            break;
          }

          // Emit thinking event if no content received yet and enough time has passed
          if (!hasReceivedContent && !chunk.content) {
            const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
            if (elapsed >= 5 && elapsed - lastThinkingEmit >= 5) {
              lastThinkingEmit = elapsed;
              logger.info('Engine', `${agent.name} still thinking... (${elapsed}s)`);
              yield { type: 'agent_thinking', agentId: agent.id, agentName: agent.name, elapsed };
            }
          }

          if (chunk.content) {
            hasReceivedContent = true;
            yield { type: 'agent_message_chunk', agentId: agent.id, content: chunk.content };
          }
          if (partialMessage) {
            const totalTime = Math.floor((Date.now() - thinkingStart) / 1000);
            this.addMessage(partialMessage);
            this.protocol.recordAgentMessage();
            logger.info('Engine', `${agent.name} completed response (${totalTime}s)`);
            yield { type: 'agent_message_complete', message: partialMessage };
            
            await this.finalizeAgentMessage(agent, partialMessage, { trackDisagreements: true });
          }
        }

        if (wasSkipped) {
          yield { type: 'agent_skipped', agentId: agent.id, agentName: agent.name };
        }
        
        // NEW: Check limits after each agent
        const abortReason = await this.checkLimitsAndAbort();
        if (abortReason && abortReason.type !== 'needs_human') {
          return;
        }
      }

      // Skip summary if interrupted
      if (this.shouldStop() || this.shouldWrapUp()) return;
      
      // NEW: Update metrics and check for arbitration at end of agent loop
      const metrics = await this.updateMetrics();
      
      // Check if arbitration is needed
      if (this.arbiter && Arbiter.needsArbitration(this.structuredState.getState())) {
        await this.invokeArbiterIfNeeded();
      }

      // Moderator summary (streaming)
      logger.info('Engine', `Waiting for Moderator to summarize round ${round}...`);
      yield { type: 'moderator_speaking' };
      
      let hasReceivedModContent = false;
      const modThinkingStart = Date.now();
      let lastModThinkingEmit = 0;
      
      for await (const { chunk, message } of this.moderator.summarizeRoundStream(
        this.config.topic,
        this.session.messages,
        round,
        this.config.depth
      )) {
        if (this.shouldStop()) return;

        // Emit thinking event if no content received yet
        if (!hasReceivedModContent && !chunk.content) {
          const elapsed = Math.floor((Date.now() - modThinkingStart) / 1000);
          if (elapsed >= 5 && elapsed - lastModThinkingEmit >= 5) {
            lastModThinkingEmit = elapsed;
            logger.info('Engine', `Moderator still thinking... (${elapsed}s)`);
            yield { type: 'moderator_thinking', elapsed };
          }
        }

        if (chunk.content) {
          hasReceivedModContent = true;
          yield { type: 'moderator_message_chunk', content: chunk.content };
        }
        if (message) {
          const totalTime = Math.floor((Date.now() - modThinkingStart) / 1000);
          this.addMessage(message);
          logger.info('Engine', `Moderator completed summary (${totalTime}s)`);
          yield { type: 'moderator_message_complete', message };
          yield { type: 'round_complete', round, summary: message.content };
          await this.finalizeModeratorMessage(message);
          
          // NEW: Emit decision gate at end of round
          await this.emitDecisionGate();
          
          // Save session to file after each round (Bug fix #1)
          await this.saveSessionToFile();
          
          const abortReason = await this.checkLimitsAndAbort();
          if (abortReason && abortReason.type !== 'needs_human') {
            return;
          }
        }
      }

      this.protocol.advance();
    }
  }

  /**
   * Synthesis phase - agents propose merged solutions
   */
  private async runSynthesisPhase(): Promise<void> {
    this.session.currentPhase = 'SYNTHESIS';
    this.session.currentRound = this.config.depth;
    await this.emit({ type: 'phase_change', phase: 'SYNTHESIS', round: this.config.depth });

    // Transition message
    await this.emit({ type: 'moderator_speaking' });
    const transition = await this.moderator.transitionPhase(
      this.config.topic,
      this.session.messages,
      'DISCUSSION',
      'SYNTHESIS',
      this.config.depth
    );
    this.addMessage(transition);
    await this.emit({ type: 'moderator_message_complete', message: transition });
    await this.finalizeModeratorMessage(transition);
    await this.checkLimitsAndAbort();
    if (this.abortRequested) return;

    // Each agent proposes synthesis
    for (const agent of this.agents) {
      await this.emit({ type: 'agent_speaking', agentId: agent.id, agentName: agent.name });
      
      const message = await agent.respond(
        this.config.topic,
        this.config.depth,
        this.config.depth,
        'SYNTHESIS',
        this.session.messages
      );
      
      this.addMessage(message);
      this.protocol.recordAgentMessage();
      await this.emit({ type: 'agent_message_complete', message });
      await this.finalizeAgentMessage(agent, message);
      
      const abortReason = await this.checkLimitsAndAbort();
      if (abortReason && abortReason.type !== 'needs_human') return;
    }

    await this.updateMetrics();
    
    // Save session after synthesis phase (Bug fix #1)
    await this.saveSessionToFile();
    
    this.protocol.advance();
  }

  /**
   * Synthesis phase with streaming
   */
  private async *runSynthesisPhaseStream(): AsyncIterable<ConsensusEvent> {
    this.session.currentPhase = 'SYNTHESIS';
    this.session.currentRound = this.config.depth;
    yield { type: 'phase_change', phase: 'SYNTHESIS', round: this.config.depth };

    // Transition
    yield { type: 'moderator_speaking' };
    const transition = await this.moderator.transitionPhase(
      this.config.topic,
      this.session.messages,
      'DISCUSSION',
      'SYNTHESIS',
      this.config.depth
    );
    this.addMessage(transition);
    yield { type: 'moderator_message_complete', message: transition };
    await this.finalizeModeratorMessage(transition);
    await this.checkLimitsAndAbort();
    if (this.abortRequested) return;

    // Agents synthesize (streaming)
    for (const agent of this.agents) {
      yield { type: 'agent_speaking', agentId: agent.id, agentName: agent.name };
      
      for await (const { chunk, partialMessage } of agent.respondStream(
        this.config.topic,
        this.config.depth,
        this.config.depth,
        'SYNTHESIS',
        this.session.messages
      )) {
        if (chunk.content) {
          yield { type: 'agent_message_chunk', agentId: agent.id, content: chunk.content };
        }
        if (partialMessage) {
          this.addMessage(partialMessage);
          this.protocol.recordAgentMessage();
          yield { type: 'agent_message_complete', message: partialMessage };
          await this.finalizeAgentMessage(agent, partialMessage);
          
          const abortReason = await this.checkLimitsAndAbort();
          if (abortReason && abortReason.type !== 'needs_human') {
            return;
          }
        }
      }
    }

    await this.updateMetrics();
    
    // Save session after synthesis phase (Bug fix #1)
    await this.saveSessionToFile();
    
    this.protocol.advance();
  }

  /**
   * Consensus phase - final conclusion
   */
  private async runConsensusPhase(): Promise<void> {
    this.session.currentPhase = 'CONSENSUS';
    this.session.currentRound = this.config.depth;
    await this.emit({ type: 'phase_change', phase: 'CONSENSUS', round: this.config.depth });

    // Moderator conclusion
    await this.emit({ type: 'moderator_speaking' });
    const conclusion = await this.moderator.conclude(
      this.config.topic,
      this.session.messages,
      this.config.depth
    );
    this.addMessage(conclusion);
    await this.emit({ type: 'moderator_message_complete', message: conclusion });
    await this.finalizeModeratorMessage(conclusion);

    // Analyze consensus
    const consensus = DiscussionProtocol.analyzeConsensus(this.session.messages);
    this.session.consensusReached = consensus.agreementLevel > 0.6;
    this.session.finalConsensus = conclusion.content;
    this.session.isComplete = true;

    // Save final session (Bug fix #1)
    await this.saveSessionToFile();

    await this.emit({ type: 'consensus_reached', consensus: conclusion.content });
  }

  /**
   * Consensus phase with streaming
   */
  private async *runConsensusPhaseStream(): AsyncIterable<ConsensusEvent> {
    this.session.currentPhase = 'CONSENSUS';
    this.session.currentRound = this.config.depth;
    yield { type: 'phase_change', phase: 'CONSENSUS', round: this.config.depth };

    // Moderator conclusion
    yield { type: 'moderator_speaking' };
    const conclusion = await this.moderator.conclude(
      this.config.topic,
      this.session.messages,
      this.config.depth
    );
    this.addMessage(conclusion);
    yield { type: 'moderator_message_complete', message: conclusion };
    await this.finalizeModeratorMessage(conclusion);

    const consensus = DiscussionProtocol.analyzeConsensus(this.session.messages);
    this.session.consensusReached = consensus.agreementLevel > 0.6;
    this.session.finalConsensus = conclusion.content;
    this.session.isComplete = true;

    // Save final session (Bug fix #1)
    await this.saveSessionToFile();

    yield { type: 'consensus_reached', consensus: conclusion.content };
  }

  /**
   * Generate the final output
   */
  private generateOutput(): ConsensusOutput {
    const agentMessages = this.session.messages.filter(
      (m): m is AgentMessage => 'agentId' in m
    );

    const consensus = DiscussionProtocol.analyzeConsensus(this.session.messages);
    
    // Update session with final cost and metrics
    this.session.costEntries = this.costTracker.getEntries();
    this.session.costSummary = this.costTracker.getSummary();
    this.session.structuredState = this.structuredState.getState();
    this.session.metrics = this.structuredState.calculateMetrics(this.agents.length);

    // Log final cost summary
    logger.info('Engine', 'Discussion completed', {
      totalCost: CostTracker.formatCost(this.costTracker.getTotalCost()),
      totalTokens: this.costTracker.getTotalTokens().totalTokens,
      consensusLevel: `${(this.session.metrics?.agreementLevel || 0) * 100}%`,
    });

    return {
      session: this.session,
      summary: {
        topic: this.config.topic,
        participantCount: this.agents.length,
        roundCount: this.config.depth,
        consensusReached: this.session.consensusReached,
        finalConsensus: this.session.finalConsensus || '',
        keyAgreements: consensus.keyAgreements,
        remainingDisagreements: consensus.keyDisagreements,
        agentSummaries: this.agents.map((agent) => {
          const msgs = agentMessages.filter((m) => m.agentId === agent.id);
          return {
            agentName: agent.name,
            personality: agent.config.personality.name,
            keyContributions: msgs.flatMap((m) => m.keyPoints).slice(0, 5),
          };
        }),
      },
      transcript: this.session.messages,
    };
  }

  /**
   * Get current session state
   */
  getSession(): SessionState {
    return this.session;
  }

  /**
   * Resume a previous session
   */
  static async resume(
    previousSession: SessionState,
    additionalRounds: number = 1,
    options?: {
      humanDecision?: string;
      resolveBlockers?: 'all' | string[];
      overrideLimits?: DiscussionConfig['limits'];
    }
  ): Promise<ConsensusEngine> {
    const newConfig: DiscussionConfig = {
      ...previousSession.config,
      depth: previousSession.config.depth + additionalRounds,
      continueFromSession: previousSession.id,
      limits: options?.overrideLimits
        ? { ...previousSession.config.limits, ...options.overrideLimits }
        : previousSession.config.limits,
    };

    const engine = new ConsensusEngine(newConfig);
    const shouldTrim = previousSession.isComplete || previousSession.currentPhase === 'CONSENSUS';
    const trimmedMessages = shouldTrim
      ? previousSession.messages.filter(
          (message) => message.phase !== 'SYNTHESIS' && message.phase !== 'CONSENSUS'
        )
      : previousSession.messages;
    const lastDiscussionRound = trimmedMessages
      .filter((message) => message.phase === 'DISCUSSION')
      .map((message) => message.round)
      .reduce((max, round) => Math.max(max, round), 0);
    const hasOpening = trimmedMessages.some((message) => message.phase === 'OPENING');
    const resumePhase = lastDiscussionRound > 0 ? 'DISCUSSION' : hasOpening ? 'OPENING' : 'OPENING';
    const resumeRound = lastDiscussionRound > 0 ? lastDiscussionRound : 1;

    engine.session = {
      ...previousSession,
      id: nanoid(),
      updatedAt: new Date(),
      config: newConfig,
      isComplete: false,
      consensusReached: false,
      finalConsensus: undefined,
      abortReason: undefined,
      currentPhase: resumePhase,
      currentRound: resumeRound,
      messages: trimmedMessages,
    };
    
    // Rehydrate structured state and costs if available
    if (previousSession.structuredState) {
      engine.structuredState = StructuredStateManager.fromState(previousSession.structuredState);
    } else {
      engine.structuredState = StructuredStateManager.fromMessages(newConfig.topic, previousSession.messages);
    }

    if (previousSession.costEntries && previousSession.costEntries.length > 0) {
      engine.costTracker = CostTracker.fromEntries(previousSession.costEntries);
    }

    if (options?.humanDecision) {
      const decisionText = options.humanDecision.trim();
      if (decisionText.length > 0) {
        const resolutionTargetIds =
          options.resolveBlockers === 'all' || !options.resolveBlockers
            ? engine.structuredState.getOpenBlockers().map((b) => b.id)
            : options.resolveBlockers;

        for (const blockerId of resolutionTargetIds) {
          engine.structuredState.resolveBlocker(blockerId, decisionText);
        }

        engine.structuredState.addDecision('Human decision', decisionText, ['human']);
        engine.session.structuredState = engine.structuredState.getState();

        engine.session.messages.push({
          id: nanoid(),
          timestamp: new Date(),
          phase: engine.session.currentPhase,
          round: engine.session.currentRound,
          type: 'summary',
          content: `Human decision applied:\n${decisionText}`,
        });
      }
    }

    return engine;
  }
}
