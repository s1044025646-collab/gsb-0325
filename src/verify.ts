import { executeNetwork } from './execute.js';
import type { Counterexample, NetworkDef } from './types.js';

export interface VerifyOptions {
  /** 本次推进最多检查的案例数 */
  caseBudget?: number | null;
  /** 本次推进最多执行的比较次数 */
  comparisonBudget?: number | null;
  /** 从第几个二进制输入开始（0..2^n-1），用于断点续算 */
  startIndex?: number;
}

export interface VerifyStepResult {
  /** 新的下一未检查输入索引 */
  nextStartIndex: number;
  checkedCases: number;
  comparisonsUsed: number;
  counterexample: Counterexample | null;
  /** true 表示所有 2^n 个输入已全部检查完毕且无反例 */
  completed: boolean;
  /** true 表示在检查完所有案例前预算耗尽 */
  budgetExhausted: boolean;
}

/** 固定公开次序：第 index 个输入 = index 的二进制位映射到线路（低位 -> 线路 0） */
export function binaryInput(index: number, wireCount: number): number[] {
  const input = new Array<number>(wireCount).fill(0);
  for (let bit = 0; bit < wireCount; bit++) {
    input[bit] = (index >>> bit) & 1;
  }
  return input;
}

export function totalCaseCount(wireCount: number): number {
  return 2 ** wireCount;
}

export function verifyStep(def: NetworkDef, options: VerifyOptions = {}): VerifyStepResult {
  const total = totalCaseCount(def.wireCount);
  const start = options.startIndex ?? 0;
  const caseBudget = options.caseBudget ?? null;
  const comparisonBudget = options.comparisonBudget ?? null;

  let index = start;
  let checkedCases = 0;
  let comparisonsUsed = 0;
  let budgetExhausted = false;

  while (index < total) {
    if (caseBudget !== null && checkedCases >= caseBudget) {
      budgetExhausted = true;
      break;
    }
    if (comparisonBudget !== null && def.stages.length > 0) {
      const perCase = def.stages.reduce((sum, s) => sum + s.comparators.length, 0);
      if (comparisonsUsed + perCase > comparisonBudget) {
        budgetExhausted = true;
        break;
      }
    }

    const input = binaryInput(index, def.wireCount);
    const execution = executeNetwork(def, input);
    comparisonsUsed += execution.comparatorComparisons;
    checkedCases++;

    if (!execution.sortedAsc) {
      return {
        nextStartIndex: index + 1,
        checkedCases,
        comparisonsUsed,
        counterexample: {
          input,
          stages: execution.stages,
          output: execution.output,
          inversionPositions: execution.inversionPositions
        },
        completed: false,
        budgetExhausted: false
      };
    }
    index++;
  }

  return {
    nextStartIndex: index,
    checkedCases,
    comparisonsUsed,
    counterexample: null,
    completed: index >= total,
    budgetExhausted
  };
}
