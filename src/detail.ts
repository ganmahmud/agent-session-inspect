import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type {
  ConversationEntry,
  DebugMessage,
  EditDetail,
  ModelConfiguration,
  ModelRequestDetail,
  ReplyActivity,
  SessionDetail,
  SessionInventory,
  SessionUsage,
  SourceReference,
  TaskTiming,
  TimeBreakdown,
  TokenUsage,
  ToolCallDetail,
  TurnSettings,
  UsageSnapshot,
} from './types.ts';

type JsonRecord = Record<string, unknown>;

export interface PendingActivity extends ReplyActivity {
  task?: TaskTiming;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function usage(value: unknown): TokenUsage | undefined {
  const source = record(value);
  if (!source) return undefined;
  const result: TokenUsage = {
    inputTokens: number(source.input_tokens),
    cachedInputTokens: number(source.cached_input_tokens),
    outputTokens: number(source.output_tokens),
    reasoningOutputTokens: number(source.reasoning_output_tokens),
    totalTokens: number(source.total_tokens),
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

function durationMs(value: unknown): number | undefined {
  const source = record(value);
  if (!source) return undefined;
  const seconds = number(source.secs);
  const nanos = number(source.nanos);
  return seconds === undefined && nanos === undefined ? undefined : Math.round((seconds ?? 0) * 1000 + (nanos ?? 0) / 1_000_000);
}

export const MAX_PAYLOAD_STRING_LENGTH = 50_000;

export function compactJson(value: unknown, limit = MAX_PAYLOAD_STRING_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (str.length > limit) {
    return str.slice(0, limit) + `\n\n... [Truncated ${str.length - limit} characters for memory optimization]`;
  }
  return str;
}

function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const blocks = content.flatMap((block) => {
    const value = record(block);
    return value && typeof value.text === 'string' ? [value.text] : [];
  });
  return blocks.length ? blocks.join('\n\n') : undefined;
}

type TranscriptFormat = 'canonical' | 'event' | 'response';

function parseLine(raw: string): JsonRecord | undefined {
  if (!raw.trim()) return undefined;
  try {
    return record(JSON.parse(raw)) ?? {};
  } catch {
    return undefined;
  }
}

function isCanonicalMessage(payload: JsonRecord): boolean {
  const itemType = text(record(payload.item)?.type);
  return itemType === 'UserMessage' || itemType === 'AgentMessage';
}

async function transcriptFormat(file: string): Promise<TranscriptFormat> {
  let userEventCount = 0;
  let agentEventCount = 0;
  const input = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of input) {
    const source = parseLine(raw);
    if (text(source?.type) !== 'event_msg') continue;
    const payload = record(source?.payload) ?? {};
    const eventType = text(payload.type);
    if (eventType === 'item_completed' && isCanonicalMessage(payload)) return 'canonical';
    if (eventType === 'user_message') userEventCount += 1;
    if (eventType === 'agent_message') agentEventCount += 1;
  }
  return userEventCount && agentEventCount ? 'event' : 'response';
}

function canonicalMessage(payload: JsonRecord): { role: 'user' | 'assistant'; text: string } | undefined {
  const item = record(payload.item);
  const itemType = text(item?.type);
  const roles: Record<string, 'user' | 'assistant'> = { UserMessage: 'user', AgentMessage: 'assistant' };
  const role = itemType ? roles[itemType] : undefined;
  const value = messageText(item?.content);
  return role && value !== undefined ? { role, text: value } : undefined;
}

export function timestampDelta(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const delta = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
}

function emptyUsage(): TokenUsage {
  return {};
}

export function addUsage(total: TokenUsage, next: TokenUsage): void {
  for (const key of Object.keys(next) as Array<keyof TokenUsage>) {
    if (next[key] !== undefined) total[key] = (total[key] ?? 0) + next[key];
  }
}

export function newActivity(startedAt?: string, model: ModelConfiguration = { source: 'unavailable' }): PendingActivity {
  return {
    association: 'source_order',
    startedAt,
    model,
    modelRequests: [],
    tools: [],
    edits: [],
    breakdown: { measuredToolMs: 0, source: 'unavailable', explanation: 'No response interval was recorded.' },
  };
}

function toolKind(name: string, fallback: ToolCallDetail['kind']): ToolCallDetail['kind'] {
  if (name === 'exec' || name === 'exec_command') return 'exec';
  if (name === 'apply_patch') return 'patch';
  if (name.toLowerCase().includes('subagent') || name.startsWith('agent:') || name.startsWith('sub_agent') || name === 'delegate_task' || name === 'spawn_agent') return 'subagent';
  return fallback;
}

export function toolFor(activity: PendingActivity, tools: Map<string, ToolCallDetail>, id: string, partial: Partial<ToolCallDetail>): ToolCallDetail {
  const existing = tools.get(id);
  if (existing) {
    Object.assign(existing, Object.fromEntries(Object.entries(partial).filter(([, value]) => value !== undefined)));
    return existing;
  }
  const created: ToolCallDetail = { id, name: partial.name ?? 'unknown tool', kind: partial.kind ?? 'unknown', ...partial };
  tools.set(id, created);
  activity.tools.push(created);
  return created;
}

function editFiles(value: unknown): EditDetail['files'] {
  const changes = record(value);
  if (!changes) return [];
  return Object.entries(changes).map(([path, change]) => {
    const source = record(change);
    let diff = text(source?.unified_diff);
    if (diff && diff.length > MAX_PAYLOAD_STRING_LENGTH) {
      diff = diff.slice(0, MAX_PAYLOAD_STRING_LENGTH) + '\n\n... [Truncated diff for memory optimization]';
    }
    return { path, operation: text(source?.type), diff };
  });
}

/** A tool's [start, end] in epoch ms; the start is derived from end and duration when it was not logged. */
function toolInterval(tool: ToolCallDetail): readonly [number, number] | undefined {
  const toolDuration = tool.durationMs ?? timestampDelta(tool.startedAt, tool.completedAt);
  if (!tool.completedAt || toolDuration === undefined) return undefined;
  const end = Date.parse(tool.completedAt);
  const start = tool.startedAt ? Date.parse(tool.startedAt) : end - toolDuration;
  return end >= start ? [start, end] : undefined;
}

function breakdownExplanation(duration: number | undefined, measuredToolMs: number): string {
  if (duration === undefined) return 'No response completion interval was recorded; measured tool time is shown when available.';
  if (measuredToolMs) {
    return `Measured tool work occupies ${measuredToolMs} ms. The remaining interval is unclassified and may include model execution, scheduling, and log gaps.`;
  }
  return 'No tool-duration records were available. This recorded interval cannot be labelled as model time from the log alone.';
}

function breakdownSource(activity: PendingActivity, duration: number | undefined): TimeBreakdown['source'] {
  if (activity.task?.durationMs !== undefined) return 'task_complete';
  return duration === undefined ? 'unavailable' : 'timestamps';
}

export function calculateBreakdown(activity: PendingActivity): TimeBreakdown {
  const duration = activity.task?.durationMs ?? timestampDelta(activity.startedAt, activity.completedAt);
  const intervals = activity.tools
    .flatMap((tool) => {
      const interval = toolInterval(tool);
      return interval ? [interval] : [];
    })
    .sort(([left], [right]) => left - right);
  const merged: Array<readonly [number, number]> = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) merged[merged.length - 1] = [last[0], Math.max(last[1], interval[1])];
    else merged.push(interval);
  }
  const measuredToolMs = merged.reduce((total, [start, end]) => total + end - start, 0);
  const otherElapsedMs = duration === undefined ? undefined : Math.max(0, duration - measuredToolMs);
  return {
    durationMs: duration,
    measuredToolMs,
    otherElapsedMs,
    source: breakdownSource(activity, duration),
    explanation: breakdownExplanation(duration, measuredToolMs),
  };
}

