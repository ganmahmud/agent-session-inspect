import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, resolve } from 'node:path';
import type {
  CatalogTitle,
  DisplayTitle,
  NormalizedEvent,
  ProjectGroup,
  Relationship,
  ScanResult,
  SessionInventory,
  TokenUsage,
} from './types.ts';

type JsonRecord = Record<string, unknown>;

interface MutableSession extends SessionInventory {
  titleFromLog?: DisplayTitle;
  relationshipKeys: Set<string>;
}

export interface ScanOptions {
  catalogTitles?: CatalogTitle[];
  catalogErrors?: string[];
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function usage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: TokenUsage = {
    inputTokens: asNumber(record.input_tokens),
    cachedInputTokens: asNumber(record.cached_input_tokens),
    outputTokens: asNumber(record.output_tokens),
    reasoningOutputTokens: asNumber(record.reasoning_output_tokens),
    totalTokens: asNumber(record.total_tokens),
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

function emptySession(id: string, file: string): MutableSession {
  return {
    id,
    displayTitle: { value: null, source: 'absent' },
    sourceFiles: [file],
    cliVersions: [],
    recordCount: 0,
    malformedRecords: 0,
    unknownRecords: 0,
    eventCounts: {},
    token: { observations: 0, missingUsageObservations: 0 },
    tools: { calls: 0, outputs: 0, execCompleted: 0, mcpCompleted: 0 },
    taskCount: 0,
    completedTaskCount: 0,
    abortedTaskCount: 0,
    compactionCount: 0,
    rollbackCount: 0,
    relationships: [],
    relationshipKeys: new Set(),
  };
}

function updateTime(session: MutableSession, timestamp: string | undefined): void {
  if (!timestamp) return;
  if (!session.startedAt || timestamp < session.startedAt) session.startedAt = timestamp;
  if (!session.updatedAt || timestamp > session.updatedAt) session.updatedAt = timestamp;
}

function addRelationship(session: MutableSession, type: Relationship['type'], sessionId: string | undefined): void {
  if (!sessionId || sessionId === session.id) return;
  const key = `${type}:${sessionId}`;
  if (session.relationshipKeys.has(key)) return;
  session.relationshipKeys.add(key);
  session.relationships.push({ type, sessionId });
}

function increment(session: MutableSession, kind: string): void {
  session.eventCounts[kind] = (session.eventCounts[kind] ?? 0) + 1;
}

export function normalizeCodexRecord(record: JsonRecord, file: string, line: number): NormalizedEvent {
  const payload = asRecord(record.payload);
  const outerType = asText(record.type) ?? 'unknown';
  const payloadType = payload && asText(payload.type);
  const kind = payloadType ? `${outerType}.${payloadType}` : outerType;
  return {
    kind,
    timestamp: asText(record.timestamp),
    source: { file, line },
    correlationId: payload && asText(payload.call_id),
    evidence: 'measured',
  };
}

export function isSystemOrTempPath(pathStr: string): boolean {
  const normalized = pathStr.replace(/\\/g, '/').toLowerCase();
  if (
    normalized.startsWith('/tmp/') ||
    normalized.startsWith('/private/tmp/') ||
    normalized.startsWith('/var/folders/') ||
    normalized.startsWith('/private/var/') ||
    normalized.includes('/appdata/local/temp/')
  ) {
    return true;
  }
  return false;
}

export function extractProjectName(cwd?: string, explicitName?: string): string | undefined {
  if (explicitName && explicitName.trim() && !explicitName.trim().startsWith('.')) {
    return explicitName.trim();
  }
  if (!cwd || !cwd.trim()) return undefined;
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return undefined;
  if (isSystemOrTempPath(trimmed)) return undefined;

  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return undefined;
  const lastSegment = segments[segments.length - 1];

  // Dotfolders (e.g. .buzz, .codex, .vscode, .gemini, .cache) are internal/tool dirs, not user projects
  if (lastSegment.startsWith('.')) return undefined;

  // Ignore user home root (e.g. /Users/username, /home/username)
  if (segments.length === 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
    return undefined;
  }

  return lastSegment;
}

function observeMetadata(session: MutableSession, payload: JsonRecord, timestamp: string | undefined): void {
  session.cwd ??= asText(payload.cwd);
  session.projectName ??= asText(payload.project_name) ?? asText(payload.project) ?? asText(payload.workspace_name) ?? extractProjectName(session.cwd);
  session.provider ??= asText(payload.model_provider);
  const version = asText(payload.cli_version);
  if (version && !session.cliVersions.includes(version)) session.cliVersions.push(version);
  addRelationship(session, 'parent', asText(payload.parent_thread_id));
  addRelationship(session, 'fork', asText(payload.forked_from_id));
  updateTime(session, timestamp ?? asText(payload.timestamp));
}

function observeToken(session: MutableSession, payload: JsonRecord): void {
  session.token.observations += 1;
  const info = asRecord(payload.info);
  if (!info) {
    session.token.missingUsageObservations += 1;
    return;
  }
  session.token.total = usage(info.total_token_usage) ?? session.token.total;
  session.token.last = usage(info.last_token_usage) ?? session.token.last;
  session.token.modelContextWindow = asNumber(info.model_context_window) ?? session.token.modelContextWindow;
}

function observeEvent(session: MutableSession, eventType: string, payload: JsonRecord, timestamp?: string): void {
  switch (eventType) {
    case 'token_count':
      observeToken(session, payload);
      break;
    case 'task_started':
      session.taskCount += 1;
      break;
    case 'task_complete':
      session.completedTaskCount += 1;
      break;
    case 'turn_aborted':
      session.abortedTaskCount += 1;
      break;
    case 'context_compacted':
      session.compactionCount += 1;
      break;
    case 'thread_rolled_back':
      session.rollbackCount += 1;
      break;
    case 'exec_command_end':
      session.tools.execCompleted += 1;
      break;
    case 'mcp_tool_call_end':
      session.tools.mcpCompleted += 1;
      break;
    case 'sub_agent_activity':
    case 'subagent_activity':
    case 'agent_activity':
      addRelationship(session, 'subagent', asText(payload.agent_thread_id) ?? asText(payload.subagent_id) ?? asText(payload.sub_agent_id) ?? asText(payload.thread_id) ?? asText(payload.session_id) ?? asText(payload.call_id));
      break;
    case 'thread_name_updated': {
      const title = asText(payload.thread_name);
      if (title) session.titleFromLog = { value: title, source: 'session_event', observedAt: timestamp };
      break;
    }
  }
}

function observeResponseItem(session: MutableSession, itemType: string): void {
  if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'web_search_call' || itemType === 'tool_search_call') {
    session.tools.calls += 1;
  }
  if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output' || itemType === 'tool_search_output') {
    session.tools.outputs += 1;
  }
}

