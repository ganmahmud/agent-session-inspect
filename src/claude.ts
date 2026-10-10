import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { collectFiles, extractProjectName, updateTime } from './codex.ts';
import {
  activityHasData,
  addUsage,
  calculateBreakdown,
  compactJson,
  finalise,
  MAX_PAYLOAD_STRING_LENGTH,
  newActivity,
  timestampDelta,
  toolFor,
  type PendingActivity,
} from './detail.ts';
import type {
  ConversationEntry,
  DebugMessage,
  DisplayTitle,
  EditDetail,
  ModelConfiguration,
  ModelRequestDetail,
  ReplyActivity,
  ScanResult,
  SessionDetail,
  SessionInventory,
  SourceReference,
  TaskTiming,
  TokenUsage,
  ToolCallDetail,
  UsageSnapshot,
} from './types.ts';

// Claude Code writes one JSONL transcript per session under ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
// Subagent (Task tool) transcripts are sidechains: either separate files under <session-id>/subagents/ or, in
// older versions, inline records flagged `isSidechain` without an `agentId`.

export type JsonRecord = Record<string, unknown>;

const DEFAULT_CONTEXT_WINDOW = 200_000;
const EXTENDED_CONTEXT_WINDOW = 1_000_000;
const TITLE_LENGTH = 80;

const KNOWN_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'summary',
  'custom-title',
  'ai-title',
  'attachment',
  'file-history-snapshot',
  'queue-operation',
  'last-prompt',
  'atis-latch',
]);

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Maps Anthropic usage onto the Codex-shaped TokenUsage: input includes cache reads and writes, as Codex input does. */
export function claudeUsage(value: unknown): TokenUsage | undefined {
  const source = record(value);
  if (!source) return undefined;
  const fresh = number(source.input_tokens);
  const cacheWrite = number(source.cache_creation_input_tokens);
  const cacheRead = number(source.cache_read_input_tokens);
  const output = number(source.output_tokens);
  if (fresh === undefined && cacheWrite === undefined && cacheRead === undefined && output === undefined) return undefined;
  const input = (fresh ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0);
  return {
    inputTokens: input,
    cachedInputTokens: cacheRead,
    outputTokens: output,
    reasoningOutputTokens: number(record(source.output_tokens_details)?.thinking_tokens),
    totalTokens: input + (output ?? 0),
  };
}

/** Session a record belongs to; file-based subagent sidechains become their own sessions. */
export function claudeSessionKey(source: JsonRecord): string | undefined {
  const sessionId = text(source.sessionId);
  if (!sessionId) return undefined;
  const agentId = text(source.agentId);
  return source.isSidechain === true && agentId ? `${sessionId}-agent-${agentId}` : sessionId;
}

export function contentBlocks(content: unknown): JsonRecord[] {
  return Array.isArray(content) ? content.flatMap((block) => (record(block) ? [record(block)!] : [])) : [];
}

export function blockText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.length ? content : undefined;
  const parts = contentBlocks(content).flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []));
  return parts.length ? parts.join('\n\n') : undefined;
}

function isCommandOutput(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith('<local-command-stdout>') || trimmed.startsWith('<local-command-stderr>') || trimmed.startsWith('<local-command-caveat>');
}

export function isInterruption(value: string): boolean {
  return value.trimStart().startsWith('[Request interrupted by user');
}

/** Visible prompt text of a user record, or undefined for tool results, meta records and command echoes. */
export function userPrompt(source: JsonRecord): string | undefined {
  if (source.isMeta === true || source.isCompactSummary === true || source.isVisibleInTranscriptOnly === true) return undefined;
  const content = record(source.message)?.content;
  if (contentBlocks(content).some((block) => block.type === 'tool_result')) return undefined;
  const value = blockText(content);
  return value && !isCommandOutput(value) ? value : undefined;
}

export function promptTitle(prompt: string): string | undefined {
  const commandName = /<command-name>([^<]+)<\/command-name>/.exec(prompt)?.[1];
  const args = /<command-args>([^<]*)<\/command-args>/.exec(prompt)?.[1];
  const value = (commandName ? `${commandName.trim()} ${args ?? ''}` : prompt).replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  return value.length > TITLE_LENGTH ? `${value.slice(0, TITLE_LENGTH - 1)}…` : value;
}

