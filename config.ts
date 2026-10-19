import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface PcmConfig {
  dataDir: string;
  dbPath: string;
  namespace: string;
  artifactRoot: string;
  exportDir: string;
  logLevel: LogLevel;
}

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const VALID_NAMESPACE_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export function loadConfig(overrides?: Partial<PcmConfig> & { env?: NodeJS.ProcessEnv }): PcmConfig {
  const env = overrides?.env ?? process.env;

  const defaultDataDir = path.join(os.homedir(), '.local', 'share', 'zyrog2i-pcm');
  const rawDataDir = overrides?.dataDir ?? env.PCM_DATA_DIR ?? defaultDataDir;
  const dataDir = path.resolve(rawDataDir);

  const rawNamespace = (overrides?.namespace ?? env.PCM_NAMESPACE ?? 'default').trim();
  if (!VALID_NAMESPACE_RE.test(rawNamespace)) {
    throw new Error(
      `Invalid PCM_NAMESPACE "${rawNamespace}": must be 1-64 characters matching [a-zA-Z0-9._-]`
    );
  }

  const rawArtifactRoot =
    overrides?.artifactRoot ?? env.PCM_ARTIFACT_ROOT ?? path.join(dataDir, 'artifacts');
  const artifactRoot = path.resolve(rawArtifactRoot);

  const rawExportDir =
    overrides?.exportDir ?? env.PCM_EXPORT_DIR ?? path.join(dataDir, 'exports');
  const exportDir = path.resolve(rawExportDir);

  const rawLogLevel = (overrides?.logLevel ?? env.PCM_LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel: LogLevel =
    rawLogLevel === 'debug' ||
    rawLogLevel === 'info' ||
    rawLogLevel === 'warn' ||
    rawLogLevel === 'error' ||
    rawLogLevel === 'silent'
      ? rawLogLevel
      : 'info';

  const dbPath = overrides?.dbPath
    ? path.resolve(overrides.dbPath)
    : path.join(dataDir, 'pcm.sqlite');

  return {
    dataDir,
    dbPath,
    namespace: rawNamespace,
    artifactRoot,
    exportDir,
    logLevel,
  };
}

export function ensureConfiguredDirectories(config: PcmConfig): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.artifactRoot, { recursive: true });
  fs.mkdirSync(config.exportDir, { recursive: true });
}

export class StderrLogger {
  private readonly minPriority: number;
  private readonly namespace: string;

  constructor(level: LogLevel = 'info', namespace: string = 'default') {
    this.minPriority = LOG_PRIORITY[level] ?? LOG_PRIORITY.info;
    this.namespace = namespace;
  }

  private write(level: Exclude<LogLevel, 'silent'>, message: string, meta?: Record<string, unknown>): void {
    if (LOG_PRIORITY[level] < this.minPriority) {
      return;
    }
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      ns: this.namespace,
      msg: message,
    };
    if (meta && Object.keys(meta).length > 0) {
      payload.meta = meta;
    }
    // Invariant: Under stdio, stdout is protocol-only; diagnostics go strictly to stderr.
    process.stderr.write(JSON.stringify(payload) + '\n');
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }
}
