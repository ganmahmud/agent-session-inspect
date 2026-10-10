import type { PageServerLoad } from './$types';
import { allSessionFacts } from '$lib/server/session-data';
import { fileHistories } from '../../../../src/search.ts';

export const load: PageServerLoad = async ({ url }) => {
	const query = url.searchParams.get('q')?.trim() ?? '';
	const facts = await allSessionFacts();
	const files = fileHistories(
		facts.map((f) => f.index),
		query
	);
	const titles = Object.fromEntries(
		facts.map((f) => [
			f.session.id,
			{
				title: f.session.displayTitle.value ?? 'Untitled session',
				agent: f.session.agent ?? 'codex'
			}
		])
	);
	return { query, files, titles, home: process.env.HOME ?? '' };
};
