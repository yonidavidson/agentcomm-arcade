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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8777);
// Loopback by default. This board is unauthenticated and it can WRITE to the
// bus (send, broadcast, emit), so binding every interface — Node's default
// when listen() gets no host — hands anyone who can route to this machine the
// ability to read the roster and post as you. Set HOST=0.0.0.0 to expose it
// deliberately (a shared box, a dev VM, a container you port-forward from).
const HOST = process.env.HOST || '127.0.0.1';
const HERE = dirname(fileURLToPath(import.meta.url));

// Which bus do we talk to? The CLI resolves it natively (agentcomm >= 0.17.4):
//   1. AGENTCOMM_BACKEND — bus URI, wins over everything.
//   2. AGENTCOMM_REPO    — resolve as if the CLI ran inside that checkout.
//   3. cwd               — run me from inside a bus repo.
// The env vars pass straight through to the child. One footgun: running from
// inside THIS checkout with neither var set points the bus at the arcade's
// own (empty) remote — the board renders, just with nobody on it. Warn loudly.
const SELF_POINTING =
  !process.env.AGENTCOMM_BACKEND &&
  !process.env.AGENTCOMM_REPO &&
  existsSync(join(process.cwd(), '.git')) &&
  process.cwd() === HERE;

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
// A fresh global install has no warm daemon, so the CLI falls back to a
// direct git-over-SSH connection — a single read can take ~a minute on a
// busy bus. The timeout has to outlive that, not just a daemon round-trip.
const CLI_TIMEOUT_MS = Number(process.env.AGENTCOMM_TIMEOUT_MS) || 120_000;

function execRaw(args, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      CLI.file,
      [...CLI.prefix, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
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
// The lane is secondary to the roster, so it gets a SHORT timeout: a hung
// `events` call must degrade the score feed, not stall the whole board. On
// timeout/error we serve the last good result (marked `stale`) if we have one.
const EVENTS_TIMEOUT_MS = Number(process.env.AGENTCOMM_EVENTS_TIMEOUT_MS) || 20_000;
let lastGoodEvents = null;
async function getEventsRaw() {
  let out;
  try {
    out = (await execRaw(['events', '--json', '--limit', '300'], EVENTS_TIMEOUT_MS)).trim();
  } catch {
    // timed out or failed — the CLI supports the lane, it just didn't answer
    return lastGoodEvents ? { ...lastGoodEvents, stale: true } : { supported: true, events: [], unavailable: true };
  }
  if (out.startsWith('[')) {
    try {
      lastGoodEvents = { supported: true, events: JSON.parse(out) };
      return lastGoodEvents;
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
}).listen(PORT, HOST, () => {
  const bus =
    process.env.AGENTCOMM_BACKEND ||
    `git remote of ${process.env.AGENTCOMM_REPO || process.cwd()}`;
  const host = HOST === '127.0.0.1' || HOST === '::1' ? 'localhost' : HOST;
  console.log(`[guild] 👾 AGENTCOMM GUILD HALL  ·  http://${host}:${PORT}`);
  console.log(`[guild]    bus: ${bus}`);
  if (host !== 'localhost') {
    console.warn(`[guild] ⚠ bound to ${HOST} — this board is unauthenticated and can post`);
    console.warn('[guild]   to the bus, so anyone who can reach this port can send as you.');
  }
  if (SELF_POINTING) {
    console.warn('[guild] ⚠ no AGENTCOMM_BACKEND/AGENTCOMM_REPO set and you are running from');
    console.warn('[guild]   the arcade checkout itself — the bus resolves to THIS repo, which');
    console.warn('[guild]   has no agents. Point at your real bus, e.g.:');
    console.warn('[guild]     AGENTCOMM_REPO=~/dev/my-bus-repo node server.mjs');
  }
  console.log('[guild]    rescans every 5 min — click a card for history, ✉ to send, ＋ to log a metric.');
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[guild] port ${PORT} is busy — try:  PORT=${PORT + 1} node server.mjs`);
    process.exit(1);
  }
  throw e;
});
