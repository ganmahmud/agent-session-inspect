#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayName, shortId } from './codex.ts';
import { renderInspect, renderScan } from './report.ts';
import { parseAgent, scanSessions } from './sessions.ts';
import { startTui } from './tui.ts';
import type { AgentKind, ScanResult, SessionInventory } from './types.ts';

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
  agent?: AgentKind;
  format: 'text' | 'json';
  verbose: boolean;
  ui: boolean;
  web: boolean;
  port: number;
}

function usage(): string {
  return `Usage:
  agent-session-inspect tui [path]                        # Interactive terminal dashboard
  agent-session-inspect web [path] [--port 4318]           # Interactive web dashboard (--web)
  agent-session-inspect scan [path] [--format json]        # Terminal scan report (Codex + Claude Code)
  agent-session-inspect codex scan [path]                  # Codex sessions only
  agent-session-inspect claude scan [path]                 # Claude Code sessions only
  agent-session-inspect inspect <title|id|file>           # Detailed session inspect

Options:
  --agent codex|claude|all   Limit any command to one agent's sessions (default: all)

Sessions are read from $CODEX_HOME/sessions (~/.codex/sessions) and
$CLAUDE_CONFIG_DIR/projects (~/.claude/projects).`;
}

function parse(argv: string[]): Arguments {
  const values = argv.slice(2);
  let format: Arguments['format'] = 'text';
  let verbose = false;
  let ui = false;
  let web = false;
  let port = 4318;
  let agent: AgentKind | undefined;
  const positional: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--format') {
      const next = values[++index];
      if (next !== 'text' && next !== 'json') throw new Error('--format must be text or json');
      format = next;
    } else if (value === '--verbose') {
      verbose = true;
    } else if (value === '--ui' || value === '--tui') {
      ui = true;
    } else if (value === '--web') {
      web = true;
    } else if (value === '--port') {
      const next = Number(values[++index]);
      if (!Number.isInteger(next) || next < 0 || next > 65535) throw new Error('--port must be an integer from 0 to 65535');
      port = next;
    } else if (value === '--agent') {
      agent = parseAgent(values[++index]);
    } else if (value === '--help' || value === '-h') {
      throw new Error(usage());
    } else {
      positional.push(value);
    }
  }

  if (positional[0] === 'web' || web) return { command: 'serve', target: positional[0] === 'web' ? positional[1] : positional[0], agent, format, verbose, ui, web: true, port };
  if (positional[0] === 'tui' || positional[0] === 'ui' || ui) return { command: 'tui', target: positional[0] === 'tui' || positional[0] === 'ui' ? positional[1] : positional[0], agent, format, verbose, ui: true, web, port };
  if ((positional[0] === 'codex' || positional[0] === 'claude') && positional[1] === 'scan') return { command: 'scan', target: positional[2], agent: positional[0], format, verbose, ui, web, port };
  if (positional[0] === 'scan') return { command: 'scan', target: positional[1], agent, format, verbose, ui, web, port };
  if (positional[0] === 'inspect' && positional[1]) return { command: 'inspect', target: positional.slice(1).join(' '), agent, format, verbose, ui, web, port };
  if (positional[0] === 'serve') return { command: 'serve', target: positional[1], agent, format, verbose, ui, web: true, port };
  if (!positional.length) return { command: 'tui', target: undefined, agent, format, verbose, ui: true, web, port };
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

function resultFor(path: string | undefined, agent: AgentKind | undefined): Promise<ScanResult> {
  return scanSessions({ path, agent });
}

function dashboardEnv(args: Arguments): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(args.port) };
  if (args.target) env.ASI_SESSIONS_PATH = resolve(args.target);
  if (args.agent) env.ASI_AGENT = args.agent;
  return env;
}

async function main(): Promise<void> {
  const args = parse(process.argv);
  if (args.command === 'serve' || args.web) {
    const dashboard = join(packageRoot, 'dashboard');
    console.log(`\n  ⚡ Agent Session Inspect Web Dashboard\n  http://127.0.0.1:${args.port}\n\n  Local-only · read-only · Ctrl+C to stop\n`);
    const entry = join(packageRoot, 'dist', 'dashboard', 'index.js');
    const built = existsSync(entry);
    const child = spawn(built ? process.execPath : process.env.BUN_BINARY ?? 'bun', built ? [entry] : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(args.port)], {
      cwd: dashboard,
      stdio: 'inherit',
      env: dashboardEnv(args),
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 || code === null ? resolve() : reject(new Error(`Dashboard exited with code ${code}`))));
    });
    return;
  }
  if (args.command === 'tui' || args.ui) {
    const result = await resultFor(args.target, args.agent);
    await startTui(result);
    return;
  }
  if (args.command === 'scan') {
    const result = await resultFor(args.target, args.agent);
    console.log(args.format === 'json' ? JSON.stringify(result, null, 2) : renderScan(result, args.verbose));
    return;
  }
  if (args.command === 'serve') {
    const dashboard = join(packageRoot, 'dashboard');
    console.log(`\n  Agent Session Inspect dashboard\n  http://127.0.0.1:${args.port}\n\n  Local-only · read-only · Ctrl+C to stop\n`);
    const entry = join(packageRoot, 'dist', 'dashboard', 'index.js');
    const built = existsSync(entry);
    const child = spawn(built ? process.execPath : process.env.BUN_BINARY ?? 'bun', built ? [entry] : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(args.port)], {
      cwd: dashboard,
      stdio: 'inherit',
      env: dashboardEnv(args),
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 || code === null ? resolve() : reject(new Error(`Dashboard exited with code ${code}`))));
    });
    return;
  }

  const target = args.target!;
  const result = await resultFor(existsSync(target) ? target : undefined, args.agent);
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
