import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { claudeSessionStamp, claudeSessionView, sessionDetail } from '$lib/server/session-data';

export const load: PageServerLoad = async ({ params }) => {
	const view = await claudeSessionView(params.id);
	if (view) return { view, stamp: await claudeSessionStamp(params.id) };
	// Codex sessions (and unknown imports) use the shared page.
	if (await sessionDetail(params.id)) redirect(307, `/session/${params.id}?view=analytics`);
	error(404, `Claude Code session not found: ${params.id}`);
};
