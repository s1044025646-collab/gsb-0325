// 核心领域逻辑：类型、结构校验、Batcher 双调网络生成、执行与零一核验（纯函数，不依赖存储）。

export type Direction = 'asc' | 'desc';

export interface Comparator {
  a: number; // 线路下标（0 起），a < b
  b: number;
  dir: Direction; // asc: 小值写到 a；desc: 小值写到 b
  // 生成器保留的解释信息（导入网络可缺省）
  span?: number; // 两条线路的跨度 b - a
  phase?: 'build' | 'merge'; // 双调构造 / 双调合并
}

export interface Stage {
  comparators: Comparator[];
  note?: string; // 阶段解释，例如 "merge span=4 dir=desc"
}

export interface NetworkSpec {
  lines: number;
  stages: Stage[];
}

export const ALLOWED_LINES = [1, 2, 4, 8, 16] as const;
export const MAX_STAGES = 128;
export const MAX_COMPARATORS = 1024;
export const MAX_SPEC_BYTES = 256 * 1024;

export type ErrorCode =
  | 'INVALID_LINES'
  | 'INVALID_DIRECTION'
  | 'LINE_OUT_OF_RANGE'
  | 'SELF_COMPARE'
  | 'STAGE_CONFLICT'
  | 'LIMIT_EXCEEDED'
  | 'INPUT_LENGTH'
  | 'INPUT_NOT_FINITE'
  | 'NOT_FOUND'
  | 'BAD_REQUEST';

export class ApiError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
  }
}

// ---------- 结构校验 ----------

export function validateNetwork(spec: NetworkSpec): NetworkSpec {
  if (!Number.isInteger(spec.lines) || !(ALLOWED_LINES as readonly number[]).includes(spec.lines)) {
    throw new ApiError('INVALID_LINES', `线路数必须是 ${ALLOWED_LINES.join('/')}，收到 ${spec.lines}`);
  }
  if (!Array.isArray(spec.stages)) throw new ApiError('BAD_REQUEST', 'stages 必须是数组');
  if (spec.stages.length > MAX_STAGES) {
    throw new ApiError('LIMIT_EXCEEDED', `阶段数超过上限 ${MAX_STAGES}`);
  }
  let total = 0;
  for (let s = 0; s < spec.stages.length; s++) {
    const stage = spec.stages[s];
    if (!stage || !Array.isArray(stage.comparators)) {
      throw new ApiError('BAD_REQUEST', `阶段 ${s} 缺少 comparators 数组`);
    }
    const used = new Set<number>();
    for (const c of stage.comparators) {
      total++;
      if (total > MAX_COMPARATORS) {
        throw new ApiError('LIMIT_EXCEEDED', `比较器总数超过上限 ${MAX_COMPARATORS}`);
      }
      if (!Number.isInteger(c.a) || !Number.isInteger(c.b)) {
        throw new ApiError('LINE_OUT_OF_RANGE', `阶段 ${s} 存在非整数线路`);
      }
      if (c.a === c.b) throw new ApiError('SELF_COMPARE', `阶段 ${s} 存在同线比较 (${c.a},${c.b})`);
      if (c.a < 0 || c.b < 0 || c.a >= spec.lines || c.b >= spec.lines) {
        throw new ApiError('LINE_OUT_OF_RANGE', `阶段 ${s} 比较器 (${c.a},${c.b}) 越界 [0,${spec.lines})`);
      }
      if (c.dir !== 'asc' && c.dir !== 'desc') {
        throw new ApiError('INVALID_DIRECTION', `阶段 ${s} 比较器 (${c.a},${c.b}) 方向非法: ${c.dir}`);
      }
      for (const line of [c.a, c.b]) {
        if (used.has(line)) {
          throw new ApiError('STAGE_CONFLICT', `阶段 ${s} 线路 ${line} 被重复占用`);
        }
        used.add(line);
      }
    }
  }
  return spec;
}

// ---------- Batcher 双调排序网络生成 ----------

interface AnnotatedComparator extends Comparator {
  span: number;
  phase: 'build' | 'merge';
}

function bitonicSortRec(lo: number, n: number, dir: Direction, out: AnnotatedComparator[]): void {
  if (n <= 1) return;
  const m = n / 2;
  bitonicSortRec(lo, m, 'asc', out); // 左半升序
  bitonicSortRec(lo + m, m, 'desc', out); // 右半降序，构成双调序列
  bitonicMergeRec(lo, n, dir, out);
}

function bitonicMergeRec(lo: number, n: number, dir: Direction, out: AnnotatedComparator[]): void {
  if (n <= 1) return;
  const m = n / 2;
  for (let i = lo; i < lo + m; i++) {
    out.push({ a: i, b: i + m, dir, span: m, phase: 'merge' });
  }
  bitonicMergeRec(lo, m, dir, out);
  bitonicMergeRec(lo + m, m, dir, out);
}

