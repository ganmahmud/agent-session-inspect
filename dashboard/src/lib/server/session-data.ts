import { statSync } from 'node:fs';
import { parseAgent, readSessionDetail, scanSessions } from '../../../../src/sessions.ts';
import { indexClaudeView, indexDetail, type SessionIndex } from '../../../../src/search.ts';
import {
	childTotals,
	claudeViewFromDetail,
	embedClaudeImages,
	findInsights,
	readClaudeSessionView,
	type ClaudeSessionView
} from '../../../../src/claude-view.ts';
import type {
	ScanResult,
	SessionDetail,
	SessionInventory,
	ReplyActivity,
	TokenSummary
} from '../../../../src/types.ts';
export type { SessionDetail, SessionInventory, ReplyActivity, TokenSummary };

const sessionPath = process.env.ASI_SESSIONS_PATH || undefined;
const agentFilter = parseAgent(process.env.ASI_AGENT);

let cached: { createdAt: number; result: ScanResult } | undefined;

/** In-memory store for imported session data (ephemeral — lost on server restart, capped to prevent leaks). */
const importedSessions = new Map<string, SessionDetail>();
const MAX_IMPORTED_SESSIONS = 10;

/** LRU detail cache for parsed session details to avoid repetitive disk I/O while keeping memory bounded. */
const detailCache = new Map<string, { detail: SessionDetail; accessedAt: number }>();
const MAX_DETAIL_CACHE = 4;

const INVENTORY_CACHE_TTL_MS = 30_000;

export async function sessionInventory(): Promise<ScanResult> {
	if (cached && Date.now() - cached.createdAt < INVENTORY_CACHE_TTL_MS) return cached.result;
	try {
		const result = await scanSessions({ path: sessionPath, agent: agentFilter });
		cached = { createdAt: Date.now(), result };
		return result;
	} catch (err) {
		return {
			schemaVersion: 1,
			provider: agentFilter ?? 'all',
			sessions: [],
			diagnostics: {
				filesRead: 0,
				malformedRecords: 0,
				catalogErrors: [err instanceof Error ? err.message : 'failed to scan sessions']
			}
		};
	}
}

export async function sessionDetail(
	id: string,
	existingInventory?: ScanResult
): Promise<SessionDetail | undefined> {
	// Check imported sessions first
	const imported = importedSessions.get(id);
	if (imported) return imported;

	// Check detail cache
	const cachedEntry = detailCache.get(id);
	if (cachedEntry) {
		cachedEntry.accessedAt = Date.now();
		return cachedEntry.detail;
	}

	const result = existingInventory ?? (await sessionInventory());
	const session = result.sessions.find((item) => item.id === id);
	if (session) {
		const detail = await readSessionDetail(session);
		if (detail) cacheDetail(id, detail);
		return detail;
	}
	return subagentOfParent(id, result);
}

function cacheDetail(id: string, detail: SessionDetail): void {
	if (detailCache.size >= MAX_DETAIL_CACHE) {
		const oldestKey = Array.from(detailCache.entries()).sort(
			(a, b) => a[1].accessedAt - b[1].accessedAt
		)[0]?.[0];
		if (oldestKey) detailCache.delete(oldestKey);
	}
	detailCache.set(id, { detail, accessedAt: Date.now() });
}

/**
 * Finds a session that is a subagent of another via metadata relationships
 * (fast targeted lookup without reading full transcript files for all sessions).
 */
async function subagentOfParent(
	id: string,
	result: ScanResult
): Promise<SessionDetail | undefined> {
	const parentMatch = result.sessions.find((s) =>
		s.relationships?.some((r) => r.type === 'subagent' && r.sessionId === id)
	);
	const parentDetail = parentMatch ? await sessionDetail(parentMatch.id, result) : undefined;
	if (!parentDetail) return undefined;
	const subagents = await getSessionSubagents(parentDetail, result);
	const matchingSub = subagents.find((s) => s.id === id);
	if (matchingSub) importedSessions.set(id, matchingSub);
	return matchingSub;
}

/** Claude views that came with imported sessions; keyed like `importedSessions` and evicted with them. */
const importedClaudeViews = new Map<string, ClaudeSessionView>();

/** Store the Claude view that came with an imported session (call after `importSession`). */
export function importClaudeView(view: ClaudeSessionView): void {
	// Files exported before findings existed carry none; work them out from the turns.
	importedClaudeViews.set(view.id, {
		...view,
		insights: view.insights ?? findInsights(view),
		imported: true
	});
}