export function finalise(activity: PendingActivity, completedAt?: string): ReplyActivity {
  activity.completedAt ??= completedAt;
  activity.breakdown = calculateBreakdown(activity);
  return activity;
}

function modelFromTurnContext(payload: JsonRecord, timestamp?: string): ModelConfiguration | undefined {
  const name = text(payload.model);
  return name ? { name, source: 'turn_context', observedAt: timestamp } : undefined;
}

function modelFromSettings(payload: JsonRecord, timestamp?: string): ModelConfiguration | undefined {
  const settings = record(payload.thread_settings);
  const name = text(settings?.model);
  return name ? { name, provider: text(settings?.model_provider_id), source: 'thread_settings', observedAt: timestamp } : undefined;
}

function settingsFromTurnContext(payload: JsonRecord): TurnSettings | undefined {
  const sandbox = payload.sandbox_policy;
  const settings: TurnSettings = {
    effort: text(payload.effort),
    approvalPolicy: text(payload.approval_policy),
    sandbox: text(sandbox) ?? text(record(sandbox)?.type),
  };
  return settings.effort || settings.approvalPolicy || settings.sandbox ? settings : undefined;
}

function reasoningSummary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    const item = typeof part === 'string' ? part : text(record(part)?.text);
    return item?.trim() ? [item.trim()] : [];
  });
  return parts.length ? parts.join('\n\n') : undefined;
}

