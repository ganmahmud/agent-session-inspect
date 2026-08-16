import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sessionDetail, getSessionSubagents } from '$lib/server/session-data';

export const load: PageServerLoad = async ({ params }) => {
	const detail = await sessionDetail(params.id);
	if (!detail) {
		error(404, 'Session not found');
	}
	const subagents = await getSessionSubagents(detail);
	return { detail, subagents };
};

