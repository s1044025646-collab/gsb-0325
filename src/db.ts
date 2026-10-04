// SQLite 持久层：网络、版本、运行记录、零一核验进度。
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NetworkSpec } from './core';

export interface VersionRow {
  versionId: number;
  networkId: number;
  version: number;
  lines: number;
  spec: NetworkSpec;
  createdAt: string;
}

export interface VerifyRow {
  versionId: number;
  status: 'verifying' | 'verified' | 'failed';
  nextIndex: number;
  checked: number;
  compares: number;
  counterexample: string | null;
  updatedAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS networks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lines INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network_id INTEGER NOT NULL REFERENCES networks(id),
        version INTEGER NOT NULL,
        lines INTEGER NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(network_id, version)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id),
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS verify_progress (
        version_id INTEGER PRIMARY KEY REFERENCES versions(id),
        status TEXT NOT NULL,
        next_index INTEGER NOT NULL,
        checked INTEGER NOT NULL,
        compares INTEGER NOT NULL,
        counterexample_json TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createNetwork(lines: number): number {
    const r = this.db.prepare('INSERT INTO networks(lines) VALUES (?)').run(lines);
    return Number(r.lastInsertRowid);
  }

  networkExists(networkId: number): boolean {
    return !!this.db.prepare('SELECT id FROM networks WHERE id = ?').get(networkId);
  }

  addVersion(networkId: number, spec: NetworkSpec): VersionRow {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE network_id = ?')
      .get(networkId) as { v: number };
    const version = row.v + 1;
    const r = this.db
      .prepare('INSERT INTO versions(network_id, version, lines, spec_json) VALUES (?,?,?,?)')
      .run(networkId, version, spec.lines, JSON.stringify(spec));
    const versionId = Number(r.lastInsertRowid);
    this.db
      .prepare(
        `INSERT INTO verify_progress(version_id, status, next_index, checked, compares)
         VALUES (?, 'verifying', 0, 0, 0)`
      )
      .run(versionId);
    return this.getVersion(networkId, version)!;
  }

  getVersion(networkId: number, version?: number): VersionRow | null {
    const row = (
      version === undefined
        ? this.db
            .prepare('SELECT * FROM versions WHERE network_id = ? ORDER BY version DESC LIMIT 1')
            .get(networkId)
        : this.db.prepare('SELECT * FROM versions WHERE network_id = ? AND version = ?').get(networkId, version)
    ) as any;
    if (!row) return null;
    return {
      versionId: row.id,
      networkId: row.network_id,
      version: row.version,
      lines: row.lines,
      spec: JSON.parse(row.spec_json) as NetworkSpec,
      createdAt: row.created_at,
    };
  }

  listVersions(networkId: number): Omit<VersionRow, 'spec'>[] {
    const rows = this.db
      .prepare('SELECT * FROM versions WHERE network_id = ? ORDER BY version')
      .all(networkId) as any[];
    return rows.map((row) => ({
      versionId: row.id,
      networkId: row.network_id,
      version: row.version,
      lines: row.lines,
      createdAt: row.created_at,
    }));
  }

  saveRun(versionId: number, input: number[], result: unknown): number {
    const r = this.db
      .prepare('INSERT INTO runs(version_id, input_json, result_json) VALUES (?,?,?)')
      .run(versionId, JSON.stringify(input), JSON.stringify(result));
    return Number(r.lastInsertRowid);
  }

  getVerify(versionId: number): VerifyRow | null {
    const row = this.db.prepare('SELECT * FROM verify_progress WHERE version_id = ?').get(versionId) as any;
    if (!row) return null;
    return {
      versionId: row.version_id,
      status: row.status,
      nextIndex: row.next_index,
      checked: row.checked,
      compares: row.compares,
      counterexample: row.counterexample_json,
      updatedAt: row.updated_at,
    };
  }

  // 事务内推进核验进度：重启后从 next_index 继续，不漏案例、不重复计数。
  advanceVerify(
    versionId: number,
    step: (startIndex: number) => {
      checkedNow: number;
      comparesNow: number;
      nextIndex: number;
      done: boolean;
      counterexample?: unknown;
    }
  ): VerifyRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cur = this.getVerify(versionId);
      if (!cur) throw new Error('verify row missing');
      if (cur.status !== 'verifying') {
        this.db.exec('COMMIT');
        return cur; // 已终结（verified/failed），不重复推进
      }
      const r = step(cur.nextIndex);
      const status = r.counterexample ? 'failed' : r.done ? 'verified' : 'verifying';
      this.db
        .prepare(
          `UPDATE verify_progress
           SET status = ?, next_index = ?, checked = checked + ?, compares = compares + ?,
               counterexample_json = COALESCE(?, counterexample_json), updated_at = datetime('now')
           WHERE version_id = ?`
        )
        .run(
          status,
          r.nextIndex,
          r.checkedNow,
          r.comparesNow,
          r.counterexample ? JSON.stringify(r.counterexample) : null,
          versionId
        );
      this.db.exec('COMMIT');
      return this.getVerify(versionId)!;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
