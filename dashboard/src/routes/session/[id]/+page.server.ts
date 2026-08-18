import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sessionDetail, getSessionSubagents } from '$lib/server/session-data';

export const load: PageServerLoad = async ({ params }) => {
	try {
		const detail = await sessionDetail(params.id);
		if (!detail) {
			error(404, `Session not found: ${params.id}`);
		}
		const subagents = await getSessionSubagents(detail);
		return { detail, subagents };
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) {
			throw err;
		}
		error(404, `Session not found: ${params.id}`);
	}
};
