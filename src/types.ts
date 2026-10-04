export type Direction = 'asc' | 'desc';

export interface Comparator {
  a: number;
  b: number;
  dir: Direction;
}

export interface Stage {
  comparators: Comparator[];
  /** 生成器保留的跨度与方向解释；导入网络可为空字符串 */
  explanation?: string;
}

export interface NetworkDef {
  wireCount: number;
  stages: Stage[];
}

export interface NetworkMeta {
  name: string;
  source: 'batcher' | 'custom';
}

export interface StructuralIssue {
  code: string;
  message: string;
  stageIndex?: number;
  comparatorIndex?: number;
}

export interface StructureCheckResult {
  valid: boolean;
  issues: StructuralIssue[];
  comparatorCount: number;
}

export interface StageExecution {
  stageIndex: number;
  valuesBefore: number[];
  valuesAfter: number[];
  /** 本阶段实际发生交换的比较器（线路对与阶段内序号） */
  swapped: Array<{ comparatorIndex: number; a: number; b: number }>;
}

export interface ExecutionResult {
  wireCount: number;
  input: number[];
  stages: StageExecution[];
  output: number[];
  /** 最终输出中的相邻逆序位置 i（output[i] > output[i+1]） */
  inversionPositions: number[];
  sortedAsc: boolean;
  comparatorComparisons: number;
}

export type VerifyStatus = 'unverified' | 'in_progress' | 'verified' | 'counterexample' | 'incomplete';

export interface Counterexample {
  input: number[];
  stages: StageExecution[];
  output: number[];
  inversionPositions: number[];
}

export interface VerifyProgress {
  runId: number;
  networkId: number;
  version: number;
  status: VerifyStatus;
  totalCases: number;
  checkedCases: number;
  comparisonsUsed: number;
  comparisonBudget: number | null;
  caseBudget: number | null;
  nextStartIndex: number;
  counterexample: Counterexample | null;
  updatedAt: string;
}
