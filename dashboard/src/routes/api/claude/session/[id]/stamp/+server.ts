import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { claudeSessionStamp } from '$lib/server/session-data';

/** Cheap change check for a running session: file sizes and times only, no parsing. */
export const GET: RequestHandler = async ({ params }) => {
	const stamp = await claudeSessionStamp(params.id);
	if (!stamp) error(404, 'Local Claude Code session not found.');
	return json(stamp, { headers: { 'cache-control': 'no-store' } });
};