function toolKind(name: string): ToolCallDetail['kind'] {
  if (name === 'Bash' || name === 'BashOutput' || name === 'PowerShell') return 'exec';
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return 'patch';
  if (name === 'Task' || name === 'Agent') return 'subagent';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'function';
}

// --- Inventory scan -------------------------------------------------------------------------------------------

/** One measured fact extracted from a transcript line; cached per file so rescans only re-read changed files. */
interface Observation {
  key: string;
  uuid?: string;
  timestamp?: string;
  kind: string;
  known: boolean;
  malformed?: number;
  parentId?: string;
  cwd?: string;
  version?: string;
  requestKey?: string;
  usage?: TokenUsage;
  toolCalls?: number;
  toolOutputs?: number;
  execCompleted?: number;
  mcpCompleted?: number;
  prompt?: string;
  interrupted?: boolean;
  compaction?: boolean;
  title?: string;
  summary?: string;
  command?: string;
}

const fileCache = new Map<string, { mtimeMs: number; size: number; observations: Observation[] }>();

export function clearClaudeScanCache(): void {
  fileCache.clear();
}

function observeAssistant(observation: Observation, source: JsonRecord, message: JsonRecord | undefined, blocks: JsonRecord[], toolNames: Map<string, string>): void {
  observation.requestKey = text(message?.id) ?? text(source.requestId) ?? observation.uuid;
  observation.usage = claudeUsage(message?.usage);
  const uses = blocks.filter((block) => block.type === 'tool_use');
  observation.toolCalls = uses.length;
  for (const use of uses) {
    const id = text(use.id);
    if (id) toolNames.set(id, text(use.name) ?? '');
  }
  const firstType = text(blocks[0]?.type);
  if (firstType) observation.kind = `assistant.${firstType}`;
}

function observeUser(observation: Observation, source: JsonRecord, blocks: JsonRecord[], toolNames: Map<string, string>): void {
  const results = blocks.filter((block) => block.type === 'tool_result');
  if (results.length) {
    observation.kind = 'user.tool_result';
    observation.toolOutputs = results.length;
    for (const result of results) {
      const kind = toolKind(toolNames.get(text(result.tool_use_id) ?? '') ?? '');
      if (kind === 'exec') observation.execCompleted = (observation.execCompleted ?? 0) + 1;
      if (kind === 'mcp') observation.mcpCompleted = (observation.mcpCompleted ?? 0) + 1;
    }
  }
  const prompt = userPrompt(source);
  if (prompt) {
    observation.prompt = promptTitle(prompt);
    observation.interrupted = isInterruption(prompt);
  }
  if (source.isCompactSummary === true) observation.compaction = true;
}

function observeSystem(observation: Observation, source: JsonRecord, subtype: string | undefined): void {
  if (subtype === 'compact_boundary') observation.compaction = true;
  if (subtype !== 'local_command') return;
  const content = text(source.content);
  if (content?.includes('<command-name>')) observation.command = promptTitle(content);
}

function observeRecord(source: JsonRecord, type: string, key: string, toolNames: Map<string, string>): Observation {
  const message = record(source.message);
  const blocks = contentBlocks(message?.content);
  const subtype = text(source.subtype);
  const observation: Observation = {
    key,
    uuid: text(source.uuid),
    timestamp: text(source.timestamp),
    kind: subtype ? `${type}.${subtype}` : type,
    known: KNOWN_TYPES.has(type),
    cwd: text(source.cwd),
    version: text(source.version),
  };
  if (key !== text(source.sessionId)) observation.parentId = text(source.sessionId);
  if (type === 'assistant') observeAssistant(observation, source, message, blocks, toolNames);
  if (type === 'user') observeUser(observation, source, blocks, toolNames);
  if (type === 'system') observeSystem(observation, source, subtype);
  if (type === 'custom-title' || type === 'ai-title') observation.title = text(source.customTitle) ?? text(source.aiTitle) ?? text(source.title);
  return observation;
}

