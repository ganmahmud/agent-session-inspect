# Changelog

All notable changes to **Agent Session Inspect** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