/** Store an imported session in the in-memory map and return its inventory entry. */
export function importSession(detail: SessionDetail): SessionInventory {
	if (importedSessions.size >= MAX_IMPORTED_SESSIONS) {
		const oldestKey = importedSessions.keys().next().value;
		if (oldestKey) {
			importedSessions.delete(oldestKey);
			importedClaudeViews.delete(oldestKey);
		}
	}
	importedSessions.set(detail.id, detail);
	// Synthesize a SessionInventory from the full detail for the sidebar
	const inv = { ...detail } as Record<string, unknown>;
	delete inv.conversation;
	delete inv.usage;
	delete inv.debug;
	if (!inv.token || !(inv.token as TokenSummary).last) {
		inv.token = detail.token;
	}
	return inv as unknown as SessionInventory;
}

/** Return all imported session inventory entries. */
export function getImportedSessionIds(): string[] {
	return Array.from(importedSessions.keys());
}

/** Remove an imported session from memory. */
export function deleteImportedSession(id: string): boolean {
	detailCache.delete(id);
	importedClaudeViews.delete(id);
	return importedSessions.delete(id);
}

const MAX_SUBAGENT_TEXT = 50_000;

function emptyDebug(): SessionDetail['debug'] {
	return { hiddenMessages: [], unattachedActivities: [], malformedRecords: 0, unknownRecords: 0 };
}

/** A subagent known only from the inventory: its totals without a conversation. */
function inventoryStub(inv: SessionInventory): SessionDetail {
	return {
		...inv,
		conversation: [],
		usage: {
			snapshots: [],
			modelStepTotal: inv.token?.last ?? inv.token?.total ?? {},
			modelStepCount: 0,
			evidence: 'reported_snapshot'
		},
		debug: emptyDebug()
	};
}

function payloadText(value: unknown, fallback: string): string {
	if (!value) return fallback;
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	return text.length > MAX_SUBAGENT_TEXT
		? text.slice(0, MAX_SUBAGENT_TEXT) + '... [truncated]'
		: text;
}

type ConversationEntry = SessionDetail['conversation'][number];
type ToolCall = NonNullable<ConversationEntry['activity']>['tools'][number];

/** A subagent invoked inline as a tool call, rebuilt as a two-message session with estimated tokens. */
function inlineSubagent(
	session: SessionDetail,
	message: ConversationEntry,
	t: ToolCall,
	subId: string
): SessionDetail {
	const subName = t.name.startsWith('subagent:') ? t.name : `subagent:${t.name}`;
	const inputText = payloadText(t.input, `Delegated task for ${subName}`);
	const outputText = payloadText(
		t.output,
		`Completed subagent execution with status: ${t.status ?? 'completed'}`
	);
	const inTokens = Math.max(1, Math.ceil(inputText.length / 4));
	const outTokens = Math.max(1, Math.ceil(outputText.length / 4));
	const usage = {
		inputTokens: inTokens,
		outputTokens: outTokens,
		totalTokens: inTokens + outTokens
	};
	const source = t.source ?? { file: 'inline', line: 1 };
	const startedAt = t.startedAt ?? message.timestamp;
	const completedAt = t.completedAt ?? message.timestamp;

	return {
		id: t.id || subId,
		displayTitle: { value: subName, source: 'session_event' },
		sourceFiles: session.sourceFiles ?? [],
		cliVersions: session.cliVersions ?? [],
		agent: session.agent,
		startedAt,
		updatedAt: completedAt,
		cwd: session.cwd,
		provider: session.provider,
		recordCount: 2,
		malformedRecords: 0,
		unknownRecords: 0,
		eventCounts: { sub_agent_activity: 1 },
		taskCount: 1,
		completedTaskCount: 1,
		abortedTaskCount: 0,
		compactionCount: 0,
		rollbackCount: 0,
		conversation: [
			{
				id: `${t.id}-task`,
				role: 'user',
				kind: 'conversation' as const,
				timestamp: startedAt,
				text: inputText,
				source
			},
			{
				id: `${t.id}-result`,
				role: 'assistant',
				kind: 'conversation' as const,
				timestamp: completedAt,
				text: outputText,
				activity: {
					association: 'source_order' as const,
					breakdown: {
						durationMs: t.durationMs ?? 0,
						measuredToolMs: t.durationMs ?? 0,
						otherElapsedMs: 0,
						source: 'timestamps' as const,
						explanation: 'Measured subagent execution'
					},
					tools: [t],
					edits: [],
					modelRequests: [
						{
							id: `${t.id}-req`,
							timestamp: completedAt,
							usage: { ...usage },
							evidence: 'reported_snapshot' as const,
							source
						}
					],
					model: {
						name: session.agent === 'claude' ? 'claude-subagent' : 'codex-subagent',
						source: 'thread_settings' as const
					}
				},
				source
			}
		],
		usage: {
			snapshots: [
				{
					id: `${t.id}-snap`,
					timestamp: completedAt,
					usage: { ...usage },
					modelContextWindow: 200_000,
					evidence: 'reported_snapshot' as const,
					source
				}
			],
			modelStepTotal: { ...usage },
			modelStepCount: 1,
			evidence: 'reported_snapshot' as const
		},
		token: {
			last: { ...usage },
			total: { ...usage },
			observations: 1,
			missingUsageObservations: 0
		},
		tools: { calls: 1, outputs: 1, execCompleted: 0, mcpCompleted: 0 },
		relationships: [{ type: 'parent', sessionId: session.id }],
		debug: emptyDebug()
	};
}

