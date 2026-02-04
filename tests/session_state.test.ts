import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionManager } from '../src/output/state.js';
import { createPersonality } from '../src/agents/personalities/index.js';
import type { DiscussionConfig, SessionState } from '../src/core/types.js';

function createConfig(): DiscussionConfig {
  const personality = createPersonality({ name: 'Test Personality' });
  return {
    topic: 'Test Topic',
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

test('SessionManager.load rehydrates dates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-consensus-'));
  const manager = new SessionManager(dir);
  const config = createConfig();
  const createdAt = new Date('2025-01-01T00:00:00.000Z');
  const updatedAt = new Date('2025-01-01T00:05:00.000Z');
  const session: SessionState = {
    id: 'session-1',
    createdAt,
    updatedAt,
    config,
    currentPhase: 'DISCUSSION',
    currentRound: 1,
    messages: [
      {
        id: 'm1',
        agentId: 'agent-1',
        agentName: 'Agent One',
        timestamp: new Date('2025-01-01T00:01:00.000Z'),
        phase: 'OPENING',
        round: 1,
        stance: 'PROPOSE',
        content: 'Opening thoughts',
        referencedMessageIds: [],
        keyPoints: ['Point A'],
      },
      {
        id: 'm2',
        timestamp: new Date('2025-01-01T00:02:00.000Z'),
        phase: 'DISCUSSION',
        round: 1,
        type: 'summary',
        content: 'Summary text',
      },
    ],
    isComplete: false,
    consensusReached: false,
    structuredState: {
      problem: 'Test Topic',
      constraints: [],
      options: [],
      openQuestions: [],
      decisions: [
        {
          decision: 'Do X',
          rationale: 'Because',
          madeAt: new Date('2025-01-01T00:03:00.000Z'),
          supporters: ['agent-1'],
        },
      ],
      blockers: [],
      consensusLevel: 0,
    },
    costEntries: [
      {
        agentId: 'agent-1',
        agentName: 'Agent One',
        provider: 'lmstudio',
        model: 'local-model',
        timestamp: new Date('2025-01-01T00:04:00.000Z'),
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        estimatedCost: 0.001,
        phase: 'OPENING',
        round: 1,
      },
    ],
  };

  try {
    await manager.save(session);
    const loaded = await manager.load('session-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.createdAt).toBeInstanceOf(Date);
    expect(loaded?.updatedAt).toBeInstanceOf(Date);
    expect(loaded?.messages[0]?.timestamp).toBeInstanceOf(Date);
    expect(loaded?.structuredState?.decisions[0]?.madeAt).toBeInstanceOf(Date);
    expect(loaded?.costEntries?.[0]?.timestamp).toBeInstanceOf(Date);
    expect(loaded?.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(loaded?.updatedAt.toISOString()).toBe(updatedAt.toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
