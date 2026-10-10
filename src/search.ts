import { isAbsolute, resolve } from 'node:path';
import type { ClaudeSessionView, ClaudeToolStep } from './claude-view.ts';
import type { AgentKind, SessionDetail } from './types.ts';

// Cross-session search and per-file edit history. Documents are plain text pulled from each session's
// prompts, replies, commands and tool calls; matching is case-insensitive and every word must appear.

export type SearchKind = 'prompt' | 'reply' | 'note' | 'command' | 'tool';

export interface SearchDoc {
  sessionId: string;
  agent: AgentKind;
  kind: SearchKind;
  text: string;
  timestamp?: string;
  /** Element id to jump to on the session page (a turn or tool call). */
  anchor?: string;
}

export interface FileEdit {
  /** Absolute path, used to group a file's history across sessions. */
  path: string;
  sessionId: string;
  agent: AgentKind;
  timestamp?: string;
  /** The user message that led to the edit. */
  prompt?: string;
  diff?: string;
  added: number;
  removed: number;
  created: boolean;
  anchor?: string;
}

export interface SessionIndex {
  docs: SearchDoc[];
  edits: FileEdit[];
}

const MAX_DOC_LENGTH = 20_000;

/** Caps a document's size and turns escaped newlines and tabs (common in pasted logs) into spaces. */
function clip(value: string): string {
  const text = value.replace(/\\[nrt]/g, ' ');
  return text.length > MAX_DOC_LENGTH ? text.slice(0, MAX_DOC_LENGTH) : text;
}

function absolute(path: string, cwd?: string): string {
  if (isAbsolute(path) || !cwd) return path;
  return resolve(cwd, path);
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

function toolPath(step: ClaudeToolStep, cwd?: string): string | undefined {
  try {
    const input = JSON.parse(step.input ?? '{}') as { file_path?: unknown; notebook_path?: unknown };
    const candidate = [input.file_path, input.notebook_path].find((value) => typeof value === 'string');
    const path = typeof candidate === 'string' ? candidate : undefined;
    return path ? absolute(path, cwd) : undefined;
  } catch {
    return undefined;
  }
}

function toolCommand(step: ClaudeToolStep): string | undefined {
  try {
    const input = JSON.parse(step.input ?? '{}') as { command?: unknown };
    return typeof input.command === 'string' ? input.command : undefined;
  } catch {
    return undefined;
  }
}

/** Index of a Claude Code session, from its Claude view. */
export function indexClaudeView(view: ClaudeSessionView): SessionIndex {
  const docs: SearchDoc[] = [];
  const edits: FileEdit[] = [];
  for (const turn of view.turns) {
    const anchor = `turn-${turn.id}`;
    if (turn.prompt) docs.push({ sessionId: view.id, agent: 'claude', kind: 'prompt', text: clip(turn.prompt.text), timestamp: turn.prompt.timestamp, anchor });
    let lastWork = -1;
    turn.steps.forEach((step, index) => {
      if (step.kind === 'tool') lastWork = index;
    });
    turn.steps.forEach((step, index) => {
      if (step.kind === 'text') {
        docs.push({ sessionId: view.id, agent: 'claude', kind: index > lastWork ? 'reply' : 'note', text: clip(step.text), timestamp: step.timestamp, anchor });
      }
      if (step.kind !== 'tool') return;
      const command = toolCommand(step);
      docs.push({
        sessionId: view.id,
        agent: 'claude',
        kind: command ? 'command' : 'tool',
        text: clip(command ? `${step.label}\n${command}` : step.label),
        timestamp: step.startedAt,
        anchor: step.id,
      });
      for (const edit of step.fileEdits ?? []) {
        edits.push({
          path: edit.absolutePath,
          sessionId: view.id,
          agent: 'claude',
          timestamp: step.startedAt,
          prompt: turn.prompt?.text,
          diff: edit.diff,
          added: edit.added,
          removed: edit.removed,
          created: edit.diff?.startsWith('--- /dev/null') ?? false,
          anchor: step.id,
        });
      }
      if (step.category === 'edit' && step.status === 'completed') {
        const path = toolPath(step, view.cwd);
        if (!path) return;
        edits.push({
          path,
          sessionId: view.id,
          agent: 'claude',
          timestamp: step.startedAt,
          prompt: turn.prompt?.text,
          diff: step.diff,
          added: step.linesAdded ?? 0,
          removed: step.linesRemoved ?? 0,
          created: step.diff?.startsWith('--- /dev/null') ?? false,
          anchor: step.id,
        });
      }
    });
  }
  return { docs, edits };
}

function entryEdits(detail: SessionDetail, entry: SessionDetail['conversation'][number], agent: AgentKind, prompt?: string): FileEdit[] {
  return (entry.activity?.edits ?? []).flatMap((edit) =>
    edit.files.map((file) => {
      const stats = diffStats(file.diff);
      return {
        path: absolute(file.path, detail.cwd),
        sessionId: detail.id,
        agent,
        timestamp: edit.timestamp ?? entry.timestamp,
        prompt,
        diff: file.diff,
        added: stats.added,
        removed: stats.removed,
        created: file.operation === 'add' || file.operation === 'create',
      };
    }),
  );
}

/** Index of a Codex session, from its generic detail. */
export function indexDetail(detail: SessionDetail): SessionIndex {
  const agent: AgentKind = detail.agent ?? 'codex';
  const docs: SearchDoc[] = [];
  const edits: FileEdit[] = [];
  let prompt: string | undefined;
  for (const entry of detail.conversation) {
    if (entry.role === 'user') prompt = entry.text;
    if (entry.text.trim()) {
      docs.push({ sessionId: detail.id, agent, kind: entry.role === 'user' ? 'prompt' : 'reply', text: clip(entry.text), timestamp: entry.timestamp });
    }
    for (const tool of entry.activity?.tools ?? []) {
      docs.push({ sessionId: detail.id, agent, kind: tool.kind === 'exec' ? 'command' : 'tool', text: clip(`${tool.name}\n${tool.input ?? ''}`), timestamp: tool.startedAt });
    }
    edits.push(...entryEdits(detail, entry, agent, prompt));
  }
  return { docs, edits };
}

export interface SearchHit {
  doc: SearchDoc;
  /** The part of the text where the most query words appear together, with the match positions inside it. */
  snippet: string;
  matches: Array<[number, number]>;
  score: number;
}

export interface ParsedQuery {
  /** Words and quoted phrases that must all appear, lowercase. */
  terms: string[];
  /** Words prefixed with `-` that must not appear. */
  excluded: string[];
  /** The query as typed, without quotes or exclusions, for the exact-phrase bonus. */
  phrase: string;
}

const SNIPPET_LENGTH = 220;

/** Splits a query into lowercase words; quoted phrases stay together; `-word` excludes. */
export function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  const excluded: string[] = [];
  for (const match of query.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const negative = (match[1] ?? match[3]) === '-';
    const value = (match[2] ?? match[4] ?? '').toLowerCase().trim();
    if (!value || value === '-') continue;
    (negative ? excluded : terms).push(value);
  }
  return { terms, excluded, phrase: terms.join(' ') };
}