// 把有序比较器列表贪心装入阶段：每个比较器放入其两条线路均空闲的最早阶段。
// 同一阶段内线路互不相交，因此交换顺序不影响语义。
function packStages(comps: AnnotatedComparator[]): Stage[] {
  const stageUsed: Set<number>[] = [];
  const stages: Stage[] = [];
  for (const c of comps) {
    let placed = false;
    for (let s = 0; s < stages.length; s++) {
      if (!stageUsed[s].has(c.a) && !stageUsed[s].has(c.b)) {
        stageUsed[s].add(c.a).add(c.b);
        stages[s].comparators.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) {
      stageUsed.push(new Set([c.a, c.b]));
      stages.push({ comparators: [c] });
    }
  }
  for (const st of stages) {
    const dirs = new Set(st.comparators.map((c) => c.dir));
    const spans = new Set(st.comparators.map((c) => c.span ?? c.b - c.a));
    const phases = new Set(st.comparators.map((c) => c.phase));
    st.note =
      `phase=${[...phases].join('+')} dir=${[...dirs].join('+')} ` +
      `span=${[...spans].sort((x, y) => x - y).join(',')}`;
  }
  return stages;
}

export function generateBatcher(lines: number): NetworkSpec {
  if (!(ALLOWED_LINES as readonly number[]).includes(lines)) {
    throw new ApiError('INVALID_LINES', `Batcher 生成仅支持线路数 ${ALLOWED_LINES.join('/')}`);
  }
  const comps: AnnotatedComparator[] = [];
  if (lines > 1) bitonicSortRec(0, lines, 'asc', comps); // 最终统一升序
  return validateNetwork({ lines, stages: packStages(comps) });
}

// ---------- 执行 ----------

export interface StageTrace {
  stage: number;
  values: number[]; // 该阶段结束后的值
  swaps: { a: number; b: number; dir: Direction }[]; // 本阶段发生交换的比较器
}

export interface RunResult {
  input: number[];
  stages: StageTrace[];
  output: number[];
  inversions: number[]; // 输出中相邻逆序位置 i（output[i] > output[i+1]）
}

export function runNetwork(spec: NetworkSpec, input: number[]): RunResult {
  if (!Array.isArray(input) || input.length !== spec.lines) {
    throw new ApiError('INPUT_LENGTH', `输入长度必须为 ${spec.lines}`);
  }
  for (const v of input) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ApiError('INPUT_NOT_FINITE', `输入必须是有限数字，收到 ${v}`);
    }
  }
  let values = input.slice();
  const traces: StageTrace[] = [];
  for (let s = 0; s < spec.stages.length; s++) {
    const before = values.slice(); // 阶段内所有比较器读取阶段开始时的旧值
    const after = values.slice();
    const swaps: StageTrace['swaps'] = [];
    for (const c of spec.stages[s].comparators) {
      const x = before[c.a]!;
      const y = before[c.b]!;
      const lo = Math.min(x, y);
      const hi = Math.max(x, y);
      const na = c.dir === 'asc' ? lo : hi;
      const nb = c.dir === 'asc' ? hi : lo;
      if (na !== x || nb !== y) swaps.push({ a: c.a, b: c.b, dir: c.dir });
      after[c.a] = na;
      after[c.b] = nb;
    }
    values = after;
    traces.push({ stage: s, values: values.slice(), swaps });
  }
  const inversions: number[] = [];
  for (let i = 0; i + 1 < values.length; i++) {
    if (values[i] > values[i + 1]) inversions.push(i);
  }
  return { input: input.slice(), stages: traces, output: values, inversions };
}

// ---------- 零一原理核验 ----------

// 公开固定次序：caseIndex 从 0 到 2^lines - 1，线路 i 的值为 (caseIndex >> i) & 1。
export function binaryInput(lines: number, caseIndex: number): number[] {
  const input: number[] = [];
  for (let i = 0; i < lines; i++) input.push((caseIndex >>> i) & 1);
  return input;
}

export function totalCases(lines: number): number {
  return 2 ** lines;
}

export interface Counterexample {
  caseIndex: number;
  input: number[];
  stages: StageTrace[];
  output: number[];
  inversions: number[];
}

export interface VerifyStepResult {
  checkedNow: number;
  comparesNow: number;
  nextIndex: number;
  done: boolean;
  counterexample?: Counterexample;
}

// 从 startIndex 起推进核验，受案例数与比较次数预算约束。
export function verifyStep(
  spec: NetworkSpec,
  startIndex: number,
  maxCases: number,
  maxCompares: number
): VerifyStepResult {
  const total = totalCases(spec.lines);
  let idx = startIndex;
  let checkedNow = 0;
  let comparesNow = 0;
  while (idx < total && checkedNow < maxCases && comparesNow < maxCompares) {
    const input = binaryInput(spec.lines, idx);
    const result = runNetwork(spec, input);
    comparesNow += spec.stages.reduce((n, s) => n + s.comparators.length, 0);
    checkedNow++;
    if (result.inversions.length > 0) {
      return {
        checkedNow,
        comparesNow,
        nextIndex: idx, // 失败案例不计入已通过进度，下次从它重新检查
        done: false,
        counterexample: {
          caseIndex: idx,
          input,
          stages: result.stages,
          output: result.output,
          inversions: result.inversions,
        },
      };
    }
    idx++;
  }
  return { checkedNow, comparesNow, nextIndex: idx, done: idx >= total };
}
