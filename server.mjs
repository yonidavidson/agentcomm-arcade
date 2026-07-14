#!/usr/bin/env node
// AGENTCOMM GUILD HALL — a tiny arcade-style board for the agentcomm bus.
// Runs `agentcomm agents --json` on demand and serves a game-y page that polls
// it every 5 minutes. Zero dependencies — just Node >= 18.
//
//   node ~/agentcomm-arcade/server.mjs
//   → open http://localhost:8777

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8777);
const HERE = dirname(fileURLToPath(import.meta.url));
// The bus backend is auto-detected from a git repo's remote, so the CLI must
// run inside one. Point at the ctx checkout (override with AGENTCOMM_REPO).
const REPO = process.env.AGENTCOMM_REPO || join(homedir(), 'dev/ctx');

// --- locate the agentcomm CLI (plugin cache, latest version) ---------------
function findCli() {
  if (process.env.AGENTCOMM_CLI) return process.env.AGENTCOMM_CLI;
  const base = join(homedir(), '.claude/plugins/cache/yonidavidson-plugins/agentcomm');
  const versions = readdirSync(base)
    .filter((v) => /^\d+\.\d+\.\d+/.test(v))
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    });
  if (!versions.length) throw new Error(`no agentcomm version found under ${base}`);
  return join(base, versions.at(-1), 'dist/cli.js');
}

let CLI;
try {
  CLI = findCli();
  console.log(`[guild] using CLI: ${CLI}`);
} catch (e) {
  console.error(`[guild] could not find agentcomm CLI: ${e.message}`);
  console.error('[guild] set AGENTCOMM_CLI=/path/to/dist/cli.js to override.');
  process.exit(1);
}

// --- ping the bus ----------------------------------------------------------
// The CLI prints a "using git+ssh://…" banner to STDERR and JSON to STDOUT.
// Args are passed as an array (no shell), so message bodies can't inject.
function execRaw(args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: REPO, timeout: 25_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(stdout);
      },
    );
  });
}
async function runCli(args) {
  const stdout = await execRaw(args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`could not parse CLI output: ${stdout.slice(0, 200)}`);
  }
}

// small per-key cache so a manual refresh doesn't hammer git
const caches = new Map();
async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = caches.get(key);
  if (hit && now - hit.at < ttlMs) return hit.data;
  const data = await fn();
  caches.set(key, { at: now, data });
  return data;
}

const getAgents = () => cached('agents', 20_000, () => runCli(['agents', '--json']));
const getLog = () => cached('log', 20_000, () => runCli(['log', 'lobby', '--json', '--limit', '80']));

const INDEX = readFileSync(join(HERE, 'index.html'), 'utf8');

createServer(async (req, res) => {
  try {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(INDEX);
    }
    if (req.url.startsWith('/api/agents')) {
      const agents = await getAgents();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, now: Date.now(), agents }));
    }
    if (req.url.startsWith('/api/log')) {
      const messages = await getLog();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, now: Date.now(), messages }));
    }
    if (req.method === 'POST' && req.url.startsWith('/api/send')) {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 100_000) req.destroy(); // guard against huge bodies
      });
      req.on('end', async () => {
        try {
          const { to, from, subject, thread, body } = JSON.parse(raw || '{}');
          const sender = String(from || 'guild-hall').trim() || 'guild-hall';
          const text = String(body || '').trim();
          if (!text) throw new Error('message body is required');
          const broadcast = to === '__all__';
          if (!broadcast && !String(to || '').trim()) throw new Error('recipient is required');

          const args = broadcast
            ? ['broadcast', text, '--as', sender]
            : ['send', String(to).trim(), text, '--as', sender];
          if (subject) args.push('--subject', String(subject));
          if (thread) args.push('--thread', String(thread));

          const out = await execRaw(args);
          caches.delete('log'); // so the ticker reflects the new message next scan
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, broadcast, result: out.trim().split('\n').pop() }));
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, now: Date.now(), error: String(e.message || e) }));
  }
}).listen(PORT, () => {
  console.log(`[guild] ▶  AGENTCOMM GUILD HALL running at http://localhost:${PORT}`);
  console.log('[guild]    the page rescans the bus every 5 minutes (or click SCAN NOW).');
});
