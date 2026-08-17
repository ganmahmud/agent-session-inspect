# Agent Session Inspect ⚡

[![npm version](https://img.shields.io/npm/v/@ganmahmud/agent-session-inspect.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@ganmahmud/agent-session-inspect)
[![npm downloads](https://img.shields.io/npm/dm/@ganmahmud/agent-session-inspect.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/@ganmahmud/agent-session-inspect)
[![node version](https://img.shields.io/node/v/@ganmahmud/agent-session-inspect.svg?style=flat-square)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@ganmahmud/agent-session-inspect.svg?style=flat-square&color=green)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ganmahmud/agent-session-inspect.svg?style=flat-square)](https://github.com/ganmahmud/agent-session-inspect/stargazers)

Local, read-only inspection tool and dashboards for Codex agent sessions.

![Agent Session Inspect Web Dashboard](assets/web-dashboard.png)

## Quick Start

Requires Node.js >= 22.13. Run without installing:

```sh
# Interactive Terminal TUI Dashboard (Default)
npx @ganmahmud/agent-session-inspect

# Interactive Web Dashboard (--web)
npx @ganmahmud/agent-session-inspect --web

# Terminal Scan Summary
npx @ganmahmud/agent-session-inspect codex scan

# Inspect Specific Session
npx @ganmahmud/agent-session-inspect inspect "Session Title or ID"
```

## Global Installation

```sh
npm install -g @ganmahmud/agent-session-inspect

# Launch Terminal TUI
agent-session-inspect

# Launch Web Dashboard
agent-session-inspect web --port 4318
```

## Features

### 🌐 Interactive Web Dashboard (`web` / `--web`)
Modern SvelteKit local web app (`http://127.0.0.1:4318`) with dark mode, timeline visualization, and rich markdown rendering.

### 🔍 Rich File Changes & Inline Diff Viewer
Full patch inspection with side-by-side file tree, addition/deletion counters, and copyable unified diffs.

![File Changes & Diff Viewer](assets/web-diff-viewer.png)

### 📊 Context & Performance Diagnostics
Token footprint breakdown, prompt cache efficiency, reasoning overhead metrics, and heavy-hitter turn spike analysis.

![Session Diagnostics & Analytics](assets/web-analytics.png)

### ⚡ Terminal TUI Dashboard (`tui` / `--ui`)
Dual-pane keyboard & mouse interface with live session filtering, turn-by-turn activity logs, tool execution metrics, and raw metadata.

### 📦 Session Export & Import
Download full sessions or single message interactions as JSON; drag-and-drop JSON files in the web UI to inspect ephemeral sessions in-memory.

### 🔒 100% Local & Read-Only
Parses local `~/.codex/sessions` logs directly without modifying any user data.

## Local Development

```sh
# Run CLI / TUI from checkout
npm start

# Run Web Dashboard dev server
npm run dashboard:dev
```

## License

[MIT License](LICENSE) © [Gan Mahmud](https://github.com/ganmahmud)