/** Subagents invoked inline as tool calls in the session's conversation, skipping ones already found. */
function inlineSubagents(session: SessionDetail, known: SessionDetail[]): SessionDetail[] {
	const found: SessionDetail[] = [];
	for (const m of session.conversation) {
		for (const t of m.activity?.tools ?? []) {
			if (t.kind !== 'subagent' && !t.name.startsWith('subagent:')) continue;
			const subId = t.name.replace(/^subagent:/, '') || t.id;
			const seen = [...known, ...found].some((s) => s.id === subId || s.id === t.id);
			if (!seen) found.push(inlineSubagent(session, m, t, subId));
		}
	}
	return found;
}

/** Look up all subagents for a session by direct and inverse relationships, and inline activity. */
export async function getSessionSubagents(
	session: SessionDetail | SessionInventory,
	existingInventory?: ScanResult
): Promise<SessionDetail[]> {
	const result = existingInventory ?? (await sessionInventory());

	// Direct subagent relationships
	const directSubagentIds = (session.relationships || [])
		.filter((r) => r.type === 'subagent')
		.map((r) => r.sessionId);

	// Inverse parent relationships (sessions pointing to this session as parent)
	const childSessionIds = result.sessions
		.filter((s) => s.relationships?.some((r) => r.type === 'parent' && r.sessionId === session.id))
		.map((s) => s.id);

	const subagentDetails: SessionDetail[] = [];
	for (const subId of new Set([...directSubagentIds, ...childSessionIds])) {
		if (subId === session.id) continue;
		const inv = result.sessions.find((s) => s.id === subId);
		const detail = inv ? inventoryStub(inv) : importedSessions.get(subId);
		if (detail) subagentDetails.push(detail);
	}

	if ('conversation' in session && Array.isArray(session.conversation)) {
		subagentDetails.push(...inlineSubagents(session, subagentDetails));
	}
	return subagentDetails;
}

const claudeViewCache = new Map<string, { updatedAt?: string; view: ClaudeSessionView }>();
const MAX_CLAUDE_VIEW_CACHE = 4;

/** True when a session is a Claude Code transcript on this machine (imports carry no transcript to re-read). */
export function isLocalClaudeSession(session?: SessionInventory): boolean {
	return session?.agent === 'claude' && !importedSessions.has(session.id);
}

/** True for any Claude Code session, local or imported: these open in the Claude view. */
export function isClaudeSession(id: string, session?: SessionInventory): boolean {
	return importedSessions.get(id)?.agent === 'claude' || session?.agent === 'claude';
}

/** Claude Code–specific view of a session, for the /claude route. */
export async function claudeSessionView(id: string): Promise<ClaudeSessionView | undefined> {
	const imported = importedSessions.get(id);
	if (imported) {
		if (imported.agent !== 'claude') return undefined;
		// Exports written before Claude views were included are converted from the generic detail.
		const view = importedClaudeViews.get(id) ?? {
			...claudeViewFromDetail(imported),
			imported: true
		};
		importedClaudeViews.set(id, view);
		return view;
	}
	const result = await sessionInventory();
	const session = result.sessions.find((item) => item.id === id);
	if (!session || !isLocalClaudeSession(session)) return undefined;
	// Keyed on the files themselves, not the 30-second inventory cache, so a live session updates promptly.
	const stamp = transcriptStamp(session.sourceFiles).stamp;
	const cachedView = claudeViewCache.get(id);
	if (cachedView && cachedView.updatedAt === stamp) return cachedView.view;
	const children = result.sessions
		.filter((item) => item.relationships?.some((r) => r.type === 'parent' && r.sessionId === id))
		.map((item) => item.id);
	const view = await readClaudeSessionView(session, children);
	// Roll each subagent transcript's totals up into the parent's subagent list.
	for (const sub of view.subagents) {
		const child = sub.sessionId && result.sessions.find((item) => item.id === sub.sessionId);
		if (child) sub.totals = childTotals(await readClaudeSessionView(child));
	}
	claudeViewCache.delete(id);
	if (claudeViewCache.size >= MAX_CLAUDE_VIEW_CACHE) {
		const oldest = claudeViewCache.keys().next().value;
		if (oldest) claudeViewCache.delete(oldest);
	}
	claudeViewCache.set(id, { updatedAt: stamp, view });
	return view;
}

