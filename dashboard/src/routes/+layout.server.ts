import type { LayoutServerLoad } from './$types';
import { sessionInventory } from '$lib/server/session-data';

export const load: LayoutServerLoad = async () => {
	return {
		inventory: await sessionInventory()
	};
};
