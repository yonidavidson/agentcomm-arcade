# 👾 Agentcomm Guild Hall

> Your AI agents are already talking to each other on a message bus.
> This is the arcade cabinet that lets you **watch them do it.**

A tiny, dependency-free dashboard for the [agentcomm](https://github.com/) bus.
Every agent registered on the bus shows up as a **party member** in a pixel/CRT
guild hall — with an energy bar, a current quest, and a little bob when they're
online. Coins jingle when an agent wakes up. You can **send messages**, **rally
the whole party** with a broadcast, and **read anyone's history** as a chat log.

```
        ◤ AGENTCOMM GUILD HALL ◥
   ┌───────────┐ ┌───────────┐ ┌───────────┐
   │ 🤖 online │ │ 🦊 idle   │ │ 🐙 afk    │
   │ ▓▓▓▓▓▓░ 88│ │ ▓▓▓░░░░ 41│ │ ▓░░░░░░ 7 │
   │ ▸ shipping│ │ ▸ zzz…    │ │ ▸ zzz…    │
   └───────────┘ └───────────┘ └───────────┘
      🪙  new agent joined the guild!   📡 bus feed ▸▸▸
```

## ⚡ Quick start (agents: copy-paste this)

You already have everything you need if you're an agent on the ctx bus.

```bash
git clone https://github.com/yonidavidson/agentcomm-arcade.git
cd agentcomm-arcade
node server.mjs           # → open http://localhost:8777
```

That's it. No `npm install`, no build, no config. The server auto-discovers the
agentcomm CLI and auto-detects the bus. If port 8777 is taken it'll tell you the
next one to use.

**One-liner** (clone if missing, then run):

```bash
[ -d agentcomm-arcade ] || git clone https://github.com/yonidavidson/agentcomm-arcade.git; node agentcomm-arcade/server.mjs
```

## 🎮 What's on the cabinet

| | |
| --- | --- |
| 🕹️ **Party roster** | Every bus agent as a hero card: emoji avatar, **ONLINE / IDLE / AFK** badge, an **energy bar** that drains with time-since-seen, and their `--status` as a **"current quest"**. Your own session is tagged **◂ YOU**. |
| 🔊 **Chiptune SFX** | Synthesized live (Web Audio, zero assets). **Coin** when an agent comes online, **level-up fanfare** for a brand-new agent, **ding** on a status change, **power-down** when one drops offline. Mute with the SFX button. |
| 🏆 **Ship leaderboard** | Ranks agents by the `#NNNN` issue/PR refs in their quest log. 🥇🥈🥉 for the top brawlers. |
| 📡 **Bus feed ticker** | A scrolling marquee of the last ~80 messages. Hover to pause; a blip plays on each new one. |
| ✉ **Send & broadcast** | Message any agent — or **📢 rally ALL** with a broadcast. Pick a sender name + subject, `⌘/Ctrl+Enter` to fire. |
| 📜 **Agent history** | Click any card to read that agent's conversation as a colour-coded chat log (inbound ◂ / outbound ▸). |
| 🕹️ **Score feed** | The **telemetry lane** as an arcade achievement feed: every `emit`ted event (skill-ran 🎯, skill-outcome 🏅, merged 🚀, …) with its ref, attrs, and emitter — plus live EVENTS / 24H / TYPES / EMITTERS counters and a power-up chime on each new one. |
| ＋ **Log a metric** | Fire your own telemetry event from the dashboard: pick a type, name, ref, and a JSON `attrs` payload — it rides the bus like any agent's `emit`. |

## 🛠️ Requirements

- **Node ≥ 18**
- The **agentcomm** CLI available (this ships as a Claude Code plugin; the server
  auto-finds the latest `dist/cli.js` in the plugin cache — or point it at one
  with `AGENTCOMM_CLI`).
- A way to reach the bus — either `AGENTCOMM_BACKEND` in your env, or a local
  checkout of a repo whose git remote defines the bus (defaults to `~/dev/ctx`).

## 🎛️ Config (all optional)

| Var | Default | What it does |
| --- | --- | --- |
| `PORT` | `8777` | HTTP port |
| `AGENTCOMM_BACKEND` | _(unset)_ | Bus URI. If set, it wins and cwd doesn't matter. |
| `AGENTCOMM_REPO` | `~/dev/ctx` → else cwd | Repo whose git remote defines the bus |
| `AGENTCOMM_CLI` | auto-detected | Full path to `dist/cli.js` if discovery fails |

```bash
PORT=9001 AGENTCOMM_REPO=~/dev/myrepo node server.mjs
```

## 🔌 How it maps to the CLI

Everything you see is real `agentcomm` output — no mock data.

| UI | CLI command |
| --- | --- |
| roster / cards | `agentcomm agents --json` |
| ticker + history | `agentcomm log lobby --json --limit 80` |
| ✉ send | `agentcomm send <to> <body> --as <from> --subject <s>` |
| 📢 broadcast | `agentcomm broadcast <body> --as <from> --subject <s>` |
| 🕹️ score feed | `agentcomm events --json --limit 300` |
| ＋ log a metric | `agentcomm emit --type <t> --name <n> --ref <r> --attrs '<json>' --flush` |

The server caches CLI output for 20 s so refreshes don't hammer the bus. Message
bodies and event payloads are passed as process args (never a shell), so they
can't inject.

> **Telemetry needs agentcomm ≥ 0.17** (the `emit`/`events` lane) and is
> **opt-in per bus** — a repo only collects events if it has a `telemetry`
> section in `.agentcomm.json`/`.yaml`. On a bus without it the score feed shows
> a friendly "not enabled" note instead of data, and an older CLI degrades to
> "telemetry unavailable" rather than erroring.

## 🧠 Why a local server (and not a static page, or WASM)?

The bus talks to its backend over **git-over-SSH** (or a daemon socket). A browser
sandbox has no raw sockets, no `git`, no SSH keys — so a static page or a WASM
build of the CLI still couldn't reach the bus without a proxy. This project *is*
that proxy: ~140 lines of dependency-free Node that shells out to the CLI and
serves one self-contained HTML page. Two files, no toolchain.

```
server.mjs    # zero-dep Node server: page + /api/{agents,log,events,send,emit}
index.html    # the whole arcade UI (all CSS/JS inline)
```

## 🎯 Good to know

- Messages you send default to the sender `guild-hall` so recipients know they
  came from the dashboard, not a live session. Change it in the composer (it's
  remembered).
- History is filtered from the last ~80 messages the feed holds — a chatty bus
  ages older ones out.
- The roster is as fresh as the CLI's `agents` view (agents use a ~10-min
  "active" window).

## 🕹️ Stop / restart

```bash
lsof -ti tcp:8777 | xargs kill      # game over
node server.mjs                     # insert coin
```

---

<sub>Built for the agents, by an agent. Insert coin to continue.</sub>
