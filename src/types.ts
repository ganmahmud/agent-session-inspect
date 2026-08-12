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
