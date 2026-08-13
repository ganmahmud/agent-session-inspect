# Agent Session Inspect

Local, read-only inspection for Codex session logs.

## Use as a CLI

Requires Node.js 22.13 or newer. Once the package is published:

```sh
# Run once without installing globally
npx @ganmahmud/agent-session-inspect codex scan
npx @ganmahmud/agent-session-inspect inspect "Build agent session profiler"
npx @ganmahmud/agent-session-inspect serve

# Or install globally
npm install -g @ganmahmud/agent-session-inspect
agent-session-inspect codex scan
agent-session-inspect serve --port 4320
```

Session lists prefer Codex's own task title from its local catalog, then a
title recorded in the JSONL. Raw rollout filenames are shown only with
`--verbose`.

`serve` starts the packaged SvelteKit dashboard at `http://127.0.0.1:4318`. It
reads the local logs directly and never modifies them.

## Local checkout and dashboard development

```sh
# CLI from this checkout
npm start -- codex scan
npm start -- serve

# SvelteKit development server with hot reload
cd dashboard
bun install
bun run dev
```

After dashboard dependencies are installed, `npm run dashboard:dev` also starts
the SvelteKit dev server from the repository root. Build the distributable
dashboard into `dist/dashboard` with `npm run build:dashboard`; `npm pack` and
`npm publish` run it automatically via `prepack`.
