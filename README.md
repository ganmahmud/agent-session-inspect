# Agent Session Inspect ⚡

Local, read-only inspection tool and dashboards for Codex agent sessions.

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

- **⚡ Terminal TUI Dashboard (`tui` / `--ui`)**: Dual-pane keyboard & mouse interface with live session filtering, turn-by-turn activity logs, tool execution metrics, and raw metadata.
- **🌐 Web Dashboard (`web` / `--web`)**: SvelteKit local web app (`http://127.0.0.1:4318`) with dark mode, timeline visualization, and rich markdown rendering.
- **📦 Session Export & Import**: Download full sessions or single message interactions as JSON; drag-and-drop JSON files to inspect ephemeral sessions in-memory.
- **📊 Terminal & JSON Summaries**: Quick scan tables or JSON outputs for CI/CD scripting (`--format json`).
- **🔒 100% Local & Read-Only**: Parses local `~/.codex/sessions` logs directly without modifying data.

## Local Development

```sh
# Run CLI / TUI from checkout
npm start

# Run Web Dashboard dev server
npm run dashboard:dev
```

## License

[MIT License](LICENSE) © [Gan Mahmud](https://github.com/ganmahmud)
