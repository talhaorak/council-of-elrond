export const DISCUSSION_ALGORITHMS = {
  SEQUENTIAL: 'sequential',
  PARALLEL_SEQUENTIAL: 'parallel-sequential',
  SIX_HATS: 'six-hats',
  DEBATE: 'debate',
  DELPHI: 'delphi',
} as const;

export type DiscussionAlgorithmName =
  (typeof DISCUSSION_ALGORITHMS)[keyof typeof DISCUSSION_ALGORITHMS];

export type DiscussionRoundMode = 'sequential' | 'parallel';

export type DiscussionContextMode = 'full' | 'debate' | 'anonymous';

export type DiscussionSummaryMode = 'standard' | 'anonymous';

export interface DiscussionRoundPlan {
  round: number;
  mode: DiscussionRoundMode;
  contextMode: DiscussionContextMode;
  summaryMode: DiscussionSummaryMode;
  rotateOffset: number;
}

export interface DiscussionPlanInput {
  depth: number;
  startRound: number;
  agentCount: number;
}

export interface DiscussionAlgorithm {
  name: DiscussionAlgorithmName;
  description: string;
  createRoundPlans(input: DiscussionPlanInput): DiscussionRoundPlan[];
}
