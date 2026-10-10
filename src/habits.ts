import { errorSignature, type ClaudeSessionView, type ClaudeToolStep } from './claude-view.ts';
import type { SessionIndex } from './search.ts';
import type { SessionInventory } from './types.ts';

// Patterns across every session: where money and time go, what keeps failing, what sits in context unused,
// and what you keep telling Claude. Everything here is derived from local transcripts; nothing is sent anywhere.

export interface HabitsInput {
  session: SessionInventory;
  view?: ClaudeSessionView;
  /** Search index; supplies Codex prompts for spotting corrections. */
  index?: SessionIndex;
}

export interface Habits {
  since?: string;
  totals: {
    sessions: number;
    claudeSessions: number;
    codexSessions: number;
    costUsd: number;
    tokens: number;
    workingMs: number;
    messages: number;
    cacheWasteUsd: number;
    cacheExpiries: number;
  };
  weeks: Array<{ week: string; costUsd: number; tokens: number; sessions: number }>;
  projects: Array<{ name: string; sessions: number; costUsd: number; tokens: number; lastAt?: string }>;
  time: { modelMs: number; toolMs: number; waitingOnYouMs: number; workingMs: number };
  failures: Array<{ tool: string; signature: string; count: number; sessions: number; costUsd: number; example: { sessionId: string; stepId: string } }>;
  contextTrim: Array<{ kind: 'mcp' | 'skills' | 'instructions'; name: string; tokensPerRequest: number; loadedIn: number; usedIn: number }>;
  /**
   * Commands Claude Code's permission checks blocked, grouped by program. `rule` is a suggested allow rule, left out
   * for chained commands (where a prefix rule would allow anything after it) and for destructive programs.
   */
  blocked: Array<{ key: string; rule?: string; count: number; examples: string[]; example: { sessionId: string; stepId: string } }>;
  corrections: Array<{ text: string; sessionId: string; turnId: string; timestamp?: string; title: string }>;
  compacted: Array<{ sessionId: string; title: string; count: number }>;
}

const DAY = 86_400_000;
/** Rough characters per token, for sizing text that never went through the tokenizer on its own. */
const CHARS_PER_TOKEN = 4;

function weekStart(timestamp: string): string {
  const date = new Date(timestamp);
  const offset = (date.getUTCDay() + 6) % 7; // Monday-based weeks
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset)).toISOString().slice(0, 10);
}

function commandOf(step: ClaudeToolStep): string | undefined {
  try {
    const parsed = JSON.parse(step.input ?? '{}') as { command?: unknown };
    return typeof parsed.command === 'string' ? parsed.command.trim() : undefined;
  } catch {
    return undefined;
  }
}

