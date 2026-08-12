#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodexCatalog } from './catalog.ts';
import { displayName, scanCodex, shortId, sourceLabel } from './codex.ts';
import type { ScanResult, SessionInventory } from './types.ts';

const codexHome = process.env.CODEX_HOME || join(process.env.HOME || '', '.codex');
const defaultSessionsPath = join(codexHome, 'sessions');
const defaultCatalogPaths = [codexHome, join(codexHome, 'sqlite')];

interface Arguments {
  command?: string;
  target?: string;
  format: 'text' | 'json';
  verbose: boolean;
}

function usage(): string {
  return `Usage:
  agent-session-inspect codex scan [path] [--format text|json] [--verbose]
  agent-session-inspect inspect <title|session-id|file> [--format text|json] [--verbose]`;
}

function parse(argv: string[]): Arguments {
  const values = argv.slice(2);
  let format: Arguments['format'] = 'text';
  let verbose = false;
  const positional: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--format') {
      const next = values[++index];
      if (next !== 'text' && next !== 'json') throw new Error('--format must be text or json');
      format = next;
    } else if (value === '--verbose') {
      verbose = true;
    } else if (value === '--help' || value === '-h') {
      throw new Error(usage());
    } else {
      positional.push(value);
    }
  }

  if (positional[0] === 'codex' && positional[1] === 'scan') return { command: 'scan', target: positional[2], format, verbose };
  if (positional[0] === 'inspect' && positional[1]) return { command: 'inspect', target: positional.slice(1).join(' '), format, verbose };
  throw new Error(usage());
}

function date(value: string | undefined): string {
  return value?.slice(0, 10) ?? 'unknown date';
}

function textScan(result: ScanResult, verbose: boolean): string {
  const lines = result.sessions.map((session) => {
    const base = `${displayName(session)} — ${date(session.startedAt)} · ${shortId(session.id)}`;
    return verbose ? `${base}\n  ${sourceLabel(session)}` : base;
  });
  if (!lines.length) lines.push('No Codex sessions found.');
  if (result.diagnostics.malformedRecords) lines.push(`\nSkipped malformed JSONL records: ${result.diagnostics.malformedRecords}`);
  return lines.join('\n');
}

function textInspect(session: SessionInventory, verbose: boolean): string {
  const token = session.token.last ?? session.token.total;
  const lines = [
    displayName(session),
    `ID: ${session.id}`,
    `Title source: ${session.displayTitle.source}`,
    `Date: ${date(session.startedAt)}`,
    `Started: ${session.startedAt ?? 'unavailable'}`,
    `Updated: ${session.updatedAt ?? 'unavailable'}`,
    `Records: ${session.recordCount} (${session.unknownRecords} unknown, ${session.malformedRecords} malformed)`,
    `Tasks: ${session.taskCount} started, ${session.completedTaskCount} completed, ${session.abortedTaskCount} aborted`,
    `Tools: ${session.tools.calls} calls, ${session.tools.outputs} outputs, ${session.tools.execCompleted} exec completed, ${session.tools.mcpCompleted} MCP completed`,
    `Tokens (reported): ${token?.totalTokens ?? 'unavailable'} total, ${token?.cachedInputTokens ?? 'unavailable'} cached input`,
    `Compactions: ${session.compactionCount}; rollbacks: ${session.rollbackCount}`,
  ];
  if (session.relationships.length) lines.push(`Relationships: ${session.relationships.map((edge) => `${edge.type}:${shortId(edge.sessionId)}`).join(', ')}`);
  if (verbose) lines.push(`Sources: ${session.sourceFiles.join(', ')}`);
  return lines.join('\n');
}

function select(result: ScanResult, target: string): SessionInventory[] {
  const resolvedTarget = existsSync(target) ? resolve(target) : undefined;
  const lower = target.toLocaleLowerCase();
  return result.sessions.filter((session) =>
    session.id === target ||
    session.id.startsWith(target) ||
    session.displayTitle.value?.toLocaleLowerCase() === lower ||
    (resolvedTarget && session.sourceFiles.some((file) => resolve(file) === resolvedTarget)),
  );
}

async function resultFor(path: string): Promise<ScanResult> {
  const catalog = readCodexCatalog(defaultCatalogPaths);
  return scanCodex(path, { catalogTitles: catalog.titles, catalogErrors: catalog.errors });
}

async function main(): Promise<void> {
  const args = parse(process.argv);
  if (args.command === 'scan') {
    const result = await resultFor(args.target ?? defaultSessionsPath);
    console.log(args.format === 'json' ? JSON.stringify(result, null, 2) : textScan(result, args.verbose));
    return;
  }

  const target = args.target!;
  const scanPath = existsSync(target) ? target : defaultSessionsPath;
  const result = await resultFor(scanPath);
  const matches = select(result, target);
  if (!matches.length) throw new Error(`No session matched: ${target}`);
  if (matches.length > 1) {
    const choices = matches.map((session) => `${displayName(session)} — ${date(session.startedAt)} · ${shortId(session.id)}`);
    throw new Error(`More than one session matched. Use an ID or file path:\n${choices.join('\n')}`);
  }
  console.log(args.format === 'json' ? JSON.stringify({ schemaVersion: 1, session: matches[0] }, null, 2) : textInspect(matches[0], args.verbose));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
