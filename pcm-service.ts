import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PcmConfig, StderrLogger } from '../config';
import { PcmError } from '../domain/errors';
import {
  ARTIFACT_VERIFICATION_VALUES,
  ASSUMPTION_HANDLING_VALUES,
  AUTONOMY_VALUES,
  AcceptanceCriterion,
  ArtifactRecord,
  CAPABILITY_OBSERVATION_KINDS,
  CLARIFICATION_STRICTNESS_VALUES,
  CapabilityObservationRecord,
  DecisionOption,
  DecisionRecord,
  EXPERTISE_MODE_VALUES,
  KnowledgeNavigationRecord,
  MAX_ARRAY_ITEMS,
  MAX_POINTER_TEXT_LENGTH,
  MAX_SHORT_TEXT_LENGTH,
  MAX_TEXT_LENGTH,
  MEMORY_SCOPES,
  MEMORY_STATUS_VALUES,
  MEMORY_TYPES,
  MemoryRecord,
  PRIVACY_CLASSIFICATIONS,
  PROFILE_ALLOWLIST_FIELDS,
  PROJECT_STATUS_VALUES,
  ProjectRecord,
  ProvenanceInfo,
  RECEIPT_OUTCOME_VALUES,
  RISK_TOLERANCE_VALUES,
  RUNTIME_ROUTE_STATUS_VALUES,
  ReceiptRecord,
  RuntimeRouteRecord,
  TASK_PRIORITY_VALUES,
  TASK_STATUS_VALUES,
  TASK_VERIFICATION_VALUES,
  TONE_VALUES,
  TaskAssignment,
  TaskBlocker,
  TaskOpenQuestion,
  TaskRecord,
  UserProfile,
  VERBOSITY_VALUES,
  VERIFICATION_EFFORT_VALUES,
  assertEnum,
  assertExpectedVersion,
  assertNoCallerNamespaceSpoofing,
  assertNoSecrets,
  assertNonEmptyString,
  assertObject,
  assertOptionalString,
  assertStringArray,
  assertUnitInterval,
  computePayloadHash,
  redactSecrets,
  validateArtifactReference,
  validatePagination,
  validateTaskStatusTransition,
} from '../domain/schemas';
import { SqliteDatabase } from '../storage/database';
import {
  mapArtifactRow,
  mapCapabilityObservationRow,
  mapDecisionRow,
  mapKnowledgeNavigationRow,
  mapMemoryRow,
  mapProfileRow,
  mapProjectRow,
  mapReceiptRow,
  mapRuntimeRouteRow,
  mapTaskRow,
} from '../storage/repositories';

export interface PaginatedResult<T> {
  items: T[];
  total_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface MutationResult<T> {
  entity: T;
  receipt: ReceiptRecord;
  idempotent_replay: boolean;
}

const DEFAULT_STALE_THRESHOLDS_SECONDS: Record<string, number> = {
  last_known_availability: 300, // 5 minutes
  measured_performance: 86400, // 24 hours
  static_capability: 604800, // 7 days
};

export class PcmService {
  public readonly db: SqliteDatabase;
  public readonly config: PcmConfig;
  public readonly logger: StderrLogger;

  constructor(db: SqliteDatabase, config: PcmConfig, logger?: StderrLogger) {
    this.db = db;
    this.config = config;
    this.logger = logger ?? new StderrLogger(config.logLevel, config.namespace);
  }

  private get namespace(): string {
    return this.config.namespace;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private newId(prefix?: string): string {
    const uuid = crypto.randomUUID();
    return prefix ? `${prefix}_${uuid}` : uuid;
  }

  private validateProvenance(raw: unknown): ProvenanceInfo | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    const obj = assertObject(raw, 'provenance');
    assertNoSecrets(obj, 'provenance');
    return {
      ...(obj.source !== undefined
        ? { source: assertNonEmptyString(obj.source, 'provenance.source', MAX_SHORT_TEXT_LENGTH) }
        : {}),
      ...(obj.actor !== undefined
        ? { actor: assertNonEmptyString(obj.actor, 'provenance.actor', MAX_SHORT_TEXT_LENGTH) }
        : {}),
      ...(obj.recorded_reason !== undefined
        ? {
            recorded_reason: assertNonEmptyString(
              obj.recorded_reason,
              'provenance.recorded_reason',
              MAX_SHORT_TEXT_LENGTH
            ),
          }
        : {}),
      ...(obj.external_ref !== undefined
        ? {
            external_ref: assertNonEmptyString(
              obj.external_ref,
              'provenance.external_ref',
              MAX_SHORT_TEXT_LENGTH
            ),
          }
        : {}),
    };
  }

  /**
   * Verify that an entity ID exists in the given table and belongs to the server's namespace.
   * If the ID exists in another namespace, throw NAMESPACE_MISMATCH.
   * If it does not exist at all, throw NOT_FOUND.
   */
  private assertEntityInNamespace(table: string, id: string, entityLabel: string): void {
    const row = this.db.get<{ id: string; namespace_id: string }>(
      `SELECT id, namespace_id FROM ${table} WHERE id = ?`,
      [id]
    );
    if (!row) {
      throw new PcmError('NOT_FOUND', `${entityLabel} "${id}" was not found`, {
        entity: entityLabel,
        id,
      });
    }
    if (row.namespace_id !== this.namespace) {
      throw new PcmError(
        'NAMESPACE_MISMATCH',
        `${entityLabel} "${id}" belongs to a different namespace and cannot be accessed`,
        { entity: entityLabel, id }
      );
    }
  }

  /**
   * Atomic write wrapper with idempotency key ledger and mandatory operational receipt.
   */
  private executeWriteWithReceipt<T>(params: {
    operation: string;
    eventType: string;
    rawInput: Record<string, unknown>;
    mutate: (now: string) => {
      entity: T;
      taskId?: string | null;
      projectId?: string | null;
      summary: string;
      evidenceRefs?: string[];
      artifactRefs?: string[];
      stateVersions?: Record<string, number>;
      metadata?: Record<string, unknown>;
    };
  }): MutationResult<T> {
    const { operation, eventType, rawInput, mutate } = params;
    assertNoCallerNamespaceSpoofing(rawInput, this.namespace);

    const idempotencyKey = assertOptionalString(
      rawInput.idempotency_key,
      'idempotency_key',
      MAX_SHORT_TEXT_LENGTH
    );
    const correlationId = assertOptionalString(
      rawInput.correlation_id,
      'correlation_id',
      MAX_SHORT_TEXT_LENGTH
    );
    const actorAttribution = assertOptionalString(
      rawInput.actor_attribution,
      'actor_attribution',
      MAX_SHORT_TEXT_LENGTH
    );
    const payloadHash = idempotencyKey ? computePayloadHash(operation, rawInput) : null;

    return this.db.transaction(() => {
      if (idempotencyKey && payloadHash) {
        const existingKey = this.db.get<{
          operation: string;
          payload_hash: string;
          receipt_id: string;
          response_json: string;
        }>(
          `SELECT operation, payload_hash, receipt_id, response_json
           FROM idempotency_keys
           WHERE namespace_id = ? AND idempotency_key = ?`,
          [this.namespace, idempotencyKey]
        );

        if (existingKey) {
          if (existingKey.operation !== operation || existingKey.payload_hash !== payloadHash) {
            throw new PcmError(
              'DUPLICATE_IDEMPOTENCY_KEY',
              `Idempotency key "${idempotencyKey}" was already used with a different operation or payload`,
              {
                idempotency_key: idempotencyKey,
                existing_operation: existingKey.operation,
                requested_operation: operation,
              }
            );
          }

          const cached = JSON.parse(existingKey.response_json) as {
            entity: T;
            receipt: ReceiptRecord;
          };
          return {
            entity: cached.entity,
            receipt: cached.receipt,
            idempotent_replay: true,
          };
        }
      }

      const now = this.nowIso();
      const mutationOut = mutate(now);

      // Test fault injection hook AFTER entity mutation but BEFORE transaction commit
      if (rawInput._test_force_fail_after_mutation === true) {
        throw new PcmError(
          'INTERNAL_ERROR',
          'Simulated transaction failure after entity mutation for rollback verification'
        );
      }

      const receiptId = this.newId('rcpt');
      const safeSummary = redactSecrets(mutationOut.summary);
      const safeMetadata = mutationOut.metadata ? redactSecrets(mutationOut.metadata) : null;

      this.db.run(
        `INSERT INTO receipts (
          id, namespace_id, task_id, project_id, correlation_id, idempotency_key,
          event_type, operation, actor_attribution, timestamp, outcome, summary,
          evidence_refs_json, artifact_refs_json, state_versions_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          receiptId,
          this.namespace,
          mutationOut.taskId ?? null,
          mutationOut.projectId ?? null,
          correlationId,
          idempotencyKey,
          eventType,
          operation,
          actorAttribution,
          now,
          'success',
          safeSummary,
          JSON.stringify(mutationOut.evidenceRefs ?? []),
          JSON.stringify(mutationOut.artifactRefs ?? []),
          mutationOut.stateVersions ? JSON.stringify(mutationOut.stateVersions) : null,
          safeMetadata ? JSON.stringify(safeMetadata) : null,
        ]
      );

      if (rawInput._test_force_fail_after_receipt === true) {
        throw new PcmError(
          'INTERNAL_ERROR',
          'Simulated transaction failure after receipt insert for rollback verification'
        );
      }

      const receiptRow = this.db.get(
        'SELECT * FROM receipts WHERE id = ? AND namespace_id = ?',
        [receiptId, this.namespace]
      );
      if (!receiptRow) {
        throw new PcmError('INTERNAL_ERROR', 'Failed to read committed receipt');
      }
      const receipt = mapReceiptRow(receiptRow);

      if (idempotencyKey && payloadHash) {
        this.db.run(
          `INSERT INTO idempotency_keys (
            namespace_id, idempotency_key, operation, payload_hash, receipt_id, response_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            this.namespace,
            idempotencyKey,
            operation,
            payloadHash,
            receiptId,
            JSON.stringify({ entity: mutationOut.entity, receipt }),
            now,
          ]
        );
      }

      return {
        entity: mutationOut.entity,
        receipt,
        idempotent_replay: false,
      };
    });
  }

  // ==========================================================================
  // 1. Health & Readiness
  // ==========================================================================

