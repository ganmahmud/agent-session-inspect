import { error } from '@sveltejs/kit';
import { sessionDetail } from '$lib/server/session-data';

export async function GET({ params }) {
	const detail = await sessionDetail(params.id);
	if (!detail) error(404, 'Session not found');

	const shortId = detail.id.slice(0, 8);
	const date = detail.startedAt ? new Date(detail.startedAt).toISOString().slice(0, 10) : 'unknown';
	const filename = `session-${shortId}-${date}.json`;

	const envelope = {
		exportVersion: 1,
		exportedAt: new Date().toISOString(),
		session: detail
	};

	return new Response(JSON.stringify(envelope, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="${filename}"`
		}
	});
}
