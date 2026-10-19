import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PcmConfig, loadConfig } from '../../src/config';
import { PcmService } from '../../src/services/pcm-service';
import { SqliteDatabase } from '../../src/storage/database';

export interface IsolatedTestEnv {
  tempRoot: string;
  config: PcmConfig;
  db: SqliteDatabase;
  service: PcmService;
  cleanup: () => void;
}

export function createIsolatedTestEnv(namespace = 'test_ns'): IsolatedTestEnv {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-test-'));
  const dataDir = path.join(tempRoot, 'data');
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const exportDir = path.join(tempRoot, 'exports');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  const config = loadConfig({
    dataDir,
    namespace,
    artifactRoot,
    exportDir,
    logLevel: 'silent',
  });

  const db = new SqliteDatabase(config.dbPath);
  db.runMigrations();
  const service = new PcmService(db, config);

  return {
    tempRoot,
    config,
    db,
    service,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // ignore
      }
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

export const SYNTHETIC_FIXTURES = {
  projectAlpha: {
    name: 'ZyroG2i Xlyo Runtime Core',
    description: 'Compact runtime stack and Task Maxer deployment verification project',
    objectives: [
      'Persist authoritative operational state across restarts',
      'Provide bounded context bundles to replacement workers',
    ],
    constraints: [
      'Local SQLite persistence only',
      'No remote network listeners in v1',
    ],
    status: 'active' as const,
  },
  projectUnrelated: {
    name: 'Unrelated Secondary Initiative',
    description: 'Separate project used to verify context bundle isolation',
    objectives: ['Stay excluded from Project Alpha worker context views'],
    constraints: ['Strict isolation'],
    status: 'active' as const,
  },
  taskPrimary: {
    title: 'Implement PCM SQLite Migration & Receipt Ledger',
    initial_request_summary: 'Build transactional migrations and atomic receipt recording',
    confirmed_specification: {
      storage_engine: 'SQLite3 with foreign_keys=ON',
      concurrency_control: 'Optimistic locking via expected_version',
      receipt_policy: 'Atomic commit with entity mutation',
    },
    constraints: ['Never fall back to in-memory database', 'Use parameterized queries'],
    assumptions: ['Local filesystem supports POSIX rename and locking'],
    acceptance_criteria: [
      {
        id: 'ac_fk',
        description: 'SQLite foreign keys enabled and verified',
        mandatory: true,
        met: false,
      },
      {
        id: 'ac_atomic',
        description: 'Mutations and receipts commit atomically',
        mandatory: true,
        met: false,
      },
    ],
    status: 'draft' as const,
    priority: 'high' as const,
    current_stage: 'specification_confirmed',
    assignments: [{ worker_id: 'zyro-worker-01', role: 'backend-implementer' }],
    dependency_refs: ['dep_schema_v1'],
    open_questions: [
      {
        id: 'oq_backup',
        question: 'Should snapshot export use SQLite online backup API?',
        resolved: false,
      },
    ],
    blockers: [
      {
        id: 'blk_audit',
        description: 'Awaiting security review of artifact path validation',
        resolved: false,
      },
    ],
    verification_status: 'not_started' as const,
  },
  decisionLayaSample: {
    state_version_observed: 1,
    objective: 'Select snapshot consistency mechanism for PCM export',
    options: [
      {
        option_id: 'opt_sqlite_backup_api',
        description: 'Use sqlite3_backup_init online backup API prior to JSON serialization',
        selection_probability: 0.82,
        suitability_score: 0.94,
        route_status: 'viable',
        evidence_refs: ['ev_sqlite_docs_backup'],
      },
      {
        option_id: 'opt_raw_file_cp',
        description: 'Copy raw SQLite file directly from filesystem without lock coordination',
        selection_probability: 0.18,
        suitability_score: 0.15,
        route_status: 'failed',
        evidence_refs: ['ev_corruption_risk'],
      },
    ],
    chosen_option: 'opt_sqlite_backup_api',
    selection_basis: 'Guarantees point-in-time transactional consistency without tearing pages',
    assessment_confidence: 0.91,
    evidence_refs: ['ev_sqlite_docs_backup'],
  },
};

export interface TestCaseResult {
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  error?: string;
}

export async function runTestCases(
  cases: Array<{ name: string; fn: () => Promise<void> | void }>
): Promise<TestCaseResult[]> {
  const results: TestCaseResult[] = [];
  for (const tc of cases) {
    const start = Date.now();
    try {
      await tc.fn();
      results.push({
        name: tc.name,
        status: 'passed',
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        name: tc.name,
        status: 'failed',
        durationMs: Date.now() - start,
        error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
      });
    }
  }
  return results;
}
