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
  UsageSnapshot,
} from './types.ts';

type JsonRecord = Record<string, unknown>;

interface PendingActivity extends ReplyActivity {
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

function compactJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const blocks = content.flatMap((block) => {
    const value = record(block);
    return value && typeof value.text === 'string' ? [value.text] : [];
  });
  return blocks.length ? blocks.join('\n\n') : undefined;
}

function timestampDelta(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const delta = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
}

function emptyUsage(): TokenUsage {
  return {};
}

function addUsage(total: TokenUsage, next: TokenUsage): void {
  for (const key of Object.keys(next) as Array<keyof TokenUsage>) {
    if (next[key] !== undefined) total[key] = (total[key] ?? 0) + next[key];
  }
}

function newActivity(startedAt?: string, model: ModelConfiguration = { source: 'unavailable' }): PendingActivity {
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
  return fallback;
}

function toolFor(activity: PendingActivity, tools: Map<string, ToolCallDetail>, id: string, partial: Partial<ToolCallDetail>): ToolCallDetail {
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
    return { path, operation: text(source?.type), diff: text(source?.unified_diff) };
  });
}

function calculateBreakdown(activity: PendingActivity): TimeBreakdown {
  const duration = activity.task?.durationMs ?? timestampDelta(activity.startedAt, activity.completedAt);
  const intervals = activity.tools
    .flatMap((tool) => {
      const toolDuration = tool.durationMs ?? timestampDelta(tool.startedAt, tool.completedAt);
      const end = tool.completedAt ? Date.parse(tool.completedAt) : undefined;
      const start = tool.startedAt ? Date.parse(tool.startedAt) : end !== undefined && toolDuration !== undefined ? end - toolDuration : undefined;
      return start !== undefined && end !== undefined && toolDuration !== undefined && end >= start ? [[start, end] as const] : [];
    })
    .sort(([left], [right]) => left - right);
  const merged: Array<readonly [number, number]> = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) merged[merged.length - 1] = [last[0], Math.max(last[1], interval[1])];
    else merged.push(interval);
  }
  const measuredToolMs = merged.reduce((total, [start, end]) => total + end - start, 0);
  const source: TimeBreakdown['source'] = activity.task?.durationMs !== undefined ? 'task_complete' : duration !== undefined ? 'timestamps' : 'unavailable';
  const otherElapsedMs = duration === undefined ? undefined : Math.max(0, duration - measuredToolMs);
  const explanation = duration === undefined
    ? 'No response completion interval was recorded; measured tool time is shown when available.'
    : measuredToolMs
      ? `Measured tool work occupies ${measuredToolMs} ms. The remaining interval is unclassified and may include model execution, scheduling, and log gaps.`
      : 'No tool-duration records were available. This recorded interval cannot be labelled as model time from the log alone.';
  return { durationMs: duration, measuredToolMs, otherElapsedMs, source, explanation };
}

function finalise(activity: PendingActivity, completedAt?: string): ReplyActivity {
  activity.completedAt ??= completedAt;
  activity.breakdown = calculateBreakdown(activity);
  return activity;
}

async function hasCompleteChatSurface(session: SessionInventory): Promise<boolean> {
  let user = false;
  let assistant = false;
  for (const file of session.sourceFiles) {
    const input = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const raw of input) {
      try {
        const source = record(JSON.parse(raw));
        const payload = record(source?.payload);
        if (text(source?.type) !== 'event_msg') continue;
        user ||= text(payload?.type) === 'user_message';
        assistant ||= text(payload?.type) === 'agent_message';
        if (user && assistant) return true;
      } catch {
        // A malformed line must not stop the read-only fallback check.
      }
    }
  }
  return false;
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

function activityHasData(activity: PendingActivity): boolean {
  return activity.modelRequests.length > 0 || activity.tools.length > 0 || activity.edits.length > 0;
}

