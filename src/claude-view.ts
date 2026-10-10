import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { relative, isAbsolute } from 'node:path';
import {
  blockText,
  claudeSessionKey,
  contentBlocks,
  isInterruption,
  promptTitle,
  toolResultText,
  unifiedDiff,
  userPrompt,
  type JsonRecord,
} from './claude.ts';
import { compactJson, timestampDelta } from './detail.ts';
import type { ConversationEntry, SessionDetail, SessionInventory, ToolCallDetail } from './types.ts';

// A Claude Code–specific reading of one transcript: turns as chronological steps (text, thinking, tool calls,
// events) plus the session environment Claude Code records (cost, models, hooks, CLAUDE.md files, MCP servers…).

const PREVIEW_LIMIT = 20_000;

export type ToolCategory = 'read' | 'edit' | 'shell' | 'web' | 'agent' | 'mcp' | 'other';

/** What a tool call did, in the words used to summarise a run of calls ("Ran 3 commands, read 2 files"). */
export type ToolVerb = 'command' | 'read' | 'search' | 'edit' | 'web' | 'agent' | 'tool';

/** Where an image sits in the transcript; the dashboard fetches the bytes on demand. */
export interface ClaudeImageRef {
  file: number;
  line: number;
  index: number;
  mediaType: string;
  /** Inline `data:` URL, set on exported and imported copies that no longer have the transcript. */
  src?: string;
}

export interface ClaudeTokens {
  fresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
  requests: number;
}

export interface ClaudeTextStep {
  kind: 'text';
  id: string;
  timestamp?: string;
  text: string;
  /** Share of the session cost spent producing this step; see `allocateCost`. */
  costUsd?: number;
}

export interface ClaudeThinkingStep {
  kind: 'thinking';
  id: string;
  timestamp?: string;
  text?: string;
  tokens?: number;
  costUsd?: number;
}

export interface ClaudeToolStep {
  kind: 'tool';
  id: string;
  name: string;
  category: ToolCategory;
  /** The one argument that identifies the call: a path, command, pattern, URL… */
  summary?: string;
  description?: string;
  /** Plain-language description of the call, e.g. "Read src/app.ts" or Bash's own description. */
  label: string;
  verb: ToolVerb;
  /** MCP server name for `mcp__server__tool` calls. */
  server?: string;
  images: ClaudeImageRef[];
  /** A page the call opened or served, shown as a link card. */
  link?: { title: string; url: string };
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status: 'completed' | 'error' | 'pending';
  input?: string;
  output?: string;
  diff?: string;
  filePath?: string;
  linesAdded?: number;
  linesRemoved?: number;
  /** Child session id when a subagent transcript for this call exists. */
  subagentId?: string;
  /** Files a shell command changed, as Claude Code recorded them (`bashEditDiff`). */
  fileEdits?: Array<{ path: string; absolutePath: string; diff?: string; added: number; removed: number }>;
  costUsd?: number;
}

export interface ClaudeEventStep {
  kind: 'event';
  id: string;
  timestamp?: string;
  tone: 'info' | 'warn' | 'error';
  label: string;
  detail?: string;
}

export type ClaudeStep = ClaudeTextStep | ClaudeThinkingStep | ClaudeToolStep | ClaudeEventStep;

export interface ClaudeTurn {
  index: number;
  id: string;
  prompt?: { text: string; timestamp?: string; permissionMode?: string; source?: string; images: ClaudeImageRef[] };
  startedAt?: string;
  endedAt?: string;
  /** Claude Code's own `turn_duration` when recorded, else first-to-last timestamp. */
  durationMs?: number;
  durationSource: 'recorded' | 'timestamps' | 'unavailable';
  status: 'completed' | 'interrupted' | 'open';
  steps: ClaudeStep[];
  tokens: ClaudeTokens;
  peakContext: number;
  models: string[];
  toolCount: number;
  errorCount: number;
  costUsd?: number;
}

export interface ClaudeModelUsage {
  model: string;
  requests: number;
  costUsd?: number;
  input?: number;
  output?: number;
  thinking?: number;
  cacheRead?: number;
  cacheWrite?: number;
  webSearches?: number;
}

export interface ClaudeFileTouch {
  path: string;
  reads: number;
  edits: number;
  created: boolean;
  linesAdded: number;
  linesRemoved: number;
  firstStepId: string;
}

/** What a subagent's own transcript adds to its parent: rolled up so the parent shows the full cost of delegating. */
export interface ClaudeChildTotals {
  tokens: number;
  requests: number;
  steps: number;
  failed: number;
  durationMs?: number;
  costUsd?: number;
}

/** Totals of a subagent transcript, for its parent's subagent list. */
export function childTotals(child: ClaudeSessionView): ClaudeChildTotals {
  const tools = child.turns.flatMap((turn) => turn.steps.filter((step) => step.kind === 'tool'));
  const start = child.turns[0]?.startedAt;
  const end = child.turns.at(-1)?.endedAt;
  return {
    tokens: child.tokens.fresh + child.tokens.cacheWrite + child.tokens.cacheRead + child.tokens.output,
    requests: child.tokens.requests,
    steps: tools.length,
    failed: tools.filter((step) => step.kind === 'tool' && step.status === 'error').length,
    durationMs: start && end ? Date.parse(end) - Date.parse(start) : undefined,
    costUsd: child.cost?.usd,
  };
}

/** A point where the prompt cache had to be rebuilt instead of read, and what that cost. */
export interface ClaudeCacheReset {
  id: string;
  timestamp?: string;
  turnId: string;
  reason: 'expired' | 'model' | 'compaction' | 'other';
  /** Idle time before the call, for expired caches. */
  gapMs?: number;
  /** Cache lifetime the call was written with (5 minutes or 1 hour). */
  ttlMs: number;
  tokens: number;
  /** What re-caching cost beyond reading the same tokens from a warm cache; needs recorded cost. */
  extraUsd?: number;
  fromModel?: string;
  toModel?: string;
}

/** A short finding about where a session lost time or money, pointing at the step or message to look at. */
export interface ClaudeInsight {
  id: string;
  tone: 'warn' | 'info';
  text: string;
  /** Step to jump to (a tool call id), or a turn when the finding is about a whole message. */
  stepId?: string;
  turnId?: string;
  costUsd?: number;
}

export interface ClaudeSessionView {
  id: string;
  /** True for a copy loaded from an export file rather than read from a transcript on this machine. */
  imported?: boolean;
  title: string | null;
  cwd?: string;
  projectName?: string;
  startedAt?: string;
  endedAt?: string;
  versions: string[];
  entrypoints: string[];
  gitBranches: string[];
  permissionModes: string[];
  efforts: string[];
  remoteUrl?: string;
  /** Claude Code's running totals (`cost-state`); absent in older transcripts. */
  cost?: {
    usd: number;
    apiMs: number;
    toolMs: number;
    wallMs: number;
    linesAdded: number;
    linesRemoved: number;
    unknownModelCost: boolean;
    /** When this Claude Code process started counting; earlier calls were replayed from a resumed session. */
    startedAt?: string;
  };
  models: ClaudeModelUsage[];
  tokens: ClaudeTokens;
  peakContext: number;
  contextWindow: number;
  toolCounts: Record<ToolCategory, number>;
  toolNames: Array<{ name: string; category: ToolCategory; count: number; errors: number }>;
  files: ClaudeFileTouch[];
  /** CLAUDE.md and similar files loaded into context; `chars` is their size, so their token cost can be shown. */
  instructions: Array<{ path: string; type?: string; chars?: number }>;
  hooks: Array<{ name: string; event?: string; count: number; cancelled: number }>;
  skills: Array<{ name: string; count: number }>;
  /** `instructionChars` is the size of the instructions the server adds to every request. */
  mcpServers: Array<{ name: string; calls: number; connected: boolean; instructionChars?: number }>;
  /** Size of the skill list Claude Code puts in context. */
  skillListingChars?: number;
  slashCommands: Array<{ name: string; count: number }>;
  subagents: Array<{ id: string; stepId: string; type?: string; description?: string; sessionId?: string; totals?: ClaudeChildTotals }>;
  recaps: Array<{ timestamp?: string; text: string }>;
  /** Pull request URLs that appeared in tool output (e.g. from `gh pr create`). */
  pullRequests: string[];
  /** At most four findings worth a look, most costly first. */
  insights: ClaudeInsight[];
  /** Times the prompt cache went cold mid-session and the context had to be written to it again. */
  cacheResets: ClaudeCacheReset[];
  /** Context size at each API call, in order; drives the context chart. */
  contextSeries: Array<{ timestamp?: string; tokens: number; turnId: string }>;
  apiErrors: number;
  compactions: number;
  interruptions: number;
  turns: ClaudeTurn[];
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

function emptyTokens(): ClaudeTokens {
  return { fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, requests: 0 };
}

export function toolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'LSP'].includes(name)) return 'read';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return 'edit';
  if (['Bash', 'BashOutput', 'KillShell', 'KillBash', 'PowerShell', 'Monitor'].includes(name)) return 'shell';
  if (['WebFetch', 'WebSearch'].includes(name)) return 'web';
  if (['Task', 'Agent', 'SendMessage'].includes(name)) return 'agent';
  return 'other';
}

