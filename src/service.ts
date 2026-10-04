import { Store } from './db.js';
import { AppError, ErrorCode } from './errors.js';
import { executeNetwork } from './execute.js';
import { generateBitonic } from './generate.js';
import { checkStructure } from './validate.js';
import { totalCaseCount, verifyStep } from './verify.js';
import type { ExecutionResult, NetworkDef, StructureCheckResult, VerifyProgress } from './types.js';

export interface AdvanceOptions {
  caseBudget?: number | null;
  comparisonBudget?: number | null;
  /** 强制重新开始核验（忽略既有 in_progress/incomplete 进度） */
  restart?: boolean;
}

export class AppService {
  constructor(private readonly store: Store) {}

  generate(name: string, wireCount: number): { networkId: number; version: number; def: NetworkDef } {
    const def = generateBitonic(wireCount);
    const created = this.store.createNetwork(name || `batcher-${wireCount}`, 'batcher', def);
    return { networkId: created.networkId, version: created.version, def };
  }

  importNetwork(name: string, def: NetworkDef): { networkId: number; version: number } {
    const created = this.store.createNetwork(name, 'custom', def);
    return { networkId: created.networkId, version: created.version };
  }

  listNetworks() {
    return this.store.listNetworks();
  }

  listVersions(networkId: number) {
    return this.store.listVersions(networkId);
  }

  getDef(networkId: number, version?: number): { version: number; def: NetworkDef } {
    const row = this.store.getVersion(networkId, version);
    return { version: row.version, def: JSON.parse(row.def_json) as NetworkDef };
  }

  addVersion(networkId: number, def: NetworkDef): { version: number } {
    return this.store.addVersion(networkId, def);
  }

  check(networkId: number, version?: number): StructureCheckResult {
    const { def } = this.getDef(networkId, version);
    return checkStructure(def);
  }

  /** 结构检查任意候选定义（不必先入库） */
  checkCandidate(def: NetworkDef): StructureCheckResult {
    return checkStructure(def);
  }

  execute(networkId: number, input: number[], version?: number): { runId: number; result: ExecutionResult } {
    const verRow = this.store.getVersion(networkId, version);
    const def = JSON.parse(verRow.def_json) as NetworkDef;
    const result = executeNetwork(def, input);
    const runId = this.store.recordRun(verRow.id, result.input, result);
    return { runId, result };
  }

  getRun(runId: number) {
    return this.store.getRun(runId);
  }

  getProgress(networkId: number, version?: number): VerifyProgress | null {
    const verRow = this.store.getVersion(networkId, version);
    return this.store.getProgress(networkId, verRow.id, verRow.version);
  }

  getCounterexample(networkId: number, version?: number) {
    const progress = this.getProgress(networkId, version);
    return progress?.counterexample ?? null;
  }

  exportNetwork(networkId: number, version?: number) {
    const { version: v, def } = this.getDef(networkId, version);
    return {
      networkId,
      version: v,
      wireCount: def.wireCount,
      stages: def.stages
    };
  }

  /** 推进零一核验；从 SQLite 中的下一未检查输入继续，杜绝漏检与重复计数 */
  advanceVerify(networkId: number, options: AdvanceOptions = {}, version?: number): VerifyProgress {
    const verRow = this.store.getVersion(networkId, version);
    const def = JSON.parse(verRow.def_json) as NetworkDef;
    const total = totalCaseCount(def.wireCount);

    const caseBudget = normalizeBudget(options.caseBudget);
    const comparisonBudget = normalizeBudget(options.comparisonBudget);

    let progress: VerifyProgress;
    if (options.restart) {
      progress = this.store.initProgress(0, networkId, verRow.id, verRow.version, total, comparisonBudget, caseBudget);
      this.store.saveProgress({
        versionId: verRow.id,
        runId: 0,
        networkId,
        version: verRow.version,
        checkedCasesDelta: 0,
        comparisonsDelta: 0,
        nextStartIndex: 0,
        status: 'in_progress',
        counterexample: null,
        comparisonBudget,
        caseBudget
      });
    } else {
      progress = this.store.initProgress(0, networkId, verRow.id, verRow.version, total, comparisonBudget, caseBudget);
    }

    if (progress.status === 'verified' || progress.status === 'counterexample') {
      return progress;
    }

    const step = verifyStep(def, {
      startIndex: progress.nextStartIndex,
      caseBudget,
      comparisonBudget:
        comparisonBudget === null
          ? null
          : Math.max(0, comparisonBudget - progress.comparisonsUsed)
    });

    let status: VerifyProgress['status'];
    if (step.counterexample) {
      status = 'counterexample';
    } else if (step.completed) {
      status = 'verified';
    } else {
      status = 'incomplete';
    }

    return this.store.saveProgress({
      versionId: verRow.id,
      runId: progress.runId,
      networkId,
      version: verRow.version,
      checkedCasesDelta: step.checkedCases,
      comparisonsDelta: step.comparisonsUsed,
      nextStartIndex: step.counterexample
        ? step.nextStartIndex
        : step.nextStartIndex,
      status,
      counterexample: step.counterexample,
      comparisonBudget,
      caseBudget
    });
  }

  close(): void {
    this.store.close();
  }
}

function normalizeBudget(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AppError(ErrorCode.INVALID_PARAM, '预算必须为正整数');
  }
  return value;
}
