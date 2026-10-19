#!/usr/bin/env node
import { createPcmMcpServer } from './mcp/server';

async function main(): Promise<void> {
  // Redirect console.log / console.info / console.warn to stderr so stdout remains strictly MCP JSON-RPC protocol-only
  const writeStderr = (...args: unknown[]): void => {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      }) + '\n'
    );
  };
  console.log = writeStderr;
  console.info = writeStderr;
  console.warn = writeStderr;

  const runtime = createPcmMcpServer();

  const shutdown = async (signal: string): Promise<void> => {
    runtime.logger.info(`Received ${signal}; shutting down PCM MCP server`);
    await runtime.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await runtime.startStdio();
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'Fatal startup error in PCM MCP server',
        error: err instanceof Error ? err.message : String(err),
      }) + '\n'
    );
    process.exit(1);
  });
}

export { createPcmMcpServer };
