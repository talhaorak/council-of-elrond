import { test, expect } from 'bun:test';
import { ConsensusEngine } from '../src/core/engine.js';
import { createPersonality } from '../src/agents/personalities/index.js';
import type { DiscussionConfig, SessionState, StructuredState, CostEntry } from '../src/core/types.js';

function createConfig(): DiscussionConfig {
  const personality = createPersonality({ name: 'Test Personality' });
  return {
    topic: 'Resume Topic',
    depth: 2,
    agents: [
      {
        id: 'agent-1',
        name: 'Agent One',
        provider: 'lmstudio',
        model: 'local-model',
        personality,
      },
      {
        id: 'agent-2',
        name: 'Agent Two',
        provider: 'lmstudio',
        model: 'local-model',
        personality,
      },
    ],
    moderator: {
      provider: 'lmstudio',
      model: 'local-model',
    },
  };
}

test('ConsensusEngine.resume carries structured state and cost entries', async () => {
  const config = createConfig();
  const structuredState: StructuredState = {
    problem: 'Resume Topic',
    constraints: ['Constraint A'],
    options: [
      {
        id: 'opt-1',
        proposal: 'Option 1',
        proposedBy: 'agent-1',
        supporters: ['agent-1'],
        opponents: [],
        pros: ['Pro A'],
        cons: [],
        risks: [],
      },
    ],
    openQuestions: ['Question 1'],
    decisions: [
      {
        decision: 'Do X',
        rationale: 'Because',
        madeAt: new Date('2025-02-01T00:00:00.000Z'),
        supporters: ['agent-1'],
      },
    ],
    blockers: [],
    consensusLevel: 50,
  };
  const costEntries: CostEntry[] = [
    {
      agentId: 'agent-1',
      agentName: 'Agent One',
      provider: 'lmstudio',
      model: 'local-model',
      timestamp: new Date('2025-02-01T00:01:00.000Z'),
      tokens: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      estimatedCost: 0.002,
      phase: 'DISCUSSION',
      round: 1,
    },
  ];

  const previousSession: SessionState = {
    id: 'session-prev',
    createdAt: new Date('2025-02-01T00:00:00.000Z'),
    updatedAt: new Date('2025-02-01T00:02:00.000Z'),
    config,
    currentPhase: 'DISCUSSION',
    currentRound: 1,
    messages: [],
    isComplete: false,
    consensusReached: false,
    structuredState,
    costEntries,
  };

  const engine = await ConsensusEngine.resume(previousSession, 2);
  const resumedState = engine.getStructuredState().getState();
  const resumedEntries = engine.getCostTracker().getEntries();

  expect(engine.getSession().config.depth).toBe(4);
  expect(resumedState.problem).toBe(structuredState.problem);
  expect(resumedState.options.length).toBe(1);
  expect(resumedState.decisions[0].madeAt).toBeInstanceOf(Date);
  expect(resumedState.decisions[0].madeAt.toISOString()).toBe(
    structuredState.decisions[0].madeAt.toISOString()
  );
  expect(resumedEntries.length).toBe(1);
  expect(resumedEntries[0].timestamp).toBeInstanceOf(Date);
  expect(resumedEntries[0].estimatedCost).toBeCloseTo(0.002, 5);
});
