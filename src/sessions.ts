import { join } from 'node:path';
import { readCodexCatalog } from './catalog.ts';
import { readClaudeSessionDetail, scanClaude } from './claude.ts';
import { scanCodex } from './codex.ts';
import { readCodexSessionDetail } from './detail.ts';
import type { AgentKind, ScanResult, SessionDetail, SessionInventory } from './types.ts';

export const AGENTS: AgentKind[] = ['codex', 'claude'];

const home = process.env.HOME || process.env.USERPROFILE || '';

export function codexHome(): string {
  return process.env.CODEX_HOME || join(home, '.codex');
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
}

/** Default transcript directory for each agent. */
export function defaultSessionsPath(agent: AgentKind): string {
  return agent === 'claude' ? join(claudeHome(), 'projects') : join(codexHome(), 'sessions');
}

export function parseAgent(value: string | undefined): AgentKind | undefined {
  if (value === undefined || value === '' || value === 'all') return undefined;
  if (value === 'codex' || value === 'claude') return value;
  throw new Error(`Unknown agent "${value}". Expected codex, claude or all.`);
}

export interface ScanSessionsOptions {
  /** Scan this path instead of each agent's default directory; every requested agent's parser reads it. */
  path?: string;
  /** Limit to one agent; both are scanned when omitted. */
  agent?: AgentKind;
}

async function scanAgent(agent: AgentKind, path: string): Promise<ScanResult> {
  if (agent === 'claude') return scanClaude(path);
  const home = codexHome();
  const catalog = readCodexCatalog([home, join(home, 'sqlite')]);
  return scanCodex(path, { catalogTitles: catalog.titles, catalogErrors: catalog.errors });
}

/** Scans Codex and Claude Code transcripts and merges them into one newest-first inventory. */
export async function scanSessions(options: ScanSessionsOptions = {}): Promise<ScanResult> {
  const agents = options.agent ? [options.agent] : AGENTS;
  const results = await Promise.all(agents.map((agent) => scanAgent(agent, options.path ?? defaultSessionsPath(agent))));
  const sessions = results
    .flatMap((result) => result.sessions)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    provider: options.agent ?? 'all',
    sessions,
    diagnostics: {
      filesRead: results.reduce((sum, result) => sum + result.diagnostics.filesRead, 0),
      malformedRecords: results.reduce((sum, result) => sum + result.diagnostics.malformedRecords, 0),
      catalogErrors: results.flatMap((result) => result.diagnostics.catalogErrors),
    },
  };
}

export function readSessionDetail(session: SessionInventory): Promise<SessionDetail> {
  return session.agent === 'claude' ? readClaudeSessionDetail(session) : readCodexSessionDetail(session);
}
