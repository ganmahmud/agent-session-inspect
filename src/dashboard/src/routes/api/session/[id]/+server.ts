import { json, error } from '@sveltejs/kit';
import { sessionDetail } from '$lib/server/session-data';

export async function GET({ params }) {
	const detail = await sessionDetail(params.id);
	if (!detail) error(404, 'Session not found');
	return json(detail);
}
