import type { DiscussionAlgorithm, DiscussionPlanInput, DiscussionRoundPlan } from './types.js';

function createPlans(input: DiscussionPlanInput): DiscussionRoundPlan[] {
  const totalDiscussionRounds = Math.max(1, input.depth - 1);
  const start = Math.max(1, input.startRound);
  const plans: DiscussionRoundPlan[] = [];

  for (let round = start; round <= totalDiscussionRounds; round++) {
    plans.push({
      round,
      mode: 'parallel',
      contextMode: 'full',
      summaryMode: 'standard',
      rotateOffset: 0,
    });
  }

  return plans;
}

export const sixHatsAlgorithm: DiscussionAlgorithm = {
  name: 'six-hats',
  description: 'All agents think in parallel per round from distinct perspectives, then moderator synthesizes.',
  createRoundPlans: createPlans,
};