function knownRecord(recordType: string, payloadType: string | undefined): boolean {
  if (recordType === 'session_meta' || recordType === 'turn_context' || recordType === 'compacted' || recordType === 'world_state' || recordType === 'inter_agent_communication_metadata') return true;
  if (recordType === 'response_item') return Boolean(payloadType);
  if (recordType === 'event_msg') return Boolean(payloadType);
  return false;
}

function collectFiles(path: string): string[] {
  const target = resolve(path);
  try {
    if (!existsSync(target)) return [];
    if (!statSync(target).isDirectory()) return target.endsWith('.jsonl') ? [target] : [];
  } catch {
    return [];
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child);
      }
    } catch {
      // Ignore unreadable subdirectories
    }
  };
  visit(target);
  return files.sort();
}

interface FileScanCacheEntry {
  mtimeMs: number;
  size: number;
  sessions: MutableSession[];
  malformedRecords: number;
}

const fileScanCache = new Map<string, FileScanCacheEntry>();

export function clearScanCache(): void {
  fileScanCache.clear();
}

function cloneSession(session: MutableSession): MutableSession {
  return {
    ...session,
    sourceFiles: [...session.sourceFiles],
    cliVersions: [...session.cliVersions],
    eventCounts: { ...session.eventCounts },
    token: {
      ...session.token,
      total: session.token.total ? { ...session.token.total } : undefined,
      last: session.token.last ? { ...session.token.last } : undefined,
    },
    tools: { ...session.tools },
    relationships: session.relationships.map((r) => ({ ...r })),
    relationshipKeys: new Set(session.relationshipKeys ?? []),
    displayTitle: { ...session.displayTitle },
    titleFromLog: session.titleFromLog ? { ...session.titleFromLog } : undefined,
    projectName: session.projectName,
  };
}

