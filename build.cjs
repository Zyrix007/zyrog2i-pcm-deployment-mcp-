#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');
const NATIVE_SRC = path.join(ROOT, 'native', 'sqlite_napi.c');
const BUILD_DIR = path.join(ROOT, 'build');
const NATIVE_OUT = path.join(BUILD_DIR, 'sqlite_napi.node');
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');

function buildNativeSqlite() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  execFileSync(
    'gcc',
    [
      '-shared',
      '-fPIC',
      '-O2',
      '-Wall',
      '-I/usr/include/node',
      NATIVE_SRC,
      '/usr/lib/x86_64-linux-gnu/libsqlite3.so.0',
      '-o',
      NATIVE_OUT,
    ],
    { stdio: 'inherit' }
  );
  console.error(`[build] Compiled native SQLite N-API addon -> ${path.relative(ROOT, NATIVE_OUT)}`);
}

function ensureOfflineMcpSdk() {
  const sdkRoot = path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk');
  const pkgJsonPath = path.join(sdkRoot, 'package.json');
  // Only install local SDK shim if upstream npm package is not present
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (!pkg._pcmOfflineCompat) {
        return;
      }
    } catch {
      // regenerate
    }
  }

  fs.mkdirSync(path.join(sdkRoot, 'server'), { recursive: true });
  fs.mkdirSync(path.join(sdkRoot, 'client'), { recursive: true });

  fs.writeFileSync(
    pkgJsonPath,
    JSON.stringify(
      {
        name: '@modelcontextprotocol/sdk',
        version: '1.0.0-offline-compat',
        _pcmOfflineCompat: true,
        main: './types.js',
      },
      null,
      2
    )
  );

  // types.js
  fs.writeFileSync(
    path.join(sdkRoot, 'types.js'),
    `'use strict';
const LATEST_PROTOCOL_VERSION = '2024-11-05';
const ListToolsRequestSchema = { method: 'tools/list' };
const CallToolRequestSchema = { method: 'tools/call' };
const PingRequestSchema = { method: 'ping' };

module.exports = {
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  PingRequestSchema,
};
`
  );

  // server/index.js
  fs.writeFileSync(
    path.join(sdkRoot, 'server', 'index.js'),
    `'use strict';
const { LATEST_PROTOCOL_VERSION } = require('../types.js');

class Server {
  constructor(serverInfo, options = {}) {
    this.serverInfo = serverInfo;
    this.options = options;
    this.handlers = new Map();
    this.transport = null;
  }

  setRequestHandler(schema, handler) {
    const method = typeof schema === 'string' ? schema : schema && schema.method;
    if (!method) {
      throw new Error('Invalid request schema: missing method');
    }
    this.handlers.set(method, handler);
  }

  async connect(transport) {
    this.transport = transport;
    transport.onmessage = async (msg) => {
      await this._handleMessage(msg);
    };
    await transport.start();
  }

  async _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // Notification (no id)
    if (msg.id === undefined || msg.id === null) {
      return;
    }

    const id = msg.id;
    const method = msg.method;

    try {
      if (method === 'initialize') {
        const result = {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: (this.options && this.options.capabilities) || { tools: {} },
          serverInfo: this.serverInfo,
        };
        await this.transport.send({ jsonrpc: '2.0', id, result });
        return;
      }

      if (method === 'ping') {
        await this.transport.send({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      const handler = this.handlers.get(method);
      if (!handler) {
        await this.transport.send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: 'Method not found: ' + String(method),
          },
        });
        return;
      }

      const result = await handler({ method, params: msg.params || {} });
      await this.transport.send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      await this.transport.send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  async close() {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }
}

module.exports = { Server };
`
  );

  // server/stdio.js
  fs.writeFileSync(
    path.join(sdkRoot, 'server', 'stdio.js'),
    `'use strict';

class StdioServerTransport {
  constructor(stdin = process.stdin, stdout = process.stdout) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._buffer = '';
    this._started = false;
    this._onData = (chunk) => {
      this._buffer += chunk.toString('utf8');
      this._processBuffer();
    };
    this._onEnd = () => {
      if (this.onclose) this.onclose();
    };
  }

  async start() {
    if (this._started) return;
    this._started = true;
    this.stdin.on('data', this._onData);
    this.stdin.on('end', this._onEnd);
    if (typeof this.stdin.resume === 'function') {
      this.stdin.resume();
    }
  }

  _processBuffer() {
    let newlineIdx;
    while ((newlineIdx = this._buffer.indexOf('\\n')) !== -1) {
      const line = this._buffer.slice(0, newlineIdx).replace(/\\r$/, '');
      this._buffer = this._buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (this.onmessage) {
          Promise.resolve(this.onmessage(parsed)).catch((err) => {
            if (this.onerror) this.onerror(err);
          });
        }
      } catch (err) {
        if (this.onerror) this.onerror(err);
      }
    }
  }

  async send(message) {
    const serialized = JSON.stringify(message) + '\\n';
    return new Promise((resolve, reject) => {
      this.stdout.write(serialized, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close() {
    if (!this._started) return;
    this._started = false;
    this.stdin.removeListener('data', this._onData);
    this.stdin.removeListener('end', this._onEnd);
  }
}

module.exports = { StdioServerTransport };
`
  );

  // client/stdio.js
  fs.writeFileSync(
    path.join(sdkRoot, 'client', 'stdio.js'),
    `'use strict';
const { spawn } = require('child_process');

class StdioClientTransport {
  constructor(serverParams) {
    this.serverParams = serverParams;
    this.process = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.stderrChunks = [];
    this.rawStdoutLines = [];
    this._buffer = '';
  }

  async start() {
    const { command, args = [], env, cwd } = this.serverParams;
    this.process = spawn(command, args, {
      env: env ? { ...process.env, ...env } : process.env,
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stderr.on('data', (chunk) => {
      this.stderrChunks.push(chunk.toString('utf8'));
    });

    this.process.stdout.on('data', (chunk) => {
      this._buffer += chunk.toString('utf8');
      let idx;
      while ((idx = this._buffer.indexOf('\\n')) !== -1) {
        const line = this._buffer.slice(0, idx).replace(/\\r$/, '');
        this._buffer = this._buffer.slice(idx + 1);
        if (!line.trim()) continue;
        this.rawStdoutLines.push(line);
        try {
          const msg = JSON.parse(line);
          if (this.onmessage) {
            this.onmessage(msg);
          }
        } catch (err) {
          if (this.onerror) this.onerror(err);
        }
      }
    });

    this.process.on('close', () => {
      if (this.onclose) this.onclose();
    });

    this.process.on('error', (err) => {
      if (this.onerror) this.onerror(err);
    });
  }

  async send(message) {
    if (!this.process || !this.process.stdin) {
      throw new Error('StdioClientTransport process is not running');
    }
    const line = JSON.stringify(message) + '\\n';
    return new Promise((resolve, reject) => {
      this.process.stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close() {
    if (!this.process) return;
    const proc = this.process;
    this.process = null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 2000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.stdin.end();
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  getStderrOutput() {
    return this.stderrChunks.join('');
  }

  getRawStdoutLines() {
    return [...this.rawStdoutLines];
  }
}

module.exports = { StdioClientTransport };
`
  );

  // client/index.js
  fs.writeFileSync(
    path.join(sdkRoot, 'client', 'index.js'),
    `'use strict';
const { LATEST_PROTOCOL_VERSION } = require('../types.js');

class Client {
  constructor(clientInfo, options = {}) {
    this.clientInfo = clientInfo;
    this.options = options;
    this.transport = null;
    this._nextId = 1;
    this._pending = new Map();
    this.serverCapabilities = null;
    this.serverVersion = null;
  }

  async connect(transport) {
    this.transport = transport;
    transport.onmessage = (msg) => {
      if (msg && msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message || 'MCP RPC error');
          err.code = msg.error.code;
          reject(err);
        } else {
          resolve(msg.result);
        }
      }
    };
    await transport.start();
    const initRes = await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: (this.options && this.options.capabilities) || {},
      clientInfo: this.clientInfo,
    });
    this.serverCapabilities = initRes.capabilities;
    this.serverVersion = initRes.serverInfo;
    await this.transport.send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    return initRes;
  }

  async request(method, params = {}) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((err) => {
        this._pending.delete(id);
        reject(err);
      });
    });
  }

  async listTools() {
    return this.request('tools/list', {});
  }

  async callTool(params) {
    return this.request('tools/call', params);
  }

  async ping() {
    return this.request('ping', {});
  }

  async close() {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }
}

module.exports = { Client };
`
  );
}

function collectTsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

function transpileTypeScriptTree(srcRoot, outRoot) {
  const files = collectTsFiles(srcRoot);
  for (const file of files) {
    const rel = path.relative(srcRoot, file);
    const outFile = path.join(outRoot, rel.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const code = fs.readFileSync(file, 'utf8');
    const transformed = babel.transformSync(code, {
      filename: file,
      presets: [
        '@babel/preset-typescript',
        ['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
      ],
      sourceMaps: true,
    });
    fs.writeFileSync(outFile, transformed.code, 'utf8');
    if (transformed.map) {
      fs.writeFileSync(`${outFile}.map`, JSON.stringify(transformed.map), 'utf8');
    }
  }
  return files.length;
}

function main() {
  buildNativeSqlite();
  ensureOfflineMcpSdk();
  if (process.argv.includes('--native-only')) {
    return;
  }
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  const count = transpileTypeScriptTree(SRC_DIR, DIST_DIR);
  console.error(`[build] Transpiled ${count} TypeScript source files from src/ -> dist/`);
}

main();
