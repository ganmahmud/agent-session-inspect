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

type JsonRecord = Record<string, unknown>;

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

function contentBlocks(content: unknown): JsonRecord[] {
  return Array.isArray(content) ? content.flatMap((block) => (record(block) ? [record(block)!] : [])) : [];
}

function blockText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.length ? content : undefined;
  const parts = contentBlocks(content).flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []));
  return parts.length ? parts.join('\n\n') : undefined;
}

function isCommandOutput(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith('<local-command-stdout>') || trimmed.startsWith('<local-command-stderr>') || trimmed.startsWith('<local-command-caveat>');
}

function isInterruption(value: string): boolean {
  return value.trimStart().startsWith('[Request interrupted by user');
}

/** Visible prompt text of a user record, or undefined for tool results, meta records and command echoes. */
function userPrompt(source: JsonRecord): string | undefined {
  if (source.isMeta === true || source.isCompactSummary === true || source.isVisibleInTranscriptOnly === true) return undefined;
  const content = record(source.message)?.content;
  if (contentBlocks(content).some((block) => block.type === 'tool_result')) return undefined;
  const value = blockText(content);
  return value && !isCommandOutput(value) ? value : undefined;
}

function promptTitle(prompt: string): string | undefined {
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
}

const fileCache = new Map<string, { mtimeMs: number; size: number; observations: Observation[] }>();

export function clearClaudeScanCache(): void {
  fileCache.clear();
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
    let source: JsonRecord;
    try {
      source = record(JSON.parse(raw)) ?? {};
    } catch {
      malformed += 1;
      continue;
    }
    const type = text(source.type) ?? 'unknown';
    if (type === 'summary') {
      const summary = text(source.summary);
      if (summary) summaries.push(summary);
      continue;
    }
    const key = claudeSessionKey(source);
    if (!key) continue;
    primaryKey ??= key;

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

    if (type === 'assistant') {
      observation.requestKey = text(message?.id) ?? text(source.requestId) ?? observation.uuid;
      observation.usage = claudeUsage(message?.usage);
      const uses = blocks.filter((block) => block.type === 'tool_use');
      observation.toolCalls = uses.length;
      for (const use of uses) {
        const id = text(use.id);
        if (id) toolNames.set(id, text(use.name) ?? '');
      }
      if (blocks[0] && text(blocks[0].type)) observation.kind = `assistant.${text(blocks[0].type)}`;
    }

    if (type === 'user') {
      const results = blocks.filter((block) => block.type === 'tool_result');
      if (results.length) {
        observation.kind = 'user.tool_result';
        observation.toolOutputs = results.length;
        for (const result of results) {
          const name = toolNames.get(text(result.tool_use_id) ?? '') ?? '';
          if (toolKind(name) === 'exec') observation.execCompleted = (observation.execCompleted ?? 0) + 1;
          if (toolKind(name) === 'mcp') observation.mcpCompleted = (observation.mcpCompleted ?? 0) + 1;
        }
      }
      const prompt = userPrompt(source);
      if (prompt) {
        observation.prompt = promptTitle(prompt);
        observation.interrupted = isInterruption(prompt);
      }
      if (source.isCompactSummary === true) observation.compaction = true;
    }

    if (type === 'system' && subtype === 'compact_boundary') observation.compaction = true;
    if (type === 'custom-title' || type === 'ai-title') observation.title = text(source.customTitle) ?? text(source.aiTitle) ?? text(source.title);
    observations.push(observation);
  }

  // Summary records carry no session id; they describe the session the file belongs to.
  const fileKey = basename(file, '.jsonl');
  const summaryKey = observations.some((item) => item.key === fileKey) ? fileKey : primaryKey;
  if (summaryKey && (summaries.length || malformed)) {
    observations.push({ key: summaryKey, kind: 'summary', known: true, summary: summaries.at(-1), malformed });
  }
  return observations;
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
  };
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
  if (item.requestKey) {
    if (item.usage) session.requests.set(item.requestKey, { usage: item.usage, timestamp: item.timestamp });
    else if (!session.requests.has(item.requestKey)) session.token.missingUsageObservations += 1;
  }
  session.tools.calls += item.toolCalls ?? 0;
  session.tools.outputs += item.toolOutputs ?? 0;
  session.tools.execCompleted += item.execCompleted ?? 0;
  session.tools.mcpCompleted += item.mcpCompleted ?? 0;
  if (item.prompt) {
    if (item.interrupted) session.abortedTaskCount += 1;
    else {
      session.taskCount += 1;
      if (!session.firstPrompt || (item.timestamp ?? '') < (session.firstPrompt.timestamp ?? '')) session.firstPrompt = { value: item.prompt, timestamp: item.timestamp };
    }
  }
  if (item.compaction) session.compactionCount += 1;
  if (item.title) session.title = item.title;
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
  const title: DisplayTitle | undefined = session.title
    ? { value: session.title, source: 'session_event' }
    : session.summary
      ? { value: session.summary, source: 'session_event' }
      : session.firstPrompt
        ? { value: session.firstPrompt.value, source: 'session_event', observedAt: session.firstPrompt.timestamp }
        : undefined;
  if (title) session.displayTitle = title;
  session.cliVersions.sort();
  session.sourceFiles.sort();
  session.relationships.sort((a, b) => `${a.type}:${a.sessionId}`.localeCompare(`${b.type}:${b.sessionId}`));
  for (const key of ['seen', 'requests', 'title', 'summary', 'firstPrompt'] as const) Reflect.deleteProperty(session, key);
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

