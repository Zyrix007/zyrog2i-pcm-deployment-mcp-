import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { PcmError } from '../../src/domain/errors';
import { executeToolCall } from '../../src/mcp/tools';
import {
  SYNTHETIC_FIXTURES,
  TestCaseResult,
  createIsolatedTestEnv,
  runTestCases,
} from '../fixtures/synthetic-fixtures';

function expectErrorCode(fn: () => unknown, expectedCode: string): PcmError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PcmError, `Expected PcmError, got ${String(err)}`);
    assert.strictEqual(
      err.code,
      expectedCode,
      `Expected ${expectedCode}, got ${err.code}: ${err.message}`
    );
    return err;
  }
  assert.fail(`Expected PcmError(${expectedCode}), but operation succeeded`);
}

export async function runSuite(): Promise<TestCaseResult[]> {
  return runTestCases([
    {
      name: 'Rejects caller namespace spoofing and cross-namespace entity access with NAMESPACE_MISMATCH',
      fn: () => {
        const env = createIsolatedTestEnv('authority_ns');
        try {
          // 1. Caller attempts to pass `namespace` or `namespace_id` in tool input
          expectErrorCode(
            () =>
              env.service.projectCreate({
                name: 'Spoofed Project',
                namespace: 'attacker_ns',
              }),
            'NAMESPACE_MISMATCH'
          );

          expectErrorCode(
            () =>
              env.service.taskList({
                namespace_id: 'attacker_ns',
              }),
            'NAMESPACE_MISMATCH'
          );

          // 2. Direct cross-namespace entity ID access is rejected with NAMESPACE_MISMATCH
          env.db.run(
            `INSERT INTO projects (
              id, namespace_id, name, objectives_json, constraints_json, status, version, created_at, updated_at
            ) VALUES ('proj_foreign', 'foreign_ns', 'Foreign Project', '[]', '[]', 'active', 1, ?, ?)`,
            [new Date().toISOString(), new Date().toISOString()]
          );

          expectErrorCode(
            () => env.service.projectGet({ id: 'proj_foreign' }),
            'NAMESPACE_MISMATCH'
          );

          // Also verify through MCP tool dispatcher
          const mcpRes = executeToolCall(env.service, 'pcm_project_get', {
            id: 'proj_foreign',
          });
          assert.strictEqual(mcpRes.isError, true);
          assert.strictEqual((mcpRes.structuredContent as any).error.code, 'NAMESPACE_MISMATCH');
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Rejects artifact path traversal, absolute paths, file:// URIs, and symlink escapes with PATH_NOT_ALLOWED',
      fn: () => {
        const env = createIsolatedTestEnv('sec_paths');
        try {
          const proj = env.service.projectCreate(SYNTHETIC_FIXTURES.projectAlpha).entity;

          // 1. Relative traversal '../'
          expectErrorCode(
            () =>
              env.service.artifactRegister({
                project_id: proj.id,
                name: 'Traversal 1',
                type: 'report',
                relative_path_or_external_reference: '../outside.txt',
              }),
            'PATH_NOT_ALLOWED'
          );

          // 2. Nested traversal 'reports/../../secret.db'
          expectErrorCode(
            () =>
              env.service.artifactRegister({
                project_id: proj.id,
                name: 'Traversal 2',
                type: 'report',
                relative_path_or_external_reference: 'reports/../../secret.db',
              }),
            'PATH_NOT_ALLOWED'
          );

          // 3. Absolute path '/etc/passwd'
          expectErrorCode(
            () =>
              env.service.artifactRegister({
                project_id: proj.id,
                name: 'Abs Path',
                type: 'config',
                relative_path_or_external_reference: '/etc/passwd',
              }),
            'PATH_NOT_ALLOWED'
          );

          // 4. file:// URI
          expectErrorCode(
            () =>
              env.service.artifactRegister({
                project_id: proj.id,
                name: 'File URI',
                type: 'config',
                relative_path_or_external_reference: 'file:///etc/hosts',
              }),
            'PATH_NOT_ALLOWED'
          );

          // 5. Symlink escape inside PCM_ARTIFACT_ROOT pointing outside PCM_ARTIFACT_ROOT
          const outsideFile = path.join(env.tempRoot, 'outside-secret.txt');
          fs.writeFileSync(outsideFile, 'top-secret', 'utf8');
          const symlinkInsideRoot = path.join(env.config.artifactRoot, 'escaped-link.txt');
          fs.symlinkSync(outsideFile, symlinkInsideRoot);

          expectErrorCode(
            () =>
              env.service.artifactRegister({
                project_id: proj.id,
                name: 'Symlink Escape',
                type: 'secret',
                relative_path_or_external_reference: 'escaped-link.txt',
              }),
            'PATH_NOT_ALLOWED'
          );

          // 6. Valid relative path inside PCM_ARTIFACT_ROOT succeeds and defaults to verification_status='unverified'
          const validFile = path.join(env.config.artifactRoot, 'sub', 'valid-report.json');
          fs.mkdirSync(path.dirname(validFile), { recursive: true });
          fs.writeFileSync(validFile, '{"ok":true}', 'utf8');

          const registered = env.service.artifactRegister({
            project_id: proj.id,
            name: 'Valid Report',
            type: 'report',
            relative_path_or_external_reference: 'sub/valid-report.json',
          }).entity;
          assert.strictEqual(registered.verification_status, 'unverified');
          assert.strictEqual(
            registered.relative_path_or_external_reference,
            'sub/valid-report.json'
          );
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Rejects unapproved profile fields and credential/secret storage across tools',
      fn: () => {
        const env = createIsolatedTestEnv('sec_profile_secrets');
        try {
          // 1. Unapproved profile field trying to disable safety/verification
          expectErrorCode(
            () =>
              env.service.profileUpdate({
                expected_version: 1,
                tone: 'direct',
                disable_safety_checks: true,
              }),
            'INVALID_INPUT'
          );

          expectErrorCode(
            () =>
              env.service.profileUpdate({
                expected_version: 1,
                override_truthfulness: 'always_agree',
              }),
            'INVALID_INPUT'
          );

          // 2. Reject storing API keys / secrets in memories
          expectErrorCode(
            () =>
              env.service.memoryCreate({
                content: 'Use production key sk-1234567890abcdef1234567890abcdef for requests',
                type: 'confirmed_fact',
                scope: 'user',
              }),
            'INVALID_INPUT'
          );

          expectErrorCode(
            () =>
              env.service.memoryCreate({
                content: 'GitHub token ghp_1234567890abcdefghijklmnopqrstuvwx',
                type: 'working_note',
                scope: 'user',
              }),
            'INVALID_INPUT'
          );
        } finally {
          env.cleanup();
        }
      },
    },

    {
      name: 'Permanent memory forgetting requires explicit confirmation and purges active storage, search indexes, and receipts',
      fn: () => {
        const env = createIsolatedTestEnv('sec_forget');
        try {
          const uniqueSensitiveMarker = 'UNIQUE_SENSITIVE_PHRASE_X99281_PURGE_ME';
          const created = env.service.memoryCreate({
            content: `User temporary confidential note: ${uniqueSensitiveMarker}`,
            type: 'working_note',
            scope: 'user',
            tags: ['ephemeral_tag_x99281'],
          }).entity;

          // Verify searchable before forget
          const searchBefore = env.service.memorySearch({ query: 'x99281' });
          assert.strictEqual(searchBefore.total_count, 1);

          // 1. Forgetting without confirmation fails with CONFIRMATION_REQUIRED
          expectErrorCode(
            () =>
              env.service.memoryForget({
                id: created.id,
              }),
            'CONFIRMATION_REQUIRED'
          );

          expectErrorCode(
            () =>
              env.service.memoryForget({
                id: created.id,
                confirm_permanent_delete: true,
                confirmation_phrase: 'WRONG_PHRASE',
              }),
            'CONFIRMATION_REQUIRED'
          );

          // 2. Confirmed permanent forgetting succeeds
          const forgot = env.service.memoryForget({
            id: created.id,
            expected_version: 1,
            confirm_permanent_delete: true,
            confirmation_phrase: 'PERMANENTLY_FORGET',
          });
          assert.strictEqual(forgot.entity.purged, true);

          // 3. Verify absent from memorySearch, memories table, memories_search_index table, and receipts table
          const searchAfter = env.service.memorySearch({
            query: 'x99281',
            include_all_statuses: true,
          });
          assert.strictEqual(searchAfter.total_count, 0);

          const rawMemRows = env.db.all('SELECT * FROM memories WHERE id = ?', [created.id]);
          assert.strictEqual(rawMemRows.length, 0);

          const rawIdxRows = env.db.all(
            'SELECT * FROM memories_search_index WHERE memory_id = ? OR searchable_text LIKE ?',
            [created.id, `%${uniqueSensitiveMarker.toLowerCase()}%`]
          );
          assert.strictEqual(rawIdxRows.length, 0);

          const allReceiptsJson = JSON.stringify(env.db.all('SELECT * FROM receipts'));
          assert.ok(
            !allReceiptsJson.includes(uniqueSensitiveMarker),
            'Forgotten content must never appear in operational receipts'
          );
          assert.ok(
            !allReceiptsJson.includes('ephemeral_tag_x99281'),
            'Forgotten tags must never appear in operational receipts'
          );
        } finally {
          env.cleanup();
        }
      },
    },
  ]);
}
