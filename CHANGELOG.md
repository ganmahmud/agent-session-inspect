# Changelog

All notable changes to **Agent Session Inspect** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **Claude Code Support**: Claude Code transcripts (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`) are scanned alongside Codex sessions in the CLI, TUI and web dashboard.
  - Token usage is deduplicated per API response and mapped onto the existing fields (input includes cache reads and writes; thinking tokens count as reasoning output).
  - Tool calls with timing, `Edit`/`Write` diffs, compaction boundaries, interrupted turns, and `Task` subagent transcripts as linked child sessions.
  - Session titles come from `/rename`, transcript summaries, the first prompt, or — for sessions that only ran local slash commands — those commands.
  - Tool calls that end a turn (or sit between replies) without any assistant text are shown in the conversation as a tool-only reply instead of being hidden in the debug log.
- **Claude Code session view** (`/claude/session/<id>`): local Claude Code transcripts open in their own reading-first page instead of the shared Codex-shaped one.
  - Reads like the Claude Code desktop transcript: your messages as right-aligned bubbles (with pasted images), then Claude's **Thoughts**: the notes it wrote along the way, with each run of tool calls on one line in plain words ("Ran 4 commands, used 2 tools (1 failed)") that opens to rows labelled by what each call did ("Check scripts, create launch config", "Read src/app.ts", "Edited …"), failed calls in red, and each row opening to its input, result or diff. Screenshots appear inline (click for full size) and dev-server previews as link cards. The answer follows in full.
  - Beyond the desktop view: an **Answers only** switch that folds every message's thoughts to one line, a "Next failed step" jump, per-message time, tokens and model on hover, and a sticky bar with branch, pull request (when one was created in the session), lines changed, files changed and cost.
  - The top shows cost, working time, tokens and lines changed, plus a slim turn bar sized by time spent for jumping between turns; token mix, cache use, model and tool time, peak context and per-model cost sit behind "Show usage details".
  - The side panel shows the recap, files changed and setup (model, permissions, effort, version); tools, subagents, files read, MCP servers, skills and commands, hooks and loaded CLAUDE.md files are folded sections.
  - **Cost per message and per step**: Claude Code's recorded cost for each model is split across its API calls by token mix (Anthropic's price ratios: cache read 0.1×, cache write 1.25×/2×, output 5× input) and then across the steps each call produced, so the parts add up exactly to the session total. Shown on each reply, each tool-run line and each tool call.
  - **Worth a look**: up to four findings under the session summary, such as the same tool call failing the same way several times (with what it cost), the same command re-run, the slowest step and a message that took most of the session's spend. Each one jumps to the step it is about.
  - **Review all changes**: every edit the session made, per file, in the diff viewer (with copy and .patch download), from the Files changed panel.
  - Every user message and Claude reply can be copied, exported on its own, or selected; selected messages can be copied as Markdown or exported together (screenshots included) and imported back as a Claude Code session.
  - Imported Claude Code sessions open in this view too. Full exports of Claude Code sessions now include the Claude view with screenshots embedded; exports from earlier versions are converted on import.
  - `/session/<id>` redirects there for Claude Code sessions; `?view=analytics` keeps the token analytics page.
- **Cache expiry** on the Claude Code view: API calls that had to re-cache the whole context are found and explained (a break longer than the 5-minute or 1-hour cache lifetime, a model switch, or compaction), with what the re-cache cost beyond a cache read. They show as notes in the conversation and in "Worth a look".
- **Context over time** chart in the usage details, with cache rebuilds marked.
- **Subagents** listed with their own tokens, steps and failures, and the total they added to the session.
- **Edits made by shell commands** (Claude Code's `bashEditDiff`) count as file changes everywhere: Files changed, Review all changes, file history and per-step line counts.
- Cost is only split across API calls made after the Claude Code process started, so resumed sessions don't spread their cost over replayed turns.
- **Search** (`/search`) across every prompt, reply and command in all sessions; results land on the exact turn or step.
  - Results update as you type and are ranked by relevance: your messages and answers above commands, whole words and exact phrases first, recent sessions break ties, and pasted logs are marked down.
  - Snippets show the part of a long message where the search words meet, with every word highlighted.
  - Filter by agent, message type (your messages, answers, notes, commands, tool calls), project and time, each showing how many matches it holds; sort by best match or newest.
  - `"exact phrase"` and `-word` to exclude; `/` focuses the box, arrow keys move through results and Enter opens one; recent searches are kept in the browser.
  - The search index is built in the background when the dashboard loads.
- **File history** (`/files`): each edited file with every session that changed it, the diff, and the message that asked for it.
- **Habits** (`/habits`): spend by week and project, model, tool and waiting time, repeated failures, context loaded on every request but rarely used (MCP server instructions, the skill list, CLAUDE.md files), follow-up corrections to copy into CLAUDE.md, and commands blocked by permission checks with allow rules suggested only for simple, non-destructive commands.
- **Compare** (`/compare`): two Claude Code sessions side by side.
- **Ask about this session**: questions answered by your local `claude` CLI from a summary of the session, run with no tools, no MCP servers, no saved session and a $1 cap per question.
- **Live view**: a session that is still running updates as Claude Code writes to it, with a Live badge and the cost so far.
- **Replay**: scrub or play a session back, with files changed and cost at each moment.
- Copy the command to resume a session in a terminal.
- The CLI's dashboard server accepts request bodies up to 64 MB (override with `BODY_SIZE_LIMIT`), so large session imports no longer hit adapter-node's 512 KB default.
- **Dashboard agent tabs**: the sidebar lists Codex and Claude Code sessions under separate tabs with counts. Opening a session switches to its agent's tab; Claude Code subagent transcripts appear under their parent's Subagents tab rather than as top-level sessions.
- **Codex session page**: each reply shows its reasoning effort, approval policy and sandbox; Codex's thinking summaries sit in a collapsed note; plan-mode turns (which end with a plan instead of a message) now appear, marked **Plan**; turns that errored (e.g. out of credits) or were interrupted are badged, with an **Issues** filter; the header shows the git branch and commit.
- Root `tsconfig.json`, `@types/node` and `npm run typecheck` so editors and `tsc` type-check `src/` and `test/`.
- `--agent codex|claude|all` option for every command, plus `scan` and `claude scan` commands. The dashboard honours `ASI_AGENT`.
- Each session now records which `agent` wrote it; agent labels in the TUI, scan report and dashboard follow it.

### Changed
- `scan` JSON output reports `provider: "all"` unless an agent is selected.
- A custom `[path]` is read by both agents' parsers; with no path, each agent's default directory is used.

---

## [0.1.8] - 2026-08-18

### Added
- **Project-Based Categorization & Overview**:
  - Automatically detect and group sessions by workspace project (`cwd` directory name or metadata tags).
  - Dedicated `/project/[name]` overview pages with project-level token statistics, session counts, and quick navigation.
  - Interactive project filter toolbar in Terminal TUI with 3-pane `Tab` / `Shift+Tab` focus cycling, arrow key navigation (`←`/`→`), direct project jumping (`[`/`]`, `0-9`), and mouse click support.
- **Session Pinning**: Pin important or frequently inspected sessions to the top of the sidebar.
- **Resizable Sidebar Layout**: User-customizable sidebar width with persistent layout state and smooth drag-resizing.
- **TUI Enhancements**:
  - Compact token formatting (`36.3K`, `1.2M`) for high readability on narrow terminal displays.
  - Role filter cycling (`r` for User / Codex Agent / Subagents / Review).
  - Subagent count indicators on session items in the TUI inventory pane.
  - One-key session JSON export (`e`) directly from the terminal.

---

## [0.1.7] - 2026-08-17

### Added
- **Interactive File Changes & Unified Diff Viewer**:
  - Side-by-side changed files tree with addition/deletion counters (`+N / -M`).
  - Full syntax-highlighted unified diff viewer with file search and clipboard copy.
  - Turn-level file diff accordions in the main conversation timeline.
- **Subagent Telemetry Tracking**:
  - Automatic detection of delegated subagent runs (`subagent_activity`, `spawn_agent`, `delegate_task`).
  - Subagent badge counters and multi-agent telemetry summaries in conversation and analytics views.

### Performance
- **File-Based Scan Caching**: Implement `mtime`/`size` scan cache in `scanCodex()` to bypass redundant transcript parsing on repeated scans.
- **Payload Truncation**: Safeguard memory consumption by automatically truncating giant output payloads during indexing.

---

## [0.1.6] - 2026-08-17

### Added
- **Context & Performance Diagnostics**:
  - Context window saturation gauge and token headroom metrics.
  - Prompt cache hit ratio calculator and reasoning output percentages.
  - Heavy-hitter turn spike analysis identifying the most token-intensive turns.
- **Standalone JSON Export & In-Memory Import**:
  - Export complete sessions or individual turn interactions as standalone JSON files.
  - Drag-and-drop JSON import into Web Dashboard for zero-setup team troubleshooting.
- **Terminal TUI Analytics Tab**: Interactive tab switcher (`Tab` or `1-3`) to inspect token profiles directly in terminal.

---

## [0.1.5] - 2026-08-16

### Changed
- Refined message typography, spacing, and collapsible turn cards for long prompts.
- Optimized chat conversation layout with modular card styling.

---

## [0.1.4] - 2026-08-16

### Added
- Collapsible long user prompts with backdrop blur and sticky actions.
- Markdown rendering improvements for nested code blocks and tool payloads.

---

## [0.1.3] - 2026-08-16

### Added
- In-memory session import API (`/api/session/import`) and client-side drag-and-drop dropzone.
- Ephemeral session inspection without database writes.

---

## [0.1.2] - 2026-08-15

### Added
- Single message JSON export for isolating specific turn interactions.
- Added session deletion API for imported in-memory data.

---

## [0.1.1] - 2026-08-15

### Changed
- Modernized obsidian slate & charcoal dark palette with tailored role contrast.
- Added `TokenBreakdownVisualizer` component for input, cached, output, and reasoning breakdown.

---

## [0.1.0] - 2026-08-14

### Added
- Initial release of **Agent Session Inspect**.
- Dual-pane Terminal TUI (`agent-session-inspect`).
- Local SvelteKit Web Dashboard (`agent-session-inspect web`).
- Read-only parser for `~/.codex/sessions` and SQLite catalog integration.
