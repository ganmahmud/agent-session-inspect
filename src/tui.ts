import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import { agentLabel, displayName, projectName, shortId } from './codex.ts';
import { readSessionDetail } from './sessions.ts';
import type {
  ReplyActivity,
  ScanResult,
  SessionDetail,
  SessionInventory,
} from './types.ts';

// 256-color palette for futuristic aesthetic
const c = {
  reset: '\x1b[0m',
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  cyan: (s: string) => `\x1b[38;5;39m${s}\x1b[39m`,
  brightCyan: (s: string) => `\x1b[38;5;51m${s}\x1b[39m`,
  emerald: (s: string) => `\x1b[38;5;49m${s}\x1b[39m`,
  purple: (s: string) => `\x1b[38;5;141m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[38;5;221m${s}\x1b[39m`,
  red: (s: string) => `\x1b[38;5;203m${s}\x1b[39m`,
  gray: (s: string) => `\x1b[38;5;242m${s}\x1b[39m`,
  darkGray: (s: string) => `\x1b[38;5;236m${s}\x1b[39m`,
  white: (s: string) => `\x1b[38;5;255m${s}\x1b[39m`,
  bgSelected: (s: string) => `\x1b[48;5;238m\x1b[38;5;51m${s}\x1b[0m`,
  bgHeader: (s: string) => `\x1b[48;5;235m\x1b[38;5;39m${s}\x1b[0m`,
  bgTabActive: (s: string) => `\x1b[48;5;39m\x1b[38;5;232m\x1b[1m${s}\x1b[0m`,
  bgTabInactive: (s: string) => `\x1b[48;5;236m\x1b[38;5;247m${s}\x1b[0m`,
  bgFocusTag: (s: string) => `\x1b[48;5;49m\x1b[38;5;232m\x1b[1m${s}\x1b[0m`,
  bgNotice: (s: string) => `\x1b[48;5;28m\x1b[38;5;255m\x1b[1m${s}\x1b[0m`,
};