function mergeSessions(target: MutableSession, source: MutableSession): void {
  for (const f of source.sourceFiles) {
    if (!target.sourceFiles.includes(f)) target.sourceFiles.push(f);
  }
  for (const v of source.cliVersions) {
    if (!target.cliVersions.includes(v)) target.cliVersions.push(v);
  }
  target.cwd ??= source.cwd;
  target.projectName ??= source.projectName ?? extractProjectName(target.cwd);
  target.provider ??= source.provider;
  target.recordCount += source.recordCount;
  target.malformedRecords += source.malformedRecords;
  target.unknownRecords += source.unknownRecords;
  for (const [k, v] of Object.entries(source.eventCounts)) {
    target.eventCounts[k] = (target.eventCounts[k] ?? 0) + v;
  }
  target.token.observations += source.token.observations;
  target.token.missingUsageObservations += source.token.missingUsageObservations;
  if (source.token.total) target.token.total = source.token.total;
  if (source.token.last) target.token.last = source.token.last;
  if (source.token.modelContextWindow) target.token.modelContextWindow = source.token.modelContextWindow;
  target.tools.calls += source.tools.calls;
  target.tools.outputs += source.tools.outputs;
  target.tools.execCompleted += source.tools.execCompleted;
  target.tools.mcpCompleted += source.tools.mcpCompleted;
  target.taskCount += source.taskCount;
  target.completedTaskCount += source.completedTaskCount;
  target.abortedTaskCount += source.abortedTaskCount;
  target.compactionCount += source.compactionCount;
  target.rollbackCount += source.rollbackCount;
  for (const rel of source.relationships) {
    addRelationship(target, rel.type, rel.sessionId);
  }
  updateTime(target, source.startedAt);
  updateTime(target, source.updatedAt);
  if (source.titleFromLog) {
    if (!target.titleFromLog || (source.titleFromLog.observedAt ?? '') >= (target.titleFromLog.observedAt ?? '')) {
      target.titleFromLog = source.titleFromLog;
    }
  }
}

async function scanFileCached(
  file: string,
  sessions: Map<string, MutableSession>,
  diagnostics: ScanResult['diagnostics']
): Promise<void> {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return;
  }

  const cached = fileScanCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    diagnostics.malformedRecords += cached.malformedRecords;
    for (const cachedSession of cached.sessions) {
      const existing = sessions.get(cachedSession.id);
      if (existing) {
        mergeSessions(existing, cachedSession);
      } else {
        sessions.set(cachedSession.id, cloneSession(cachedSession));
      }
    }
    return;
  }

  const fileSessions = new Map<string, MutableSession>();
  const fileDiagnostics: ScanResult['diagnostics'] = {
    filesRead: 1,
    malformedRecords: 0,
    catalogErrors: [],
  };

  await scanFile(file, fileSessions, fileDiagnostics);

  diagnostics.malformedRecords += fileDiagnostics.malformedRecords;
  const sessionList = Array.from(fileSessions.values());

  fileScanCache.set(file, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sessions: sessionList.map(cloneSession),
    malformedRecords: fileDiagnostics.malformedRecords,
  });

  for (const s of sessionList) {
    const existing = sessions.get(s.id);
    if (existing) {
      mergeSessions(existing, s);
    } else {
      sessions.set(s.id, cloneSession(s));
    }
  }
}

async function scanFile(file: string, sessions: Map<string, MutableSession>, diagnostics: ScanResult['diagnostics']): Promise<void> {
  let currentId: string | undefined;
  const input = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;

  for await (const text of input) {
    line += 1;
    if (!text.trim()) continue;
    let record: JsonRecord;
    try {
      record = asRecord(JSON.parse(text)) ?? {};
    } catch {
      diagnostics.malformedRecords += 1;
      const current = currentId ? sessions.get(currentId) : undefined;
      if (current) current.malformedRecords += 1;
      continue;
    }

    const recordType = asText(record.type) ?? 'unknown';
    const payload = asRecord(record.payload) ?? {};
    const timestamp = asText(record.timestamp);
    if (recordType === 'session_meta') currentId = asText(payload.session_id) ?? asText(payload.id) ?? currentId;
    if (!currentId) continue;

    const session = sessions.get(currentId) ?? emptySession(currentId, file);
    sessions.set(currentId, session);
    if (!session.sourceFiles.includes(file)) session.sourceFiles.push(file);
    session.recordCount += 1;
    updateTime(session, timestamp);

    const normalized = normalizeCodexRecord(record, file, line);
    increment(session, normalized.kind);
    const payloadType = asText(payload.type);
    if (!knownRecord(recordType, payloadType)) session.unknownRecords += 1;

    if (recordType === 'session_meta') observeMetadata(session, payload, timestamp);
    if (recordType === 'event_msg' && payloadType) observeEvent(session, payloadType, payload, timestamp);
    if (recordType === 'response_item' && payloadType) observeResponseItem(session, payloadType);
    if (recordType === 'compacted') session.compactionCount += 1;
  }
}

