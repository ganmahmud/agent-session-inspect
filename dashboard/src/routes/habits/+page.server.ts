import type { PageServerLoad } from './$types';
import { allSessionFacts } from '$lib/server/session-data';
import { buildHabits, DAY } from '../../../../src/habits.ts';

export const load: PageServerLoad = async ({ url }) => {
	const range = url.searchParams.get('range') === 'all' ? 'all' : '30';
	const facts = await allSessionFacts();
	const habits = buildHabits(
		facts.map((f) => ({ session: f.session, view: f.view, index: f.index })),
		range === 'all' ? undefined : Date.now() - 30 * DAY
	);
	return { range, habits };
};
