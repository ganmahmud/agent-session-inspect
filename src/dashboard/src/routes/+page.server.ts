import type { PageServerLoad } from './$types';
import { sessionInventory } from '$lib/server/session-data';

export const load: PageServerLoad = async () => ({ inventory: await sessionInventory() });
