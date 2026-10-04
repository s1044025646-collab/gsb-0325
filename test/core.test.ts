import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { generateBitonic } from '../src/generate.js';
import { executeNetwork } from '../src/execute.js';
import { binaryInput, totalCaseCount, verifyStep } from '../src/verify.js';
import { checkStructure } from '../src/validate.js';
import { AppError } from '../src/errors.js';
import type { NetworkDef } from '../src/types.js';

test('生成网络支持 1/2/4/8/16 且拒绝其他线路数', () => {
  for (const n of [1, 2, 4, 8, 16]) {
    const def = generateBitonic(n);
    assert.equal(def.wireCount, n);
    assert.ok(checkStructure(def).valid);
  }
  assert.throws(() => generateBitonic(3), (e: Error) => e instanceof AppError && e.code === 'UNSUPPORTED_SIZE');
});

test('所有允许规模通过完整零一穷举，案例数恰为 2^n', () => {
  for (const n of [1, 2, 4, 8, 16]) {
    const def = generateBitonic(n);
    const step = verifyStep(def, {});
    assert.equal(step.counterexample, null, `n=${n} 不应有反例`);
    assert.equal(step.completed, true);
    assert.equal(step.checkedCases, totalCaseCount(n));
    assert.equal(step.checkedCases, 2 ** n);
  }
});