function parseJsonLine(raw: string): JsonRecord | undefined {
  try {
    return record(JSON.parse(raw)) ?? {};
  } catch {
    return undefined;
  }
}

async function observeFile(file: string): Promise<Observation[]> {
  const observations: Observation[] = [];
  const summaries: string[] = [];
  const toolNames = new Map<string, string>();
  let malformed = 0;
  let primaryKey: string | undefined;
  const input = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

  for await (const raw of input) {
    if (!raw.trim()) continue;
    const source = parseJsonLine(raw);
    if (!source) {
      malformed += 1;
      continue;
    }
    const type = text(source.type) ?? 'unknown';
    const summary = type === 'summary' ? text(source.summary) : undefined;
    if (summary) summaries.push(summary);
    const key = type === 'summary' ? undefined : claudeSessionKey(source);
    if (!key) continue;
    primaryKey ??= key;
    observations.push(observeRecord(source, type, key, toolNames));
  }

  const summary = summaryObservation(file, observations, primaryKey, summaries, malformed);
  if (summary) observations.push(summary);
  return observations;
}

/** Summary records carry no session id; they describe the session the file belongs to. */
function summaryObservation(file: string, observations: Observation[], primaryKey: string | undefined, summaries: string[], malformed: number): Observation | undefined {
  const fileKey = basename(file, '.jsonl');
  const summaryKey = observations.some((item) => item.key === fileKey) ? fileKey : primaryKey;
  if (!summaryKey || (!summaries.length && !malformed)) return undefined;
  return { key: summaryKey, kind: 'summary', known: true, summary: summaries.at(-1), malformed };
}

async function cachedObservations(file: string): Promise<Observation[]> {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return [];
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.observations;
  const observations = await observeFile(file);
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, observations });
  return observations;
}

interface MutableClaudeSession extends SessionInventory {
  seen: Set<string>;
  requests: Map<string, { usage: TokenUsage; timestamp?: string }>;
  title?: string;
  summary?: string;
  firstPrompt?: { value: string; timestamp?: string };
  commands: string[];
}

function emptySession(id: string): MutableClaudeSession {
  return {
    id,
    agent: 'claude',
    displayTitle: { value: null, source: 'absent' },
    sourceFiles: [],
    provider: 'anthropic',
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
    seen: new Set(),
    requests: new Map(),
    commands: [],
  };
}

function applyRequest(session: MutableClaudeSession, item: Observation): void {
  if (!item.requestKey) return;
  if (item.usage) session.requests.set(item.requestKey, { usage: item.usage, timestamp: item.timestamp });
  else if (!session.requests.has(item.requestKey)) session.token.missingUsageObservations += 1;
}

function applyPrompt(session: MutableClaudeSession, item: Observation): void {
  if (!item.prompt) return;
  if (item.interrupted) {
    session.abortedTaskCount += 1;
    return;
  }
  session.taskCount += 1;
  if (!session.firstPrompt || (item.timestamp ?? '') < (session.firstPrompt.timestamp ?? '')) session.firstPrompt = { value: item.prompt, timestamp: item.timestamp };
}

function apply(session: MutableClaudeSession, item: Observation): void {
  if (item.uuid) {
    // Resumed sessions replay earlier records into a new file; count each record once.
    if (session.seen.has(item.uuid)) return;
    session.seen.add(item.uuid);
  }
  session.malformedRecords += item.malformed ?? 0;
  if (item.summary) session.summary = item.summary;
  if (item.kind === 'summary') return;

  session.recordCount += 1;
  session.eventCounts[item.kind] = (session.eventCounts[item.kind] ?? 0) + 1;
  if (!item.known) session.unknownRecords += 1;
  updateTime(session, item.timestamp);
  session.cwd ??= item.cwd;
  if (item.version && !session.cliVersions.includes(item.version)) session.cliVersions.push(item.version);
  if (item.parentId && !session.relationships.some((edge) => edge.type === 'parent')) session.relationships.push({ type: 'parent', sessionId: item.parentId });
  applyRequest(session, item);
  session.tools.calls += item.toolCalls ?? 0;
  session.tools.outputs += item.toolOutputs ?? 0;
  session.tools.execCompleted += item.execCompleted ?? 0;
  session.tools.mcpCompleted += item.mcpCompleted ?? 0;
  applyPrompt(session, item);
  if (item.compaction) session.compactionCount += 1;
  if (item.title) session.title = item.title;
  if (item.command && !session.commands.includes(item.command)) session.commands.push(item.command);
}

