import type { PageServerLoad } from './$types';
import { allSessionFacts } from '$lib/server/session-data';
import { searchSessions, type SearchFilters, type SearchKind } from '../../../../src/search.ts';

const KINDS: SearchKind[] = ['prompt', 'reply', 'note', 'command', 'tool'];
const DAY = 86_400_000;

export const load: PageServerLoad = async ({ url }) => {
	const params = url.searchParams;
	const query = params.get('q')?.trim() ?? '';
	const agent = params.get('agent');
	const days = Number(params.get('days'));
	const filters: SearchFilters = {
		agent: agent === 'claude' || agent === 'codex' ? agent : undefined,
		kinds: (params.get('kind') ?? '')
			.split(',')
			.filter((kind): kind is SearchKind => KINDS.includes(kind as SearchKind)),
		project: params.get('project') || undefined,
		sinceMs: days > 0 ? Date.now() - days * DAY : undefined,
		sort: params.get('sort') === 'newest' ? 'newest' : 'relevance'
	};
	const started = performance.now();
	const facts = query ? await allSessionFacts() : [];
	const results = searchSessions(
		facts.map((f) => ({
			index: f.index,
			session: {
				id: f.session.id,
				agent: f.session.agent ?? 'codex',
				title: f.session.displayTitle.value ?? 'Untitled session',
				project: f.session.projectName,
				updatedAt: f.session.updatedAt
			}
		})),
		query,
		filters
	);
	return {
		query,
		filters: { ...filters, days: days > 0 ? days : undefined },
		results,
		sessionCount: facts.length,
		tookMs: Math.round(performance.now() - started)
	};
};
