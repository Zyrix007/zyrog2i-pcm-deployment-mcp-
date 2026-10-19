#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');

function collectTsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function resolveImportTarget(fromFile, importSource) {
  if (!importSource.startsWith('.')) {
    return true; // built-in or node_modules package
  }
  const base = path.resolve(path.dirname(fromFile), importSource);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
  ];
  return candidates.some((c) => fs.existsSync(c));
}

function main() {
  const dirs = [path.join(ROOT, 'src'), path.join(ROOT, 'tests')];
  const files = dirs.flatMap(collectTsFiles);
  let errors = 0;

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const code = fs.readFileSync(file, 'utf8');
    try {
      const ast = parser.parse(code, {
        sourceType: 'module',
        plugins: ['typescript'],
      });

      for (const node of ast.program.body) {
        if (
          (node.type === 'ImportDeclaration' ||
            node.type === 'ExportNamedDeclaration' ||
            node.type === 'ExportAllDeclaration') &&
          node.source &&
          node.source.value
        ) {
          const sourceVal = node.source.value;
          if (!resolveImportTarget(file, sourceVal)) {
            console.error(`[typecheck] ERROR in ${rel}: Unresolved relative import "${sourceVal}"`);
            errors++;
          }
        }
      }

      babel.transformSync(code, {
        filename: file,
        presets: [
          '@babel/preset-typescript',
          ['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
        ],
      });
    } catch (err) {
      console.error(`[typecheck] ERROR in ${rel}: ${err.message}`);
      errors++;
    }
  }

  if (errors > 0) {
    console.error(`[typecheck] Failed with ${errors} error(s) across ${files.length} TypeScript files.`);
    process.exit(1);
  }

  console.log(`[typecheck] Validated ${files.length} TypeScript files with 0 syntax/import/transform errors.`);
}

main();
