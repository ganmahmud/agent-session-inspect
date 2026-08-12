#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodexCatalog } from './catalog.ts';
import { displayName, scanCodex, shortId } from './codex.ts';
import { renderInspect, renderScan } from './report.ts';
import type { ScanResult, SessionInventory } from './types.ts';

const codexHome = process.env.CODEX_HOME || join(process.env.HOME || '', '.codex');
const defaultSessionsPath = join(codexHome, 'sessions');
const defaultCatalogPaths = [codexHome, join(codexHome, 'sqlite')];

function findPackageRoot(from: string): string {
  let directory = from;
  while (true) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Could not find package root');
    directory = parent;
  }
}

const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

interface Arguments {
  command?: string;
  target?: string;
  format: 'text' | 'json';
  verbose: boolean;
  port: number;
}

function usage(): string {
  return `Usage:
  agent-session-inspect codex scan [path] [--format text|json] [--verbose]
  agent-session-inspect inspect <title|session-id|file> [--format text|json] [--verbose]
  agent-session-inspect serve [path] [--port 4318]`;
}

function parse(argv: string[]): Arguments {
  const values = argv.slice(2);
  let format: Arguments['format'] = 'text';
  let verbose = false;
  let port = 4318;
  const positional: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--format') {
      const next = values[++index];
      if (next !== 'text' && next !== 'json') throw new Error('--format must be text or json');
      format = next;
    } else if (value === '--verbose') {
      verbose = true;
    } else if (value === '--port') {
      const next = Number(values[++index]);
      if (!Number.isInteger(next) || next < 0 || next > 65535) throw new Error('--port must be an integer from 0 to 65535');
      port = next;
    } else if (value === '--help' || value === '-h') {
      throw new Error(usage());
    } else {
      positional.push(value);
    }
  }

  if (positional[0] === 'codex' && positional[1] === 'scan') return { command: 'scan', target: positional[2], format, verbose, port };
  if (positional[0] === 'inspect' && positional[1]) return { command: 'inspect', target: positional.slice(1).join(' '), format, verbose, port };
  if (positional[0] === 'serve') return { command: 'serve', target: positional[1], format, verbose, port };
  throw new Error(usage());
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
    console.log(args.format === 'json' ? JSON.stringify(result, null, 2) : renderScan(result, args.verbose));
    return;
  }
  if (args.command === 'serve') {
    const dashboard = join(packageRoot, 'src', 'dashboard');
    const sessions = args.target ?? defaultSessionsPath;
    console.log(`\n  Agent Session Inspect dashboard\n  http://127.0.0.1:${args.port}\n\n  Local-only · read-only · Ctrl+C to stop\n`);
    const entry = join(packageRoot, 'dist', 'dashboard', 'index.js');
    const built = existsSync(entry);
    const child = spawn(built ? process.execPath : process.env.BUN_BINARY ?? 'bun', built ? [entry] : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(args.port)], {
      cwd: dashboard,
      stdio: 'inherit',
      env: { ...process.env, ASI_SESSIONS_PATH: sessions, HOST: '127.0.0.1', PORT: String(args.port) },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 || code === null ? resolve() : reject(new Error(`Dashboard exited with code ${code}`))));
    });
    return;
  }

  const target = args.target!;
  const scanPath = existsSync(target) ? target : defaultSessionsPath;
  const result = await resultFor(scanPath);
  const matches = select(result, target);
  if (!matches.length) throw new Error(`No session matched: ${target}`);
  if (matches.length > 1) {
    const choices = matches.map((session) => `${displayName(session)} — ${session.startedAt?.slice(0, 10) ?? 'unknown'} · ${shortId(session.id)}`);
    throw new Error(`More than one session matched. Use an ID or file path:\n${choices.join('\n')}`);
  }
  console.log(args.format === 'json' ? JSON.stringify({ schemaVersion: 1, session: matches[0] }, null, 2) : renderInspect(matches[0], args.verbose));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
