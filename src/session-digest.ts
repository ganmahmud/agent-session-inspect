import type { ClaudeSessionView } from './claude-view.ts';

// A compact plain-text rendering of a Claude Code session, small enough to hand to a model as context:
// every user message, Claude's notes and answers, and one line per tool call (with failures and edits).

const DEFAULT_LIMIT = 120_000;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)} …[${trimmed.length - limit} more characters]` : trimmed;
}

function usd(value?: number): string {
  return value === undefined ? 'not recorded' : `$${value.toFixed(2)}`;
}

function duration(ms?: number): string {
  if (ms === undefined) return 'unknown';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function turnHeading(turn: ClaudeSessionView['turns'][number], message: number): string {
  if (!turn.prompt) return '\n## Before the first message';
  const interrupted = turn.status === 'interrupted' ? ', interrupted' : '';
  return `\n## User message ${message} (${turn.prompt.timestamp ?? 'unknown time'}; Claude worked ${duration(turn.durationMs)}, cost ${usd(turn.costUsd)}${interrupted})`;
}

function toolLine(step: Extract<ClaudeSessionView['turns'][number]['steps'][number], { kind: 'tool' }>): string {
  const lines = step.linesAdded || step.linesRemoved ? ` (+${step.linesAdded ?? 0} −${step.linesRemoved ?? 0})` : '';
  const failed = step.status === 'error' ? ` [FAILED: ${clip((step.output ?? '').split('\n')[0] ?? '', 160)}]` : '';
  return `- ${step.label}${lines}${failed}`;
}

/** Splits a turn's steps into the working (notes and tool calls) and the answer (notes after the last tool call). */
function splitSteps(turn: ClaudeSessionView['turns'][number], detail: 'full' | 'brief'): { work: string[]; answer: string[] } {
  const lastTool = turn.steps.findLastIndex((step) => step.kind === 'tool');
  const work: string[] = [];
  const answer: string[] = [];
  turn.steps.forEach((step, index) => {
    if (step.kind === 'text') (index > lastTool ? answer : work).push(`Note: ${clip(step.text, detail === 'full' ? 800 : 200)}`);
    if (step.kind === 'event') work.push(`Event: ${step.label}`);
    if (step.kind === 'tool') work.push(toolLine(step));
  });
  return { work, answer };
}

function renderTurns(view: ClaudeSessionView, detail: 'full' | 'brief'): string[] {
  const lines: string[] = [];
  const full = detail === 'full';
  let message = 0;
  for (const turn of view.turns) {
    if (turn.prompt) message += 1;
    lines.push(turnHeading(turn, message));
    if (turn.prompt) lines.push(clip(turn.prompt.text, full ? 4_000 : 800));
    const { work, answer } = splitSteps(turn, detail);
    if (work.length) {
      lines.push("### Claude's working");
      lines.push(...(full ? work : work.filter((line) => line.startsWith('Event') || line.includes('FAILED') || line.includes('(+')).slice(0, 15)));
    }
    if (answer.length) {
      lines.push("### Claude's answer");
      lines.push(...answer.map((line) => clip(line.replace(/^Note: /, ''), full ? 6_000 : 1_500)));
    }
  }
  return lines;
}

/** Plain-text digest of a session; falls back to a briefer form when the full one is over `limit` characters. */
export function sessionDigest(view: ClaudeSessionView, limit = DEFAULT_LIMIT): string {
  const header = [
    `# Claude Code session: ${view.title ?? 'Untitled'}`,
    `Project directory: ${view.cwd ?? 'unknown'}`,
    `Time: ${view.startedAt ?? '?'} to ${view.endedAt ?? '?'}`,
    `Total cost: ${usd(view.cost?.usd)}; models: ${view.models.map((model) => model.model).join(', ') || 'unknown'}`,
    `Files edited: ${view.files.filter((file) => file.edits).map((file) => file.path + ' (+' + file.linesAdded + ' −' + file.linesRemoved + ')').join(', ') || 'none'}`,
    view.insights.length ? `Findings: ${view.insights.map((insight) => insight.text).join(' | ')}` : '',
  ].filter(Boolean);
  const full = [...header, ...renderTurns(view, 'full')].join('\n');
  if (full.length <= limit) return full;
  const brief = [...header, '(Shortened: tool calls are summarised to failures, edits and events.)', ...renderTurns(view, 'brief')].join('\n');
  return brief.length <= limit ? brief : `${brief.slice(0, limit)}\n…[digest truncated]`;
}