function errorText(value: unknown): string | undefined {
  return text(value) ?? text(record(value)?.message);
}

export function activityHasData(activity: PendingActivity): boolean {
  return activity.modelRequests.length > 0 || activity.tools.length > 0 || activity.edits.length > 0;
}

function isInternalReviewMessage(value: string): boolean {
  const message = value.trimStart();
  // ponytail: prefix match covers current guardian prompts; use structured provenance if Codex logs it later.
  return message.startsWith('The following is the Codex agent history ') && (
    message.includes('request action you are assessing') ||
    message.includes('added since your last approval assessment')
  );
}

interface RecordContext {
  format: TranscriptFormat;
  timestamp?: string;
  type?: string;
  eventType?: string;
  payload: JsonRecord;
  provenance: SourceReference;
}

interface VisibleMessage {
  role: 'user' | 'assistant';
  text: string;
  phase?: string;
}

function asRole(value: unknown): 'user' | 'assistant' | undefined {
  return value === 'user' || value === 'assistant' ? value : undefined;
}

function completedItemMessage({ format, payload }: RecordContext): VisibleMessage | undefined {
  const item = record(payload.item);
  // Plan-mode turns end with a Plan item instead of an AgentMessage; the plan is the reply.
  const plan = text(item?.type) === 'Plan' ? text(item?.text) : undefined;
  if (plan) return { role: 'assistant', text: plan, phase: 'plan' };
  const canonical = format === 'canonical' ? canonicalMessage(payload) : undefined;
  return canonical && { ...canonical, phase: text(payload.phase) };
}

function eventMessage({ eventType, payload }: RecordContext): VisibleMessage | undefined {
  const message = text(payload.message);
  const role = eventType === 'user_message' ? 'user' : 'assistant';
  return message === undefined ? undefined : { role, text: message, phase: text(payload.phase) };
}

function responseMessage({ payload }: RecordContext): VisibleMessage | undefined {
  const role = asRole(payload.role);
  const content = messageText(payload.content);
  return role && content !== undefined ? { role, text: content, phase: text(payload.phase) } : undefined;
}

/** The user or assistant message a record carries, read the way the transcript's format records messages. */
function visibleMessage(ctx: RecordContext): VisibleMessage | undefined {
  const { format, type, eventType } = ctx;
  if (type === 'event_msg' && eventType === 'item_completed') return completedItemMessage(ctx);
  if (format === 'event' && type === 'event_msg' && (eventType === 'user_message' || eventType === 'agent_message')) return eventMessage(ctx);
  if (format === 'response' && type === 'response_item' && eventType === 'message') return responseMessage(ctx);
  return undefined;
}

