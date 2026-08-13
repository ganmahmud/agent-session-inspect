import { json, error } from '@sveltejs/kit';
import { importSession } from '$lib/server/session-data';
import type { SessionDetail, ReplyActivity } from '$lib/server/session-data';

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
}

export async function POST({ request }) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON body');
	}

	const envelope = body as MessageEnvelope & SessionEnvelope;

	if (!envelope || typeof envelope !== 'object') {
		error(400, 'Expected a JSON object');
	}

	if (envelope.exportVersion !== 1) {
		error(400, 'Unsupported or missing exportVersion. Expected exportVersion: 1.');
	}

	// Full session import
	if (envelope.session && envelope.session.id && Array.isArray(envelope.session.conversation)) {
		const inventory = importSession(envelope.session);
		const title = inventory.displayTitle?.value ?? 'Untitled session';
		return json({ id: inventory.id, title });
	}

	// Single message import — wrap into minimal SessionDetail
	if (envelope.message && envelope.message.id && envelope.message.text) {
		const msg = envelope.message;
		const cleanHash = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
		const syntheticId = `imp-msg-${cleanHash}`;
		const roleLabel = msg.role === 'assistant' ? 'Agent' : 'User';
		const titleText = envelope.sessionTitle
			? `[${roleLabel} msg] ${envelope.sessionTitle}`
			: `[${roleLabel} msg] ${msg.text.slice(0, 60)}`;

		const activity = msg.activity as ReplyActivity | undefined;
		let totalTokens = 0;
		let inputTokens = 0;
		let outputTokens = 0;

		if (activity?.modelRequests?.length) {
			for (const req of activity.modelRequests) {
				const u = (req.usage || req) as { totalTokens?: number; inputTokens?: number; outputTokens?: number };
				totalTokens += u.totalTokens ?? 0;
				inputTokens += u.inputTokens ?? 0;
				outputTokens += u.outputTokens ?? 0;
			}
		}

		const toolCallsCount = activity?.tools?.length ?? 0;

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
				total: { totalTokens, inputTokens, outputTokens },
				last: { totalTokens, inputTokens, outputTokens },
				observations: activity?.modelRequests?.length ?? (totalTokens > 0 ? 1 : 0),
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
				latest: totalTokens > 0 ? {
					id: `snap-${cleanHash}`,
					timestamp: msg.timestamp,
					usage: { totalTokens, inputTokens, outputTokens },
					source: { file: 'imported', line: 0 },
					evidence: 'reported_snapshot'
				} : undefined,
				snapshots: totalTokens > 0 ? [{
					id: `snap-${cleanHash}`,
					timestamp: msg.timestamp,
					usage: { totalTokens, inputTokens, outputTokens },
					source: { file: 'imported', line: 0 },
					evidence: 'reported_snapshot'
				}] : [],
				modelStepTotal: { totalTokens, inputTokens, outputTokens },
				modelStepCount: activity?.modelRequests?.length ?? (totalTokens > 0 ? 1 : 0),
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

	error(400, 'Invalid import: expected a "session" or "message" field.');
}