/** The Claude view of a local session with screenshots inlined, for a self-contained export file. */
export async function exportableClaudeView(id: string): Promise<ClaudeSessionView | undefined> {
	const view = await claudeSessionView(id);
	if (!view) return undefined;
	if (view.imported) return view;
	const session = (await sessionInventory()).sessions.find((item) => item.id === id);
	return session ? embedClaudeImages(view, session.sourceFiles) : view;
}

/** Per-session search index and Claude view, rebuilt only when a session's transcript changes. */
const sessionFacts = new Map<
	string,
	{ updatedAt?: string; index: SessionIndex; view?: ClaudeSessionView }
>();

export interface SessionFacts {
	session: SessionInventory;
	index: SessionIndex;
	/** Claude view for Claude Code sessions, used by cross-session analysis. */
	view?: ClaudeSessionView;
}

let factsInFlight: Promise<SessionFacts[]> | undefined;

/**
 * Search index and Claude views for every session (local and imported). Subagent transcripts are skipped.
 * Concurrent callers share one build, so a background warm-up and a search don't read every transcript twice.
 */
export function allSessionFacts(): Promise<SessionFacts[]> {
	factsInFlight ??= buildSessionFacts().finally(() => (factsInFlight = undefined));
	return factsInFlight;
}

async function readFacts(
	session: SessionInventory
): Promise<{ index: SessionIndex; view?: ClaudeSessionView }> {
	if (session.agent !== 'claude') {
		const detail = importedSessions.get(session.id) ?? (await readSessionDetail(session));
		return { index: indexDetail(detail) };
	}
	const view = importedSessions.has(session.id)
		? await claudeSessionView(session.id)
		: await readClaudeSessionView(session);
	return { index: view ? indexClaudeView(view) : { docs: [], edits: [] }, view };
}

async function buildSessionFacts(): Promise<SessionFacts[]> {
	const result = await sessionInventory();
	const sessions = [
		...result.sessions,
		...[...importedSessions.values()].filter(
			(detail) => !result.sessions.some((s) => s.id === detail.id)
		)
	];
	const facts: SessionFacts[] = [];
	for (const session of sessions) {
		if (session.relationships?.some((r) => r.type === 'parent')) continue;
		const cached = sessionFacts.get(session.id);
		if (cached && cached.updatedAt === session.updatedAt) {
			facts.push({ session, index: cached.index, view: cached.view });
			continue;
		}
		try {
			const { index, view } = await readFacts(session);
			sessionFacts.set(session.id, { updatedAt: session.updatedAt, index, view });
			facts.push({ session, index, view });
		} catch {
			// An unreadable transcript is left out of search rather than failing the whole page.
		}
	}
	return facts;
}

/** Size and modification time of a session's transcript files; changes whenever Claude Code writes to them. */
export function transcriptStamp(files: string[]): { stamp: string; modifiedAt?: string } {
	let latest = 0;
	const parts: string[] = [];
	for (const file of files) {
		try {
			const stat = statSync(file);
			parts.push(`${stat.size}:${stat.mtimeMs}`);
			latest = Math.max(latest, stat.mtimeMs);
		} catch {
			parts.push('missing');
		}
	}
	return {
		stamp: parts.join('|'),
		modifiedAt: latest ? new Date(latest).toISOString() : undefined
	};
}

/** Change stamp for a local Claude Code session, polled by the page to follow a session that is still running. */
export async function claudeSessionStamp(
	id: string
): Promise<{ stamp: string; modifiedAt?: string } | undefined> {
	if (importedSessions.has(id)) return undefined;
	const session = (await sessionInventory()).sessions.find((item) => item.id === id);
	return session?.agent === 'claude' ? transcriptStamp(session.sourceFiles) : undefined;
}
