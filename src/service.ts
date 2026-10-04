// 业务服务：组合核心逻辑与存储，供 API 与 CLI 共用。
import {
  ApiError,
  Counterexample,
  MAX_SPEC_BYTES,
  NetworkSpec,
  generateBatcher,
  runNetwork,
  totalCases,
  validateNetwork,
  verifyStep,
} from './core';
import { Store, VerifyRow } from './db';

export class Service {
  constructor(public store: Store) {}

  generate(lines: number) {
    const spec = generateBatcher(lines);
    const networkId = this.store.createNetwork(spec.lines);
    const v = this.store.addVersion(networkId, spec);
    return { networkId, version: v.version, spec };
  }

  importNetwork(body: unknown, networkId?: number) {
    const json = JSON.stringify(body ?? {});
    if (Buffer.byteLength(json) > MAX_SPEC_BYTES) {
      throw new ApiError('LIMIT_EXCEEDED', `网络描述超过 ${MAX_SPEC_BYTES} 字节上限`);
    }
    const spec = validateNetwork(body as NetworkSpec);
    let id = networkId;
    if (id === undefined) {
      id = this.store.createNetwork(spec.lines);
    } else if (!this.store.networkExists(id)) {
      throw new ApiError('NOT_FOUND', `网络 ${id} 不存在`);
    }
    const v = this.store.addVersion(id, spec); // 修改比较器 => 新版本，旧证明不沿用
    return { networkId: id, version: v.version, spec };
  }

  private requireVersion(networkId: number, version?: number) {
    const v = this.store.getVersion(networkId, version);
    if (!v) throw new ApiError('NOT_FOUND', `网络 ${networkId} 版本 ${version ?? '最新'} 不存在`);
    return v;
  }

  exportNetwork(networkId: number, version?: number) {
    const v = this.requireVersion(networkId, version);
    return { networkId, version: v.version, spec: v.spec };
  }

  check(networkId: number, version?: number) {
    const v = this.requireVersion(networkId, version);
    validateNetwork(v.spec);
    const comparators = v.spec.stages.reduce((n, s) => n + s.comparators.length, 0);
    return {
      ok: true,
      networkId,
      version: v.version,
      lines: v.spec.lines,
      stages: v.spec.stages.length,
      comparators,
    };
  }

  execute(networkId: number, input: number[], version?: number) {
    const v = this.requireVersion(networkId, version);
    const result = runNetwork(v.spec, input);
    const runId = this.store.saveRun(v.versionId, input, result);
    return { runId, networkId, version: v.version, ...result };
  }

  verify(networkId: number, opts: { version?: number; maxCases?: number; maxCompares?: number }) {
    const v = this.requireVersion(networkId, opts.version);
    const maxCases = opts.maxCases ?? Number.MAX_SAFE_INTEGER;
    const maxCompares = opts.maxCompares ?? Number.MAX_SAFE_INTEGER;
    if (!(maxCases > 0) || !(maxCompares > 0)) {
      throw new ApiError('BAD_REQUEST', 'maxCases/maxCompares 必须为正数');
    }
    const progress = this.store.advanceVerify(v.versionId, (start) =>
      verifyStep(v.spec, start, maxCases, maxCompares)
    );
    return this.verifyView(networkId, v.version, progress);
  }

  verifyStatus(networkId: number, version?: number) {
    const v = this.requireVersion(networkId, version);
    const progress = this.store.getVerify(v.versionId);
    if (!progress) throw new ApiError('NOT_FOUND', '核验进度不存在');
    return this.verifyView(networkId, v.version, progress);
  }

  private verifyView(networkId: number, version: number, p: VerifyRow) {
    const v = this.requireVersion(networkId, version);
    const total = totalCases(v.spec.lines);
    return {
      networkId,
      version,
      status: p.status, // verifying=未完成(预算暂停) | verified=已验证 | failed=存在反例
      checked: p.checked,
      compares: p.compares,
      nextIndex: p.nextIndex,
      totalCases: total,
      verified: p.status === 'verified' && p.checked === total,
    };
  }

  counterexample(networkId: number, version?: number): Counterexample {
    const v = this.requireVersion(networkId, version);
    const p = this.store.getVerify(v.versionId);
    if (!p || !p.counterexample) {
      throw new ApiError('NOT_FOUND', '该版本没有记录反例');
    }
    return JSON.parse(p.counterexample) as Counterexample;
  }

  versions(networkId: number) {
    if (!this.store.networkExists(networkId)) {
      throw new ApiError('NOT_FOUND', `网络 ${networkId} 不存在`);
    }
    return this.store.listVersions(networkId).map((v) => ({
      ...v,
      verify: this.store.getVerify(v.versionId)?.status ?? 'verifying',
    }));
  }
}
