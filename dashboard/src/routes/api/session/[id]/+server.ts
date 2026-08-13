import { json, error } from '@sveltejs/kit';
import { deleteImportedSession } from '$lib/server/session-data';

export async function DELETE({ params }) {
	const deleted = deleteImportedSession(params.id);
	if (!deleted) {
		error(404, 'Imported session not found or cannot be deleted');
	}
	return json({ success: true, id: params.id });
}
