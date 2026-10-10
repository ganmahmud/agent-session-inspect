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

interface Flags {
  format: Arguments['format'];
  verbose: boolean;
  ui: boolean;
  web: boolean;
  port: number;
  agent?: AgentKind;
}

/** Applies one option to `flags`; returns how many extra values it consumed, or undefined if it is not an option. */
function applyFlag(flags: Flags, value: string, next: string | undefined): number | undefined {
  switch (value) {
    case '--format':
      if (next !== 'text' && next !== 'json') throw new Error('--format must be text or json');
      flags.format = next;
      return 1;
    case '--verbose':
      flags.verbose = true;
      return 0;
    case '--ui':
    case '--tui':
      flags.ui = true;
      return 0;
    case '--web':
      flags.web = true;
      return 0;
    case '--port': {
      const port = Number(next);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
      flags.port = port;
      return 1;
    }
    case '--agent':
      flags.agent = parseAgent(next);
      return 1;
    case '--help':
    case '-h':
      throw new Error(usage());
    default:
      return undefined;
  }
}

function command(positional: string[], flags: Flags): Arguments {
  const [first, second] = positional;
  const base = { ...flags };
  if (first === 'web' || flags.web) return { ...base, command: 'serve', target: first === 'web' ? second : first, web: true };
  if (first === 'tui' || first === 'ui' || flags.ui) return { ...base, command: 'tui', target: first === 'tui' || first === 'ui' ? second : first, ui: true };
  if ((first === 'codex' || first === 'claude') && second === 'scan') return { ...base, command: 'scan', target: positional[2], agent: first };
  if (first === 'scan') return { ...base, command: 'scan', target: second };
  if (first === 'inspect' && second) return { ...base, command: 'inspect', target: positional.slice(1).join(' ') };
  if (first === 'serve') return { ...base, command: 'serve', target: second, web: true };
  if (!positional.length) return { ...base, command: 'tui', target: undefined, ui: true };
  throw new Error(usage());
}

function parse(argv: string[]): Arguments {
  const values = argv.slice(2);
  const flags: Flags = { format: 'text', verbose: false, ui: false, web: false, port: 4318 };
  const positional: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const consumed = applyFlag(flags, values[index], values[index + 1]);
    if (consumed === undefined) positional.push(values[index]);
    else index += consumed;
  }
  return command(positional, flags);
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
  // Session exports with screenshots run to several MB; adapter-node rejects request bodies over 512 KB by default.
  const env: NodeJS.ProcessEnv = { BODY_SIZE_LIMIT: '64M', ...process.env, HOST: '127.0.0.1', PORT: String(args.port) };
  if (args.target) env.ASI_SESSIONS_PATH = resolve(args.target);
  if (args.agent) env.ASI_AGENT = args.agent;
  return env;
}

async function runDashboard(args: Arguments): Promise<void> {
  const dashboard = join(packageRoot, 'dashboard');
  console.log(`\n  ⚡ Agent Session Inspect Web Dashboard\n  http://127.0.0.1:${args.port}\n\n  Local-only · read-only · Ctrl+C to stop\n`);
  const entry = join(packageRoot, 'dist', 'dashboard', 'index.js');
  const built = existsSync(entry);
  const executable = built ? process.execPath : process.env.BUN_BINARY ?? 'bun';
  const child = spawn(executable, built ? [entry] : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(args.port)], {
    cwd: dashboard,
    stdio: 'inherit',
    env: dashboardEnv(args),
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 || code === null ? resolve() : reject(new Error(`Dashboard exited with code ${code}`))));
  });
}

async function inspect(args: Arguments): Promise<void> {
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

async function main(): Promise<void> {
  const args = parse(process.argv);
  if (args.command === 'serve' || args.web) return runDashboard(args);
  if (args.command === 'tui' || args.ui) return startTui(await resultFor(args.target, args.agent));
  if (args.command === 'scan') {
    const result = await resultFor(args.target, args.agent);
    console.log(args.format === 'json' ? JSON.stringify(result, null, 2) : renderScan(result, args.verbose));
    return;
  }
  return inspect(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
