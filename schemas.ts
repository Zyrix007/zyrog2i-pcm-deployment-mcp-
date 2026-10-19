import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PcmError } from './errors';

// ============================================================================
// Common Constants & Enums
// ============================================================================

export const MAX_TEXT_LENGTH = 16384;
export const MAX_SHORT_TEXT_LENGTH = 512;
export const MAX_POINTER_TEXT_LENGTH = 1024;
export const MAX_ARRAY_ITEMS = 100;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const PROFILE_ALLOWLIST_FIELDS = [
  'clarification_strictness',
  'risk_tolerance',
  'tone',
  'verbosity',
  'expertise_mode',
  'assumption_handling',
  'verification_effort',
  'autonomy',
] as const;

export type ProfileFieldKey = (typeof PROFILE_ALLOWLIST_FIELDS)[number];

export const CLARIFICATION_STRICTNESS_VALUES = ['low', 'medium', 'high', 'strict'] as const;
export const RISK_TOLERANCE_VALUES = ['conservative', 'moderate', 'aggressive'] as const;
export const TONE_VALUES = ['concise', 'neutral', 'detailed', 'technical', 'direct'] as const;
export const VERBOSITY_VALUES = ['minimal', 'concise', 'balanced', 'comprehensive'] as const;
export const EXPERTISE_MODE_VALUES = ['beginner', 'intermediate', 'expert', 'architect'] as const;
export const ASSUMPTION_HANDLING_VALUES = ['ask_first', 'state_explicitly', 'provisional_allowed'] as const;
export const VERIFICATION_EFFORT_VALUES = ['minimal', 'standard', 'strict', 'exhaustive'] as const;
export const AUTONOMY_VALUES = ['supervised', 'collaborative', 'autonomous'] as const;

