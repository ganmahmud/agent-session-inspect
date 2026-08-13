import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { sessionInventory } from '$lib/server/session-data';

export const load: PageServerLoad = async () => {
	const inventory = await sessionInventory();
	if (inventory.sessions.length > 0) {
		throw redirect(307, `/session/${inventory.sessions[0].id}`);
	}
	return { inventory };
};
