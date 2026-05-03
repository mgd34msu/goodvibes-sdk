/**
 * PlannerEvent — discriminated union for adaptive planner decisions and overrides.
 */

export type ExecutionStrategy = 'auto' | 'single' | 'cohort' | 'background' | 'remote';

export interface StrategyCandidate {
  readonly strategy: ExecutionStrategy;
  readonly score: number;
  readonly reasonCode: string;
}

export interface PlannerDecision {
  readonly selected: ExecutionStrategy;
  readonly reasonCode: string;
  readonly candidates: readonly StrategyCandidate[];
  readonly overrideActive: boolean;
  readonly timestamp: number;
  readonly inputs: {
    readonly riskScore: number;
    readonly latencyBudgetMs: number;
    readonly isMultiStep: boolean;
    readonly remoteAvailable: boolean;
    readonly backgroundEligible: boolean;
    readonly taskDescription?: string;
  };
}

export type PlannerEvent =
  | ({
    type: 'PLAN_STRATEGY_SELECTED';
  } & PlannerDecision)
  | {
    type: 'PLAN_STRATEGY_OVERRIDDEN';
    strategy: ExecutionStrategy | null;
    clearedBy?: string;
  };

export type PlannerEventType = PlannerEvent['type'];
