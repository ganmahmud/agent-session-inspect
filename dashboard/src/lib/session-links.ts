import { resolve } from '$app/paths';

/** Link to a session, landing on a turn or step when the Claude view can jump there. */
export function sessionLink(id: string, agent?: string, anchor?: string): string {
	if (agent === 'claude') {
		const hash = anchor ? '#' + encodeURIComponent(anchor) : '';
		return resolve('/claude/session/[id]', { id }) + hash;
	}
	return resolve('/session/[id]', { id });
}

/** Splits text into plain and highlighted parts for rendering search matches without {@html}. */
export function highlightParts(
	text: string,
	matches: Array<[number, number]>
): Array<{ text: string; hit: boolean }> {
	const parts: Array<{ text: string; hit: boolean }> = [];
	let at = 0;
	for (const [start, end] of matches) {
		if (start < at) continue;
		if (start > at) parts.push({ text: text.slice(at, start), hit: false });
		parts.push({ text: text.slice(start, end), hit: true });
		at = end;
	}
	if (at < text.length) parts.push({ text: text.slice(at), hit: false });
	return parts;
}

export function relativeDay(value?: string): string {
	if (!value) return '';
	const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
	if (days <= 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 30) return `${days} days ago`;
	return new Date(value).toLocaleDateString([], {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
}
