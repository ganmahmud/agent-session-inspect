import type { PageServerLoad } from './$types';
import { claudeSessionView, sessionInventory } from '$lib/server/session-data';
import { fileOverlap, sessionMetrics } from '../../../../src/compare.ts';

export const load: PageServerLoad = async ({ url }) => {
	const inventory = await sessionInventory();
	const options = inventory.sessions
		.filter((s) => s.agent === 'claude' && !s.relationships?.some((r) => r.type === 'parent'))
		.map((s) => ({
			id: s.id,
			title: s.displayTitle.value ?? 'Untitled session',
			updatedAt: s.updatedAt
		}));
	const aId = url.searchParams.get('a') ?? '';
	const bId = url.searchParams.get('b') ?? '';
	const [a, b] = await Promise.all([
		aId ? claudeSessionView(aId) : undefined,
		bId ? claudeSessionView(bId) : undefined
	]);
	const metricsA = a ? sessionMetrics(a) : undefined;
	const metricsB = b ? sessionMetrics(b) : undefined;
	return {
		options,
		a: metricsA,
		b: metricsB,
		overlap: metricsA && metricsB ? fileOverlap(metricsA, metricsB) : undefined
	};
};