const CHAINED = /&&|\|\||;|\||>|<|`|\$\(|\n/;
// Destructive programs, network fetchers and interpreters: a prefix rule for these would allow arbitrary actions.
const DESTRUCTIVE = new Set([
  'rm', 'rmdir', 'sudo', 'su', 'mv', 'dd', 'chmod', 'chown', 'kill', 'killall', 'curl', 'wget', 'ssh', 'scp', 'eval', 'exec',
  'sh', 'bash', 'zsh', 'python', 'python3', 'node', 'bun', 'deno', 'ruby', 'perl', 'php', 'npx', 'bunx', 'xargs', 'env',
]);

/** The program and subcommand a command starts with, e.g. "npm test" or "git status". */
export function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  const program = words[0] ?? '';
  const sub = words[1];
  return sub && /^[a-z][\w-]*$/i.test(sub) ? `${program} ${sub}` : program;
}

/**
 * A Claude Code allow rule for a blocked command, or undefined when a prefix rule would be unsafe: chained commands
 * (`cd x && …` would allow anything after the `&&`), destructive programs and pushes.
 */
export function permissionRule(command: string): string | undefined {
  if (CHAINED.test(command.trim())) return undefined;
  const prefix = commandPrefix(command);
  const program = prefix.split(' ')[0];
  if (!program || DESTRUCTIVE.has(program) || /^git (push|reset|clean)\b/.test(prefix)) return undefined;
  return `Bash(${prefix}:*)`;
}

const BLOCKED = /permission for this action was denied|was blocked|not allowed by|denied by the claude code|classifier/i;
const CORRECTIONS = [
  /^\s*(no|nope|don'?t|do not|stop|instead|actually|wrong|never)\b/i,
  /^\s*(that'?s (not|wrong)|not like that|please don'?t|why did you)/i,
  /^\s*you (forgot|missed|should(n'?t)?|need to)\b/i,
  /\binstead of\b/i,
];

/** Short follow-up messages that push back on what Claude did: candidates for a standing CLAUDE.md rule. */
export function isCorrection(text: string): boolean {
  return text.length <= 300 && CORRECTIONS.some((pattern) => pattern.test(text));
}

type TrimKind = Habits['contextTrim'][number]['kind'];
type Week = Habits['weeks'][number] & { ids: Set<string> };
type Failure = Habits['failures'][number] & { ids: Set<string> };
type Session = HabitsInput['session'];
type Turn = NonNullable<HabitsInput['view']>['turns'][number];

class HabitsAccumulator {
  readonly habits: Habits;
  private readonly since?: string;
  private readonly weeks = new Map<string, Week>();
  private readonly projects = new Map<string, Habits['projects'][number]>();
  private readonly failures = new Map<string, Failure>();
  private readonly blocked = new Map<string, Habits['blocked'][number]>();
  // Resumed sessions replay the earlier transcript into a new file; count each turn and message once.
  private readonly seenTurns = new Set<string>();
  private readonly trim = new Map<string, { kind: TrimKind; name: string; chars: number[]; usedIn: number }>();

  constructor(since: string | undefined, sessionCount: number) {
    this.since = since;
    this.habits = {
      since,
      totals: { sessions: sessionCount, claudeSessions: 0, codexSessions: 0, costUsd: 0, tokens: 0, workingMs: 0, messages: 0, cacheWasteUsd: 0, cacheExpiries: 0 },
      weeks: [],
      projects: [],
      time: { modelMs: 0, toolMs: 0, waitingOnYouMs: 0, workingMs: 0 },
      failures: [],
      contextTrim: [],
      blocked: [],
      corrections: [],
      compacted: [],
    };
  }

  private inRange(stamp?: string): boolean {
    return !this.since || (stamp !== undefined && stamp >= this.since);
  }

  private addWeek(stamp: string | undefined, sessionId: string, costUsd: number, tokens: number): void {
    if (!stamp) return;
    const key = weekStart(stamp);
    const week = this.weeks.get(key) ?? { week: key, costUsd: 0, tokens: 0, sessions: 0, ids: new Set<string>() };
    week.costUsd += costUsd;
    week.tokens += tokens;
    week.ids.add(sessionId);
    this.weeks.set(key, week);
  }

  private addProject(name: string, costUsd: number, tokens: number, lastAt?: string): void {
    const project = this.projects.get(name) ?? { name, sessions: 0, costUsd: 0, tokens: 0, lastAt };
    project.sessions += 1;
    project.costUsd += costUsd;
    project.tokens += tokens;
    if (lastAt && (!project.lastAt || lastAt > project.lastAt)) project.lastAt = lastAt;
    this.projects.set(name, project);
  }

  private addTrim(kind: TrimKind, name: string, chars: number | undefined, used: boolean): void {
    if (!chars) return;
    const key = `${kind}:${name}`;
    const entry = this.trim.get(key) ?? { kind, name, chars: [], usedIn: 0 };
    entry.chars.push(chars);
    if (used) entry.usedIn += 1;
    this.trim.set(key, entry);
  }

  /** Codex: token totals only, no recorded cost. */
  addCodex(session: Session, index: HabitsInput['index'], title: string, project: string): void {
    this.habits.totals.codexSessions += 1;
    const tokens = session.token.total?.totalTokens ?? 0;
    this.habits.totals.tokens += tokens;
    this.habits.totals.messages += session.taskCount;
    const prompts = index?.docs.filter((doc) => doc.kind === 'prompt') ?? [];
    for (const doc of prompts.slice(1)) {
      if (this.inRange(doc.timestamp) && isCorrection(doc.text)) {
        this.habits.corrections.push({ text: doc.text.trim(), sessionId: session.id, turnId: '', timestamp: doc.timestamp, title });
      }
    }
    this.addWeek(session.updatedAt ?? session.startedAt, session.id, 0, tokens);
    this.addProject(project, 0, tokens, session.updatedAt);
  }

  addClaude(session: Session, view: NonNullable<HabitsInput['view']>, title: string, project: string): void {
    this.habits.totals.claudeSessions += 1;
    let sessionCost = 0;
    let sessionTokens = 0;
    for (const turn of view.turns) {
      if (!this.inRange(turn.startedAt) || this.seenTurns.has(turn.id)) continue;
      this.seenTurns.add(turn.id);
      const tokens = turn.tokens.fresh + turn.tokens.cacheWrite + turn.tokens.cacheRead + turn.tokens.output;
      sessionCost += turn.costUsd ?? 0;
      sessionTokens += tokens;
      this.addTurn(session, turn, title, tokens);
    }

    this.habits.totals.costUsd += sessionCost;
    this.habits.totals.tokens += sessionTokens;
    this.habits.time.modelMs += view.cost?.apiMs ?? 0;
    this.habits.time.toolMs += view.cost?.toolMs ?? 0;
    for (const reset of view.cacheResets) {
      if (reset.reason !== 'expired' || !this.inRange(reset.timestamp)) continue;
      this.habits.totals.cacheExpiries += 1;
      this.habits.totals.cacheWasteUsd += reset.extraUsd ?? 0;
    }
    if (view.compactions) this.habits.compacted.push({ sessionId: session.id, title, count: view.compactions });
    this.addProject(project, sessionCost, sessionTokens, session.updatedAt);

    for (const server of view.mcpServers) this.addTrim('mcp', server.name, server.instructionChars, server.calls > 0);
    this.addTrim('skills', 'Skill list', view.skillListingChars, view.skills.length > 0);
    for (const file of view.instructions) this.addTrim('instructions', file.path, file.chars, true);
  }

  private addTurn(session: Session, turn: Turn, title: string, tokens: number): void {
    this.habits.totals.workingMs += turn.durationMs ?? 0;
    if (turn.prompt) this.habits.totals.messages += 1;
    this.addWeek(turn.startedAt, session.id, turn.costUsd ?? 0, tokens);
    for (const step of turn.steps) {
      if (step.kind === 'tool') this.addToolStep(session, step);
    }
    // The first message of a session sets the task; later short push-backs are corrections.
    if (turn.prompt && turn.index > 0 && isCorrection(turn.prompt.text)) {
      this.habits.corrections.push({ text: turn.prompt.text.trim(), sessionId: session.id, turnId: turn.id, timestamp: turn.prompt.timestamp, title });
    }
  }

  private addToolStep(session: Session, step: ClaudeToolStep): void {
    if (step.name === 'AskUserQuestion' || step.name === 'ExitPlanMode') this.habits.time.waitingOnYouMs += step.durationMs ?? 0;
    if (step.status !== 'error') return;
    const command = step.category === 'shell' ? commandOf(step) : undefined;
    if (command && BLOCKED.test(step.output ?? '')) this.addBlocked(session, step, command);
    else this.addFailure(session, step);
  }

  private addBlocked(session: Session, step: ClaudeToolStep, command: string): void {
    const rule = permissionRule(command);
    const key = rule ?? `${commandPrefix(command)} (chained or risky)`;
    const entry = this.blocked.get(key) ?? { key, rule, count: 0, examples: [], example: { sessionId: session.id, stepId: step.id } };
    entry.count += 1;
    const example = command.split('\n')[0].slice(0, 120);
    if (entry.examples.length < 3 && !entry.examples.includes(example)) entry.examples.push(example);
    this.blocked.set(key, entry);
  }

  private addFailure(session: Session, step: ClaudeToolStep): void {
    const tool = step.server ? `${step.label.split(':')[0]} (${step.server})` : step.name;
    const signature = errorSignature(step.output);
    const key = `${tool}\u0000${signature}`;
    const failure = this.failures.get(key) ?? { tool, signature, count: 0, sessions: 0, costUsd: 0, example: { sessionId: session.id, stepId: step.id }, ids: new Set<string>() };
    failure.count += 1;
    failure.costUsd += step.costUsd ?? 0;
    failure.ids.add(session.id);
    this.failures.set(key, failure);
  }

  finish(): Habits {
    const habits = this.habits;
    habits.time.workingMs = habits.totals.workingMs;
    habits.weeks = [...this.weeks.values()].map(({ ids, ...week }) => ({ ...week, sessions: ids.size })).sort((a, b) => a.week.localeCompare(b.week));
    habits.projects = [...this.projects.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
    habits.failures = [...this.failures.values()]
      .map(({ ids, ...failure }) => ({ ...failure, sessions: ids.size }))
      .filter((failure) => failure.count >= 2)
      .sort((a, b) => b.count - a.count || b.costUsd - a.costUsd)
      .slice(0, 8);
    habits.blocked = [...this.blocked.values()].sort((a, b) => b.count - a.count).slice(0, 10);
    habits.contextTrim = [...this.trim.values()]
      .map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        tokensPerRequest: Math.round(entry.chars.reduce((sum, chars) => sum + chars, 0) / entry.chars.length / CHARS_PER_TOKEN),
        loadedIn: entry.chars.length,
        usedIn: entry.usedIn,
      }))
      // Worth trimming: loaded often, rarely used. Instruction files are always "used", so rank them by size.
      .sort((a, b) => b.tokensPerRequest * (b.loadedIn - b.usedIn + 1) - a.tokensPerRequest * (a.loadedIn - a.usedIn + 1));
    habits.corrections = habits.corrections.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, 12);
    habits.compacted = habits.compacted.sort((a, b) => b.count - a.count).slice(0, 8);
    return habits;
  }
}

export function buildHabits(inputs: HabitsInput[], sinceMs?: number): Habits {
  const since = sinceMs ? new Date(sinceMs).toISOString() : undefined;
  const inRange = (stamp?: string) => !since || (stamp !== undefined && stamp >= since);
  // Sessions with recorded cost go first, so when a resumed copy repeats their turns the costed version is kept.
  const sessions = inputs
    .filter(({ session }) => inRange(session.updatedAt ?? session.startedAt))
    .sort((a, b) => Number(Boolean(b.view?.cost)) - Number(Boolean(a.view?.cost)));
  const accumulator = new HabitsAccumulator(since, sessions.length);
  for (const { session, view, index } of sessions) {
    const title = session.displayTitle.value ?? 'Untitled session';
    const project = session.projectName ?? 'No project';
    if (view) accumulator.addClaude(session, view, title, project);
    else accumulator.addCodex(session, index, title, project);
  }
  return accumulator.finish();
}

export { DAY };
