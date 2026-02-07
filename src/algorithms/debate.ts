import type { DiscussionAlgorithm, DiscussionPlanInput, DiscussionRoundPlan } from './types.js';

function createPlans(input: DiscussionPlanInput): DiscussionRoundPlan[] {
  const totalDiscussionRounds = Math.max(1, input.depth - 1);
  const start = Math.max(1, input.startRound);
  const plans: DiscussionRoundPlan[] = [];

  for (let round = start; round <= totalDiscussionRounds; round++) {
    plans.push({
      round,
      mode: 'sequential',
      contextMode: 'debate',
      summaryMode: 'standard',
      rotateOffset: round - 1,
    });
  }

  return plans;
}

export const debateAlgorithm: DiscussionAlgorithm = {
  name: 'debate',
  description:
    'Structured rebuttal format with rotating speaker order and argument-focused context between participants.',
  createRoundPlans: createPlans,
};
