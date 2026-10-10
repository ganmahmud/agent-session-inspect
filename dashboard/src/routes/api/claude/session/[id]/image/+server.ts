import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isLocalClaudeSession, sessionInventory } from '$lib/server/session-data';
import { imageBlocks } from '../../../../../../../../src/claude-view.ts';

/** Reads one transcript line without loading the whole file. */
async function readLine(file: string, target: number): Promise<string | undefined> {
	const input = createInterface({
		input: createReadStream(file, { encoding: 'utf8' }),
		crlfDelay: Infinity
	});
	let line = 0;
	for await (const raw of input) {
		line += 1;
		if (line === target) {
			input.close();
			return raw;
		}
	}
	return undefined;
}

/** Serves an image embedded in a Claude Code transcript (pasted screenshots, browser screenshots). */
export const GET: RequestHandler = async ({ params, url }) => {
	const fileIndex = Number(url.searchParams.get('f'));
	const lineNumber = Number(url.searchParams.get('l'));
	const imageIndex = Number(url.searchParams.get('i'));
	if (
		![fileIndex, lineNumber, imageIndex].every((value) => Number.isInteger(value) && value >= 0)
	) {
		error(400, 'Expected integer f, l and i query parameters.');
	}

	const inventory = await sessionInventory();
	const session = inventory.sessions.find((item) => item.id === params.id);
	// Only files that belong to this session can be read, so the endpoint cannot be pointed elsewhere on disk.
	const file = isLocalClaudeSession(session) ? session?.sourceFiles[fileIndex] : undefined;
	if (!file) error(404, 'Transcript not found.');

	const raw = await readLine(file, lineNumber);
	let message: unknown;
	try {
		message = raw
			? (JSON.parse(raw) as { message?: { content?: unknown } }).message?.content
			: undefined;
	} catch {
		error(404, 'Image not found.');
	}
	const source = imageBlocks(message)[imageIndex]?.source as
		{ media_type?: string; data?: string } | undefined;
	if (!source?.data || !source.media_type) error(404, 'Image not found.');

	return new Response(Buffer.from(source.data, 'base64'), {
		headers: {
			'content-type': source.media_type,
			'cache-control': 'private, max-age=86400, immutable',
			'x-content-type-options': 'nosniff'
		}
	});
};
