# Agent Session Inspect

Local, read-only inspection for Codex session logs.

```sh
npm start -- codex scan
npm start -- inspect "Build agent session profiler"
npm start -- codex scan /path/to/sessions --format json
```

Session lists prefer Codex's own task title from its local catalog, then a
title recorded in the JSONL. Raw rollout filenames are shown only with
`--verbose`.
