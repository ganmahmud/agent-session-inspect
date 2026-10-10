import { json, error } from '@sveltejs/kit';
import { importClaudeView, importSession } from '$lib/server/session-data';
import type { SessionDetail, ReplyActivity } from '$lib/server/session-data';
import {
	viewFromTurns,
	type ClaudeSessionView,
	type ClaudeTurn
} from '../../../../../../src/claude-view.ts';

interface MessageEnvelope {
	exportVersion: number;
	exportedAt?: string;
	sessionId?: string;
	sessionTitle?: string;
	message?: {
		id: string;
		role: string;
		kind: string;
		timestamp?: string;
		text: string;
		phase?: string;
		activity?: unknown;
	};
}

interface SessionEnvelope {
	exportVersion: number;
	session?: SessionDetail;
	/** Claude Code layout of `session`, present in exports of Claude Code sessions. */
	claudeView?: ClaudeSessionView;
}

/** Messages picked out of a Claude Code session, exported from the Claude view. */
interface ClaudeTurnsEnvelope {
	exportVersion: number;
	agent?: string;
	sessionId?: string;
	sessionTitle?: string;
	cwd?: string;
	/** User messages plus Claude replies picked; one turn can hold both. */
	selectedCount?: number;
	claudeTurns?: ClaudeTurn[];
}

/** Generic session detail for imported Claude turns, so the sidebar and the shared page can list them. */
function detailFromTurns(id: string, title: string, view: ClaudeSessionView): SessionDetail {
	const conversation: SessionDetail['conversation'] = view.turns.flatMap((turn) => {
		const entries: SessionDetail['conversation'] = [];
		if (turn.prompt) {
			entries.push({
				id: `${turn.id}-user`,
				role: 'user',
				kind: 'conversation',
				timestamp: turn.prompt.timestamp,
				text: turn.prompt.text,
				source: { file: 'imported', line: 0 }
			});
		}
		const answer = turn.steps.flatMap((step) => (step.kind === 'text' ? [step.text] : []));
		if (answer.length) {
			entries.push({
				id: `${turn.id}-claude`,
				role: 'assistant',
				kind: 'conversation',
				timestamp: turn.endedAt,
				text: answer.join('\n\n'),
				source: { file: 'imported', line: 0 }
			});
		}
		return entries;
	});
	const total =
		view.tokens.fresh + view.tokens.cacheWrite + view.tokens.cacheRead + view.tokens.output;
	return {
		id,
		agent: 'claude',
		displayTitle: { value: title, source: 'session_event' },
		sourceFiles: [],
		startedAt: view.startedAt,
		updatedAt: view.endedAt,
		cwd: view.cwd,
		projectName: view.projectName,
		provider: 'anthropic',
		cliVersions: view.versions,
		recordCount: conversation.length,
		malformedRecords: 0,
		unknownRecords: 0,
		eventCounts: {},
		token: {
			total: { totalTokens: total, outputTokens: view.tokens.output },
			observations: view.tokens.requests,
			missingUsageObservations: 0
		},
		tools: {
			calls: Object.values(view.toolCounts).reduce((a, b) => a + b, 0),
			outputs: 0,
			execCompleted: 0,
			mcpCompleted: 0
		},
		taskCount: view.turns.filter((turn) => turn.prompt).length,
		completedTaskCount: 0,
		abortedTaskCount: view.interruptions,
		compactionCount: view.compactions,
		rollbackCount: 0,
		relationships: [],
		conversation,
		usage: {
			snapshots: [],
			modelStepTotal: {},
			modelStepCount: view.tokens.requests,
			evidence: 'reported_snapshot'
		},
		debug: { hiddenMessages: [], unattachedActivities: [], malformedRecords: 0, unknownRecords: 0 }
	};
}

type ImportEnvelope = MessageEnvelope & SessionEnvelope & ClaudeTurnsEnvelope;

/** Random lowercase id fragment for synthetic imported sessions; not security-sensitive. */
function randomId(length: number): string {
	return crypto.randomUUID().replaceAll('-', '').slice(0, length);
}

