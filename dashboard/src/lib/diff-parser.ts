import type { SessionDetail } from '../../../src/types.ts';

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

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
const FILE_HEADER_PREFIXES = ['---', '+++', 'diff ', 'index '];

function hunkFromHeader(rawLine: string, match: RegExpMatchArray): DiffHunk {
	return {
		header: rawLine,
		oldStart: Number.parseInt(match[1], 10),
		oldCount: match[2] ? Number.parseInt(match[2], 10) : 1,
		newStart: Number.parseInt(match[3], 10),
		newCount: match[4] ? Number.parseInt(match[4], 10) : 1,
		lines: [{ type: 'hunk-header', content: rawLine }]
	};
}

/** Classifies one diff body line, advancing the old/new line counters it consumes. */
function diffLine(rawLine: string, counters: { old: number; new: number }): DiffLine {
	if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
		return { type: 'add', newLineNumber: counters.new++, content: rawLine.slice(1) };
	}
	if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
		return { type: 'del', oldLineNumber: counters.old++, content: rawLine.slice(1) };
	}
	if (rawLine.startsWith('\\ No newline')) return { type: 'meta', content: rawLine };
	// Unprefixed lines are treated as context too.
	return {
		type: 'context',
		oldLineNumber: counters.old++,
		newLineNumber: counters.new++,
		content: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
	};
}

/**
 * Parse a unified diff text string into structured hunks with line numbers.
 */
export function parseUnifiedDiff(rawDiff?: string): ParsedDiff {
	if (!rawDiff?.trim()) {
		return { hunks: [], additions: 0, deletions: 0, rawDiff: rawDiff ?? '' };
	}

	const hunks: DiffHunk[] = [];
	let currentHunk: DiffHunk | null = null;
	const counters = { old: 0, new: 0 };
	let additions = 0;
	let deletions = 0;

	for (const rawLine of rawDiff.split('\n')) {
		const hunkMatch = HUNK_HEADER.exec(rawLine);
		if (hunkMatch) {
			currentHunk = hunkFromHeader(rawLine, hunkMatch);
			counters.old = currentHunk.oldStart;
			counters.new = currentHunk.newStart;
			hunks.push(currentHunk);
			continue;
		}
		if (!currentHunk) {
			// Lines before the first hunk (e.g. --- a/file, +++ b/file, diff --git...)
			if (FILE_HEADER_PREFIXES.some((prefix) => rawLine.startsWith(prefix))) continue;
			// If no hunk header is present at all, treat as a synthetic hunk starting at line 1
			currentHunk = {
				header: '@@ -1 +1 @@',
				oldStart: 1,
				oldCount: 1,
				newStart: 1,
				newCount: 1,
				lines: []
			};
			counters.old = 1;
			counters.new = 1;
			hunks.push(currentHunk);
		}
		const line = diffLine(rawLine, counters);
		if (line.type === 'add') additions += 1;
		if (line.type === 'del') deletions += 1;
		currentHunk.lines.push(line);
	}

	return { hunks, additions, deletions, rawDiff };
}

function changeStatus(operation: string): FileChangeRecord['status'] {
	const op = operation.toLowerCase();
	if (op === 'create' || op === 'add') return 'added';
	if (op === 'delete' || op === 'remove') return 'deleted';
	return 'modified';
}

function newRecord(path: string, operation?: string): FileChangeRecord {
	const parts = path.split('/');
	const basename = parts.pop() || path;
	return {
		path,
		basename,
		directory: parts.join('/') || '/',
		operation: operation || 'update',
		status: changeStatus(operation || 'update'),
		diffs: [],
		parsedDiffs: [],
		additions: 0,
		deletions: 0,
		turnReferences: []
	};
}

type EditList = NonNullable<SessionDetail['conversation'][number]['activity']>['edits'];

/** Folds edits into per-file records; returns how many edits were seen. */
function collectEdits(
	filesMap: Map<string, FileChangeRecord>,
	edits: EditList | undefined,
	turn?: FileChangeRecord['turnReferences'][number]
): number {
	for (const edit of edits ?? []) {
		for (const file of edit.files ?? []) {
			if (!file.path) continue;
			const normPath = file.path.trim();
			const record = filesMap.get(normPath) ?? newRecord(normPath, file.operation);
			filesMap.set(normPath, record);
			if (turn) record.turnReferences.push(turn);
			if (file.diff) {
				record.diffs.push(file.diff);
				const parsed = parseUnifiedDiff(file.diff);
				record.parsedDiffs.push(parsed);
				record.additions += parsed.additions;
				record.deletions += parsed.deletions;
			}
		}
	}
	return edits?.length ?? 0;
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

	for (const msg of detail.conversation ?? []) {
		if (msg.role !== 'assistant') continue;
		assistantTurnCount += 1;
		const turn = { messageId: msg.id, turnNumber: assistantTurnCount, timestamp: msg.timestamp };
		totalEdits += collectEdits(filesMap, msg.activity?.edits, turn);
	}
	// Also check unattached activities from debug
	for (const unattached of detail.debug?.unattachedActivities ?? []) {
		totalEdits += collectEdits(filesMap, unattached.edits);
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
