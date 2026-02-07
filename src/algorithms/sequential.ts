import type { DiscussionAlgorithm, DiscussionPlanInput, DiscussionRoundPlan } from './types.js';

function createPlans(input: DiscussionPlanInput): DiscussionRoundPlan[] {
  const totalDiscussionRounds = Math.max(1, input.depth - 1);
  const start = Math.max(1, input.startRound);
  const plans: DiscussionRoundPlan[] = [];

  for (let round = start; round <= totalDiscussionRounds; round++) {
    plans.push({
      round,
      mode: 'sequential',
      contextMode: 'full',
      summaryMode: 'standard',
      rotateOffset: 0,
    });
  }

  return plans;
}

export const sequentialAlgorithm: DiscussionAlgorithm = {
  name: 'sequential',
  description: 'Default turn-by-turn discussion where each agent sees all prior context.',
  createRoundPlans: createPlans,
};