/** Lowercase words and phrases of a query (kept for callers that only need the terms). */
export function queryTerms(query: string): string[] {
  return parseQuery(query).terms;
}

function occurrences(text: string, term: string): number[] {
  const at: number[] = [];
  let index = text.indexOf(term);
  while (index >= 0 && at.length < 50) {
    at.push(index);
    index = text.indexOf(term, index + term.length);
  }
  return at;
}

/** Messages outrank commands and tool calls, which are usually found by accident. */
const KIND_WEIGHT: Record<SearchKind, number> = { prompt: 3, reply: 2.5, note: 1.5, command: 1.2, tool: 1 };

/** Pasted logs and JSON dumps match everything; mark them down so real messages come first. */
function noisiness(text: string): number {
  const sample = text.slice(0, 2_000);
  const symbols = (sample.match(/[{}"\\[\]:]/g) ?? []).length;
  return sample.length ? symbols / sample.length : 0;
}

/** Start of the window that contains the most distinct query words. */
function bestWindowStart(terms: string[], positions: Map<string, number[]>): number {
  let best = positions.get(terms[0])?.[0] ?? 0;
  let bestCount = 0;
  const inWindow = (term: string, start: number) =>
    positions.get(term)!.some((at) => at >= start && at + term.length <= start + SNIPPET_LENGTH);
  for (const starts of positions.values()) {
    for (const start of starts) {
      const count = terms.filter((term) => inWindow(term, start)).length;
      if (count > bestCount) {
        bestCount = count;
        best = start;
      }
    }
  }
  return best;
}

/** Collapses whitespace in text[from, to) without losing match positions: origin maps each kept character back. */
function collapseWhitespace(text: string, from: number, to: number): { collapsed: string; origin: number[] } {
  let collapsed = '';
  let lastSpace = false;
  const origin: number[] = [];
  for (let i = from; i < to; i += 1) {
    const char = /\s/.test(text[i]) ? ' ' : text[i];
    if (char === ' ' && lastSpace) continue;
    lastSpace = char === ' ';
    origin.push(i);
    collapsed += char;
  }
  return { collapsed, origin };
}

function snippetFor(text: string, terms: string[], positions: Map<string, number[]>): { snippet: string; matches: Array<[number, number]> } {
  const from = Math.max(0, bestWindowStart(terms, positions) - 60);
  const to = Math.min(text.length, from + SNIPPET_LENGTH);
  const prefix = from > 0 ? '…' : '';
  const { collapsed, origin } = collapseWhitespace(text, from, to);
  const snippet = prefix + collapsed + (to < text.length ? '…' : '');
  const matches: Array<[number, number]> = [];
  for (const term of terms) {
    for (const at of positions.get(term) ?? []) {
      if (at < from || at + term.length > to) continue;
      const start = origin.indexOf(at);
      const end = origin.findIndex((index) => index >= at + term.length);
      if (start >= 0) matches.push([start + prefix.length, (end < 0 ? origin.length : end) + prefix.length]);
    }
  }
  matches.sort((a, b) => a[0] - b[0]);
  return { snippet, matches };
}

/** Scores a document against a query; undefined when a word is missing or an excluded word is present. */
export function matchDoc(doc: SearchDoc, query: ParsedQuery | string[], now = Date.now()): SearchHit | undefined {
  const parsed: ParsedQuery = Array.isArray(query) ? { terms: query, excluded: [], phrase: query.join(' ') } : query;
  const { terms, excluded, phrase } = parsed;
  if (!terms.length) return undefined;
  const lower = doc.text.toLowerCase();
  if (excluded.some((term) => lower.includes(term))) return undefined;
  const positions = new Map<string, number[]>();
  for (const term of terms) {
    const at = occurrences(lower, term);
    if (!at.length) return undefined;
    positions.set(term, at);
  }

  let score = KIND_WEIGHT[doc.kind];
  for (const term of terms) {
    const at = positions.get(term)!;
    score += Math.min(at.length, 5) / Math.log2(lower.length / 200 + 2);
    // Whole-word matches beat matches inside longer words.
    if (at.some((index) => !/\w/.test(lower[index - 1] ?? ' ') && !/\w/.test(lower[index + term.length] ?? ' '))) score += 0.5;
  }
  if (terms.length > 1 && lower.includes(phrase)) score += 3;
  if (doc.timestamp) score += 2 * Math.exp(-(now - Date.parse(doc.timestamp)) / (30 * 86_400_000));
  score -= noisiness(doc.text) > 0.08 ? 1.5 : 0;

  return { doc, score, ...snippetFor(doc.text, terms, positions) };
}

/** Flat list of hits, best first (kept for simple callers and tests). */
export function search(indexes: Iterable<SessionIndex>, query: string, limit = 200): SearchHit[] {
  const parsed = parseQuery(query);
  if (!parsed.terms.length) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const index of indexes) {
    for (const doc of index.docs) {
      const key = `${doc.kind}\u0000${doc.timestamp ?? ''}\u0000${doc.text.slice(0, 200)}`;
      if (seen.has(key)) continue;
      const hit = matchDoc(doc, parsed, now);
      if (!hit) continue;
      seen.add(key);
      hits.push(hit);
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface SearchSession {
  id: string;
  agent: AgentKind;
  title: string;
  project?: string;
  updatedAt?: string;
}

export interface SearchFilters {
  agent?: AgentKind;
  kinds?: SearchKind[];
  project?: string;
  /** Only messages newer than this (epoch milliseconds). */
  sinceMs?: number;
  sort?: 'relevance' | 'newest';
}

export interface SearchGroup extends SearchSession {
  score: number;
  /** All matches in the session; `hits` holds the best few. */
  matchCount: number;
  hits: SearchHit[];
}

export interface SearchResults {
  total: number;
  /** Sessions with a match; `groups` holds at most the best 60 of them. */
  sessionCount: number;
  groups: SearchGroup[];
  /** Match counts by agent, kind and project for the query, before those filters, so each choice shows what it holds. */
  facets: { agents: Record<string, number>; kinds: Record<string, number>; projects: Array<{ name: string; count: number }> };
}

/**
 * Counts a hit toward each facet whose other filters it passes, so a facet shows what picking it would give.
 * Returns whether the hit passes every filter.
 */
function countFacets(facets: SearchResults['facets'], projects: Map<string, number>, session: SearchSession, doc: SearchDoc, filters: SearchFilters): boolean {
  const project = session.project ?? 'No project';
  const agentOk = !filters.agent || session.agent === filters.agent;
  const kindOk = !filters.kinds?.length || filters.kinds.includes(doc.kind);
  const projectOk = !filters.project || project === filters.project;
  if (kindOk && projectOk) facets.agents[session.agent] = (facets.agents[session.agent] ?? 0) + 1;
  if (agentOk && projectOk) facets.kinds[doc.kind] = (facets.kinds[doc.kind] ?? 0) + 1;
  if (agentOk && kindOk) projects.set(project, (projects.get(project) ?? 0) + 1);
  return agentOk && kindOk && projectOk;
}

const HITS_PER_SESSION = 12;
const MAX_SESSIONS = 60;

/** Matches a doc not already matched in another session; a resumed session replays the earlier transcript. */
function unseenMatch(doc: SearchDoc, parsed: ParsedQuery, now: number, seen: Set<string>): SearchHit | undefined {
  const key = `${doc.kind}\u0000${doc.timestamp ?? ''}\u0000${doc.text.slice(0, 200)}`;
  if (seen.has(key)) return undefined;
  const hit = matchDoc(doc, parsed, now);
  if (hit) seen.add(key);
  return hit;
}

function withinWindow(doc: SearchDoc, sinceMs?: number): boolean {
  return !sinceMs || (doc.timestamp !== undefined && Date.parse(doc.timestamp) >= sinceMs);
}

function addHit(groups: Map<string, SearchGroup>, session: SearchSession, hit: SearchHit): void {
  const group = groups.get(session.id) ?? { ...session, score: 0, matchCount: 0, hits: [] };
  group.matchCount += 1;
  group.hits.push(hit);
  groups.set(session.id, group);
}

function rankGroups(groups: SearchGroup[], sort: SearchFilters['sort']): SearchGroup[] {
  for (const group of groups) {
    group.hits.sort((a, b) => b.score - a.score);
    group.hits = group.hits.slice(0, HITS_PER_SESSION);
    // A session's rank: its best match, nudged up by how many matches it has.
    group.score = (group.hits[0]?.score ?? 0) + 0.4 * Math.log2(1 + group.matchCount);
  }
  const byNewest = (a: SearchGroup, b: SearchGroup) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  const byScore = (a: SearchGroup, b: SearchGroup) => b.score - a.score;
  return groups.sort(sort === 'newest' ? byNewest : byScore).slice(0, MAX_SESSIONS);
}

/** Searches every session and groups matches by session, best session first (or newest, when sorted so). */
export function searchSessions(entries: Array<{ index: SessionIndex; session: SearchSession }>, query: string, filters: SearchFilters = {}): SearchResults {
  const parsed = parseQuery(query);
  const results: SearchResults = { total: 0, sessionCount: 0, groups: [], facets: { agents: {}, kinds: {}, projects: [] } };
  if (!parsed.terms.length) return results;
  const now = Date.now();
  const seen = new Set<string>();
  const projects = new Map<string, number>();
  const groups = new Map<string, SearchGroup>();

  for (const { index, session } of entries) {
    for (const doc of index.docs) {
      const hit = withinWindow(doc, filters.sinceMs) ? unseenMatch(doc, parsed, now, seen) : undefined;
      if (!hit || !countFacets(results.facets, projects, session, doc, filters)) continue;

      results.total += 1;
      addHit(groups, session, hit);
    }
  }

  results.sessionCount = groups.size;
  results.groups = rankGroups([...groups.values()], filters.sort);
  results.facets.projects = [...projects.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return results;
}

export interface FileHistory {
  path: string;
  edits: FileEdit[];
  sessions: number;
  added: number;
  removed: number;
  lastEditedAt?: string;
}

/** Files whose path contains the query (or all, when empty), each with its edits across sessions, oldest first. */
export function fileHistories(indexes: Iterable<SessionIndex>, query: string, limit = 100): FileHistory[] {
  const needle = query.trim().toLowerCase();
  const byPath = new Map<string, FileEdit[]>();
  // Resumed sessions replay earlier tool calls; the same call (same id and time) is one edit.
  const seen = new Set<string>();
  for (const index of indexes) {
    for (const edit of index.edits) {
      if (needle && !edit.path.toLowerCase().includes(needle)) continue;
      const key = `${edit.path}\u0000${edit.anchor ?? ''}\u0000${edit.timestamp ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit]);
    }
  }
  return [...byPath.entries()]
    .map(([path, edits]) => {
      const ordered = edits.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
      return {
        path,
        edits: ordered,
        sessions: new Set(ordered.map((edit) => edit.sessionId)).size,
        added: ordered.reduce((sum, edit) => sum + edit.added, 0),
        removed: ordered.reduce((sum, edit) => sum + edit.removed, 0),
        lastEditedAt: ordered.at(-1)?.timestamp,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || (b.lastEditedAt ?? '').localeCompare(a.lastEditedAt ?? ''))
    .slice(0, limit);
}
