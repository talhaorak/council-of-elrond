import type { DiscussionAlgorithm, DiscussionPlanInput, DiscussionRoundPlan } from './types.js';

function createPlans(input: DiscussionPlanInput): DiscussionRoundPlan[] {
  const totalDiscussionRounds = Math.max(1, input.depth - 1);
  const start = Math.max(1, input.startRound);
  const plans: DiscussionRoundPlan[] = [];

  for (let round = start; round <= totalDiscussionRounds; round++) {
    plans.push({
      round,
      mode: 'parallel',
      contextMode: 'anonymous',
      summaryMode: 'anonymous',
      rotateOffset: 0,
    });
  }

  return plans;
}

export const delphiAlgorithm: DiscussionAlgorithm = {
  name: 'delphi',
  description: 'Anonymous parallel rounds with aggregated summaries to reduce groupthink before convergence.',
  createRoundPlans: createPlans,
};
