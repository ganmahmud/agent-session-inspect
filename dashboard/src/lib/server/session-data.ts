import { join } from 'node:path';
import { readCodexCatalog } from '../../../../src/catalog.ts';
import { scanCodex } from '../../../../src/codex.ts';
import { readCodexSessionDetail } from '../../../../src/detail.ts';
import type { ScanResult, SessionDetail, SessionInventory, ReplyActivity, TokenSummary } from '../../../../src/types.ts';
export type { SessionDetail, SessionInventory, ReplyActivity, TokenSummary };

const codexHome = process.env.CODEX_HOME || join(process.env.HOME || '', '.codex');
const sessionPath = process.env.ASI_SESSIONS_PATH || join(codexHome, 'sessions');
const catalogPaths = [codexHome, join(codexHome, 'sqlite')];

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
		const catalog = readCodexCatalog(catalogPaths);
		const result = await scanCodex(sessionPath, { catalogTitles: catalog.titles, catalogErrors: catalog.errors });
		cached = { createdAt: Date.now(), result };
		return result;
	} catch (err) {
		return {
			schemaVersion: 1,
			provider: 'codex',
			sessions: [],
			diagnostics: {
				filesRead: 0,
				malformedRecords: 0,
				catalogErrors: [err instanceof Error ? err.message : 'failed to scan sessions']
			}
		};
	}
}

export async function sessionDetail(id: string, existingInventory?: ScanResult): Promise<SessionDetail | undefined> {
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
		const detail = await readCodexSessionDetail(session);
		if (detail) {
			if (detailCache.size >= MAX_DETAIL_CACHE) {
				const oldestKey = Array.from(detailCache.entries())
					.sort((a, b) => a[1].accessedAt - b[1].accessedAt)[0]?.[0];
				if (oldestKey) detailCache.delete(oldestKey);
			}
			detailCache.set(id, { detail, accessedAt: Date.now() });
		}
		return detail;
	}

	// If not found directly, check if this ID is a subagent of any session via metadata relationships
	// (Fast targeted lookup without reading full transcript files for all sessions)
	const parentMatch = result.sessions.find((s) =>
		s.relationships?.some((r) => r.type === 'subagent' && r.sessionId === id)
	);
	if (parentMatch) {
		const parentDetail = await sessionDetail(parentMatch.id, result);
		if (parentDetail) {
			const subagents = await getSessionSubagents(parentDetail, result);
			const matchingSub = subagents.find((s) => s.id === id);
			if (matchingSub) {
				importedSessions.set(id, matchingSub);
				return matchingSub;
			}
		}
	}

	return undefined;
}

/** Store an imported session in the in-memory map and return its inventory entry. */
export function importSession(detail: SessionDetail): SessionInventory {
	if (importedSessions.size >= MAX_IMPORTED_SESSIONS) {
		const oldestKey = importedSessions.keys().next().value;
		if (oldestKey) importedSessions.delete(oldestKey);
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
	return importedSessions.delete(id);
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
		.filter((s) => s.relationships && s.relationships.some((r) => r.type === 'parent' && r.sessionId === session.id))
		.map((s) => s.id);

	const allSubagentIds = Array.from(new Set([...directSubagentIds, ...childSessionIds]));
	const subagentDetails: SessionDetail[] = [];

	for (const subId of allSubagentIds) {
		if (subId === session.id) continue;
		const inv = result.sessions.find((s) => s.id === subId);
		if (inv) {
			subagentDetails.push({
				...inv,
				conversation: [],
				usage: {
					snapshots: [],
					modelStepTotal: inv.token?.last ?? inv.token?.total ?? {},
					modelStepCount: 0,
					evidence: 'reported_snapshot'
				},
				debug: { hiddenMessages: [], unattachedActivities: [], malformedRecords: 0, unknownRecords: 0 }
			});
		} else {
			const imported = importedSessions.get(subId);
			if (imported) {
				subagentDetails.push(imported);
			}
		}
	}

	// Also extract inline subagent invocations from conversation if session is SessionDetail
	if ('conversation' in session && Array.isArray(session.conversation)) {
		for (const m of session.conversation) {
			for (const t of m.activity?.tools ?? []) {
				if (t.kind === 'subagent' || t.name.startsWith('subagent:')) {
					const subId = t.name.replace(/^subagent:/, '') || t.id;
					if (!subagentDetails.some((s) => s.id === subId || s.id === t.id)) {
						const subName = t.name.startsWith('subagent:') ? t.name : `subagent:${t.name}`;
						let inputText = t.input
							? typeof t.input === 'string'
								? t.input
								: JSON.stringify(t.input, null, 2)
							: `Delegated task for ${subName}`;
						if (inputText.length > 50_000) {
							inputText = inputText.slice(0, 50_000) + '... [truncated]';
						}
						let outputText = t.output
							? typeof t.output === 'string'
								? t.output
								: JSON.stringify(t.output, null, 2)
							: `Completed subagent execution with status: ${t.status ?? 'completed'}`;
						if (outputText.length > 50_000) {
							outputText = outputText.slice(0, 50_000) + '... [truncated]';
						}
						const inTokens = Math.max(1, Math.ceil(inputText.length / 4));
						const outTokens = Math.max(1, Math.ceil(outputText.length / 4));
						const totalTok = inTokens + outTokens;

						subagentDetails.push({
							id: t.id || subId,
							displayTitle: { value: subName, source: 'session_event' },
							sourceFiles: session.sourceFiles ?? [],
							cliVersions: session.cliVersions ?? [],
							startedAt: t.startedAt ?? m.timestamp,
							updatedAt: t.completedAt ?? m.timestamp,
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
									timestamp: t.startedAt ?? m.timestamp,
									text: inputText,
									source: t.source ?? { file: 'inline', line: 1 }
								},
								{
									id: `${t.id}-result`,
									role: 'assistant',
									kind: 'conversation' as const,
									timestamp: t.completedAt ?? m.timestamp,
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
												timestamp: t.completedAt ?? m.timestamp,
												usage: {
													inputTokens: inTokens,
													outputTokens: outTokens,
													totalTokens: totalTok
												},
												evidence: 'reported_snapshot' as const,
												source: t.source ?? { file: 'inline', line: 1 }
											}
										],
										model: { name: 'codex-subagent', source: 'thread_settings' as const }
									},
									source: t.source ?? { file: 'inline', line: 1 }
								}
							],
							usage: {
								snapshots: [
									{
										id: `${t.id}-snap`,
										timestamp: t.completedAt ?? m.timestamp,
										usage: {
											inputTokens: inTokens,
											outputTokens: outTokens,
											totalTokens: totalTok
										},
										modelContextWindow: 200_000,
										evidence: 'reported_snapshot' as const,
										source: t.source ?? { file: 'inline', line: 1 }
									}
								],
								modelStepTotal: {
									inputTokens: inTokens,
									outputTokens: outTokens,
									totalTokens: totalTok
								},
								modelStepCount: 1,
								evidence: 'reported_snapshot' as const
							},
							token: {
								last: {
									inputTokens: inTokens,
									outputTokens: outTokens,
									totalTokens: totalTok
								},
								total: {
									inputTokens: inTokens,
									outputTokens: outTokens,
									totalTokens: totalTok
								},
								observations: 1,
								missingUsageObservations: 0
							},
							tools: { calls: 1, outputs: 1, execCompleted: 0, mcpCompleted: 0 },
							relationships: [{ type: 'parent', sessionId: session.id }],
							debug: { hiddenMessages: [], unattachedActivities: [], malformedRecords: 0, unknownRecords: 0 }
						});
					}
				}
			}
		}
	}

	return subagentDetails;
}

