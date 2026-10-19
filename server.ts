import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PcmConfig, StderrLogger, ensureConfiguredDirectories, loadConfig } from '../config';
import { PcmService } from '../services/pcm-service';
import { SqliteDatabase } from '../storage/database';
import { PCM_TOOLS, executeToolCall } from './tools';

export interface PcmMcpRuntime {
  config: PcmConfig;
  logger: StderrLogger;
  db: SqliteDatabase;
  service: PcmService;
  server: Server;
  startStdio: () => Promise<void>;
  close: () => Promise<void>;
}

export function createPcmMcpServer(configOverrides?: Partial<PcmConfig>): PcmMcpRuntime {
  const config = loadConfig(configOverrides);
  const logger = new StderrLogger(config.logLevel, config.namespace);

  ensureConfiguredDirectories(config);
  const db = new SqliteDatabase(config.dbPath);
  const migrationResult = db.runMigrations();
  logger.info('SQLite database initialized and migrations verified', {
    dbPath: config.dbPath,
    namespace: config.namespace,
    currentSchemaVersion: migrationResult.currentVersion,
    appliedMigrations: migrationResult.appliedVersions,
  });

  const service = new PcmService(db, config, logger);

  const server = new Server(
    {
      name: 'zyrog2i-pcm-deployment-mcp',
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: PCM_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: {
          readOnlyHint: t.readOnlyHint,
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }) => {
    const toolName = request.params.name;
    const rawArgs = request.params.arguments ?? {};
    return executeToolCall(service, toolName, rawArgs);
  });

  let transport: StdioServerTransport | null = null;

  return {
    config,
    logger,
    db,
    service,
    server,
    startStdio: async () => {
      transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info('PCM MCP stdio server started and awaiting JSON-RPC 2.0 messages');
    },
    close: async () => {
      try {
        if (transport) {
          await server.close();
          transport = null;
        }
      } finally {
        db.close();
        logger.info('PCM MCP server and SQLite connection closed cleanly');
      }
    },
  };
}