test('独立数组排序核对最终结果（负数、重复、降序、小数）', () => {
  const def = generateBitonic(16);
  const cases: number[][] = [
    [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    Array.from({ length: 16 }, (_, i) => (i % 3) - 1),
    [-5.5, 3, 0, 3, -5.5, 7, 7, -100, 2, 2, 2, 9, -0, 4.2, 4.2, -1],
    new Array(16).fill(2)
  ];
  for (const input of cases) {
    const got = executeNetwork(def, input).output;
    const want = input.slice().sort((a, b) => a - b);
    assert.equal(got.length, want.length);
    assert.ok(got.every((v, i) => v === want[i] || (Object.is(v, 0) && Object.is(want[i], -0))), `got=${got} want=${want}`);
    assert.equal(executeNetwork(def, input).inversionPositions.length, 0);
  }
});

test('手写四线路网络阶段语义：阶段内并行读旧值', () => {
  const def: NetworkDef = {
    wireCount: 4,
    stages: [
      { comparators: [{ a: 0, b: 1, dir: 'asc' }, { a: 2, b: 3, dir: 'asc' }] },
      { comparators: [{ a: 0, b: 2, dir: 'asc' }, { a: 1, b: 3, dir: 'asc' }] },
      { comparators: [{ a: 1, b: 2, dir: 'asc' }] }
    ]
  };
  const r = executeNetwork(def, [4, 3, 2, 1]);
  assert.deepEqual(r.stages[0]!.valuesBefore, [4, 3, 2, 1]);
  assert.deepEqual(r.stages[0]!.valuesAfter, [3, 4, 1, 2]);
  assert.deepEqual(r.stages[1]!.valuesAfter, [1, 2, 3, 4]);
  assert.deepEqual(r.stages[2]!.swapped, []);
  assert.deepEqual(r.output, [1, 2, 3, 4]);
  assert.equal(r.sortedAsc, true);
});

test('打乱同阶段比较器存储顺序不改变结果', () => {
  const def = generateBitonic(16);
  const shuffled: NetworkDef = {
    wireCount: 16,
    stages: def.stages.map((s) => ({ ...s, comparators: [...s.comparators].reverse() }))
  };
  const input = [9, -1, 4, 4, 0, 7, -3, 2, 8, 8, 1, 5, -6, 3, 3, 10];
  assert.deepEqual(executeNetwork(shuffled, input).output, executeNetwork(def, input).output);
  const a = verifyStep(shuffled, {});
  const b = verifyStep(def, {});
  assert.equal(a.counterexample, null);
  assert.equal(b.counterexample, null);
  assert.equal(a.checkedCases, b.checkedCases);
});

test('相等值不制造交换；降序比较器可出现在内部阶段', () => {
  const def = generateBitonic(4);
  const r = executeNetwork(def, [5, 5, 5, 5]);
  assert.equal(r.stages.every((s) => s.swapped.length === 0), true);
  assert.ok(def.stages.some((s) => s.comparators.some((c) => c.dir === 'desc')));
});

test('删除关键比较器产生零一反例并给出逐阶段输出与逆序位置', () => {
  const n4 = generateBitonic(4);
  const broken: NetworkDef = {
    wireCount: 4,
    stages: n4.stages.map((s, i) => (i === n4.stages.length - 1 ? { ...s, comparators: s.comparators.slice(0, -1) } : s))
  };
  const step = verifyStep(broken, {});
  assert.ok(step.counterexample);
  const ce = step.counterexample!;
  assert.deepEqual(ce.input, binaryInput(step.nextStartIndex - 1, 4));
  assert.ok(ce.inversionPositions.length > 0);
  assert.equal(ce.stages.length, broken.stages.length);
});

test('结构检查：越界、同线、非法方向、阶段内重复占用', () => {
  const cases: NetworkDef[] = [
    { wireCount: 4, stages: [{ comparators: [{ a: 0, b: 4, dir: 'asc' }] }] },
    { wireCount: 4, stages: [{ comparators: [{ a: 2, b: 2, dir: 'asc' }] }] },
    { wireCount: 4, stages: [{ comparators: [{ a: 0, b: 1, dir: 'up' as never }] }] },
    {
      wireCount: 4,
      stages: [{ comparators: [{ a: 0, b: 1, dir: 'asc' }, { a: 1, b: 2, dir: 'asc' }] }]
    }
  ];
  const expectedCodes = ['WIRE_OUT_OF_RANGE', 'SAME_WIRE_COMPARATOR', 'ILLEGAL_DIRECTION', 'DUPLICATE_WIRE_IN_STAGE'];
  cases.forEach((def, i) => {
    const result = checkStructure(def);
    assert.equal(result.valid, false);
    assert.equal(result.issues[0]!.code, expectedCodes[i]);
  });
});

test('输入校验：长度、NaN/Infinity、非数字', () => {
  const def = generateBitonic(4);
  assert.throws(() => executeNetwork(def, [1, 2, 3]), (e: Error) => e instanceof AppError && e.code === 'INPUT_LENGTH_MISMATCH');
  for (const bad of [[1, 2, 3, NaN], [1, 2, 3, Infinity], [1, 2, 3, 'x' as never]]) {
    assert.throws(() => executeNetwork(def, bad), (e: Error) => e instanceof AppError && e.code === 'INPUT_NOT_FINITE_NUMBER');
  }
});

test('预算暂停：分段穷举不漏不重，完成后才 verified', () => {
  const def = generateBitonic(8);
  let start = 0;
  let total = 0;
  let status: 'running' | 'done' = 'running';
  while (status === 'running') {
    const step = verifyStep(def, { startIndex: start, caseBudget: 37 });
    total += step.checkedCases;
    start = step.nextStartIndex;
    if (step.counterexample) throw new Error('不应有反例');
    if (step.completed) status = 'done';
    assert.ok(step.budgetExhausted || status === 'done');
  }
  assert.equal(total, 256);
  assert.equal(start, 256);
});

test('比较次数预算同样可暂停', () => {
  const def = generateBitonic(4);
  const perCase = def.stages.reduce((s, st) => s + st.comparators.length, 0);
  const step = verifyStep(def, { startIndex: 0, comparisonBudget: perCase * 2 + 1 });
  assert.equal(step.checkedCases, 2);
  assert.equal(step.budgetExhausted, true);
  assert.equal(step.nextStartIndex, 2);
});

test('二进制输入固定公开次序：低位映射线路0', () => {
  assert.deepEqual(binaryInput(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(binaryInput(1, 4), [1, 0, 0, 0]);
  assert.deepEqual(binaryInput(5, 4), [1, 0, 1, 0]);
  assert.deepEqual(binaryInput(15, 4), [1, 1, 1, 1]);
});

test('一线路与空阶段', () => {
  const def = generateBitonic(1);
  assert.deepEqual(def.stages, []);
  const r = executeNetwork(def, [7]);
  assert.deepEqual(r.output, [7]);
  assert.equal(r.sortedAsc, true);
  assert.equal(verifyStep(def, {}).checkedCases, 2);
});

test('SQLite 持久化：重启续算与网络版本隔离', async () => {
  const { Store } = await import('../src/db.js');
  const { AppService } = await import('../src/service.js');
  const dbPath = 'data/test-batcher.sqlite';
  rmSync(dbPath, { force: true });

  let store = new Store(dbPath);
  let svc = new AppService(store);
  const created = svc.generate('v1-8', 8);
  const p1 = svc.advanceVerify(created.networkId, { caseBudget: 60 });
  assert.equal(p1.status, 'incomplete');
  assert.equal(p1.checkedCases, 60);
  assert.equal(p1.nextStartIndex, 60);
  store.close();

  store = new Store(dbPath);
  svc = new AppService(store);
  const p2 = svc.advanceVerify(created.networkId, {});
  assert.equal(p2.checkedCases, 256);
  assert.equal(p2.status, 'verified');

  const n4 = generateBitonic(4);
  const broken: NetworkDef = {
    wireCount: 4,
    stages: n4.stages.map((s, i) => (i === n4.stages.length - 1 ? { ...s, comparators: s.comparators.slice(0, -1) } : s))
  };
  const other = svc.importNetwork('broken-4', broken);
  const cp = svc.advanceVerify(other.networkId, {});
  assert.equal(cp.status, 'counterexample');
  assert.ok(cp.counterexample);

  const v2 = svc.addVersion(created.networkId, { wireCount: 8, stages: n4.stages as never });
  assert.equal(v2.version, 2);
  assert.equal(svc.getProgress(created.networkId, 2), null);
  assert.equal(svc.getProgress(created.networkId, 1)!.status, 'verified');
  const pv2 = svc.advanceVerify(created.networkId, {}, 2);
  assert.equal(pv2.status, 'counterexample');
  assert.equal(svc.getProgress(created.networkId, 1)!.status, 'verified');

  const exec = svc.execute(created.networkId, [8, 7, 6, 5, 4, 3, 2, 1], 1);
  const run = svc.getRun(exec.runId);
  assert.deepEqual(run.result.output, [1, 2, 3, 4, 5, 6, 7, 8]);

  assert.throws(() => svc.addVersion(created.networkId, { wireCount: 4, stages: [] }), (e: Error) => e instanceof AppError && e.code === 'INVALID_PARAM');
  store.close();
});