function clip(value: string | undefined, limit = PREVIEW_LIMIT): string | undefined {
  if (value === undefined) return undefined;
  return value.length > limit ? `${value.slice(0, limit)}\n\n… ${value.length - limit} more characters` : value;
}

function firstLine(value: string, limit = 160): string {
  const line = value.trim().split('\n')[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function toolSummary(name: string, input: JsonRecord, cwd?: string): string | undefined {
  const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
  if (path) return displayPath(path, cwd);
  const value =
    text(input.command) ??
    text(input.pattern) ??
    text(input.url) ??
    text(input.query) ??
    text(input.skill) ??
    text(input.description) ??
    text(input.prompt);
  if (value) return firstLine(value);
  if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const question = text(record(input.questions[0])?.question);
    return question && firstLine(question);
  }
  const firstString = Object.values(input).find((item): item is string => typeof item === 'string' && item.length > 0);
  return firstString && firstLine(firstString);
}

export function displayPath(path: string, cwd?: string): string {
  if (cwd && isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** Adds files a shell command changed to the step and the session's file list. */
function recordBashEdits(view: ClaudeSessionView, step: ClaudeToolStep, bashEdits: JsonRecord, cwd?: string): void {
  const edits: NonNullable<ClaudeToolStep['fileEdits']> = [];
  for (const file of Array.isArray(bashEdits.files) ? bashEdits.files : []) {
    const absolutePath = text(record(file)?.filePath);
    if (!absolutePath) continue;
    const patch = { filePath: absolutePath, structuredPatch: record(file)?.hunks };
    const stats = patchStats(patch);
    edits.push({ path: displayPath(absolutePath, cwd), absolutePath, diff: unifiedDiff(patch), added: stats.added, removed: stats.removed });
  }
  // Large changes are listed by name only.
  for (const absolutePath of Array.isArray(bashEdits.changedFiles) ? bashEdits.changedFiles : []) {
    if (typeof absolutePath !== 'string' || edits.some((edit) => edit.absolutePath === absolutePath)) continue;
    edits.push({ path: displayPath(absolutePath, cwd), absolutePath, added: 0, removed: 0 });
  }
  if (!edits.length) return;
  step.fileEdits = edits;
  step.linesAdded = edits.reduce((sum, edit) => sum + edit.added, 0);
  step.linesRemoved = edits.reduce((sum, edit) => sum + edit.removed, 0);
  for (const edit of edits) {
    const touch =
      view.files.find((item) => item.path === edit.path) ??
      (view.files.push({ path: edit.path, reads: 0, edits: 0, created: false, linesAdded: 0, linesRemoved: 0, firstStepId: step.id }), view.files.at(-1)!);
    touch.edits += 1;
    touch.linesAdded += edit.added;
    touch.linesRemoved += edit.removed;
  }
}

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Image blocks of a message in reading order, including those nested in tool results. */
export function imageBlocks(content: unknown): JsonRecord[] {
  const images: JsonRecord[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type === 'image') images.push(block);
    if (block.type === 'tool_result') images.push(...contentBlocks(block.content).filter((item) => item.type === 'image'));
  }
  return images.filter((image) => MEDIA_TYPES.has(text(record(image.source)?.media_type) ?? ''));
}

function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function quoted(value: string | undefined, limit = 80): string {
  return value ? `"${firstLine(value, limit)}"` : '';
}

/** Plain-language label and summary verb for a tool call, mirroring how Claude Code describes its own work. */
export function describeTool(name: string, input: JsonRecord, cwd?: string): { label: string; verb: ToolVerb; server?: string } {
  const path = text(input.file_path) ?? text(input.notebook_path);
  const shown = path ? displayPath(path, cwd) : undefined;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { label: text(input.description) ?? `Ran ${firstLine(text(input.command) ?? 'a command', 100)}`, verb: 'command' };
    case 'BashOutput':
      return { label: 'Checked background command output', verb: 'command' };
    case 'KillShell':
    case 'KillBash':
      return { label: 'Stopped a background command', verb: 'command' };
    case 'Monitor':
      return { label: text(input.description) ?? 'Watched a command', verb: 'command' };
    case 'Read':
    case 'NotebookRead':
      return { label: `Read ${shown ?? 'a file'}`, verb: 'read' };
    case 'Write':
      return { label: `Wrote ${shown ?? 'a file'}`, verb: 'edit' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { label: `Edited ${shown ?? 'a file'}`, verb: 'edit' };
    case 'Grep':
    {
      const path = text(input.path);
      const where = path ? ' in ' + displayPath(path, cwd) : '';
      return { label: `Searched for ${quoted(text(input.pattern))}${where}`, verb: 'search' };
    }
    case 'Glob':
      return { label: `Found files matching ${text(input.pattern) ?? ''}`.trim(), verb: 'search' };
    case 'LS':
      return { label: `Listed ${displayPath(text(input.path) ?? '.', cwd)}`, verb: 'search' };
    case 'WebFetch':
      return { label: `Fetched ${text(input.url) ?? 'a page'}`, verb: 'web' };
    case 'WebSearch':
      return { label: `Searched the web for ${quoted(text(input.query))}`, verb: 'web' };
    case 'Task':
    case 'Agent':
      return { label: text(input.description) ?? 'Ran a subagent', verb: 'agent' };
    case 'SendMessage':
      return { label: 'Messaged a subagent', verb: 'agent' };
    case 'Skill':
      return { label: `Used the ${text(input.skill) ?? text(input.command) ?? ''} skill`.replace('  ', ' '), verb: 'tool' };
    case 'TodoWrite':
      return { label: 'Updated the to-do list', verb: 'tool' };
    case 'AskUserQuestion': {
      const question = text(record(Array.isArray(input.questions) ? input.questions[0] : undefined)?.question);
      return { label: question ? `Asked: ${firstLine(question, 100)}` : 'Asked you a question', verb: 'tool' };
    }
    case 'ToolSearch':
      return { label: 'Loaded tool definitions', verb: 'tool' };
    case 'ExitPlanMode':
      return { label: 'Presented a plan', verb: 'tool' };
  }
  if (name.startsWith('mcp__')) {
    const [, server = '', tool = name] = name.split('__');
    const detail = text(input.url) ?? text(input.query) ?? text(input.text) ?? text(input.name) ?? text(input.action);
    const suffix = detail ? ': ' + firstLine(detail, 80) : '';
    return { label: humanize(tool) + suffix, verb: 'tool', server: humanize(server) };
  }
  return { label: humanize(name), verb: 'tool' };
}

/** Link card for a dev-server preview the session started. */
function previewLink(name: string, output: string | undefined): { title: string; url: string } | undefined {
  if (!name.endsWith('preview_start') || !output) return undefined;
  // The tool prints JSON followed by prose, so read the fields rather than parsing the whole output.
  const port = /"port"\s*:\s*(\d+)/.exec(output)?.[1];
  const title = /"name"\s*:\s*"([^"]+)"/.exec(output)?.[1];
  return port ? { title: title ?? `localhost:${port}`, url: `http://localhost:${port}` } : undefined;
}

// Pull/merge request URLs on GitHub, GitLab and Azure DevOps (both hostnames).
const PR_HOSTS = [
  String.raw`github\.com/[\w.-]+/[\w.-]+/pull/\d+`,
  String.raw`gitlab\.com/[\w./-]+/-/merge_requests/\d+`,
  String.raw`[\w.-]+\.visualstudio\.com/[\w%./-]+/pullrequest/\d+`,
  String.raw`dev\.azure\.com/[\w%./-]+/pullrequest/\d+`,
];
const PR_PATTERN = new RegExp(String.raw`https://(?:${PR_HOSTS.join('|')})`, 'g');

interface RequestRecord {
  turn: ClaudeTurn;
  usage: JsonRecord;
  model?: string;
  timestamp?: string;
}

const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
/** Below this many re-cached tokens a cold cache is not worth pointing out. */
const MIN_RESET_TOKENS = 10_000;

