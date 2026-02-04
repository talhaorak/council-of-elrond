import { z } from 'zod';

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

export const Phase = {
  OPENING: 'OPENING',
  DISCUSSION: 'DISCUSSION',
  SYNTHESIS: 'SYNTHESIS',
  CONSENSUS: 'CONSENSUS',
} as const;

export type Phase = (typeof Phase)[keyof typeof Phase];

export const Stance = {
  PROPOSE: 'PROPOSE',
  AGREE: 'AGREE',
  DISAGREE: 'DISAGREE',
  REFINE: 'REFINE',
  CHALLENGE: 'CHALLENGE',
  PASS: 'PASS',
} as const;

export type Stance = (typeof Stance)[keyof typeof Stance];

export const Provider = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GOOGLE: 'google',
  OLLAMA: 'ollama',
  LMSTUDIO: 'lmstudio',
  OPENROUTER: 'openrouter',
} as const;

export type Provider = (typeof Provider)[keyof typeof Provider];

// ============================================================================
// PERSONALITY SYSTEM
// ============================================================================

export const PersonalityArchetype = {
  SKEPTIC: 'skeptic',
  OPTIMIST: 'optimist',
  PESSIMIST: 'pessimist',
  PRAGMATIST: 'pragmatist',
  INNOVATOR: 'innovator',
  DEVILS_ADVOCATE: 'devils-advocate',
  ANALYST: 'analyst',
  MEDIATOR: 'mediator',
} as const;

export type PersonalityArchetype = (typeof PersonalityArchetype)[keyof typeof PersonalityArchetype];

export interface PersonalityTrait {
  name: string;
  description: string;
  weight: number; // 0-1, how strongly this trait influences responses
}

export interface Personality {
  archetype?: PersonalityArchetype;
  name: string;
  description: string;
  traits: PersonalityTrait[];
  systemPromptAddition: string;
  communicationStyle: {
    tone: string;
    verbosity: 'concise' | 'moderate' | 'detailed';
    formality: 'casual' | 'balanced' | 'formal';
  };
}

// ============================================================================
// AGENT CONFIGURATION
// ============================================================================

export interface AgentConfig {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  personality: Personality;
  apiKey?: string;
  baseUrl?: string; // For Ollama/LM Studio
  temperature?: number;
  maxTokens?: number;
}

export interface ModeratorConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
}

// ============================================================================
// MESSAGES & COMMUNICATION
// ============================================================================

export interface AgentMessage {
  id: string;
  agentId: string;
  agentName: string;
  timestamp: Date;
  phase: Phase;
  round: number;
  stance: Stance;
  content: string;
  referencedMessageIds: string[];
  keyPoints: string[];
  blockers?: Blocker[];      // Structured objections raised
  proposal?: DiscussionOption;  // Structured proposal if proposing
  tokenUsage?: TokenUsage;   // Token usage for this message
  metadata?: Record<string, unknown>;
}

export interface ModeratorMessage {
  id: string;
  timestamp: Date;
  phase: Phase;
  round: number;
  type: 'introduction' | 'summary' | 'transition' | 'conclusion';
  content: string;
  identifiedAgreements?: string[];
  identifiedDisagreements?: string[];
  nextSteps?: string[];
}

export type Message = AgentMessage | ModeratorMessage;

export function isAgentMessage(msg: Message): msg is AgentMessage {
  return 'agentId' in msg;
}

export function isModeratorMessage(msg: Message): msg is ModeratorMessage {
  return 'type' in msg;
}

// ============================================================================
// SESSION & STATE
// ============================================================================

export interface DiscussionConfig {
  topic: string;
  depth: number; // Number of discussion rounds
  agents: AgentConfig[];
  moderator: ModeratorConfig;
  arbiter?: ArbiterConfig;  // Optional arbiter for tie-breaking
  limits?: DiscussionLimits;  // Cost/time/token limits
  outputPath?: string;
  outputToStdout?: boolean;
  continueFromSession?: string;
}

