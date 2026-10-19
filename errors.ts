export const PCM_ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'PERMISSION_DENIED',
  'NAMESPACE_MISMATCH',
  'INVALID_STATE_TRANSITION',
  'DUPLICATE_IDEMPOTENCY_KEY',
  'STORAGE_UNAVAILABLE',
  'MIGRATION_FAILED',
  'PATH_NOT_ALLOWED',
  'CONFIRMATION_REQUIRED',
  'INTEGRITY_ERROR',
  'INTERNAL_ERROR',
] as const;

export type PcmErrorCode = (typeof PCM_ERROR_CODES)[number];

export interface PcmErrorShape {
  code: PcmErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class PcmError extends Error {
  public readonly code: PcmErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: PcmErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PcmError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, PcmError.prototype);
  }

  toJSON(): PcmErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isPcmError(err: unknown): err is PcmError {
  return (
    err instanceof PcmError ||
    (typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      typeof (err as { code?: unknown }).code === 'string' &&
      (PCM_ERROR_CODES as readonly string[]).includes((err as { code: string }).code))
  );
}

export function normalizeError(err: unknown): PcmError {
  if (err instanceof PcmError) {
    return err;
  }
  if (isPcmError(err)) {
    const shaped = err as PcmErrorShape;
    return new PcmError(shaped.code, shaped.message, shaped.details);
  }
  if (err instanceof Error) {
    if (err.message.includes('FOREIGN KEY constraint failed') || err.message.includes('SQLITE_ERROR (787)')) {
      return new PcmError('INTEGRITY_ERROR', 'Foreign key constraint failed', {
        cause: err.message,
      });
    }
    if (err.message.includes('STORAGE_UNAVAILABLE')) {
      return new PcmError('STORAGE_UNAVAILABLE', err.message);
    }
    return new PcmError('INTERNAL_ERROR', err.message);
  }
  return new PcmError('INTERNAL_ERROR', String(err));
}
