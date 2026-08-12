import { displayName, shortId } from './codex.ts';
import type { ScanResult, SessionInventory } from './types.ts';

const useColor = Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined);
const color = (code: number, value: string): string => (useColor ? `\u001B[${code}m${value}\u001B[0m` : value);
const bold = (value: string): string => color(1, value);
const dim = (value: string): string => color(2, value);
const cyan = (value: string): string => color(36, value);
const green = (value: string): string => color(32, value);
const yellow = (value: string): string => color(33, value);

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

export function renderScan(result: ScanResult, verbose: boolean): string {
  const totalTokens = result.sessions.reduce((sum, session) => sum + (latestTokens(session) ?? 0), 0);
  const totalTools = result.sessions.reduce((sum, session) => sum + session.tools.calls, 0);
  const title = bold('Codex session inspector');
  const subtitle = dim(`${result.sessions.length} sessions · ${formatNumber(totalTokens)} reported tokens · ${formatNumber(totalTools)} tool calls`);
  const header = `${cyan('SESSION')}\n${'─'.repeat(86)}`;
  const rows = result.sessions.map((session) => {
    const metrics = `${date(session.startedAt)}  ${shortId(session.id)}  ${duration(session.startedAt, session.updatedAt)}  ${formatNumber(latestTokens(session))} tokens  ${session.tools.calls} tools`;
    const detail = verbose ? `\n  ${dim(session.sourceFiles.join(', '))}` : '';
    return `${green('●')} ${bold(displayName(session))}\n  ${dim(metrics)}${detail}`;
  });
  const diagnostics = result.diagnostics.malformedRecords || result.diagnostics.catalogErrors.length
    ? `\n${yellow('Diagnostics')}  ${result.diagnostics.malformedRecords} malformed records, ${result.diagnostics.catalogErrors.length} catalog warnings`
    : '';
  return [title, subtitle, '', header, rows.length ? rows.join('\n\n') : dim('No Codex sessions found.'), diagnostics].filter(Boolean).join('\n');
}

export function renderInspect(session: SessionInventory, verbose: boolean): string {
  const token = session.token.last ?? session.token.total;
  const metrics = [
    ['Duration', duration(session.startedAt, session.updatedAt)],
    ['Reported tokens', formatNumber(token?.totalTokens)],
    ['Cached input', formatNumber(token?.cachedInputTokens)],
    ['Tool calls', `${session.tools.calls} calls · ${session.tools.outputs} outputs`],
    ['Tasks', `${session.taskCount} started · ${session.completedTaskCount} completed · ${session.abortedTaskCount} aborted`],
    ['Context changes', `${session.compactionCount} compactions · ${session.rollbackCount} rollbacks`],
  ];
  const lines = [
    bold(displayName(session)),
    `${dim('Codex task')} ${cyan(shortId(session.id))}  ${dim(`title: ${session.displayTitle.source}`)}`,
    `${'─'.repeat(64)}`,
    ...metrics.map(([label, value]) => `${dim(label.padEnd(18))} ${value}`),
    '',
    `${dim('Timeline')} ${session.startedAt ?? 'unavailable'} → ${session.updatedAt ?? 'unavailable'}`,
    `${dim('Records')} ${session.recordCount} measured · ${session.unknownRecords} unknown · ${session.malformedRecords} malformed`,
  ];
  if (session.relationships.length) lines.push(`${dim('Relationships')} ${session.relationships.map((edge) => `${edge.type}:${shortId(edge.sessionId)}`).join(', ')}`);
  if (verbose) lines.push(`${dim('Sources')} ${session.sourceFiles.join(', ')}`);
  return lines.join('\n');
}