export interface SessionState {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  config: DiscussionConfig;
  currentPhase: Phase;
  currentRound: number;
  messages: Message[];
  isComplete: boolean;
  consensusReached: boolean;
  finalConsensus?: string;
  // New fields for improvements
  structuredState?: StructuredState;
  costEntries?: CostEntry[];
  costSummary?: CostSummary;
  metrics?: ConsensusMetrics;
  abortReason?: AbortReason;
  arbiterDecisions?: ArbiterDecision[];
}

// ============================================================================
// PROVIDER INTERFACES
// ============================================================================

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface LLMProvider {
  name: Provider;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<StreamChunk>;
  isAvailable(): Promise<boolean>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

// ============================================================================
// OUTPUT
// ============================================================================

export interface ConsensusOutput {
  session: SessionState;
  summary: {
    topic: string;
    participantCount: number;
    roundCount: number;
    consensusReached: boolean;
    finalConsensus: string;
    keyAgreements: string[];
    remainingDisagreements: string[];
    agentSummaries: {
      agentName: string;
      personality: string;
      keyContributions: string[];
    }[];
  };
  transcript: Message[];
}

// ============================================================================
// BLOCKER SCHEMA (Structured Objections)
// ============================================================================

export interface Blocker {
  id: string;
  condition: string;      // When this issue occurs
  impact: string;         // What breaks or goes wrong
  detection: string;      // How to notice/measure this issue
  mitigation: string;     // Concrete action to address it
  severity: 1 | 2 | 3 | 4 | 5;     // 1=minor, 5=critical
  confidence: 1 | 2 | 3 | 4 | 5;   // 1=speculation, 5=certain
  raisedBy: string;       // Agent ID who raised it
  status: 'open' | 'addressed' | 'disputed' | 'escalated';
  resolution?: string;    // How it was resolved
}

export const BlockerSchema = z.object({
  id: z.string(),
  condition: z.string().min(10),
  impact: z.string().min(10),
  detection: z.string().min(10),
  mitigation: z.string().min(10),
  severity: z.number().int().min(1).max(5),
  confidence: z.number().int().min(1).max(5),
  raisedBy: z.string(),
  status: z.enum(['open', 'addressed', 'disputed', 'escalated']),
  resolution: z.string().optional(),
});

// ============================================================================
// STRUCTURED STATE (Optimized Context Passing)
// ============================================================================

export interface DiscussionOption {
  id: string;
  proposal: string;
  proposedBy: string;
  pros: string[];
  cons: string[];
  risks: string[];
  supporters: string[];    // Agent IDs who support this
  opponents: string[];     // Agent IDs who oppose this
}

export interface StructuredState {
  problem: string;
  constraints: string[];
  options: DiscussionOption[];
  openQuestions: string[];
  decisions: Array<{
    decision: string;
    rationale: string;
    madeAt: Date;
    supporters: string[];
  }>;
  blockers: Blocker[];
  consensusLevel: number;  // 0-100 percentage
}

// ============================================================================
// COST TRACKING
// ============================================================================

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CostEntry {
  agentId: string;
  agentName: string;
  provider: Provider;
  model: string;
  timestamp: Date;
  tokens: TokenUsage;
  estimatedCost: number;  // in USD
  phase: Phase;
  round: number;
}

export interface CostSummary {
  totalTokens: TokenUsage;
  totalCost: number;
  costByAgent: Record<string, number>;
  costByPhase: Record<Phase, number>;
  costByRound: Record<number, number>;
  averageCostPerMessage: number;
}

// ============================================================================
// ABORT CONDITIONS & LIMITS
// ============================================================================

export interface DiscussionLimits {
  maxCostUsd?: number;           // Maximum total cost in USD
  maxDurationMs?: number;        // Maximum duration in milliseconds
  maxTokens?: number;            // Maximum total tokens
  maxBlockers?: number;          // Maximum unresolved blockers before abort
  maxConsecutiveDisagreements?: number;  // Max disagreements before arbitration
  requireHumanDecision?: boolean; // Require human decision when critical blockers occur
}

export type AbortReason = 
  | { type: 'cost_limit'; spent: number; limit: number }
  | { type: 'time_limit'; elapsed: number; limit: number }
  | { type: 'token_limit'; used: number; limit: number }
  | { type: 'blocker_limit'; count: number; limit: number }
  | { type: 'deadlock'; description: string }
  | { type: 'needs_human'; blockers: Blocker[] }
  | { type: 'user_interrupt'; interruptType: 'soft' | 'hard' };

// ============================================================================
// DECISION GATES & QUALITY METRICS
// ============================================================================

export interface ConsensusMetrics {
  agreementLevel: number;        // 0-1, percentage of agents in agreement
  keyAgreements: string[];
  keyDisagreements: string[];
  blockerCount: number;
  resolvedBlockerCount: number;
  averageConfidence: number;     // Average confidence across agents
  convergenceRound: number | null;  // When consensus was reached
}

export interface DecisionGate {
  name: string;
  condition: 'go' | 'no-go' | 'expand' | 'needs-human';
  metrics: {
    agreementLevel: number;
    costSpent: number;
    costLimit: number;
    blockerCount: number;
    timeSpent: number;
  };
  recommendation: string;
}

// ============================================================================
// ARBITER (Tie-Breaking)
// ============================================================================

export interface ArbiterConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface ArbiterDecision {
  blockerId: string;
  decision: 'accept' | 'reject' | 'merge';
  rationale: string;
  mergedResolution?: string;
  timestamp: Date;
}

// ============================================================================
// EVENTS (for streaming UI updates)
// ============================================================================

export type ConsensusEvent =
  | { type: 'session_start'; session: SessionState }
  | { type: 'phase_change'; phase: Phase; round: number }
  | { type: 'agent_speaking'; agentId: string; agentName: string }
  | { type: 'agent_thinking'; agentId: string; agentName: string; elapsed: number }
  | { type: 'agent_message_chunk'; agentId: string; content: string }
  | { type: 'agent_message_complete'; message: AgentMessage }
  | { type: 'agent_skipped'; agentId: string; agentName: string }
  | { type: 'moderator_speaking' }
  | { type: 'moderator_thinking'; elapsed: number }
  | { type: 'moderator_message_chunk'; content: string }
  | { type: 'moderator_message_complete'; message: ModeratorMessage }
  | { type: 'round_complete'; round: number; summary: string }
  | { type: 'consensus_reached'; consensus: string }
  | { type: 'session_complete'; output: ConsensusOutput }
  | { type: 'error'; error: string }
  | { type: 'interrupt_soft'; reason: string }
  | { type: 'interrupt_hard'; reason: string }
  | { type: 'wrapping_up' }
  // New events for improvements
  | { type: 'cost_update'; cost: CostEntry; totalCost: number }
  | { type: 'blocker_raised'; blocker: Blocker }
  | { type: 'blocker_resolved'; blockerId: string; resolution: string }
  | { type: 'blocker_escalated'; blocker: Blocker }
  | { type: 'arbiter_invoked'; reason: string }
  | { type: 'arbiter_decision'; decision: ArbiterDecision }
  | { type: 'abort'; reason: AbortReason }
  | { type: 'decision_gate'; gate: DecisionGate }
  | { type: 'state_update'; state: StructuredState }
  | { type: 'metrics_update'; metrics: ConsensusMetrics };

// ============================================================================
// ZOD SCHEMAS (for validation)
// ============================================================================

export const PersonalityTraitSchema = z.object({
  name: z.string(),
  description: z.string(),
  weight: z.number().min(0).max(1),
});

export const PersonalitySchema = z.object({
  archetype: z.nativeEnum(PersonalityArchetype).optional(),
  name: z.string(),
  description: z.string(),
  traits: z.array(PersonalityTraitSchema),
  systemPromptAddition: z.string(),
  communicationStyle: z.object({
    tone: z.string(),
    verbosity: z.enum(['concise', 'moderate', 'detailed']),
    formality: z.enum(['casual', 'balanced', 'formal']),
  }),
});

export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.nativeEnum(Provider),
  model: z.string(),
  personality: PersonalitySchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
});

export const ModeratorConfigSchema = z.object({
  provider: z.nativeEnum(Provider),
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const DiscussionConfigSchema = z.object({
  topic: z.string().min(1),
  depth: z.number().int().min(1).max(10),
  agents: z.array(AgentConfigSchema).min(2),
  moderator: ModeratorConfigSchema,
  outputPath: z.string().optional(),
  outputToStdout: z.boolean().optional(),
  continueFromSession: z.string().optional(),
});