function chooseCatalogTitle(session: MutableSession, titles: CatalogTitle[]): CatalogTitle | undefined {
  const paths = new Set(session.sourceFiles.map((file) => resolve(file)));
  return titles
    .filter((title) => title.sessionId === session.id)
    .filter((title) => !title.rolloutPath || paths.has(resolve(title.rolloutPath)))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

function applyTitles(sessions: Iterable<MutableSession>, catalogTitles: CatalogTitle[]): void {
  for (const session of sessions) {
    const catalog = chooseCatalogTitle(session, catalogTitles);
    if (catalog) {
      session.displayTitle = { value: catalog.title, source: 'provider_catalog' };
    } else if (session.titleFromLog) {
      session.displayTitle = session.titleFromLog;
    }
    delete session.titleFromLog;
    Reflect.deleteProperty(session, 'relationshipKeys');
    session.cliVersions.sort();
    session.sourceFiles.sort();
    session.relationships.sort((a, b) => `${a.type}:${a.sessionId}`.localeCompare(`${b.type}:${b.sessionId}`));
  }
}

export async function scanCodex(path: string, options: ScanOptions = {}): Promise<ScanResult> {
  const diagnostics: ScanResult['diagnostics'] = {
    filesRead: 0,
    malformedRecords: 0,
    catalogErrors: options.catalogErrors ?? [],
  };
  const sessions = new Map<string, MutableSession>();
  for (const file of collectFiles(path)) {
    diagnostics.filesRead += 1;
    await scanFileCached(file, sessions, diagnostics);
  }
  applyTitles(sessions.values(), options.catalogTitles ?? []);
  const ordered = [...sessions.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  return { schemaVersion: 1, provider: 'codex', sessions: ordered, diagnostics };
}

export function displayName(session: SessionInventory): string {
  return session.displayTitle.value ?? 'Untitled Codex session';
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function sourceLabel(session: SessionInventory): string {
  return session.sourceFiles.map((file) => basename(file)).join(', ');
}

export function projectName(session: SessionInventory): string {
  return session.projectName || extractProjectName(session.cwd) || 'General / No Project';
}

export function groupSessionsByProject(sessions: SessionInventory[]): ProjectGroup[] {
  const map = new Map<string, { name: string; path?: string; sessions: SessionInventory[]; totalTokens: number; latestActivity: number }>();
  for (const session of sessions) {
    const pName = projectName(session);
    if (pName === 'General / No Project') continue;
    const key = session.cwd || pName;
    const time = Date.parse(session.updatedAt ?? session.startedAt ?? '') || 0;
    let group = map.get(key);
    if (!group) {
      group = {
        name: pName,
        path: session.cwd,
        sessions: [],
        totalTokens: 0,
        latestActivity: time,
      };
      map.set(key, group);
    } else {
      if (time > group.latestActivity) group.latestActivity = time;
    }
    group.sessions.push(session);
    const tokens = session.token?.last?.totalTokens ?? session.token?.total?.totalTokens ?? 0;
    group.totalTokens += tokens;
  }
  return Array.from(map.values())
    .map((g) => ({
      name: g.name,
      path: g.path,
      sessions: g.sessions.sort((a, b) => (Date.parse(b.updatedAt ?? b.startedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? a.startedAt ?? '') || 0)),
      totalTokens: g.totalTokens,
      sessionCount: g.sessions.length,
      latestActivity: g.latestActivity,
    }))
    .sort((a, b) => b.latestActivity - a.latestActivity);
}