function titleFor(session: MutableClaudeSession): DisplayTitle | undefined {
  if (session.title) return { value: session.title, source: 'session_event' };
  if (session.summary) return { value: session.summary, source: 'session_event' };
  if (session.firstPrompt) return { value: session.firstPrompt.value, source: 'session_event', observedAt: session.firstPrompt.timestamp };
  // Sessions that only ran local slash commands (/login, /skills, …) have no prompt to title them by.
  if (session.commands.length) return { value: session.commands.join(', '), source: 'session_event' };
  return undefined;
}

function finish(session: MutableClaudeSession): SessionInventory {
  const total: TokenUsage = {};
  let last: TokenUsage | undefined;
  let largestInput = 0;
  for (const request of [...session.requests.values()].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))) {
    addUsage(total, request.usage);
    last = request.usage;
    largestInput = Math.max(largestInput, request.usage.inputTokens ?? 0);
  }
  session.token.observations = session.requests.size;
  if (last) {
    session.token.total = total;
    session.token.last = last;
    session.token.modelContextWindow = contextWindow(largestInput);
  }
  session.completedTaskCount = Math.max(0, session.taskCount - session.abortedTaskCount);
  session.projectName = extractProjectName(session.cwd);
  const title = titleFor(session);
  if (title) session.displayTitle = title;
  session.cliVersions.sort();
  session.sourceFiles.sort();
  session.relationships.sort((a, b) => `${a.type}:${a.sessionId}`.localeCompare(`${b.type}:${b.sessionId}`));
  for (const key of ['seen', 'requests', 'title', 'summary', 'firstPrompt', 'commands'] as const) Reflect.deleteProperty(session, key);
  return session;
}

