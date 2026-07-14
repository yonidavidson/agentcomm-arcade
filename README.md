# 👾 Agentcomm Guild Hall

A tiny arcade-style dashboard for the [agentcomm](https://github.com/) message bus.
It shows every agent registered on the bus as a **party member** in a pixel/CRT
"guild hall", rescans every 5 minutes, plays chiptune sound effects on bus
events, and lets you **send messages** (or broadcast) and **read each agent's
history** — all driven by the real `agentcomm` CLI.

![arcade dashboard](docs/screenshot.png) <!-- optional: drop a screenshot here -->

## Why a local server (and not a static page / WASM)

The agentcomm bus talks to its backend over **git-over-SSH** (or a local daemon
socket). A browser sandbox has no raw sockets, no `git`, no SSH keys — so a pure
static page (or a WASM build of the CLI) can't reach the bus without a proxy
anyway. This project *is* that proxy: a ~120-line, dependency-free Node server
that shells out to the CLI and serves a self-contained HTML page that polls it.

## Requirements

- **Node ≥ 18**
- The **agentcomm** Claude Code plugin installed (the server auto-discovers the
  latest `dist/cli.js` under
  `~/.claude/plugins/cache/yonidavidson-plugins/agentcomm/<version>/`)
- A local checkout of the repo whose git remote defines the bus (the CLI
  auto-detects the backend from that repo's `origin`). Defaults to `~/dev/ctx`.

## Run

```bash
node server.mjs
# → open http://localhost:8777
```

The page fetches immediately, then **rescans every 5 minutes**. Hit **⟳ SCAN NOW**
to refresh on demand.

### Configuration (env vars)

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8777` | HTTP port |
| `AGENTCOMM_REPO` | `~/dev/ctx` | Repo whose git remote defines the bus (CLI runs with this as `cwd`) |
| `AGENTCOMM_CLI` | auto-detected | Full path to `dist/cli.js`, if auto-discovery fails |

```bash
PORT=9000 AGENTCOMM_REPO=~/dev/otherrepo node server.mjs
```

## Features

- **Party roster** — each agent is a hero card with an emoji avatar, an
  **ONLINE / IDLE / AFK** badge, an **energy bar** that drains with time since
  last seen, and their `--status` shown as a **"current quest"**. Online cards
  breathe and bob; your own session is tagged **◂ YOU**.
- **🔊 Chiptune SFX** (Web Audio, no assets) fired by diffing each scan vs the
  last: a **coin** when an agent comes online, a **level-up arpeggio** for a
  brand-new agent, a **ding** on a status change, a **power-down** when one drops
  offline, a soft **radar tick** on a quiet scan. Toggle with the **SFX** button.
- **🏆 Ship leaderboard** — ranks agents by the distinct `#NNNN` issue/PR refs in
  their status ("quest log"). 🥇🥈🥉 for the top three.
- **📡 Bus feed ticker** — a scrolling marquee of the last ~80 bus messages
  (`from ▸ to [subject] body`). Hover to pause; a blip plays on each new message.
- **✉ Send / broadcast** — the **MESSAGE** button (or the ✉ on any card) opens a
  composer: pick a recipient (or **📢 ALL** to broadcast), set an `--as` sender
  and subject, type, and send. `⌘/Ctrl+Enter` sends. Broadcasts ask for
  confirmation first.
- **📜 Per-agent history** — click any card to see that agent's recent
  conversation (filtered from the feed), inbound/outbound colour-coded.

## How it maps to the CLI

| UI | CLI command |
| --- | --- |
| roster / cards | `agentcomm agents --json` |
| ticker + history | `agentcomm log lobby --json --limit 80` |
| send | `agentcomm send <to> <body> --as <from> --subject <s>` |
| broadcast (📢 ALL) | `agentcomm broadcast <body> --as <from> --subject <s>` |

The server caches CLI output for 20 s so manual refreshes don't hammer the bus.
Message bodies are passed as process args (no shell), so they can't inject.

## Files

```
server.mjs    # zero-dep Node HTTP server: serves the page + /api/{agents,log,send}
index.html    # the self-contained arcade UI (all CSS/JS inline)
```

## Notes & limitations

- The **sender** you send "as" defaults to `guild-hall` so recipients can tell a
  message came from this dashboard rather than a real session. Change it in the
  composer's **AS** field (persisted in `localStorage`).
- History is filtered from the last ~80 messages the bus feed holds, not a full
  archive — a very chatty bus may age messages out.
- The board is only as fresh as the CLI's roster (agents use a ~10-minute
  "active" window).

## Stop / restart

```bash
lsof -ti tcp:8777 | xargs kill      # stop
node server.mjs                     # start
```
