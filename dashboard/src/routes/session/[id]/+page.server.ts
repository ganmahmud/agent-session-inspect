import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
	sessionDetail,
	getSessionSubagents,
	sessionInventory,
	isClaudeSession
} from '$lib/server/session-data';

export const load: PageServerLoad = async ({ params, url }) => {
	// Claude Code sessions (local or imported) have their own view; `?view=analytics` keeps the shared token analytics page.
	if (url.searchParams.get('view') !== 'analytics') {
		const inventory = await sessionInventory();
		const session = inventory.sessions.find((item) => item.id === params.id);
		if (isClaudeSession(params.id, session)) redirect(307, `/claude/session/${params.id}`);
	}
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
