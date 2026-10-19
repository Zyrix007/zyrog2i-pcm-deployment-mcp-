import { normalizeError } from '../domain/errors';
import {
  ARTIFACT_VERIFICATION_VALUES,
  ASSUMPTION_HANDLING_VALUES,
  AUTONOMY_VALUES,
  CAPABILITY_OBSERVATION_KINDS,
  CLARIFICATION_STRICTNESS_VALUES,
  EXPERTISE_MODE_VALUES,
  MEMORY_SCOPES,
  MEMORY_STATUS_VALUES,
  MEMORY_TYPES,
  PRIVACY_CLASSIFICATIONS,
  PROJECT_STATUS_VALUES,
  RECEIPT_OUTCOME_VALUES,
  RISK_TOLERANCE_VALUES,
  RUNTIME_ROUTE_STATUS_VALUES,
  TASK_PRIORITY_VALUES,
  TASK_STATUS_VALUES,
  TASK_VERIFICATION_VALUES,
  TONE_VALUES,
  VERBOSITY_VALUES,
  VERIFICATION_EFFORT_VALUES,
} from '../domain/schemas';
import { PcmService } from '../services/pcm-service';

export interface McpToolDefinition {
  name: string;
  description: string;
  readOnlyHint: boolean;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (service: PcmService, args: Record<string, unknown>) => unknown;
}

const WRITE_METADATA_PROPS = {
  idempotency_key: {
    type: 'string',
    description: 'Optional idempotency key. Same key + same payload replays safely; same key + different payload fails.',
  },
  correlation_id: {
    type: 'string',
    description: 'Optional correlation ID recorded in the atomic operational receipt.',
  },
  actor_attribution: {
    type: 'string',
    description: 'Optional descriptive actor attribution recorded in the operational receipt (not authentication).',
  },
};

const PAGINATION_PROPS = {
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Maximum number of records to return (1..100).',
  },
  offset: {
    type: 'integer',
    minimum: 0,
    default: 0,
    description: 'Pagination offset (>= 0).',
  },
};

