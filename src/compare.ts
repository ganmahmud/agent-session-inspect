import type { ClaudeSessionView, ToolCategory } from './claude-view.ts';

// Side-by-side numbers for two Claude Code sessions, e.g. the same task with a different model or prompt.

export interface SessionMetrics {
  id: string;
  title: string;
  startedAt?: string;
  models: string[];
  messages: number;
  workingMs: number;
  costUsd?: number;
  tokens: number;
  cacheHitPct: number;
  peakContext: number;
  steps: number;
  failed: number;
  stepsByKind: Record<ToolCategory, number>;
  linesAdded: number;
  linesRemoved: number;
  cacheResets: number;
  compactions: number;
  files: string[];
}

export function sessionMetrics(view: ClaudeSessionView): SessionMetrics {
  const tools = view.turns.flatMap((turn) => turn.steps.filter((step) => step.kind === 'tool'));
  const input = view.tokens.fresh + view.tokens.cacheWrite + view.tokens.cacheRead;
  const edited = view.files.filter((file) => file.edits > 0);
  return {
    id: view.id,
    title: view.title ?? 'Untitled session',
    startedAt: view.startedAt,
    models: view.models.filter((model) => model.requests > 0).map((model) => model.model),
    messages: view.turns.filter((turn) => turn.prompt).length,
    workingMs: view.turns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0),
    costUsd: view.cost?.usd,
    tokens: input + view.tokens.output,
    cacheHitPct: input ? Math.round((view.tokens.cacheRead / input) * 100) : 0,
    peakContext: view.peakContext,
    steps: tools.length,
    failed: tools.filter((step) => step.kind === 'tool' && step.status === 'error').length,
    stepsByKind: { ...view.toolCounts },
    linesAdded: edited.reduce((sum, file) => sum + file.linesAdded, 0),
    linesRemoved: edited.reduce((sum, file) => sum + file.linesRemoved, 0),
    cacheResets: view.cacheResets.length,
    compactions: view.compactions,
    files: edited.map((file) => file.path),
  };
}

export interface FileOverlap {
  both: string[];
  onlyA: string[];
  onlyB: string[];
}

export function fileOverlap(a: SessionMetrics, b: SessionMetrics): FileOverlap {
  const inB = new Set(b.files);
  const inA = new Set(a.files);
  return {
    both: a.files.filter((file) => inB.has(file)),
    onlyA: a.files.filter((file) => !inB.has(file)),
    onlyB: b.files.filter((file) => !inA.has(file)),
  };
}
