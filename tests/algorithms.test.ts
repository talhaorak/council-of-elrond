import { expect, test } from 'bun:test';
import { buildConfig } from '../src/config/loader.js';
import { getDiscussionAlgorithm, listDiscussionAlgorithms } from '../src/algorithms/index.js';

test('buildConfig defaults algorithm to sequential', async () => {
  const config = await buildConfig({
    topic: 'Default algorithm test',
    depth: 3,
    agents: ['skeptic', 'optimist'],
  });

  expect(config.algorithm).toBe('sequential');
});

test('buildConfig accepts explicit algorithm from options', async () => {
  const config = await buildConfig({
    topic: 'Debate algorithm test',
    depth: 4,
    algorithm: 'debate',
    agents: ['skeptic', 'optimist'],
  });

  expect(config.algorithm).toBe('debate');
});

test('algorithm registry exposes expected algorithms', () => {
  const names = listDiscussionAlgorithms().map((algorithm) => algorithm.name).sort();
  expect(names).toEqual([
    'debate',
    'delphi',
    'parallel-sequential',
    'sequential',
    'six-hats',
  ]);
});

test('parallel-sequential creates hybrid round plan', () => {
  const algorithm = getDiscussionAlgorithm('parallel-sequential');
  const plans = algorithm.createRoundPlans({
    depth: 5,
    startRound: 1,
    agentCount: 4,
  });

  expect(plans.map((plan) => plan.mode)).toEqual([
    'parallel',
    'sequential',
    'sequential',
    'parallel',
  ]);
});