function importFullSession(envelope: ImportEnvelope, source: SessionDetail) {
	const session = { ...source };
	// Sort conversation messages by timestamp ascending
	session.conversation = [...session.conversation].sort(
		(a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime()
	);
	const inventory = importSession(session);
	if (session.agent === 'claude' && envelope.claudeView?.id === session.id) {
		importClaudeView(envelope.claudeView);
	}
	const title = inventory.displayTitle?.value ?? 'Untitled session';
	return json({ id: inventory.id, title });
}

/** Messages selected from a Claude Code session: rebuild them as a small Claude session. */
function importClaudeTurns(
	envelope: ImportEnvelope,
	turns: NonNullable<ImportEnvelope['claudeTurns']>
) {
	const id = `imp-claude-${randomId(8)}`;
	const count = envelope.selectedCount ?? turns.length;
	const noun = count === 1 ? 'message' : 'messages';
	const title = `[${count} ${noun}] ${envelope.sessionTitle ?? 'Claude Code session'}`;
	const view = viewFromTurns(
		{ id, title, cwd: envelope.cwd },
		turns.map((turn) => ({ ...turn, steps: turn.steps ?? [] }))
	);
	importSession(detailFromTurns(id, title, view));
	importClaudeView(view);
	return json({ id, title });
}

function activityUsage(activity?: ReplyActivity) {
	const totals = { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
	for (const req of activity?.modelRequests ?? []) {
		const u = (req.usage || req) as {
			totalTokens?: number;
			inputTokens?: number;
			outputTokens?: number;
		};
		totals.totalTokens += u.totalTokens ?? 0;
		totals.inputTokens += u.inputTokens ?? 0;
		totals.outputTokens += u.outputTokens ?? 0;
	}
	return totals;
}

/** Single message import — wrap into minimal SessionDetail */
function importMessage(envelope: ImportEnvelope, msg: NonNullable<ImportEnvelope['message']>) {
	const cleanHash = randomId(16);
	const syntheticId = `imp-msg-${cleanHash}`;
	const roleLabel = msg.role === 'assistant' ? 'Agent' : 'User';
	const titleText = `[${roleLabel} msg] ${envelope.sessionTitle || msg.text.slice(0, 60)}`;

	const activity = msg.activity as ReplyActivity | undefined;
	const usage = activityUsage(activity);
	const toolCallsCount = activity?.tools?.length ?? 0;
	const fallbackObservations = usage.totalTokens > 0 ? 1 : 0;
	const observations = activity?.modelRequests?.length ?? fallbackObservations;
	const snapshot =
		usage.totalTokens > 0
			? {
					id: `snap-${cleanHash}`,
					timestamp: msg.timestamp,
					usage,
					source: { file: 'imported', line: 0 },
					evidence: 'reported_snapshot' as const
				}
			: undefined;

	const syntheticSession: SessionDetail = {
		id: syntheticId,
		displayTitle: { value: titleText, source: 'session_event' },
		sourceFiles: [],
		cliVersions: [],
		recordCount: 1,
		malformedRecords: 0,
		unknownRecords: 0,
		eventCounts: {},
		token: {
			total: { ...usage },
			last: { ...usage },
			observations,
			missingUsageObservations: 0
		},
		tools: { calls: toolCallsCount, outputs: toolCallsCount, execCompleted: 0, mcpCompleted: 0 },
		taskCount: 0,
		completedTaskCount: 0,
		abortedTaskCount: 0,
		compactionCount: 0,
		rollbackCount: 0,
		relationships: [],
		startedAt: msg.timestamp,
		conversation: [
			{
				id: msg.id,
				role: msg.role as 'user' | 'assistant',
				kind: (msg.kind as 'conversation' | 'internal_review') ?? 'conversation',
				timestamp: msg.timestamp,
				text: msg.text,
				phase: msg.phase,
				source: { file: 'imported', line: 0 },
				activity
			}
		],
		usage: {
			latest: snapshot,
			snapshots: snapshot ? [snapshot] : [],
			modelStepTotal: { ...usage },
			modelStepCount: observations,
			evidence: 'reported_snapshot'
		},
		debug: {
			hiddenMessages: [],
			unattachedActivities: [],
			malformedRecords: 0,
			unknownRecords: 0
		}
	};

	const inventory = importSession(syntheticSession);
	return json({ id: inventory.id, title: titleText });
}

export async function POST({ request }) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON body');
	}

	const envelope = body as ImportEnvelope;

	if (!envelope || typeof envelope !== 'object') {
		error(400, 'Expected a JSON object');
	}

	if (envelope.exportVersion !== 1) {
		error(400, 'Unsupported or missing exportVersion. Expected exportVersion: 1.');
	}

	if (envelope.session?.id && Array.isArray(envelope.session.conversation)) {
		return importFullSession(envelope, envelope.session);
	}
	if (Array.isArray(envelope.claudeTurns) && envelope.claudeTurns.length) {
		return importClaudeTurns(envelope, envelope.claudeTurns);
	}
	if (envelope.message?.id && envelope.message.text) {
		return importMessage(envelope, envelope.message);
	}

	error(400, 'Invalid import: expected a "session", "message" or "claudeTurns" field.');
}