export const PCM_TOOLS: McpToolDefinition[] = [
  // 1. Health & Schema Readiness
  {
    name: 'pcm_health',
    description: 'Check PCM server health, readiness, configured namespace, and SQLite database schema/migration status.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: (service, args) => service.health(args),
  },

  // 2. Bounded Context Bundle
  {
    name: 'pcm_context_bundle_get',
    description:
      'Retrieve a bounded task/project context bundle with confirmed specification, status, blockers, open questions, relevant decisions, artifacts, and recent receipts; includes entity versions and omitted-section indicators.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Target Task Maxer task ID.' },
        project_id: { type: 'string', description: 'Target project ID.' },
        max_decisions: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
        max_artifacts: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
        max_routes: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
        max_receipts: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
        max_memories: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
      },
      additionalProperties: false,
    },
    handler: (service, args) => service.contextBundleGet(args),
  },

  // 3. Profile Get & Update
  {
    name: 'pcm_profile_get',
    description: 'Retrieve the durable user interaction/preference profile for the configured namespace.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: (service, args) => service.profileGet(args),
  },
  {
    name: 'pcm_profile_update',
    description:
      'Update allowlisted user profile interaction preferences using optimistic concurrency (expected_version). Never overrides safety, truthfulness, or verification rules.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        expected_version: { type: 'integer', minimum: 1 },
        clarification_strictness: { type: 'string', enum: [...CLARIFICATION_STRICTNESS_VALUES] },
        risk_tolerance: { type: 'string', enum: [...RISK_TOLERANCE_VALUES] },
        tone: { type: 'string', enum: [...TONE_VALUES] },
        verbosity: { type: 'string', enum: [...VERBOSITY_VALUES] },
        expertise_mode: { type: 'string', enum: [...EXPERTISE_MODE_VALUES] },
        assumption_handling: { type: 'string', enum: [...ASSUMPTION_HANDLING_VALUES] },
        verification_effort: { type: 'string', enum: [...VERIFICATION_EFFORT_VALUES] },
        autonomy: { type: 'string', enum: [...AUTONOMY_VALUES] },
        ...WRITE_METADATA_PROPS,
      },
      required: ['expected_version'],
      additionalProperties: false,
    },
    handler: (service, args) => service.profileUpdate(args),
  },

  // 4. Memory Operations
  {
    name: 'pcm_memory_create',
    description:
      'Explicitly persist a long-term memory record distinguishing confirmed_fact, assumption, model_claim, preference, and working_note. Rejects credentials/secrets.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string', enum: [...MEMORY_TYPES] },
        scope: { type: 'string', enum: [...MEMORY_SCOPES] },
        project_id: { type: 'string' },
        task_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        source_type: { type: 'string' },
        source_ref: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        privacy_classification: { type: 'string', enum: [...PRIVACY_CLASSIFICATIONS] },
        expires_at: { type: 'string' },
        provenance: { type: 'object' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['content', 'type', 'scope'],
      additionalProperties: false,
    },
    handler: (service, args) => service.memoryCreate(args),
  },
  {
    name: 'pcm_memory_search',
    description: 'Search explicitly saved memories with filters and bounded pagination.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: [...MEMORY_TYPES] },
        scope: { type: 'string', enum: [...MEMORY_SCOPES] },
        project_id: { type: 'string' },
        task_id: { type: 'string' },
        tag: { type: 'string' },
        status: { type: 'string', enum: [...MEMORY_STATUS_VALUES], default: 'active' },
        include_expired: { type: 'boolean', default: false },
        ...PAGINATION_PROPS,
      },
      additionalProperties: false,
    },
    handler: (service, args) => service.memorySearch(args),
  },
  {
    name: 'pcm_memory_update',
    description: 'Update an existing memory record using expected_version.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_version: { type: 'integer', minimum: 1 },
        content: { type: 'string' },
        type: { type: 'string', enum: [...MEMORY_TYPES] },
        tags: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        privacy_classification: { type: 'string', enum: [...PRIVACY_CLASSIFICATIONS] },
        expires_at: { type: ['string', 'null'] },
        source_type: { type: ['string', 'null'] },
        source_ref: { type: ['string', 'null'] },
        status: { type: 'string', enum: [...MEMORY_STATUS_VALUES] },
        ...WRITE_METADATA_PROPS,
      },
      required: ['id', 'expected_version'],
      additionalProperties: false,
    },
    handler: (service, args) => service.memoryUpdate(args),
  },
  {
    name: 'pcm_memory_archive',
    description: 'Archive a memory record (default non-destructive removal) using expected_version.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_version: { type: 'integer', minimum: 1 },
        ...WRITE_METADATA_PROPS,
      },
      required: ['id', 'expected_version'],
      additionalProperties: false,
    },
    handler: (service, args) => service.memoryArchive(args),
  },
  {
    name: 'pcm_memory_forget',
    description:
      'Permanently forget and purge a memory from active storage, search indexes, and audit receipts. Requires confirm_permanent_delete=true and confirmation_phrase="PERMANENTLY_FORGET".',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_version: { type: 'integer', minimum: 1 },
        confirm_permanent_delete: { type: 'boolean' },
        confirmation_phrase: { type: 'string' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['id', 'confirm_permanent_delete', 'confirmation_phrase'],
      additionalProperties: false,
    },
    handler: (service, args) => service.memoryForget(args),
  },

  // 5. Project Operations
  {
    name: 'pcm_project_create',
    description: 'Create a project grouping Task Maxer tasks and artifact references.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        objectives: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: [...PROJECT_STATUS_VALUES], default: 'active' },
        provenance: { type: 'object' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (service, args) => service.projectCreate(args),
  },
  {
    name: 'pcm_project_get',
    description: 'Get a project record and its linked task/artifact reference IDs.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (service, args) => service.projectGet(args),
  },
  {
    name: 'pcm_project_list',
    description: 'List projects in the configured namespace with bounded pagination.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...PROJECT_STATUS_VALUES] },
        ...PAGINATION_PROPS,
      },
      additionalProperties: false,
    },
    handler: (service, args) => service.projectList(args),
  },
  {
    name: 'pcm_project_update',
    description: 'Update a project record using expected_version.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_version: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        objectives: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: [...PROJECT_STATUS_VALUES] },
        provenance: { type: 'object' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['id', 'expected_version'],
      additionalProperties: false,
    },
    handler: (service, args) => service.projectUpdate(args),
  },

  // 6. Task / Task Maxer Operations
  {
    name: 'pcm_task_create',
    description:
      'Create a Task Maxer task with confirmed specification (distinct from assumptions), constraints, acceptance criteria, status, dependencies, open questions, blockers, and verification status.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        project_id: { type: 'string' },
        title: { type: 'string' },
        initial_request_summary: { type: 'string' },
        confirmed_specification: { type: ['object', 'string'] },
        constraints: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        acceptance_criteria: { type: 'array' },
        status: { type: 'string', enum: [...TASK_STATUS_VALUES], default: 'draft' },
        priority: { type: 'string', enum: [...TASK_PRIORITY_VALUES], default: 'medium' },
        current_stage: { type: 'string' },
        assignments: { type: 'array' },
        dependency_refs: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array' },
        blockers: { type: 'array' },
        verification_status: {
          type: 'string',
          enum: [...TASK_VERIFICATION_VALUES],
          default: 'not_started',
        },
        provenance: { type: 'object' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['title', 'confirmed_specification'],
      additionalProperties: false,
    },
    handler: (service, args) => service.taskCreate(args),
  },
  {
    name: 'pcm_task_get',
    description: 'Get a Task Maxer task by ID.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (service, args) => service.taskGet(args),
  },
  {
    name: 'pcm_task_list',
    description: 'List Task Maxer tasks with bounded pagination and optional filters.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        status: { type: 'string', enum: [...TASK_STATUS_VALUES] },
        priority: { type: 'string', enum: [...TASK_PRIORITY_VALUES] },
        ...PAGINATION_PROPS,
      },
      additionalProperties: false,
    },
    handler: (service, args) => service.taskList(args),
  },
  {
    name: 'pcm_task_update',
    description:
      'Validated update of a Task Maxer task using expected_version. Enforces status transitions, completion verification criteria, and prevents silently discarding blockers, dependencies, or open questions.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_version: { type: 'integer', minimum: 1 },
        project_id: { type: ['string', 'null'] },
        title: { type: 'string' },
        initial_request_summary: { type: ['string', 'null'] },
        confirmed_specification: { type: ['object', 'string'] },
        constraints: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        acceptance_criteria: { type: 'array' },
        status: { type: 'string', enum: [...TASK_STATUS_VALUES] },
        priority: { type: 'string', enum: [...TASK_PRIORITY_VALUES] },
        current_stage: { type: ['string', 'null'] },
        assignments: { type: 'array' },
        dependency_refs: { type: 'array', items: { type: 'string' } },
        allow_dependency_removal: { type: 'boolean' },
        open_questions: { type: 'array' },
        blockers: { type: 'array' },
        verification_status: { type: 'string', enum: [...TASK_VERIFICATION_VALUES] },
        provenance: { type: 'object' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['id', 'expected_version'],
      additionalProperties: false,
    },
    handler: (service, args) => service.taskUpdate(args),
  },

  // 7. Structured Decisions
  {
    name: 'pcm_decision_append',
    description:
      'Validate and record a structured task decision (from a decision layer such as Laya) without inventing scores or probabilities.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        task_id: { type: 'string' },
        state_version_observed: { type: 'integer', minimum: 1 },
        objective: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              option_id: { type: 'string' },
              description: { type: 'string' },
              selection_probability: { type: 'number', minimum: 0, maximum: 1 },
              suitability_score: { type: 'number', minimum: 0, maximum: 1 },
              route_status: { type: 'string' },
              evidence_refs: { type: 'array', items: { type: 'string' } },
            },
            required: ['option_id', 'description'],
          },
        },
        chosen_option: { type: 'string' },
        selection_basis: { type: 'string' },
        assessment_confidence: { type: 'number', minimum: 0, maximum: 1 },
        escalation: { type: 'string' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
        provenance: { type: 'object' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['task_id', 'state_version_observed', 'objective', 'options', 'chosen_option'],
      additionalProperties: false,
    },
    handler: (service, args) => service.decisionAppend(args),
  },
  {
    name: 'pcm_decision_list',
    description: 'List structured decisions recorded for a task with bounded pagination.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        ...PAGINATION_PROPS,
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: (service, args) => service.decisionList(args),
  },

  // 8. Artifacts
  {
    name: 'pcm_artifact_register',
    description:
      'Register artifact metadata and a validated relative path inside PCM_ARTIFACT_ROOT (or passive external reference). Rejects path traversal and symlink escapes. Registration is not verification.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        task_id: { type: 'string' },
        project_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string' },
        relative_path_or_external_reference: { type: 'string' },
        mime_type: { type: 'string' },
        size_bytes: { type: 'integer', minimum: 0 },
        checksum: { type: 'string' },
        provenance: { type: 'object' },
        verification_status: {
          type: 'string',
          enum: [...ARTIFACT_VERIFICATION_VALUES],
          default: 'unverified',
        },
        ...WRITE_METADATA_PROPS,
      },
      required: ['name', 'type', 'relative_path_or_external_reference'],
      additionalProperties: false,
    },
    handler: (service, args) => service.artifactRegister(args),
  },
  {
    name: 'pcm_artifact_list',
    description: 'List artifact metadata records for a task or project with bounded pagination.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        project_id: { type: 'string' },
        ...PAGINATION_PROPS,
      },
      additionalProperties: false,
    },
    handler: (service, args) => service.artifactList(args),
  },

  // 9. Operational Receipts
  {
    name: 'pcm_receipt_append',
    description: 'Append an immutable operational receipt.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        task_id: { type: 'string' },
        project_id: { type: 'string' },
        event_type: { type: 'string' },
        operation: { type: 'string' },
        outcome: { type: 'string', enum: [...RECEIPT_OUTCOME_VALUES] },
        summary: { type: 'string' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
        artifact_refs: { type: 'array', items: { type: 'string' } },
        state_versions: { type: 'object' },
        metadata: { type: 'object' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['event_type', 'operation', 'outcome', 'summary'],
      additionalProperties: false,
    },
    handler: (service, args) => service.receiptAppend(args),
  },
  {
    name: 'pcm_receipt_search',
    description: 'Search immutable operational receipts with bounded pagination.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        project_id: { type: 'string' },
        operation: { type: 'string' },
        event_type: { type: 'string' },
        outcome: { type: 'string', enum: [...RECEIPT_OUTCOME_VALUES] },
        correlation_id: { type: 'string' },
        ...PAGINATION_PROPS,
      },
      additionalProperties: false,
    },
    handler: (service, args) => service.receiptSearch(args),
  },

  // 10. Runtime Routes
  {
    name: 'pcm_runtime_route_append',
    description:
      'Append a runtime route record for a live task, keeping status, assessment_confidence, selection_probability, suitability_score, observations, and evidence_refs distinct.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        task_id: { type: 'string' },
        route_summary: { type: 'string' },
        status: { type: 'string', enum: [...RUNTIME_ROUTE_STATUS_VALUES] },
        assessment_confidence: { type: 'number', minimum: 0, maximum: 1 },
        selection_probability: { type: 'number', minimum: 0, maximum: 1 },
        suitability_score: { type: 'number', minimum: 0, maximum: 1 },
        observations: { type: 'array', items: { type: 'string' } },
        evidence_refs: { type: 'array', items: { type: 'string' } },
        next_action: { type: 'string' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['task_id', 'route_summary', 'status'],
      additionalProperties: false,
    },
    handler: (service, args) => service.runtimeRouteAppend(args),
  },
  {
    name: 'pcm_runtime_route_list',
    description: 'List runtime route records for a task with bounded pagination.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: [...RUNTIME_ROUTE_STATUS_VALUES] },
        ...PAGINATION_PROPS,
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: (service, args) => service.runtimeRouteList(args),
  },

  // 11. Capability Observations
  {
    name: 'pcm_capability_observation_record',
    description:
      'Record a supplied capability observation (static_capability, measured_performance, or last_known_availability). PCM never probes hardware.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        machine_or_runtime_id: { type: 'string' },
        kind: { type: 'string', enum: [...CAPABILITY_OBSERVATION_KINDS] },
        backend: { type: 'string' },
        observations: { type: 'object' },
        measurement_method: { type: 'string' },
        measured_at: { type: 'string' },
        valid_until: { type: 'string' },
        source_receipt_id: { type: 'string' },
        ...WRITE_METADATA_PROPS,
      },
      required: ['machine_or_runtime_id', 'kind', 'observations', 'measured_at'],
      additionalProperties: false,
    },
    handler: (service, args) => service.capabilityObservationRecord(args),
  },
  {
    name: 'pcm_capability_observation_get',
    description:
      'Retrieve supplied capability observations with explicit freshness/staleness indicators.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        machine_or_runtime_id: { type: 'string' },
        kind: { type: 'string', enum: [...CAPABILITY_OBSERVATION_KINDS] },
        backend: { type: 'string' },
        as_of: { type: 'string' },
        ...PAGINATION_PROPS,
      },
      additionalProperties: false,
    },
    handler: (service, args) => service.capabilityObservationGet(args),
  },

  // 12. Knowledge Navigation (Separate Get, Separate Update, and Named Combined Tool)
  {
    name: 'pcm_knowledge_navigation_get',
    description:
      'Retrieve compact, task-scoped domain/subject/chapter/concept pointers and prerequisite/source references.',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: (service, args) => service.knowledgeNavigationGet(args),
  },
  {
    name: 'pcm_knowledge_navigation_update',
    description:
      'Create or update compact, task-scoped domain/subject/chapter/concept pointers and prerequisite/source references using expected_version.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        expected_version: { type: 'integer', minimum: 0 },
        domain: { type: 'string' },
        subject: { type: 'string' },
        chapter_or_concept: { type: 'string' },
        current_position: { type: 'string' },
        prerequisite_refs: { type: 'array', items: { type: 'string' } },
        source_refs: { type: 'array', items: { type: 'string' } },
        unresolved_items: { type: 'array', items: { type: 'string' } },
        ...WRITE_METADATA_PROPS,
      },
      required: [
        'task_id',
        'expected_version',
        'domain',
        'subject',
        'chapter_or_concept',
        'current_position',
      ],
      additionalProperties: false,
    },
    handler: (service, args) => service.knowledgeNavigationUpdate(args),
  },
  {
    name: 'pcm_knowledge_navigation_get_update',
    description:
      'Retrieve or update compact, task-scoped domain/subject/chapter/concept pointers and prerequisite/source references using expected_version.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'update'] },
        task_id: { type: 'string' },
        expected_version: { type: 'integer', minimum: 0 },
        domain: { type: 'string' },
        subject: { type: 'string' },
        chapter_or_concept: { type: 'string' },
        current_position: { type: 'string' },
        prerequisite_refs: { type: 'array', items: { type: 'string' } },
        source_refs: { type: 'array', items: { type: 'string' } },
        unresolved_items: { type: 'array', items: { type: 'string' } },
        ...WRITE_METADATA_PROPS,
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: (service, args) => service.knowledgeNavigationGetUpdate(args),
  },

  // 13. Consistent Snapshot Export
  {
    name: 'pcm_snapshot_export',
    description:
      'Export a consistent namespace-scoped JSON snapshot with schema/version manifest to the controlled export directory using SQLite online backup.',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Optional alphanumeric label included in the generated safe filename.',
        },
      },
      additionalProperties: false,
    },
    handler: (service, args) => service.snapshotExport(args),
  },
];

export function executeToolCall(
  service: PcmService,
  toolName: string,
  rawArgs: unknown
): {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
} {
  const tool = PCM_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    const errPayload = {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Unknown PCM tool: "${toolName}"`,
      },
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(errPayload) }],
      structuredContent: errPayload,
    };
  }

  try {
    const argsObj =
      rawArgs === undefined || rawArgs === null
        ? {}
        : typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : (() => {
              throw new Error('Tool arguments must be a JSON object');
            })();

    const data = tool.handler(service, argsObj);
    const okPayload = {
      ok: true,
      tool: toolName,
      data,
    };
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(okPayload) }],
      structuredContent: okPayload,
    };
  } catch (err) {
    const pcmErr = normalizeError(err);
    service.logger.warn(`Tool "${toolName}" failed with ${pcmErr.code}: ${pcmErr.message}`, {
      tool: toolName,
      code: pcmErr.code,
    });
    const errPayload = {
      ok: false,
      tool: toolName,
      error: pcmErr.toJSON(),
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(errPayload) }],
      structuredContent: errPayload,
    };
  }
}