/** Reasoning summaries appear both as item_completed and response_item records. */
function reasoningRecord({ type, eventType, payload }: RecordContext): { id?: string; summary?: string } | undefined {
  if (type === 'response_item' && eventType === 'reasoning') return { id: text(payload.id), summary: reasoningSummary(payload.summary) };
  const item = eventType === 'item_completed' ? record(payload.item) : undefined;
  if (text(item?.type) === 'Reasoning') return { id: text(item?.id), summary: reasoningSummary(item?.summary_text) };
  return undefined;
}

class CodexDetailReader {
  readonly conversation: ConversationEntry[] = [];
  readonly hiddenMessages: DebugMessage[] = [];
  readonly unattachedActivities: ReplyActivity[] = [];
  readonly snapshots: UsageSnapshot[] = [];
  readonly modelStepTotal = emptyUsage();
  modelRequestIndex = 0;
  private readonly toolIndex = new Map<string, ToolCallDetail>();
  private readonly seenReasoning = new Set<string>();
  private currentModel: ModelConfiguration = { source: 'unavailable' };
  private currentSettings: TurnSettings | undefined;
  private pending: PendingActivity;
  private lastAssistant: ConversationEntry | undefined;
  private activeTask: TaskTiming | undefined;

  private readonly handlers: Record<string, (ctx: RecordContext) => void> = {
    'event_msg.task_started': (ctx) => this.taskStarted(ctx),
    'event_msg.token_count': (ctx) => this.tokenCount(ctx),
    'event_msg.exec_command_end': (ctx) => this.commandEnd(ctx),
    'event_msg.mcp_tool_call_end': (ctx) => this.commandEnd(ctx),
    'event_msg.patch_apply_end': (ctx) => this.patchEnd(ctx),
    'event_msg.sub_agent_activity': (ctx) => this.subagentActivity(ctx),
    'event_msg.task_complete': (ctx) => this.taskEnd(ctx),
    'event_msg.turn_aborted': (ctx) => this.taskEnd(ctx),
    'event_msg.item_completed': (ctx) => this.reasoning(ctx),
    'response_item.reasoning': (ctx) => this.reasoning(ctx),
    'response_item.message': (ctx) => this.hiddenMessage(ctx),
    'response_item.function_call': (ctx) => this.toolCall(ctx),
    'response_item.custom_tool_call': (ctx) => this.toolCall(ctx),
    'response_item.function_call_output': (ctx) => this.toolOutput(ctx),
    'response_item.custom_tool_call_output': (ctx) => this.toolOutput(ctx),
  };

  constructor(startedAt?: string) {
    this.pending = newActivity(startedAt, this.currentModel);
  }

  read(ctx: RecordContext): void {
    this.observeSettings(ctx);
    const message = visibleMessage(ctx);
    if (message) this.addMessage(ctx, message);
    else this.handlers[`${ctx.type}.${ctx.eventType}`]?.(ctx);
  }

  finish(): void {
    if (activityHasData(this.pending)) this.unattachedActivities.push(finalise(this.pending));
  }

  private callId(ctx: RecordContext): string {
    return text(ctx.payload.call_id) ?? `${ctx.provenance.file}:${ctx.provenance.line}`;
  }

  private observeSettings({ type, eventType, payload, timestamp }: RecordContext): void {
    if (type === 'turn_context') {
      this.currentModel = modelFromTurnContext(payload, timestamp) ?? this.currentModel;
      this.currentSettings = settingsFromTurnContext(payload) ?? this.currentSettings;
    }
    if (type === 'event_msg' && eventType === 'thread_settings_applied') {
      this.currentModel = modelFromSettings(payload, timestamp) ?? this.currentModel;
    }
  }