function unifiedDiff(result: JsonRecord): string | undefined {
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
    diff = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
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

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  const value = blockText(content);
  return value ?? compactJson(content);
}

export async function readClaudeSessionDetail(session: SessionInventory): Promise<SessionDetail> {
  const conversation: ConversationEntry[] = [];
  const hiddenMessages: DebugMessage[] = [];
  const unattachedActivities: ReplyActivity[] = [];
  const toolIndex = new Map<string, ToolCallDetail>();
  const requests = new Map<string, ModelRequestDetail>();
  const seen = new Set<string>();
  let currentModel: ModelConfiguration = { source: 'unavailable' };
  let pending: PendingActivity = newActivity(session.startedAt, currentModel);
  let turn: TaskTiming | undefined;
  let turnLastAssistant: ConversationEntry | undefined;

  const closeTurn = (status: TaskTiming['status']) => {
    if (!turn) return;
    turn.status = status;
    turn.durationMs = timestampDelta(turn.startedAt, turn.completedAt);
    if (turnLastAssistant?.activity) {
      turnLastAssistant.activity.task = turn;
      turnLastAssistant.activity.breakdown = calculateBreakdown(turnLastAssistant.activity);
    }
    turn = undefined;
    turnLastAssistant = undefined;
  };

  for (const file of session.sourceFiles) {
    const input = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    let line = 0;
    for await (const raw of input) {
      line += 1;
      if (!raw.trim()) continue;
      let source: JsonRecord;
      try {
        source = record(JSON.parse(raw)) ?? {};
      } catch {
        continue;
      }
      const type = text(source.type);
      const sidechainInline = source.isSidechain === true && !text(source.agentId);
      if (claudeSessionKey(source) !== session.id && !(sidechainInline && text(source.sessionId) === session.id)) continue;
      const uuid = text(source.uuid);
      if (uuid) {
        if (seen.has(uuid)) continue;
        seen.add(uuid);
      }
      const timestamp = text(source.timestamp);
      const provenance: SourceReference = { file, line };
      const message = record(source.message);
      const blocks = contentBlocks(message?.content);

      if (sidechainInline) {
        // Inline subagent traffic from older Claude Code versions: keep it out of the main conversation.
        const value = blockText(message?.content);
        if (value) hiddenMessages.push({ id: `${file}:${line}`, role: `sidechain:${text(message?.role) ?? type ?? 'unknown'}`, timestamp, text: value, source: provenance });
        continue;
      }

      if (type === 'assistant') {
        const model = text(message?.model);
        if (model && model !== '<synthetic>') currentModel = { name: model, provider: 'anthropic', source: 'message', observedAt: timestamp };
        const requestKey = text(message?.id) ?? text(source.requestId) ?? `${file}:${line}`;
        const usage = claudeUsage(message?.usage);
        const existing = requests.get(requestKey);
        if (existing) {
          if (usage) existing.usage = usage;
        } else if (usage) {
          const request: ModelRequestDetail = { id: requestKey, timestamp, usage, evidence: 'reported_snapshot', source: provenance };
          requests.set(requestKey, request);
          pending.modelRequests.push(request);
        }

        for (const block of blocks) {
          if (block.type === 'tool_use') {
            const id = text(block.id) ?? `${file}:${line}`;
            const name = text(block.name) ?? 'tool call';
            toolFor(pending, toolIndex, id, { name, kind: toolKind(name), startedAt: timestamp, input: compactJson(block.input), source: provenance });
          }
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            pending.model = currentModel;
            const entry: ConversationEntry = {
              id: `${file}:${line}`,
              role: 'assistant',
              kind: 'conversation',
              timestamp,
              text: block.text,
              source: provenance,
              activity: finalise(pending, timestamp),
            };
            conversation.push(entry);
            turnLastAssistant = entry;
            if (turn) turn.completedAt = timestamp;
            pending = newActivity(timestamp, currentModel);
          }
        }
        continue;
      }

      if (type === 'user') {
        const results = blocks.filter((block) => block.type === 'tool_result');
        for (const result of results) {
          const id = text(result.tool_use_id) ?? `${file}:${line}`;
          const tool = toolIndex.get(id) ?? toolFor(pending, toolIndex, id, { name: 'tool call', kind: 'unknown', source: provenance });
          const isError = result.is_error === true;
          tool.completedAt = timestamp;
          tool.status = isError ? 'error' : 'completed';
          tool.output = compactJson(toolResultText(result.content));
          tool.durationMs ??= timestampDelta(tool.startedAt, tool.completedAt);
          if (turn) turn.completedAt = timestamp;
          if (tool.kind === 'patch' && results.length === 1) {
            const edit = editFromResult(id, record(source.toolUseResult), timestamp, provenance, isError);
            if (edit) pending.edits.push(edit);
          }
        }
        if (results.length) continue;

        const prompt = userPrompt(source);
        if (prompt === undefined) {
          const value = blockText(message?.content);
          if (value) hiddenMessages.push({ id: `${file}:${line}`, role: source.isCompactSummary === true ? 'compact_summary' : source.isMeta === true ? 'meta' : 'command', timestamp, text: value, source: provenance });
          continue;
        }
        const interrupted = isInterruption(prompt);
        if (interrupted) closeTurn('aborted');
        else {
          closeTurn('completed');
          if (activityHasData(pending)) unattachedActivities.push(finalise(pending));
          pending = newActivity(timestamp, currentModel);
          turn = { id: uuid, startedAt: timestamp, completedAt: timestamp, status: 'open' };
        }
        conversation.push({ id: `${file}:${line}`, role: 'user', kind: 'conversation', timestamp, text: prompt, source: provenance });
        continue;
      }

      if (type === 'system') {
        const content = text(source.content);
        if (content) hiddenMessages.push({ id: `${file}:${line}`, role: `system${text(source.subtype) ? `:${text(source.subtype)}` : ''}`, timestamp, text: content, source: provenance });
      }
    }
  }

  closeTurn('completed');
  if (activityHasData(pending)) unattachedActivities.push(finalise(pending));

  // Snapshots are cumulative over unique model requests, mirroring Codex `total_token_usage`.
  const ordered = [...requests.values()].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
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
    conversation,
    usage: { latest: snapshots.at(-1), snapshots, modelStepTotal, modelStepCount: ordered.length, evidence: 'reported_snapshot' },
    debug: { hiddenMessages, unattachedActivities, malformedRecords: session.malformedRecords, unknownRecords: session.unknownRecords },
  };
}