export const MEMORY_TYPES = [
  'confirmed_fact',
  'assumption',
  'model_claim',
  'preference',
  'working_note',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ['user', 'project', 'task'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_STATUS_VALUES = ['active', 'archived', 'superseded'] as const;
export type MemoryStatus = (typeof MEMORY_STATUS_VALUES)[number];

export const PRIVACY_CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type PrivacyClassification = (typeof PRIVACY_CLASSIFICATIONS)[number];

export const PROJECT_STATUS_VALUES = ['active', 'paused', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUS_VALUES)[number];

export const TASK_STATUS_VALUES = [
  'draft',
  'ready',
  'active',
  'blocked',
  'needs_user',
  'needs_verification',
  'completed',
  'failed',
  'archived',
] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export const TASK_VERIFICATION_VALUES = [
  'not_required',
  'not_started',
  'pending',
  'passed',
  'failed',
  'inconclusive',
] as const;
export type TaskVerificationStatus = (typeof TASK_VERIFICATION_VALUES)[number];

export const TASK_PRIORITY_VALUES = ['low', 'medium', 'high', 'critical'] as const;
export type TaskPriority = (typeof TASK_PRIORITY_VALUES)[number];

export const RUNTIME_ROUTE_STATUS_VALUES = [
  'proposed',
  'unverified',
  'viable',
  'partially_viable',
  'failed',
  'blocked',
] as const;
export type RuntimeRouteStatus = (typeof RUNTIME_ROUTE_STATUS_VALUES)[number];

export const CAPABILITY_OBSERVATION_KINDS = [
  'static_capability',
  'measured_performance',
  'last_known_availability',
] as const;
export type CapabilityObservationKind = (typeof CAPABILITY_OBSERVATION_KINDS)[number];

export const ARTIFACT_VERIFICATION_VALUES = [
  'unverified',
  'pending',
  'verified',
  'failed',
] as const;
export type ArtifactVerificationStatus = (typeof ARTIFACT_VERIFICATION_VALUES)[number];

export const RECEIPT_OUTCOME_VALUES = ['success', 'failure', 'noop'] as const;
export type ReceiptOutcome = (typeof RECEIPT_OUTCOME_VALUES)[number];

// ============================================================================
// Entity Interfaces
// ============================================================================

export interface ProvenanceInfo {
  source?: string;
  actor?: string;
  recorded_reason?: string;
  external_ref?: string;
}

export interface UserProfile {
  id: string;
  namespace_id: string;
  clarification_strictness: (typeof CLARIFICATION_STRICTNESS_VALUES)[number];
  risk_tolerance: (typeof RISK_TOLERANCE_VALUES)[number];
  tone: (typeof TONE_VALUES)[number];
  verbosity: (typeof VERBOSITY_VALUES)[number];
  expertise_mode: (typeof EXPERTISE_MODE_VALUES)[number];
  assumption_handling: (typeof ASSUMPTION_HANDLING_VALUES)[number];
  verification_effort: (typeof VERIFICATION_EFFORT_VALUES)[number];
  autonomy: (typeof AUTONOMY_VALUES)[number];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryRecord {
  id: string;
  namespace_id: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  project_id: string | null;
  task_id: string | null;
  tags: string[];
  source_type: string | null;
  source_ref: string | null;
  confidence: number | null;
  privacy_classification: PrivacyClassification;
  expires_at: string | null;
  status: MemoryStatus;
  version: number;
  provenance: ProvenanceInfo | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRecord {
  id: string;
  namespace_id: string;
  name: string;
  description: string | null;
  objectives: string[];
  constraints: string[];
  status: ProjectStatus;
  version: number;
  provenance: ProvenanceInfo | null;
  created_at: string;
  updated_at: string;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  met: boolean;
  evidence_ref?: string;
}

export interface TaskAssignment {
  worker_id: string;
  role?: string;
  assigned_at?: string;
}

export interface TaskOpenQuestion {
  id: string;
  question: string;
  resolved: boolean;
  resolution?: string;
}

export interface TaskBlocker {
  id: string;
  description: string;
  resolved: boolean;
  resolution?: string;
}

export interface TaskRecord {
  id: string;
  namespace_id: string;
  project_id: string | null;
  title: string;
  initial_request_summary: string | null;
  confirmed_specification: Record<string, unknown> | string;
  constraints: string[];
  assumptions: string[];
  acceptance_criteria: AcceptanceCriterion[];
  status: TaskStatus;
  priority: TaskPriority;
  current_stage: string | null;
  assignments: TaskAssignment[];
  dependency_refs: string[];
  open_questions: TaskOpenQuestion[];
  blockers: TaskBlocker[];
  verification_status: TaskVerificationStatus;
  version: number;
  provenance: ProvenanceInfo | null;
  created_at: string;
  updated_at: string;
}

export interface DecisionOption {
  option_id: string;
  description: string;
  selection_probability?: number | null;
  suitability_score?: number | null;
  route_status?: string | null;
  evidence_refs: string[];
}

export interface DecisionRecord {
  id: string;
  namespace_id: string;
  task_id: string;
  state_version_observed: number;
  objective: string;
  options: DecisionOption[];
  chosen_option: string;
  selection_basis: string | null;
  assessment_confidence: number | null;
  escalation: string | null;
  evidence_refs: string[];
  provenance: ProvenanceInfo | null;
  created_at: string;
}

export interface ArtifactRecord {
  id: string;
  namespace_id: string;
  task_id: string | null;
  project_id: string | null;
  name: string;
  description: string | null;
  type: string;
  relative_path_or_external_reference: string;
  mime_type: string | null;
  size_bytes: number | null;
  checksum: string | null;
  provenance: ProvenanceInfo | null;
  verification_status: ArtifactVerificationStatus;
  created_at: string;
}

export interface RuntimeRouteRecord {
  id: string;
  namespace_id: string;
  task_id: string;
  route_summary: string;
  status: RuntimeRouteStatus;
  assessment_confidence: number | null;
  selection_probability: number | null;
  suitability_score: number | null;
  observations: string[];
  evidence_refs: string[];
  next_action: string | null;
  created_at: string;
}

export interface CapabilityObservationRecord {
  id: string;
  namespace_id: string;
  machine_or_runtime_id: string;
  kind: CapabilityObservationKind;
  backend: string | null;
  observations: Record<string, unknown>;
  measurement_method: string | null;
  measured_at: string;
  valid_until: string | null;
  source_receipt_id: string | null;
  created_at: string;
  freshness?: {
    is_stale: boolean;
    status: 'fresh' | 'stale' | 'expired';
    age_seconds: number;
    evaluated_at: string;
  };
}

export interface ReceiptRecord {
  id: string;
  namespace_id: string;
  task_id: string | null;
  project_id: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  event_type: string;
  operation: string;
  actor_attribution: string | null;
  timestamp: string;
  outcome: ReceiptOutcome;
  summary: string;
  evidence_refs: string[];
  artifact_refs: string[];
  state_versions: Record<string, number> | null;
  metadata: Record<string, unknown> | null;
}

export interface KnowledgeNavigationRecord {
  id: string;
  namespace_id: string;
  task_id: string;
  domain: string;
  subject: string;
  chapter_or_concept: string;
  prerequisite_refs: string[];
  source_refs: string[];
  current_position: string;
  unresolved_items: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Security & Validation Utilities
// ============================================================================

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bsk-proj-[a-zA-Z0-9_-]{20,}\b/,
  /\bghp_[a-zA-Z0-9]{25,}\b/,
  /\bgithub_pat_[a-zA-Z0-9_]{25,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/,
  /\b(?:password|passwd|secret|api_key|apikey|access_token|private_key|client_secret)\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/i,
];

export function containsSecret(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

export function assertNoSecrets(value: unknown, fieldName: string): void {
  if (typeof value === 'string') {
    if (containsSecret(value)) {
      throw new PcmError(
        'INVALID_INPUT',
        `Rejected credential or secret pattern in "${fieldName}". PCM must never store credentials/secrets.`,
        { field: fieldName, reason: 'SECRET_DETECTED' }
      );
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoSecrets(value[i], `${fieldName}[${i}]`);
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(password|passwd|secret|api_key|apikey|access_token|private_key|client_secret|auth_token)$/i.test(k)) {
        throw new PcmError(
          'INVALID_INPUT',
          `Rejected secret key "${k}" in "${fieldName}". PCM must never store credentials/secrets.`,
          { field: `${fieldName}.${k}`, reason: 'SECRET_KEY_DETECTED' }
        );
      }
      assertNoSecrets(v, `${fieldName}.${k}`);
    }
  }
}

export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    let out: string = value;
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(new RegExp(pattern.source, 'gi'), '[REDACTED_SECRET]');
    }
    return out as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(password|passwd|secret|api_key|apikey|access_token|private_key|client_secret|auth_token)$/i.test(k)) {
        out[k] = '[REDACTED_SECRET]';
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

export function assertNoCallerNamespaceSpoofing(
  input: unknown,
  configuredNamespace: string
): void {
  if (!input || typeof input !== 'object') {
    return;
  }
  const obj = input as Record<string, unknown>;
  for (const key of ['namespace', 'namespace_id', 'target_namespace', 'ns']) {
    if (key in obj && obj[key] !== undefined) {
      throw new PcmError(
        'NAMESPACE_MISMATCH',
        `Caller-supplied "${key}" is forbidden; namespace authority is strictly bound by server configuration ("${configuredNamespace}").`,
        {
          forbidden_field: key,
          supplied_value: obj[key],
          configured_namespace: configuredNamespace,
        }
      );
    }
  }
}

export function assertObject(input: unknown, label = 'input'): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PcmError('INVALID_INPUT', `Expected ${label} to be a non-null object`);
  }
  return input as Record<string, unknown>;
}

export function assertNonEmptyString(
  val: unknown,
  field: string,
  maxLen: number = MAX_TEXT_LENGTH
): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new PcmError('INVALID_INPUT', `Field "${field}" must be a non-empty string`, { field });
  }
  if (val.length > maxLen) {
    throw new PcmError(
      'INVALID_INPUT',
      `Field "${field}" exceeds maximum length of ${maxLen} characters`,
      { field, maxLen, actualLen: val.length }
    );
  }
  if (val.includes('\0')) {
    throw new PcmError('INVALID_INPUT', `Field "${field}" contains forbidden null byte`, { field });
  }
  return val;
}

