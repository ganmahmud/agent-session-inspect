import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import { displayName, projectName, shortId } from './codex.ts';
import { readCodexSessionDetail } from './detail.ts';
import type { ReplyActivity, ScanResult, SessionDetail, SessionInventory } from './types.ts';

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
  return value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value);
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

function duration(startedAt: string | undefined, updatedAt: string | undefined): string {
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

function formatCard(title: string, colorFn: (s: string) => string, lines: string[], width: number): string[] {
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
  return activity?.modelRequests.reduce((sum, request) => sum + (request.usage.totalTokens ?? 0), 0) ?? 0;
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
    ? (latest.usage.totalTokens ?? (latest.usage.inputTokens ?? 0) + (latest.usage.outputTokens ?? 0))
    : 0;
  const saturationPct = Math.min(100, Math.round((latestTotal / maxContext) * 100));

  const latestInput = latest?.usage.inputTokens ?? 0;
  const latestCached = latest?.usage.cachedInputTokens ?? 0;
  const latestFresh = Math.max(0, latestInput - latestCached);
  const latestOutput = latest?.usage.outputTokens ?? 0;
  const latestReasoning = latest?.usage.reasoningOutputTokens ?? 0;

  const cacheHitRatio = latestInput > 0 ? Math.round((latestCached / latestInput) * 100) : 0;
  const reasoningRatio = latestOutput > 0 ? Math.round((latestReasoning / latestOutput) * 100) : 0;

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

function computeTopTokenTurns(detail: SessionDetail, usageStats: UsageStats): TopTokenTurn[] {
  const assistantMsgs = detail.conversation.filter((m) => m.role === 'assistant');
  const grandTotal = usageStats.latestTotal || 1;

  const turns = assistantMsgs.map((m, turnIdx) => {
    const total = activityTotal(m.activity);
    const msgIdx = detail.conversation.findIndex((x) => x.id === m.id);
    const prevUserMsg = msgIdx > 0
      ? detail.conversation.slice(0, msgIdx).reverse().find((x) => x.role === 'user' && x.kind !== 'internal_review')
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
      promptSnippet: prevUserMsg?.text ? sanitize(prevUserMsg.text).slice(0, 100) : 'Assistant response',
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
        const current = map.get(key) ?? { name: key, kind: t.kind, count: 0, durationMs: 0 };
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

export async function startTui(scanResult: ScanResult): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive TUI requires a terminal TTY');
  }

  const sessions = scanResult.sessions;
  let selectedIndex = 0;
  let scrollOffset = 0;
  let rightScrollOffset = 0;
  let activeTab = 0; // 0: Overview, 1: Activity, 2: Analytics, 3: Tools, 4: Changes, 5: Subagents, 6: Metadata
  let activePane: 'sidebar' | 'main' = 'sidebar';
  let searchQuery = '';
  let isSearching = false;
  let selectedProjectFilter: string | null = null; // null = all projects
  let roleFilter: 'all' | 'user' | 'agent' | 'review' | 'subagent' = 'all';
  let currentDetail: SessionDetail | null = null;
  let loadingDetail = false;
  let notificationMessage = '';
  let notificationTimer: NodeJS.Timeout | null = null;

  // Extract all unique project names
  const allProjects = Array.from(
    new Set(sessions.map((s) => projectName(s)).filter((p) => p !== 'General / No Project'))
  ).sort();

  const notify = (msg: string) => {
    notificationMessage = msg;
    render();
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
      notificationMessage = '';
      render();
    }, 3000);
  };

  const getFilteredSessions = () => {
    let list = sessions;
    if (selectedProjectFilter) {
      list = list.filter((s) => projectName(s).toLowerCase() === selectedProjectFilter!.toLowerCase());
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((s) =>
        sanitize(displayName(s)).toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        projectName(s).toLowerCase().includes(q)
      );
    }
    return list;
  };

  const loadDetail = async (session: SessionInventory) => {
    loadingDetail = true;
    currentDetail = null;
    render();
    try {
      currentDetail = await readCodexSessionDetail(session);
    } catch {
      currentDetail = null;
    } finally {
      loadingDetail = false;
      render();
    }
  };

  // Setup Terminal with button mouse tracking to prevent terminal buffer scroll
  process.stdout.write('\x1b[?1049h'); // Alternate screen buffer
  process.stdout.write('\x1b[?25l');   // Hide cursor
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

  const render = () => {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;

    const sidebarWidth = Math.min(46, Math.max(32, Math.floor(cols * 0.36)));
    const mainWidth = Math.max(20, cols - sidebarWidth - 1);

    const filtered = getFilteredSessions();
    if (selectedIndex >= filtered.length) selectedIndex = Math.max(0, filtered.length - 1);

    // Each session item uses 2 terminal rows
    const visibleItemCount = Math.floor((rows - 5) / 2);
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    if (selectedIndex >= scrollOffset + visibleItemCount) scrollOffset = selectedIndex - visibleItemCount + 1;

    const buffer: string[] = [];
    const move = (r: number, col: number) => `\x1b[${r};${col}H`;

    // 1. Move cursor to Home
    buffer.push('\x1b[H');

    // 2. Header Banner
    const totalTokens = sessions.reduce((sum, s) => sum + (latestTokens(s) ?? 0), 0);
    const headerTitle = `⚡ AGENT SESSION INSPECTOR`;
    const projectFilterText = selectedProjectFilter ? `📁 ${selectedProjectFilter} · ` : '';
    const headerStats = `${projectFilterText}${filtered.length}/${sessions.length} sessions · ${formatCompactTokens(totalTokens)} tokens`;
    const focusTag = activePane === 'sidebar' ? c.bgFocusTag(' SIDEBAR FOCUS ') : c.bgFocusTag(' MAIN FOCUS ');
    const headerLine = ` ${c.bold(headerTitle)}  ${c.dim('│')}  ${c.yellow(headerStats)}  ${focusTag}`.padEnd(cols - 1);
    buffer.push(move(1, 1) + c.bgHeader(headerLine.slice(0, cols)));

    // 3. Vertical Divider Line
    const dividerColor = activePane === 'sidebar' ? c.cyan : c.darkGray;
    for (let r = 2; r < rows; r++) {
      buffer.push(move(r, sidebarWidth + 1) + dividerColor('│'));
    }

    // 4. Sidebar Search / Filter Bar
    const prjTag = selectedProjectFilter ? ` [PRJ: ${selectedProjectFilter}]` : '';
    const searchStr = isSearching
      ? `🔍 SEARCH: ${searchQuery}_`
      : `🔍 FILTER: ${searchQuery || 'all sessions'}${prjTag}`;
    const sidebarTitleColor = activePane === 'sidebar' ? c.cyan : c.dim;
    buffer.push(move(2, 2) + '\x1b[K' + sidebarTitleColor(c.bold(searchStr.slice(0, sidebarWidth - 2).padEnd(sidebarWidth - 2))));
    buffer.push(move(3, 1) + '\x1b[K' + c.darkGray('─'.repeat(sidebarWidth)));

    // 5. Sidebar Session List
    for (let i = 0; i < visibleItemCount; i++) {
      const idx = scrollOffset + i;
      const rowStart = 4 + (i * 2);
      if (idx >= filtered.length || rowStart + 1 >= rows) break;

      const session = filtered[idx];
      const isSelected = idx === selectedIndex;
      const cleanTitle = sanitize(displayName(session));
      const tokens = latestTokens(session);
      const subCount = getSubagentCount(session);
      const pName = projectName(session);

      const subagentsStr = subCount > 0 ? ` · 🤖${subCount}` : '';
      const prjStr = pName && pName !== 'General / No Project' && !selectedProjectFilter ? ` · 📁${pName.slice(0, 10)}` : '';
      const sub = `${date(session.startedAt)} · ${duration(session.startedAt, session.updatedAt)}${tokens ? ' · ' + formatCompactTokens(tokens) + 't' : ''}${subagentsStr}${prjStr}`;

      const icon = isSelected ? (activePane === 'sidebar' ? '▶ ' : '👉 ') : '◈ ';
      const line1Text = (icon + cleanTitle).slice(0, sidebarWidth - 2).padEnd(sidebarWidth - 2);
      const line2Text = (`   ${sub}`).slice(0, sidebarWidth - 2).padEnd(sidebarWidth - 2);

      if (isSelected) {
        buffer.push(move(rowStart, 1) + '\x1b[K' + c.bgSelected(line1Text));
        buffer.push(move(rowStart + 1, 1) + '\x1b[K' + c.bgSelected(line2Text));
      } else {
        buffer.push(move(rowStart, 1) + '\x1b[K' + c.white(line1Text));
        buffer.push(move(rowStart + 1, 1) + '\x1b[K' + c.gray(line2Text));
      }
    }

    // Clear empty rows below sidebar list
    const maxSidebarRow = 4 + (visibleItemCount * 2);
    for (let r = maxSidebarRow; r < rows; r++) {
      buffer.push(move(r, 1) + '\x1b[K');
    }

    // 6. Right Panel Header & Navigation Tabs (7 tabs)
    const selectedSession = filtered[selectedIndex];
    const tabLabels = [' Overview ', ' Activity ', ' Analytics ', ' Tools ', ' Changes ', ' Subagents ', ' Metadata '];
    const tabHeaders = tabLabels.map((label, idx) => {
      const shortcut = `[${idx + 1}]`;
      const fullLabel = `${shortcut}${label}`;
      return idx === activeTab ? c.bgTabActive(fullLabel) : c.bgTabInactive(fullLabel);
    }).join(' ');

    buffer.push(move(2, sidebarWidth + 3) + '\x1b[K' + tabHeaders);
    buffer.push(move(3, sidebarWidth + 2) + '\x1b[K' + c.darkGray('─'.repeat(mainWidth)));

    // 7. Right Panel Main Content Area
    if (!selectedSession) {
      buffer.push(move(5, sidebarWidth + 4) + '\x1b[K' + c.dim('No sessions match the current filter.'));
    } else {
      const currentLines: string[] = [];

      if (activeTab === 0) {
        // OVERVIEW TAB
        currentLines.push(c.brightCyan(c.bold(`◈ ${sanitize(displayName(selectedSession))}`)));
        currentLines.push(c.gray(`ID: ${selectedSession.id}`));
        currentLines.push('');

        currentLines.push(...formatCard('WORKSPACE & TIMELINE', c.cyan, [
          ...(selectedSession.cwd || selectedSession.projectName ? [
            `Project Workspace   ${projectName(selectedSession)}`,
            ...(selectedSession.cwd ? [`Directory Path      ${selectedSession.cwd}`] : []),
          ] : []),
          `Started             ${selectedSession.startedAt ?? 'unknown'}`,
          `Updated             ${selectedSession.updatedAt ?? 'unknown'}`,
          `Duration            ${duration(selectedSession.startedAt, selectedSession.updatedAt)}`,
          `Title Source        ${selectedSession.displayTitle.source}`,
          ...(selectedSession.provider ? [`Provider            ${selectedSession.provider.toUpperCase()}`] : []),
        ], mainWidth - 4));

        currentLines.push('');
        const token = selectedSession.token.last ?? selectedSession.token.total;
        currentLines.push(...formatCard('TOKEN METRICS', c.yellow, [
          `Total Tokens        ${formatNumber(token?.totalTokens)} (${formatCompactTokens(token?.totalTokens)})`,
          `Cached Input        ${formatNumber(token?.cachedInputTokens)}`,
          `Output Tokens       ${formatNumber(token?.outputTokens)}`,
          `Reasoning Tokens    ${formatNumber(token?.reasoningOutputTokens)}`,
        ], mainWidth - 4));

        currentLines.push('');
        const subCount = getSubagentCount(selectedSession);
        currentLines.push(...formatCard('EXECUTION & SUBAGENTS FLEET', c.purple, [
          `Subagents Fleet     ${subCount > 0 ? `${subCount} spawned` : 'none'}`,
          `Tool Calls          ${selectedSession.tools.calls} calls (${selectedSession.tools.outputs} outputs)`,
          `Task Status         ${selectedSession.taskCount} started · ${selectedSession.completedTaskCount} completed · ${selectedSession.abortedTaskCount} aborted`,
          `Compactions         ${selectedSession.compactionCount} compactions · ${selectedSession.rollbackCount} rollbacks`,
        ], mainWidth - 4));

        if (currentDetail) {
          const stats = computeUsageStats(currentDetail);
          const profile = computeToolUsageProfile(currentDetail);
          currentLines.push('');
          currentLines.push(...formatCard('CONTEXT EFFICIENCY & CODE EDITS', c.emerald, [
            `Context Meter       ${progressBar(stats.saturationPct, 16)}`,
            `Cache Hit Ratio     ${stats.cacheHitRatio}%`,
            `Reasoning Ratio     ${stats.reasoningRatio}%`,
            `Code Edits          ${profile.totalEditsCount} edits across ${profile.uniqueEditedFilesCount} files`,
          ], mainWidth - 4));
        }

      } else if (activeTab === 1) {
        // ACTIVITY TAB (CONVERSATION TIMELINE WITH ROLE FILTERING & RICH BREAKDOWN)
        if (loadingDetail) {
          currentLines.push(c.yellow('⚡ Loading session activity transcript...'));
        } else if (!currentDetail || !currentDetail.conversation.length) {
          currentLines.push(c.dim('No conversation activity records found.'));
        } else {
          const filterLabel = roleFilter === 'agent'
            ? 'CODEX AGENT'
            : roleFilter === 'subagent'
              ? 'SUBAGENTS'
              : roleFilter.toUpperCase();
          currentLines.push(c.brightCyan(c.bold(`CONVERSATION & ACTIVITY TIMELINE`)) + c.gray(`  [ FILTER: ${filterLabel} · Press 'r' to cycle ]`));
          currentLines.push('');

          let conversationList = currentDetail.conversation;
          if (roleFilter === 'user') conversationList = conversationList.filter((m) => m.role === 'user' && m.kind !== 'internal_review');
          else if (roleFilter === 'agent') conversationList = conversationList.filter((m) => m.role === 'assistant');
          else if (roleFilter === 'review') conversationList = conversationList.filter((m) => m.kind === 'internal_review');
          else if (roleFilter === 'subagent') {
            conversationList = conversationList.filter((m) =>
              m.activity?.tools.some((t) => t.kind === 'subagent' || t.name.toLowerCase().includes('subagent') || t.name.toLowerCase().includes('agent'))
            );
          }

          if (conversationList.length === 0) {
            currentLines.push(c.dim(`No messages match the active role filter [${filterLabel}].`));
          } else {
            for (const item of conversationList) {
              if (item.kind === 'internal_review') {
                const textLines = item.text ? item.text.split('\n') : ['(empty review entry)'];
                currentLines.push(...formatCard('🛡️ INTERNAL REVIEW', c.yellow, textLines, mainWidth - 4));
                currentLines.push('');
              } else if (item.role === 'user') {
                const textLines = item.text ? item.text.split('\n') : ['(empty message)'];
                currentLines.push(...formatCard('👤 USER', c.emerald, textLines, mainWidth - 4));
                currentLines.push('');
              } else if (item.role === 'assistant') {
                const cardLines: string[] = [];
                if (item.activity?.model.name) {
                  cardLines.push(c.gray(`Model: ${item.activity.model.name}`));
                }

                const totalTurnTokens = activityTotal(item.activity);
                if (totalTurnTokens > 0) {
                  let inTokens = 0, cachedTokens = 0, outTokens = 0, reasoningTokens = 0;
                  for (const req of item.activity?.modelRequests ?? []) {
                    inTokens += req.usage.inputTokens ?? 0;
                    cachedTokens += req.usage.cachedInputTokens ?? 0;
                    outTokens += req.usage.outputTokens ?? 0;
                    reasoningTokens += req.usage.reasoningOutputTokens ?? 0;
                  }
                  cardLines.push(c.yellow(`Tokens: ${formatNumber(totalTurnTokens)} total (In: ${formatNumber(inTokens)}, Cached: ${formatNumber(cachedTokens)}, Out: ${formatNumber(outTokens)}, Reasoning: ${formatNumber(reasoningTokens)})`));
                  cardLines.push('');
                }

                if (item.text) {
                  cardLines.push(...item.text.split('\n'));
                }

                if (item.activity?.tools.length) {
                  cardLines.push('');
                  cardLines.push(c.purple(`⚡ Tools Executed (${item.activity.tools.length}):`));
                  for (const tool of item.activity.tools) {
                    const durStr = tool.durationMs ? `${tool.durationMs}ms` : 'exec';
                    const isSub = tool.kind === 'subagent' || tool.name.toLowerCase().includes('subagent');
                    const prefix = isSub ? '🤖 [SUBAGENT] ' : '• ';
                    cardLines.push(`  ${prefix}${tool.name} (${durStr})`);
                  }
                }

                if (item.activity?.edits.length) {
                  cardLines.push('');
                  cardLines.push(c.emerald(`✏️ Code Edits:`));
                  for (const edit of item.activity.edits) {
                    for (const f of edit.files) {
                      cardLines.push(`  • ${f.path}${f.operation ? ` (${f.operation})` : ''}`);
                    }
                  }
                }

                currentLines.push(...formatCard('🤖 CODEX AGENT', c.cyan, cardLines, mainWidth - 4));
                currentLines.push('');
              }
            }
          }
        }

      } else if (activeTab === 2) {
        // ANALYTICS TAB (RESOURCE CONSUMPTION & TOKEN USAGE VISUALIZER)
        if (loadingDetail) {
          currentLines.push(c.yellow('⚡ Computing session analytics & token profile...'));
        } else if (!currentDetail) {
          currentLines.push(c.dim('No session detail loaded for analytics.'));
        } else {
          const stats = computeUsageStats(currentDetail);
          const topSpikes = computeTopTokenTurns(currentDetail, stats);
          const profile = computeToolUsageProfile(currentDetail);

          currentLines.push(c.brightCyan(c.bold('📊 SESSION RESOURCE & TOKEN ANALYTICS')));
          currentLines.push('');

          // 1. CONTEXT WINDOW & CACHE EFFICIENCY
          currentLines.push(...formatCard('CONTEXT WINDOW & CACHE EFFICIENCY', c.yellow, [
            `Saturation Meter ${progressBar(stats.saturationPct, 22)}`,
            `Window Capacity  ${formatNumber(stats.latestTotal)} / ${formatNumber(stats.maxContext)} tokens`,
            `Cache Hit Ratio  ${stats.cacheHitRatio}% (${formatNumber(stats.latestCached)} / ${formatNumber(stats.latestInput)} input tokens)`,
            `Reasoning Ratio  ${stats.reasoningRatio}% (${formatNumber(stats.latestReasoning)} / ${formatNumber(stats.latestOutput)} output tokens)`,
          ], mainWidth - 4));
          currentLines.push('');

          // 2. TIME & RESOURCE PROFILE
          currentLines.push(...formatCard('TIME & RESOURCE PROFILE', c.purple, [
            `Tool Execution   ${stats.totalToolMs} ms measured tool work`,
            `Overhead/Model   ${stats.totalOtherMs} ms model/system time`,
            `Code Edits       ${profile.totalEditsCount} edits across ${profile.uniqueEditedFilesCount} unique files`,
            `Snapshots        ${stats.snapshotCount} usage snapshots · ${stats.modelStepCount} model steps`,
          ], mainWidth - 4));
          currentLines.push('');

          // 3. TOP TOKEN-HEAVY TURN SPIKES (TOP 5)
          const spikeLines: string[] = [];
          if (topSpikes.length === 0) {
            spikeLines.push('No token usage spikes recorded.');
          } else {
            for (const spike of topSpikes) {
              spikeLines.push(c.bold(`Turn #${spike.turnNumber} — ${formatNumber(spike.totalTokens)} tokens (${spike.shareOfSessionPct}% of session)`));
              spikeLines.push(`  Model: ${spike.modelName} | In: ${formatNumber(spike.input)} (${formatNumber(spike.cached)} cached) | Out: ${formatNumber(spike.output)}`);
              spikeLines.push(`  Prompt: "${spike.promptSnippet}"`);
              spikeLines.push('');
            }
          }
          currentLines.push(...formatCard('TOP TOKEN-HEAVY TURNS (SPIKES)', c.red, spikeLines, mainWidth - 4));
          currentLines.push('');

          // 4. TOOL INVOCATION PROFILE
          const toolLines: string[] = [];
          if (profile.tools.length === 0) {
            toolLines.push('No tools invoked in this session.');
          } else {
            toolLines.push(`Total Tool Invocations: ${profile.totalInvocations}`);
            toolLines.push('');
            for (const item of profile.tools) {
              toolLines.push(`• ${item.name} (${item.kind}): ${item.count} calls · ${item.durationMs} ms total`);
            }
          }
          currentLines.push(...formatCard('TOOL INVOCATION & TIMING PROFILE', c.emerald, toolLines, mainWidth - 4));
        }

      } else if (activeTab === 3) {
        // TOOLS TAB (TOOL EXECUTIONS & DETAILS)
        if (loadingDetail) {
          currentLines.push(c.yellow('⚡ Loading tool executions...'));
        } else if (!currentDetail) {
          currentLines.push(c.dim('No detail loaded'));
        } else {
          currentLines.push(c.purple(c.bold('TOOL EXECUTIONS & DETAILS')));
          currentLines.push('');
          let count = 0;
          for (const msg of currentDetail.conversation) {
            if (msg.activity?.tools?.length) {
              for (const tool of msg.activity.tools) {
                count++;
                const statusSymbol = tool.status === 'completed' || tool.status === '0'
                  ? c.emerald('✓ completed')
                  : tool.status
                    ? c.red(`✗ ${tool.status}`)
                    : c.dim('exec');
                const title = `⚙️ TOOL #${count}: ${tool.name} [${statusSymbol}]`;
                const content: string[] = [];
                content.push(`Kind:     ${tool.kind}`);
                content.push(`Duration: ${tool.durationMs !== undefined ? tool.durationMs + 'ms' : '—'}`);
                if (tool.input) content.push(`Input:    ${sanitize(tool.input)}`);
                if (tool.output) content.push(`Output:   ${sanitize(tool.output)}`);
                currentLines.push(...formatCard(title, c.purple, content, mainWidth - 4));
                currentLines.push('');
              }
            }
          }
          if (!count) currentLines.push(c.dim('No tool execution records found.'));
        }

      } else if (activeTab === 4) {
        // CHANGES / DIFFS TAB
        if (loadingDetail) {
          currentLines.push(c.yellow('⚡ Loading file changes and diffs...'));
        } else if (!currentDetail) {
          currentLines.push(c.dim('No session detail loaded for changes.'));
        } else {
          currentLines.push(c.emerald(c.bold('✏️ FILE CHANGES & CODE PATCHES')));
          currentLines.push('');

          const allEdits = currentDetail.conversation.flatMap((m) => m.activity?.edits ?? []);
          const fileDiffsMap = new Map<string, { path: string; operation?: string; diffs: string[] }>();

          for (const edit of allEdits) {
            for (const f of edit.files) {
              const existing = fileDiffsMap.get(f.path) ?? { path: f.path, operation: f.operation, diffs: [] };
              if (f.diff) existing.diffs.push(f.diff);
              if (f.operation) existing.operation = f.operation;
              fileDiffsMap.set(f.path, existing);
            }
          }

          if (fileDiffsMap.size === 0) {
            currentLines.push(c.dim('No file edits or code patches recorded in this session.'));
          } else {
            currentLines.push(c.yellow(`Modified Files: ${fileDiffsMap.size} files across ${allEdits.length} edit operations`));
            currentLines.push('');

            for (const [filePath, info] of fileDiffsMap.entries()) {
              const op = info.operation ? `[${info.operation.toUpperCase()}] ` : '';
              const title = `📄 ${op}${filePath}`;
              const diffLines: string[] = [];

              if (info.diffs.length === 0) {
                diffLines.push(c.dim('(File modified without unified diff snippet recorded)'));
              } else {
                for (const rawDiff of info.diffs) {
                  const lines = rawDiff.split('\n');
                  for (const l of lines) {
                    if (l.startsWith('+')) {
                      diffLines.push(c.emerald(l));
                    } else if (l.startsWith('-')) {
                      diffLines.push(c.red(l));
                    } else if (l.startsWith('@@')) {
                      diffLines.push(c.cyan(l));
                    } else {
                      diffLines.push(c.gray(l));
                    }
                  }
                  diffLines.push('');
                }
              }

              currentLines.push(...formatCard(title, c.emerald, diffLines, mainWidth - 4));
              currentLines.push('');
            }
          }
        }

      } else if (activeTab === 5) {
        // SUBAGENTS TAB
        currentLines.push(c.purple(c.bold('🤖 SUBAGENTS FLEET HIERARCHY')));
        currentLines.push('');

        const subagents = (selectedSession.relationships ?? []).filter((r) => r.type === 'subagent');
        const parents = (selectedSession.relationships ?? []).filter((r) => r.type === 'parent');

        const relLines: string[] = [];
        if (parents.length > 0) {
          relLines.push(c.bold('Parent Session:'));
          for (const p of parents) {
            relLines.push(`  ⬆️ ${p.sessionId}`);
          }
          relLines.push('');
        }

        if (subagents.length > 0) {
          relLines.push(c.bold(`Spawned Subagents (${subagents.length}):`));
          for (const sub of subagents) {
            relLines.push(`  🤖 Subagent ID: ${sub.sessionId}`);
          }
          relLines.push('');
        }

        const subEventsCount =
          (selectedSession.eventCounts?.['sub_agent_activity'] ?? 0) +
          (selectedSession.eventCounts?.['subagent_activity'] ?? 0) +
          (selectedSession.eventCounts?.['agent_activity'] ?? 0);

        relLines.push(`Subagent Activity Events: ${subEventsCount}`);

        currentLines.push(...formatCard('FLEET TOPOLOGY & COUNTS', c.purple, relLines, mainWidth - 4));
        currentLines.push('');

        if (currentDetail) {
          const subagentTools: string[] = [];
          for (const m of currentDetail.conversation) {
            if (m.activity?.tools) {
              for (const t of m.activity.tools) {
                if (t.kind === 'subagent' || t.name.toLowerCase().includes('subagent') || t.name.toLowerCase().includes('agent')) {
                  subagentTools.push(`• ${t.name} (${t.durationMs ? `${t.durationMs}ms` : 'exec'})`);
                  if (t.input) subagentTools.push(`  Input: ${sanitize(t.input).slice(0, 120)}`);
                  if (t.output) subagentTools.push(`  Result: ${sanitize(t.output).slice(0, 120)}`);
                  subagentTools.push('');
                }
              }
            }
          }

          if (subagentTools.length > 0) {
            currentLines.push(...formatCard('SUBAGENT ACTIVITY TRANSCRIPT', c.cyan, subagentTools, mainWidth - 4));
          } else {
            currentLines.push(c.dim('No dedicated subagent tool invocations in conversation.'));
          }
        }

      } else if (activeTab === 6) {
        // METADATA TAB
        currentLines.push(c.gray('RAW SESSION INVENTORY METADATA:'));
        currentLines.push('');
        const rawJson = JSON.stringify(selectedSession, null, 2);
        currentLines.push(...rawJson.split('\n'));
      }

      // Render main content area with Line Erase (\x1b[K) and scroll clamping
      const mainHeight = rows - 5;
      const maxScroll = Math.max(0, currentLines.length - mainHeight);
      if (rightScrollOffset > maxScroll) rightScrollOffset = maxScroll;
      if (rightScrollOffset < 0) rightScrollOffset = 0;

      for (let r = 0; r < mainHeight; r++) {
        const lineIdx = rightScrollOffset + r;
        const lineStr = currentLines[lineIdx];
        buffer.push(move(4 + r, sidebarWidth + 3) + '\x1b[K' + (lineStr ?? ''));
      }
    }

    // 8. Footer Status Bar
    if (notificationMessage) {
      buffer.push(move(rows, 1) + '\x1b[K' + c.bgNotice(` ${notificationMessage} `.padEnd(cols - 1).slice(0, cols)));
    } else {
      const statusHelp = activePane === 'sidebar'
        ? ` [TAB/→] Main Pane | [↑/↓] Select Session | [1-7] Tabs | [/] Search | [p] Project | [e] Export | [c] Copy ID | [q] Exit`
        : ` [TAB] Sidebar | [←/→] Tabs | [↑/↓] Scroll | [1-7] Jump Tab | [r] Role Filter | [p] Project | [e] Export | [q] Exit`;
      const footerText = isSearching
        ? ` TYPE FILTER · [ENTER] Save · [ESC] Clear filter`
        : statusHelp;
      buffer.push(move(rows, 1) + '\x1b[K' + c.bgHeader(footerText.padEnd(cols - 1).slice(0, cols)));
    }

    process.stdout.write(buffer.join(''));
  };

  // Load first session detail on boot
  const filteredInit = getFilteredSessions();
  if (filteredInit[0]) loadDetail(filteredInit[0]);

  // Keyboard Event Listener
  process.stdin.on('keypress', (str, key) => {
    if (isSearching) {
      if (key.name === 'return' || key.name === 'escape') {
        isSearching = false;
      } else if (key.name === 'backspace') {
        searchQuery = searchQuery.slice(0, -1);
      } else if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
        searchQuery += str;
      }
      selectedIndex = 0;
      scrollOffset = 0;
      const filtered = getFilteredSessions();
      if (filtered[0]) loadDetail(filtered[0]);
      render();
      return;
    }

    if (key.ctrl && key.name === 'c') cleanup();
    if (str === 'q') cleanup();

    const filtered = getFilteredSessions();
    const selectedSession = filtered[selectedIndex];

    if (key.name === 'tab') {
      activePane = activePane === 'sidebar' ? 'main' : 'sidebar';
      render();
      return;
    }

    // Toggle / Cycle Project Filter with 'p'
    if (str === 'p') {
      if (allProjects.length === 0) {
        notify('No named projects found in session inventory.');
      } else if (!selectedProjectFilter) {
        selectedProjectFilter = allProjects[0];
        notify(`Filtered by Project: ${selectedProjectFilter}`);
      } else {
        const curIdx = allProjects.indexOf(selectedProjectFilter);
        if (curIdx >= 0 && curIdx < allProjects.length - 1) {
          selectedProjectFilter = allProjects[curIdx + 1];
          notify(`Filtered by Project: ${selectedProjectFilter}`);
        } else {
          selectedProjectFilter = null;
          notify('Cleared Project Filter (showing all sessions)');
        }
      }
      selectedIndex = 0;
      scrollOffset = 0;
      const newFiltered = getFilteredSessions();
      if (newFiltered[0]) loadDetail(newFiltered[0]);
      render();
      return;
    }

    if (str === 'e' && currentDetail) {
      try {
        const file = exportSessionJson(currentDetail);
        notify(`Exported session JSON to: ${file}`);
      } catch (err) {
        notify(`Failed to export session JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (str === 'c' && selectedSession) {
      notify(`Copied Session ID: ${selectedSession.id}`);
      return;
    }

    if ((str === 'r' || str === 'f') && activeTab === 1) {
      const filters: Array<'all' | 'user' | 'agent' | 'review' | 'subagent'> = ['all', 'user', 'agent', 'review', 'subagent'];
      const nextIdx = (filters.indexOf(roleFilter) + 1) % filters.length;
      roleFilter = filters[nextIdx];
      rightScrollOffset = 0;
      render();
      return;
    }

    if (activePane === 'sidebar') {
      if (key.name === 'up' || str === 'k') {
        if (selectedIndex > 0) {
          selectedIndex--;
          rightScrollOffset = 0;
          if (filtered[selectedIndex]) loadDetail(filtered[selectedIndex]);
        }
      } else if (key.name === 'down' || str === 'j') {
        if (selectedIndex < filtered.length - 1) {
          selectedIndex++;
          rightScrollOffset = 0;
          if (filtered[selectedIndex]) loadDetail(filtered[selectedIndex]);
        }
      } else if (key.name === 'right' || str === 'l') {
        activePane = 'main';
      }
    } else {
      // Main Content Focus Controls
      if (key.name === 'right' || str === 'l') {
        if (activeTab < 6) {
          activeTab++;
          rightScrollOffset = 0;
        }
      } else if (key.name === 'left' || str === 'h') {
        if (activeTab > 0) {
          activeTab--;
          rightScrollOffset = 0;
        } else {
          // On first tab (Overview), left arrow switches focus to Sidebar
          activePane = 'sidebar';
        }
      } else if (key.name === 'up' || str === 'k') {
        rightScrollOffset = Math.max(0, rightScrollOffset - 1);
      } else if (key.name === 'down' || str === 'j') {
        rightScrollOffset++;
      } else if (key.name === 'pageup') {
        rightScrollOffset = Math.max(0, rightScrollOffset - 8);
      } else if (key.name === 'pagedown') {
        rightScrollOffset += 8;
      } else if (key.name === 'home') {
        rightScrollOffset = 0;
      } else if (key.name === 'end') {
        rightScrollOffset = 999999;
      }
    }

    if (str === '/') {
      isSearching = true;
      searchQuery = '';
    } else if (str === '1') {
      activeTab = 0;
      rightScrollOffset = 0;
    } else if (str === '2') {
      activeTab = 1;
      rightScrollOffset = 0;
    } else if (str === '3') {
      activeTab = 2;
      rightScrollOffset = 0;
    } else if (str === '4') {
      activeTab = 3;
      rightScrollOffset = 0;
    } else if (str === '5') {
      activeTab = 4;
      rightScrollOffset = 0;
    } else if (str === '6') {
      activeTab = 5;
      rightScrollOffset = 0;
    } else if (str === '7') {
      activeTab = 6;
      rightScrollOffset = 0;
    }

    render();
  });

  // Mouse Listener (SGR Mouse Tracking with Button Event \x1b[?1002h)
  process.stdin.on('data', (chunk) => {
    const raw = chunk.toString();
    const mouseMatch = raw.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (!mouseMatch) return;

    const btn = parseInt(mouseMatch[1], 10);
    const x = parseInt(mouseMatch[2], 10);
    const y = parseInt(mouseMatch[3], 10);
    const isPress = mouseMatch[4] === 'M';

    const cols = process.stdout.columns || 100;
    const sidebarWidth = Math.min(46, Math.max(32, Math.floor(cols * 0.36)));

    if (btn === 64) { // Scroll Up
      if (x <= sidebarWidth) {
        if (selectedIndex > 0) {
          selectedIndex--;
          const filtered = getFilteredSessions();
          if (filtered[selectedIndex]) loadDetail(filtered[selectedIndex]);
        }
      } else {
        rightScrollOffset = Math.max(0, rightScrollOffset - 3);
      }
      render();
    } else if (btn === 65) { // Scroll Down
      if (x <= sidebarWidth) {
        const filtered = getFilteredSessions();
        if (selectedIndex < filtered.length - 1) {
          selectedIndex++;
          if (filtered[selectedIndex]) loadDetail(filtered[selectedIndex]);
        }
      } else {
        rightScrollOffset += 3;
      }
      render();
    } else if (btn === 0 && isPress) { // Left Click
      if (x <= sidebarWidth && y >= 4) {
        activePane = 'sidebar';
        const clickedIdx = scrollOffset + Math.floor((y - 4) / 2);
        const filtered = getFilteredSessions();
        if (clickedIdx >= 0 && clickedIdx < filtered.length) {
          selectedIndex = clickedIdx;
          rightScrollOffset = 0;
          loadDetail(filtered[selectedIndex]);
          render();
        }
      } else if (x > sidebarWidth) {
        activePane = 'main';
        if (y === 2) { // Click Tab Header
          const tabLabels = [' Overview ', ' Activity ', ' Analytics ', ' Tools ', ' Changes ', ' Subagents ', ' Metadata '];
          let currentX = sidebarWidth + 3;
          let clickedTab = -1;
          for (let i = 0; i < tabLabels.length; i++) {
            const tabLen = `[${i + 1}]${tabLabels[i]}`.length;
            if (x >= currentX && x < currentX + tabLen + 1) {
              clickedTab = i;
              break;
            }
            currentX += tabLen + 1;
          }
          if (clickedTab !== -1) {
            activeTab = clickedTab;
            rightScrollOffset = 0;
          }
        }
        render();
      }
    }
  });

  process.stdout.on('resize', render);
  render();
}
