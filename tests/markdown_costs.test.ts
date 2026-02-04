import { test, expect } from 'bun:test';
import { generateMarkdown } from '../src/output/markdown.js';
import { createPersonality } from '../src/agents/personalities/index.js';
import type { ConsensusOutput, DiscussionConfig } from '../src/core/types.js';

function createConfig(): DiscussionConfig {
  const personality = createPersonality({ name: 'Test Personality' });
  return {
    topic: 'Cost Mapping',
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

test('generateMarkdown maps cost entries to agent names', () => {
  const config = createConfig();
  const output: ConsensusOutput = {
    session: {
      id: 'session-1',
      createdAt: new Date('2025-03-01T00:00:00.000Z'),
      updatedAt: new Date('2025-03-01T00:01:00.000Z'),
      config,
      currentPhase: 'CONSENSUS',
      currentRound: 2,
      messages: [],
      isComplete: true,
      consensusReached: true,
      finalConsensus: 'Done',
      costSummary: {
        totalTokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        totalCost: 0.01,
        costByAgent: {
          'agent-1': 0.004,
          'agent-2': 0.005,
          moderator: 0.001,
        },
        costByPhase: {
          OPENING: 0.003,
          DISCUSSION: 0.006,
          SYNTHESIS: 0.001,
          CONSENSUS: 0.0,
        },
        costByRound: {
          1: 0.006,
          2: 0.004,
        },
        averageCostPerMessage: 0.003,
      },
      metrics: {
        agreementLevel: 0.8,
        keyAgreements: [],
        keyDisagreements: [],
        blockerCount: 0,
        resolvedBlockerCount: 0,
        averageConfidence: 5,
        convergenceRound: null,
      },
    },
    summary: {
      topic: 'Cost Mapping',
      participantCount: 2,
      roundCount: 2,
      consensusReached: true,
      finalConsensus: 'Done',
      keyAgreements: [],
      remainingDisagreements: [],
      agentSummaries: [
        { agentName: 'Agent One', personality: 'Test Personality', keyContributions: [] },
        { agentName: 'Agent Two', personality: 'Test Personality', keyContributions: [] },
      ],
    },
    transcript: [],
  };

  const markdown = generateMarkdown(output);
  expect(markdown).toContain('| Agent One |');
  expect(markdown).toContain('| Agent Two |');
  expect(markdown).toContain('| Moderator |');
});
