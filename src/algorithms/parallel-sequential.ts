import type { DiscussionAlgorithm, DiscussionPlanInput, DiscussionRoundPlan } from './types.js';

function createPlans(input: DiscussionPlanInput): DiscussionRoundPlan[] {
  const totalDiscussionRounds = Math.max(1, input.depth - 1);
  const start = Math.max(1, input.startRound);
  const plans: DiscussionRoundPlan[] = [];

  for (let round = start; round <= totalDiscussionRounds; round++) {
    const isFirst = round === 1;
    const isParallelVote = totalDiscussionRounds >= 3 && round === totalDiscussionRounds;

    plans.push({
      round,
      mode: isFirst || isParallelVote ? 'parallel' : 'sequential',
      contextMode: 'full',
      summaryMode: 'standard',
      rotateOffset: 0,
    });
  }

  return plans;
}

export const parallelSequentialAlgorithm: DiscussionAlgorithm = {
  name: 'parallel-sequential',
  description:
    'Round 1 divergent parallel broadcast, middle rounds sequential synthesis, final round parallel vote when available.',
  createRoundPlans: createPlans,
};