function contextWindow(largestInput: number): number {
  // ponytail: transcripts do not record the window size; a prompt larger than the default implies the 1M tier.
  return largestInput > DEFAULT_CONTEXT_WINDOW ? EXTENDED_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

export async function scanClaude(path: string): Promise<ScanResult> {
  const diagnostics: ScanResult['diagnostics'] = { filesRead: 0, malformedRecords: 0, catalogErrors: [] };
  const sessions = new Map<string, MutableClaudeSession>();
  for (const file of collectFiles(path)) {
    diagnostics.filesRead += 1;
    for (const item of await cachedObservations(file)) {
      diagnostics.malformedRecords += item.malformed ?? 0;
      const session = sessions.get(item.key) ?? emptySession(item.key);
      sessions.set(item.key, session);
      if (!session.sourceFiles.includes(file)) session.sourceFiles.push(file);
      apply(session, item);
    }
  }
  for (const session of sessions.values()) {
    const parent = session.relationships.find((edge) => edge.type === 'parent');
    const parentSession = parent && sessions.get(parent.sessionId);
    if (parentSession && !parentSession.relationships.some((edge) => edge.type === 'subagent' && edge.sessionId === session.id)) {
      parentSession.relationships.push({ type: 'subagent', sessionId: session.id });
    }
  }
  const ordered = [...sessions.values()]
    .map(finish)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  return { schemaVersion: 1, provider: 'claude', sessions: ordered, diagnostics };
}

// --- Session detail -------------------------------------------------------------------------------------------

export function unifiedDiff(result: JsonRecord): string | undefined {
  const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch.flatMap((hunk) => (record(hunk) ? [record(hunk)!] : [])) : [];
  const file = (text(result.filePath) ?? 'file').replace(/^\/+/, '');
  let diff: string;
  if (hunks.length) {
    const body = hunks.map((hunk) => {
      const lines = Array.isArray(hunk.lines) ? hunk.lines.filter((line): line is string => typeof line === 'string') : [];
      return `@@ -${number(hunk.oldStart) ?? 0},${number(hunk.oldLines) ?? 0} +${number(hunk.newStart) ?? 0},${number(hunk.newLines) ?? 0} @@\n${lines.join('\n')}`;
    });
    diff = `--- a/${file}\n+++ b/${file}\n${body.join('\n')}`;
  } else if (result.type === 'create' && typeof result.content === 'string') {
    const lines = result.content.split('\n');
    diff = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => '+' + line).join('\n')}`;
  } else {
    return undefined;
  }
  return diff.length > MAX_PAYLOAD_STRING_LENGTH ? `${diff.slice(0, MAX_PAYLOAD_STRING_LENGTH)}\n\n... [Truncated diff for memory optimization]` : diff;
}

function editFromResult(id: string, result: JsonRecord | undefined, timestamp: string | undefined, source: SourceReference, isError: boolean): EditDetail | undefined {
  const path = text(result?.filePath) ?? text(result?.notebook_path);
  if (!result || !path || isError) return undefined;
  const operation = text(result.type) === 'create' ? 'add' : 'update';
  return { id, timestamp, status: 'completed', files: [{ path, operation, diff: unifiedDiff(result) }], source };
}

export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  const value = blockText(content);
  return value ?? compactJson(content);
}

interface ClaudeRecordContext {
  source: JsonRecord;
  type?: string;
  uuid?: string;
  timestamp?: string;
  provenance: SourceReference;
  message?: JsonRecord;
  blocks: JsonRecord[];
}

function hiddenRole(source: JsonRecord): string {
  if (source.isCompactSummary === true) return 'compact_summary';
  return source.isMeta === true ? 'meta' : 'command';
}

class ClaudeDetailReader {
  readonly conversation: ConversationEntry[] = [];
  readonly hiddenMessages: DebugMessage[] = [];
  readonly unattachedActivities: ReplyActivity[] = [];
  readonly requests = new Map<string, ModelRequestDetail>();
  private readonly toolIndex = new Map<string, ToolCallDetail>();
  private readonly seen = new Set<string>();
  private currentModel: ModelConfiguration = { source: 'unavailable' };
  private pending: PendingActivity;
  private turn: TaskTiming | undefined;
  private turnLastAssistant: ConversationEntry | undefined;

  private readonly session: SessionInventory;

  constructor(session: SessionInventory) {
    this.session = session;
    this.pending = newActivity(session.startedAt, this.currentModel);
  }

  /** Whether a record belongs to this session, counting replayed records (same uuid) once. */
  private accepts(source: JsonRecord, sidechainInline: boolean, uuid?: string): boolean {
    const ownRecord = claudeSessionKey(source) === this.session.id || (sidechainInline && text(source.sessionId) === this.session.id);
    if (!ownRecord) return false;
    if (!uuid) return true;
    if (this.seen.has(uuid)) return false;
    this.seen.add(uuid);
    return true;
  }

  read(source: JsonRecord, provenance: SourceReference): void {
    const sidechainInline = source.isSidechain === true && !text(source.agentId);
    const uuid = text(source.uuid);
    if (!this.accepts(source, sidechainInline, uuid)) return;
    const message = record(source.message);
    const ctx: ClaudeRecordContext = { source, type: text(source.type), uuid, timestamp: text(source.timestamp), provenance, message, blocks: contentBlocks(message?.content) };
    if (sidechainInline) this.sidechain(ctx);
    else if (ctx.type === 'assistant') this.assistant(ctx);
    else if (ctx.type === 'user') this.user(ctx);
    else if (ctx.type === 'system') this.system(ctx);
  }

  finish(): void {
    this.flushPending();
    this.closeTurn('completed');
  }

  private hide(ctx: ClaudeRecordContext, role: string, value: string): void {
    const { file, line } = ctx.provenance;
    this.hiddenMessages.push({ id: `${file}:${line}`, role, timestamp: ctx.timestamp, text: value, source: ctx.provenance });
  }

  /** Inline subagent traffic from older Claude Code versions: keep it out of the main conversation. */
  private sidechain(ctx: ClaudeRecordContext): void {
    const value = blockText(ctx.message?.content);
    if (value) this.hide(ctx, `sidechain:${text(ctx.message?.role) ?? ctx.type ?? 'unknown'}`, value);
  }

  private system(ctx: ClaudeRecordContext): void {
    const content = text(ctx.source.content);
    const subtype = text(ctx.source.subtype);
    if (content) this.hide(ctx, subtype ? 'system:' + subtype : 'system', content);
  }

  private assistant(ctx: ClaudeRecordContext): void {
    const { message, source, timestamp, provenance } = ctx;
    const model = text(message?.model);
    if (model && model !== '<synthetic>') this.currentModel = { name: model, provider: 'anthropic', source: 'message', observedAt: timestamp };
    this.recordRequest(text(message?.id) ?? text(source.requestId) ?? `${provenance.file}:${provenance.line}`, claudeUsage(message?.usage), ctx);
    for (const block of ctx.blocks) {
      if (block.type === 'tool_use') this.toolUse(block, ctx);
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) this.reply(block.text, ctx);
    }
  }

  private recordRequest(requestKey: string, usage: TokenUsage | undefined, ctx: ClaudeRecordContext): void {
    if (!usage) return;
    const existing = this.requests.get(requestKey);
    if (existing) {
      existing.usage = usage;
      return;
    }
    const request: ModelRequestDetail = { id: requestKey, timestamp: ctx.timestamp, usage, evidence: 'reported_snapshot', source: ctx.provenance };
    this.requests.set(requestKey, request);
    this.pending.modelRequests.push(request);
  }

  private toolUse(block: JsonRecord, ctx: ClaudeRecordContext): void {
    const id = text(block.id) ?? `${ctx.provenance.file}:${ctx.provenance.line}`;
    const name = text(block.name) ?? 'tool call';
    toolFor(this.pending, this.toolIndex, id, { name, kind: toolKind(name), startedAt: ctx.timestamp, input: compactJson(block.input), source: ctx.provenance });
  }

  private reply(value: string, ctx: ClaudeRecordContext): void {
    this.pending.model = this.currentModel;
    const entry: ConversationEntry = {
      id: `${ctx.provenance.file}:${ctx.provenance.line}`,
      role: 'assistant',
      kind: 'conversation',
      timestamp: ctx.timestamp,
      text: value,
      source: ctx.provenance,
      activity: finalise(this.pending, ctx.timestamp),
    };
    this.conversation.push(entry);
    this.turnLastAssistant = entry;
    if (this.turn) this.turn.completedAt = ctx.timestamp;
    this.pending = newActivity(ctx.timestamp, this.currentModel);
  }

  private user(ctx: ClaudeRecordContext): void {
    const results = ctx.blocks.filter((block) => block.type === 'tool_result');
    if (results.length) {
      for (const result of results) this.toolResult(result, results.length === 1, ctx);
      return;
    }
    const prompt = userPrompt(ctx.source);
    if (prompt === undefined) {
      const value = blockText(ctx.message?.content);
      if (value) this.hide(ctx, hiddenRole(ctx.source), value);
      return;
    }
    this.flushPending();
    if (isInterruption(prompt)) this.closeTurn('aborted');
    else {
      this.closeTurn('completed');
      this.pending = newActivity(ctx.timestamp, this.currentModel);
      this.turn = { id: ctx.uuid, startedAt: ctx.timestamp, completedAt: ctx.timestamp, status: 'open' };
    }
    const { file, line } = ctx.provenance;
    this.conversation.push({ id: `${file}:${line}`, role: 'user', kind: 'conversation', timestamp: ctx.timestamp, text: prompt, source: ctx.provenance });
  }

  private toolResult(result: JsonRecord, onlyResult: boolean, ctx: ClaudeRecordContext): void {
    const { timestamp, provenance } = ctx;
    const id = text(result.tool_use_id) ?? `${provenance.file}:${provenance.line}`;
    const tool = this.toolIndex.get(id) ?? toolFor(this.pending, this.toolIndex, id, { name: 'tool call', kind: 'unknown', source: provenance });
    const isError = result.is_error === true;
    tool.completedAt = timestamp;
    tool.status = isError ? 'error' : 'completed';
    tool.output = compactJson(toolResultText(result.content));
    tool.durationMs ??= timestampDelta(tool.startedAt, tool.completedAt);
    if (this.turn) this.turn.completedAt = timestamp;
    if (tool.kind === 'patch' && onlyResult) {
      const edit = editFromResult(id, record(ctx.source.toolUseResult), timestamp, provenance, isError);
      if (edit) this.pending.edits.push(edit);
    }
  }

  // Claude Code often runs a batch of tools without writing text afterwards (or between batches); keep that work in
  // the conversation as a text-less reply instead of dropping it into the unattached debug bucket.
  private flushPending(): void {
    const pending = this.pending;
    if (!activityHasData(pending)) return;
    const timestamps = [
      ...pending.tools.map((tool) => tool.completedAt ?? tool.startedAt),
      ...pending.modelRequests.map((request) => request.timestamp),
    ].filter((value): value is string => Boolean(value));
    const completedAt = timestamps.sort((a, b) => a.localeCompare(b)).at(-1);
    const first = pending.tools[0]?.source ?? pending.modelRequests[0]?.source;
    pending.model = this.currentModel;
    const entry: ConversationEntry = {
      id: first ? `${first.file}:${first.line}:activity` : `activity-${this.conversation.length}`,
      role: 'assistant',
      kind: 'conversation',
      timestamp: completedAt ?? pending.startedAt,
      text: '',
      phase: 'tool_activity',
      source: first ?? { file: this.session.sourceFiles[0] ?? '', line: 0 },
      activity: finalise(pending, completedAt),
    };
    this.conversation.push(entry);
    this.turnLastAssistant = entry;
    if (this.turn && completedAt && completedAt > (this.turn.completedAt ?? '')) this.turn.completedAt = completedAt;
    this.pending = newActivity(completedAt, this.currentModel);
  }

  private closeTurn(status: TaskTiming['status']): void {
    const turn = this.turn;
    if (!turn) return;
    turn.status = status;
    turn.durationMs = timestampDelta(turn.startedAt, turn.completedAt);
    const activity = this.turnLastAssistant?.activity;
    if (activity) {
      activity.task = turn;
      activity.breakdown = calculateBreakdown(activity);
    }
    this.turn = undefined;
    this.turnLastAssistant = undefined;
  }
}

export async function readClaudeSessionDetail(session: SessionInventory): Promise<SessionDetail> {
  const reader = new ClaudeDetailReader(session);
  for (const file of session.sourceFiles) {
    const input = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    let line = 0;
    for await (const raw of input) {
      line += 1;
      const source = raw.trim() ? parseJsonLine(raw) : undefined;
      if (source) reader.read(source, { file, line });
    }
  }
  reader.finish();

  // Snapshots are cumulative over unique model requests, mirroring Codex `total_token_usage`.
  const ordered = [...reader.requests.values()].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  const modelStepTotal: TokenUsage = {};
  const snapshots: UsageSnapshot[] = [];
  const window = session.token.modelContextWindow ?? contextWindow(Math.max(0, ...ordered.map((request) => request.usage.inputTokens ?? 0)));
  for (const request of ordered) {
    addUsage(modelStepTotal, request.usage);
    request.totalUsage = { ...modelStepTotal };
    snapshots.push({ id: `snapshot-${snapshots.length + 1}`, timestamp: request.timestamp, usage: { ...modelStepTotal }, modelContextWindow: window, source: request.source, evidence: 'reported_snapshot' });
  }

  return {
    ...session,
    conversation: reader.conversation,
    usage: { latest: snapshots.at(-1), snapshots, modelStepTotal, modelStepCount: ordered.length, evidence: 'reported_snapshot' },
    debug: { hiddenMessages: reader.hiddenMessages, unattachedActivities: reader.unattachedActivities, malformedRecords: session.malformedRecords, unknownRecords: session.unknownRecords },
  };
}
