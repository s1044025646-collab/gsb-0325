import { validateInput } from './validate.js';
import type { ExecutionResult, NetworkDef, StageExecution } from './types.js';

/**
 * 按阶段执行网络。
 * 阶段内所有比较器并行读取阶段开始时的旧值，相等值不交换。
 */
export function executeNetwork(def: NetworkDef, rawInput: unknown): ExecutionResult {
  const input = validateInput(rawInput, def.wireCount);
  const stageResults: StageExecution[] = [];
  let current = input.slice();
  let comparisons = 0;

  def.stages.forEach((stage, stageIndex) => {
    const before = current.slice();
    const next = current.slice();
    const swapped: StageExecution['swapped'] = [];
    stage.comparators.forEach((c, comparatorIndex) => {
      comparisons++;
      const x = before[c.a]!;
      const y = before[c.b]!;
      if (c.dir === 'asc') {
        if (x > y) {
          next[c.a] = y;
          next[c.b] = x;
          swapped.push({ comparatorIndex, a: c.a, b: c.b });
        }
      } else {
        if (x < y) {
          next[c.a] = y;
          next[c.b] = x;
          swapped.push({ comparatorIndex, a: c.a, b: c.b });
        }
      }
    });
    stageResults.push({ stageIndex, valuesBefore: before, valuesAfter: next, swapped });
    current = next;
  });

  const inversionPositions: number[] = [];
  for (let i = 0; i < current.length - 1; i++) {
    if (current[i]! > current[i + 1]!) inversionPositions.push(i);
  }

  return {
    wireCount: def.wireCount,
    input,
    stages: stageResults,
    output: current,
    inversionPositions,
    sortedAsc: inversionPositions.length === 0,
    comparatorComparisons: comparisons
  };
}