  public health(rawInput: Record<string, unknown> = {}): Record<string, unknown> {
    assertNoCallerNamespaceSpoofing(rawInput, this.namespace);
    if (!this.db.isOpen()) {
      throw new PcmError('STORAGE_UNAVAILABLE', 'Database is not open');
    }
    const probe = this.db.get<{ ok: number }>('SELECT 1 as ok');
    const schema = this.db.getSchemaStatus();
    if (!probe || probe.ok !== 1 || !schema.foreign_keys_enabled || !schema.is_up_to_date) {
      throw new PcmError('STORAGE_UNAVAILABLE', 'Database readiness check failed', {
        schema,
      });
    }

    const counts = {
      projects:
        this.db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM projects WHERE namespace_id = ?', [
          this.namespace,
        ])?.cnt ?? 0,
      tasks:
        this.db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM tasks WHERE namespace_id = ?', [
          this.namespace,
        ])?.cnt ?? 0,
      memories:
        this.db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM memories WHERE namespace_id = ?', [
          this.namespace,
        ])?.cnt ?? 0,
      decisions:
        this.db.get<{ cnt: number }>(
          'SELECT COUNT(*) as cnt FROM decisions WHERE namespace_id = ?',
          [this.namespace]
        )?.cnt ?? 0,
      artifacts:
        this.db.get<{ cnt: number }>(
          'SELECT COUNT(*) as cnt FROM artifacts WHERE namespace_id = ?',
          [this.namespace]
        )?.cnt ?? 0,
      runtime_routes:
        this.db.get<{ cnt: number }>(
          'SELECT COUNT(*) as cnt FROM runtime_routes WHERE namespace_id = ?',
          [this.namespace]
        )?.cnt ?? 0,
      capability_observations:
        this.db.get<{ cnt: number }>(
          'SELECT COUNT(*) as cnt FROM capability_observations WHERE namespace_id = ?',
          [this.namespace]
        )?.cnt ?? 0,
      receipts:
        this.db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM receipts WHERE namespace_id = ?', [
          this.namespace,
        ])?.cnt ?? 0,
    };

    return {
      status: 'ready',
      service: 'ZyroG2i_PCM_Deployment_MCP_MVP_v2',
      namespace: this.namespace,
      timestamp: this.nowIso(),
      schema,
      storage: {
        engine: 'sqlite',
        db_path: this.config.dbPath,
        artifact_root: this.config.artifactRoot,
        export_dir: this.config.exportDir,
      },
      namespace_counts: counts,
    };
  }

  // ==========================================================================
  // 2. User Profile (Get / Update)
  // ==========================================================================

  private ensureDefaultProfile(): UserProfile {
    const existing = this.db.get('SELECT * FROM profiles WHERE namespace_id = ?', [this.namespace]);
    if (existing) {
      return mapProfileRow(existing);
    }
    const now = this.nowIso();
    const id = `profile_${this.namespace}`;
    this.db.run(
      `INSERT OR IGNORE INTO profiles (
        id, namespace_id, clarification_strictness, risk_tolerance, tone, verbosity,
        expertise_mode, assumption_handling, verification_effort, autonomy,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        this.namespace,
        'medium',
        'moderate',
        'direct',
        'concise',
        'expert',
        'state_explicitly',
        'strict',
        'collaborative',
        now,
        now,
      ]
    );
    const created = this.db.get('SELECT * FROM profiles WHERE namespace_id = ?', [this.namespace]);
    if (!created) {
      throw new PcmError('INTERNAL_ERROR', 'Failed to initialize default profile');
    }
    return mapProfileRow(created);
  }

  public profileGet(rawInput: Record<string, unknown> = {}): UserProfile {
    assertNoCallerNamespaceSpoofing(rawInput, this.namespace);
    return this.ensureDefaultProfile();
  }

  public profileUpdate(rawInput: Record<string, unknown>): MutationResult<UserProfile> {
    const input = assertObject(rawInput, 'profile_update');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'profile_update');

    const expectedVersion = assertExpectedVersion(input.expected_version);

    const allowedTopLevelKeys = new Set<string>([
      ...PROFILE_ALLOWLIST_FIELDS,
      'expected_version',
      'idempotency_key',
      'correlation_id',
      'actor_attribution',
      '_test_force_fail_after_mutation',
      '_test_force_fail_after_receipt',
    ]);

    for (const key of Object.keys(input)) {
      if (!allowedTopLevelKeys.has(key)) {
        throw new PcmError(
          'INVALID_INPUT',
          `Unapproved profile field "${key}". Profile accepts only allowlisted interaction/preference fields and never overrides safety, truthfulness, or verification rules.`,
          { field: key, reason: 'UNAPPROVED_PROFILE_FIELD', allowed_fields: PROFILE_ALLOWLIST_FIELDS }
        );
      }
    }

    const touchedFields: string[] = [];
    for (const k of PROFILE_ALLOWLIST_FIELDS) {
      if (input[k] !== undefined) {
        touchedFields.push(k);
      }
    }
    if (touchedFields.length === 0) {
      throw new PcmError(
        'INVALID_INPUT',
        'At least one allowlisted profile field must be provided for update',
        { allowed_fields: PROFILE_ALLOWLIST_FIELDS }
      );
    }

    return this.executeWriteWithReceipt({
      operation: 'profile_update',
      eventType: 'profile.updated',
      rawInput: input,
      mutate: (now) => {
        const current = this.ensureDefaultProfile();
        if (current.version !== expectedVersion) {
          throw new PcmError(
            'VERSION_CONFLICT',
            `Profile version conflict: expected_version=${expectedVersion}, actual_version=${current.version}`,
            { expected_version: expectedVersion, actual_version: current.version }
          );
        }

        const next: UserProfile = {
          ...current,
          clarification_strictness:
            input.clarification_strictness !== undefined
              ? assertEnum(
                  input.clarification_strictness,
                  CLARIFICATION_STRICTNESS_VALUES,
                  'clarification_strictness'
                )
              : current.clarification_strictness,
          risk_tolerance:
            input.risk_tolerance !== undefined
              ? assertEnum(input.risk_tolerance, RISK_TOLERANCE_VALUES, 'risk_tolerance')
              : current.risk_tolerance,
          tone:
            input.tone !== undefined
              ? assertEnum(input.tone, TONE_VALUES, 'tone')
              : current.tone,
          verbosity:
            input.verbosity !== undefined
              ? assertEnum(input.verbosity, VERBOSITY_VALUES, 'verbosity')
              : current.verbosity,
          expertise_mode:
            input.expertise_mode !== undefined
              ? assertEnum(input.expertise_mode, EXPERTISE_MODE_VALUES, 'expertise_mode')
              : current.expertise_mode,
          assumption_handling:
            input.assumption_handling !== undefined
              ? assertEnum(
                  input.assumption_handling,
                  ASSUMPTION_HANDLING_VALUES,
                  'assumption_handling'
                )
              : current.assumption_handling,
          verification_effort:
            input.verification_effort !== undefined
              ? assertEnum(
                  input.verification_effort,
                  VERIFICATION_EFFORT_VALUES,
                  'verification_effort'
                )
              : current.verification_effort,
          autonomy:
            input.autonomy !== undefined
              ? assertEnum(input.autonomy, AUTONOMY_VALUES, 'autonomy')
              : current.autonomy,
          version: current.version + 1,
          updated_at: now,
        };

        const res = this.db.run(
          `UPDATE profiles
           SET clarification_strictness = ?,
               risk_tolerance = ?,
               tone = ?,
               verbosity = ?,
               expertise_mode = ?,
               assumption_handling = ?,
               verification_effort = ?,
               autonomy = ?,
               version = ?,
               updated_at = ?
           WHERE namespace_id = ? AND version = ?`,
          [
            next.clarification_strictness,
            next.risk_tolerance,
            next.tone,
            next.verbosity,
            next.expertise_mode,
            next.assumption_handling,
            next.verification_effort,
            next.autonomy,
            next.version,
            next.updated_at,
            this.namespace,
            expectedVersion,
          ]
        );

        if (res.changes !== 1) {
          throw new PcmError('VERSION_CONFLICT', 'Profile update conflicted concurrently');
        }

        return {
          entity: next,
          summary: `Updated user profile preferences (${touchedFields.join(', ')}) to v${next.version}`,
          stateVersions: { profile: next.version },
          metadata: { updated_fields: touchedFields },
        };
      },
    });
  }

  // ==========================================================================
  // 3. Memory Operations (Create, Search, Update, Archive, Permanent Forget)
  // ==========================================================================

  private upsertMemorySearchIndex(memory: MemoryRecord): void {
    const searchable = [
      memory.content,
      memory.type,
      memory.scope,
      memory.source_type ?? '',
      memory.source_ref ?? '',
    ]
      .join(' ')
      .toLowerCase();
    const tagsText = memory.tags.join(' ').toLowerCase();

    this.db.run(
      `INSERT INTO memories_search_index (memory_id, namespace_id, searchable_text, tags_text, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         searchable_text = excluded.searchable_text,
         tags_text = excluded.tags_text,
         updated_at = excluded.updated_at`,
      [memory.id, this.namespace, searchable, tagsText, memory.updated_at]
    );
  }

  public memoryCreate(rawInput: Record<string, unknown>): MutationResult<MemoryRecord> {
    const input = assertObject(rawInput, 'memory_create');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'memory_create');

    const content = assertNonEmptyString(input.content, 'content', MAX_TEXT_LENGTH);
    const type = assertEnum(input.type, MEMORY_TYPES, 'type');
    const scope = assertEnum(input.scope, MEMORY_SCOPES, 'scope');
    const projectId = assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH);
    const taskId = assertOptionalString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);

    if (scope === 'project' && !projectId) {
      throw new PcmError('INVALID_INPUT', 'project_id is required when memory scope is "project"');
    }
    if (scope === 'task' && !taskId) {
      throw new PcmError('INVALID_INPUT', 'task_id is required when memory scope is "task"');
    }

    const tags = assertStringArray(input.tags, 'tags', 50, 128);
    const sourceType = assertOptionalString(input.source_type, 'source_type', MAX_SHORT_TEXT_LENGTH);
    const sourceRef = assertOptionalString(input.source_ref, 'source_ref', MAX_SHORT_TEXT_LENGTH);
    const confidence = assertUnitInterval(input.confidence, 'confidence');
    const privacyClassification =
      input.privacy_classification !== undefined
        ? assertEnum(
            input.privacy_classification,
            PRIVACY_CLASSIFICATIONS,
            'privacy_classification'
          )
        : 'internal';
    const expiresAt = assertOptionalString(input.expires_at, 'expires_at', 64);
    const provenance = this.validateProvenance(input.provenance);

    return this.executeWriteWithReceipt({
      operation: 'memory_create',
      eventType: 'memory.created',
      rawInput: input,
      mutate: (now) => {
        if (projectId) {
          this.assertEntityInNamespace('projects', projectId, 'Project');
        }
        if (taskId) {
          this.assertEntityInNamespace('tasks', taskId, 'Task');
        }

        const id =
          input.id !== undefined
            ? assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH)
            : this.newId('mem');

        const existing = this.db.get('SELECT id FROM memories WHERE id = ?', [id]);
        if (existing) {
          throw new PcmError('INVALID_INPUT', `Memory with id "${id}" already exists`);
        }

        const record: MemoryRecord = {
          id,
          namespace_id: this.namespace,
          content,
          type,
          scope,
          project_id: projectId,
          task_id: taskId,
          tags,
          source_type: sourceType,
          source_ref: sourceRef,
          confidence,
          privacy_classification: privacyClassification,
          expires_at: expiresAt,
          status: 'active',
          version: 1,
          provenance,
          created_at: now,
          updated_at: now,
        };

        this.db.run(
          `INSERT INTO memories (
            id, namespace_id, content, type, scope, project_id, task_id, tags_json,
            source_type, source_ref, confidence, privacy_classification, expires_at,
            status, version, provenance_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.namespace_id,
            record.content,
            record.type,
            record.scope,
            record.project_id,
            record.task_id,
            JSON.stringify(record.tags),
            record.source_type,
            record.source_ref,
            record.confidence,
            record.privacy_classification,
            record.expires_at,
            record.status,
            record.version,
            record.provenance ? JSON.stringify(record.provenance) : null,
            record.created_at,
            record.updated_at,
          ]
        );

        this.upsertMemorySearchIndex(record);

        // Invariant: Never copy raw memory content into receipts so permanent forgetting leaves zero content in receipts.
        return {
          entity: record,
          taskId: record.task_id,
          projectId: record.project_id,
          summary: `Created ${record.type} memory ${record.id} (scope=${record.scope})`,
          stateVersions: { [`memory:${record.id}`]: record.version },
          metadata: {
            memory_id: record.id,
            type: record.type,
            scope: record.scope,
            content_length: record.content.length,
            tags_count: record.tags.length,
          },
        };
      },
    });
  }

  public memorySearch(rawInput: Record<string, unknown> = {}): PaginatedResult<MemoryRecord> {
    const input = assertObject(rawInput, 'memory_search');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const { limit, offset } = validatePagination(input);

    const query = assertOptionalString(input.query, 'query', MAX_SHORT_TEXT_LENGTH);
    const type =
      input.type !== undefined ? assertEnum(input.type, MEMORY_TYPES, 'type') : null;
    const scope =
      input.scope !== undefined ? assertEnum(input.scope, MEMORY_SCOPES, 'scope') : null;
    const projectId = assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH);
    const taskId = assertOptionalString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    const tag = assertOptionalString(input.tag, 'tag', 128);
    const status =
      input.status !== undefined
        ? assertEnum(input.status, MEMORY_STATUS_VALUES, 'status')
        : 'active';
    const includeExpired = input.include_expired === true;

    const whereClauses: string[] = ['m.namespace_id = ?'];
    const params: unknown[] = [this.namespace];

    if (input.include_all_statuses !== true) {
      whereClauses.push('m.status = ?');
      params.push(status);
    }

    if (type) {
      whereClauses.push('m.type = ?');
      params.push(type);
    }
    if (scope) {
      whereClauses.push('m.scope = ?');
      params.push(scope);
    }
    if (projectId) {
      whereClauses.push('m.project_id = ?');
      params.push(projectId);
    }
    if (taskId) {
      whereClauses.push('m.task_id = ?');
      params.push(taskId);
    }
    if (!includeExpired) {
      whereClauses.push('(m.expires_at IS NULL OR m.expires_at > ?)');
      params.push(this.nowIso());
    }
    if (query) {
      whereClauses.push('idx.searchable_text LIKE ?');
      params.push(`%${query.toLowerCase()}%`);
    }
    if (tag) {
      whereClauses.push('idx.tags_text LIKE ?');
      params.push(`%${tag.toLowerCase()}%`);
    }

    const whereSql = whereClauses.join(' AND ');
    const countRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt
       FROM memories m
       INNER JOIN memories_search_index idx ON idx.memory_id = m.id
       WHERE ${whereSql}`,
      params
    );
    const totalCount = countRow ? Number(countRow.cnt) : 0;

    const rows = this.db.all(
      `SELECT m.*
       FROM memories m
       INNER JOIN memories_search_index idx ON idx.memory_id = m.id
       WHERE ${whereSql}
       ORDER BY m.updated_at DESC, m.id ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const items = rows.map(mapMemoryRow);
    return {
      items,
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  public memoryUpdate(rawInput: Record<string, unknown>): MutationResult<MemoryRecord> {
    const input = assertObject(rawInput, 'memory_update');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'memory_update');

    const id = assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH);
    const expectedVersion = assertExpectedVersion(input.expected_version);

    return this.executeWriteWithReceipt({
      operation: 'memory_update',
      eventType: 'memory.updated',
      rawInput: input,
      mutate: (now) => {
        this.assertEntityInNamespace('memories', id, 'Memory');
        const row = this.db.get('SELECT * FROM memories WHERE id = ? AND namespace_id = ?', [
          id,
          this.namespace,
        ]);
        if (!row) {
          throw new PcmError('NOT_FOUND', `Memory "${id}" not found`);
        }
        const current = mapMemoryRow(row);
        if (current.version !== expectedVersion) {
          throw new PcmError(
            'VERSION_CONFLICT',
            `Memory "${id}" version conflict: expected_version=${expectedVersion}, actual_version=${current.version}`,
            { id, expected_version: expectedVersion, actual_version: current.version }
          );
        }

        const nextContent =
          input.content !== undefined
            ? assertNonEmptyString(input.content, 'content', MAX_TEXT_LENGTH)
            : current.content;
        const nextType =
          input.type !== undefined
            ? assertEnum(input.type, MEMORY_TYPES, 'type')
            : current.type;
        const nextTags =
          input.tags !== undefined
            ? assertStringArray(input.tags, 'tags', 50, 128)
            : current.tags;
        const nextConfidence =
          input.confidence !== undefined
            ? assertUnitInterval(input.confidence, 'confidence')
            : current.confidence;
        const nextStatus =
          input.status !== undefined
            ? assertEnum(input.status, MEMORY_STATUS_VALUES, 'status')
            : current.status;
        const nextPrivacy =
          input.privacy_classification !== undefined
            ? assertEnum(
                input.privacy_classification,
                PRIVACY_CLASSIFICATIONS,
                'privacy_classification'
              )
            : current.privacy_classification;
        const nextExpiresAt =
          input.expires_at !== undefined
            ? assertOptionalString(input.expires_at, 'expires_at', 64)
            : current.expires_at;
        const nextSourceType =
          input.source_type !== undefined
            ? assertOptionalString(input.source_type, 'source_type', MAX_SHORT_TEXT_LENGTH)
            : current.source_type;
        const nextSourceRef =
          input.source_ref !== undefined
            ? assertOptionalString(input.source_ref, 'source_ref', MAX_SHORT_TEXT_LENGTH)
            : current.source_ref;

        const updated: MemoryRecord = {
          ...current,
          content: nextContent,
          type: nextType,
          tags: nextTags,
          confidence: nextConfidence,
          status: nextStatus,
          privacy_classification: nextPrivacy,
          expires_at: nextExpiresAt,
          source_type: nextSourceType,
          source_ref: nextSourceRef,
          version: current.version + 1,
          updated_at: now,
        };

        const res = this.db.run(
          `UPDATE memories
           SET content = ?,
               type = ?,
               tags_json = ?,
               confidence = ?,
               status = ?,
               privacy_classification = ?,
               expires_at = ?,
               source_type = ?,
               source_ref = ?,
               version = ?,
               updated_at = ?
           WHERE id = ? AND namespace_id = ? AND version = ?`,
          [
            updated.content,
            updated.type,
            JSON.stringify(updated.tags),
            updated.confidence,
            updated.status,
            updated.privacy_classification,
            updated.expires_at,
            updated.source_type,
            updated.source_ref,
            updated.version,
            updated.updated_at,
            id,
            this.namespace,
            expectedVersion,
          ]
        );

        if (res.changes !== 1) {
          throw new PcmError('VERSION_CONFLICT', `Memory "${id}" concurrent update conflict`);
        }

        this.upsertMemorySearchIndex(updated);

        return {
          entity: updated,
          taskId: updated.task_id,
          projectId: updated.project_id,
          summary: `Updated memory ${updated.id} to v${updated.version} (status=${updated.status})`,
          stateVersions: { [`memory:${updated.id}`]: updated.version },
          metadata: {
            memory_id: updated.id,
            type: updated.type,
            status: updated.status,
            content_length: updated.content.length,
          },
        };
      },
    });
  }

  public memoryArchive(rawInput: Record<string, unknown>): MutationResult<MemoryRecord> {
    const input = assertObject(rawInput, 'memory_archive');
    return this.memoryUpdate({
      ...input,
      status: 'archived',
    });
  }

  public memoryForget(
    rawInput: Record<string, unknown>
  ): MutationResult<{ forgotten_id: string; purged: true }> {
    const input = assertObject(rawInput, 'memory_forget');
    assertNoCallerNamespaceSpoofing(input, this.namespace);

    const id = assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH);

    // Permanent forgetting requires meaningful confirmation
    if (
      input.confirm_permanent_delete !== true ||
      input.confirmation_phrase !== 'PERMANENTLY_FORGET'
    ) {
      throw new PcmError(
        'CONFIRMATION_REQUIRED',
        'Permanent memory forgetting requires confirm_permanent_delete=true and confirmation_phrase="PERMANENTLY_FORGET". Use memory_archive by default.',
        {
          id,
          required_fields: {
            confirm_permanent_delete: true,
            confirmation_phrase: 'PERMANENTLY_FORGET',
          },
        }
      );
    }

    const expectedVersion =
      input.expected_version !== undefined
        ? assertExpectedVersion(input.expected_version)
        : undefined;

    return this.executeWriteWithReceipt({
      operation: 'memory_forget',
      eventType: 'memory.permanently_forgotten',
      rawInput: input,
      mutate: () => {
        this.assertEntityInNamespace('memories', id, 'Memory');
        const row = this.db.get('SELECT * FROM memories WHERE id = ? AND namespace_id = ?', [
          id,
          this.namespace,
        ]);
        if (!row) {
          throw new PcmError('NOT_FOUND', `Memory "${id}" not found`);
        }
        const current = mapMemoryRow(row);
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          throw new PcmError(
            'VERSION_CONFLICT',
            `Memory "${id}" version conflict: expected_version=${expectedVersion}, actual_version=${current.version}`,
            { id, expected_version: expectedVersion, actual_version: current.version }
          );
        }

        // 1. Delete from search index
        this.db.run(
          'DELETE FROM memories_search_index WHERE memory_id = ? AND namespace_id = ?',
          [id, this.namespace]
        );

        // 2. Delete from memories table
        this.db.run('DELETE FROM memories WHERE id = ? AND namespace_id = ?', [
          id,
          this.namespace,
        ]);

        // 3. Scrub any prior receipt metadata/summaries referencing this memory so zero content remains in receipts
        this.db.run(
          `UPDATE receipts
           SET summary = '[REDACTED: permanently forgotten memory ' || ? || ']',
               metadata_json = '{"memory_id":' || json_quote(?) || ',"purged":true}'
           WHERE namespace_id = ?
             AND (metadata_json LIKE ? OR summary LIKE ?)`,
          [id, id, this.namespace, `%${id}%`, `%${id}%`]
        );

        return {
          entity: { forgotten_id: id, purged: true as const },
          taskId: current.task_id,
          projectId: current.project_id,
          summary: `Permanently forgot memory record ${id} (content and search index purged)`,
          metadata: {
            forgotten_memory_id: id,
            purged: true,
          },
        };
      },
    });
  }

  // ==========================================================================
  // 4. Project Operations (Create, Get, List, Update)
  // ==========================================================================

  public projectCreate(rawInput: Record<string, unknown>): MutationResult<ProjectRecord> {
    const input = assertObject(rawInput, 'project_create');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'project_create');

    const name = assertNonEmptyString(input.name, 'name', MAX_SHORT_TEXT_LENGTH);
    const description = assertOptionalString(input.description, 'description', MAX_TEXT_LENGTH);
    const objectives = assertStringArray(input.objectives, 'objectives');
    const constraints = assertStringArray(input.constraints, 'constraints');
    const status =
      input.status !== undefined
        ? assertEnum(input.status, PROJECT_STATUS_VALUES, 'status')
        : 'active';
    const provenance = this.validateProvenance(input.provenance);

    return this.executeWriteWithReceipt({
      operation: 'project_create',
      eventType: 'project.created',
      rawInput: input,
      mutate: (now) => {
        const id =
          input.id !== undefined
            ? assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH)
            : this.newId('proj');

        const existing = this.db.get('SELECT id FROM projects WHERE id = ?', [id]);
        if (existing) {
          throw new PcmError('INVALID_INPUT', `Project with id "${id}" already exists`);
        }

        const record: ProjectRecord = {
          id,
          namespace_id: this.namespace,
          name,
          description,
          objectives,
          constraints,
          status,
          version: 1,
          provenance,
          created_at: now,
          updated_at: now,
        };

        this.db.run(
          `INSERT INTO projects (
            id, namespace_id, name, description, objectives_json, constraints_json,
            status, version, provenance_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.namespace_id,
            record.name,
            record.description,
            JSON.stringify(record.objectives),
            JSON.stringify(record.constraints),
            record.status,
            record.version,
            record.provenance ? JSON.stringify(record.provenance) : null,
            record.created_at,
            record.updated_at,
          ]
        );

        return {
          entity: record,
          projectId: record.id,
          summary: `Created project "${record.name}" (${record.id}) v1`,
          stateVersions: { [`project:${record.id}`]: record.version },
        };
      },
    });
  }

  public projectGet(
    rawInput: Record<string, unknown>
  ): ProjectRecord & { task_ids: string[]; artifact_ids: string[] } {
    const input = assertObject(rawInput, 'project_get');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const id = assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH);

    this.assertEntityInNamespace('projects', id, 'Project');
    const row = this.db.get('SELECT * FROM projects WHERE id = ? AND namespace_id = ?', [
      id,
      this.namespace,
    ]);
    if (!row) {
      throw new PcmError('NOT_FOUND', `Project "${id}" not found`);
    }
    const project = mapProjectRow(row);

    // Projects group task and artifact references without duplicating child content
    const taskRows = this.db.all<{ id: string }>(
      'SELECT id FROM tasks WHERE namespace_id = ? AND project_id = ? ORDER BY created_at ASC',
      [this.namespace, id]
    );
    const artifactRows = this.db.all<{ id: string }>(
      'SELECT id FROM artifacts WHERE namespace_id = ? AND project_id = ? ORDER BY created_at ASC',
      [this.namespace, id]
    );

    return {
      ...project,
      task_ids: taskRows.map((r) => r.id),
      artifact_ids: artifactRows.map((r) => r.id),
    };
  }

  public projectList(rawInput: Record<string, unknown> = {}): PaginatedResult<ProjectRecord> {
    const input = assertObject(rawInput, 'project_list');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const { limit, offset } = validatePagination(input);

    const status =
      input.status !== undefined
        ? assertEnum(input.status, PROJECT_STATUS_VALUES, 'status')
        : null;

    const whereClauses = ['namespace_id = ?'];
    const params: unknown[] = [this.namespace];

    if (status) {
      whereClauses.push('status = ?');
      params.push(status);
    }

    const whereSql = whereClauses.join(' AND ');
    const countRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM projects WHERE ${whereSql}`,
      params
    );
    const totalCount = countRow ? Number(countRow.cnt) : 0;

    const rows = this.db.all(
      `SELECT * FROM projects WHERE ${whereSql} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const items = rows.map(mapProjectRow);
    return {
      items,
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  public projectUpdate(rawInput: Record<string, unknown>): MutationResult<ProjectRecord> {
    const input = assertObject(rawInput, 'project_update');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'project_update');

    const id = assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH);
    const expectedVersion = assertExpectedVersion(input.expected_version);

    return this.executeWriteWithReceipt({
      operation: 'project_update',
      eventType: 'project.updated',
      rawInput: input,
      mutate: (now) => {
        this.assertEntityInNamespace('projects', id, 'Project');
        const row = this.db.get('SELECT * FROM projects WHERE id = ? AND namespace_id = ?', [
          id,
          this.namespace,
        ]);
        if (!row) {
          throw new PcmError('NOT_FOUND', `Project "${id}" not found`);
        }
        const current = mapProjectRow(row);
        if (current.version !== expectedVersion) {
          throw new PcmError(
            'VERSION_CONFLICT',
            `Project "${id}" version conflict: expected_version=${expectedVersion}, actual_version=${current.version}`,
            { id, expected_version: expectedVersion, actual_version: current.version }
          );
        }

        const updated: ProjectRecord = {
          ...current,
          name:
            input.name !== undefined
              ? assertNonEmptyString(input.name, 'name', MAX_SHORT_TEXT_LENGTH)
              : current.name,
          description:
            input.description !== undefined
              ? assertOptionalString(input.description, 'description', MAX_TEXT_LENGTH)
              : current.description,
          objectives:
            input.objectives !== undefined
              ? assertStringArray(input.objectives, 'objectives')
              : current.objectives,
          constraints:
            input.constraints !== undefined
              ? assertStringArray(input.constraints, 'constraints')
              : current.constraints,
          status:
            input.status !== undefined
              ? assertEnum(input.status, PROJECT_STATUS_VALUES, 'status')
              : current.status,
          provenance:
            input.provenance !== undefined
              ? this.validateProvenance(input.provenance)
              : current.provenance,
          version: current.version + 1,
          updated_at: now,
        };

        const res = this.db.run(
          `UPDATE projects
           SET name = ?,
               description = ?,
               objectives_json = ?,
               constraints_json = ?,
               status = ?,
               provenance_json = ?,
               version = ?,
               updated_at = ?
           WHERE id = ? AND namespace_id = ? AND version = ?`,
          [
            updated.name,
            updated.description,
            JSON.stringify(updated.objectives),
            JSON.stringify(updated.constraints),
            updated.status,
            updated.provenance ? JSON.stringify(updated.provenance) : null,
            updated.version,
            updated.updated_at,
            id,
            this.namespace,
            expectedVersion,
          ]
        );

        if (res.changes !== 1) {
          throw new PcmError('VERSION_CONFLICT', `Project "${id}" concurrent update conflict`);
        }

        return {
          entity: updated,
          projectId: updated.id,
          summary: `Updated project "${updated.name}" (${updated.id}) to v${updated.version} (status=${updated.status})`,
          stateVersions: { [`project:${updated.id}`]: updated.version },
        };
      },
    });
  }

  // ==========================================================================
  // 5. Task / Task Maxer Operations (Create, Get, List, Update)
  // ==========================================================================

  private normalizeAcceptanceCriteria(raw: unknown): AcceptanceCriterion[] {
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw) || raw.length > MAX_ARRAY_ITEMS) {
      throw new PcmError(
        'INVALID_INPUT',
        `acceptance_criteria must be an array of at most ${MAX_ARRAY_ITEMS} items`
      );
    }
    return raw.map((item, idx) => {
      if (typeof item === 'string') {
        return {
          id: `ac_${idx + 1}`,
          description: assertNonEmptyString(
            item,
            `acceptance_criteria[${idx}]`,
            MAX_SHORT_TEXT_LENGTH
          ),
          mandatory: true,
          met: false,
        };
      }
      const obj = assertObject(item, `acceptance_criteria[${idx}]`);
      return {
        id:
          obj.id !== undefined
            ? assertNonEmptyString(obj.id, `acceptance_criteria[${idx}].id`, 128)
            : `ac_${idx + 1}`,
        description: assertNonEmptyString(
          obj.description,
          `acceptance_criteria[${idx}].description`,
          MAX_SHORT_TEXT_LENGTH
        ),
        mandatory: obj.mandatory !== undefined ? Boolean(obj.mandatory) : true,
        met: obj.met !== undefined ? Boolean(obj.met) : false,
        ...(obj.evidence_ref !== undefined
          ? {
              evidence_ref: assertNonEmptyString(
                obj.evidence_ref,
                `acceptance_criteria[${idx}].evidence_ref`,
                MAX_SHORT_TEXT_LENGTH
              ),
            }
          : {}),
      };
    });
  }

  private normalizeAssignments(raw: unknown): TaskAssignment[] {
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw) || raw.length > MAX_ARRAY_ITEMS) {
      throw new PcmError('INVALID_INPUT', 'assignments must be an array');
    }
    return raw.map((item, idx) => {
      if (typeof item === 'string') {
        return {
          worker_id: assertNonEmptyString(item, `assignments[${idx}]`, 128),
        };
      }
      const obj = assertObject(item, `assignments[${idx}]`);
      const workerId = obj.worker_id ?? obj.agent_or_worker_id ?? obj.assignee;
      return {
        worker_id: assertNonEmptyString(workerId, `assignments[${idx}].worker_id`, 128),
        ...(obj.role !== undefined
          ? { role: assertNonEmptyString(obj.role, `assignments[${idx}].role`, 128) }
          : {}),
        ...(obj.assigned_at !== undefined
          ? {
              assigned_at: assertNonEmptyString(
                obj.assigned_at,
                `assignments[${idx}].assigned_at`,
                64
              ),
            }
          : {}),
      };
    });
  }

  private normalizeOpenQuestions(raw: unknown): TaskOpenQuestion[] {
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw) || raw.length > MAX_ARRAY_ITEMS) {
      throw new PcmError('INVALID_INPUT', 'open_questions must be an array');
    }
    return raw.map((item, idx) => {
      if (typeof item === 'string') {
        return {
          id: `oq_${idx + 1}`,
          question: assertNonEmptyString(item, `open_questions[${idx}]`, MAX_SHORT_TEXT_LENGTH),
          resolved: false,
        };
      }
      const obj = assertObject(item, `open_questions[${idx}]`);
      return {
        id:
          obj.id !== undefined
            ? assertNonEmptyString(obj.id, `open_questions[${idx}].id`, 128)
            : `oq_${idx + 1}`,
        question: assertNonEmptyString(
          obj.question,
          `open_questions[${idx}].question`,
          MAX_SHORT_TEXT_LENGTH
        ),
        resolved: obj.resolved === true,
        ...(obj.resolution !== undefined && obj.resolution !== null
          ? {
              resolution: assertNonEmptyString(
                obj.resolution,
                `open_questions[${idx}].resolution`,
                MAX_SHORT_TEXT_LENGTH
              ),
            }
          : {}),
      };
    });
  }

  private normalizeBlockers(raw: unknown): TaskBlocker[] {
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw) || raw.length > MAX_ARRAY_ITEMS) {
      throw new PcmError('INVALID_INPUT', 'blockers must be an array');
    }
    return raw.map((item, idx) => {
      if (typeof item === 'string') {
        return {
          id: `blk_${idx + 1}`,
          description: assertNonEmptyString(item, `blockers[${idx}]`, MAX_SHORT_TEXT_LENGTH),
          resolved: false,
        };
      }
      const obj = assertObject(item, `blockers[${idx}]`);
      return {
        id:
          obj.id !== undefined
            ? assertNonEmptyString(obj.id, `blockers[${idx}].id`, 128)
            : `blk_${idx + 1}`,
        description: assertNonEmptyString(
          obj.description,
          `blockers[${idx}].description`,
          MAX_SHORT_TEXT_LENGTH
        ),
        resolved: obj.resolved === true,
        ...(obj.resolution !== undefined && obj.resolution !== null
          ? {
              resolution: assertNonEmptyString(
                obj.resolution,
                `blockers[${idx}].resolution`,
                MAX_SHORT_TEXT_LENGTH
              ),
            }
          : {}),
      };
    });
  }

  private validateConfirmedSpec(raw: unknown): Record<string, unknown> | string {
    if (typeof raw === 'string') {
      return assertNonEmptyString(raw, 'confirmed_specification', MAX_TEXT_LENGTH);
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (Object.keys(raw as Record<string, unknown>).length === 0) {
        throw new PcmError(
          'INVALID_INPUT',
          'confirmed_specification object must not be empty'
        );
      }
      return raw as Record<string, unknown>;
    }
    throw new PcmError(
      'INVALID_INPUT',
      'confirmed_specification is required and must be a non-empty string or object'
    );
  }

  public taskCreate(rawInput: Record<string, unknown>): MutationResult<TaskRecord> {
    const input = assertObject(rawInput, 'task_create');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'task_create');

    const title = assertNonEmptyString(input.title, 'title', MAX_SHORT_TEXT_LENGTH);
    const projectId = assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH);
    const initialRequestSummary = assertOptionalString(
      input.initial_request_summary,
      'initial_request_summary',
      MAX_TEXT_LENGTH
    );
    const confirmedSpecification = this.validateConfirmedSpec(input.confirmed_specification);
    const constraints = assertStringArray(input.constraints, 'constraints');
    const assumptions = assertStringArray(input.assumptions, 'assumptions');
    const acceptanceCriteria = this.normalizeAcceptanceCriteria(input.acceptance_criteria);
    const status =
      input.status !== undefined
        ? assertEnum(input.status, TASK_STATUS_VALUES, 'status')
        : 'draft';
    const priority =
      input.priority !== undefined
        ? assertEnum(input.priority, TASK_PRIORITY_VALUES, 'priority')
        : 'medium';
    const currentStage = assertOptionalString(
      input.current_stage,
      'current_stage',
      MAX_SHORT_TEXT_LENGTH
    );
    const assignments = this.normalizeAssignments(input.assignments);
    const dependencyRefs = assertStringArray(input.dependency_refs, 'dependency_refs');
    const openQuestions = this.normalizeOpenQuestions(input.open_questions);
    const blockers = this.normalizeBlockers(input.blockers);
    const verificationStatus =
      input.verification_status !== undefined
        ? assertEnum(input.verification_status, TASK_VERIFICATION_VALUES, 'verification_status')
        : 'not_started';
    const provenance = this.validateProvenance(input.provenance);

    if (status === 'completed') {
      validateTaskStatusTransition(
        'active',
        'completed',
        verificationStatus,
        acceptanceCriteria,
        blockers
      );
    }

    return this.executeWriteWithReceipt({
      operation: 'task_create',
      eventType: 'task.created',
      rawInput: input,
      mutate: (now) => {
        if (projectId) {
          this.assertEntityInNamespace('projects', projectId, 'Project');
        }

        const id =
          input.id !== undefined
            ? assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH)
            : this.newId('task');

        const existing = this.db.get('SELECT id FROM tasks WHERE id = ?', [id]);
        if (existing) {
          throw new PcmError('INVALID_INPUT', `Task with id "${id}" already exists`);
        }

        const record: TaskRecord = {
          id,
          namespace_id: this.namespace,
          project_id: projectId,
          title,
          initial_request_summary: initialRequestSummary,
          confirmed_specification: confirmedSpecification,
          constraints,
          assumptions,
          acceptance_criteria: acceptanceCriteria,
          status,
          priority,
          current_stage: currentStage,
          assignments,
          dependency_refs: dependencyRefs,
          open_questions: openQuestions,
          blockers,
          verification_status: verificationStatus,
          version: 1,
          provenance,
          created_at: now,
          updated_at: now,
        };

        this.db.run(
          `INSERT INTO tasks (
            id, namespace_id, project_id, title, initial_request_summary,
            confirmed_specification_json, constraints_json, assumptions_json,
            acceptance_criteria_json, status, priority, current_stage,
            assignments_json, dependency_refs_json, open_questions_json,
            blockers_json, verification_status, version, provenance_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.namespace_id,
            record.project_id,
            record.title,
            record.initial_request_summary,
            JSON.stringify(record.confirmed_specification),
            JSON.stringify(record.constraints),
            JSON.stringify(record.assumptions),
            JSON.stringify(record.acceptance_criteria),
            record.status,
            record.priority,
            record.current_stage,
            JSON.stringify(record.assignments),
            JSON.stringify(record.dependency_refs),
            JSON.stringify(record.open_questions),
            JSON.stringify(record.blockers),
            record.verification_status,
            record.version,
            record.provenance ? JSON.stringify(record.provenance) : null,
            record.created_at,
            record.updated_at,
          ]
        );

        return {
          entity: record,
          taskId: record.id,
          projectId: record.project_id,
          summary: `Created task "${record.title}" (${record.id}) v1 [status=${record.status}]`,
          stateVersions: { [`task:${record.id}`]: record.version },
        };
      },
    });
  }

  public taskGet(rawInput: Record<string, unknown>): TaskRecord {
    const input = assertObject(rawInput, 'task_get');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const id = assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH);

    this.assertEntityInNamespace('tasks', id, 'Task');
    const row = this.db.get('SELECT * FROM tasks WHERE id = ? AND namespace_id = ?', [
      id,
      this.namespace,
    ]);
    if (!row) {
      throw new PcmError('NOT_FOUND', `Task "${id}" not found`);
    }
    return mapTaskRow(row);
  }

  public taskList(rawInput: Record<string, unknown> = {}): PaginatedResult<TaskRecord> {
    const input = assertObject(rawInput, 'task_list');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const { limit, offset } = validatePagination(input);

    const projectId = assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH);
    const status =
      input.status !== undefined ? assertEnum(input.status, TASK_STATUS_VALUES, 'status') : null;
    const priority =
      input.priority !== undefined
        ? assertEnum(input.priority, TASK_PRIORITY_VALUES, 'priority')
        : null;

    const whereClauses = ['namespace_id = ?'];
    const params: unknown[] = [this.namespace];

    if (projectId) {
      whereClauses.push('project_id = ?');
      params.push(projectId);
    }
    if (status) {
      whereClauses.push('status = ?');
      params.push(status);
    }
    if (priority) {
      whereClauses.push('priority = ?');
      params.push(priority);
    }

    const whereSql = whereClauses.join(' AND ');
    const countRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM tasks WHERE ${whereSql}`,
      params
    );
    const totalCount = countRow ? Number(countRow.cnt) : 0;

    const rows = this.db.all(
      `SELECT * FROM tasks WHERE ${whereSql} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const items = rows.map(mapTaskRow);
    return {
      items,
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  public taskUpdate(rawInput: Record<string, unknown>): MutationResult<TaskRecord> {
    const input = assertObject(rawInput, 'task_update');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'task_update');

    const id = assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH);
    const expectedVersion = assertExpectedVersion(input.expected_version);

    return this.executeWriteWithReceipt({
      operation: 'task_update',
      eventType: 'task.updated',
      rawInput: input,
      mutate: (now) => {
        this.assertEntityInNamespace('tasks', id, 'Task');
        const row = this.db.get('SELECT * FROM tasks WHERE id = ? AND namespace_id = ?', [
          id,
          this.namespace,
        ]);
        if (!row) {
          throw new PcmError('NOT_FOUND', `Task "${id}" not found`);
        }
        const current = mapTaskRow(row);
        if (current.version !== expectedVersion) {
          throw new PcmError(
            'VERSION_CONFLICT',
            `Task "${id}" version conflict: expected_version=${expectedVersion}, actual_version=${current.version}`,
            { id, expected_version: expectedVersion, actual_version: current.version }
          );
        }

        const nextProjectId =
          input.project_id !== undefined
            ? assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH)
            : current.project_id;
        if (nextProjectId) {
          this.assertEntityInNamespace('projects', nextProjectId, 'Project');
        }

        const nextAcceptanceCriteria =
          input.acceptance_criteria !== undefined
            ? this.normalizeAcceptanceCriteria(input.acceptance_criteria)
            : current.acceptance_criteria;

        // Rule: Never silently discard blockers, dependencies, or unresolved questions.
        let nextBlockers = current.blockers;
        if (input.blockers !== undefined) {
          nextBlockers = this.normalizeBlockers(input.blockers);
          const nextBlockerMap = new Map(nextBlockers.map((b) => [b.id, b]));
          for (const existingBlocker of current.blockers) {
            if (!existingBlocker.resolved && !nextBlockerMap.has(existingBlocker.id)) {
              throw new PcmError(
                'INVALID_INPUT',
                `Cannot silently discard unresolved blocker "${existingBlocker.id}". Resolve it explicitly (resolved=true) rather than omitting it.`,
                { blocker_id: existingBlocker.id, reason: 'UNRESOLVED_BLOCKER_DISCARDED' }
              );
            }
          }
        }

        let nextOpenQuestions = current.open_questions;
        if (input.open_questions !== undefined) {
          nextOpenQuestions = this.normalizeOpenQuestions(input.open_questions);
          const nextQuestionMap = new Map(nextOpenQuestions.map((q) => [q.id, q]));
          for (const existingQ of current.open_questions) {
            if (!existingQ.resolved && !nextQuestionMap.has(existingQ.id)) {
              throw new PcmError(
                'INVALID_INPUT',
                `Cannot silently discard unresolved open question "${existingQ.id}". Mark resolved=true with a resolution rather than omitting it.`,
                { question_id: existingQ.id, reason: 'UNRESOLVED_QUESTION_DISCARDED' }
              );
            }
          }
        }

        let nextDependencyRefs = current.dependency_refs;
        if (input.dependency_refs !== undefined) {
          nextDependencyRefs = assertStringArray(input.dependency_refs, 'dependency_refs');
          if (input.allow_dependency_removal !== true) {
            const nextDepSet = new Set(nextDependencyRefs);
            for (const existingDep of current.dependency_refs) {
              if (!nextDepSet.has(existingDep)) {
                throw new PcmError(
                  'INVALID_INPUT',
                  `Cannot silently discard dependency "${existingDep}" without explicit allow_dependency_removal=true`,
                  { dependency_ref: existingDep, reason: 'DEPENDENCY_DISCARDED' }
                );
              }
            }
          }
        }

        const nextStatus =
          input.status !== undefined
            ? assertEnum(input.status, TASK_STATUS_VALUES, 'status')
            : current.status;
        const nextVerificationStatus =
          input.verification_status !== undefined
            ? assertEnum(
                input.verification_status,
                TASK_VERIFICATION_VALUES,
                'verification_status'
              )
            : current.verification_status;

        validateTaskStatusTransition(
          current.status,
          nextStatus,
          nextVerificationStatus,
          nextAcceptanceCriteria,
          nextBlockers
        );

        const updated: TaskRecord = {
          ...current,
          project_id: nextProjectId,
          title:
            input.title !== undefined
              ? assertNonEmptyString(input.title, 'title', MAX_SHORT_TEXT_LENGTH)
              : current.title,
          initial_request_summary:
            input.initial_request_summary !== undefined
              ? assertOptionalString(
                  input.initial_request_summary,
                  'initial_request_summary',
                  MAX_TEXT_LENGTH
                )
              : current.initial_request_summary,
          confirmed_specification:
            input.confirmed_specification !== undefined
              ? this.validateConfirmedSpec(input.confirmed_specification)
              : current.confirmed_specification,
          constraints:
            input.constraints !== undefined
              ? assertStringArray(input.constraints, 'constraints')
              : current.constraints,
          assumptions:
            input.assumptions !== undefined
              ? assertStringArray(input.assumptions, 'assumptions')
              : current.assumptions,
          acceptance_criteria: nextAcceptanceCriteria,
          status: nextStatus,
          priority:
            input.priority !== undefined
              ? assertEnum(input.priority, TASK_PRIORITY_VALUES, 'priority')
              : current.priority,
          current_stage:
            input.current_stage !== undefined
              ? assertOptionalString(input.current_stage, 'current_stage', MAX_SHORT_TEXT_LENGTH)
              : current.current_stage,
          assignments:
            input.assignments !== undefined
              ? this.normalizeAssignments(input.assignments)
              : current.assignments,
          dependency_refs: nextDependencyRefs,
          open_questions: nextOpenQuestions,
          blockers: nextBlockers,
          verification_status: nextVerificationStatus,
          provenance:
            input.provenance !== undefined
              ? this.validateProvenance(input.provenance)
              : current.provenance,
          version: current.version + 1,
          updated_at: now,
        };

        const res = this.db.run(
          `UPDATE tasks
           SET project_id = ?,
               title = ?,
               initial_request_summary = ?,
               confirmed_specification_json = ?,
               constraints_json = ?,
               assumptions_json = ?,
               acceptance_criteria_json = ?,
               status = ?,
               priority = ?,
               current_stage = ?,
               assignments_json = ?,
               dependency_refs_json = ?,
               open_questions_json = ?,
               blockers_json = ?,
               verification_status = ?,
               provenance_json = ?,
               version = ?,
               updated_at = ?
           WHERE id = ? AND namespace_id = ? AND version = ?`,
          [
            updated.project_id,
            updated.title,
            updated.initial_request_summary,
            JSON.stringify(updated.confirmed_specification),
            JSON.stringify(updated.constraints),
            JSON.stringify(updated.assumptions),
            JSON.stringify(updated.acceptance_criteria),
            updated.status,
            updated.priority,
            updated.current_stage,
            JSON.stringify(updated.assignments),
            JSON.stringify(updated.dependency_refs),
            JSON.stringify(updated.open_questions),
            JSON.stringify(updated.blockers),
            updated.verification_status,
            updated.provenance ? JSON.stringify(updated.provenance) : null,
            updated.version,
            updated.updated_at,
            id,
            this.namespace,
            expectedVersion,
          ]
        );

        if (res.changes !== 1) {
          throw new PcmError('VERSION_CONFLICT', `Task "${id}" concurrent update conflict`);
        }

        return {
          entity: updated,
          taskId: updated.id,
          projectId: updated.project_id,
          summary: `Updated task "${updated.title}" (${updated.id}) v${current.version}->v${updated.version} [status=${current.status}->${updated.status}, verification=${updated.verification_status}]`,
          stateVersions: { [`task:${updated.id}`]: updated.version },
        };
      },
    });
  }

  // ==========================================================================
  // 6. Structured Decisions (Append, List)
  // ==========================================================================

  public decisionAppend(rawInput: Record<string, unknown>): MutationResult<DecisionRecord> {
    const input = assertObject(rawInput, 'decision_append');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'decision_append');

    const taskId = assertNonEmptyString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    const stateVersionObserved = assertExpectedVersion(
      input.state_version_observed,
      'state_version_observed'
    );
    if (stateVersionObserved < 1) {
      throw new PcmError('INVALID_INPUT', 'state_version_observed must be >= 1');
    }
    const objective = assertNonEmptyString(input.objective, 'objective', MAX_TEXT_LENGTH);

    if (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > 50) {
      throw new PcmError('INVALID_INPUT', 'options must be a non-empty array (1..50 items)');
    }

    const optionIds = new Set<string>();
    const options: DecisionOption[] = input.options.map((rawOpt, idx) => {
      const opt = assertObject(rawOpt, `options[${idx}]`);
      const optionId = assertNonEmptyString(opt.option_id, `options[${idx}].option_id`, 128);
      if (optionIds.has(optionId)) {
        throw new PcmError('INVALID_INPUT', `Duplicate option_id "${optionId}" in decision options`);
      }
      optionIds.add(optionId);

      const description = assertNonEmptyString(
        opt.description,
        `options[${idx}].description`,
        MAX_TEXT_LENGTH
      );
      const selectionProbability = assertUnitInterval(
        opt.selection_probability,
        `options[${idx}].selection_probability`
      );
      const suitabilityScore = assertUnitInterval(
        opt.suitability_score,
        `options[${idx}].suitability_score`
      );
      const routeStatus = assertOptionalString(
        opt.route_status,
        `options[${idx}].route_status`,
        128
      );
      const evidenceRefs = assertStringArray(
        opt.evidence_refs,
        `options[${idx}].evidence_refs`
      );

      // Never invent scores or evidence: preserve null when omitted
      return {
        option_id: optionId,
        description,
        selection_probability: selectionProbability,
        suitability_score: suitabilityScore,
        route_status: routeStatus,
        evidence_refs: evidenceRefs,
      };
    });

    const chosenOption = assertNonEmptyString(input.chosen_option, 'chosen_option', 128);
    if (!optionIds.has(chosenOption)) {
      throw new PcmError(
        'INVALID_INPUT',
        `chosen_option "${chosenOption}" must match one of the provided options[].option_id`,
        { chosen_option: chosenOption, available_option_ids: Array.from(optionIds) }
      );
    }

    const selectionBasis = assertOptionalString(
      input.selection_basis,
      'selection_basis',
      MAX_TEXT_LENGTH
    );
    const assessmentConfidence = assertUnitInterval(
      input.assessment_confidence,
      'assessment_confidence'
    );
    const escalation = assertOptionalString(input.escalation, 'escalation', MAX_TEXT_LENGTH);
    const evidenceRefs = assertStringArray(input.evidence_refs, 'evidence_refs');
    const provenance = this.validateProvenance(input.provenance);

    return this.executeWriteWithReceipt({
      operation: 'decision_append',
      eventType: 'decision.recorded',
      rawInput: input,
      mutate: (now) => {
        this.assertEntityInNamespace('tasks', taskId, 'Task');
        const taskRow = this.db.get<{ project_id: string | null; version: number }>(
          'SELECT project_id, version FROM tasks WHERE id = ? AND namespace_id = ?',
          [taskId, this.namespace]
        );

        const id =
          input.id !== undefined
            ? assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH)
            : this.newId('dec');

        const record: DecisionRecord = {
          id,
          namespace_id: this.namespace,
          task_id: taskId,
          state_version_observed: stateVersionObserved,
          objective,
          options,
          chosen_option: chosenOption,
          selection_basis: selectionBasis,
          assessment_confidence: assessmentConfidence,
          escalation,
          evidence_refs: evidenceRefs,
          provenance,
          created_at: now,
        };

        this.db.run(
          `INSERT INTO decisions (
            id, namespace_id, task_id, state_version_observed, objective,
            options_json, chosen_option, selection_basis, assessment_confidence,
            escalation, evidence_refs_json, provenance_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.namespace_id,
            record.task_id,
            record.state_version_observed,
            record.objective,
            JSON.stringify(record.options),
            record.chosen_option,
            record.selection_basis,
            record.assessment_confidence,
            record.escalation,
            JSON.stringify(record.evidence_refs),
            record.provenance ? JSON.stringify(record.provenance) : null,
            record.created_at,
          ]
        );

        return {
          entity: record,
          taskId: record.task_id,
          projectId: taskRow?.project_id ?? null,
          summary: `Recorded decision ${record.id} for task ${record.task_id}: chose "${record.chosen_option}"`,
          evidenceRefs: record.evidence_refs,
          stateVersions: {
            [`task:${record.task_id}:observed`]: record.state_version_observed,
          },
        };
      },
    });
  }

  public decisionList(rawInput: Record<string, unknown>): PaginatedResult<DecisionRecord> {
    const input = assertObject(rawInput, 'decision_list');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const { limit, offset } = validatePagination(input);
    const taskId = assertNonEmptyString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);

    this.assertEntityInNamespace('tasks', taskId, 'Task');

    const countRow = this.db.get<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM decisions WHERE namespace_id = ? AND task_id = ?',
      [this.namespace, taskId]
    );
    const totalCount = countRow ? Number(countRow.cnt) : 0;

    const rows = this.db.all(
      `SELECT * FROM decisions
       WHERE namespace_id = ? AND task_id = ?
       ORDER BY created_at DESC, id ASC
       LIMIT ? OFFSET ?`,
      [this.namespace, taskId, limit, offset]
    );

    const items = rows.map(mapDecisionRow);
    return {
      items,
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  // ==========================================================================
  // 7. Artifacts (Register, List)
  // ==========================================================================

  public artifactRegister(rawInput: Record<string, unknown>): MutationResult<ArtifactRecord> {
    const input = assertObject(rawInput, 'artifact_register');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'artifact_register');

    const taskId = assertOptionalString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    const projectId = assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH);
    if (!taskId && !projectId) {
      throw new PcmError(
        'INVALID_INPUT',
        'Artifact registration requires at least one of task_id or project_id'
      );
    }

    const name = assertNonEmptyString(input.name, 'name', MAX_SHORT_TEXT_LENGTH);
    const description = assertOptionalString(input.description, 'description', MAX_TEXT_LENGTH);
    const type = assertNonEmptyString(input.type, 'type', 128);
    const rawRef = assertNonEmptyString(
      input.relative_path_or_external_reference,
      'relative_path_or_external_reference',
      MAX_POINTER_TEXT_LENGTH
    );

    const { normalizedRef } = validateArtifactReference(rawRef, this.config.artifactRoot);

    const mimeType = assertOptionalString(input.mime_type, 'mime_type', 128);
    let sizeBytes: number | null = null;
    if (input.size_bytes !== undefined && input.size_bytes !== null) {
      if (
        typeof input.size_bytes !== 'number' ||
        !Number.isInteger(input.size_bytes) ||
        input.size_bytes < 0
      ) {
        throw new PcmError('INVALID_INPUT', 'size_bytes must be a non-negative integer');
      }
      sizeBytes = input.size_bytes;
    }
    const checksum = assertOptionalString(input.checksum, 'checksum', 256);
    const provenance = this.validateProvenance(input.provenance);

    // Rule: Registration is not verification. Default to 'unverified'.
    const verificationStatus =
      input.verification_status !== undefined
        ? assertEnum(
            input.verification_status,
            ARTIFACT_VERIFICATION_VALUES,
            'verification_status'
          )
        : 'unverified';

    return this.executeWriteWithReceipt({
      operation: 'artifact_register',
      eventType: 'artifact.registered',
      rawInput: input,
      mutate: (now) => {
        if (taskId) {
          this.assertEntityInNamespace('tasks', taskId, 'Task');
        }
        if (projectId) {
          this.assertEntityInNamespace('projects', projectId, 'Project');
        }

        const id =
          input.id !== undefined
            ? assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH)
            : this.newId('art');

        const record: ArtifactRecord = {
          id,
          namespace_id: this.namespace,
          task_id: taskId,
          project_id: projectId,
          name,
          description,
          type,
          relative_path_or_external_reference: normalizedRef,
          mime_type: mimeType,
          size_bytes: sizeBytes,
          checksum,
          provenance,
          verification_status: verificationStatus,
          created_at: now,
        };

        this.db.run(
          `INSERT INTO artifacts (
            id, namespace_id, task_id, project_id, name, description, type,
            relative_path_or_external_reference, mime_type, size_bytes,
            checksum, provenance_json, verification_status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.namespace_id,
            record.task_id,
            record.project_id,
            record.name,
            record.description,
            record.type,
            record.relative_path_or_external_reference,
            record.mime_type,
            record.size_bytes,
            record.checksum,
            record.provenance ? JSON.stringify(record.provenance) : null,
            record.verification_status,
            record.created_at,
          ]
        );

        return {
          entity: record,
          taskId: record.task_id,
          projectId: record.project_id,
          summary: `Registered artifact "${record.name}" (${record.id}) [verification_status=${record.verification_status}]`,
          artifactRefs: [record.id],
        };
      },
    });
  }

  public artifactList(rawInput: Record<string, unknown> = {}): PaginatedResult<ArtifactRecord> {
    const input = assertObject(rawInput, 'artifact_list');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const { limit, offset } = validatePagination(input);

    const taskId = assertOptionalString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    const projectId = assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH);

    const whereClauses = ['namespace_id = ?'];
    const params: unknown[] = [this.namespace];

    if (taskId) {
      whereClauses.push('task_id = ?');
      params.push(taskId);
    }
    if (projectId) {
      whereClauses.push('project_id = ?');
      params.push(projectId);
    }

    const whereSql = whereClauses.join(' AND ');
    const countRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM artifacts WHERE ${whereSql}`,
      params
    );
    const totalCount = countRow ? Number(countRow.cnt) : 0;

    const rows = this.db.all(
      `SELECT * FROM artifacts WHERE ${whereSql} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const items = rows.map(mapArtifactRow);
    return {
      items,
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  // ==========================================================================
  // 8. Runtime Routes (Append, List)
  // ==========================================================================

  public runtimeRouteAppend(
    rawInput: Record<string, unknown>
  ): MutationResult<RuntimeRouteRecord> {
    const input = assertObject(rawInput, 'runtime_route_append');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'runtime_route_append');

    const taskId = assertNonEmptyString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    const routeSummary = assertNonEmptyString(
      input.route_summary,
      'route_summary',
      MAX_TEXT_LENGTH
    );
    const status = assertEnum(input.status, RUNTIME_ROUTE_STATUS_VALUES, 'status');
    const assessmentConfidence = assertUnitInterval(
      input.assessment_confidence,
      'assessment_confidence'
    );
    const selectionProbability = assertUnitInterval(
      input.selection_probability,
      'selection_probability'
    );
    const suitabilityScore = assertUnitInterval(input.suitability_score, 'suitability_score');
    const observations = assertStringArray(
      input.observations,
      'observations',
      MAX_ARRAY_ITEMS,
      MAX_TEXT_LENGTH
    );
    const evidenceRefs = assertStringArray(input.evidence_refs, 'evidence_refs');
    const nextAction = assertOptionalString(input.next_action, 'next_action', MAX_TEXT_LENGTH);

    return this.executeWriteWithReceipt({
      operation: 'runtime_route_append',
      eventType: 'runtime_route.recorded',
      rawInput: input,
      mutate: (now) => {
        this.assertEntityInNamespace('tasks', taskId, 'Task');
        const taskRow = this.db.get<{ project_id: string | null }>(
          'SELECT project_id FROM tasks WHERE id = ? AND namespace_id = ?',
          [taskId, this.namespace]
        );

        const id =
          input.id !== undefined
            ? assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH)
            : this.newId('route');

        const record: RuntimeRouteRecord = {
          id,
          namespace_id: this.namespace,
          task_id: taskId,
          route_summary: routeSummary,
          status,
          assessment_confidence: assessmentConfidence,
          selection_probability: selectionProbability,
          suitability_score: suitabilityScore,
          observations,
          evidence_refs: evidenceRefs,
          next_action: nextAction,
          created_at: now,
        };

        this.db.run(
          `INSERT INTO runtime_routes (
            id, namespace_id, task_id, route_summary, status,
            assessment_confidence, selection_probability, suitability_score,
            observations_json, evidence_refs_json, next_action, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.namespace_id,
            record.task_id,
            record.route_summary,
            record.status,
            record.assessment_confidence,
            record.selection_probability,
            record.suitability_score,
            JSON.stringify(record.observations),
            JSON.stringify(record.evidence_refs),
            record.next_action,
            record.created_at,
          ]
        );

        return {
          entity: record,
          taskId: record.task_id,
          projectId: taskRow?.project_id ?? null,
          summary: `Recorded runtime route ${record.id} for task ${record.task_id} [status=${record.status}]`,
          evidenceRefs: record.evidence_refs,
        };
      },
    });
  }

  public runtimeRouteList(
    rawInput: Record<string, unknown>
  ): PaginatedResult<RuntimeRouteRecord> {
    const input = assertObject(rawInput, 'runtime_route_list');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const { limit, offset } = validatePagination(input);
    const taskId = assertNonEmptyString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    const status =
      input.status !== undefined
        ? assertEnum(input.status, RUNTIME_ROUTE_STATUS_VALUES, 'status')
        : null;

    this.assertEntityInNamespace('tasks', taskId, 'Task');

    const whereClauses = ['namespace_id = ?', 'task_id = ?'];
    const params: unknown[] = [this.namespace, taskId];
    if (status) {
      whereClauses.push('status = ?');
      params.push(status);
    }

    const whereSql = whereClauses.join(' AND ');
    const countRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM runtime_routes WHERE ${whereSql}`,
      params
    );
    const totalCount = countRow ? Number(countRow.cnt) : 0;

    const rows = this.db.all(
      `SELECT * FROM runtime_routes WHERE ${whereSql} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const items = rows.map(mapRuntimeRouteRow);
    return {
      items,
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  // ==========================================================================
  // 9. Capability Observations (Record, Get with Freshness Labels)
  // ==========================================================================

  private attachFreshness(
    record: CapabilityObservationRecord,
    evaluatedAtIso: string
  ): CapabilityObservationRecord {
    const evalMs = Date.parse(evaluatedAtIso);
    const measuredMs = Date.parse(record.measured_at);
    const ageSeconds = Number.isFinite(measuredMs)
      ? Math.max(0, Math.round((evalMs - measuredMs) / 1000))
      : 0;

    let isStale = false;
    let status: 'fresh' | 'stale' | 'expired' = 'fresh';

    if (record.valid_until) {
      const validUntilMs = Date.parse(record.valid_until);
      if (Number.isFinite(validUntilMs) && evalMs > validUntilMs) {
        isStale = true;
        status = 'expired';
      }
    }

    if (!isStale) {
      const thresholdSec = DEFAULT_STALE_THRESHOLDS_SECONDS[record.kind] ?? 3600;
      if (ageSeconds > thresholdSec) {
        isStale = true;
        status = 'stale';
      }
    }

    return {
      ...record,
      freshness: {
        is_stale: isStale,
        status,
        age_seconds: ageSeconds,
        evaluated_at: evaluatedAtIso,
      },
    };
  }

  public capabilityObservationRecord(
    rawInput: Record<string, unknown>
  ): MutationResult<CapabilityObservationRecord> {
    const input = assertObject(rawInput, 'capability_observation_record');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'capability_observation_record');

    const machineOrRuntimeId = assertNonEmptyString(
      input.machine_or_runtime_id,
      'machine_or_runtime_id',
      MAX_SHORT_TEXT_LENGTH
    );
    const kind = assertEnum(input.kind, CAPABILITY_OBSERVATION_KINDS, 'kind');
    const backend = assertOptionalString(input.backend, 'backend', 128);
    const observations = assertObject(input.observations, 'observations');
    if (Object.keys(observations).length === 0) {
      throw new PcmError('INVALID_INPUT', 'observations object must not be empty');
    }
    const measurementMethod = assertOptionalString(
      input.measurement_method,
      'measurement_method',
      MAX_SHORT_TEXT_LENGTH
    );
    const measuredAt = assertNonEmptyString(input.measured_at, 'measured_at', 64);
    if (Number.isNaN(Date.parse(measuredAt))) {
      throw new PcmError('INVALID_INPUT', 'measured_at must be a valid ISO-8601 timestamp');
    }
    const validUntil = assertOptionalString(input.valid_until, 'valid_until', 64);
    if (validUntil && Number.isNaN(Date.parse(validUntil))) {
      throw new PcmError('INVALID_INPUT', 'valid_until must be a valid ISO-8601 timestamp');
    }
    const sourceReceiptId = assertOptionalString(
      input.source_receipt_id,
      'source_receipt_id',
      MAX_SHORT_TEXT_LENGTH
    );

    return this.executeWriteWithReceipt({
      operation: 'capability_observation_record',
      eventType: 'capability_observation.recorded',
      rawInput: input,
      mutate: (now) => {
        if (sourceReceiptId) {
          this.assertEntityInNamespace('receipts', sourceReceiptId, 'Receipt');
        }

        const id =
          input.id !== undefined
            ? assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH)
            : this.newId('cap');

        const baseRecord: CapabilityObservationRecord = {
          id,
          namespace_id: this.namespace,
          machine_or_runtime_id: machineOrRuntimeId,
          kind,
          backend,
          observations,
          measurement_method: measurementMethod,
          measured_at: measuredAt,
          valid_until: validUntil,
          source_receipt_id: sourceReceiptId,
          created_at: now,
        };

        this.db.run(
          `INSERT INTO capability_observations (
            id, namespace_id, machine_or_runtime_id, kind, backend,
            observations_json, measurement_method, measured_at,
            valid_until, source_receipt_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            baseRecord.id,
            baseRecord.namespace_id,
            baseRecord.machine_or_runtime_id,
            baseRecord.kind,
            baseRecord.backend,
            JSON.stringify(baseRecord.observations),
            baseRecord.measurement_method,
            baseRecord.measured_at,
            baseRecord.valid_until,
            baseRecord.source_receipt_id,
            baseRecord.created_at,
          ]
        );

        const withFreshness = this.attachFreshness(baseRecord, now);
        return {
          entity: withFreshness,
          summary: `Recorded supplied ${baseRecord.kind} observation ${baseRecord.id} for runtime "${baseRecord.machine_or_runtime_id}"`,
        };
      },
    });
  }

  public capabilityObservationGet(
    rawInput: Record<string, unknown> = {}
  ): PaginatedResult<CapabilityObservationRecord> {
    const input = assertObject(rawInput, 'capability_observation_get');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const { limit, offset } = validatePagination(input);

    const machineOrRuntimeId = assertOptionalString(
      input.machine_or_runtime_id,
      'machine_or_runtime_id',
      MAX_SHORT_TEXT_LENGTH
    );
    const kind =
      input.kind !== undefined
        ? assertEnum(input.kind, CAPABILITY_OBSERVATION_KINDS, 'kind')
        : null;
    const backend = assertOptionalString(input.backend, 'backend', 128);
    const evaluatedAt =
      assertOptionalString(input.as_of, 'as_of', 64) ?? this.nowIso();

    const whereClauses = ['namespace_id = ?'];
    const params: unknown[] = [this.namespace];

    if (machineOrRuntimeId) {
      whereClauses.push('machine_or_runtime_id = ?');
      params.push(machineOrRuntimeId);
    }
    if (kind) {
      whereClauses.push('kind = ?');
      params.push(kind);
    }
    if (backend) {
      whereClauses.push('backend = ?');
      params.push(backend);
    }

    const whereSql = whereClauses.join(' AND ');
    const countRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM capability_observations WHERE ${whereSql}`,
      params
    );
    const totalCount = countRow ? Number(countRow.cnt) : 0;

    const rows = this.db.all(
      `SELECT * FROM capability_observations
       WHERE ${whereSql}
       ORDER BY measured_at DESC, id ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const items = rows.map((r) =>
      this.attachFreshness(mapCapabilityObservationRow(r), evaluatedAt)
    );
    return {
      items,
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  // ==========================================================================
  // 10. Operational Receipts (Append, Search)
  // ==========================================================================

  public receiptAppend(rawInput: Record<string, unknown>): ReceiptRecord {
    const input = assertObject(rawInput, 'receipt_append');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'receipt_append');

    const taskId = assertOptionalString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    const projectId = assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH);
    const correlationId = assertOptionalString(
      input.correlation_id,
      'correlation_id',
      MAX_SHORT_TEXT_LENGTH
    );
    const idempotencyKey = assertOptionalString(
      input.idempotency_key,
      'idempotency_key',
      MAX_SHORT_TEXT_LENGTH
    );
    const eventType = assertNonEmptyString(input.event_type, 'event_type', 128);
    const operation = assertNonEmptyString(input.operation, 'operation', 128);
    const actorAttribution = assertOptionalString(
      input.actor_attribution,
      'actor_attribution',
      MAX_SHORT_TEXT_LENGTH
    );
    const outcome = assertEnum(input.outcome, RECEIPT_OUTCOME_VALUES, 'outcome');
    const summary = assertNonEmptyString(input.summary, 'summary', MAX_TEXT_LENGTH);
    const evidenceRefs = assertStringArray(input.evidence_refs, 'evidence_refs');
    const artifactRefs = assertStringArray(input.artifact_refs, 'artifact_refs');

    let stateVersions: Record<string, number> | null = null;
    if (input.state_versions !== undefined && input.state_versions !== null) {
      const svObj = assertObject(input.state_versions, 'state_versions');
      stateVersions = {};
      for (const [k, v] of Object.entries(svObj)) {
        if (typeof v !== 'number' || !Number.isInteger(v)) {
          throw new PcmError('INVALID_INPUT', `state_versions["${k}"] must be an integer`);
        }
        stateVersions[k] = v;
      }
    }

    let metadata: Record<string, unknown> | null = null;
    if (input.metadata !== undefined && input.metadata !== null) {
      metadata = redactSecrets(assertObject(input.metadata, 'metadata'));
    }

    const payloadHash = idempotencyKey ? computePayloadHash('receipt_append', input) : null;

    return this.db.transaction(() => {
      if (idempotencyKey && payloadHash) {
        const existingKey = this.db.get<{
          operation: string;
          payload_hash: string;
          response_json: string;
        }>(
          `SELECT operation, payload_hash, response_json
           FROM idempotency_keys
           WHERE namespace_id = ? AND idempotency_key = ?`,
          [this.namespace, idempotencyKey]
        );
        if (existingKey) {
          if (
            existingKey.operation !== 'receipt_append' ||
            existingKey.payload_hash !== payloadHash
          ) {
            throw new PcmError(
              'DUPLICATE_IDEMPOTENCY_KEY',
              `Idempotency key "${idempotencyKey}" already used with different payload`
            );
          }
          return JSON.parse(existingKey.response_json) as ReceiptRecord;
        }
      }

      if (taskId) {
        this.assertEntityInNamespace('tasks', taskId, 'Task');
      }
      if (projectId) {
        this.assertEntityInNamespace('projects', projectId, 'Project');
      }

      const id =
        input.id !== undefined
          ? assertNonEmptyString(input.id, 'id', MAX_SHORT_TEXT_LENGTH)
          : this.newId('rcpt');
      const now = this.nowIso();

      const record: ReceiptRecord = {
        id,
        namespace_id: this.namespace,
        task_id: taskId,
        project_id: projectId,
        correlation_id: correlationId,
        idempotency_key: idempotencyKey,
        event_type: eventType,
        operation,
        actor_attribution: actorAttribution,
        timestamp: now,
        outcome,
        summary: redactSecrets(summary),
        evidence_refs: evidenceRefs,
        artifact_refs: artifactRefs,
        state_versions: stateVersions,
        metadata,
      };

      this.db.run(
        `INSERT INTO receipts (
          id, namespace_id, task_id, project_id, correlation_id, idempotency_key,
          event_type, operation, actor_attribution, timestamp, outcome, summary,
          evidence_refs_json, artifact_refs_json, state_versions_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.namespace_id,
          record.task_id,
          record.project_id,
          record.correlation_id,
          record.idempotency_key,
          record.event_type,
          record.operation,
          record.actor_attribution,
          record.timestamp,
          record.outcome,
          record.summary,
          JSON.stringify(record.evidence_refs),
          JSON.stringify(record.artifact_refs),
          record.state_versions ? JSON.stringify(record.state_versions) : null,
          record.metadata ? JSON.stringify(record.metadata) : null,
        ]
      );

      if (idempotencyKey && payloadHash) {
        this.db.run(
          `INSERT INTO idempotency_keys (
            namespace_id, idempotency_key, operation, payload_hash, receipt_id, response_json, created_at
          ) VALUES (?, ?, 'receipt_append', ?, ?, ?, ?)`,
          [this.namespace, idempotencyKey, payloadHash, record.id, JSON.stringify(record), now]
        );
      }

      return record;
    });
  }

  public receiptSearch(rawInput: Record<string, unknown> = {}): PaginatedResult<ReceiptRecord> {
    const input = assertObject(rawInput, 'receipt_search');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const { limit, offset } = validatePagination(input);

    const taskId = assertOptionalString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    const projectId = assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH);
    const operation = assertOptionalString(input.operation, 'operation', 128);
    const eventType = assertOptionalString(input.event_type, 'event_type', 128);
    const outcome =
      input.outcome !== undefined
        ? assertEnum(input.outcome, RECEIPT_OUTCOME_VALUES, 'outcome')
        : null;
    const correlationId = assertOptionalString(
      input.correlation_id,
      'correlation_id',
      MAX_SHORT_TEXT_LENGTH
    );

    const whereClauses = ['namespace_id = ?'];
    const params: unknown[] = [this.namespace];

    if (taskId) {
      whereClauses.push('task_id = ?');
      params.push(taskId);
    }
    if (projectId) {
      whereClauses.push('project_id = ?');
      params.push(projectId);
    }
    if (operation) {
      whereClauses.push('operation = ?');
      params.push(operation);
    }
    if (eventType) {
      whereClauses.push('event_type = ?');
      params.push(eventType);
    }
    if (outcome) {
      whereClauses.push('outcome = ?');
      params.push(outcome);
    }
    if (correlationId) {
      whereClauses.push('correlation_id = ?');
      params.push(correlationId);
    }

    const whereSql = whereClauses.join(' AND ');
    const countRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM receipts WHERE ${whereSql}`,
      params
    );
    const totalCount = countRow ? Number(countRow.cnt) : 0;

    const rows = this.db.all(
      `SELECT * FROM receipts WHERE ${whereSql} ORDER BY timestamp DESC, id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const items = rows.map(mapReceiptRow);
    return {
      items,
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  // ==========================================================================
  // 11. Knowledge Navigation (Get / Update / Combined Get-Update)
  // ==========================================================================

  public knowledgeNavigationGet(
    rawInput: Record<string, unknown>
  ): KnowledgeNavigationRecord | null {
    const input = assertObject(rawInput, 'knowledge_navigation_get');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const taskId = assertNonEmptyString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);

    this.assertEntityInNamespace('tasks', taskId, 'Task');

    const row = this.db.get(
      'SELECT * FROM knowledge_navigation WHERE namespace_id = ? AND task_id = ?',
      [this.namespace, taskId]
    );
    return row ? mapKnowledgeNavigationRow(row) : null;
  }

  public knowledgeNavigationUpdate(
    rawInput: Record<string, unknown>
  ): MutationResult<KnowledgeNavigationRecord> {
    const input = assertObject(rawInput, 'knowledge_navigation_update');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    assertNoSecrets(input, 'knowledge_navigation_update');

    const taskId = assertNonEmptyString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    const expectedVersion = assertExpectedVersion(input.expected_version);

    const domain = assertNonEmptyString(input.domain, 'domain', MAX_SHORT_TEXT_LENGTH);
    const subject = assertNonEmptyString(input.subject, 'subject', MAX_SHORT_TEXT_LENGTH);
    const chapterOrConcept = assertNonEmptyString(
      input.chapter_or_concept,
      'chapter_or_concept',
      MAX_SHORT_TEXT_LENGTH
    );
    const currentPosition = assertNonEmptyString(
      input.current_position,
      'current_position',
      MAX_POINTER_TEXT_LENGTH
    );
    const prerequisiteRefs = assertStringArray(
      input.prerequisite_refs,
      'prerequisite_refs',
      50,
      MAX_SHORT_TEXT_LENGTH
    );
    const sourceRefs = assertStringArray(
      input.source_refs,
      'source_refs',
      50,
      MAX_SHORT_TEXT_LENGTH
    );
    const unresolvedItems = assertStringArray(
      input.unresolved_items,
      'unresolved_items',
      50,
      MAX_SHORT_TEXT_LENGTH
    );

    return this.executeWriteWithReceipt({
      operation: 'knowledge_navigation_update',
      eventType: 'knowledge_navigation.updated',
      rawInput: input,
      mutate: (now) => {
        this.assertEntityInNamespace('tasks', taskId, 'Task');
        const taskRow = this.db.get<{ project_id: string | null }>(
          'SELECT project_id FROM tasks WHERE id = ? AND namespace_id = ?',
          [taskId, this.namespace]
        );

        const existingRow = this.db.get(
          'SELECT * FROM knowledge_navigation WHERE namespace_id = ? AND task_id = ?',
          [this.namespace, taskId]
        );

        if (!existingRow) {
          if (expectedVersion !== 0 && expectedVersion !== 1) {
            throw new PcmError(
              'VERSION_CONFLICT',
              `Knowledge navigation for task "${taskId}" does not exist yet; expected_version must be 0 (or 1 for initial creation), received ${expectedVersion}`,
              { task_id: taskId, expected_version: expectedVersion, actual_version: 0 }
            );
          }

          const id = this.newId('knav');
          const created: KnowledgeNavigationRecord = {
            id,
            namespace_id: this.namespace,
            task_id: taskId,
            domain,
            subject,
            chapter_or_concept: chapterOrConcept,
            prerequisite_refs: prerequisiteRefs,
            source_refs: sourceRefs,
            current_position: currentPosition,
            unresolved_items: unresolvedItems,
            version: 1,
            created_at: now,
            updated_at: now,
          };

          this.db.run(
            `INSERT INTO knowledge_navigation (
              id, namespace_id, task_id, domain, subject, chapter_or_concept,
              prerequisite_refs_json, source_refs_json, current_position,
              unresolved_items_json, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [
              created.id,
              created.namespace_id,
              created.task_id,
              created.domain,
              created.subject,
              created.chapter_or_concept,
              JSON.stringify(created.prerequisite_refs),
              JSON.stringify(created.source_refs),
              created.current_position,
              JSON.stringify(created.unresolved_items),
              created.created_at,
              created.updated_at,
            ]
          );

          return {
            entity: created,
            taskId,
            projectId: taskRow?.project_id ?? null,
            summary: `Initialized knowledge navigation pointer for task ${taskId} (${domain}/${subject}) v1`,
            stateVersions: { [`knowledge_navigation:${taskId}`]: 1 },
          };
        }

        const current = mapKnowledgeNavigationRow(existingRow);
        if (current.version !== expectedVersion) {
          throw new PcmError(
            'VERSION_CONFLICT',
            `Knowledge navigation version conflict for task "${taskId}": expected_version=${expectedVersion}, actual_version=${current.version}`,
            { task_id: taskId, expected_version: expectedVersion, actual_version: current.version }
          );
        }

        const updated: KnowledgeNavigationRecord = {
          ...current,
          domain,
          subject,
          chapter_or_concept: chapterOrConcept,
          prerequisite_refs: prerequisiteRefs,
          source_refs: sourceRefs,
          current_position: currentPosition,
          unresolved_items: unresolvedItems,
          version: current.version + 1,
          updated_at: now,
        };

        const res = this.db.run(
          `UPDATE knowledge_navigation
           SET domain = ?,
               subject = ?,
               chapter_or_concept = ?,
               prerequisite_refs_json = ?,
               source_refs_json = ?,
               current_position = ?,
               unresolved_items_json = ?,
               version = ?,
               updated_at = ?
           WHERE namespace_id = ? AND task_id = ? AND version = ?`,
          [
            updated.domain,
            updated.subject,
            updated.chapter_or_concept,
            JSON.stringify(updated.prerequisite_refs),
            JSON.stringify(updated.source_refs),
            updated.current_position,
            JSON.stringify(updated.unresolved_items),
            updated.version,
            updated.updated_at,
            this.namespace,
            taskId,
            expectedVersion,
          ]
        );

        if (res.changes !== 1) {
          throw new PcmError('VERSION_CONFLICT', 'Knowledge navigation concurrent update conflict');
        }

        return {
          entity: updated,
          taskId,
          projectId: taskRow?.project_id ?? null,
          summary: `Updated knowledge navigation pointer for task ${taskId} to v${updated.version} (pos="${updated.current_position}")`,
          stateVersions: { [`knowledge_navigation:${taskId}`]: updated.version },
        };
      },
    });
  }

  public knowledgeNavigationGetUpdate(rawInput: Record<string, unknown>): unknown {
    const input = assertObject(rawInput, 'pcm_knowledge_navigation_get_update');
    assertNoCallerNamespaceSpoofing(input, this.namespace);
    const mode = input.action ?? (input.expected_version !== undefined ? 'update' : 'get');
    if (mode === 'get') {
      return {
        mode: 'get',
        navigation: this.knowledgeNavigationGet(input),
      };
    }
    if (mode === 'update') {
      return {
        mode: 'update',
        ...this.knowledgeNavigationUpdate(input),
      };
    }
    throw new PcmError('INVALID_INPUT', 'action must be "get" or "update"');
  }

  // ==========================================================================
  // 12. Bounded Worker Context Bundle (pcm_context_bundle_get)
  // ==========================================================================

  public contextBundleGet(rawInput: Record<string, unknown>): Record<string, unknown> {
    const input = assertObject(rawInput, 'context_bundle_get');
    assertNoCallerNamespaceSpoofing(input, this.namespace);

    const taskId = assertOptionalString(input.task_id, 'task_id', MAX_SHORT_TEXT_LENGTH);
    let projectId = assertOptionalString(input.project_id, 'project_id', MAX_SHORT_TEXT_LENGTH);

    if (!taskId && !projectId) {
      throw new PcmError(
        'INVALID_INPUT',
        'context_bundle_get requires at least one of task_id or project_id'
      );
    }

    const clampBound = (val: unknown, def: number, max: number): number => {
      if (val === undefined || val === null) return def;
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > max) {
        throw new PcmError('INVALID_INPUT', `Section limit must be an integer between 1 and ${max}`);
      }
      return val;
    };

    const maxDecisions = clampBound(input.max_decisions, 5, 25);
    const maxArtifacts = clampBound(input.max_artifacts, 10, 25);
    const maxRoutes = clampBound(input.max_routes, 5, 25);
    const maxReceipts = clampBound(input.max_receipts, 5, 25);
    const maxMemories = clampBound(input.max_memories, 10, 25);

    const profile = this.ensureDefaultProfile();
    let task: TaskRecord | null = null;
    if (taskId) {
      task = this.taskGet({ id: taskId });
      if (projectId && task.project_id && task.project_id !== projectId) {
        throw new PcmError(
          'INVALID_INPUT',
          `Task "${taskId}" belongs to project "${task.project_id}", not "${projectId}"`
        );
      }
      if (!projectId && task.project_id) {
        projectId = task.project_id;
      }
    }

    let project: (ProjectRecord & { task_ids: string[]; artifact_ids: string[] }) | null = null;
    if (projectId) {
      project = this.projectGet({ id: projectId });
    }

    const knowledgeNav = task ? this.knowledgeNavigationGet({ task_id: task.id }) : null;

    // Decisions (strictly scoped to task)
    const decisionsResult = task
      ? this.decisionList({ task_id: task.id, limit: maxDecisions, offset: 0 })
      : { items: [], total_count: 0 };

    // Runtime Routes (strictly scoped to task)
    const routesResult = task
      ? this.runtimeRouteList({ task_id: task.id, limit: maxRoutes, offset: 0 })
      : { items: [], total_count: 0 };

    // Artifacts (strictly scoped to task or project, never unrelated entities)
    let artifactsTotal = 0;
    let artifactItems: ArtifactRecord[] = [];
    if (task) {
      const artRes = this.artifactList({ task_id: task.id, limit: maxArtifacts, offset: 0 });
      artifactItems = artRes.items;
      artifactsTotal = artRes.total_count;
    } else if (project) {
      const artRes = this.artifactList({ project_id: project.id, limit: maxArtifacts, offset: 0 });
      artifactItems = artRes.items;
      artifactsTotal = artRes.total_count;
    }

    // Recent Receipts (strictly scoped to task or project, never dumping full history)
    let receiptsTotal = 0;
    let receiptItems: ReceiptRecord[] = [];
    if (task) {
      const rcptRes = this.receiptSearch({ task_id: task.id, limit: maxReceipts, offset: 0 });
      receiptItems = rcptRes.items;
      receiptsTotal = rcptRes.total_count;
    } else if (project) {
      const rcptRes = this.receiptSearch({ project_id: project.id, limit: maxReceipts, offset: 0 });
      receiptItems = rcptRes.items;
      receiptsTotal = rcptRes.total_count;
    }

    // Relevant active memories (scoped to this task, its project, or user-level in this namespace)
    const now = this.nowIso();
    const memWhere: string[] = [
      'namespace_id = ?',
      "status = 'active'",
      '(expires_at IS NULL OR expires_at > ?)',
    ];
    const memParams: unknown[] = [this.namespace, now];

    if (task && project) {
      memWhere.push("(scope = 'user' OR (scope = 'project' AND project_id = ?) OR (scope = 'task' AND task_id = ?))");
      memParams.push(project.id, task.id);
    } else if (task) {
      memWhere.push("(scope = 'user' OR (scope = 'task' AND task_id = ?))");
      memParams.push(task.id);
    } else if (project) {
      memWhere.push("(scope = 'user' OR (scope = 'project' AND project_id = ?))");
      memParams.push(project.id);
    }

    const memWhereSql = memWhere.join(' AND ');
    const memCountRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM memories WHERE ${memWhereSql}`,
      memParams
    );
    const memoriesTotal = memCountRow ? Number(memCountRow.cnt) : 0;
    const memRows = this.db.all(
      `SELECT * FROM memories WHERE ${memWhereSql} ORDER BY updated_at DESC, id ASC LIMIT ?`,
      [...memParams, maxMemories]
    );
    const memoryItems = memRows.map(mapMemoryRow);

    const entityVersions: Record<string, number> = {
      profile: profile.version,
      ...(project ? { [`project:${project.id}`]: project.version } : {}),
      ...(task ? { [`task:${task.id}`]: task.version } : {}),
      ...(knowledgeNav ? { [`knowledge_navigation:${task!.id}`]: knowledgeNav.version } : {}),
    };

    const decisionsOmitted = Math.max(0, decisionsResult.total_count - decisionsResult.items.length);
    const artifactsOmitted = Math.max(0, artifactsTotal - artifactItems.length);
    const routesOmitted = Math.max(0, routesResult.total_count - routesResult.items.length);
    const receiptsOmitted = Math.max(0, receiptsTotal - receiptItems.length);
    const memoriesOmitted = Math.max(0, memoriesTotal - memoryItems.length);

    return {
      namespace_id: this.namespace,
      generated_at: now,
      bounded: true,
      bounds: {
        max_decisions: maxDecisions,
        max_artifacts: maxArtifacts,
        max_routes: maxRoutes,
        max_receipts: maxReceipts,
        max_memories: maxMemories,
      },
      entity_versions: entityVersions,
      omitted_sections: {
        decisions_omitted: decisionsOmitted,
        artifacts_omitted: artifactsOmitted,
        runtime_routes_omitted: routesOmitted,
        receipts_omitted: receiptsOmitted,
        memories_omitted: memoriesOmitted,
        unrelated_projects_excluded: true,
        unrelated_tasks_excluded: true,
        archived_memories_excluded: true,
        full_receipt_history_excluded: true,
      },
      profile,
      project,
      task: task
        ? {
            id: task.id,
            project_id: task.project_id,
            title: task.title,
            confirmed_specification: task.confirmed_specification,
            constraints: task.constraints,
            assumptions: task.assumptions,
            acceptance_criteria: task.acceptance_criteria,
            status: task.status,
            priority: task.priority,
            current_stage: task.current_stage,
            assignments: task.assignments,
            dependency_refs: task.dependency_refs,
            open_questions: task.open_questions,
            blockers: task.blockers,
            verification_status: task.verification_status,
            version: task.version,
            updated_at: task.updated_at,
          }
        : null,
      knowledge_navigation: knowledgeNav,
      relevant_memories: {
        items: memoryItems,
        total_count: memoriesTotal,
        returned_count: memoryItems.length,
        omitted_count: memoriesOmitted,
        truncated: memoriesOmitted > 0,
      },
      decisions: {
        items: decisionsResult.items,
        total_count: decisionsResult.total_count,
        returned_count: decisionsResult.items.length,
        omitted_count: decisionsOmitted,
        truncated: decisionsOmitted > 0,
      },
      artifacts: {
        items: artifactItems,
        total_count: artifactsTotal,
        returned_count: artifactItems.length,
        omitted_count: artifactsOmitted,
        truncated: artifactsOmitted > 0,
      },
      runtime_routes: {
        items: routesResult.items,
        total_count: routesResult.total_count,
        returned_count: routesResult.items.length,
        omitted_count: routesOmitted,
        truncated: routesOmitted > 0,
      },
      recent_receipts: {
        items: receiptItems,
        total_count: receiptsTotal,
        returned_count: receiptItems.length,
        omitted_count: receiptsOmitted,
        truncated: receiptsOmitted > 0,
      },
    };
  }

  // ==========================================================================
  // 13. Consistent Namespace-Scoped Snapshot Export (pcm_snapshot_export)
  // ==========================================================================

  public snapshotExport(rawInput: Record<string, unknown> = {}): Record<string, unknown> {
    const input = assertObject(rawInput, 'snapshot_export');
    assertNoCallerNamespaceSpoofing(input, this.namespace);

    // Reject any attempt to supply a target path or directory traversal
    if (input.output_path !== undefined || input.path !== undefined || input.file_path !== undefined) {
      throw new PcmError(
        'PATH_NOT_ALLOWED',
        'Snapshot export uses server-generated safe filenames inside PCM_EXPORT_DIR; caller-supplied file paths are forbidden.'
      );
    }

    let safeLabel = 'snapshot';
    if (input.label !== undefined && input.label !== null) {
      const rawLabel = assertNonEmptyString(input.label, 'label', 64);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rawLabel)) {
        throw new PcmError(
          'PATH_NOT_ALLOWED',
          'Snapshot label may only contain alphanumeric characters, hyphens, and underscores'
        );
      }
      safeLabel = rawLabel;
    }

    fs.mkdirSync(this.config.exportDir, { recursive: true });
    const now = this.nowIso();
    const safeTs = now.replace(/[:.]/g, '-');
    const shortId = crypto.randomUUID().slice(0, 8);

    // Step 1: Use SQLite's online backup API (sqlite3_backup_init/step/finish) to create a point-in-time consistent database snapshot
    const tempSqliteSnapshotPath = path.join(
      this.config.exportDir,
      `.tmp-consistent-backup-${this.namespace}-${safeTs}-${shortId}.sqlite`
    );

    this.db.backupToFile(tempSqliteSnapshotPath);

    let snapshotDb: SqliteDatabase | null = null;
    try {
      snapshotDb = new SqliteDatabase(tempSqliteSnapshotPath);
      const schemaStatus = snapshotDb.getSchemaStatus();

      const profileRows = snapshotDb
        .all('SELECT * FROM profiles WHERE namespace_id = ?', [this.namespace])
        .map(mapProfileRow);
      const projects = snapshotDb
        .all('SELECT * FROM projects WHERE namespace_id = ? ORDER BY created_at ASC', [
          this.namespace,
        ])
        .map(mapProjectRow);
      const tasks = snapshotDb
        .all('SELECT * FROM tasks WHERE namespace_id = ? ORDER BY created_at ASC', [
          this.namespace,
        ])
        .map(mapTaskRow);
      const memories = snapshotDb
        .all('SELECT * FROM memories WHERE namespace_id = ? ORDER BY created_at ASC', [
          this.namespace,
        ])
        .map(mapMemoryRow);
      const decisions = snapshotDb
        .all('SELECT * FROM decisions WHERE namespace_id = ? ORDER BY created_at ASC', [
          this.namespace,
        ])
        .map(mapDecisionRow);
      const artifacts = snapshotDb
        .all('SELECT * FROM artifacts WHERE namespace_id = ? ORDER BY created_at ASC', [
          this.namespace,
        ])
        .map(mapArtifactRow);
      const runtimeRoutes = snapshotDb
        .all('SELECT * FROM runtime_routes WHERE namespace_id = ? ORDER BY created_at ASC', [
          this.namespace,
        ])
        .map(mapRuntimeRouteRow);
      const capabilityObservations = snapshotDb
        .all(
          'SELECT * FROM capability_observations WHERE namespace_id = ? ORDER BY measured_at ASC',
          [this.namespace]
        )
        .map((r) => this.attachFreshness(mapCapabilityObservationRow(r), now));
      const knowledgeNavigation = snapshotDb
        .all('SELECT * FROM knowledge_navigation WHERE namespace_id = ? ORDER BY updated_at ASC', [
          this.namespace,
        ])
        .map(mapKnowledgeNavigationRow);
      const receipts = snapshotDb
        .all('SELECT * FROM receipts WHERE namespace_id = ? ORDER BY timestamp ASC', [
          this.namespace,
        ])
        .map(mapReceiptRow);

      const redactedData = redactSecrets({
        profile: profileRows[0] ?? null,
        projects,
        tasks,
        memories,
        decisions,
        artifacts,
        runtime_routes: runtimeRoutes,
        capability_observations: capabilityObservations,
        knowledge_navigation: knowledgeNavigation,
        receipts,
      });

      const dataChecksum = crypto
        .createHash('sha256')
        .update(JSON.stringify(redactedData), 'utf8')
        .digest('hex');

      const manifest = {
        format: 'ZyroG2i_PCM_Namespace_Snapshot',
        format_version: '2.0.0',
        schema_version: schemaStatus.current_version,
        sqlite_version: schemaStatus.sqlite_version,
        applied_migrations: schemaStatus.applied_migrations,
        consistent_snapshot_method: 'sqlite_online_backup_api',
        namespace_id: this.namespace,
        exported_at: now,
        redaction_applied: true,
        auto_upload: false,
        data_checksum_sha256: dataChecksum,
        entity_counts: {
          profiles: profileRows.length,
          projects: projects.length,
          tasks: tasks.length,
          memories: memories.length,
          decisions: decisions.length,
          artifacts: artifacts.length,
          runtime_routes: runtimeRoutes.length,
          capability_observations: capabilityObservations.length,
          knowledge_navigation: knowledgeNavigation.length,
          receipts: receipts.length,
        },
      };

      const snapshotPayload = {
        manifest,
        data: redactedData,
      };

      const filename = `pcm-snapshot-${this.namespace}-${safeLabel}-${safeTs}-${shortId}.json`;
      const finalFilePath = path.join(this.config.exportDir, filename);
      const tempJsonPath = `${finalFilePath}.tmp`;

      fs.writeFileSync(tempJsonPath, JSON.stringify(snapshotPayload, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(tempJsonPath, finalFilePath);

      const receipt = this.receiptAppend({
        event_type: 'snapshot.exported',
        operation: 'snapshot_export',
        outcome: 'success',
        summary: `Exported consistent namespace snapshot "${filename}" (${dataChecksum.slice(0, 12)})`,
        metadata: {
          filename,
          schema_version: manifest.schema_version,
          entity_counts: manifest.entity_counts,
          data_checksum_sha256: dataChecksum,
        },
      });

      return {
        filename,
        export_path: finalFilePath,
        manifest,
        receipt_id: receipt.id,
      };
    } finally {
      if (snapshotDb) {
        snapshotDb.close();
      }
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const p = `${tempSqliteSnapshotPath}${suffix}`;
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch {
            // ignore cleanup errors
          }
        }
      }
    }
  }
}
