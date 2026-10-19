import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { PcmError } from '../../src/domain/errors';
import { SqliteDatabase } from '../../src/storage/database';
import {
  SYNTHETIC_FIXTURES,
  TestCaseResult,
  createIsolatedTestEnv,
  runTestCases,
} from '../fixtures/synthetic-fixtures';

function expectPcmError(fn: () => unknown, expectedCode: string): PcmError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PcmError, `Expected PcmError, got: ${String(err)}`);
    assert.strictEqual(
      err.code,
      expectedCode,
      `Expected error code ${expectedCode}, got ${err.code} (${err.message})`
    );
    return err;
  }
  assert.fail(`Expected function to throw PcmError(${expectedCode}), but it succeeded`);
}

export async function runSuite(): Promise<TestCaseResult[]> {
  return runTestCases([
    {
      name: 'SQLite storage rejects in-memory database and enforces foreign keys & migrations',
      fn: () => {
        expectPcmError(() => new SqliteDatabase(':memory:'), 'STORAGE_UNAVAILABLE');

        const env = createIsolatedTestEnv('unit_storage');
        try {
          assert.strictEqual(env.db.foreignKeysEnabled(), true);
          const status = env.db.getSchemaStatus();
          assert.strictEqual(status.is_up_to_date, true);
          assert.strictEqual(status.foreign_keys_enabled, true);
          assert.ok(status.current_version >= 1);

          // Test foreign key enforcement directly: inserting task with nonexistent project_id fails with INTEGRITY_ERROR
          expectPcmError(
            () =>
              env.db.run(
                `INSERT INTO tasks (
                  id, namespace_id, project_id, title, confirmed_specification_json,
                  status, priority, verification_status, version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'draft', 'medium', 'not_started', 1, ?, ?)`,
                [
                  'task_bad_fk',
                  'unit_storage',
                  'nonexistent_proj',
                  'Bad FK Task',
                  '{}',
                  new Date().toISOString(),
                  new Date().toISOString(),
                ]
              ),
            'INTEGRITY_ERROR'
          );
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Profile get/update enforces expected_version optimistic concurrency',
      fn: () => {
        const env = createIsolatedTestEnv('unit_profile');
        try {
          const initial = env.service.profileGet();
          assert.strictEqual(initial.version, 1);
          assert.strictEqual(initial.namespace_id, 'unit_profile');

          // Update with current version (1) succeeds -> version becomes 2
          const upd1 = env.service.profileUpdate({
            expected_version: 1,
            tone: 'technical',
            verification_effort: 'exhaustive',
            actor_attribution: 'zyru-spec-agent',
          });
          assert.strictEqual(upd1.entity.version, 2);
          assert.strictEqual(upd1.entity.tone, 'technical');
          assert.strictEqual(upd1.entity.verification_effort, 'exhaustive');
          assert.ok(upd1.receipt.id.startsWith('rcpt_'));

          // Stale version update (expected_version: 1) fails with VERSION_CONFLICT without overwriting
          expectPcmError(
            () =>
              env.service.profileUpdate({
                expected_version: 1,
                tone: 'concise',
              }),
            'VERSION_CONFLICT'
          );

          const afterConflict = env.service.profileGet();
          assert.strictEqual(afterConflict.version, 2);
          assert.strictEqual(afterConflict.tone, 'technical');
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Task Maxer lifecycle validates transitions, completion criteria, and protects blockers/questions/dependencies',
      fn: () => {
        const env = createIsolatedTestEnv('unit_task_maxer');
        try {
          const proj = env.service.projectCreate(SYNTHETIC_FIXTURES.projectAlpha).entity;
          const created = env.service.taskCreate({
            ...SYNTHETIC_FIXTURES.taskPrimary,
            project_id: proj.id,
          }).entity;

          assert.strictEqual(created.version, 1);
          assert.strictEqual(created.status, 'draft');
          assert.strictEqual(created.blockers.length, 1);
          assert.strictEqual(created.open_questions.length, 1);

          // 1. Invalid transition draft -> completed is rejected
          expectPcmError(
            () =>
              env.service.taskUpdate({
                id: created.id,
                expected_version: 1,
                status: 'completed',
              }),
            'INVALID_STATE_TRANSITION'
          );

          // 2. Transition draft -> active succeeds
          const activeTask = env.service.taskUpdate({
            id: created.id,
            expected_version: 1,
            status: 'active',
          }).entity;
          assert.strictEqual(activeTask.version, 2);
          assert.strictEqual(activeTask.status, 'active');

          // 3. Silently discarding unresolved blocker is rejected
          expectPcmError(
            () =>
              env.service.taskUpdate({
                id: created.id,
                expected_version: 2,
                blockers: [],
              }),
            'INVALID_INPUT'
          );

          // 4. Silently discarding unresolved open question is rejected
          expectPcmError(
            () =>
              env.service.taskUpdate({
                id: created.id,
                expected_version: 2,
                open_questions: [],
              }),
            'INVALID_INPUT'
          );

          // 5. Silently discarding dependency_refs without allow_dependency_removal=true is rejected
          expectPcmError(
            () =>
              env.service.taskUpdate({
                id: created.id,
                expected_version: 2,
                dependency_refs: [],
              }),
            'INVALID_INPUT'
          );

          // 6. Attempting to mark completed while verification_status='not_started' or mandatory criteria unmet fails
          expectPcmError(
            () =>
              env.service.taskUpdate({
                id: created.id,
                expected_version: 2,
                status: 'completed',
                verification_status: 'passed',
                // mandatory acceptance_criteria still have met: false
              }),
            'INVALID_STATE_TRANSITION'
          );

          // 7. Resolve blocker & open question, satisfy mandatory acceptance criteria, set verification_status='passed', and mark completed
          const completedTask = env.service.taskUpdate({
            id: created.id,
            expected_version: 2,
            status: 'completed',
            verification_status: 'passed',
            acceptance_criteria: [
              {
                id: 'ac_fk',
                description: 'SQLite foreign keys enabled and verified',
                mandatory: true,
                met: true,
                evidence_ref: 'rcpt_fk_test',
              },
              {
                id: 'ac_atomic',
                description: 'Mutations and receipts commit atomically',
                mandatory: true,
                met: true,
                evidence_ref: 'rcpt_tx_test',
              },
            ],
            blockers: [
              {
                id: 'blk_audit',
                description: 'Awaiting security review of artifact path validation',
                resolved: true,
                resolution: 'Security suite passed path traversal and symlink checks',
              },
            ],
            open_questions: [
              {
                id: 'oq_backup',
                question: 'Should snapshot export use SQLite online backup API?',
                resolved: true,
                resolution: 'Confirmed sqlite3_backup_init online backup API',
              },
            ],
          }).entity;

          assert.strictEqual(completedTask.status, 'completed');
          assert.strictEqual(completedTask.verification_status, 'passed');
          assert.strictEqual(completedTask.version, 3);
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Forced transaction failure rolls back both entity mutation and operational receipt',
      fn: () => {
        const env = createIsolatedTestEnv('unit_atomic_tx');
        try {
          const initialProjects = env.service.projectList().total_count;
          const initialReceipts = env.service.receiptSearch().total_count;

          // Force failure after entity insert
          expectPcmError(
            () =>
              env.service.projectCreate({
                name: 'Should Rollback Project 1',
                _test_force_fail_after_mutation: true,
              }),
            'INTERNAL_ERROR'
          );

          // Force failure after receipt insert
          expectPcmError(
            () =>
              env.service.projectCreate({
                name: 'Should Rollback Project 2',
                _test_force_fail_after_receipt: true,
              }),
            'INTERNAL_ERROR'
          );

          const afterProjects = env.service.projectList().total_count;
          const afterReceipts = env.service.receiptSearch().total_count;
          assert.strictEqual(afterProjects, initialProjects, 'No partial project row may remain');
          assert.strictEqual(afterReceipts, initialReceipts, 'No partial receipt row may remain');
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Idempotency key replays identical payload without duplication and rejects changed payload',
      fn: () => {
        const env = createIsolatedTestEnv('unit_idempotency');
        try {
          const payload = {
            name: 'Idempotent Project',
            description: 'Testing idempotency ledger',
            idempotency_key: 'idem_proj_001',
          };

          const first = env.service.projectCreate(payload);
          assert.strictEqual(first.idempotent_replay, false);

          const second = env.service.projectCreate(payload);
          assert.strictEqual(second.idempotent_replay, true);
          assert.strictEqual(second.entity.id, first.entity.id);
          assert.strictEqual(second.receipt.id, first.receipt.id);

          // Verify only 1 project and 1 receipt exist in DB
          assert.strictEqual(env.service.projectList().total_count, 1);
          assert.strictEqual(env.service.receiptSearch().total_count, 1);

          // Changed payload under same idempotency_key fails with DUPLICATE_IDEMPOTENCY_KEY
          expectPcmError(
            () =>
              env.service.projectCreate({
                name: 'Modified Payload Project',
                description: 'Different payload under same key',
                idempotency_key: 'idem_proj_001',
              }),
            'DUPLICATE_IDEMPOTENCY_KEY'
          );
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Worker context bundle is bounded, includes entity versions & omitted indicators, and excludes unrelated projects/tasks',
      fn: () => {
        const env = createIsolatedTestEnv('unit_context_bundle');
        try {
          const projA = env.service.projectCreate(SYNTHETIC_FIXTURES.projectAlpha).entity;
          const projB = env.service.projectCreate(SYNTHETIC_FIXTURES.projectUnrelated).entity;

          const taskA = env.service.taskCreate({
            ...SYNTHETIC_FIXTURES.taskPrimary,
            project_id: projA.id,
          }).entity;

          const taskUnrelated = env.service.taskCreate({
            title: 'Unrelated Task on Project B',
            project_id: projB.id,
            confirmed_specification: 'Unrelated task specification',
          }).entity;

          // Record 4 decisions on taskA, and 1 decision on taskUnrelated
          for (let i = 1; i <= 4; i++) {
            env.service.decisionAppend({
              ...SYNTHETIC_FIXTURES.decisionLayaSample,
              task_id: taskA.id,
              objective: `Decision #${i} for taskA`,
            });
          }
          env.service.decisionAppend({
            ...SYNTHETIC_FIXTURES.decisionLayaSample,
            task_id: taskUnrelated.id,
            objective: 'Unrelated decision that must not leak',
          });

          // Record 3 runtime routes on taskA
          for (let i = 1; i <= 3; i++) {
            env.service.runtimeRouteAppend({
              task_id: taskA.id,
              route_summary: `Route attempt #${i}`,
              status: i < 3 ? 'partially_viable' : 'viable',
              assessment_confidence: 0.75,
              selection_probability: 0.5,
              suitability_score: 0.8,
              observations: [`Observation ${i}`],
              evidence_refs: [`ev_${i}`],
            });
          }

          // Record knowledge navigation pointer for taskA
          env.service.knowledgeNavigationGetUpdate({
            action: 'update',
            task_id: taskA.id,
            expected_version: 0,
            domain: 'distributed_systems',
            subject: 'sqlite_wal_concurrency',
            chapter_or_concept: 'online_backup_api',
            current_position: 'section_3.2_page_locks',
            prerequisite_refs: ['prereq_acid'],
            source_refs: ['sqlite_doc_backup'],
            unresolved_items: ['verify_wal_checkpoint_behavior'],
          });

          // Request context bundle with tight bounds (max_decisions=2, max_routes=2, max_receipts=2)
          const bundle = env.service.contextBundleGet({
            task_id: taskA.id,
            max_decisions: 2,
            max_routes: 2,
            max_receipts: 2,
          }) as Record<string, any>;

          assert.strictEqual(bundle.bounded, true);
          assert.strictEqual(bundle.project.id, projA.id);
          assert.strictEqual(bundle.task.id, taskA.id);
          assert.strictEqual(bundle.knowledge_navigation.domain, 'distributed_systems');

          // Check entity versions map
          assert.strictEqual(bundle.entity_versions[`project:${projA.id}`], 1);
          assert.strictEqual(bundle.entity_versions[`task:${taskA.id}`], 1);
          assert.strictEqual(bundle.entity_versions[`knowledge_navigation:${taskA.id}`], 1);

          // Check bounded decisions and omitted indicators
          assert.strictEqual(bundle.decisions.total_count, 4);
          assert.strictEqual(bundle.decisions.returned_count, 2);
          assert.strictEqual(bundle.decisions.omitted_count, 2);
          assert.strictEqual(bundle.decisions.truncated, true);
          assert.strictEqual(bundle.omitted_sections.decisions_omitted, 2);
          assert.strictEqual(bundle.omitted_sections.runtime_routes_omitted, 1);
          assert.ok(bundle.omitted_sections.receipts_omitted >= 1);

          // Ensure unrelated project/task content is completely absent
          const serialized = JSON.stringify(bundle);
          assert.ok(!serialized.includes(projB.id), 'Unrelated project ID must not appear in bundle');
          assert.ok(
            !serialized.includes(taskUnrelated.id),
            'Unrelated task ID must not appear in bundle'
          );
          assert.ok(
            !serialized.includes('Unrelated decision that must not leak'),
            'Unrelated decision must not appear in bundle'
          );
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Capability observations distinguish kinds and explicitly mark stale/expired records',
      fn: () => {
        const env = createIsolatedTestEnv('unit_capabilities');
        try {
          // Record a fresh static capability and a stale availability observation from 2 hours ago
          const now = new Date('2026-10-14T15:00:00.000Z');
          const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
          const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
          const oneMinuteAgo = new Date(now.getTime() - 60 * 1000).toISOString();

          env.service.capabilityObservationRecord({
            machine_or_runtime_id: 'node-worker-gpu-01',
            kind: 'static_capability',
            backend: 'cuda',
            observations: { vram_gb: 24, compute_capability: '8.9' },
            measurement_method: 'supplied_manifest',
            measured_at: oneMinuteAgo,
          });

          env.service.capabilityObservationRecord({
            machine_or_runtime_id: 'node-worker-gpu-01',
            kind: 'last_known_availability',
            backend: 'cuda',
            observations: { available: true, queue_depth: 0 },
            measurement_method: 'runtime_heartbeat',
            measured_at: twoHoursAgo,
            valid_until: fiveMinutesAgo,
          });

          const list = env.service.capabilityObservationGet({
            machine_or_runtime_id: 'node-worker-gpu-01',
            as_of: now.toISOString(),
          });

          assert.strictEqual(list.total_count, 2);
          const staticObs = list.items.find((i) => i.kind === 'static_capability')!;
          const availObs = list.items.find((i) => i.kind === 'last_known_availability')!;

          assert.strictEqual(staticObs.freshness?.is_stale, false);
          assert.strictEqual(staticObs.freshness?.status, 'fresh');

          assert.strictEqual(availObs.freshness?.is_stale, true);
          assert.strictEqual(availObs.freshness?.status, 'expired');
          assert.strictEqual(availObs.freshness?.age_seconds, 7200);
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Snapshot export produces consistent namespace-scoped JSON with schema/version manifest',
      fn: () => {
        const env = createIsolatedTestEnv('unit_snapshot_ns');
        try {
          const proj = env.service.projectCreate(SYNTHETIC_FIXTURES.projectAlpha).entity;
          env.service.taskCreate({
            ...SYNTHETIC_FIXTURES.taskPrimary,
            project_id: proj.id,
          });
          env.service.memoryCreate({
            content: 'Confirmed architectural constraint: use SQLite online backup API',
            type: 'confirmed_fact',
            scope: 'project',
            project_id: proj.id,
            tags: ['architecture', 'backup'],
          });

          // Also insert a record into another namespace directly in the same SQLite DB to verify namespace isolation on export
          env.db.run(
            `INSERT INTO projects (
              id, namespace_id, name, objectives_json, constraints_json, status, version, created_at, updated_at
            ) VALUES ('proj_other_ns', 'other_namespace', 'Other Namespace Secret Project', '[]', '[]', 'active', 1, ?, ?)`,
            [new Date().toISOString(), new Date().toISOString()]
          );

          const exported = env.service.snapshotExport({ label: 'release_v2' }) as Record<
            string,
            any
          >;
          assert.ok(fs.existsSync(exported.export_path));
          assert.ok(
            exported.export_path.startsWith(path.resolve(env.config.exportDir) + path.sep)
          );

          const rawJson = fs.readFileSync(exported.export_path, 'utf8');
          const parsed = JSON.parse(rawJson);

          assert.strictEqual(parsed.manifest.format, 'ZyroG2i_PCM_Namespace_Snapshot');
          assert.strictEqual(parsed.manifest.namespace_id, 'unit_snapshot_ns');
          assert.strictEqual(parsed.manifest.schema_version, 1);
          assert.strictEqual(
            parsed.manifest.consistent_snapshot_method,
            'sqlite_online_backup_api'
          );
          assert.strictEqual(parsed.manifest.entity_counts.projects, 1);
          assert.strictEqual(parsed.manifest.entity_counts.tasks, 1);
          assert.strictEqual(parsed.manifest.entity_counts.memories, 1);
          assert.ok(!rawJson.includes('other_namespace'));
          assert.ok(!rawJson.includes('Other Namespace Secret Project'));
        } finally {
          env.cleanup();
        }
      },
    },
  ]);
}
