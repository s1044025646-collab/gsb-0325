import { AppError, ErrorCode, LIMITS } from './errors.js';
import type { NetworkDef, Stage, StructureCheckResult, StructuralIssue } from './types.js';

const DIRS = new Set(['asc', 'desc']);

export function checkStructure(def: NetworkDef): StructureCheckResult {
  const issues: StructuralIssue[] = [];
  let comparatorCount = 0;

  if (typeof def.wireCount !== 'number' || !Number.isInteger(def.wireCount) || def.wireCount < 1) {
    throw new AppError(ErrorCode.INVALID_PARAM, 'wireCount 必须为不小于 1 的整数', { wireCount: def.wireCount });
  }
  if (!Array.isArray(def.stages)) {
    throw new AppError(ErrorCode.INVALID_PARAM, 'stages 必须为数组');
  }
  if (def.stages.length > LIMITS.MAX_STAGES) {
    issues.push({ code: ErrorCode.TOO_MANY_STAGES, message: `阶段数 ${def.stages.length} 超过上限 ${LIMITS.MAX_STAGES}` });
  }

  def.stages.forEach((stage: Stage, stageIndex) => {
    if (!stage || !Array.isArray(stage.comparators)) {
      issues.push({ code: ErrorCode.INVALID_PARAM, message: '阶段必须包含 comparators 数组', stageIndex });
      return;
    }
    if (typeof stage.explanation === 'string' && stage.explanation.length > LIMITS.MAX_EXPLANATION_CHARS) {
      issues.push({ code: ErrorCode.EXPLANATION_TOO_LARGE, message: `阶段 ${stageIndex} 解释超过 ${LIMITS.MAX_EXPLANATION_CHARS} 字符`, stageIndex });
    }
    const seen = new Map<number, number>();
    stage.comparators.forEach((c, comparatorIndex) => {
      comparatorCount++;
      if (!c || typeof c.a !== 'number' || typeof c.b !== 'number') {
        issues.push({ code: ErrorCode.INVALID_PARAM, message: '比较器必须包含整数线路号 a、b', stageIndex, comparatorIndex });
        return;
      }
      if (!Number.isInteger(c.a) || !Number.isInteger(c.b)) {
        issues.push({ code: ErrorCode.INVALID_PARAM, message: '线路号必须为整数', stageIndex, comparatorIndex });
      }
      if (c.a < 0 || c.b < 0 || c.a >= def.wireCount || c.b >= def.wireCount) {
        issues.push({ code: ErrorCode.WIRE_OUT_OF_RANGE, message: `比较器线路越界：(${c.a}, ${c.b})，线路数 ${def.wireCount}`, stageIndex, comparatorIndex });
      }
      if (c.a === c.b) {
        issues.push({ code: ErrorCode.SAME_WIRE_COMPARATOR, message: `比较器两条线路相同：${c.a}`, stageIndex, comparatorIndex });
      }
      if (!DIRS.has(c.dir)) {
        issues.push({ code: ErrorCode.ILLEGAL_DIRECTION, message: `非法比较方向：${String(c.dir)}，只允许 asc/desc`, stageIndex, comparatorIndex });
      }
      for (const w of [c.a, c.b]) {
        const prev = seen.get(w);
        if (prev !== undefined) {
          issues.push({ code: ErrorCode.DUPLICATE_WIRE_IN_STAGE, message: `线路 ${w} 在同一阶段被比较器 ${prev} 与 ${comparatorIndex} 重复占用`, stageIndex, comparatorIndex });
        } else {
          seen.set(w, comparatorIndex);
        }
      }
    });
  });

  if (comparatorCount > LIMITS.MAX_TOTAL_COMPARATORS) {
    issues.push({ code: ErrorCode.TOO_MANY_COMPARATORS, message: `比较器总数 ${comparatorCount} 超过上限 ${LIMITS.MAX_TOTAL_COMPARATORS}` });
  }

  return { valid: issues.length === 0, issues, comparatorCount };
}

export function assertValidStructure(def: NetworkDef): StructureCheckResult {
  const result = checkStructure(def);
  if (!result.valid) {
    throw new AppError(result.issues[0]!.code as never, result.issues[0]!.message, result.issues);
  }
  return result;
}

export function validateInput(input: unknown, wireCount: number): number[] {
  if (!Array.isArray(input)) {
    throw new AppError(ErrorCode.INVALID_PARAM, '输入必须为数组');
  }
  if (input.length !== wireCount) {
    throw new AppError(ErrorCode.INPUT_LENGTH_MISMATCH, `输入长度必须为 ${wireCount}，实际为 ${input.length}`, { expected: wireCount, actual: input.length });
  }
  const values: number[] = [];
  for (const v of input) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new AppError(ErrorCode.INPUT_NOT_FINITE_NUMBER, '输入必须全部为有限数字（不允许 NaN/Infinity）', { invalidValue: v });
    }
    values.push(v);
  }
  return values;
}
