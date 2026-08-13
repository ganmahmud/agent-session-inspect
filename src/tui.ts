import readline from 'node:readline';
import { displayName, shortId } from './codex.ts';
import { readCodexSessionDetail } from './detail.ts';
import type { ScanResult, SessionDetail, SessionInventory } from './types.ts';

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
};

function sanitize(str: string | null | undefined): string {
  if (!str) return '';
  return str.replace(/[\r\n\t]+/g, ' ').trim();
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value);
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
    while (current.length > maxWidth) {
      let spaceIdx = current.lastIndexOf(' ', maxWidth);
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
  const titleStr = `─ ${title} `;
  const topBorderLen = Math.max(0, cardWidth - titleStr.length - 2);
  const header = colorFn(`┌${titleStr}${'─'.repeat(topBorderLen)}┐`);
  const footer = colorFn(`└${'─'.repeat(Math.max(0, cardWidth - 2))}┘`);

  const wrapped = lines.flatMap((line) => wrapText(line, innerWidth));
  const body = wrapped.map((line) => `${colorFn('│')} ${line.padEnd(innerWidth)} ${colorFn('│')}`);
  return [header, ...body, footer];
}

export async function startTui(scanResult: ScanResult): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive TUI requires a terminal TTY');
  }

  const sessions = scanResult.sessions;
  let selectedIndex = 0;
  let scrollOffset = 0;
  let rightScrollOffset = 0;
  let activeTab = 0; // 0: Overview, 1: Activity, 2: Tools, 3: Metadata
  let activePane: 'sidebar' | 'main' = 'sidebar';
  let searchQuery = '';
  let isSearching = false;
  let currentDetail: SessionDetail | null = null;
  let loadingDetail = false;

  const getFilteredSessions = () => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => sanitize(displayName(s)).toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
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

    const sidebarWidth = Math.min(42, Math.max(30, Math.floor(cols * 0.36)));
    const mainWidth = Math.max(20, cols - sidebarWidth - 1);

    const filtered = getFilteredSessions();
    if (selectedIndex >= filtered.length) selectedIndex = Math.max(0, filtered.length - 1);

    // Each session item uses 2 terminal rows
    const visibleItemCount = Math.floor((rows - 5) / 2);
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    if (selectedIndex >= scrollOffset + visibleItemCount) scrollOffset = selectedIndex - visibleItemCount + 1;

    const buffer: string[] = [];
    const move = (r: number, col: number) => `\x1b[${r};${col}H`;

    // 1. Move cursor to Home (Do not call \x1b[2J to avoid outer terminal scrollback redraw)
    buffer.push('\x1b[H');

    // 2. Header Banner
    const totalTokens = sessions.reduce((sum, s) => sum + (latestTokens(s) ?? 0), 0);
    const headerTitle = `⚡ AGENT SESSION INSPECTOR`;
    const headerStats = `${filtered.length}/${sessions.length} sessions · ${formatNumber(totalTokens)} tokens`;
    const focusTag = activePane === 'sidebar' ? c.bgFocusTag(' SIDEBAR FOCUS ') : c.bgFocusTag(' TRANSCRIPT FOCUS ');
    const headerLine = ` ${c.bold(headerTitle)}  ${c.dim('│')}  ${c.yellow(headerStats)}  ${focusTag}`.padEnd(cols - 1);
    buffer.push(move(1, 1) + c.bgHeader(headerLine.slice(0, cols)));

    // 3. Vertical Divider Line
    const dividerColor = activePane === 'sidebar' ? c.cyan : c.darkGray;
    for (let r = 2; r < rows; r++) {
      buffer.push(move(r, sidebarWidth + 1) + dividerColor('│'));
    }

    // 4. Sidebar Search / Filter Bar
    const searchStr = isSearching ? `🔍 SEARCH: ${searchQuery}_` : `🔍 FILTER: ${searchQuery || 'all sessions'}`;
    const sidebarTitleColor = activePane === 'sidebar' ? c.cyan : c.dim;
    buffer.push(move(2, 2) + '\x1b[K' + sidebarTitleColor(c.bold(searchStr.slice(0, sidebarWidth - 2).padEnd(sidebarWidth - 2))));
    buffer.push(move(3, 1) + '\x1b[K' + c.darkGray('─'.repeat(sidebarWidth)));

    // 5. Sidebar Session List (Spacious 2-line cards)
    for (let i = 0; i < visibleItemCount; i++) {
      const idx = scrollOffset + i;
      const rowStart = 4 + (i * 2);
      if (idx >= filtered.length || rowStart + 1 >= rows) break;

      const session = filtered[idx];
      const isSelected = idx === selectedIndex;
      const cleanTitle = sanitize(displayName(session));
      const tokens = latestTokens(session);
      const sub = `${date(session.startedAt)} · ${duration(session.startedAt, session.updatedAt)}${tokens ? ' · ' + formatNumber(tokens) + 't' : ''}`;

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

    // 6. Right Panel Header & Navigation Tabs
    const selectedSession = filtered[selectedIndex];
    const tabLabels = [' Overview ', ' Activity ', ' Tools ', ' Metadata '];
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

        currentLines.push(...formatCard('TIMELINE & METRICS', c.cyan, [
          `Started      ${selectedSession.startedAt ?? 'unknown'}`,
          `Updated      ${selectedSession.updatedAt ?? 'unknown'}`,
          `Duration     ${duration(selectedSession.startedAt, selectedSession.updatedAt)}`,
          `Title Src    ${selectedSession.displayTitle.source}`,
        ], mainWidth - 4));

        currentLines.push('');
        const token = selectedSession.token.last ?? selectedSession.token.total;
        currentLines.push(...formatCard('TOKEN USAGE', c.yellow, [
          `Total Tokens   ${formatNumber(token?.totalTokens)}`,
          `Cached Input   ${formatNumber(token?.cachedInputTokens)}`,
        ], mainWidth - 4));

        currentLines.push('');
        currentLines.push(...formatCard('EXECUTION & TASKS', c.purple, [
          `Tool Calls     ${selectedSession.tools.calls} calls (${selectedSession.tools.outputs} outputs)`,
          `Task Status    ${selectedSession.taskCount} started · ${selectedSession.completedTaskCount} completed · ${selectedSession.abortedTaskCount} aborted`,
          `Compactions    ${selectedSession.compactionCount} compactions · ${selectedSession.rollbackCount} rollbacks`,
        ], mainWidth - 4));

      } else if (activeTab === 1) {
        // ACTIVITY TAB
        if (loadingDetail) {
          currentLines.push(c.yellow('⚡ Loading session activity transcript...'));
        } else if (!currentDetail || !currentDetail.conversation.length) {
          currentLines.push(c.dim('No conversation activity records found.'));
        } else {
          currentLines.push(c.brightCyan(c.bold('CONVERSATION & ACTIVITY TIMELINE')));
          currentLines.push('');
          for (const item of currentDetail.conversation) {
            if (item.role === 'user') {
              const textLines = item.text ? item.text.split('\n') : ['(empty message)'];
              currentLines.push(...formatCard('👤 USER', c.emerald, textLines, mainWidth - 4));
              currentLines.push('');
            } else if (item.role === 'assistant') {
              const textLines: string[] = [];
              if (item.text) textLines.push(...item.text.split('\n'));
              if (item.activity?.tools.length) {
                textLines.push(`⚡ Executed ${item.activity.tools.length} tool calls`);
              }
              currentLines.push(...formatCard('🤖 ASSISTANT', c.cyan, textLines, mainWidth - 4));
              currentLines.push('');
            }
          }
        }
      } else if (activeTab === 2) {
        // TOOLS TAB
        if (loadingDetail) {
          currentLines.push(c.yellow('⚡ Loading tool executions...'));
        } else if (!currentDetail) {
          currentLines.push(c.dim('No detail loaded'));
        } else {
          currentLines.push(c.purple(c.bold('TOOL EXECUTIONS')));
          currentLines.push('');
          let count = 0;
          for (const msg of currentDetail.conversation) {
            if (msg.activity?.tools?.length) {
              for (const tool of msg.activity.tools) {
                count++;
                const title = `⚙️ TOOL #${count}: ${tool.name} (${tool.durationMs ? tool.durationMs + 'ms' : 'exec'})`;
                const content: string[] = [];
                if (tool.input) content.push(`Input:  ${sanitize(tool.input)}`);
                if (tool.output) content.push(`Output: ${sanitize(tool.output)}`);
                currentLines.push(...formatCard(title, c.purple, content, mainWidth - 4));
                currentLines.push('');
              }
            }
          }
          if (!count) currentLines.push(c.dim('No tool execution records found.'));
        }
      } else if (activeTab === 3) {
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
    const statusHelp = activePane === 'sidebar'
      ? ` [TAB] Switch to Transcript Focus | [↑/↓] Sessions | [1-4] Tabs | [/] Filter | [q] Exit`
      : ` [TAB] Switch to Sidebar Focus | [↑/↓/PgUp/PgDn] Scroll Transcript | [Home/End] Jump | [q] Exit`;
    const footerText = isSearching
      ? ` TYPE FILTER · [ENTER] Save · [ESC] Clear filter`
      : statusHelp;
    buffer.push(move(rows, 1) + '\x1b[K' + c.bgHeader(footerText.padEnd(cols - 1).slice(0, cols)));

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

    if (key.name === 'tab') {
      activePane = activePane === 'sidebar' ? 'main' : 'sidebar';
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
      // Main Transcript Focus Controls
      if (key.name === 'up' || str === 'k') {
        rightScrollOffset = Math.max(0, rightScrollOffset - 1);
      } else if (key.name === 'down' || str === 'j') {
        rightScrollOffset++;
      } else if (key.name === 'left' || str === 'h') {
        activePane = 'sidebar';
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
    const sidebarWidth = Math.min(42, Math.max(30, Math.floor(cols * 0.36)));

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
          if (x < sidebarWidth + 14) activeTab = 0;
          else if (x < sidebarWidth + 28) activeTab = 1;
          else if (x < sidebarWidth + 39) activeTab = 2;
          else activeTab = 3;
          rightScrollOffset = 0;
        }
        render();
      }
    }
  });

  process.stdout.on('resize', render);
  render();
}
