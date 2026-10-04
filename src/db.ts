import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppError, ErrorCode, LIMITS } from './errors.js';
import { checkStructure } from './validate.js';
import type { ExecutionResult, NetworkDef, VerifyProgress, VerifyStatus } from './types.js';

interface ProgressRow {
  run_id: number;
  network_id: number;
  version_id: number;
  version: number;
  status: VerifyStatus;
  total_cases: number;
  checked_cases: number;
  comparisons_used: number;
  comparison_budget: number | null;
  case_budget: number | null;
  next_start_index: number;
  counterexample_json: string | null;
  updated_at: string;
}

interface NetRow {
  id: number;
  name: string;
  source: 'batcher' | 'custom';
  wire_count: number;
  created_at: string;
}

interface VerRow {
  id: number;
  network_id: number;
  version: number;
  def_json: string;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const abs = resolve(dbPath);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new DatabaseSync(abs);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS networks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('batcher','custom')),
        wire_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS network_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        def_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (network_id, version)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES network_versions(id) ON DELETE CASCADE,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS verify_progress (
        version_id INTEGER PRIMARY KEY REFERENCES network_versions(id) ON DELETE CASCADE,
        run_id INTEGER NOT NULL,
        network_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        total_cases INTEGER NOT NULL,
        checked_cases INTEGER NOT NULL,
        comparisons_used INTEGER NOT NULL,
        comparison_budget INTEGER,
        case_budget INTEGER,
        next_start_index INTEGER NOT NULL,
        counterexample_json TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  createNetwork(name: string, source: 'batcher' | 'custom', def: NetworkDef): { networkId: number; versionId: number; version: number } {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError(ErrorCode.INVALID_PARAM, '网络名称不能为空');
    }
    if (name.length > LIMITS.MAX_NAME_CHARS) {
      throw new AppError(ErrorCode.INVALID_PARAM, `名称不能超过 ${LIMITS.MAX_NAME_CHARS} 字符`);
    }
    const checkResult = checkStructure(def);
    if (!checkResult.valid) {
      throw new AppError(checkResult.issues[0]!.code as never, checkResult.issues[0]!.message, checkResult.issues);
    }
    const info = this.db
      .prepare('INSERT INTO networks (name, source, wire_count) VALUES (?,?,?)')
      .run(name, source, def.wireCount);
    const networkId = Number(info.lastInsertRowid);
    const versionId = this.insertVersion(networkId, 1, def);
    return { networkId, versionId, version: 1 };
  }

  private insertVersion(networkId: number, version: number, def: NetworkDef): number {
    const info = this.db
      .prepare('INSERT INTO network_versions (network_id, version, def_json) VALUES (?,?,?)')
      .run(networkId, version, JSON.stringify(def));
    return Number(info.lastInsertRowid);
  }

  addVersion(networkId: number, def: NetworkDef): { versionId: number; version: number } {
    const net = this.getNetworkRow(networkId);
    if (def.wireCount !== net.wire_count) {
      throw new AppError(ErrorCode.INVALID_PARAM, `线路数不可变：该网络固定为 ${net.wire_count}`);
    }
    const checkResult = checkStructure(def);
    if (!checkResult.valid) {
      throw new AppError(checkResult.issues[0]!.code as never, checkResult.issues[0]!.message, checkResult.issues);
    }
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM network_versions WHERE network_id = ?')
      .get(networkId) as { v: number | null };
    const version = (row.v ?? 0) + 1;
    const versionId = this.insertVersion(networkId, version, def);
    return { versionId, version };
  }

  private getNetworkRow(networkId: number): NetRow {
    const row = this.db.prepare('SELECT * FROM networks WHERE id = ?').get(networkId) as NetRow | undefined;
    if (!row) throw new AppError(ErrorCode.NETWORK_NOT_FOUND, `网络 id=${networkId} 不存在`);
    return row;
  }

  listNetworks(): Array<NetRow & { latestVersion: number }> {
    return this.db
      .prepare(
        `SELECT n.*, (SELECT MAX(version) FROM network_versions v WHERE v.network_id = n.id) AS latestVersion
         FROM networks n ORDER BY n.id`
      )
      .all() as Array<NetRow & { latestVersion: number }>;
  }

  getVersion(networkId: number, version?: number): VerRow {
    this.getNetworkRow(networkId);
    let row: VerRow | undefined;
    if (version === undefined) {
      row = this.db
        .prepare('SELECT * FROM network_versions WHERE network_id = ? ORDER BY version DESC LIMIT 1')
        .get(networkId) as VerRow | undefined;
    } else {
      row = this.db
        .prepare('SELECT * FROM network_versions WHERE network_id = ? AND version = ?')
        .get(networkId, version) as VerRow | undefined;
    }
    if (!row) throw new AppError(ErrorCode.VERSION_NOT_FOUND, `网络 ${networkId} 的版本 ${version ?? 'latest'} 不存在`);
    return row;
  }

  getDef(networkId: number, version?: number): NetworkDef {
    return JSON.parse(this.getVersion(networkId, version).def_json) as NetworkDef;
  }

  listVersions(networkId: number): Array<{ versionId: number; version: number; createdAt: string }> {
    this.getNetworkRow(networkId);
    return this.db
      .prepare('SELECT id AS versionId, version, created_at AS createdAt FROM network_versions WHERE network_id = ? ORDER BY version')
      .all(networkId) as Array<{ versionId: number; version: number; createdAt: string }>;
  }

  recordRun(versionId: number, input: number[], result: ExecutionResult): number {
    const info = this.db
      .prepare('INSERT INTO runs (version_id, input_json, result_json) VALUES (?,?,?)')
      .run(versionId, JSON.stringify(input), JSON.stringify(result));
    return Number(info.lastInsertRowid);
  }

  getRun(runId: number): { runId: number; networkId: number; version: number; input: number[]; result: ExecutionResult; createdAt: string } {
    const row = this.db
      .prepare(
        `SELECT r.id AS runId, r.input_json AS inputJson, r.result_json AS resultJson, r.created_at AS createdAt,
                v.network_id AS networkId, v.version AS version
         FROM runs r JOIN network_versions v ON v.id = r.version_id WHERE r.id = ?`
      )
      .get(runId) as
      | { runId: number; inputJson: string; resultJson: string; createdAt: string; networkId: number; version: number }
      | undefined;
    if (!row) throw new AppError(ErrorCode.RUN_NOT_FOUND, `运行记录 id=${runId} 不存在`);
    return {
      runId: row.runId,
      networkId: row.networkId,
      version: row.version,
      input: JSON.parse(row.inputJson) as number[],
      result: JSON.parse(row.resultJson) as ExecutionResult,
      createdAt: row.createdAt
    };
  }

  getProgress(networkId: number, versionId: number, version: number): VerifyProgress | null {
    const row = this.db.prepare('SELECT * FROM verify_progress WHERE version_id = ?').get(versionId) as ProgressRow | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      networkId: row.network_id,
      version: row.version,
      status: row.status,
      totalCases: row.total_cases,
      checkedCases: row.checked_cases,
      comparisonsUsed: row.comparisons_used,
      comparisonBudget: row.comparison_budget,
      caseBudget: row.case_budget,
      nextStartIndex: row.next_start_index,
      counterexample: row.counterexample_json ? (JSON.parse(row.counterexample_json) as VerifyProgress['counterexample']) : null,
      updatedAt: row.updated_at
    };
  }

  initProgress(
    runId: number,
    networkId: number,
    versionId: number,
    version: number,
    totalCases: number,
    comparisonBudget: number | null,
    caseBudget: number | null
  ): VerifyProgress {
    const existing = this.getProgress(networkId, versionId, version);
    if (existing && (existing.status === 'in_progress' || existing.status === 'incomplete')) {
      return existing;
    }
    this.db
      .prepare(
        `INSERT INTO verify_progress
           (version_id, run_id, network_id, version, status, total_cases, checked_cases,
            comparisons_used, comparison_budget, case_budget, next_start_index, counterexample_json)
         VALUES (?,?,?,?,?,?,0,0,?,?,0,NULL)
         ON CONFLICT(version_id) DO UPDATE SET
           run_id=excluded.run_id, status='in_progress', checked_cases=0, comparisons_used=0,
           next_start_index=0, counterexample_json=NULL, updated_at=datetime('now')`
      )
      .run(versionId, runId, networkId, version, 'in_progress', totalCases, comparisonBudget, caseBudget);
    return this.getProgress(networkId, versionId, version)!;
  }

  saveProgress(p: {
    versionId: number;
    runId: number;
    networkId: number;
    version: number;
    checkedCasesDelta: number;
    comparisonsDelta: number;
    nextStartIndex: number;
    status: VerifyStatus;
    counterexample: unknown;
    comparisonBudget: number | null;
    caseBudget: number | null;
  }): VerifyProgress {
    this.db
      .prepare(
        `UPDATE verify_progress SET
           run_id=?, status=?, checked_cases=checked_cases+?, comparisons_used=comparisons_used+?,
           next_start_index=?, counterexample_json=?, comparison_budget=?, case_budget=?,
           updated_at=datetime('now')
         WHERE version_id=?`
      )
      .run(
        p.runId,
        p.status,
        p.checkedCasesDelta,
        p.comparisonsDelta,
        p.nextStartIndex,
        p.counterexample === null ? null : JSON.stringify(p.counterexample),
        p.comparisonBudget,
        p.caseBudget,
        p.versionId
      );
    return this.getProgress(p.networkId, p.versionId, p.version)!;
  }
}