export async function readCodexSessionDetail(session: SessionInventory): Promise<SessionDetail> {
  const useChatSurface = await hasCompleteChatSurface(session);
  const conversation: ConversationEntry[] = [];
  const hiddenMessages: DebugMessage[] = [];
  const unattachedActivities: ReplyActivity[] = [];
  const snapshots: UsageSnapshot[] = [];
  const modelStepTotal = emptyUsage();
  const toolIndex = new Map<string, ToolCallDetail>();
  let modelRequestIndex = 0;
  let currentModel: ModelConfiguration = { source: 'unavailable' };
  let pending = newActivity(session.startedAt, currentModel);
  let lastAssistant: ConversationEntry | undefined;
  let activeTask: TaskTiming | undefined;

  const discardPending = () => {
    if (activityHasData(pending)) unattachedActivities.push(finalise(pending));
  };

  const startPending = (timestamp?: string) => {
    pending = newActivity(timestamp, currentModel);
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
      const timestamp = text(source.timestamp);
      const type = text(source.type);
      const payload = record(source.payload) ?? {};
      const eventType = text(payload.type);
      const provenance: SourceReference = { file, line };

      if (type === 'turn_context') currentModel = modelFromTurnContext(payload, timestamp) ?? currentModel;
      if (type === 'event_msg' && eventType === 'thread_settings_applied') currentModel = modelFromSettings(payload, timestamp) ?? currentModel;

      const eventMessageRole = type === 'event_msg' && (eventType === 'user_message' || eventType === 'agent_message')
        ? eventType === 'user_message' ? 'user' as const : 'assistant' as const
        : undefined;
      const fallbackRole = !useChatSurface && type === 'response_item' && eventType === 'message'
        ? text(payload.role) === 'user' || text(payload.role) === 'assistant' ? text(payload.role) as 'user' | 'assistant' : undefined
        : undefined;
      const role = eventMessageRole ?? fallbackRole;
      const visibleText = eventMessageRole ? text(payload.message) : fallbackRole ? messageText(payload.content) : undefined;
      if (role && visibleText !== undefined) {
        if (role === 'user') {
          discardPending();
          startPending(timestamp);
        }
        const entry: ConversationEntry = { id: `${file}:${line}`, role, timestamp, text: visibleText, phase: text(payload.phase), source: provenance };
        if (role === 'assistant') {
          pending.model = currentModel;
          entry.activity = finalise(pending, timestamp);
          lastAssistant = entry;
          startPending(timestamp);
        }
        conversation.push(entry);
        continue;
      }

      if (type === 'response_item' && eventType === 'message') {
        const role = text(payload.role);
        const content = messageText(payload.content);
        if (content && role && role !== 'user' && role !== 'assistant') hiddenMessages.push({ id: `${file}:${line}`, role, timestamp, text: content, source: provenance });
      }

      if (type === 'event_msg' && eventType === 'task_started') {
        activeTask = { id: text(payload.turn_id), startedAt: timestamp, status: 'open' };
        pending.task = activeTask;
      }

      if (type === 'response_item' && (eventType === 'function_call' || eventType === 'custom_tool_call')) {
        const id = text(payload.call_id) ?? `${file}:${line}`;
        const name = text(payload.name) ?? 'tool call';
        toolFor(pending, toolIndex, id, {
          name,
          kind: toolKind(name, eventType === 'custom_tool_call' ? 'custom' : 'function'),
          startedAt: timestamp,
          input: compactJson(eventType === 'custom_tool_call' ? payload.input : payload.arguments),
          status: text(payload.status),
          source: provenance,
        });
      }

      if (type === 'response_item' && (eventType === 'function_call_output' || eventType === 'custom_tool_call_output')) {
        const id = text(payload.call_id) ?? `${file}:${line}`;
        const tool = toolFor(pending, toolIndex, id, { name: 'tool call', kind: 'unknown', source: provenance });
        tool.completedAt = timestamp;
        tool.output = compactJson(payload.output);
        tool.durationMs ??= timestampDelta(tool.startedAt, tool.completedAt);
      }

      if (type === 'event_msg' && eventType === 'token_count') {
        const info = record(payload.info);
        const last = usage(info?.last_token_usage);
        const total = usage(info?.total_token_usage);
        const contextWindow = number(info?.model_context_window);
        if (total) snapshots.push({ id: `snapshot-${snapshots.length + 1}`, timestamp, usage: total, modelContextWindow: contextWindow, source: provenance, evidence: 'reported_snapshot' });
        if (last) {
          const request: ModelRequestDetail = {
            id: `model-${++modelRequestIndex}`,
            timestamp,
            usage: last,
            totalUsage: total,
            evidence: 'reported_snapshot',
            source: provenance,
          };
          pending.modelRequests.push(request);
          addUsage(modelStepTotal, last);
        }
      }

      if (type === 'event_msg' && (eventType === 'exec_command_end' || eventType === 'mcp_tool_call_end')) {
        const id = text(payload.call_id) ?? `${file}:${line}`;
        const invocation = record(payload.invocation);
        const name = eventType === 'mcp_tool_call_end' ? `${text(invocation?.server) ?? 'mcp'}.${text(invocation?.tool) ?? 'tool'}` : 'exec_command';
        const tool = toolFor(pending, toolIndex, id, {
          name,
          kind: eventType === 'mcp_tool_call_end' ? 'mcp' : 'exec',
          input: compactJson(eventType === 'mcp_tool_call_end' ? invocation?.arguments : payload.command),
          completedAt: timestamp,
          durationMs: durationMs(payload.duration),
          status: text(payload.status) ?? (eventType === 'mcp_tool_call_end' ? undefined : String(payload.exit_code ?? 'completed')),
          output: compactJson(eventType === 'mcp_tool_call_end' ? payload.result : payload.aggregated_output),
          source: provenance,
        });
        tool.durationMs ??= timestampDelta(tool.startedAt, tool.completedAt);
      }

      if (type === 'event_msg' && eventType === 'patch_apply_end') {
        const id = text(payload.call_id) ?? `${file}:${line}`;
        const tool = toolFor(pending, toolIndex, id, {
          name: 'apply_patch',
          kind: 'patch',
          completedAt: timestamp,
          status: text(payload.status) ?? (payload.success === true ? 'completed' : undefined),
          output: compactJson(payload.stdout),
          source: provenance,
        });
        tool.durationMs ??= timestampDelta(tool.startedAt, tool.completedAt);
        pending.edits.push({ id, timestamp, status: text(payload.status), files: editFiles(payload.changes), source: provenance });
      }

      if (type === 'event_msg' && (eventType === 'task_complete' || eventType === 'turn_aborted')) {
        const task = activeTask ?? { id: text(payload.turn_id), startedAt: undefined, status: 'open' as const };
        task.completedAt = timestamp ?? text(payload.completed_at);
        task.durationMs = number(payload.duration_ms);
        task.timeToFirstTokenMs = number(payload.time_to_first_token_ms);
        task.status = eventType === 'task_complete' ? 'completed' : 'aborted';
        if (lastAssistant?.activity) {
          lastAssistant.activity.task = task;
          lastAssistant.activity.breakdown = calculateBreakdown(lastAssistant.activity);
        } else pending.task = task;
        activeTask = undefined;
      }
    }
  }

  if (activityHasData(pending)) unattachedActivities.push(finalise(pending));
  const sessionUsage: SessionUsage = {
    latest: snapshots.at(-1),
    snapshots,
    modelStepTotal,
    modelStepCount: modelRequestIndex,
    evidence: 'reported_snapshot',
  };
  return {
    ...session,
    conversation,
    usage: sessionUsage,
    debug: { hiddenMessages, unattachedActivities, malformedRecords: session.malformedRecords, unknownRecords: session.unknownRecords },
  };
}
