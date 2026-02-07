import { debateAlgorithm } from './debate.js';
import { delphiAlgorithm } from './delphi.js';
import { parallelSequentialAlgorithm } from './parallel-sequential.js';
import { sequentialAlgorithm } from './sequential.js';
import { sixHatsAlgorithm } from './six-hats.js';
import type { DiscussionAlgorithm, DiscussionAlgorithmName } from './types.js';

const algorithmRegistry: Record<DiscussionAlgorithmName, DiscussionAlgorithm> = {
  sequential: sequentialAlgorithm,
  'parallel-sequential': parallelSequentialAlgorithm,
  'six-hats': sixHatsAlgorithm,
  debate: debateAlgorithm,
  delphi: delphiAlgorithm,
};

export function getDiscussionAlgorithm(name?: DiscussionAlgorithmName): DiscussionAlgorithm {
  if (!name) {
    return sequentialAlgorithm;
  }

  return algorithmRegistry[name] || sequentialAlgorithm;
}

export function listDiscussionAlgorithms(): DiscussionAlgorithm[] {
  return Object.values(algorithmRegistry);
}

export type {
  DiscussionAlgorithm,
  DiscussionAlgorithmName,
  DiscussionContextMode,
  DiscussionRoundMode,
  DiscussionRoundPlan,
  DiscussionSummaryMode,
} from './types.js';