export function assertOptionalString(
  val: unknown,
  field: string,
  maxLen: number = MAX_TEXT_LENGTH
): string | null {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val !== 'string') {
    throw new PcmError('INVALID_INPUT', `Field "${field}" must be a string when provided`, {
      field,
    });
  }
  if (val.length > maxLen) {
    throw new PcmError(
      'INVALID_INPUT',
      `Field "${field}" exceeds maximum length of ${maxLen} characters`,
      { field, maxLen, actualLen: val.length }
    );
  }
  if (val.includes('\0')) {
    throw new PcmError('INVALID_INPUT', `Field "${field}" contains forbidden null byte`, { field });
  }
  return val;
}

export function assertEnum<T extends string>(
  val: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (typeof val !== 'string' || !allowed.includes(val as T)) {
    throw new PcmError(
      'INVALID_INPUT',
      `Field "${field}" must be one of: ${allowed.join(', ')}`,
      { field, allowed, received: val }
    );
  }
  return val as T;
}

export function assertExpectedVersion(val: unknown, field = 'expected_version'): number {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
    throw new PcmError(
      'INVALID_INPUT',
      `Field "${field}" is required and must be a non-negative integer`,
      { field, received: val }
    );
  }
  return val;
}

export function assertUnitInterval(val: unknown, field: string): number | null {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
    throw new PcmError(
      'INVALID_INPUT',
      `Field "${field}" must be a finite number between 0.0 and 1.0 inclusive`,
      { field, received: val }
    );
  }
  return val;
}

