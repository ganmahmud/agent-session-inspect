import { displayName, shortId } from './codex.ts';
import type { ScanResult, SessionInventory } from './types.ts';

const useColor = Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined);
const color = (code: number, value: string): string => (useColor ? `\u001B[${code}m${value}\u001B[0m` : value);
const bold = (value: string): string => color(1, value);
const dim = (value: string): string => color(2, value);
const cyan = (value: string): string => color(36, value);
const brightCyan = (value: string): string => color(96, value);
const green = (value: string): string => color(32, value);
const brightGreen = (value: string): string => color(92, value);
const yellow = (value: string): string => color(33, value);
const magenta = (value: string): string => color(35, value);
const gray = (value: string): string => color(90, value);

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

  const banner = [
    cyan('╭──────────────────────────────────────────────────────────────────────────────╮'),
    `${cyan('│')} ${brightCyan(bold('⚡ AGENT SESSION INSPECTOR'))}${' '.repeat(50)}${cyan('│')}`,
    `${cyan('│')} ${dim(`${result.sessions.length} sessions`)} ${gray('│')} ${yellow(`${formatNumber(totalTokens)} tokens`)} ${gray('│')} ${magenta(`${formatNumber(totalTools)} tool calls`)}${' '.repeat(Math.max(0, 31 - formatNumber(totalTokens).length - formatNumber(totalTools).length - String(result.sessions.length).length))}${cyan('│')}`,
    cyan('╰──────────────────────────────────────────────────────────────────────────────╯'),
  ].join('\n');

  const rows = result.sessions.map((session) => {
    const titleLine = `${brightGreen('◈')} ${bold(displayName(session))}`;
    const idLine = `  ${gray('│')} ${dim('ID')} ${cyan(shortId(session.id).padEnd(10))} ${gray('·')} ${dim('DATE')} ${date(session.startedAt)}`;
    const statsLine = `  ${gray('│')} ${dim('STATS')} ${brightCyan(duration(session.startedAt, session.updatedAt).padEnd(8))} ${gray('│')} ${yellow(`${formatNumber(latestTokens(session))} tokens`)} ${gray('│')} ${magenta(`${session.tools.calls} tools`)}`;
    const detail = verbose ? `\n  ${gray('│')} ${dim('SOURCE')} ${gray(session.sourceFiles.join(', '))}` : '';
    return `${titleLine}\n${idLine}\n${statsLine}${detail}`;
  });

  const diagnostics = result.diagnostics.malformedRecords || result.diagnostics.catalogErrors.length
    ? `\n${yellow('── Diagnostics ──────────────────────────────────────────────────────────────')}\n${yellow('!')} ${result.diagnostics.malformedRecords} malformed records · ${result.diagnostics.catalogErrors.length} catalog warnings`
    : '';

  return [banner, '', rows.length ? rows.join('\n\n') : dim('No Codex sessions found.'), diagnostics].filter(Boolean).join('\n');
}

export function renderInspect(session: SessionInventory, verbose: boolean): string {
  const token = session.token.last ?? session.token.total;

  const header = [
    brightCyan('╭──────────────────────────────────────────────────────────────────────────────╮'),
    `${brightCyan('│')} ${brightCyan(bold('⚡ SESSION INSPECTION'))}${' '.repeat(53)}${brightCyan('│')}`,
    `${brightCyan('│')} ${bold(displayName(session)).slice(0, 72).padEnd(74)}${brightCyan('│')}`,
    brightCyan('╰──────────────────────────────────────────────────────────────────────────────╯'),
  ].join('\n');

  const infoBox = [
    `  ${cyan('┌─ GENERAL INFO ───────────────────────────────────────────────────────────┐')}`,
    `  ${cyan('│')} ${dim('Session ID'.padEnd(14))} ${cyan(session.id)}`,
    `  ${cyan('│')} ${dim('Short ID'.padEnd(14))} ${brightCyan(shortId(session.id))}`,
    `  ${cyan('│')} ${dim('Title Source'.padEnd(14))} ${session.displayTitle.source}`,
    `  ${cyan('│')} ${dim('Timeline'.padEnd(14))} ${session.startedAt ?? 'unknown'} → ${session.updatedAt ?? 'unknown'}`,
    `  ${cyan('│')} ${dim('Duration'.padEnd(14))} ${brightGreen(duration(session.startedAt, session.updatedAt))}`,
    `  ${cyan('└──────────────────────────────────────────────────────────────────────────┘')}`,
  ].join('\n');

  const tokenBox = [
    `  ${yellow('┌─ TOKEN METRICS ──────────────────────────────────────────────────────────┐')}`,
    `  ${yellow('│')} ${dim('Reported Tokens'.padEnd(16))} ${yellow(formatNumber(token?.totalTokens))}`,
    `  ${yellow('│')} ${dim('Cached Input'.padEnd(16))} ${yellow(formatNumber(token?.cachedInputTokens))}`,
    `  ${yellow('└──────────────────────────────────────────────────────────────────────────┘')}`,
  ].join('\n');

  const execBox = [
    `  ${magenta('┌─ EXECUTION STATS ────────────────────────────────────────────────────────┐')}`,
    `  ${magenta('│')} ${dim('Tool Calls'.padEnd(16))} ${magenta(`${session.tools.calls} calls`)} ${gray('(')}${session.tools.outputs} outputs${gray(')')}`,
    `  ${magenta('│')} ${dim('Tasks'.padEnd(16))} ${session.taskCount} started ${gray('·')} ${green(`${session.completedTaskCount} completed`)} ${gray('·')} ${session.abortedTaskCount ? yellow(`${session.abortedTaskCount} aborted`) : '0 aborted'}`,
    `  ${magenta('│')} ${dim('Context Changes'.padEnd(16))} ${session.compactionCount} compactions ${gray('·')} ${session.rollbackCount} rollbacks`,
    `  ${magenta('│')} ${dim('Records'.padEnd(16))} ${session.recordCount} measured ${gray('·')} ${session.unknownRecords} unknown ${gray('·')} ${session.malformedRecords ? yellow(`${session.malformedRecords} malformed`) : '0 malformed'}`,
    `  ${magenta('└──────────────────────────────────────────────────────────────────────────┘')}`,
  ].join('\n');

  const lines = [header, '', infoBox, '', tokenBox, '', execBox];

  if (session.relationships.length) {
    lines.push('', `  ${dim('Relationships:')} ${session.relationships.map((edge) => `${edge.type}:${cyan(shortId(edge.sessionId))}`).join(', ')}`);
  }
  if (verbose) {
    lines.push(`  ${dim('Sources:')} ${gray(session.sourceFiles.join(', '))}`);
  }

  return lines.join('\n');
}