/**
 * Finds API calls that wrote the conversation to the prompt cache again instead of reading it, and why:
 * an idle gap longer than the cache lifetime, a model switch (each model has its own cache) or a compaction.
 * The first call of a session is a normal cold start and is skipped.
 */
function contextTokens(usage: JsonRecord): number {
  return (number(usage.input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0) + (number(usage.cache_read_input_tokens) ?? 0);
}

function resetReason(prior: RequestRecord, current: RequestRecord, compactions: string[], ttlMs: number): ClaudeCacheReset['reason'] {
  if (current.model && prior.model && current.model !== prior.model) return 'model';
  if (compactions.some((stamp) => stamp > prior.timestamp! && stamp <= current.timestamp!)) return 'compaction';
  const gapMs = Date.parse(current.timestamp!) - Date.parse(prior.timestamp!);
  return gapMs > ttlMs ? 'expired' : 'other';
}

/** What re-writing the cache cost beyond reading it, as a share of the model's recorded cost. */
function resetExtraUsd(cacheWrite: number, oneHourCache: boolean, modelCost?: number, totalWeight?: number): number | undefined {
  if (!modelCost || !totalWeight) return undefined;
  const writeWeight = oneHourCache ? PRICE_WEIGHTS.cacheWrite1h : PRICE_WEIGHTS.cacheWrite5m;
  return (modelCost * cacheWrite * (writeWeight - PRICE_WEIGHTS.cacheRead)) / totalWeight;
}

/** Marks a cache reset in the conversation, just before the steps the call produced. */
function markReset(turn: ClaudeTurn, reset: ClaudeCacheReset, first: ClaudeStep | undefined): void {
  const found = first ? turn.steps.indexOf(first) : -1;
  const at = found < 0 ? turn.steps.length : found;
  turn.steps.splice(at, 0, { kind: 'event', id: reset.id, timestamp: reset.timestamp, tone: 'warn', label: cacheResetLabel(reset) });
}

/**
 * Finds API calls that wrote the conversation to the prompt cache again instead of reading it, and why:
 * an idle gap longer than the cache lifetime, a model switch (each model has its own cache) or a compaction.
 * The first call of a session is a normal cold start and is skipped.
 */
function detectCacheResets(view: ClaudeSessionView, requests: Map<string, RequestRecord>, stepsByRequest: Map<string, ClaudeStep[]>): void {
  const ordered = [...requests.entries()].filter(([, item]) => item.timestamp).sort(([, a], [, b]) => a.timestamp!.localeCompare(b.timestamp!));
  const compactions = view.turns.flatMap((turn) => turn.steps.filter((step): step is ClaudeEventStep => step.kind === 'event' && step.label === 'Context compacted').map((step) => step.timestamp ?? ''));
  const billed = billedRequests(view, requests);
  const modelWeight = modelWeights(billed);

  let previous: RequestRecord | undefined;
  for (const [requestKey, current] of ordered) {
    const usage = current.usage;
    const cacheWrite = number(usage.cache_creation_input_tokens) ?? 0;
    const cacheRead = number(usage.cache_read_input_tokens) ?? 0;
    view.contextSeries.push({ timestamp: current.timestamp, tokens: contextTokens(usage), turnId: current.turn.id });
    const prior = previous;
    previous = current;
    // A warm cache would have served most of the previous context; a reset re-writes it instead.
    if (!prior || cacheWrite < MIN_RESET_TOKENS || cacheRead >= contextTokens(prior.usage) * 0.5) continue;

    const oneHour = number(record(usage.cache_creation)?.ephemeral_1h_input_tokens) ?? 0;
    const ttlMs = oneHour > 0 ? ONE_HOUR : FIVE_MINUTES;
    const reason = resetReason(prior, current, compactions, ttlMs);
    const modelCost = billed.has(requestKey) ? view.models.find((item) => item.model === current.model)?.costUsd : undefined;
    const totalWeight = current.model ? modelWeight.get(current.model) : undefined;
    const extraUsd = resetExtraUsd(cacheWrite, oneHour > 0, modelCost, totalWeight);

    const reset: ClaudeCacheReset = {
      id: `cache-${requestKey}`,
      timestamp: current.timestamp,
      turnId: current.turn.id,
      reason,
      gapMs: reason === 'expired' ? Date.parse(current.timestamp!) - Date.parse(prior.timestamp!) : undefined,
      ttlMs,
      tokens: cacheWrite,
      extraUsd,
      fromModel: reason === 'model' ? prior.model : undefined,
      toModel: reason === 'model' ? current.model : undefined,
    };
    view.cacheResets.push(reset);
    markReset(current.turn, reset, stepsByRequest.get(requestKey)?.[0]);
  }
}

export function cacheResetLabel(reset: ClaudeCacheReset): string {
  const cost = reset.extraUsd ? ` (+${formatUsd(reset.extraUsd)})` : '';
  const tokens = `${Math.round(reset.tokens / 1000)}K tokens`;
  if (reset.reason === 'expired') return `Cache expired after a ${formatDuration(reset.gapMs ?? 0)} break: re-cached ${tokens}${cost}`;
  if (reset.reason === 'model') return `Switched model (${reset.fromModel} → ${reset.toModel}): re-cached ${tokens}${cost}`;
  if (reset.reason === 'compaction') return `Compaction reset the cache: re-cached ${tokens}${cost}`;
  return `Cache missed: re-cached ${tokens}${cost}`;
}

/**
 * Relative price of each token class against fresh input. These ratios hold across current Claude models
 * (cache read 0.1×, 5-minute cache write 1.25×, 1-hour cache write 2×, output 5×); they only weight the split,
 * so the parts always add up to the per-model cost Claude Code itself recorded.
 */
const PRICE_WEIGHTS = { fresh: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 };

function requestWeight(usage: JsonRecord): number {
  const cacheWrite = number(usage.cache_creation_input_tokens) ?? 0;
  const oneHour = number(record(usage.cache_creation)?.ephemeral_1h_input_tokens) ?? 0;
  return (
    (number(usage.input_tokens) ?? 0) * PRICE_WEIGHTS.fresh +
    (number(usage.cache_read_input_tokens) ?? 0) * PRICE_WEIGHTS.cacheRead +
    Math.max(0, cacheWrite - oneHour) * PRICE_WEIGHTS.cacheWrite5m +
    Math.min(oneHour, cacheWrite) * PRICE_WEIGHTS.cacheWrite1h +
    (number(usage.output_tokens) ?? 0) * PRICE_WEIGHTS.output
  );
}

/**
 * API calls the recorded cost covers. A resumed session replays the earlier transcript into its file, but its cost
 * record only counts calls made after this Claude Code process started, so replayed calls are left out.
 */
function modelWeights(requests: Map<string, RequestRecord>): Map<string, number> {
  const weights = new Map<string, number>();
  for (const { usage, model } of requests.values()) if (model) weights.set(model, (weights.get(model) ?? 0) + requestWeight(usage));
  return weights;
}

function billedRequests(view: ClaudeSessionView, requests: Map<string, RequestRecord>): Map<string, RequestRecord> {
  const start = view.cost?.startedAt;
  if (!start) return requests;
  return new Map([...requests].filter(([, item]) => !item.timestamp || item.timestamp >= start));
}

/** Splits each model's recorded cost across its API responses, then across the steps each response produced. */
function allocateCost(
  view: ClaudeSessionView,
  requests: Map<string, RequestRecord>,
  stepsByRequest: Map<string, ClaudeStep[]>,
): void {
  const billed = billedRequests(view, requests);
  const modelWeight = modelWeights(billed);
  for (const [requestKey, { turn, usage, model }] of billed) {
    const modelCost = view.models.find((item) => item.model === model)?.costUsd;
    const total = model ? modelWeight.get(model) : undefined;
    if (!modelCost || !total) continue;
    const cost = (modelCost * requestWeight(usage)) / total;
    turn.costUsd = (turn.costUsd ?? 0) + cost;
    const steps = stepsByRequest.get(requestKey) ?? [];
    for (const step of steps) if (step.kind !== 'event') step.costUsd = (step.costUsd ?? 0) + cost / steps.length;
  }
}

const formatUsd = (value: number) => (value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`);

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** First meaningful line of an error, with numbers and paths blurred so repeats of one problem group together. */
export function errorSignature(output: string | undefined): string {
  const line = (output ?? '').split('\n').map((item) => item.trim()).find((item) => item && !/^exit code \d+$/i.test(item)) ?? 'failed';
  const blurred = line.replace(/\/[^\s'"]+/g, '…').replace(/\d+/g, '#');
  if (blurred.length <= 90) return blurred;
  // Cut at the last word boundary so the signature does not end mid-word.
  const head = blurred.slice(0, 89);
  const space = head.search(/\s\S*$/);
  return (space < 0 ? head : head.slice(0, space).trimEnd()) + '…';
}

type WeightedInsight = ClaudeInsight & { weight: number };

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function failureInsights(tools: ClaudeToolStep[]): WeightedInsight[] {
  const failures = new Map<string, ClaudeToolStep[]>();
  for (const step of tools) {
    if (step.status !== 'error') continue;
    const name = step.server ? `${step.label.split(':')[0]} (${step.server})` : step.name;
    const key = `${name}\u0000${errorSignature(step.output)}`;
    failures.set(key, [...(failures.get(key) ?? []), step]);
  }
  return [...failures].flatMap(([key, steps]) => {
    if (steps.length < 2) return [];
    const cost = steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0);
    const [name, signature] = key.split('\u0000');
    const quote = /[a-z]{3}/i.test(signature) ? ': “' + signature + '”' : '';
    const spent = cost ? ' · ' + formatUsd(cost) : '';
    return [{
      id: `fail-${steps[0].id}`,
      tone: 'warn' as const,
      text: `${steps.length} ${name} calls failed the same way${quote}${spent}`,
      stepId: steps[0].id,
      costUsd: cost || undefined,
      weight: 3 + steps.length + cost * 10,
    }];
  });
}

function rerunInsights(tools: ClaudeToolStep[]): WeightedInsight[] {
  const commands = new Map<string, ClaudeToolStep[]>();
  for (const step of tools) {
    if (step.category !== 'shell') continue;
    // Compare whole commands: scripts passed via heredoc share a first line but differ in body.
    const command = text(record(safeParse(step.input))?.command)?.trim();
    if (command) commands.set(command, [...(commands.get(command) ?? []), step]);
  }
  return [...commands].flatMap(([command, steps]) =>
    steps.length < 3
      ? []
      : [{ id: `rerun-${steps[0].id}`, tone: 'info' as const, text: `Ran the same command ${steps.length} times: ${firstLine(command, 70)}`, stepId: steps[0].id, weight: 2 + steps.length / 2 }],
  );
}

// Questions and plan approvals wait on the user; that time is not slow work.
const WAITS_ON_USER = new Set(['AskUserQuestion', 'ExitPlanMode']);

function slowInsights(tools: ClaudeToolStep[]): WeightedInsight[] {
  const slowest = tools
    .filter((item) => (item.durationMs ?? 0) >= 60_000 && !WAITS_ON_USER.has(item.name))
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];
  if (!slowest) return [];
  return [{ id: `slow-${slowest.id}`, tone: 'info', text: `Slowest step took ${formatDuration(slowest.durationMs!)}: ${firstLine(slowest.label, 70)}`, stepId: slowest.id, weight: 2 + slowest.durationMs! / 120_000 }];
}

function spendInsights(view: ClaudeSessionView): WeightedInsight[] {
  const sessionCost = view.turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
  const prompts = view.turns.filter((turn) => turn.prompt);
  const paidPrompts = prompts.filter((turn) => (turn.costUsd ?? 0) > 0);
  const priciest = [...prompts].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))[0];
  if (!priciest?.costUsd || paidPrompts.length <= 1 || priciest.costUsd < sessionCost * 0.4) return [];
  const position = prompts.indexOf(priciest) + 1;
  return [{
    id: `spend-${priciest.id}`,
    tone: 'info',
    text: `User message ${position} cost ${formatUsd(priciest.costUsd)}, ${Math.round((priciest.costUsd / sessionCost) * 100)}% of the session`,
    turnId: priciest.id,
    costUsd: priciest.costUsd,
    weight: 2.5 + priciest.costUsd,
  }];
}

function cacheInsights(view: ClaudeSessionView): WeightedInsight[] {
  const found: WeightedInsight[] = [];
  const expired = view.cacheResets.filter((reset) => reset.reason === 'expired');
  if (expired.length) {
    const extra = expired.reduce((sum, reset) => sum + (reset.extraUsd ?? 0), 0);
    const ttl = expired[0].ttlMs === ONE_HOUR ? '1 hour' : '5 minutes';
    const breaks = plural(expired.length, 'a break', expired.length + ' breaks');
    const extraText = extra ? '; re-caching cost ' + formatUsd(extra) + ' extra' : '';
    found.push({ id: 'cache-expired', tone: 'warn', text: `Cache went cold after ${breaks} over ${ttl}${extraText}`, stepId: expired[0].id, costUsd: extra || undefined, weight: 3 + extra * 10 });
  }
  const otherResets = view.cacheResets.filter((reset) => reset.reason !== 'expired');
  if (otherResets.length) {
    const extra = otherResets.reduce((sum, reset) => sum + (reset.extraUsd ?? 0), 0);
    const times = plural(otherResets.length, 'once', otherResets.length + ' times');
    const extraText = extra ? ' (' + formatUsd(extra) + ' extra)' : '';
    found.push({ id: 'cache-other', tone: 'info', text: `Cache was rebuilt ${times} by model switches, compaction or cache misses${extraText}`, stepId: otherResets[0].id, weight: 1.8 + extra * 10 });
  }
  return found;
}

function contextInsights(view: ClaudeSessionView): WeightedInsight[] {
  const found: WeightedInsight[] = [];
  if (view.compactions) {
    const times = plural(view.compactions, 'once', view.compactions + ' times');
    found.push({ id: 'compactions', tone: 'info', text: `Context filled up and was compacted ${times}`, weight: 1.5 });
  }
  if (view.apiErrors) found.push({ id: 'api-errors', tone: 'warn', text: `${view.apiErrors} API ${plural(view.apiErrors, 'request', 'requests')} failed`, weight: 1.5 });
  return found;
}

/** Looks for the few things a reviewer would want pointed out: repeated failures, re-runs, slow steps, cost spikes. */
export function findInsights(view: ClaudeSessionView): ClaudeInsight[] {
  const tools = view.turns.flatMap((turn) => turn.steps.filter((step): step is ClaudeToolStep => step.kind === 'tool'));
  const found = [
    ...failureInsights(tools),
    ...rerunInsights(tools),
    ...slowInsights(tools),
    ...spendInsights(view),
    ...cacheInsights(view),
    ...contextInsights(view),
  ];
  return found
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map(({ weight: _weight, ...insight }) => insight);
}

function safeParse(value: string | undefined): unknown {
  try {
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

function hunkLines(hunk: unknown): string[] {
  const lines = record(hunk)?.lines;
  return Array.isArray(lines) ? lines.filter((line): line is string => typeof line === 'string') : [];
}

function patchStats(result: JsonRecord | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (!result) return { added, removed };
  const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
  for (const line of hunks.flatMap(hunkLines)) {
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  if (!hunks.length && result.type === 'create' && typeof result.content === 'string') added = result.content.split('\n').length;
  return { added, removed };
}

function commandName(content: string): string | undefined {
  return /<command-name>([^<]+)<\/command-name>/.exec(content)?.[1]?.trim();
}

function stripCommandOutput(content: string): string {
  return content.replace(/<\/?local-command-(stdout|stderr|caveat)>/g, '').trim();
}

function increment<T extends { count: number }>(list: T[], match: (item: T) => boolean, create: () => T): T {
  let item = list.find(match);
  if (!item) {
    item = create();
    list.push(item);
  }
  item.count += 1;
  return item;
}

function emptyView(session: SessionInventory): ClaudeSessionView {
  return {
    id: session.id,
    title: session.displayTitle.value,
    cwd: session.cwd,
    projectName: session.projectName,
    startedAt: session.startedAt,
    endedAt: session.updatedAt,
    versions: [],
    entrypoints: [],
    gitBranches: [],
    permissionModes: [],
    efforts: [],
    models: [],
    tokens: emptyTokens(),
    peakContext: 0,
    contextWindow: session.token.modelContextWindow ?? 200_000,
    toolCounts: { read: 0, edit: 0, shell: 0, web: 0, agent: 0, mcp: 0, other: 0 },
    toolNames: [],
    files: [],
    instructions: [],
    hooks: [],
    skills: [],
    mcpServers: [],
    slashCommands: [],
    subagents: [],
    recaps: [],
    pullRequests: [],
    insights: [],
    cacheResets: [],
    contextSeries: [],
    apiErrors: 0,
    compactions: 0,
    interruptions: 0,
    turns: [],
  };
}

function addUnique<T extends string>(list: T[], value: T | undefined): void {
  if (value && !list.includes(value)) list.push(value);
}

function parseLine(raw: string): JsonRecord | undefined {
  if (!raw.trim()) return undefined;
  try {
    return record(JSON.parse(raw)) ?? {};
  } catch {
    return undefined;
  }
}

/** One transcript record with where it came from. */
interface ViewRecord {
  source: JsonRecord;
  type?: string;
  uuid?: string;
  id: string;
  timestamp?: string;
  fileIndex: number;
  line: number;
  message?: JsonRecord;
  blocks: JsonRecord[];
}

interface ToolEntry {
  step: ClaudeToolStep;
  turn: ClaudeTurn;
  input: JsonRecord;
}

// Only trust PR links printed by commands that create or show one, not URLs quoted in file contents.
const PR_COMMAND = /\b(pr|mr)\s+(create|view)\b|\brepos\s+pr\b/;

/** Builds a Claude session view from transcript records, one record at a time. */
class ClaudeViewBuilder {
  readonly view: ClaudeSessionView;
  private readonly session: SessionInventory;
  private readonly cwd?: string;
  private readonly childIds: Set<string>;
  private readonly seen = new Set<string>();
  private readonly requests = new Map<string, RequestRecord>();
  private readonly tools = new Map<string, ToolEntry>();
  private readonly thinkingByRequest = new Map<string, ClaudeThinkingStep>();
  // Steps each API response produced, so its cost can be split across them.
  private readonly stepsByRequest = new Map<string, ClaudeStep[]>();
  private turn: ClaudeTurn | undefined;

  constructor(session: SessionInventory, childSessionIds: string[]) {
    this.session = session;
    this.cwd = session.cwd;
    this.childIds = new Set(childSessionIds);
    this.view = emptyView(session);
  }

  private produced(requestKey: string, step: ClaudeStep): void {
    this.stepsByRequest.set(requestKey, [...(this.stepsByRequest.get(requestKey) ?? []), step]);
  }

  private newTurn(id: string, timestamp?: string): ClaudeTurn {
    return {
      index: this.view.turns.length,
      id,
      startedAt: timestamp,
      endedAt: timestamp,
      durationSource: 'unavailable',
      status: 'open',
      steps: [],
      tokens: emptyTokens(),
      peakContext: 0,
      models: [],
      toolCount: 0,
      errorCount: 0,
    };
  }

  private current(id: string, timestamp?: string): ClaudeTurn {
    if (!this.turn) {
      // Activity before the first prompt (slash commands, hooks, resumed context) gets its own preamble turn.
      this.turn = this.newTurn(id, timestamp);
      this.view.turns.push(this.turn);
    }
    const turn = this.turn;
    if (timestamp) {
      if (!turn.startedAt || timestamp < turn.startedAt) turn.startedAt = timestamp;
      if (!turn.endedAt || timestamp > turn.endedAt) turn.endedAt = timestamp;
    }
    return turn;
  }

  private event(rec: ViewRecord, step: Omit<ClaudeEventStep, 'kind' | 'id' | 'timestamp'>): void {
    this.current(rec.id, rec.timestamp).steps.push({ kind: 'event', id: rec.id, timestamp: rec.timestamp, ...step });
  }

  private closeTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.status === 'open') turn.status = 'completed';
    if (turn.durationSource !== 'recorded') {
      turn.durationMs = timestampDelta(turn.startedAt, turn.endedAt);
      turn.durationSource = turn.durationMs === undefined ? 'unavailable' : 'timestamps';
    }
  }

  /** Whether a record belongs to this session's main thread, counting replayed records (same uuid) once. */
  private accepts(source: JsonRecord, type?: string, uuid?: string): boolean {
    if (type !== 'summary' && text(source.sessionId) && claudeSessionKey(source) !== this.session.id) return false;
    if (source.isSidechain === true && !text(source.agentId) && this.view.id === text(source.sessionId)) return false;
    if (!uuid) return true;
    if (this.seen.has(uuid)) return false;
    this.seen.add(uuid);
    return true;
  }

  read(source: JsonRecord, fileIndex: number, file: string, line: number): void {
    const type = text(source.type);
    const uuid = text(source.uuid);
    if (!this.accepts(source, type, uuid)) return;
    const view = this.view;
    addUnique(view.versions, text(source.version));
    addUnique(view.entrypoints, text(source.entrypoint));
    addUnique(view.gitBranches, text(source.gitBranch) === 'HEAD' ? undefined : text(source.gitBranch));
    addUnique(view.permissionModes, text(source.permissionMode));
    addUnique(view.efforts, text(source.effort));
    const message = record(source.message);
    const rec: ViewRecord = { source, type, uuid, id: `${file}:${line}`, timestamp: text(source.timestamp), fileIndex, line, message, blocks: contentBlocks(message?.content) };
    switch (type) {
      case 'cost-state':
        this.costState(source);
        break;
      case 'attachment':
        this.attachment(record(source.attachment));
        break;
      case 'system':
        this.system(rec);
        break;
      case 'assistant':
        this.assistant(rec);
        break;
      case 'user':
        this.user(rec);
        break;
    }
  }

  private costState(source: JsonRecord): void {
    const view = this.view;
    const startTime = number(source.startTime);
    view.cost = {
      usd: number(source.totalCostUSD) ?? 0,
      apiMs: number(source.totalAPIDuration) ?? 0,
      toolMs: number(source.totalToolDuration) ?? 0,
      wallMs: number(source.totalDuration) ?? 0,
      linesAdded: number(source.totalLinesAdded) ?? 0,
      linesRemoved: number(source.totalLinesRemoved) ?? 0,
      unknownModelCost: source.hasUnknownModelCost === true,
      startedAt: startTime ? new Date(startTime).toISOString() : undefined,
    };
    for (const [model, value] of Object.entries(record(source.modelUsage) ?? {})) {
      const usage = record(value);
      if (!usage) continue;
      Object.assign(this.modelEntry(model), {
        costUsd: number(usage.costUSD),
        input: number(usage.inputTokens),
        output: number(usage.outputTokens),
        thinking: number(usage.thinkingTokens),
        cacheRead: number(usage.cacheReadInputTokens),
        cacheWrite: number(usage.cacheCreationInputTokens),
        webSearches: number(usage.webSearchRequests),
      });
    }
  }

  private modelEntry(model: string): ClaudeModelUsage {
    const view = this.view;
    const entry = view.models.find((item) => item.model === model) ?? { model, requests: 0 };
    if (!view.models.includes(entry)) view.models.push(entry);
    return entry;
  }

  private attachment(attachment: JsonRecord | undefined): void {
    const kind = text(attachment?.type);
    if (!attachment || !kind) return;
    if (kind === 'instructions') this.instructionFiles(attachment);
    if (kind.startsWith('hook_')) this.hook(attachment, kind);
    if (kind === 'mcp_instructions_delta') this.mcpInstructions(attachment);
    if (kind === 'skill_listing') {
      const listing = text(attachment.content);
      if (listing) this.view.skillListingChars = Math.max(this.view.skillListingChars ?? 0, listing.length);
    }
  }

  private instructionFiles(attachment: JsonRecord): void {
    if (!Array.isArray(attachment.files)) return;
    for (const item of attachment.files) {
      const path = text(record(item)?.path);
      const content = text(record(item)?.content);
      if (path && !this.view.instructions.some((entry) => entry.path === path)) this.view.instructions.push({ path, type: text(record(item)?.type), chars: content?.length });
    }
  }

  private hook(attachment: JsonRecord, kind: string): void {
    const name = text(attachment.hookName) ?? 'hook';
    const hook = increment(this.view.hooks, (item) => item.name === name, () => ({ name, event: text(attachment.hookEvent), count: 0, cancelled: 0 }));
    if (kind === 'hook_cancelled') hook.cancelled += 1;
  }

  private mcpInstructions(attachment: JsonRecord): void {
    if (!Array.isArray(attachment.addedNames)) return;
    const blocks = Array.isArray(attachment.addedBlocks) ? attachment.addedBlocks : [];
    attachment.addedNames.forEach((name, index) => {
      if (typeof name !== 'string') return;
      const chars = typeof blocks[index] === 'string' ? (blocks[index] as string).length : undefined;
      const server = this.view.mcpServers.find((item) => item.name === name);
      if (server) {
        server.connected = true;
        server.instructionChars = chars ?? server.instructionChars;
      } else this.view.mcpServers.push({ name, calls: 0, connected: true, instructionChars: chars });
    });
  }

  private system(rec: ViewRecord): void {
    const { source, timestamp } = rec;
    const view = this.view;
    const subtype = text(source.subtype);
    const content = text(source.content);
    switch (subtype) {
      case 'turn_duration': {
        const target = this.current(rec.id, timestamp);
        const duration = number(source.durationMs);
        if (duration !== undefined) {
          target.durationMs = duration;
          target.durationSource = 'recorded';
        }
        return;
      }
      case 'bridge_status':
        view.remoteUrl = text(source.url) ?? view.remoteUrl;
        return;
      case 'away_summary':
        if (content) view.recaps.push({ timestamp, text: content });
        return;
      case 'local_command':
        if (content) this.localCommand(rec, content);
        return;
      case 'compact_boundary':
        view.compactions += 1;
        this.event(rec, { tone: 'warn', label: 'Context compacted', detail: content });
        return;
      case 'api_error':
        view.apiErrors += 1;
        this.event(rec, { tone: 'error', label: 'API request failed', detail: apiErrorDetail(source, content) });
        return;
      case 'informational':
        if (content) this.event(rec, { tone: 'info', label: firstLine(content, 120), detail: content.length > 120 ? content : undefined });
        return;
    }
  }

  private slashCommand(rec: ViewRecord, content: string, name: string): void {
    increment(this.view.slashCommands, (item) => item.name === name, () => ({ name, count: 0 }));
    this.event(rec, { tone: 'info', label: `Ran ${promptTitle(content) ?? name}` });
  }

  /** Attaches a command's printed output to the "Ran …" event just before it. */
  private commandOutput(content: string): void {
    const output = stripCommandOutput(content);
    const last = this.turn?.steps.at(-1);
    if (output && last?.kind === 'event' && last.label.startsWith('Ran ')) last.detail = clip(output);
  }

  private localCommand(rec: ViewRecord, content: string): void {
    const name = commandName(content);
    if (name) this.slashCommand(rec, content, name);
    else this.commandOutput(content);
  }

  private assistant(rec: ViewRecord): void {
    const { message, source, timestamp } = rec;
    const target = this.current(rec.id, timestamp);
    const model = text(message?.model);
    const requestKey = text(message?.id) ?? text(source.requestId) ?? rec.id;
    const usage = record(message?.usage);
    if (model && model !== '<synthetic>') addUnique(target.models, model);
    if (usage) {
      // Streamed blocks repeat the usage; keep the latest numbers but the response's first timestamp.
      const previous = this.requests.get(requestKey);
      this.requests.set(requestKey, { turn: target, usage, model: model === '<synthetic>' ? undefined : model, timestamp: previous?.timestamp ?? timestamp });
    }
    for (const block of rec.blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        const step: ClaudeTextStep = { kind: 'text', id: `${rec.id}:${target.steps.length}`, timestamp, text: block.text };
        target.steps.push(step);
        this.produced(requestKey, step);
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') this.thinking(block, target, requestKey, rec);
      if (block.type === 'tool_use') this.toolUse(block, target, requestKey, rec);
    }
  }

  private thinking(block: JsonRecord, target: ClaudeTurn, requestKey: string, rec: ViewRecord): void {
    // One response can stream several thinking blocks; show one row per response unless the text was kept.
    const thought = text(block.thinking);
    const existing = this.thinkingByRequest.get(requestKey);
    if (existing && !thought) return;
    const step: ClaudeThinkingStep = { kind: 'thinking', id: `${rec.id}:${target.steps.length}`, timestamp: rec.timestamp, text: thought && clip(thought) };
    target.steps.push(step);
    this.produced(requestKey, step);
    if (!existing) this.thinkingByRequest.set(requestKey, step);
  }

  private toolUse(block: JsonRecord, target: ClaudeTurn, requestKey: string, rec: ViewRecord): void {
    const view = this.view;
    const toolId = text(block.id) ?? rec.id;
    const name = text(block.name) ?? 'tool';
    const toolInput = record(block.input) ?? {};
    const step: ClaudeToolStep = {
      kind: 'tool',
      id: toolId,
      name,
      category: toolCategory(name),
      summary: toolSummary(name, toolInput, this.cwd),
      description: name === 'Bash' ? text(toolInput.description) : undefined,
      ...describeTool(name, toolInput, this.cwd),
      images: [],
      startedAt: rec.timestamp,
      status: 'pending',
      input: compactJson(toolInput, PREVIEW_LIMIT),
    };
    target.steps.push(step);
    this.produced(requestKey, step);
    target.toolCount += 1;
    this.tools.set(toolId, { step, turn: target, input: toolInput });
    view.toolCounts[step.category] += 1;
    increment(view.toolNames, (item) => item.name === name, () => ({ name, category: step.category, count: 0, errors: 0 }));
    if (name === 'Skill') {
      const skill = text(toolInput.skill) ?? text(toolInput.command);
      if (skill) increment(view.skills, (item) => item.name === skill, () => ({ name: skill, count: 0 }));
    }
    if (step.category === 'mcp') this.mcpCall(name);
    if (step.category === 'agent' && name !== 'SendMessage') {
      view.subagents.push({ id: toolId, stepId: toolId, type: text(toolInput.subagent_type), description: text(toolInput.description) });
    }
    this.fileTouch(step, toolInput, toolId);
  }

  private mcpCall(name: string): void {
    const server = name.split('__')[1] ?? name;
    const entry = this.view.mcpServers.find((item) => item.name === server);
    if (entry) entry.calls += 1;
    else this.view.mcpServers.push({ name: server, calls: 1, connected: false });
  }

  private fileTouch(step: ClaudeToolStep, toolInput: JsonRecord, toolId: string): void {
    const path = text(toolInput.file_path) ?? text(toolInput.notebook_path);
    if (!path || (step.category !== 'read' && step.category !== 'edit')) return;
    const filePath = displayPath(path, this.cwd);
    step.filePath = filePath;
    let touch = this.view.files.find((item) => item.path === filePath);
    if (!touch) {
      touch = { path: filePath, reads: 0, edits: 0, created: false, linesAdded: 0, linesRemoved: 0, firstStepId: toolId };
      this.view.files.push(touch);
    }
    if (step.category === 'read') touch.reads += 1;
    else touch.edits += 1;
  }

  private user(rec: ViewRecord): void {
    const results = rec.blocks.filter((block) => block.type === 'tool_result');
    if (results.length) {
      this.toolResults(rec, results);
      return;
    }
    const prompt = userPrompt(rec.source);
    if (prompt === undefined) this.nonPrompt(rec);
    else if (isInterruption(prompt)) this.interruption(rec, prompt);
    else this.prompt(rec, prompt);
  }

  private toolResults(rec: ViewRecord, results: JsonRecord[]): void {
    let imageIndex = 0;
    for (const result of results) {
      const resultImages = imageBlocks([result]).map((image) => ({
        file: rec.fileIndex,
        line: rec.line,
        index: imageIndex++,
        mediaType: text(record(image.source)?.media_type) ?? 'image/png',
      }));
      const entry = this.tools.get(text(result.tool_use_id) ?? rec.id);
      if (!entry) continue;
      const structured = results.length === 1 ? record(rec.source.toolUseResult) : undefined;
      this.toolResult(entry, result, resultImages, structured, rec.timestamp);
    }
  }

  private toolResult(entry: ToolEntry, result: JsonRecord, images: ClaudeImageRef[], structured: JsonRecord | undefined, timestamp?: string): void {
    const { step, turn: owner } = entry;
    step.completedAt = timestamp;
    step.durationMs = timestampDelta(step.startedAt, timestamp);
    step.status = result.is_error === true ? 'error' : 'completed';
    const fullOutput = toolResultText(result.content);
    step.output = clip(fullOutput);
    step.images.push(...images);
    step.link ??= previewLink(step.name, fullOutput);
    if (step.category === 'shell' && PR_COMMAND.test(text(entry.input.command) ?? '')) this.pullRequests(fullOutput);
    if (timestamp && (!owner.endedAt || timestamp > owner.endedAt)) owner.endedAt = timestamp;
    if (step.status === 'error') {
      owner.errorCount += 1;
      const named = this.view.toolNames.find((item) => item.name === step.name);
      if (named) named.errors += 1;
    }
    if (step.category === 'edit' && structured && step.status === 'completed') this.editResult(step, structured);
    const bashEdits = step.category === 'shell' && step.status === 'completed' ? record(structured?.bashEditDiff) : undefined;
    if (bashEdits) recordBashEdits(this.view, step, bashEdits, this.cwd);
    if (step.category === 'agent' && structured) this.linkSubagent(step, structured);
  }

  private pullRequests(output: string | undefined): void {
    for (const url of output?.match(PR_PATTERN) ?? []) addUnique(this.view.pullRequests, url);
  }

  private editResult(step: ClaudeToolStep, structured: JsonRecord): void {
    step.diff = unifiedDiff(structured);
    const stats = patchStats(structured);
    step.linesAdded = stats.added;
    step.linesRemoved = stats.removed;
    const touch = this.view.files.find((item) => item.path === step.filePath);
    if (!touch) return;
    touch.linesAdded += stats.added;
    touch.linesRemoved += stats.removed;
    if (structured.type === 'create') touch.created = true;
  }

  private linkSubagent(step: ClaudeToolStep, structured: JsonRecord): void {
    const agentId = text(structured.agentId);
    const childId = agentId && `${this.session.id}-agent-${agentId}`;
    if (!childId || !this.childIds.has(childId)) return;
    step.subagentId = childId;
    const sub = this.view.subagents.find((item) => item.stepId === step.id);
    if (sub) sub.sessionId = childId;
  }

  /** User records that are not prompts: compaction summaries, slash commands and their output. */
  private nonPrompt(rec: ViewRecord): void {
    const value = blockText(rec.message?.content);
    if (!value) return;
    const name = commandName(value);
    if (rec.source.isCompactSummary === true) {
      this.event(rec, { tone: 'warn', label: 'Conversation summary carried into the new context', detail: clip(value) });
    } else if (name) {
      this.slashCommand(rec, value, name);
    } else if (this.turn && /^\s*<local-command-stdout>/.test(value)) {
      this.commandOutput(value);
    }
  }

  private interruption(rec: ViewRecord, prompt: string): void {
    this.view.interruptions += 1;
    const target = this.current(rec.id, rec.timestamp);
    target.status = 'interrupted';
    target.steps.push({ kind: 'event', id: rec.id, timestamp: rec.timestamp, tone: 'warn', label: 'Interrupted by you', detail: prompt.replace(/^\[|\]$/g, '') });
  }

  private prompt(rec: ViewRecord, prompt: string): void {
    const { source, message, timestamp } = rec;
    const name = commandName(prompt);
    if (name) increment(this.view.slashCommands, (item) => item.name === name, () => ({ name, count: 0 }));
    this.closeTurn();
    const turn = this.newTurn(rec.uuid ?? rec.id, timestamp);
    turn.prompt = {
      text: prompt,
      timestamp,
      permissionMode: text(source.permissionMode),
      source: text(source.promptSource) ?? text(record(source.origin)?.kind),
      images: imageBlocks(message?.content).map((image, index) => ({ file: rec.fileIndex, line: rec.line, index, mediaType: text(record(image.source)?.media_type) ?? 'image/png' })),
    };
    this.turn = turn;
    this.view.turns.push(turn);
  }

  /** Usage repeats on every streamed block of one API response; count each response once. */
  private tallyRequests(): void {
    const view = this.view;
    for (const [requestKey, { turn: owner, usage, model }] of this.requests) {
      const fresh = number(usage.input_tokens) ?? 0;
      const cacheWrite = number(usage.cache_creation_input_tokens) ?? 0;
      const cacheRead = number(usage.cache_read_input_tokens) ?? 0;
      const output = number(usage.output_tokens) ?? 0;
      const thinking = number(record(usage.output_tokens_details)?.thinking_tokens) ?? 0;
      // Thinking tokens are reported per response; show them on that response's first thinking block.
      const thinkingStep = this.thinkingByRequest.get(requestKey);
      if (thinkingStep && thinking) thinkingStep.tokens = thinking;
      for (const tokens of [owner.tokens, view.tokens]) {
        tokens.fresh += fresh;
        tokens.cacheWrite += cacheWrite;
        tokens.cacheRead += cacheRead;
        tokens.output += output;
        tokens.thinking += thinking;
        tokens.requests += 1;
      }
      const context = fresh + cacheWrite + cacheRead;
      owner.peakContext = Math.max(owner.peakContext, context);
      view.peakContext = Math.max(view.peakContext, context);
      if (model) this.modelEntry(model).requests += 1;
    }
  }

  finish(): ClaudeSessionView {
    this.closeTurn();
    const view = this.view;
    this.tallyRequests();
    if (view.peakContext > view.contextWindow) view.contextWindow = 1_000_000;
    allocateCost(view, this.requests, this.stepsByRequest);
    detectCacheResets(view, this.requests, this.stepsByRequest);

    // Thinking rows with neither text nor a token count carry no information.
    for (const item of view.turns) item.steps = item.steps.filter((step) => step.kind !== 'thinking' || step.text || step.tokens);

    // Preamble turns with nothing in them are noise.
    view.turns = view.turns.filter((item) => item.prompt || item.steps.length).map((item, index) => ({ ...item, index }));
    view.models.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.requests - a.requests);
    view.toolNames.sort((a, b) => b.count - a.count);
    view.files.sort((a, b) => b.edits - a.edits || b.reads - a.reads);
    view.hooks.sort((a, b) => b.count - a.count);
    view.mcpServers.sort((a, b) => b.calls - a.calls);
    view.endedAt = view.turns.at(-1)?.endedAt ?? view.endedAt;
    view.insights = findInsights(view);
    return view;
  }
}

function apiErrorDetail(source: JsonRecord, content?: string): string | undefined {
  const cause = record(source.cause);
  const error = record(source.error);
  return text(cause?.code) ?? text(error?.message) ?? text(record(error?.error)?.message) ?? content;
}

export async function readClaudeSessionView(session: SessionInventory, childSessionIds: string[] = []): Promise<ClaudeSessionView> {
  const builder = new ClaudeViewBuilder(session, childSessionIds);
  for (const [fileIndex, file] of session.sourceFiles.entries()) {
    const input = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    let line = 0;
    for await (const raw of input) {
      line += 1;
      const source = parseLine(raw);
      if (source) builder.read(source, fileIndex, file, line);
    }
  }
  return builder.finish();
}

// --- Exports and imports ----------------------------------------------------------------------------------------

/** Copies a view with every image's bytes inlined, so an export file is complete without the transcript. */
export async function embedClaudeImages(view: ClaudeSessionView, sourceFiles: string[]): Promise<ClaudeSessionView> {
  const copy = structuredClone(view);
  const refs = copy.turns.flatMap((turn) => [...(turn.prompt?.images ?? []), ...turn.steps.flatMap((step) => (step.kind === 'tool' ? step.images : []))]);
  const byFile = new Map<number, Map<number, ClaudeImageRef[]>>();
  for (const ref of refs) {
    const lines = byFile.get(ref.file) ?? new Map<number, ClaudeImageRef[]>();
    lines.set(ref.line, [...(lines.get(ref.line) ?? []), ref]);
    byFile.set(ref.file, lines);
  }
  for (const [fileIndex, lines] of byFile) {
    const file = sourceFiles[fileIndex];
    if (file) await inlineFileImages(file, lines);
  }
  return copy;
}

async function inlineFileImages(file: string, lines: Map<number, ClaudeImageRef[]>): Promise<void> {
  const input = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;
  for await (const raw of input) {
    line += 1;
    const wanted = lines.get(line);
    if (wanted) inlineImages(raw, wanted);
  }
}

function inlineImages(raw: string, wanted: ClaudeImageRef[]): void {
  // A malformed line just leaves those images out of the export.
  const images = imageBlocks(record(parseLine(raw)?.message)?.content);
  for (const ref of wanted) {
    const data = text(record(images[ref.index]?.source)?.data);
    if (data) ref.src = `data:${ref.mediaType};base64,${data}`;
  }
}

type ViewMeta = Pick<ClaudeSessionView, 'id' | 'title'> & Partial<Omit<ClaudeSessionView, 'turns'>>;

function findOrAdd<T>(list: T[], match: (item: T) => boolean, create: () => T): T {
  let item = list.find(match);
  if (!item) {
    item = create();
    list.push(item);
  }
  return item;
}

function tallyFileTouch(view: ClaudeSessionView, step: ClaudeToolStep): void {
  const filePath = step.filePath;
  if (!filePath || (step.category !== 'read' && step.category !== 'edit')) return;
  const touch = findOrAdd(view.files, (item) => item.path === filePath, () => ({ path: filePath, reads: 0, edits: 0, created: false, linesAdded: 0, linesRemoved: 0, firstStepId: step.id }));
  if (step.category === 'read') touch.reads += 1;
  else touch.edits += 1;
  touch.linesAdded += step.linesAdded ?? 0;
  touch.linesRemoved += step.linesRemoved ?? 0;
  if (step.diff?.startsWith('--- /dev/null')) touch.created = true;
}

function tallyToolStep(view: ClaudeSessionView, step: ClaudeToolStep): void {
  view.toolCounts[step.category] += 1;
  const named = increment(view.toolNames, (item) => item.name === step.name, () => ({ name: step.name, category: step.category, count: 0, errors: 0 }));
  if (step.status === 'error') named.errors += 1;
  const serverName = step.server;
  if (serverName) findOrAdd(view.mcpServers, (item) => item.name === serverName, () => ({ name: serverName, calls: 0, connected: true })).calls += 1;
  if (step.category === 'agent' && step.name !== 'SendMessage') view.subagents.push({ id: step.id, stepId: step.id, description: step.summary, sessionId: step.subagentId });
  const skill = step.name === 'Skill' ? step.summary : undefined;
  if (skill) increment(view.skills, (item) => item.name === skill, () => ({ name: skill, count: 0 }));
  tallyFileTouch(view, step);
}

function tallyTurn(view: ClaudeSessionView, turn: ClaudeTurn): void {
  for (const key of Object.keys(view.tokens) as Array<keyof ClaudeTokens>) view.tokens[key] += turn.tokens[key];
  view.peakContext = Math.max(view.peakContext, turn.peakContext);
  if (turn.status === 'interrupted') view.interruptions += 1;
  for (const model of turn.models) {
    const entry = findOrAdd(view.models, (item) => item.model === model, () => ({ model, requests: 0 }));
    entry.requests += turn.models.length === 1 ? turn.tokens.requests : 0;
  }
  for (const step of turn.steps) {
    if (step.kind === 'event') tallyEvent(view, step);
    if (step.kind === 'tool') tallyToolStep(view, step);
  }
}

function tallyEvent(view: ClaudeSessionView, step: ClaudeEventStep): void {
  if (step.tone === 'error') view.apiErrors += 1;
  if (step.label === 'Context compacted') view.compactions += 1;
}

/** Builds a view from turns alone (selected-message exports, converted imports), recomputing the totals. */
export function viewFromTurns(meta: ViewMeta, source: ClaudeTurn[]): ClaudeSessionView {
  const turns = source.map((turn, index) => ({ ...turn, index }));
  const view: ClaudeSessionView = {
    versions: [],
    entrypoints: [],
    gitBranches: [],
    permissionModes: [],
    efforts: [],
    models: [],
    tokens: emptyTokens(),
    peakContext: 0,
    contextWindow: 200_000,
    toolCounts: { read: 0, edit: 0, shell: 0, web: 0, agent: 0, mcp: 0, other: 0 },
    toolNames: [],
    files: [],
    instructions: [],
    hooks: [],
    skills: [],
    mcpServers: [],
    slashCommands: [],
    subagents: [],
    recaps: [],
    pullRequests: [],
    insights: [],
    cacheResets: [],
    contextSeries: [],
    apiErrors: 0,
    compactions: 0,
    interruptions: 0,
    startedAt: turns[0]?.startedAt,
    endedAt: turns.at(-1)?.endedAt,
    ...meta,
    imported: true,
    turns,
  };
  for (const turn of turns) tallyTurn(view, turn);
  if (view.peakContext > view.contextWindow) view.contextWindow = 1_000_000;
  view.toolNames.sort((a, b) => b.count - a.count);
  view.files.sort((a, b) => b.edits - a.edits || b.reads - a.reads);
  view.insights = findInsights(view);
  return view;
}

function diffStats(diff: string | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff?.split('\n') ?? []) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function detailStepStatus(tool: ToolCallDetail): ClaudeToolStep['status'] {
  if (tool.status === 'error') return 'error';
  return tool.completedAt || tool.output ? 'completed' : 'pending';
}

function toolStepFromDetail(tool: ToolCallDetail, diffs: Map<string, string>, cwd?: string): ClaudeToolStep {
  let input: JsonRecord = {};
  try {
    input = record(JSON.parse(tool.input ?? '{}')) ?? {};
  } catch {
    // Older exports may hold truncated input; describe the call from its name alone.
  }
  const diff = diffs.get(tool.id);
  const stats = diffStats(diff);
  const path = text(input.file_path) ?? text(input.notebook_path);
  const category = toolCategory(tool.name);
  return {
    kind: 'tool',
    id: tool.id,
    name: tool.name,
    category,
    summary: toolSummary(tool.name, input, cwd),
    description: tool.name === 'Bash' ? text(input.description) : undefined,
    ...describeTool(tool.name, input, cwd),
    images: [],
    startedAt: tool.startedAt,
    completedAt: tool.completedAt,
    durationMs: tool.durationMs,
    status: detailStepStatus(tool),
    input: tool.input,
    output: tool.output,
    diff,
    filePath: path && (category === 'read' || category === 'edit') ? displayPath(path, cwd) : undefined,
    linesAdded: diff ? stats.added : undefined,
    linesRemoved: diff ? stats.removed : undefined,
  };
}

function detailTurn(index: number, id: string, entry?: ConversationEntry): ClaudeTurn {
  return {
    index,
    id,
    prompt: entry ? { text: entry.text, timestamp: entry.timestamp, images: [] } : undefined,
    startedAt: entry?.timestamp,
    endedAt: entry?.timestamp,
    durationSource: 'unavailable',
    status: 'completed',
    steps: [],
    tokens: emptyTokens(),
    peakContext: 0,
    models: [],
    toolCount: 0,
    errorCount: 0,
  };
}

function addDetailActivity(turn: ClaudeTurn, activity: NonNullable<ConversationEntry['activity']>, cwd?: string): void {
  const diffs = new Map(activity.edits.flatMap((edit) => (edit.files[0]?.diff ? [[edit.id, edit.files[0].diff] as [string, string]] : [])));
  for (const tool of activity.tools) {
    const step = toolStepFromDetail(tool, diffs, cwd);
    turn.steps.push(step);
    turn.toolCount += 1;
    if (step.status === 'error') turn.errorCount += 1;
  }
  for (const request of activity.modelRequests) {
    const input = request.usage.inputTokens ?? 0;
    const cached = request.usage.cachedInputTokens ?? 0;
    turn.tokens.fresh += Math.max(0, input - cached);
    turn.tokens.cacheRead += cached;
    turn.tokens.output += request.usage.outputTokens ?? 0;
    turn.tokens.thinking += request.usage.reasoningOutputTokens ?? 0;
    turn.tokens.requests += 1;
    turn.peakContext = Math.max(turn.peakContext, input);
  }
  addUnique(turn.models, activity.model.name);
  if (activity.task) {
    turn.durationMs = activity.task.durationMs;
    turn.durationSource = activity.task.durationMs === undefined ? 'unavailable' : 'timestamps';
    if (activity.task.status === 'aborted') turn.status = 'interrupted';
  }
}

function addReplyEntry(turn: ClaudeTurn, entry: ConversationEntry, cwd?: string): void {
  if (entry.activity) addDetailActivity(turn, entry.activity, cwd);
  if (entry.text.trim()) turn.steps.push({ kind: 'text', id: entry.id, timestamp: entry.timestamp, text: entry.text });
  if (entry.timestamp && (!turn.endedAt || entry.timestamp > turn.endedAt)) turn.endedAt = entry.timestamp;
}

function markInterrupted(turn: ClaudeTurn, entry: ConversationEntry): void {
  turn.status = 'interrupted';
  turn.steps.push({ kind: 'event', id: entry.id, timestamp: entry.timestamp, tone: 'warn', label: 'Interrupted by you', detail: entry.text.replace(/^\[|\]$/g, '') });
}

/** Converts a generic session export (written before Claude views were exported) into a Claude view. */
export function claudeViewFromDetail(detail: SessionDetail): ClaudeSessionView {
  const turns: ClaudeTurn[] = [];
  let turn: ClaudeTurn | undefined;
  const open = (id: string, entry?: ConversationEntry): ClaudeTurn => {
    const next = detailTurn(turns.length, id, entry);
    turns.push(next);
    return next;
  };
  for (const entry of detail.conversation) {
    if (entry.role === 'user') {
      if (turn && isInterruption(entry.text)) markInterrupted(turn, entry);
      else turn = open(entry.id, entry);
      continue;
    }
    turn ??= open(`${entry.id}-preamble`);
    addReplyEntry(turn, entry, detail.cwd);
  }
  return viewFromTurns(
    {
      id: detail.id,
      title: detail.displayTitle.value,
      cwd: detail.cwd,
      projectName: detail.projectName,
      versions: detail.cliVersions,
      startedAt: detail.startedAt,
      endedAt: detail.updatedAt,
    },
    turns,
  );
}
