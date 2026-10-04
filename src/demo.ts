import { rmSync } from 'node:fs';
import { generateBitonic } from './generate.js';
import { executeNetwork } from './execute.js';
import { verifyStep, totalCaseCount } from './verify.js';
import type { NetworkDef } from './types.js';

function hr(title: string): void {
  console.log(`\n================ ${title} ================`);
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

hr('1. 生成四线路 Batcher 双调排序网络');
const n4 = generateBitonic(4);
console.log(`阶段数=${n4.stages.length}，比较器数=${n4.stages.reduce((s, x) => s + x.comparators.length, 0)}`);
n4.stages.forEach((st, i) => {
  console.log(`阶段 ${i}: ${st.comparators.map((c) => `(${c.a},${c.b},${c.dir === 'asc' ? '↑' : '↓'})`).join(' ')}`);
  console.log(`   解释: ${st.explanation}`);
});

hr('2. 独立数组排序核对（负数、重复值、降序输入）');
for (const input of [
  [3, -2, 3, 1],
  [5, 5, 5, 5],
  [4, 3, 2, 1],
  [0, -7, 2.5, -7]
]) {
  const got = executeNetwork(n4, input).output;
  const want = input.slice().sort((x, y) => x - y);
  console.log(`输入 ${JSON.stringify(input)} -> ${JSON.stringify(got)} 期望 ${JSON.stringify(want)} ${got.every((v, i) => v === want[i]) ? '✓' : '✗'}`);
}

hr('3. 手写四线路网络核对阶段语义（并行读旧值）');
const hand: NetworkDef = {
  wireCount: 4,
  stages: [
    { comparators: [{ a: 0, b: 1, dir: 'asc' }, { a: 2, b: 3, dir: 'asc' }], explanation: '手动阶段0：两对并行升序比较' },
    { comparators: [{ a: 0, b: 2, dir: 'asc' }, { a: 1, b: 3, dir: 'asc' }], explanation: '手动阶段1：跨度2' },
    { comparators: [{ a: 1, b: 2, dir: 'asc' }], explanation: '手动阶段2：中间线路' }
  ]
};
const handRun = executeNetwork(hand, [4, 3, 2, 1]);
handRun.stages.forEach((s) => {
  console.log(`阶段 ${s.stageIndex}: ${JSON.stringify(s.valuesBefore)} -> ${JSON.stringify(s.valuesAfter)}，交换=${JSON.stringify(s.swapped)}`);
});
console.log(`最终输出 ${JSON.stringify(handRun.output)}，逆序位置 ${JSON.stringify(handRun.inversionPositions)}`);

hr('4. 同阶段比较器存储顺序打乱，结果应一致');
const shuffled: NetworkDef = {
  wireCount: 4,
  stages: hand.stages.map((s) => ({ ...s, comparators: shuffle(s.comparators) }))
};
for (const input of [[4, 3, 2, 1], [1, 4, 2, 3], [2, 2, 1, 1]]) {
  const a = executeNetwork(hand, input).output;
  const b = executeNetwork(shuffled, input).output;
  console.log(`${JSON.stringify(input)}: 原序=${JSON.stringify(a)} 打乱=${JSON.stringify(b)} ${a.every((v, i) => v === b[i]) ? '✓ 一致' : '✗ 不一致'}`);
}

hr('5. 删除关键比较器后的零一反例');
const broken: NetworkDef = {
  wireCount: 4,
  stages: n4.stages.map((s, i) =>
    i === n4.stages.length - 1 ? { ...s, comparators: s.comparators.slice(0, -1) } : s
  )
};
const brokenStep = verifyStep(broken, {});
if (brokenStep.counterexample) {
  const ce = brokenStep.counterexample;
  console.log(`首个反例输入（固定二进制次序）: ${JSON.stringify(ce.input)}`);
  ce.stages.forEach((s) => console.log(`  阶段 ${s.stageIndex}: ${JSON.stringify(s.valuesBefore)} -> ${JSON.stringify(s.valuesAfter)}`));
  console.log(`错误输出: ${JSON.stringify(ce.output)}，相邻逆序位置: ${JSON.stringify(ce.inversionPositions)}`);
} else {
  console.log('未出现反例（异常！）');
}

hr('6. 生成八线路网络并完整零一验证');
const n8 = generateBitonic(8);
const total8 = totalCaseCount(8);
const step8 = verifyStep(n8, {});
console.log(`案例总数 = 2^8 = ${total8}，实际检查 = ${step8.checkedCases}，比较次数 = ${step8.comparisonsUsed}`);
console.log(`完成=${step8.completed}，反例=${step8.counterexample === null ? '无' : '有'}，状态=${step8.completed && step8.counterexample === null ? 'verified ✓' : '失败 ✗'}`);

hr('7. 预算暂停演示（四线路，每次预算 3 个案例）');
let start = 0;
let round = 0;
let checkedTotal = 0;
while (start < totalCaseCount(4)) {
  const step = verifyStep(n4, { startIndex: start, caseBudget: 3 });
  checkedTotal += step.checkedCases;
  round++;
  console.log(`第 ${round} 轮: 检查 ${step.checkedCases} 个，累计 ${checkedTotal}，下次起点 index=${step.nextStartIndex}，预算耗尽=${step.budgetExhausted}`);
  start = step.nextStartIndex;
  if (step.counterexample) break;
}
console.log(`分段穷举总案例数 ${checkedTotal}，应等于 ${totalCaseCount(4)}`);

hr('8. 一线路网络与空阶段');
const n1 = generateBitonic(1);
const r1 = executeNetwork(n1, [42]);
console.log(`一线路: 阶段数=${n1.stages.length}，输出=${JSON.stringify(r1.output)}，已升序=${r1.sortedAsc}`);

hr('9. SQLite 持久化：重启续算与版本隔离（使用 data/demo.sqlite）');
{
  const dbPath = 'data/demo.sqlite';
  rmSync(dbPath, { force: true });
  const { Store } = await import('./db.js');
  const { AppService } = await import('./service.js');

  let store = new Store(dbPath);
  let svc = new AppService(store);
  const created = svc.generate('demo-batcher-8', 8);
  const p1 = svc.advanceVerify(created.networkId, { caseBudget: 50 });
  console.log(`首次推进: 已检查 ${p1.checkedCases}/${p1.totalCases}，状态 ${p1.status}，下次起点 ${p1.nextStartIndex}`);
  store.close();

  store = new Store(dbPath);
  svc = new AppService(store);
  const p2 = svc.advanceVerify(created.networkId, {});
  console.log(`“重启”后续算: 累计检查 ${p2.checkedCases}/${p2.totalCases}（无重复、无遗漏），状态 ${p2.status}`);

  const brokenCreated = svc.importNetwork('demo-broken-4', broken);
  const brokenProgress = svc.advanceVerify(brokenCreated.networkId, {});
  console.log(`损坏网络版本独立核验: 状态 ${brokenProgress.status}（应为 counterexample）`);
  try {
    svc.addVersion(created.networkId, { wireCount: 4, stages: broken.stages });
    console.log('错误：本应抛出参数错误');
  } catch (e) {
    console.log(`跨线路数新版本被拒绝: ${(e as Error).message}`);
  }
  const stillVerified = svc.getProgress(created.networkId, 1);
  console.log(`八线路网络旧版本证明不受影响: 版本1 状态 ${stillVerified?.status}（版本隔离 ✓）`);
  store.close();
}

console.log('\n演示完成。');
