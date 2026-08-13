import type { LayoutServerLoad } from './$types';
import { sessionInventory, getImportedSessionIds, sessionDetail } from '$lib/server/session-data';
import type { SessionInventory } from '../../../src/types.ts';

export const load: LayoutServerLoad = async () => {
	const inventory = await sessionInventory();
	const importedIds = getImportedSessionIds();

	// Merge imported sessions into the inventory (avoid duplicates)
	for (const id of importedIds) {
		if (!inventory.sessions.some((s) => s.id === id)) {
			const detail = await sessionDetail(id);
			if (detail) {
				const inv = { ...detail } as Record<string, unknown>;
				delete inv.conversation;
				delete inv.usage;
				delete inv.debug;
				inventory.sessions.unshift(inv as unknown as SessionInventory);
			}
		}
	}

	return {
		inventory,
		importedSessionIds: importedIds
	};
};