export function assertStringArray(
  val: unknown,
  field: string,
  maxItems: number = MAX_ARRAY_ITEMS,
  maxItemLen: number = MAX_SHORT_TEXT_LENGTH
): string[] {
  if (val === undefined || val === null) {
    return [];
  }
  if (!Array.isArray(val)) {
    throw new PcmError('INVALID_INPUT', `Field "${field}" must be an array of strings`, { field });
  }
  if (val.length > maxItems) {
    throw new PcmError(
      'INVALID_INPUT',
      `Field "${field}" exceeds maximum array length of ${maxItems}`,
      { field, maxItems, actualItems: val.length }
    );
  }
  return val.map((item, idx) => assertNonEmptyString(item, `${field}[${idx}]`, maxItemLen));
}

export function validatePagination(input: Record<string, unknown>): {
  limit: number;
  offset: number;
} {
  let limit = DEFAULT_PAGE_LIMIT;
  let offset = 0;

  if (input.limit !== undefined && input.limit !== null) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_PAGE_LIMIT
    ) {
      throw new PcmError(
        'INVALID_INPUT',
        `Pagination "limit" must be an integer between 1 and ${MAX_PAGE_LIMIT}`,
        { field: 'limit', received: input.limit }
      );
    }
    limit = input.limit;
  }

  if (input.offset !== undefined && input.offset !== null) {
    if (typeof input.offset !== 'number' || !Number.isInteger(input.offset) || input.offset < 0) {
      throw new PcmError('INVALID_INPUT', 'Pagination "offset" must be a non-negative integer', {
        field: 'offset',
        received: input.offset,
      });
    }
    offset = input.offset;
  }

  return { limit, offset };
}

// ============================================================================
// Task Status Transition Validation
// ============================================================================

const ALLOWED_TASK_STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['draft', 'ready', 'active', 'needs_user', 'blocked', 'archived'],
  ready: ['ready', 'draft', 'active', 'blocked', 'needs_user', 'archived'],
  active: [
    'active',
    'ready',
    'blocked',
    'needs_user',
    'needs_verification',
    'completed',
    'failed',
    'archived',
  ],
  blocked: ['blocked', 'ready', 'active', 'needs_user', 'failed', 'archived'],
  needs_user: ['needs_user', 'draft', 'ready', 'active', 'blocked', 'failed', 'archived'],
  needs_verification: [
    'needs_verification',
    'active',
    'blocked',
    'needs_user',
    'completed',
    'failed',
    'archived',
  ],
  completed: ['completed', 'needs_verification', 'active', 'archived'],
  failed: ['failed', 'draft', 'ready', 'active', 'archived'],
  archived: ['archived'],
};

