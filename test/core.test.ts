import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ApiError,
  binaryInput,
  generateBatcher,
  runNetwork,
  totalCases,
  validateNetwork,
  verifyStep,
  NetworkSpec,
} from '../src/core';
import { Store } from '../src/db';
import { Service } from '../src/service';

const memService = () => new Service(new Store(':memory:'));

test('Batcher 生成：1/2/4/8/16 线路均通过零一穷举', () => {
  for (const lines of [1, 2, 4, 8, 16]) {
    const spec = generateBatcher(lines);
    const r = verifyStep(spec, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    assert.equal(r.done, true, `lines=${lines}`);
    assert.equal(r.counterexample, undefined);
    assert.equal(r.nextIndex, totalCases(lines));
  }
});

test('穷举案例总数恰为 2^lines', () => {
  for (const lines of [1, 2, 4, 8, 16]) {
    assert.equal(totalCases(lines), 2 ** lines);
    const svc = memService();
    const { networkId } = svc.importNetwork(generateBatcher(lines));
    const v = svc.verify(networkId, {});
    assert.equal(v.status, 'verified');
    assert.equal(v.checked, 2 ** lines);
    svc.store.close();
  }
});

test('二进制输入次序公开固定：线路 i 取第 i 位', () => {
  assert.deepEqual(binaryInput(4, 0), [0, 0, 0, 0]);
  assert.deepEqual(binaryInput(4, 6), [0, 1, 1, 0]);
  assert.deepEqual(binaryInput(4, 15), [1, 1, 1, 1]);
});

test('执行结果与独立数组排序一致（小整数、负数、重复值、降序）', () => {
  const spec = generateBatcher(8);
  const cases = [
    [3, 1, 2, 0, -5, 7, 7, 2],
    [8, 7, 6, 5, 4, 3, 2, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [0, 0, -1, 1e9, -1e9, 42, 42, 3.5],
  ];
  for (const input of cases) {
    const r = runNetwork(spec, input);
    assert.deepEqual(r.output, [...input].sort((a, b) => a - b));
    assert.deepEqual(r.inversions, []);
  }
});

test('手写四线路网络核对阶段语义（阶段内并行读旧值）', () => {
  // 经典 4 线排序网络：[(0,1),(2,3)] [(0,2),(1,3)] [(1,2)]
  const spec: NetworkSpec = {
    lines: 4,
    stages: [
      { comparators: [{ a: 0, b: 1, dir: 'asc' }, { a: 2, b: 3, dir: 'asc' }] },
      { comparators: [{ a: 0, b: 2, dir: 'asc' }, { a: 1, b: 3, dir: 'asc' }] },
      { comparators: [{ a: 1, b: 2, dir: 'asc' }] },
    ],
  };
  const r = runNetwork(spec, [4, 3, 2, 1]);
  assert.deepEqual(r.stages[0].values, [3, 4, 1, 2]);
  assert.deepEqual(r.stages[1].values, [1, 2, 3, 4]);
  assert.deepEqual(r.stages[2].values, [1, 2, 3, 4]);
  assert.deepEqual(r.output, [1, 2, 3, 4]);
  assert.equal(r.stages[0].swaps.length, 2);
  const r2 = verifyStep(spec, 0, 100, 10000);
  assert.equal(r2.done, true);
});

test('打乱同阶段比较器存储顺序不改变结果', () => {
  const spec = generateBatcher(8);
  const shuffled: NetworkSpec = {
    lines: spec.lines,
    stages: spec.stages.map((s) => ({ comparators: [...s.comparators].reverse() })),
  };
  for (let idx = 0; idx < totalCases(8); idx += 17) {
    const input = binaryInput(8, idx);
    assert.deepEqual(runNetwork(shuffled, input).output, runNetwork(spec, input).output);
  }
});

test('结构检查：越界、同线、非法方向、阶段冲突', () => {
  const base = { lines: 4, stages: [{ comparators: [{ a: 0, b: 1, dir: 'asc' as const }] }] };
  assert.throws(() => validateNetwork({ ...base, stages: [{ comparators: [{ a: 0, b: 4, dir: 'asc' }] }] }),
    (e: ApiError) => e.code === 'LINE_OUT_OF_RANGE');
  assert.throws(() => validateNetwork({ ...base, stages: [{ comparators: [{ a: 2, b: 2, dir: 'asc' }] }] }),
    (e: ApiError) => e.code === 'SELF_COMPARE');
  assert.throws(() => validateNetwork({ ...base, stages: [{ comparators: [{ a: 0, b: 1, dir: 'up' as any }] }] }),
    (e: ApiError) => e.code === 'INVALID_DIRECTION');
  assert.throws(
    () => validateNetwork({ ...base, stages: [{ comparators: [{ a: 0, b: 1, dir: 'asc' }, { a: 1, b: 2, dir: 'asc' }] }] }),
    (e: ApiError) => e.code === 'STAGE_CONFLICT');
  assert.throws(() => validateNetwork({ ...base, lines: 3 }), (e: ApiError) => e.code === 'INVALID_LINES');
});

test('输入校验：长度与有限数字', () => {
  const spec = generateBatcher(4);
  assert.throws(() => runNetwork(spec, [1, 2]), (e: ApiError) => e.code === 'INPUT_LENGTH');
  assert.throws(() => runNetwork(spec, [1, 2, 3, NaN]), (e: ApiError) => e.code === 'INPUT_NOT_FINITE');
  assert.throws(() => runNetwork(spec, [1, 2, 3, Infinity]), (e: ApiError) => e.code === 'INPUT_NOT_FINITE');
});

test('线路数一：空阶段网络，行为明确', () => {
  const spec = generateBatcher(1);
  assert.equal(spec.stages.length, 0);
  const r = runNetwork(spec, [42]);
  assert.deepEqual(r.output, [42]);
  assert.deepEqual(r.inversions, []);
  const v = verifyStep(spec, 0, 100, 100);
  assert.equal(v.done, true);
  assert.equal(v.nextIndex, 2);
});

test('删掉关键比较器后给出首个反例与相邻逆序位置', () => {
  const broken = generateBatcher(4);
  broken.stages[broken.stages.length - 1].comparators.pop();
  const r = verifyStep(broken, 0, 100, 10000);
  assert.equal(r.done, false);
  assert.ok(r.counterexample);
  assert.ok(r.counterexample!.inversions.length > 0);
  const ce = r.counterexample!;
  assert.ok(ce.output[ce.inversions[0]] > ce.output[ce.inversions[0] + 1]);
});

test('预算暂停与续算：不漏案例、不重复计数', () => {
  const spec = generateBatcher(4); // 16 案例
  const svc = memService();
  const { networkId } = svc.importNetwork(spec);
  const p1 = svc.verify(networkId, { maxCases: 5 });
  assert.equal(p1.status, 'verifying');
  assert.equal(p1.checked, 5);
  assert.equal(p1.nextIndex, 5);
  const p2 = svc.verify(networkId, { maxCases: 5 });
  assert.equal(p2.checked, 10);
  const p3 = svc.verify(networkId, {});
  assert.equal(p3.status, 'verified');
  assert.equal(p3.checked, 16);
  // 已终结后再次推进不改变计数
  const p4 = svc.verify(networkId, {});
  assert.equal(p4.checked, 16);
  svc.store.close();
});

test('重启后从下一未检查输入继续', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batcher-'));
  const db = path.join(dir, 't.db');
  const spec = generateBatcher(4);
  let svc = new Service(new Store(db));
  const { networkId } = svc.importNetwork(spec);
  svc.verify(networkId, { maxCases: 6 });
  svc.store.close();
  svc = new Service(new Store(db)); // 模拟重启
  const s = svc.verifyStatus(networkId);
  assert.equal(s.nextIndex, 6);
  assert.equal(s.checked, 6);
  const done = svc.verify(networkId, {});
  assert.equal(done.status, 'verified');
  assert.equal(done.checked, 16);
  svc.store.close();
});

test('版本隔离：修改比较器创建新版本，旧证明不沿用', () => {
  const svc = memService();
  const { networkId } = svc.importNetwork(generateBatcher(4));
  svc.verify(networkId, {});
  assert.equal(svc.verifyStatus(networkId, 1).status, 'verified');
  const broken = generateBatcher(4);
  broken.stages[broken.stages.length - 1].comparators.pop();
  const imp = svc.importNetwork(broken, networkId);
  assert.equal(imp.version, 2);
  assert.equal(svc.verifyStatus(networkId, 1).status, 'verified'); // 旧版本证明保留
  assert.equal(svc.verifyStatus(networkId, 2).status, 'verifying'); // 新版本重新核验
  svc.verify(networkId, { version: 2 });
  assert.equal(svc.verifyStatus(networkId, 2).status, 'failed');
  assert.ok(svc.counterexample(networkId, 2).input.length === 4);
  assert.throws(() => svc.counterexample(networkId, 1), (e: ApiError) => e.code === 'NOT_FOUND');
  const versions = svc.versions(networkId);
  assert.deepEqual(versions.map((v) => v.verify), ['verified', 'failed']);
  svc.store.close();
});

test('参数错误与排序反例分开报告', () => {
  const svc = memService();
  assert.throws(() => svc.generate(3), (e: ApiError) => e.code === 'INVALID_LINES');
  const { networkId } = svc.importNetwork(generateBatcher(4));
  assert.throws(() => svc.execute(networkId, [1, 2, 3]), (e: ApiError) => e.code === 'INPUT_LENGTH');
  svc.store.close();
});
