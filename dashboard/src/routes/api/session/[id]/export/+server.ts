import { error } from '@sveltejs/kit';
import { exportableClaudeView, sessionDetail } from '$lib/server/session-data';

export async function GET({ params }) {
	const detail = await sessionDetail(params.id);
	if (!detail) error(404, 'Session not found');

	const shortId = detail.id.slice(0, 8);
	const date = detail.startedAt ? new Date(detail.startedAt).toISOString().slice(0, 10) : 'unknown';
	const filename = `session-${shortId}-${date}.json`;

	// Claude Code exports also carry the Claude view (with screenshots) so imports keep that layout.
	const claudeView = detail.agent === 'claude' ? await exportableClaudeView(detail.id) : undefined;
	const envelope = {
		exportVersion: 1,
		exportedAt: new Date().toISOString(),
		session: detail,
		...(claudeView ? { claudeView } : {})
	};

	return new Response(JSON.stringify(envelope, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="${filename}"`
		}
	});
}