export function validateTaskStatusTransition(
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  verificationStatus: TaskVerificationStatus,
  acceptanceCriteria: AcceptanceCriterion[],
  blockers: TaskBlocker[]
): void {
  const allowedTargets = ALLOWED_TASK_STATUS_TRANSITIONS[fromStatus] ?? [];
  if (!allowedTargets.includes(toStatus)) {
    throw new PcmError(
      'INVALID_STATE_TRANSITION',
      `Invalid task status transition from "${fromStatus}" to "${toStatus}"`,
      { from: fromStatus, to: toStatus, allowed: allowedTargets }
    );
  }

  if (toStatus === 'completed') {
    if (verificationStatus !== 'passed' && verificationStatus !== 'not_required') {
      throw new PcmError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition task to "completed" while verification_status is "${verificationStatus}" (must be "passed" or "not_required")`,
        { to: toStatus, verification_status: verificationStatus }
      );
    }

    const unmetMandatory = acceptanceCriteria.filter((c) => c.mandatory && !c.met);
    if (unmetMandatory.length > 0) {
      throw new PcmError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition task to "completed": ${unmetMandatory.length} mandatory acceptance criteria are unmet`,
        {
          to: toStatus,
          unmet_criteria_ids: unmetMandatory.map((c) => c.id),
        }
      );
    }

    const unresolvedBlockers = blockers.filter((b) => !b.resolved);
    if (unresolvedBlockers.length > 0) {
      throw new PcmError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition task to "completed": ${unresolvedBlockers.length} blocker(s) remain unresolved`,
        {
          to: toStatus,
          unresolved_blocker_ids: unresolvedBlockers.map((b) => b.id),
        }
      );
    }
  }
}

// ============================================================================
// Artifact Path Validation (Reject traversal, absolute paths, symlink escapes)
// ============================================================================

export function validateArtifactReference(
  ref: string,
  artifactRoot: string
): { normalizedRef: string; isExternalUri: boolean } {
  const trimmed = assertNonEmptyString(
    ref,
    'relative_path_or_external_reference',
    MAX_POINTER_TEXT_LENGTH
  ).trim();

  // Check if external URI (only safe non-local reference schemes allowed as passive external reference, never fetched)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    if (/^file:\/\//i.test(trimmed)) {
      throw new PcmError(
        'PATH_NOT_ALLOWED',
        'file:// URIs are not permitted; use a relative path inside the configured artifact root',
        { reference: trimmed }
      );
    }
    if (/^https?:\/\//i.test(trimmed) || /^urn:/i.test(trimmed) || /^s3:\/\//i.test(trimmed)) {
      // Check for embedded traversal tricks
      return { normalizedRef: trimmed, isExternalUri: true };
    }
    throw new PcmError(
      'PATH_NOT_ALLOWED',
      `Unsupported URI scheme in artifact reference: "${trimmed}"`,
      { reference: trimmed }
    );
  }

  // Reject Windows drive letters or leading slashes or backslashes
  if (
    path.isAbsolute(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[a-zA-Z]:/.test(trimmed) ||
    trimmed.includes('\\')
  ) {
    throw new PcmError(
      'PATH_NOT_ALLOWED',
      `Artifact path must be a relative POSIX path inside PCM_ARTIFACT_ROOT: "${trimmed}"`,
      { reference: trimmed }
    );
  }

  // Split path segments and reject '..' or '.' segments
  const rawSegments = trimmed.split('/');
  for (const seg of rawSegments) {
    if (seg === '..' || seg === '.' || seg.length === 0) {
      throw new PcmError(
        'PATH_NOT_ALLOWED',
        `Path traversal or empty segment is forbidden in artifact reference: "${trimmed}"`,
        { reference: trimmed }
      );
    }
  }

  const resolvedRoot = path.resolve(artifactRoot);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const realRoot = fs.realpathSync(resolvedRoot);

  const candidateAbs = path.resolve(resolvedRoot, trimmed);
  if (candidateAbs !== resolvedRoot && !candidateAbs.startsWith(resolvedRoot + path.sep)) {
    throw new PcmError(
      'PATH_NOT_ALLOWED',
      `Resolved artifact path escapes PCM_ARTIFACT_ROOT: "${trimmed}"`,
      { reference: trimmed }
    );
  }

  // Walk each existing prefix component to detect symlink escapes
  let currentPath = resolvedRoot;
  for (const seg of rawSegments) {
    currentPath = path.join(currentPath, seg);
    if (fs.existsSync(currentPath)) {
      const stat = fs.lstatSync(currentPath);
      if (stat.isSymbolicLink()) {
        let realTarget: string;
        try {
          realTarget = fs.realpathSync(currentPath);
        } catch {
          throw new PcmError(
            'PATH_NOT_ALLOWED',
            `Broken or unresolvable symlink in artifact path: "${trimmed}"`,
            { reference: trimmed }
          );
        }
        if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
          throw new PcmError(
            'PATH_NOT_ALLOWED',
            `Symlink in artifact path points outside PCM_ARTIFACT_ROOT: "${trimmed}"`,
            { reference: trimmed, symlink_target: realTarget }
          );
        }
      } else {
        const realCurrent = fs.realpathSync(currentPath);
        if (realCurrent !== realRoot && !realCurrent.startsWith(realRoot + path.sep)) {
          throw new PcmError(
            'PATH_NOT_ALLOWED',
            `Real path escapes PCM_ARTIFACT_ROOT: "${trimmed}"`,
            { reference: trimmed }
          );
        }
      }
    } else {
      // Also check lstatSync in case of dangling symlink where existsSync returns false!
      try {
        const lstat = fs.lstatSync(currentPath);
        if (lstat.isSymbolicLink()) {
          throw new PcmError(
            'PATH_NOT_ALLOWED',
            `Dangling symlink is forbidden in artifact path: "${trimmed}"`,
            { reference: trimmed }
          );
        }
      } catch (err) {
        if (err instanceof PcmError) {
          throw err;
        }
        // ENOENT is fine for not-yet-created file inside valid directory
      }
    }
  }

  return { normalizedRef: rawSegments.join('/'), isExternalUri: false };
}

// ============================================================================
// Deterministic Canonical JSON & Hashing for Idempotency
// ============================================================================

export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeJson(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(String(value));
}

export function computePayloadHash(operation: string, payload: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'idempotency_key' || k === 'correlation_id' || k === '_test_force_fail_after_mutation') {
      continue;
    }
    copy[k] = v;
  }
  const canonical = canonicalizeJson({ operation, payload: copy });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
