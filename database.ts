import * as fs from 'fs';
import * as path from 'path';
import { PcmError, normalizeError } from '../domain/errors';
import { MIGRATIONS, computeMigrationChecksum } from './migrations';

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

interface NativeSqliteBinding {
  open(filename: string): unknown;
  close(handle: unknown): void;
  exec(handle: unknown, sql: string): void;
  run(handle: unknown, sql: string, params?: unknown[]): RunResult;
  query(handle: unknown, sql: string, params?: unknown[]): Record<string, unknown>[];
  backup(handle: unknown, destPath: string): boolean;
  version(): string;
}

let cachedBinding: NativeSqliteBinding | null = null;

function loadNativeSqliteBinding(): NativeSqliteBinding {
  if (cachedBinding) {
    return cachedBinding;
  }

  const candidatePaths = [
    path.resolve(__dirname, '../../build/sqlite_napi.node'),
    path.resolve(process.cwd(), 'build/sqlite_napi.node'),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cachedBinding = require(candidate) as NativeSqliteBinding;
      return cachedBinding;
    }
  }

  throw new PcmError(
    'STORAGE_UNAVAILABLE',
    'Native SQLite N-API binding (build/sqlite_napi.node) is not built or missing. Run `npm run build` first.'
  );
}

export class SqliteDatabase {
  public readonly dbPath: string;
  private readonly binding: NativeSqliteBinding;
  private handle: unknown | null = null;
  private inTransaction = false;

  constructor(dbPath: string) {
    if (!dbPath || dbPath.trim() === '' || dbPath.trim() === ':memory:') {
      throw new PcmError(
        'STORAGE_UNAVAILABLE',
        'Persistent SQLite file path is required; in-memory storage is forbidden.'
      );
    }
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.binding = loadNativeSqliteBinding();
    try {
      this.handle = this.binding.open(this.dbPath);
      this.exec('PRAGMA foreign_keys = ON;');
      this.exec('PRAGMA journal_mode = WAL;');
      this.exec('PRAGMA synchronous = NORMAL;');
      const fkRow = this.get<{ foreign_keys: number }>('PRAGMA foreign_keys;');
      if (!fkRow || fkRow.foreign_keys !== 1) {
        throw new PcmError('STORAGE_UNAVAILABLE', 'Failed to enable SQLite PRAGMA foreign_keys');
      }
    } catch (err) {
      if (err instanceof PcmError) {
        throw err;
      }
      throw new PcmError(
        'STORAGE_UNAVAILABLE',
        `Failed to initialize SQLite database at "${this.dbPath}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private ensureOpen(): unknown {
    if (!this.handle) {
      throw new PcmError('STORAGE_UNAVAILABLE', 'SQLite database connection is closed');
    }
    return this.handle;
  }

  public sqliteVersion(): string {
    return this.binding.version();
  }

  public isOpen(): boolean {
    return this.handle !== null;
  }

  public foreignKeysEnabled(): boolean {
    const row = this.get<{ foreign_keys: number }>('PRAGMA foreign_keys;');
    return Boolean(row && row.foreign_keys === 1);
  }

  public exec(sql: string): void {
    const h = this.ensureOpen();
    try {
      this.binding.exec(h, sql);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  public run(sql: string, params: unknown[] = []): RunResult {
    const h = this.ensureOpen();
    try {
      return this.binding.run(h, sql, params);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  public all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const h = this.ensureOpen();
    try {
      return this.binding.query(h, sql, params) as T[];
    } catch (err) {
      throw normalizeError(err);
    }
  }

  public get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    const rows = this.all<T>(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  public transaction<T>(fn: () => T): T {
    this.ensureOpen();
    if (this.inTransaction) {
      // Nested call inside active transaction
      return fn();
    }
    this.exec('BEGIN IMMEDIATE TRANSACTION;');
    this.inTransaction = true;
    try {
      const result = fn();
      this.exec('COMMIT;');
      this.inTransaction = false;
      return result;
    } catch (err) {
      try {
        this.exec('ROLLBACK;');
      } catch {
        // Ignore rollback secondary error
      }
      this.inTransaction = false;
      throw normalizeError(err);
    }
  }

  public backupToFile(destPath: string): void {
    const h = this.ensureOpen();
    const resolvedDest = path.resolve(destPath);
    fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
    if (fs.existsSync(resolvedDest)) {
      fs.unlinkSync(resolvedDest);
    }
    try {
      this.binding.backup(h, resolvedDest);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  public runMigrations(): {
    appliedVersions: number[];
    currentVersion: number;
    migrationsCount: number;
  } {
    this.ensureOpen();
    try {
      this.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);

      const existingRows = this.all<{ version: number; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC'
      );
      const existingMap = new Map<number, { name: string; checksum: string }>();
      for (const row of existingRows) {
        existingMap.set(row.version, { name: row.name, checksum: row.checksum });
      }

      const appliedVersions: number[] = [];

      for (const migration of MIGRATIONS) {
        const checksum = computeMigrationChecksum(migration.sql);
        const existing = existingMap.get(migration.version);
        if (existing) {
          if (existing.checksum !== checksum) {
            throw new PcmError(
              'MIGRATION_FAILED',
              `Migration v${migration.version} (${migration.name}) checksum mismatch`,
              {
                version: migration.version,
                expected_checksum: existing.checksum,
                actual_checksum: checksum,
              }
            );
          }
          continue;
        }

        this.transaction(() => {
          this.exec(migration.sql);
          this.run(
            'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
            [migration.version, migration.name, checksum, new Date().toISOString()]
          );
        });
        appliedVersions.push(migration.version);
      }

      const currentRows = this.all<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
      );
      const currentVersion = currentRows.length > 0 ? currentRows[0].version : 0;
      const totalCountRow = this.get<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM schema_migrations'
      );

      return {
        appliedVersions,
        currentVersion,
        migrationsCount: totalCountRow ? totalCountRow.cnt : 0,
      };
    } catch (err) {
      if (err instanceof PcmError && err.code === 'MIGRATION_FAILED') {
        throw err;
      }
      throw new PcmError(
        'MIGRATION_FAILED',
        `Schema migration failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public getSchemaStatus(): {
    current_version: number;
    expected_version: number;
    is_up_to_date: boolean;
    foreign_keys_enabled: boolean;
    sqlite_version: string;
    applied_migrations: Array<{ version: number; name: string; applied_at: string }>;
  } {
    const applied = this.all<{ version: number; name: string; applied_at: string }>(
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC'
    );
    const expectedVersion =
      MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
    const currentVersion = applied.length > 0 ? applied[applied.length - 1].version : 0;

    return {
      current_version: currentVersion,
      expected_version: expectedVersion,
      is_up_to_date: currentVersion === expectedVersion,
      foreign_keys_enabled: this.foreignKeysEnabled(),
      sqlite_version: this.sqliteVersion(),
      applied_migrations: applied,
    };
  }

  public close(): void {
    if (this.handle) {
      this.binding.close(this.handle);
      this.handle = null;
      this.inTransaction = false;
    }
  }
}