function sanitize(str: string | null | undefined): string {
  if (!str) return '';
  return str.replace(/[\r\n\t]+/g, ' ').trim();
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

function formatNumber(value: number | undefined): string {
  return value === undefined
    ? '—'
    : new Intl.NumberFormat('en-US').format(value);
}

function formatCompactTokens(value: number | undefined): string {
  if (value === undefined || value === null) return '0';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function getSubagentCount(session: SessionInventory): number {
  const directSubagentIds = (session.relationships ?? [])
    .filter((r) => r.type === 'subagent')
    .map((r) => r.sessionId);
  if (directSubagentIds.length > 0) return directSubagentIds.length;
  const eventSubCount =
    (session.eventCounts?.['sub_agent_activity'] ?? 0) +
    (session.eventCounts?.['subagent_activity'] ?? 0) +
    (session.eventCounts?.['agent_activity'] ?? 0);
  return eventSubCount > 0 ? eventSubCount : 0;
}

function duration(
  startedAt: string | undefined,
  updatedAt: string | undefined,
): string {
  if (!startedAt || !updatedAt) return '—';
  const milliseconds = Date.parse(updatedAt) - Date.parse(startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function date(value: string | undefined): string {
  return value?.slice(0, 10) ?? 'unknown';
}

function latestTokens(session: SessionInventory): number | undefined {
  return session.token.last?.totalTokens ?? session.token.total?.totalTokens;
}

function progressBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filledLen = Math.round((clamped / 100) * width);
  const emptyLen = width - filledLen;
  return `[${'█'.repeat(filledLen)}${'░'.repeat(emptyLen)}] ${clamped}%`;
}

function wrapText(input: string, maxWidth: number): string[] {
  if (maxWidth <= 5) maxWidth = 10;
  const clean = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = clean.split('\n');
  const output: string[] = [];

  for (const rawLine of rawLines) {
    if (!rawLine.trim()) {
      output.push('');
      continue;
    }
    let current = rawLine;
    while (visibleLength(current) > maxWidth) {
      const plain = stripAnsi(current);
      let spaceIdx = plain.lastIndexOf(' ', maxWidth);
      if (spaceIdx <= 4) spaceIdx = maxWidth;
      output.push(current.slice(0, spaceIdx));
      current = current.slice(spaceIdx).trimStart();
    }
    if (current) output.push(current);
  }
  return output;
}

function formatCard(
  title: string,
  colorFn: (s: string) => string,
  lines: string[],
  width: number,
): string[] {
  const cardWidth = Math.max(16, width);
  const innerWidth = cardWidth - 4;
  const plainTitle = stripAnsi(title);
  const titleStr = `─ ${title} `;
  const topBorderLen = Math.max(0, cardWidth - plainTitle.length - 4);
  const header = colorFn(`┌${titleStr}${'─'.repeat(topBorderLen)}`);
  const footer = colorFn(`└${'─'.repeat(Math.max(0, cardWidth - 2))}`);

  const wrapped = lines.flatMap((line) => wrapText(line, innerWidth));
  const body = wrapped.map((line) => `${colorFn('│')} ${line}`);
  return [header, ...body, footer];
}

function activityTotal(activity?: ReplyActivity): number {
  return (
    activity?.modelRequests.reduce(
      (sum, request) => sum + (request.usage.totalTokens ?? 0),
      0,
    ) ?? 0
  );
}

interface UsageStats {
  maxContext: number;
  latestTotal: number;
  saturationPct: number;
  latestInput: number;
  latestCached: number;
  latestFresh: number;
  latestOutput: number;
  latestReasoning: number;
  cacheHitRatio: number;
  reasoningRatio: number;
  totalToolMs: number;
  totalOtherMs: number;
  snapshotCount: number;
  modelStepCount: number;
}

function computeUsageStats(detail: SessionDetail): UsageStats {
  const latest = detail.usage.latest;
  const snapshots = detail.usage.snapshots ?? [];
  const maxContext = latest?.modelContextWindow || 200000;
  const latestTotal = latest
    ? (latest.usage.totalTokens ??
      (latest.usage.inputTokens ?? 0) + (latest.usage.outputTokens ?? 0))
    : 0;
  const saturationPct = Math.min(
    100,
    Math.round((latestTotal / maxContext) * 100),
  );

  const latestInput = latest?.usage.inputTokens ?? 0;
  const latestCached = latest?.usage.cachedInputTokens ?? 0;
  const latestFresh = Math.max(0, latestInput - latestCached);
  const latestOutput = latest?.usage.outputTokens ?? 0;
  const latestReasoning = latest?.usage.reasoningOutputTokens ?? 0;

  const cacheHitRatio =
    latestInput > 0 ? Math.round((latestCached / latestInput) * 100) : 0;
  const reasoningRatio =
    latestOutput > 0 ? Math.round((latestReasoning / latestOutput) * 100) : 0;

  let totalToolMs = 0;
  let totalOtherMs = 0;
  for (const m of detail.conversation) {
    if (m.role === 'assistant' && m.activity?.breakdown) {
      totalToolMs += m.activity.breakdown.measuredToolMs ?? 0;
      totalOtherMs += m.activity.breakdown.otherElapsedMs ?? 0;
    }
  }

  return {
    maxContext,
    latestTotal,
    saturationPct,
    latestInput,
    latestCached,
    latestFresh,
    latestOutput,
    latestReasoning,
    cacheHitRatio,
    reasoningRatio,
    totalToolMs,
    totalOtherMs,
    snapshotCount: snapshots.length,
    modelStepCount: detail.usage.modelStepCount ?? 0,
  };
}

interface TopTokenTurn {
  id: string;
  timestamp?: string;
  turnNumber: number;
  totalTokens: number;
  shareOfSessionPct: number;
  promptSnippet: string;
  modelName: string;
  stepCount: number;
  input: number;
  cached: number;
  fresh: number;
  output: number;
  reasoning: number;
}

function computeTopTokenTurns(
  detail: SessionDetail,
  usageStats: UsageStats,
): TopTokenTurn[] {
  const assistantMsgs = detail.conversation.filter(
    (m) => m.role === 'assistant',
  );
  const grandTotal = usageStats.latestTotal || 1;

  const turns = assistantMsgs.map((m, turnIdx) => {
    const total = activityTotal(m.activity);
    const msgIdx = detail.conversation.findIndex((x) => x.id === m.id);
    const prevUserMsg =
      msgIdx > 0
        ? detail.conversation
            .slice(0, msgIdx)
            .reverse()
            .find((x) => x.role === 'user' && x.kind !== 'internal_review')
        : undefined;

    let input = 0;
    let cached = 0;
    let output = 0;
    let reasoning = 0;

    for (const req of m.activity?.modelRequests ?? []) {
      input += req.usage.inputTokens ?? 0;
      cached += req.usage.cachedInputTokens ?? 0;
      output += req.usage.outputTokens ?? 0;
      reasoning += req.usage.reasoningOutputTokens ?? 0;
    }

    const fresh = Math.max(0, input - cached);

    return {
      id: m.id,
      timestamp: m.timestamp,
      turnNumber: turnIdx + 1,
      totalTokens: total,
      shareOfSessionPct: Math.round((total / grandTotal) * 100),
      promptSnippet: prevUserMsg?.text
        ? sanitize(prevUserMsg.text).slice(0, 100)
        : 'Assistant response',
      modelName: m.activity?.model.name ?? 'Model',
      stepCount: m.activity?.modelRequests.length ?? 0,
      input,
      cached,
      fresh,
      output,
      reasoning,
    };
  });

  return turns.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 5);
}

interface ToolProfileItem {
  name: string;
  kind: string;
  count: number;
  durationMs: number;
}

interface ToolProfile {
  tools: ToolProfileItem[];
  totalInvocations: number;
  totalEditsCount: number;
  uniqueEditedFilesCount: number;
}

function computeToolUsageProfile(detail: SessionDetail): ToolProfile {
  const map = new Map<string, ToolProfileItem>();
  let totalEditsCount = 0;
  const editedFilesSet = new Set<string>();

  for (const m of detail.conversation) {
    if (m.role === 'assistant' && m.activity) {
      for (const t of m.activity.tools ?? []) {
        const key = t.name ?? t.kind ?? 'tool';
        const current = map.get(key) ?? {
          name: key,
          kind: t.kind,
          count: 0,
          durationMs: 0,
        };
        current.count += 1;
        current.durationMs += t.durationMs ?? 0;
        map.set(key, current);
      }
      for (const edit of m.activity.edits ?? []) {
        totalEditsCount += 1;
        for (const f of edit.files) {
          editedFilesSet.add(f.path);
        }
      }
    }
  }

  const list = Array.from(map.values()).sort((a, b) => b.count - a.count);
  const totalInvocations = list.reduce((sum, item) => sum + item.count, 0);

  return {
    tools: list,
    totalInvocations,
    totalEditsCount,
    uniqueEditedFilesCount: editedFilesSet.size,
  };
}

function exportSessionJson(detail: SessionDetail): string {
  const filename = `session-${detail.id.slice(0, 8)}.json`;
  const payload = {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    session: detail,
  };
  writeFileSync(filename, JSON.stringify(payload, null, 2), 'utf8');
  return filename;
}

// --- Rendering helpers --------------------------------------------------------------------------------------------

const TAB_LABELS = [' Overview ', ' Activity ', ' Analytics ', ' Tools ', ' Changes ', ' Subagents ', ' Metadata '];
const NO_PROJECT = 'General / No Project';
const SIDEBAR_START = 5; // row 5 = first sidebar content row

type Pane = 'projects' | 'sidebar' | 'main';
type RoleFilter = 'all' | 'user' | 'agent' | 'review' | 'subagent';
const ROLE_FILTERS: RoleFilter[] = ['all', 'user', 'agent', 'review', 'subagent'];

interface SidebarLine {
  plain: string;
  colored: string;
  sel: boolean;
  sessionIndex?: number;
  isGroupHeader?: boolean;
}

interface PillBounds {
  proj: string | null;
  startX: number;
  endX: number;
}

interface TabContext {
  session: SessionInventory;
  detail: SessionDetail | null;
  loading: boolean;
  roleFilter: RoleFilter;
  width: number;
}

interface Key {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
}

const move = (row: number, col: number) => `\x1b[${row};${col}H`;

function fit(value: string, width: number): string {
  return value.slice(0, width).padEnd(width);
}

/** Default `Array.prototype.sort` order (UTF-16 code units), spelled out. */
function compareCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function sidebarWidthFor(cols: number): number {
  return Math.min(46, Math.max(32, Math.floor(cols * 0.36)));
}

function pressed(key: Key, str: string | undefined, names: string[], chars: string[] = []): boolean {
  return names.includes(key.name ?? '') || (str !== undefined && chars.includes(str));
}

function groupSessionIndices(sessions: SessionInventory[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  sessions.forEach((session, index) => {
    const key = projectName(session) || NO_PROJECT;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return groups;
}

function selectionIcon(selected: boolean, pane: Pane): string {
  if (!selected) return '◈ ';
  return pane === 'sidebar' ? '▶ ' : '👉 ';
}

function groupedSessionLines(session: SessionInventory, index: number, selected: boolean, pane: Pane, width: number): SidebarLine[] {
  const subCount = getSubagentCount(session);
  const subStr = subCount > 0 ? ' · 🤖 ' + plural(subCount, 'subagent') : '';
  const l1 = fit(selectionIcon(selected, pane) + sanitize(displayName(session)), width);
  const l2 = fit(`  ⚡ ${formatCompactTokens(latestTokens(session))} tokens · ${plural(session.tools.calls, 'tool')}${subStr}`, width);
  const l3 = fit(`  ${date(session.startedAt)} · ${duration(session.startedAt, session.updatedAt)} · #${shortId(session.id)}`, width);
  return [
    { plain: l1, colored: c.white(l1), sel: selected, sessionIndex: index },
    { plain: l2, colored: c.yellow(l2), sel: selected, sessionIndex: index },
    { plain: l3, colored: c.gray(l3), sel: selected, sessionIndex: index },
  ];
}

function flatSessionLines(session: SessionInventory, index: number, selected: boolean, pane: Pane, width: number): SidebarLine[] {
  const tokens = latestTokens(session);
  const subCount = getSubagentCount(session);
  const pName = projectName(session);
  const subStr = subCount > 0 ? ` · 🤖${subCount}` : '';
  const prjStr = pName && pName !== NO_PROJECT ? ` · 📁${pName.slice(0, 10)}` : '';
  const tokenStr = tokens ? ' · ' + formatCompactTokens(tokens) + 't' : '';
  const sub = `${date(session.startedAt)} · ${duration(session.startedAt, session.updatedAt)}${tokenStr}${subStr}${prjStr}`;
  const l1 = fit(selectionIcon(selected, pane) + sanitize(displayName(session)), width);
  const l2 = fit(`   ${sub}`, width);
  return [
    { plain: l1, colored: c.white(l1), sel: selected, sessionIndex: index },
    { plain: l2, colored: c.gray(l2), sel: selected, sessionIndex: index },
  ];
}

/** Sidebar rows: sessions grouped under project headers, or a flat list when filtered or searching. */
function buildSidebarLines(filtered: SessionInventory[], grouped: boolean, selectedIndex: number, pane: Pane, width: number): SidebarLine[] {
  if (!grouped) return filtered.flatMap((session, i) => flatSessionLines(session, i, i === selectedIndex, pane, width));
  const lines: SidebarLine[] = [];
  for (const [group, indices] of groupSessionIndices(filtered)) {
    const header = fit(`  [${group}]`, width);
    lines.push({ plain: header, colored: c.yellow(c.bold(header)), sel: false, isGroupHeader: true });
    for (const idx of indices) lines.push(...groupedSessionLines(filtered[idx], idx, idx === selectedIndex, pane, width));
  }
  return lines;
}

function sidebarRow(item: SidebarLine | undefined): string {
  if (!item) return '';
  return item.sel ? c.bgSelected(item.plain) : item.colored;
}

function focusTag(pane: Pane): string {
  const labels: Record<Pane, string> = { projects: ' PROJECTS FOCUS ', sidebar: ' SIDEBAR FOCUS ', main: ' MAIN FOCUS ' };
  return c.bgFocusTag(labels[pane]);
}

function projectPill(label: string, selected: boolean, pane: Pane): string {
  if (!selected) return c.bgTabInactive(` ${label} `);
  return pane === 'projects' ? c.bgFocusTag(` ► ${label} ◄ `) : c.bgTabActive(` ${label} `);
}

/** The project toolbar line, plus each pill's columns for mouse clicks. */
function projectToolbar(sessions: SessionInventory[], projects: (string | null)[], selected: string | null, pane: Pane): { line: string; bounds: PillBounds[] } {
  const parts: string[] = [];
  const bounds: PillBounds[] = [];
  let x = 12; // Starts after " Projects: " (1-indexed start is 12)
  for (const prj of projects) {
    const count = prj === null ? sessions.length : sessions.filter((s) => projectName(s).toLowerCase() === prj.toLowerCase()).length;
    const label = prj === null ? `ALL (${count})` : `${prj} (${count})`;
    const pill = projectPill(label, selected === prj, pane);
    const pillLen = stripAnsi(pill).length;
    parts.push(pill);
    bounds.push({ proj: prj, startX: x, endX: x + pillLen });
    x += pillLen + 2; // 2 spaces between pills
  }
  const prefix = pane === 'projects' ? c.bold(c.brightCyan(' Projects: ')) : c.bold(' Projects: ');
  return { line: `${prefix}${parts.join('  ')}`, bounds };
}

function tabHeaders(activeTab: number): string {
  return TAB_LABELS.map((label, idx) => {
    const fullLabel = `[${idx + 1}]${label}`;
    return idx === activeTab ? c.bgTabActive(fullLabel) : c.bgTabInactive(fullLabel);
  }).join(' ');
}

function tabIndexAt(x: number, sidebarWidth: number): number {
  let currentX = sidebarWidth + 3;
  for (let i = 0; i < TAB_LABELS.length; i++) {
    const tabLen = `[${i + 1}]${TAB_LABELS[i]}`.length;
    if (x >= currentX && x < currentX + tabLen + 1) return i;
    currentX += tabLen + 1;
  }
  return -1;
}

/** The session under a clicked sidebar line, mirroring the layout `buildSidebarLines` draws. */
function sessionIndexAtLine(filtered: SessionInventory[], grouped: boolean, offset: number): number | undefined {
  const idx = grouped ? groupedIndexAtLine(filtered, offset) : Math.floor(offset / 2);
  return idx !== undefined && idx >= 0 && idx < filtered.length ? idx : undefined;
}

/** Grouped layout: one header line per project, then three lines per session. */
function groupedIndexAtLine(filtered: SessionInventory[], offset: number): number | undefined {
  let line = 0;
  for (const indices of groupSessionIndices(filtered).values()) {
    if (line === offset) return undefined; // Header line
    line += 1;
    for (const idx of indices) {
      if (offset >= line && offset < line + 3) return idx;
      line += 3;
    }
  }
  return undefined;
}

const PANE_HELP: Record<Pane, string> = {
  projects: ` [←/→] Choose Project | [↓/ENTER] Go to Sessions | [TAB] Sidebar | [0] All Projects | [q] Exit`,
  sidebar: ` [TAB/→] Main Pane | [←] Projects Bar | [↑/↓] Select Session | [[]] Prev/Next Prj | [1-7] Tabs | [/] Search | [q] Exit`,
  main: ` [TAB] Projects Bar | [←/→] Tabs | [↑/↓] Scroll | [1-7] Jump Tab | [r] Role Filter | [[]] Project | [q] Exit`,
};

function footerText(pane: Pane, searching: boolean): string {
  return searching ? ` TYPE FILTER · [ENTER] Save · [ESC] Clear filter` : PANE_HELP[pane];
}

// --- Tabs -----------------------------------------------------------------------------------------------------------

function workspaceLines(session: SessionInventory): string[] {
  if (!session.cwd && !session.projectName) return [];
  return [`Project Workspace   ${projectName(session)}`, ...(session.cwd ? [`Directory Path      ${session.cwd}`] : [])];
}

function contextCard(detail: SessionDetail, width: number): string[] {
  const stats = computeUsageStats(detail);
  const profile = computeToolUsageProfile(detail);
  return formatCard('CONTEXT EFFICIENCY & CODE EDITS', c.emerald, [
    `Context Meter       ${progressBar(stats.saturationPct, 16)}`,
    `Cache Hit Ratio     ${stats.cacheHitRatio}%`,
    `Reasoning Ratio     ${stats.reasoningRatio}%`,
    `Code Edits          ${profile.totalEditsCount} edits across ${profile.uniqueEditedFilesCount} files`,
  ], width);
}

function overviewTab({ session, detail, width }: TabContext): string[] {
  const workspace = workspaceLines(session);
  const token = session.token.last ?? session.token.total;
  const subCount = getSubagentCount(session);
  const fleet = subCount > 0 ? subCount + ' spawned' : 'none';
  const lines = [
    c.brightCyan(c.bold(`◈ ${sanitize(displayName(session))}`)),
    c.gray(`ID: ${session.id}`),
    '',
    ...formatCard('WORKSPACE & TIMELINE', c.cyan, [
      ...workspace,
      `Started             ${session.startedAt ?? 'unknown'}`,
      `Updated             ${session.updatedAt ?? 'unknown'}`,
      `Duration            ${duration(session.startedAt, session.updatedAt)}`,
      `Agent               ${agentLabel(session)}`,
      `Title Source        ${session.displayTitle.source}`,
      ...(session.provider ? [`Provider            ${session.provider.toUpperCase()}`] : []),
    ], width),
    '',
    ...formatCard('TOKEN METRICS', c.yellow, [
      `Total Tokens        ${formatNumber(token?.totalTokens)} (${formatCompactTokens(token?.totalTokens)})`,
      `Cached Input        ${formatNumber(token?.cachedInputTokens)}`,
      `Output Tokens       ${formatNumber(token?.outputTokens)}`,
      `Reasoning Tokens    ${formatNumber(token?.reasoningOutputTokens)}`,
    ], width),
    '',
    ...formatCard('EXECUTION & SUBAGENTS FLEET', c.purple, [
      `Subagents Fleet     ${fleet}`,
      `Tool Calls          ${session.tools.calls} calls (${session.tools.outputs} outputs)`,
      `Task Status         ${session.taskCount} started · ${session.completedTaskCount} completed · ${session.abortedTaskCount} aborted`,
      `Compactions         ${session.compactionCount} compactions · ${session.rollbackCount} rollbacks`,
    ], width),
  ];
  if (detail) lines.push('', ...contextCard(detail, width));
  return lines;
}

type ConversationItem = SessionDetail['conversation'][number];
type ToolCall = NonNullable<ConversationItem['activity']>['tools'][number];

function isAgentTool(tool: ToolCall): boolean {
  const name = tool.name.toLowerCase();
  return tool.kind === 'subagent' || name.includes('subagent') || name.includes('agent');
}

const ROLE_MATCHERS: Record<Exclude<RoleFilter, 'all'>, (item: ConversationItem) => boolean> = {
  user: (m) => m.role === 'user' && m.kind !== 'internal_review',
  agent: (m) => m.role === 'assistant',
  review: (m) => m.kind === 'internal_review',
  subagent: (m) => Boolean(m.activity?.tools.some(isAgentTool)),
};

function roleFilterLabel(filter: RoleFilter, session: SessionInventory): string {
  if (filter === 'agent') return `${agentLabel(session).toUpperCase()} AGENT`;
  if (filter === 'subagent') return 'SUBAGENTS';
  return filter.toUpperCase();
}

function tokenBreakdown(activity: ReplyActivity, total: number): string {
  const sums = { input: 0, cached: 0, output: 0, reasoning: 0 };
  for (const req of activity.modelRequests) {
    sums.input += req.usage.inputTokens ?? 0;
    sums.cached += req.usage.cachedInputTokens ?? 0;
    sums.output += req.usage.outputTokens ?? 0;
    sums.reasoning += req.usage.reasoningOutputTokens ?? 0;
  }
  return `Tokens: ${formatNumber(total)} total (In: ${formatNumber(sums.input)}, Cached: ${formatNumber(sums.cached)}, Out: ${formatNumber(sums.output)}, Reasoning: ${formatNumber(sums.reasoning)})`;
}

function activityToolLines(activity?: ReplyActivity): string[] {
  if (!activity?.tools.length) return [];
  return [
    '',
    c.purple(`⚡ Tools Executed (${activity.tools.length}):`),
    ...activity.tools.map((tool) => {
      const durStr = tool.durationMs ? `${tool.durationMs}ms` : 'exec';
      const isSub = tool.kind === 'subagent' || tool.name.toLowerCase().includes('subagent');
      const prefix = isSub ? '🤖 [SUBAGENT] ' : '• ';
      return `  ${prefix}${tool.name} (${durStr})`;
    }),
  ];
}

function activityEditLines(activity?: ReplyActivity): string[] {
  if (!activity?.edits.length) return [];
  const files = activity.edits.flatMap((edit) => edit.files);
  return ['', c.emerald(`✏️ Code Edits:`), ...files.map((f) => `  • ${f.path}${f.operation ? ' (' + f.operation + ')' : ''}`)];
}

function assistantCardLines(item: ConversationItem): string[] {
  const lines: string[] = [];
  if (item.activity?.model.name) lines.push(c.gray(`Model: ${item.activity.model.name}`));
  const total = activityTotal(item.activity);
  if (item.activity && total > 0) lines.push(c.yellow(tokenBreakdown(item.activity, total)), '');
  if (item.text) lines.push(...item.text.split('\n'));
  lines.push(...activityToolLines(item.activity), ...activityEditLines(item.activity));
  return lines;
}

function conversationCard(item: ConversationItem, session: SessionInventory, width: number): string[] {
  if (item.kind === 'internal_review') {
    return [...formatCard('🛡️ INTERNAL REVIEW', c.yellow, item.text ? item.text.split('\n') : ['(empty review entry)'], width), ''];
  }
  if (item.role === 'user') return [...formatCard('👤 USER', c.emerald, item.text ? item.text.split('\n') : ['(empty message)'], width), ''];
  if (item.role === 'assistant') {
    return [...formatCard(`🤖 ${agentLabel(session).toUpperCase()} AGENT`, c.cyan, assistantCardLines(item), width), ''];
  }
  return [];
}

function activityTab({ session, detail, loading, roleFilter, width }: TabContext): string[] {
  if (loading) return [c.yellow('⚡ Loading session activity transcript...')];
  if (!detail?.conversation.length) return [c.dim('No conversation activity records found.')];
  const label = roleFilterLabel(roleFilter, session);
  const lines = [c.brightCyan(c.bold(`CONVERSATION & ACTIVITY TIMELINE`)) + c.gray(`  [ FILTER: ${label} · Press 'r' to cycle ]`), ''];
  const list = roleFilter === 'all' ? detail.conversation : detail.conversation.filter(ROLE_MATCHERS[roleFilter]);
  if (!list.length) return [...lines, c.dim(`No messages match the active role filter [${label}].`)];
  for (const item of list) lines.push(...conversationCard(item, session, width));
  return lines;
}

function spikeLines(spikes: TopTokenTurn[]): string[] {
  if (!spikes.length) return ['No token usage spikes recorded.'];
  return spikes.flatMap((spike) => [
    c.bold(`Turn #${spike.turnNumber} — ${formatNumber(spike.totalTokens)} tokens (${spike.shareOfSessionPct}% of session)`),
    `  Model: ${spike.modelName} | In: ${formatNumber(spike.input)} (${formatNumber(spike.cached)} cached) | Out: ${formatNumber(spike.output)}`,
    `  Prompt: "${spike.promptSnippet}"`,
    '',
  ]);
}

function toolProfileLines(profile: ToolProfile): string[] {
  if (!profile.tools.length) return ['No tools invoked in this session.'];
  return [
    `Total Tool Invocations: ${profile.totalInvocations}`,
    '',
    ...profile.tools.map((item) => `• ${item.name} (${item.kind}): ${item.count} calls · ${item.durationMs} ms total`),
  ];
}

function analyticsTab({ detail, loading, width }: TabContext): string[] {
  if (loading) return [c.yellow('⚡ Computing session analytics & token profile...')];
  if (!detail) return [c.dim('No session detail loaded for analytics.')];
  const stats = computeUsageStats(detail);
  const profile = computeToolUsageProfile(detail);
  return [
    c.brightCyan(c.bold('📊 SESSION RESOURCE & TOKEN ANALYTICS')),
    '',
    ...formatCard('CONTEXT WINDOW & CACHE EFFICIENCY', c.yellow, [
      `Saturation Meter ${progressBar(stats.saturationPct, 22)}`,
      `Window Capacity  ${formatNumber(stats.latestTotal)} / ${formatNumber(stats.maxContext)} tokens`,
      `Cache Hit Ratio  ${stats.cacheHitRatio}% (${formatNumber(stats.latestCached)} / ${formatNumber(stats.latestInput)} input tokens)`,
      `Reasoning Ratio  ${stats.reasoningRatio}% (${formatNumber(stats.latestReasoning)} / ${formatNumber(stats.latestOutput)} output tokens)`,
    ], width),
    '',
    ...formatCard('TIME & RESOURCE PROFILE', c.purple, [
      `Tool Execution   ${stats.totalToolMs} ms measured tool work`,
      `Overhead/Model   ${stats.totalOtherMs} ms model/system time`,
      `Code Edits       ${profile.totalEditsCount} edits across ${profile.uniqueEditedFilesCount} unique files`,
      `Snapshots        ${stats.snapshotCount} usage snapshots · ${stats.modelStepCount} model steps`,
    ], width),
    '',
    ...formatCard('TOP TOKEN-HEAVY TURNS (SPIKES)', c.red, spikeLines(computeTopTokenTurns(detail, stats)), width),
    '',
    ...formatCard('TOOL INVOCATION & TIMING PROFILE', c.emerald, toolProfileLines(profile), width),
  ];
}

function toolStatusLabel(status?: string): string {
  if (status === 'completed' || status === '0') return c.emerald('✓ completed');
  return status ? c.red(`✗ ${status}`) : c.dim('exec');
}

function toolDetailLines(tool: ToolCall): string[] {
  const durationText = tool.durationMs === undefined ? '—' : tool.durationMs + 'ms';
  return [
    `Kind:     ${tool.kind}`,
    `Duration: ${durationText}`,
    ...(tool.input ? [`Input:    ${sanitize(tool.input)}`] : []),
    ...(tool.output ? [`Output:   ${sanitize(tool.output)}`] : []),
  ];
}

function toolsTab({ detail, loading, width }: TabContext): string[] {
  if (loading) return [c.yellow('⚡ Loading tool executions...')];
  if (!detail) return [c.dim('No detail loaded')];
  const lines = [c.purple(c.bold('TOOL EXECUTIONS & DETAILS')), ''];
  const tools = detail.conversation.flatMap((m) => m.activity?.tools ?? []);
  tools.forEach((tool, index) => {
    lines.push(...formatCard(`⚙️ TOOL #${index + 1}: ${tool.name} [${toolStatusLabel(tool.status)}]`, c.purple, toolDetailLines(tool), width), '');
  });
  if (!tools.length) lines.push(c.dim('No tool execution records found.'));
  return lines;
}

type EditRecord = NonNullable<ConversationItem['activity']>['edits'][number];

function collectFileDiffs(edits: EditRecord[]): Map<string, { path: string; operation?: string; diffs: string[] }> {
  const files = new Map<string, { path: string; operation?: string; diffs: string[] }>();
  for (const f of edits.flatMap((edit) => edit.files)) {
    const existing = files.get(f.path) ?? { path: f.path, operation: f.operation, diffs: [] };
    if (f.diff) existing.diffs.push(f.diff);
    if (f.operation) existing.operation = f.operation;
    files.set(f.path, existing);
  }
  return files;
}

function colorDiffLine(line: string): string {
  if (line.startsWith('+')) return c.emerald(line);
  if (line.startsWith('-')) return c.red(line);
  if (line.startsWith('@@')) return c.cyan(line);
  return c.gray(line);
}

function fileDiffLines(diffs: string[]): string[] {
  if (!diffs.length) return [c.dim('(File modified without unified diff snippet recorded)')];
  return diffs.flatMap((rawDiff) => [...rawDiff.split('\n').map(colorDiffLine), '']);
}

function changesTab({ detail, loading, width }: TabContext): string[] {
  if (loading) return [c.yellow('⚡ Loading file changes and diffs...')];
  if (!detail) return [c.dim('No session detail loaded for changes.')];
  const lines = [c.emerald(c.bold('✏️ FILE CHANGES & CODE PATCHES')), ''];
  const allEdits = detail.conversation.flatMap((m) => m.activity?.edits ?? []);
  const files = collectFileDiffs(allEdits);
  if (!files.size) return [...lines, c.dim('No file edits or code patches recorded in this session.')];
  lines.push(c.yellow(`Modified Files: ${files.size} files across ${allEdits.length} edit operations`), '');
  for (const [filePath, info] of files) {
    const op = info.operation ? `[${info.operation.toUpperCase()}] ` : '';
    lines.push(...formatCard(`📄 ${op}${filePath}`, c.emerald, fileDiffLines(info.diffs), width), '');
  }
  return lines;
}

function relationshipLines(session: SessionInventory): string[] {
  const relationships = session.relationships ?? [];
  const parents = relationships.filter((r) => r.type === 'parent');
  const subagents = relationships.filter((r) => r.type === 'subagent');
  const lines: string[] = [];
  if (parents.length) lines.push(c.bold('Parent Session:'), ...parents.map((p) => `  ⬆️ ${p.sessionId}`), '');
  if (subagents.length) lines.push(c.bold(`Spawned Subagents (${subagents.length}):`), ...subagents.map((sub) => `  🤖 Subagent ID: ${sub.sessionId}`), '');
  const counts = session.eventCounts ?? {};
  const events = (counts['sub_agent_activity'] ?? 0) + (counts['subagent_activity'] ?? 0) + (counts['agent_activity'] ?? 0);
  lines.push(`Subagent Activity Events: ${events}`);
  return lines;
}

function subagentToolLines(detail: SessionDetail): string[] {
  return detail.conversation
    .flatMap((m) => m.activity?.tools ?? [])
    .filter(isAgentTool)
    .flatMap((t) => [
      `• ${t.name} (${t.durationMs ? t.durationMs + 'ms' : 'exec'})`,
      ...(t.input ? [`  Input: ${sanitize(t.input).slice(0, 120)}`] : []),
      ...(t.output ? [`  Result: ${sanitize(t.output).slice(0, 120)}`] : []),
      '',
    ]);
}

function subagentsTab({ session, detail, width }: TabContext): string[] {
  const lines = [
    c.purple(c.bold('🤖 SUBAGENTS FLEET HIERARCHY')),
    '',
    ...formatCard('FLEET TOPOLOGY & COUNTS', c.purple, relationshipLines(session), width),
    '',
  ];
  if (!detail) return lines;
  const tools = subagentToolLines(detail);
  if (tools.length) lines.push(...formatCard('SUBAGENT ACTIVITY TRANSCRIPT', c.cyan, tools, width));
  else lines.push(c.dim('No dedicated subagent tool invocations in conversation.'));
  return lines;
}

function metadataTab({ session }: TabContext): string[] {
  return [c.gray('RAW SESSION INVENTORY METADATA:'), '', ...JSON.stringify(session, null, 2).split('\n')];
}

const TAB_RENDERERS: Array<(ctx: TabContext) => string[]> = [overviewTab, activityTab, analyticsTab, toolsTab, changesTab, subagentsTab, metadataTab];

const MAIN_SCROLL = new Map<string, (offset: number) => number>([
  ['up', (offset) => Math.max(0, offset - 1)],
  ['down', (offset) => offset + 1],
  ['pageup', (offset) => Math.max(0, offset - 8)],
  ['pagedown', (offset) => offset + 8],
  ['home', () => 0],
  ['end', () => 999999],
]);

function scrolledMain(key: Key, str: string | undefined, offset: number): number {
  let action = key.name;
  if (key.name === 'up' || str === 'k') action = 'up';
  else if (key.name === 'down' || str === 'j') action = 'down';
  const scroll = action ? MAIN_SCROLL.get(action) : undefined;
  return scroll ? scroll(offset) : offset;
}

function parseMouse(raw: string): { btn: number; x: number; y: number; press: boolean } | undefined {
  const match = raw.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!match) return undefined;
  return { btn: Number.parseInt(match[1], 10), x: Number.parseInt(match[2], 10), y: Number.parseInt(match[3], 10), press: match[4] === 'M' };
}

// --- Interactive loop -----------------------------------------------------------------------------------------------

export async function startTui(scanResult: ScanResult): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive TUI requires a terminal TTY');
  }

  const sessions = scanResult.sessions;
  let selectedIndex = 0;
  let scrollOffset = 0;
  let rightScrollOffset = 0;
  let activeTab = 0; // 0: Overview, 1: Activity, 2: Analytics, 3: Tools, 4: Changes, 5: Subagents, 6: Metadata
  let activePane: Pane = 'sidebar';
  let searchQuery = '';
  let isSearching = false;
  let selectedProjectFilter: string | null = null; // null = all projects
  let roleFilter: RoleFilter = 'all';
  let currentDetail: SessionDetail | null = null;
  let loadingDetail = false;
  let notificationMessage = '';
  let notificationTimer: NodeJS.Timeout | null = null;
  // Keep track of project pill hitboxes for mouse clicking
  let projectPillBounds: PillBounds[] = [];

  // Extract all unique project names
  const allProjects = Array.from(new Set(sessions.map((s) => projectName(s)).filter((p) => p !== NO_PROJECT))).sort(compareCodePoints);

  const getProjectList = (): (string | null)[] => [null, ...allProjects];

  const getFilteredSessions = () => {
    let list = sessions;
    if (selectedProjectFilter) {
      const project = selectedProjectFilter.toLowerCase();
      list = list.filter((s) => projectName(s).toLowerCase() === project);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((s) => sanitize(displayName(s)).toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || projectName(s).toLowerCase().includes(q));
    }
    return list;
  };

  const isGrouped = () => !selectedProjectFilter && allProjects.length > 0 && !searchQuery.trim();

  const notify = (msg: string) => {
    notificationMessage = msg;
    render();
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
      notificationMessage = '';
      render();
    }, 3000);
  };

  const loadDetail = async (session: SessionInventory) => {
    loadingDetail = true;
    currentDetail = null;
    render();
    try {
      currentDetail = await readSessionDetail(session);
    } catch {
      currentDetail = null;
    } finally {
      loadingDetail = false;
      render();
    }
  };

  const setProjectFilter = (proj: string | null) => {
    selectedProjectFilter = proj;
    selectedIndex = 0;
    scrollOffset = 0;
    rightScrollOffset = 0;
    const newFiltered = getFilteredSessions();
    if (newFiltered[0]) loadDetail(newFiltered[0]);
    if (proj) notify(`Project: ${proj} (${plural(newFiltered.length, 'session')})`);
    else notify(`All Projects (${sessions.length} sessions)`);
  };

  const cycleProject = (direction: 1 | -1) => {
    const list = getProjectList();
    if (list.length <= 1) {
      notify('No named projects found in session inventory.');
      return;
    }
    const curIdx = Math.max(0, list.indexOf(selectedProjectFilter));
    setProjectFilter(list[(curIdx + direction + list.length) % list.length]);
  };

  const showTab = (tab: number) => {
    activeTab = tab;
    rightScrollOffset = 0;
  };

  const selectSession = (index: number, filtered: SessionInventory[]) => {
    selectedIndex = index;
    rightScrollOffset = 0;
    if (filtered[selectedIndex]) loadDetail(filtered[selectedIndex]);
  };

  // Setup Terminal with button mouse tracking to prevent terminal buffer scroll
  process.stdout.write('\x1b[?1049h'); // Alternate screen buffer
  process.stdout.write('\x1b[?25l'); // Hide cursor
  process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h'); // Button & SGR Mouse tracking

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);

  const cleanup = () => {
    process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l');
    process.stdout.write('\x1b[?25h');
    process.stdout.write('\x1b[?1049l');
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);
    process.exit(0);
  };

  // --- Render ---

  const renderHeader = (buffer: string[], cols: number) => {
    const headerStats = `${sessions.length} sessions loaded · ${allProjects.length} projects`;
    const headerLine = ` ${c.bold('⚡ AGENT SESSION INSPECT ⚡')}  ${c.bgFocusTag(' Local ')}  ${c.dim('·')}  ${c.yellow(headerStats)}  ${focusTag(activePane)}`.padEnd(cols - 1);
    buffer.push(move(1, 1) + c.bgHeader(headerLine.slice(0, cols)));
    const toolbar = projectToolbar(sessions, getProjectList(), selectedProjectFilter, activePane);
    projectPillBounds = toolbar.bounds;
    buffer.push(move(2, 1) + '\x1b[K' + c.bgHeader(toolbar.line.padEnd(cols - 1).slice(0, cols)));
  };

  /** Keeps the selected session (and the two lines under it) inside the visible sidebar rows. */
  const scrollSidebarTo = (lines: SidebarLine[], visibleRows: number) => {
    const selLinePos = Math.max(0, lines.findIndex((line) => line.sel));
    if (selLinePos < scrollOffset) scrollOffset = selLinePos;
    if (selLinePos + 3 > scrollOffset + visibleRows) scrollOffset = Math.max(0, selLinePos + 3 - visibleRows);
    scrollOffset = Math.max(0, scrollOffset);
  };

  const renderSidebar = (buffer: string[], rows: number, sidebarWidth: number, filtered: SessionInventory[]) => {
    const lines = buildSidebarLines(filtered, isGrouped(), selectedIndex, activePane, sidebarWidth - 2);
    const visibleRows = Math.max(1, rows - SIDEBAR_START - 1);
    scrollSidebarTo(lines, visibleRows);
    const dividerColor = activePane === 'sidebar' ? c.cyan : c.darkGray;
    for (let r = 3; r < rows; r++) buffer.push(move(r, sidebarWidth + 1) + dividerColor('│'));
    const titleColor = activePane === 'sidebar' ? c.cyan : c.dim;
    const title = isSearching ? `🔍 SEARCH: ${searchQuery}_` : `SESSIONS INVENTORY [${filtered.length} / ${sessions.length}]`;
    buffer.push(move(3, 2) + '\x1b[K' + titleColor(c.bold(fit(title, sidebarWidth - 2))));
    buffer.push(move(4, 1) + '\x1b[K' + c.darkGray('─'.repeat(sidebarWidth)));
    for (let i = 0; i < visibleRows && SIDEBAR_START + i < rows - 1; i++) {
      buffer.push(move(SIDEBAR_START + i, 1) + '\x1b[K' + sidebarRow(lines[scrollOffset + i]));
    }
  };

  const renderMain = (buffer: string[], rows: number, sidebarWidth: number, mainWidth: number, session?: SessionInventory) => {
    buffer.push(move(3, sidebarWidth + 3) + '\x1b[K' + tabHeaders(activeTab));
    buffer.push(move(4, sidebarWidth + 2) + '\x1b[K' + c.darkGray('─'.repeat(mainWidth)));
    if (!session) {
      buffer.push(move(6, sidebarWidth + 4) + '\x1b[K' + c.dim('No sessions match the current filter.'));
      return;
    }
    const lines = TAB_RENDERERS[activeTab]?.({ session, detail: currentDetail, loading: loadingDetail, roleFilter, width: mainWidth - 4 }) ?? [];
    // Clamp scrolling, then redraw every row with line erase (\x1b[K).
    const mainHeight = rows - 6;
    rightScrollOffset = Math.min(Math.max(rightScrollOffset, 0), Math.max(0, lines.length - mainHeight));
    for (let r = 0; r < mainHeight; r++) {
      buffer.push(move(5 + r, sidebarWidth + 3) + '\x1b[K' + (lines[rightScrollOffset + r] ?? ''));
    }
  };

  const renderFooter = (buffer: string[], rows: number, cols: number) => {
    const paint = notificationMessage ? c.bgNotice : c.bgHeader;
    const text = notificationMessage ? ` ${notificationMessage} ` : footerText(activePane, isSearching);
    buffer.push(move(rows, 1) + '\x1b[K' + paint(text.padEnd(cols - 1).slice(0, cols)));
  };

  const render = () => {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const sidebarWidth = sidebarWidthFor(cols);
    const mainWidth = Math.max(20, cols - sidebarWidth - 1);
    const filtered = getFilteredSessions();
    if (selectedIndex >= filtered.length) selectedIndex = Math.max(0, filtered.length - 1);

    const buffer: string[] = ['\x1b[H'];
    renderHeader(buffer, cols);
    renderSidebar(buffer, rows, sidebarWidth, filtered);
    renderMain(buffer, rows, sidebarWidth, mainWidth, filtered[selectedIndex]);
    renderFooter(buffer, rows, cols);
    process.stdout.write(buffer.join(''));
  };

  // --- Keyboard ---

  const handleSearchKey = (str: string | undefined, key: Key) => {
    if (key.name === 'return' || key.name === 'escape') isSearching = false;
    else if (key.name === 'backspace') searchQuery = searchQuery.slice(0, -1);
    else if (str?.length === 1 && str.charCodeAt(0) >= 32) searchQuery += str;
    selectedIndex = 0;
    scrollOffset = 0;
    const filtered = getFilteredSessions();
    if (filtered[0]) loadDetail(filtered[0]);
    render();
  };

  const nextPane = (back: boolean): Pane => {
    const order: Pane[] = ['projects', 'sidebar', 'main'];
    return order[(order.indexOf(activePane) + (back ? 2 : 1)) % order.length];
  };

  const exportCurrent = (detail: SessionDetail) => {
    try {
      notify(`Exported session JSON to: ${exportSessionJson(detail)}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      notify(`Failed to export session JSON: ${reason}`);
    }
  };

  /** Shortcuts that work in every pane; returns whether the key was handled. */
  const handleGlobalKey = (str: string | undefined, key: Key, selectedSession?: SessionInventory): boolean => {
    if (str === '[' || str === '<' || str === 'P') cycleProject(-1);
    else if (str === ']' || str === '>' || str === 'p') cycleProject(1);
    else if (key.name === 'tab' || key.name === 'backtab') {
      activePane = nextPane(key.name === 'backtab' || Boolean(key.shift));
      render();
    } else if (str === '0') setProjectFilter(null);
    else if (str === 'e' && currentDetail) exportCurrent(currentDetail);
    else if (str === 'c' && selectedSession) notify(`Copied Session ID: ${selectedSession.id}`);
    else if ((str === 'r' || str === 'f') && activeTab === 1) {
      roleFilter = ROLE_FILTERS[(ROLE_FILTERS.indexOf(roleFilter) + 1) % ROLE_FILTERS.length];
      rightScrollOffset = 0;
      render();
    } else return false;
    return true;
  };

  const handleProjectsKey = (str: string | undefined, key: Key) => {
    if (pressed(key, str, ['left'], ['h'])) cycleProject(-1);
    else if (pressed(key, str, ['right'], ['l'])) cycleProject(1);
    else if (key.name === 'escape' && selectedProjectFilter !== null) setProjectFilter(null);
    else if (pressed(key, str, ['down', 'return', 'space', 'escape'], ['j'])) {
      activePane = 'sidebar';
      render();
    } else if (str && str >= '1' && str <= '9') {
      const project = allProjects[Number.parseInt(str, 10) - 1];
      if (project !== undefined) setProjectFilter(project);
    }
  };

  const handleSidebarKey = (str: string | undefined, key: Key, filtered: SessionInventory[]) => {
    if (pressed(key, str, ['up'], ['k'])) {
      if (selectedIndex > 0) selectSession(selectedIndex - 1, filtered);
    } else if (pressed(key, str, ['down'], ['j'])) {
      if (selectedIndex < filtered.length - 1) selectSession(selectedIndex + 1, filtered);
    } else if (pressed(key, str, ['left'], ['h'])) activePane = 'projects';
    else if (pressed(key, str, ['right', 'return'], ['l'])) activePane = 'main';
    else if (key.name === 'pageup') selectSession(Math.max(0, selectedIndex - 5), filtered);
    else if (key.name === 'pagedown') selectSession(Math.min(filtered.length - 1, selectedIndex + 5), filtered);
  };

  const handleMainKey = (str: string | undefined, key: Key) => {
    if (pressed(key, str, ['right'], ['l'])) {
      if (activeTab < TAB_LABELS.length - 1) showTab(activeTab + 1);
    } else if (pressed(key, str, ['left'], ['h'])) {
      if (activeTab > 0) showTab(activeTab - 1);
      else activePane = 'sidebar';
    } else rightScrollOffset = scrolledMain(key, str, rightScrollOffset);
  };

  const handleTabShortcut = (str: string | undefined) => {
    if (str === '/') {
      isSearching = true;
      searchQuery = '';
    } else if (str && /^[1-7]$/.test(str)) showTab(Number(str) - 1);
  };

  // Load first session detail on boot
  const filteredInit = getFilteredSessions();
  if (filteredInit[0]) loadDetail(filteredInit[0]);

  process.stdin.on('keypress', (str: string | undefined, key: Key) => {
    if (isSearching) {
      handleSearchKey(str, key);
      return;
    }
    if (key.ctrl && key.name === 'c') cleanup();
    if (str === 'q') cleanup();
    const filtered = getFilteredSessions();
    if (handleGlobalKey(str, key, filtered[selectedIndex])) return;
    if (activePane === 'projects') {
      handleProjectsKey(str, key);
      return;
    }
    if (activePane === 'sidebar') handleSidebarKey(str, key, filtered);
    else handleMainKey(str, key);
    handleTabShortcut(str);
    render();
  });

  // --- Mouse (SGR mouse tracking with button events, \x1b[?1002h) ---

  const scrollSessions = (delta: 1 | -1) => {
    const filtered = getFilteredSessions();
    const next = selectedIndex + delta;
    if (next < 0 || next > filtered.length - 1) return;
    selectedIndex = next;
    if (filtered[selectedIndex]) loadDetail(filtered[selectedIndex]);
  };

  const clickToolbar = (x: number) => {
    const pill = projectPillBounds.find((item) => x >= item.startX && x <= item.endX);
    if (!pill) return;
    setProjectFilter(pill.proj);
    activePane = 'projects';
    render();
  };

  const clickTabs = (x: number, sidebarWidth: number) => {
    activePane = 'main';
    const tab = tabIndexAt(x, sidebarWidth);
    if (tab !== -1) showTab(tab);
    render();
  };

  const clickSidebar = (y: number) => {
    activePane = 'sidebar';
    const filtered = getFilteredSessions();
    const index = sessionIndexAtLine(filtered, isGrouped(), y - SIDEBAR_START + scrollOffset);
    if (index !== undefined) selectSession(index, filtered);
    render();
  };

  const leftClick = (x: number, y: number, sidebarWidth: number) => {
    if (y === 2) clickToolbar(x);
    else if (y === 3 && x > sidebarWidth) clickTabs(x, sidebarWidth);
    else if (y >= SIDEBAR_START && x <= sidebarWidth) clickSidebar(y);
    else if (y >= SIDEBAR_START) {
      activePane = 'main';
      render();
    }
  };

  process.stdin.on('data', (chunk) => {
    const mouse = parseMouse(chunk.toString());
    if (!mouse) return;
    const sidebarWidth = sidebarWidthFor(process.stdout.columns || 100);
    if (mouse.btn === 64 || mouse.btn === 65) {
      const delta = mouse.btn === 64 ? -1 : 1;
      if (mouse.x <= sidebarWidth) scrollSessions(delta);
      else rightScrollOffset = Math.max(0, rightScrollOffset + delta * 3);
      render();
    } else if (mouse.btn === 0 && mouse.press) leftClick(mouse.x, mouse.y, sidebarWidth);
  });

  process.stdout.on('resize', render);
  render();
}
