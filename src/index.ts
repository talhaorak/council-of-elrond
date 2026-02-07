#!/usr/bin/env bun
/**
 * Bot Consensus - Multi-agent AI consensus system
 * 
 * Entry point for programmatic usage. For CLI, use cli.ts
 */

// Core exports
export * from './core/types.js';
export { ConsensusEngine } from './core/engine.js';
export { createInterruptController, type InterruptController } from './core/interrupts.js';

// Agent exports
export { createAgent, AgentFactory } from './agents/factory.js';
export { loadPersonality, getPersonalityTemplates } from './agents/personalities/index.js';

// Provider exports
export { createProvider } from './providers/index.js';

// Config exports
export { buildConfig, validateConfig, loadConfigFile } from './config/loader.js';
export { getDiscussionAlgorithm, listDiscussionAlgorithms } from './algorithms/index.js';

// Output exports
export { generateMarkdown, generateCompactSummary } from './output/markdown.js';
export { SessionManager } from './output/state.js';

// Simple API for AI agents and programmatic use
export {
  runConsensus,
  quickConsensus,
  balancedConsensus,
  continueConsensus,
  listSessions,
  getSession,
  createController,
  runConsensusJSON,
  type ConsensusOptions,
  type ConsensusResult,
  type SimpleAgent,
  type JSONConsensusResult,
} from './api.js';
