import type { SessionInventory } from '../../../src/types.ts';

export function isSystemOrTempPath(pathStr: string): boolean {
	const normalized = pathStr.replace(/\\/g, '/').toLowerCase();
	if (
		normalized.startsWith('/tmp/') ||
		normalized.startsWith('/private/tmp/') ||
		normalized.startsWith('/var/folders/') ||
		normalized.startsWith('/private/var/') ||
		normalized.includes('/appdata/local/temp/')
	) {
		return true;
	}
	return false;
}

export function extractProjectName(cwd?: string, explicitName?: string): string | undefined {
	if (explicitName && explicitName.trim() && !explicitName.trim().startsWith('.')) {
		return explicitName.trim();
	}
	if (!cwd || !cwd.trim()) return undefined;
	const trimmed = cwd.trim().replace(/[\\/]+$/, '');
	if (!trimmed) return undefined;
	if (isSystemOrTempPath(trimmed)) return undefined;

	const segments = trimmed.split(/[\\/]/).filter(Boolean);
	if (segments.length === 0) return undefined;
	const lastSegment = segments[segments.length - 1];

	// Dotfolders (e.g. .buzz, .codex, .vscode, .gemini, .cache) are internal/tool dirs, not user projects
	if (lastSegment.startsWith('.')) return undefined;

	// Ignore user home root (e.g. /Users/username, /home/username)
	if (segments.length === 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
		return undefined;
	}

	return lastSegment;
}

export function projectName(session: SessionInventory): string {
	return session.projectName || extractProjectName(session.cwd) || 'General / No Project';
}

export function formatCompactTokens(value?: number): string {
	if (value === undefined || value === null || isNaN(value)) return '0';
	if (value < 1_000) return value.toString();
	if (value < 1_000_000) {
		const k = value / 1_000;
		return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + 'K';
	}
	if (value < 1_000_000_000) {
		const m = value / 1_000_000;
		return (m >= 100 ? Math.round(m) : Math.round(m * 10) / 10) + 'M';
	}
	const b = value / 1_000_000_000;
	return (b >= 100 ? Math.round(b) : Math.round(b * 10) / 10) + 'B';
}
