export type TitleSource = 'provider_catalog' | 'session_event' | 'absent';

export interface DisplayTitle {
  value: string | null;
  source: TitleSource;
  observedAt?: string;
}

export interface SourceReference {
  file: string;
  line: number;
}

export interface NormalizedEvent {
  kind: string;
  timestamp?: string;
  source: SourceReference;
  correlationId?: string;
  evidence: 'measured';
}

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface TokenSummary {
  total?: TokenUsage;
  last?: TokenUsage;
  modelContextWindow?: number;
  observations: number;
  missingUsageObservations: number;
}

export interface ToolSummary {
  calls: number;
  outputs: number;
  execCompleted: number;
  mcpCompleted: number;
}

export interface Relationship {
  type: 'parent' | 'fork' | 'subagent';
  sessionId: string;
}

export interface SessionInventory {
  id: string;
  displayTitle: DisplayTitle;
  sourceFiles: string[];
  startedAt?: string;
  updatedAt?: string;
  cwd?: string;
  provider?: string;
  cliVersions: string[];
  recordCount: number;
  malformedRecords: number;
  unknownRecords: number;
  eventCounts: Record<string, number>;
  token: TokenSummary;
  tools: ToolSummary;
  taskCount: number;
  completedTaskCount: number;
  abortedTaskCount: number;
  compactionCount: number;
  rollbackCount: number;
  relationships: Relationship[];
}

export interface ScanResult {
  schemaVersion: 1;
  provider: 'codex';
  sessions: SessionInventory[];
  diagnostics: {
    filesRead: number;
    malformedRecords: number;
    catalogErrors: string[];
  };
}

export interface CatalogTitle {
  sessionId: string;
  title: string;
  updatedAt?: number;
  rolloutPath?: string;
  source: 'provider_catalog';
}

export interface ToolCallDetail {
  id: string;
  name: string;
  kind: 'function' | 'custom' | 'exec' | 'mcp' | 'patch' | 'subagent' | 'unknown';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status?: string;
  input?: string;
  output?: string;
  source?: SourceReference;
}

export interface EditDetail {
  id: string;
  timestamp?: string;
  status?: string;
  files: Array<{ path: string; operation?: string; diff?: string }>;
  source?: SourceReference;
}

export interface ModelRequestDetail {
  id: string;
  timestamp?: string;
  usage: TokenUsage;
  totalUsage?: TokenUsage;
  cumulativeTokenDelta?: number;
  evidence: 'reported_snapshot';
  source: SourceReference;
}

export interface TimeBreakdown {
  durationMs?: number;
  measuredToolMs: number;
  otherElapsedMs?: number;
  source: 'task_complete' | 'timestamps' | 'unavailable';
  explanation: string;
}

export interface ModelConfiguration {
  name?: string;
  provider?: string;
  source: 'turn_context' | 'thread_settings' | 'unavailable';
  observedAt?: string;
}

export interface TaskTiming {
  id?: string;
  startedAt?: string;
  completedAt?: string;
  status: 'completed' | 'aborted' | 'open';
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

export interface ReplyActivity {
  association: 'source_order';
  startedAt?: string;
  completedAt?: string;
  model: ModelConfiguration;
  modelRequests: ModelRequestDetail[];
  tools: ToolCallDetail[];
  edits: EditDetail[];
  breakdown: TimeBreakdown;
  task?: TaskTiming;
}

export interface ConversationEntry {
  id: string;
  role: 'user' | 'assistant';
  kind: 'conversation' | 'internal_review';
  timestamp?: string;
  text: string;
  phase?: string;
  source: SourceReference;
  activity?: ReplyActivity;
}

export interface UsageSnapshot {
  id: string;
  timestamp?: string;
  usage: TokenUsage;
  modelContextWindow?: number;
  source: SourceReference;
  evidence: 'reported_snapshot';
}

export interface SessionUsage {
  latest?: UsageSnapshot;
  snapshots: UsageSnapshot[];
  modelStepTotal: TokenUsage;
  modelStepCount: number;
  evidence: 'reported_snapshot';
}

export interface DebugMessage {
  id: string;
  role: string;
  timestamp?: string;
  text: string;
  source: SourceReference;
}

export interface SessionDebug {
  hiddenMessages: DebugMessage[];
  unattachedActivities: ReplyActivity[];
  malformedRecords: number;
  unknownRecords: number;
}

export interface SessionDetail extends SessionInventory {
  conversation: ConversationEntry[];
  usage: SessionUsage;
  debug: SessionDebug;
}
