import type { SessionDetail } from './server/session-data';

export interface DiffLine {
	type: 'add' | 'del' | 'context' | 'hunk-header' | 'meta';
	oldLineNumber?: number;
	newLineNumber?: number;
	content: string;
}

export interface DiffHunk {
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
}

export interface ParsedDiff {
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
	rawDiff: string;
}

export interface FileChangeRecord {
	path: string;
	basename: string;
	directory: string;
	operation: 'create' | 'update' | 'delete' | 'patch' | string;
	status: 'added' | 'modified' | 'deleted';
	diffs: string[];
	parsedDiffs: ParsedDiff[];
	additions: number;
	deletions: number;
	turnReferences: Array<{ messageId?: string; turnNumber?: number; timestamp?: string }>;
}

export interface SessionFileChangesSummary {
	files: FileChangeRecord[];
	totalFiles: number;
	totalAdditions: number;
	totalDeletions: number;
	totalEdits: number;
}

/**
 * Parse a unified diff text string into structured hunks with line numbers.
 */
export function parseUnifiedDiff(rawDiff?: string): ParsedDiff {
	if (!rawDiff || !rawDiff.trim()) {
		return { hunks: [], additions: 0, deletions: 0, rawDiff: rawDiff ?? '' };
	}

	const rawLines = rawDiff.split('\n');
	const hunks: DiffHunk[] = [];
	let currentHunk: DiffHunk | null = null;
	let currentOld = 0;
	let currentNew = 0;
	let additions = 0;
	let deletions = 0;

	for (const rawLine of rawLines) {
		// Hunk header match: @@ -oldStart,oldCount +newStart,newCount @@ [optional heading]
		const hunkMatch = rawLine.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
		if (hunkMatch) {
			const oldStart = parseInt(hunkMatch[1], 10);
			const oldCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
			const newStart = parseInt(hunkMatch[3], 10);
			const newCount = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;

			currentOld = oldStart;
			currentNew = newStart;

			currentHunk = {
				header: rawLine,
				oldStart,
				oldCount,
				newStart,
				newCount,
				lines: [
					{
						type: 'hunk-header',
						content: rawLine
					}
				]
			};
			hunks.push(currentHunk);
			continue;
		}

		if (!currentHunk) {
			// Lines before the first hunk (e.g. --- a/file, +++ b/file, diff --git...)
			if (
				rawLine.startsWith('---') ||
				rawLine.startsWith('+++') ||
				rawLine.startsWith('diff ') ||
				rawLine.startsWith('index ')
			) {
				continue;
			}
			// If no hunk header is present at all, treat as a synthetic hunk starting at line 1
			currentHunk = {
				header: '@@ -1 +1 @@',
				oldStart: 1,
				oldCount: 1,
				newStart: 1,
				newCount: 1,
				lines: []
			};
			currentOld = 1;
			currentNew = 1;
			hunks.push(currentHunk);
		}

		if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
			additions += 1;
			currentHunk.lines.push({
				type: 'add',
				newLineNumber: currentNew++,
				content: rawLine.slice(1)
			});
		} else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
			deletions += 1;
			currentHunk.lines.push({
				type: 'del',
				oldLineNumber: currentOld++,
				content: rawLine.slice(1)
			});
		} else if (rawLine.startsWith(' ')) {
			currentHunk.lines.push({
				type: 'context',
				oldLineNumber: currentOld++,
				newLineNumber: currentNew++,
				content: rawLine.slice(1)
			});
		} else if (rawLine.startsWith('\\ No newline')) {
			currentHunk.lines.push({
				type: 'meta',
				content: rawLine
			});
		} else {
			// Unprefixed line - treat as context
			currentHunk.lines.push({
				type: 'context',
				oldLineNumber: currentOld++,
				newLineNumber: currentNew++,
				content: rawLine
			});
		}
	}

	return {
		hunks,
		additions,
		deletions,
		rawDiff
	};
}

/**
 * Extract and aggregate all file changes across a session detail.
 */
export function extractSessionFileChanges(detail?: SessionDetail): SessionFileChangesSummary {
	if (!detail) {
		return { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0, totalEdits: 0 };
	}

	const filesMap = new Map<string, FileChangeRecord>();
	let totalEdits = 0;
	let assistantTurnCount = 0;

	// Traverse conversation entries
	for (const msg of detail.conversation ?? []) {
		if (msg.role === 'assistant') {
			assistantTurnCount += 1;
			for (const edit of msg.activity?.edits ?? []) {
				totalEdits += 1;
				for (const file of edit.files ?? []) {
					if (!file.path) continue;
					const normPath = file.path.trim();
					let record = filesMap.get(normPath);
					if (!record) {
						const parts = normPath.split('/');
						const basename = parts.pop() || normPath;
						const directory = parts.join('/') || '/';
						const op = (file.operation || 'update').toLowerCase();
						const status: FileChangeRecord['status'] =
							op === 'create' || op === 'add'
								? 'added'
								: op === 'delete' || op === 'remove'
									? 'deleted'
									: 'modified';

						record = {
							path: normPath,
							basename,
							directory,
							operation: file.operation || 'update',
							status,
							diffs: [],
							parsedDiffs: [],
							additions: 0,
							deletions: 0,
							turnReferences: []
						};
						filesMap.set(normPath, record);
					}

					record.turnReferences.push({
						messageId: msg.id,
						turnNumber: assistantTurnCount,
						timestamp: msg.timestamp
					});

					if (file.diff) {
						record.diffs.push(file.diff);
						const parsed = parseUnifiedDiff(file.diff);
						record.parsedDiffs.push(parsed);
						record.additions += parsed.additions;
						record.deletions += parsed.deletions;
					}
				}
			}
		}
	}

	// Also check unattached activities from debug
	for (const unattached of detail.debug?.unattachedActivities ?? []) {
		for (const edit of unattached.edits ?? []) {
			totalEdits += 1;
			for (const file of edit.files ?? []) {
				if (!file.path) continue;
				const normPath = file.path.trim();
				let record = filesMap.get(normPath);
				if (!record) {
					const parts = normPath.split('/');
					const basename = parts.pop() || normPath;
					const directory = parts.join('/') || '/';
					const op = (file.operation || 'update').toLowerCase();
					const status: FileChangeRecord['status'] =
						op === 'create' || op === 'add'
							? 'added'
							: op === 'delete' || op === 'remove'
								? 'deleted'
								: 'modified';

					record = {
						path: normPath,
						basename,
						directory,
						operation: file.operation || 'update',
						status,
						diffs: [],
						parsedDiffs: [],
						additions: 0,
						deletions: 0,
						turnReferences: []
					};
					filesMap.set(normPath, record);
				}

				if (file.diff) {
					record.diffs.push(file.diff);
					const parsed = parseUnifiedDiff(file.diff);
					record.parsedDiffs.push(parsed);
					record.additions += parsed.additions;
					record.deletions += parsed.deletions;
				}
			}
		}
	}

	const files = Array.from(filesMap.values()).sort((a, b) => a.path.localeCompare(b.path));
	let totalAdditions = 0;
	let totalDeletions = 0;
	for (const f of files) {
		totalAdditions += f.additions;
		totalDeletions += f.deletions;
	}

	return {
		files,
		totalFiles: files.length,
		totalAdditions,
		totalDeletions,
		totalEdits
	};
}
