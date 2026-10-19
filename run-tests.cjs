#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');
const TESTS_SRC_DIR = path.join(ROOT, 'tests');
const DIST_TESTS_DIR = path.join(ROOT, 'dist', 'tests');

function collectTsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function compileAll() {
  execFileSync('node', [path.join(ROOT, 'scripts', 'build.cjs')], { stdio: 'inherit' });
  fs.rmSync(DIST_TESTS_DIR, { recursive: true, force: true });
  const testFiles = collectTsFiles(TESTS_SRC_DIR);
  for (const file of testFiles) {
    const rel = path.relative(TESTS_SRC_DIR, file);
    const outFile = path.join(DIST_TESTS_DIR, rel.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const rawCode = fs.readFileSync(file, 'utf8');
    // Since src/ compiles to dist/, rewrite relative imports from ../../src/ to ../../
    const code = rawCode.replace(/(['"])(\.\.\/)+src\//g, '$1../../');
    const transformed = babel.transformSync(code, {
      filename: file,
      presets: [
        '@babel/preset-typescript',
        ['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
      ],
      sourceMaps: true,
    });
    fs.writeFileSync(outFile, transformed.code, 'utf8');
  }
}

async function main() {
  compileAll();
  const filterSuite = process.argv[2] || null;

  const allTestFiles = [
    { suite: 'unit', file: path.join(DIST_TESTS_DIR, 'unit', 'domain-and-service.test.js') },
    {
      suite: 'integration',
      file: path.join(DIST_TESTS_DIR, 'integration', 'mcp-stdio-lifecycle.test.js'),
    },
    {
      suite: 'security',
      file: path.join(DIST_TESTS_DIR, 'security', 'security-invariants.test.js'),
    },
  ].filter((item) => !filterSuite || item.suite === filterSuite);

  let totalPassed = 0;
  let totalFailed = 0;
  const results = [];

  for (const { suite, file } of allTestFiles) {
    console.log(`\n=== Running [${suite.toUpperCase()}] suite: ${path.relative(ROOT, file)} ===`);
    const mod = require(file);
    const suiteResults = await mod.runSuite();
    for (const r of suiteResults) {
      results.push({ suite, ...r });
      if (r.status === 'passed') {
        totalPassed++;
        console.log(`  [PASS] ${r.name} (${r.durationMs}ms)`);
      } else {
        totalFailed++;
        console.error(`  [FAIL] ${r.name}: ${r.error}`);
      }
    }
  }

  console.log('\n============================================================');
  console.log(`Test Summary: ${totalPassed} passed, ${totalFailed} failed, ${results.length} total`);
  console.log('============================================================');

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