  private addMessage(ctx: RecordContext, message: VisibleMessage): void {
    const { timestamp, provenance } = ctx;
    if (message.role === 'user') {
      if (activityHasData(this.pending)) this.unattachedActivities.push(finalise(this.pending));
      this.pending = newActivity(timestamp, this.currentModel);
    }
    const entry: ConversationEntry = {
      id: `${provenance.file}:${provenance.line}`,
      role: message.role,
      kind: message.role === 'user' && isInternalReviewMessage(message.text) ? 'internal_review' : 'conversation',
      timestamp,
      text: message.text,
      phase: message.phase,
      source: provenance,
    };
    if (message.role === 'assistant') {
      this.pending.model = this.currentModel;
      this.pending.settings = this.currentSettings;
      entry.activity = finalise(this.pending, timestamp);
      this.lastAssistant = entry;
      this.pending = newActivity(timestamp, this.currentModel);
    }
    this.conversation.push(entry);
  }

  private hiddenMessage({ payload, timestamp, provenance }: RecordContext): void {
    const role = text(payload.role);
    const content = messageText(payload.content);
    if (content && role && !asRole(role)) {
      this.hiddenMessages.push({ id: `${provenance.file}:${provenance.line}`, role, timestamp, text: content, source: provenance });
    }
  }

  private reasoning(ctx: RecordContext): void {
    const reasoning = reasoningRecord(ctx);
    if (!reasoning?.summary || (reasoning.id && this.seenReasoning.has(reasoning.id))) return;
    if (reasoning.id) this.seenReasoning.add(reasoning.id);
    // Successive reasoning items often restate the same headline; keep each distinct line once per turn.
    this.pending.reasoning ??= [];
    if (!this.pending.reasoning.includes(reasoning.summary)) this.pending.reasoning.push(reasoning.summary);
  }

  private taskStarted({ payload, timestamp }: RecordContext): void {
    this.activeTask = { id: text(payload.turn_id), startedAt: timestamp, status: 'open' };
    this.pending.task = this.activeTask;
  }

  private toolCall(ctx: RecordContext): void {
    const { payload, eventType, timestamp, provenance } = ctx;
    const custom = eventType === 'custom_tool_call';
    const name = text(payload.name) ?? 'tool call';
    toolFor(this.pending, this.toolIndex, this.callId(ctx), {
      name,
      kind: toolKind(name, custom ? 'custom' : 'function'),
      startedAt: timestamp,
      input: compactJson(custom ? payload.input : payload.arguments),
      status: text(payload.status),
      source: provenance,
    });
  }

  private toolOutput(ctx: RecordContext): void {
    const tool = toolFor(this.pending, this.toolIndex, this.callId(ctx), { name: 'tool call', kind: 'unknown', source: ctx.provenance });
    tool.completedAt = ctx.timestamp;
    tool.output = compactJson(ctx.payload.output);
    tool.durationMs ??= timestampDelta(tool.startedAt, tool.completedAt);
  }

  private tokenCount({ payload, timestamp, provenance }: RecordContext): void {
    const info = record(payload.info);
    const last = usage(info?.last_token_usage);
    const total = usage(info?.total_token_usage);
    const contextWindow = number(info?.model_context_window);
    if (total) {
      this.snapshots.push({ id: `snapshot-${this.snapshots.length + 1}`, timestamp, usage: total, modelContextWindow: contextWindow, source: provenance, evidence: 'reported_snapshot' });
    }
    if (!last) return;
    const request: ModelRequestDetail = {
      id: `model-${++this.modelRequestIndex}`,
      timestamp,
      usage: last,
      totalUsage: total,
      evidence: 'reported_snapshot',
      source: provenance,
    };
    this.pending.modelRequests.push(request);
    addUsage(this.modelStepTotal, last);
  }

