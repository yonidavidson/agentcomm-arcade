#!/usr/bin/env node
// AGENTCOMM GUILD HALL — a tiny arcade-style board for the agentcomm bus.
// Runs `agentcomm agents --json` on demand and serves a game-y page that polls
// it every 5 minutes. Also surfaces the bus's telemetry lane: reads events
// (`events --json`) into a "score feed" and can record them (`emit`). Zero
// dependencies — just Node >= 18.
//
//   node ~/agentcomm-arcade/server.mjs
//   → open http://localhost:8777

import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8777);
const HERE = dirname(fileURLToPath(import.meta.url));

// Which bus do we talk to? The CLI resolves it natively (agentcomm >= 0.17.4):
//   1. AGENTCOMM_BACKEND — bus URI, wins over everything.
//   2. AGENTCOMM_REPO    — resolve as if the CLI ran inside that checkout.
//   3. cwd               — run me from inside a bus repo.
// Nothing to juggle here — the env vars pass straight through to the child.

// --- locate the agentcomm CLI ----------------------------------------------
const INSTALL_CMD =
  'npm install -g https://github.com/yonidavidson/agentcomm/releases/latest/download/agentcomm-latest.tgz';

// AGENTCOMM_CLI (explicit override) or `agentcomm` on PATH — the standard
// global install. A .js override runs through this Node; the PATH install is
// a shell shim, so it's spawned directly.
function resolveCli() {
  const override = process.env.AGENTCOMM_CLI;
  if (override) {
    return /\.(m|c)?js$/.test(override)
      ? { file: process.execPath, prefix: [override], label: `${override} (AGENTCOMM_CLI)` }
      : { file: override, prefix: [], label: `${override} (AGENTCOMM_CLI)` };
  }
  try {
    execFileSync('agentcomm', ['-v'], { stdio: 'ignore', timeout: 25_000 });
    return { file: 'agentcomm', prefix: [], label: 'agentcomm (on PATH)' };
  } catch {
    return null;
  }
}

const CLI = resolveCli();
if (!CLI) {
  console.error('[guild] agentcomm CLI not found on PATH. Install it with:');
  console.error(`[guild]   ${INSTALL_CMD}`);
  console.error('[guild] (or set AGENTCOMM_CLI=/path/to/cli to override)');
  process.exit(1);
}
console.log(`[guild] using CLI: ${CLI.label}`);

// --- ping the bus ----------------------------------------------------------
// The CLI prints a "using git+ssh://…" banner to STDERR and JSON to STDOUT.
// Args are passed as an array (no shell), so message bodies can't inject.
function execRaw(args) {
  return new Promise((resolve, reject) => {
    execFile(
      CLI.file,
      [...CLI.prefix, ...args],
      { timeout: 25_000, maxBuffer: 8 * 1024 * 1024 },
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

// Telemetry events — the "metrics" lane (agentcomm >= 0.17). `events --json`
// prints a JSON array (`[]` when the bus has no telemetry opted in). An older
// CLI has no `events` command: it prints nothing to stdout, so we report the
// lane as unsupported instead of erroring. Always resolves — never throws.
async function getEventsRaw() {
  const out = (await execRaw(['events', '--json', '--limit', '300']).catch(() => '')).trim();
  if (out.startsWith('[')) {
    try {
      return { supported: true, events: JSON.parse(out) };
    } catch {
      /* malformed — treat as unavailable */
    }
  }
  return { supported: false, events: [] };
}
const getEvents = () => cached('events', 20_000, getEventsRaw);

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
    if (req.url.startsWith('/api/events')) {
      const { supported, events } = await getEvents();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, now: Date.now(), supported, events }));
    }
    if (req.method === 'POST' && req.url.startsWith('/api/emit')) {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 100_000) req.destroy(); // guard against huge bodies
      });
      req.on('end', async () => {
        try {
          const { type, name, ref, attrs } = JSON.parse(raw || '{}');
          const t = String(type || '').trim();
          if (!t) throw new Error('event type is required (e.g. skill-ran, merged)');

          // validate the attrs payload here so we return a clean error, not a CLI dump
          let attrsArg;
          if (attrs !== undefined && attrs !== null && String(attrs).trim() !== '') {
            let parsed;
            try {
              parsed = JSON.parse(String(attrs));
            } catch (e) {
              throw new Error(`attrs must be valid JSON: ${e.message}`);
            }
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('attrs must be a JSON object, e.g. {"found_bugs":true,"findings":3}');
            }
            attrsArg = JSON.stringify(parsed);
          }

          const args = ['emit', '--type', t, '--flush', '--json'];
          if (name && String(name).trim()) args.push('--name', String(name).trim());
          if (ref && String(ref).trim()) args.push('--ref', String(ref).trim());
          if (attrsArg) args.push('--attrs', attrsArg);

          const out = (await execRaw(args)).trim();
          // older CLI (< 0.17) has no `emit` — no JSON on stdout
          if (!out.startsWith('{')) {
            throw new Error('this agentcomm build has no telemetry `emit` (needs >= 0.17)');
          }
          const r = JSON.parse(out); // { spooled, flushed, reason?, event? }
          caches.delete('events'); // so the score feed reflects it next scan
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              spooled: !!r.spooled,
              flushed: r.flushed || 0,
              reason: r.reason || null,
              event: r.event || null,
            }),
          );
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
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
  const bus =
    process.env.AGENTCOMM_BACKEND ||
    `git remote of ${process.env.AGENTCOMM_REPO || process.cwd()}`;
  console.log(`[guild] 👾 AGENTCOMM GUILD HALL  ·  http://localhost:${PORT}`);
  console.log(`[guild]    bus: ${bus}`);
  console.log('[guild]    rescans every 5 min — click a card for history, ✉ to send, ＋ to log a metric.');
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[guild] port ${PORT} is busy — try:  PORT=${PORT + 1} node server.mjs`);
    process.exit(1);
  }
  throw e;
});
