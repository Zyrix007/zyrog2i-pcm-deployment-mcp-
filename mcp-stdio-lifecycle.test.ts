import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SYNTHETIC_FIXTURES, TestCaseResult, runTestCases } from '../fixtures/synthetic-fixtures';

interface ParsedToolResponse {
  ok: boolean;
  tool?: string;
  data?: any;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

function parseToolResult(result: any): ParsedToolResponse {
  assert.ok(result && Array.isArray(result.content) && result.content.length > 0);
  const first = result.content[0];
  assert.strictEqual(first.type, 'text');
  return JSON.parse(first.text) as ParsedToolResponse;
}

async function createConnectedClient(envVars: Record<string, string>): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const serverEntry = path.resolve(process.cwd(), 'dist/index.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: envVars,
  });
  const client = new Client(
    { name: 'pcm-integration-test-client', version: '2.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, transport };
}

export async function runSuite(): Promise<TestCaseResult[]> {
  return runTestCases([
    {
      name: 'MCP stdio client initializes, lists narrow tools, calls health, persists across process restart, and keeps stdout protocol-only',
      fn: async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-mcp-stdio-'));
        const envVars = {
          PCM_DATA_DIR: path.join(tempRoot, 'data'),
          PCM_NAMESPACE: 'prod_zyro_ns',
          PCM_ARTIFACT_ROOT: path.join(tempRoot, 'artifacts'),
          PCM_EXPORT_DIR: path.join(tempRoot, 'exports'),
          PCM_LOG_LEVEL: 'info',
        };

        try {
          // --- Process Instance #1 ---
          const { client: client1, transport: transport1 } = await createConnectedClient(envVars);

          // 1. List tools and verify narrow typed tools exist
          const toolsList = await client1.listTools();
          assert.ok(Array.isArray(toolsList.tools));
          const toolNames = new Set(toolsList.tools.map((t: any) => t.name));
          const expectedTools = [
            'pcm_health',
            'pcm_context_bundle_get',
            'pcm_profile_get',
            'pcm_profile_update',
            'pcm_memory_create',
            'pcm_memory_search',
            'pcm_memory_update',
            'pcm_memory_archive',
            'pcm_memory_forget',
            'pcm_project_create',
            'pcm_project_get',
            'pcm_project_list',
            'pcm_project_update',
            'pcm_task_create',
            'pcm_task_get',
            'pcm_task_list',
            'pcm_task_update',
            'pcm_decision_append',
            'pcm_decision_list',
            'pcm_artifact_register',
            'pcm_artifact_list',
            'pcm_receipt_append',
            'pcm_receipt_search',
            'pcm_runtime_route_append',
            'pcm_runtime_route_list',
            'pcm_capability_observation_record',
            'pcm_capability_observation_get',
            'pcm_knowledge_navigation_get',
            'pcm_knowledge_navigation_update',
            'pcm_knowledge_navigation_get_update',
            'pcm_snapshot_export',
          ];
          for (const reqTool of expectedTools) {
            assert.ok(toolNames.has(reqTool), `Missing required MCP tool: ${reqTool}`);
          }

          // 2. Call pcm_health
          const healthRes = parseToolResult(
            await client1.callTool({ name: 'pcm_health', arguments: {} })
          );
          assert.strictEqual(healthRes.ok, true);
          assert.strictEqual(healthRes.data.status, 'ready');
          assert.strictEqual(healthRes.data.namespace, 'prod_zyro_ns');
          assert.strictEqual(healthRes.data.schema.foreign_keys_enabled, true);

          // 3. Create project, task, memory, knowledge_navigation, artifact
          const projRes = parseToolResult(
            await client1.callTool({
              name: 'pcm_project_create',
              arguments: SYNTHETIC_FIXTURES.projectAlpha,
            })
          );
          assert.strictEqual(projRes.ok, true);
          const projectId = projRes.data.entity.id;

          const taskRes = parseToolResult(
            await client1.callTool({
              name: 'pcm_task_create',
              arguments: {
                ...SYNTHETIC_FIXTURES.taskPrimary,
                project_id: projectId,
              },
            })
          );
          assert.strictEqual(taskRes.ok, true);
          const taskId = taskRes.data.entity.id;

          const knavRes = parseToolResult(
            await client1.callTool({
              name: 'pcm_knowledge_navigation_get_update',
              arguments: {
                action: 'update',
                task_id: taskId,
                expected_version: 0,
                domain: 'mcp_runtime',
                subject: 'stdio_transport',
                chapter_or_concept: 'jsonrpc_framing',
                current_position: 'verified_handshake',
                prerequisite_refs: ['spec_v2'],
                source_refs: ['mcp_spec_2024_11_05'],
                unresolved_items: [],
              },
            })
          );
          assert.strictEqual(knavRes.ok, true);
          assert.strictEqual(knavRes.data.entity.version, 1);

          // Verify stdout is strictly JSON-RPC 2.0 protocol messages and diagnostics are on stderr
          const stdoutLines1 = (transport1 as any).getRawStdoutLines() as string[];
          const stderrText1 = (transport1 as any).getStderrOutput() as string;
          assert.ok(stdoutLines1.length > 0, 'Expected JSON-RPC messages on stdout');
          for (const line of stdoutLines1) {
            const parsedLine = JSON.parse(line);
            assert.strictEqual(
              parsedLine.jsonrpc,
              '2.0',
              `Non-JSON-RPC line emitted on stdout: ${line}`
            );
          }
          assert.ok(
            stderrText1.includes('SQLite database initialized and migrations verified'),
            'Expected structured diagnostic logs on stderr'
          );

          // 4. Stop Process Instance #1
          await client1.close();

          // --- Process Instance #2 (Restart against same PCM_DATA_DIR) ---
          const { client: client2 } = await createConnectedClient(envVars);

          const persistedProjRes = parseToolResult(
            await client2.callTool({
              name: 'pcm_project_get',
              arguments: { id: projectId },
            })
          );
          assert.strictEqual(persistedProjRes.ok, true);
          assert.strictEqual(persistedProjRes.data.name, SYNTHETIC_FIXTURES.projectAlpha.name);
          assert.deepStrictEqual(persistedProjRes.data.task_ids, [taskId]);

          const persistedTaskRes = parseToolResult(
            await client2.callTool({
              name: 'pcm_task_get',
              arguments: { id: taskId },
            })
          );
          assert.strictEqual(persistedTaskRes.ok, true);
          assert.strictEqual(persistedTaskRes.data.title, SYNTHETIC_FIXTURES.taskPrimary.title);
          assert.strictEqual(persistedTaskRes.data.version, 1);

          const persistedKnavRes = parseToolResult(
            await client2.callTool({
              name: 'pcm_knowledge_navigation_get_update',
              arguments: {
                action: 'get',
                task_id: taskId,
              },
            })
          );
          assert.strictEqual(persistedKnavRes.ok, true);
          assert.strictEqual(
            persistedKnavRes.data.navigation.current_position,
            'verified_handshake'
          );

          await client2.close();
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      },
    },
  ]);
}