  private commandEnd(ctx: RecordContext): void {
    const { payload, timestamp, provenance } = ctx;
    const mcp = ctx.eventType === 'mcp_tool_call_end';
    const invocation = record(payload.invocation);
    const tool = toolFor(this.pending, this.toolIndex, this.callId(ctx), {
      name: mcp ? `${text(invocation?.server) ?? 'mcp'}.${text(invocation?.tool) ?? 'tool'}` : 'exec_command',
      kind: mcp ? 'mcp' : 'exec',
      input: compactJson(mcp ? invocation?.arguments : payload.command),
      completedAt: timestamp,
      durationMs: durationMs(payload.duration),
      status: text(payload.status) ?? (mcp ? undefined : String(payload.exit_code ?? 'completed')),
      output: compactJson(mcp ? payload.result : payload.aggregated_output),
      source: provenance,
    });
    tool.durationMs ??= timestampDelta(tool.startedAt, tool.completedAt);
  }

  private patchEnd(ctx: RecordContext): void {
    const { payload, timestamp, provenance } = ctx;
    const id = this.callId(ctx);
    const tool = toolFor(this.pending, this.toolIndex, id, {
      name: 'apply_patch',
      kind: 'patch',
      completedAt: timestamp,
      status: text(payload.status) ?? (payload.success === true ? 'completed' : undefined),
      output: compactJson(payload.stdout),
      source: provenance,
    });
    tool.durationMs ??= timestampDelta(tool.startedAt, tool.completedAt);
    this.pending.edits.push({ id, timestamp, status: text(payload.status), files: editFiles(payload.changes), source: provenance });
  }

  private subagentActivity(ctx: RecordContext): void {
    const { payload, timestamp, provenance } = ctx;
    const subagentId = text(payload.agent_thread_id) ?? this.callId(ctx);
    const tool = toolFor(this.pending, this.toolIndex, subagentId, {
      name: text(payload.name) ?? `subagent:${subagentId.slice(0, 8)}`,
      kind: 'subagent',
      input: compactJson(payload.input ?? payload.prompt ?? { agent_thread_id: subagentId }),
      output: compactJson(payload.output ?? payload.result ?? payload.summary),
      status: text(payload.status) ?? 'completed',
      completedAt: timestamp,
      durationMs: durationMs(payload.duration) ?? number(payload.duration_ms),
      source: provenance,
    });
    tool.durationMs ??= timestampDelta(tool.startedAt, tool.completedAt);
  }

  private taskEnd({ payload, eventType, timestamp }: RecordContext): void {
    const task = this.activeTask ?? { id: text(payload.turn_id), startedAt: undefined, status: 'open' as const };
    task.completedAt = timestamp ?? text(payload.completed_at);
    task.durationMs = number(payload.duration_ms);
    task.timeToFirstTokenMs = number(payload.time_to_first_token_ms);
    task.status = eventType === 'task_complete' ? 'completed' : 'aborted';
    task.error = errorText(payload.error);
    task.abortReason = text(payload.reason);
    const activity = this.lastAssistant?.activity;
    if (activity) {
      activity.task = task;
      activity.breakdown = calculateBreakdown(activity);
    } else this.pending.task = task;
    this.activeTask = undefined;
  }
}

export async function readCodexSessionDetail(session: SessionInventory): Promise<SessionDetail> {
  const reader = new CodexDetailReader(session.startedAt);
  for (const file of session.sourceFiles) {
    const format = await transcriptFormat(file);
    const input = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    let line = 0;
    for await (const raw of input) {
      line += 1;
      const source = parseLine(raw);
      if (!source) continue;
      const payload = record(source.payload) ?? {};
      reader.read({
        format,
        timestamp: text(source.timestamp),
        type: text(source.type),
        eventType: text(payload.type),
        payload,
        provenance: { file, line },
      });
    }
  }
  reader.finish();

  const sessionUsage: SessionUsage = {
    latest: reader.snapshots.at(-1),
    snapshots: reader.snapshots,
    modelStepTotal: reader.modelStepTotal,
    modelStepCount: reader.modelRequestIndex,
    evidence: 'reported_snapshot',
  };
  return {
    ...session,
    conversation: reader.conversation,
    usage: sessionUsage,
    debug: {
      hiddenMessages: reader.hiddenMessages,
      unattachedActivities: reader.unattachedActivities,
      malformedRecords: session.malformedRecords,
      unknownRecords: session.unknownRecords,
    },
  };
}
