<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { markdown } from '$lib/markdown';
	import { formatCompactTokens } from '$lib/project';
	import FileDiffViewer from '$lib/components/FileDiffViewer.svelte';
	import {
		parseUnifiedDiff,
		type FileChangeRecord,
		type SessionFileChangesSummary
	} from '$lib/diff-parser';
	import type {
		ClaudeEventStep,
		ClaudeImageRef,
		ClaudeInsight,
		ClaudeSessionView,
		ClaudeStep,
		ClaudeTextStep,
		ClaudeToolStep,
		ClaudeTurn,
		ToolCategory,
		ToolVerb
	} from '../../../../../../src/claude-view.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const view = $derived<ClaudeSessionView>(data.view);

	// Tool groups start folded; these hold what the reader opened.
	let open = $state<Record<string, boolean>>({});
	// "Answers only" hides Claude's working everywhere; a reader can still reveal one message's thoughts.
	let answersOnly = $state(false);
	let hiddenThoughts = $state<Record<string, boolean>>({});
	let lightbox = $state<string | undefined>(undefined);
	let reviewingChanges = $state(false);
	let showDetails = $state(false);
	let showAllFiles = $state(false);
	let copied = $state(false);

	const CATEGORIES: Array<{ key: ToolCategory; label: string }> = [
		{ key: 'read', label: 'Read & search' },
		{ key: 'edit', label: 'Edits' },
		{ key: 'shell', label: 'Shell' },
		{ key: 'mcp', label: 'MCP' },
		{ key: 'agent', label: 'Subagents' },
		{ key: 'web', label: 'Web' },
		{ key: 'other', label: 'Other' }
	];

	const fmt = new Intl.NumberFormat('en-US');
	const n = (value?: number) => (value === undefined ? '—' : fmt.format(value));
	const usd = (value?: number) =>
		value === undefined ? '—' : value < 0.01 && value > 0 ? '<$0.01' : `$${value.toFixed(2)}`;

	function duration(ms?: number): string {
		if (ms === undefined) return '—';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
		const h = Math.floor(m / 60);
		return `${h}h ${String(m % 60).padStart(2, '0')}m`;
	}

	const clock = (value?: string) =>
		value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
	const day = (value?: string) =>
		value
			? new Date(value).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
			: 'Unknown date';
	const ms = (value?: string) => (value ? new Date(value).getTime() : undefined);
	const toolLabel = (name: string) => name.replace(/^mcp__/, '').replace(/__/g, ' · ');
	const tokensOf = (t: ClaudeTurn['tokens']) => t.fresh + t.cacheWrite + t.cacheRead + t.output;

	const totalTokens = $derived(
		view.tokens.fresh + view.tokens.cacheWrite + view.tokens.cacheRead + view.tokens.output
	);
	const totalInput = $derived(view.tokens.fresh + view.tokens.cacheWrite + view.tokens.cacheRead);
	const cacheHit = $derived(
		totalInput > 0 ? Math.round((view.tokens.cacheRead / totalInput) * 100) : 0
	);
	const tokenMix = $derived.by(() => {
		const parts = [
			{ key: 'cacheRead', label: 'Cache read', value: view.tokens.cacheRead },
			{ key: 'cacheWrite', label: 'Cache write', value: view.tokens.cacheWrite },
			{ key: 'fresh', label: 'Fresh input', value: view.tokens.fresh },
			{ key: 'output', label: 'Output', value: view.tokens.output }
		];
		const sum = parts.reduce((a, p) => a + p.value, 0) || 1;
		return parts.map((p) => ({ ...p, pct: (p.value / sum) * 100 }));
	});

	const activeMs = $derived(view.turns.reduce((a, t) => a + (t.durationMs ?? 0), 0));
	const toolMs = $derived(
		view.cost?.toolMs ??
			view.turns
				.flatMap((t) => t.steps)
				.reduce((a, s) => a + (s.kind === 'tool' ? (s.durationMs ?? 0) : 0), 0)
	);
	const linesAdded = $derived(
		view.cost?.linesAdded ?? view.files.reduce((a, f) => a + f.linesAdded, 0)
	);
	const linesRemoved = $derived(
		view.cost?.linesRemoved ?? view.files.reduce((a, f) => a + f.linesRemoved, 0)
	);
	const editedFiles = $derived(view.files.filter((f) => f.edits > 0));
	const readOnlyFiles = $derived(view.files.filter((f) => f.edits === 0));
	const totalTools = $derived(Object.values(view.toolCounts).reduce((a, b) => a + b, 0));
	const promptTurns = $derived(view.turns.filter((t) => t.prompt).length);

	// Slim ribbon: one segment per turn, width by time spent, for orientation and jumping.
	const ribbon = $derived.by(() => {
		const durations = view.turns.map((t) => Math.max(t.durationMs ?? 0, 1));
		const total = durations.reduce((a, b) => a + b, 0) || 1;
		return view.turns.map((t, i) => {
			const start = ms(t.startedAt) ?? 0;
			const span = Math.max((ms(t.endedAt) ?? start) - start, 1);
			const ticks = t.steps
				.filter((s): s is ClaudeToolStep => s.kind === 'tool')
				.map((s) => ({
					id: s.id,
					category: s.category,
					error: s.status === 'error',
					left: Math.min(98, Math.max(0, (((ms(s.startedAt) ?? start) - start) / span) * 100))
				}));
			return { turn: t, grow: Math.max(durations[i] / total, 0.012), ticks };
		});
	});

	/** A run of consecutive tool calls (plus private reasoning and routine events) shown as one line. */
	interface ToolGroup {
		kind: 'group';
		id: string;
		steps: ClaudeStep[];
		tools: ClaudeToolStep[];
		errors: number;
	}
	type Segment =
		| { kind: 'narration'; step: ClaudeTextStep }
		| { kind: 'note'; step: ClaudeEventStep }
		| ToolGroup;

	interface Exchange {
		turn: ClaudeTurn;
		/** Claude's working: notes it wrote along the way and the tool calls between them. */
		thoughts: Segment[];
		/** Text after the last piece of work: the answer. */
		answer: ClaudeTextStep[];
		thoughtMs?: number;
		stepCount: number;
		failed: number;
	}

	const isNote = (s: ClaudeStep): s is ClaudeEventStep => s.kind === 'event' && s.tone !== 'info';

	function exchangeFor(t: ClaudeTurn): Exchange {
		let lastWork = -1;
		t.steps.forEach((s, i) => {
			if (s.kind !== 'text' && !isNote(s)) lastWork = i;
		});
		const thoughts: Segment[] = [];
		let group: ToolGroup | undefined;
		for (const step of t.steps.slice(0, lastWork + 1)) {
			if (step.kind === 'text' || isNote(step)) {
				group = undefined;
				thoughts.push(step.kind === 'text' ? { kind: 'narration', step } : { kind: 'note', step });
				continue;
			}
			if (!group) {
				group = { kind: 'group', id: `group-${step.id}`, steps: [], tools: [], errors: 0 };
				thoughts.push(group);
			}
			group.steps.push(step);
			if (step.kind === 'tool') {
				group.tools.push(step);
				if (step.status === 'error') group.errors += 1;
			}
		}
		// Interruptions and errors after the last tool call still belong with the working, not the answer.
		const after = t.steps.slice(lastWork + 1);
		for (const step of after) if (isNote(step)) thoughts.push({ kind: 'note', step });
		const answer = after.filter((s): s is ClaudeTextStep => s.kind === 'text');

		const tools = t.steps.filter((s): s is ClaudeToolStep => s.kind === 'tool');
		const lastWorkStep = t.steps[lastWork];
		const end = ms(
			lastWorkStep?.kind === 'tool'
				? (lastWorkStep.completedAt ?? lastWorkStep.startedAt)
				: lastWorkStep?.timestamp
		);
		const start = ms(t.prompt?.timestamp ?? t.startedAt);
		return {
			turn: t,
			thoughts,
			answer,
			thoughtMs: start !== undefined && end !== undefined ? end - start : undefined,
			stepCount: tools.length,
			failed: tools.filter((s) => s.status === 'error').length
		};
	}

	// --- Replay: rewind the conversation to any moment ------------------------------------------------------
	const stepTime = (step: ClaudeStep) => ms(step.kind === 'tool' ? step.startedAt : step.timestamp);
	const timeline = $derived.by(() => {
		const start = ms(view.turns[0]?.prompt?.timestamp ?? view.turns[0]?.startedAt);
		const end = ms(view.turns.at(-1)?.endedAt);
		return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
	});
	/** Replay position in milliseconds since the epoch; undefined shows the whole session. */
	let replayAt = $state<number | undefined>(undefined);
	let playing = $state(false);
	const visibleTurns = $derived.by(() => {
		if (replayAt === undefined) return view.turns;
		const at = replayAt;
		return view.turns
			.filter((t) => (ms(t.prompt?.timestamp ?? t.startedAt) ?? 0) <= at)
			.map((t) => ({ ...t, steps: t.steps.filter((step) => (stepTime(step) ?? 0) <= at) }));
	});
	const replayStats = $derived.by(() => {
		const steps = visibleTurns.flatMap((t) => t.steps);
		const files = new Set(
			steps.flatMap((step) =>
				step.kind === 'tool'
					? [
							...(step.category === 'edit' && step.filePath ? [step.filePath] : []),
							...(step.fileEdits ?? []).map((edit) => edit.path)
						]
					: []
			)
		);
		return {
			costUsd: steps.reduce(
				(sum, step) => sum + (step.kind === 'event' ? 0 : (step.costUsd ?? 0)),
				0
			),
			files: files.size
		};
	});

	function startReplay() {
		if (!timeline) return;
		replayAt = timeline.start;
		playing = true;
	}
	function stopReplay() {
		playing = false;
		replayAt = undefined;
	}
	$effect(() => {
		if (!playing || !timeline) return;
		// The whole session plays back in about a minute, whatever its real length.
		const tick = (timeline.end - timeline.start) / 600;
		const timer = setInterval(() => {
			const next = Math.min(timeline.end, (replayAt ?? timeline.start) + tick);
			replayAt = next;
			window.scrollTo({ top: document.documentElement.scrollHeight });
			if (next >= timeline.end) playing = false;
		}, 100);
		return () => clearInterval(timer);
	});

	const exchanges = $derived(visibleTurns.map(exchangeFor));

	const plural = (count: number, one: string, many = `${one}s`) =>
		`${count} ${count === 1 ? one : many}`;

	/** "Ran 4 commands, read 2 files, used 2 tools", in the order Claude Code itself uses. */
	function groupSummary(g: ToolGroup): string {
		const count = (verb: ToolVerb) => g.tools.filter((s) => s.verb === verb).length;
		const editedFiles = new Set(
			g.tools.filter((s) => s.verb === 'edit').map((s) => s.filePath ?? s.id)
		).size;
		const parts = [
			count('command') && `ran ${plural(count('command'), 'command')}`,
			count('read') && `read ${plural(count('read'), 'file')}`,
			count('search') && `searched ${plural(count('search'), 'time')}`,
			editedFiles && `edited ${plural(editedFiles, 'file')}`,
			count('web') && `fetched ${plural(count('web'), 'page')}`,
			count('agent') && `ran ${plural(count('agent'), 'subagent')}`,
			count('tool') && `used ${plural(count('tool'), 'tool')}`
		].filter(Boolean) as string[];
		if (!parts.length) return g.steps.some((s) => s.kind === 'thinking') ? 'Reasoned' : 'Noted';
		const text = parts.join(', ');
		return text.charAt(0).toUpperCase() + text.slice(1);
	}

	const groupLines = (g: ToolGroup) => ({
		added: g.tools.reduce((a, s) => a + (s.linesAdded ?? 0), 0),
		removed: g.tools.reduce((a, s) => a + (s.linesRemoved ?? 0), 0)
	});

	function imageSrc(image: ClaudeImageRef): string {
		// Imported copies carry the image bytes; local sessions read them from the transcript on demand.
		if (image.src) return image.src;
		return `${resolve('/api/claude/session/[id]/image', { id: view.id })}?f=${image.file}&l=${image.line}&i=${image.index}`;
	}

	function messageLabel(t: ClaudeTurn) {
		return t.prompt
			? `User message ${t.index + (view.turns[0]?.prompt ? 1 : 0)}`
			: 'Before your first message';
	}

	function setAnswersOnly(value: boolean) {
		answersOnly = value;
		hiddenThoughts = {};
	}

	const thoughtsHidden = (turnId: string) => hiddenThoughts[turnId] ?? answersOnly;

	function jumpToStep(stepId: string) {
		const exchange = exchanges.find((e) => e.turn.steps.some((s) => s.id === stepId));
		if (exchange) hiddenThoughts[exchange.turn.id] = false;
		const group = exchanges
			.flatMap((e) => e.thoughts)
			.find((s): s is ToolGroup => s.kind === 'group' && s.steps.some((x) => x.id === stepId));
		if (group) open[group.id] = true;
		open[stepId] = true;
		requestAnimationFrame(() =>
			document.getElementById(stepId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
		);
	}

	// --- Selecting, copying and exporting messages --------------------------------------------------------
	type Part = 'user' | 'claude';
	const partKey = (turnId: string, part: Part) => `${turnId}:${part}`;
	let selected = $state<Record<string, boolean>>({});
	let flashed = $state<string | undefined>(undefined);
	const selectedCount = $derived(Object.values(selected).filter(Boolean).length);

	function flash(key: string) {
		flashed = key;
		setTimeout(() => flashed === key && (flashed = undefined), 1500);
	}

	function answerText(ex: Exchange): string {
		const answer = ex.answer.map((s) => s.text).join('\n\n');
		if (answer) return answer;
		// No final reply (interrupted, or still working): fall back to the notes Claude wrote.
		return ex.thoughts.flatMap((s) => (s.kind === 'narration' ? [s.step.text] : [])).join('\n\n');
	}

	function partText(ex: Exchange, part: Part): string {
		return part === 'user' ? (ex.turn.prompt?.text ?? '') : answerText(ex);
	}

	function asMarkdown(items: Array<{ ex: Exchange; part: Part }>): string {
		return items
			.map(({ ex, part }) => {
				const when = part === 'user' ? ex.turn.prompt?.timestamp : ex.turn.endedAt;
				return `### ${part === 'user' ? 'User' : 'Claude'} · ${day(when)} ${clock(when)}\n\n${partText(ex, part)}`;
			})
			.join('\n\n---\n\n');
	}

	function copyPart(ex: Exchange, part: Part) {
		navigator.clipboard.writeText(partText(ex, part));
		flash(`copy:${partKey(ex.turn.id, part)}`);
	}

	/** One user message or one Claude reply as an importable turn. */
	function turnForParts(ex: Exchange, parts: Part[]): ClaudeTurn {
		const t = $state.snapshot(ex.turn) as ClaudeTurn;
		if (!parts.includes('claude')) {
			return {
				...t,
				steps: [],
				toolCount: 0,
				errorCount: 0,
				models: [],
				tokens: {
					...t.tokens,
					fresh: 0,
					cacheWrite: 0,
					cacheRead: 0,
					output: 0,
					thinking: 0,
					requests: 0
				},
				peakContext: 0
			};
		}
		return parts.includes('user') ? t : { ...t, prompt: undefined };
	}

	/** Inlines screenshots so the exported file opens anywhere. */
	async function embedImages(turns: ClaudeTurn[]) {
		const refs = turns.flatMap((t) => [
			...(t.prompt?.images ?? []),
			...t.steps.flatMap((s) => (s.kind === 'tool' ? s.images : []))
		]);
		await Promise.all(
			refs
				.filter((ref) => !ref.src)
				.map(async (ref) => {
					try {
						const blob = await (await fetch(imageSrc(ref))).blob();
						ref.src = await new Promise<string>((done) => {
							const reader = new FileReader();
							reader.onload = () => done(String(reader.result));
							reader.readAsDataURL(blob);
						});
					} catch {
						// Leave the reference; the image is simply missing from the export.
					}
				})
		);
	}

	async function exportParts(items: Array<{ ex: Exchange; part: Part }>, filename: string) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local grouping, not component state
		const byTurn = new Map<string, { ex: Exchange; parts: Part[] }>();
		for (const { ex, part } of items) {
			const entry = byTurn.get(ex.turn.id) ?? { ex, parts: [] };
			entry.parts.push(part);
			byTurn.set(ex.turn.id, entry);
		}
		const claudeTurns = [...byTurn.values()].map(({ ex, parts }) => turnForParts(ex, parts));
		await embedImages(claudeTurns);
		const payload = {
			exportVersion: 1,
			exportedAt: new Date().toISOString(),
			agent: 'claude',
			sessionId: view.id,
			sessionTitle: view.title ?? 'Claude Code session',
			cwd: view.cwd,
			selectedCount: items.length,
			// Readable copy of the selection; `claudeTurns` is what the dashboard imports.
			messages: items.map(({ ex, part }) => ({
				role: part === 'user' ? 'user' : 'assistant',
				timestamp: part === 'user' ? ex.turn.prompt?.timestamp : ex.turn.endedAt,
				text: partText(ex, part)
			})),
			claudeTurns
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = filename;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	function exportPart(ex: Exchange, part: Part) {
		const which = part === 'user' ? 'user' : 'claude';
		exportParts(
			[{ ex, part }],
			`claude-${which}-message-${view.id.slice(0, 8)}-${ex.turn.index + 1}.json`
		);
		flash(`export:${partKey(ex.turn.id, part)}`);
	}

	const selectedItems = $derived(
		exchanges.flatMap((ex) =>
			(['user', 'claude'] as Part[])
				.filter((part) => selected[partKey(ex.turn.id, part)])
				.map((part) => ({ ex, part }))
		)
	);

	function selectAll() {
		selected = Object.fromEntries(
			exchanges.flatMap((ex) => [
				...(ex.turn.prompt ? [[partKey(ex.turn.id, 'user'), true]] : []),
				...(ex.thoughts.length || ex.answer.length ? [[partKey(ex.turn.id, 'claude'), true]] : [])
			])
		);
	}

	function copySelected() {
		navigator.clipboard.writeText(asMarkdown(selectedItems));
		flash('copy:selection');
	}

	/** Cost label for small spends; hidden below a cent so rows don't fill with "$0.00". */
	const spend = (value?: number) => (value && value >= 0.01 ? `$${value.toFixed(2)}` : '');
	const groupCost = (g: ToolGroup) =>
		g.steps.reduce((a, s) => a + (s.kind === 'event' ? 0 : (s.costUsd ?? 0)), 0);

	/** Every edit this session made, grouped per file, for the shared diff viewer. */
	const changes = $derived.by((): SessionFileChangesSummary => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt inside $derived, never mutated after
		const files = new Map<string, FileChangeRecord>();
		let totalEdits = 0;
		const add = (
			path: string,
			diff: string,
			added: number,
			removed: number,
			stepId: string,
			turnIndex: number,
			timestamp?: string
		) => {
			totalEdits += 1;
			const parts = path.split('/');
			const created = diff.startsWith('--- /dev/null');
			const record = files.get(path) ?? {
				path,
				basename: parts.at(-1) ?? path,
				directory: parts.slice(0, -1).join('/') || '/',
				operation: created ? 'create' : 'update',
				status: created ? 'added' : 'modified',
				diffs: [],
				parsedDiffs: [],
				additions: 0,
				deletions: 0,
				turnReferences: []
			};
			record.diffs.push(diff);
			record.parsedDiffs.push(parseUnifiedDiff(diff));
			record.additions += added;
			record.deletions += removed;
			record.turnReferences.push({ messageId: stepId, turnNumber: turnIndex + 1, timestamp });
			files.set(path, record);
		};
		view.turns.forEach((t, turnIndex) => {
			for (const s of t.steps) {
				if (s.kind !== 'tool') continue;
				// Edits made with Edit/Write, and files a shell command changed.
				if (s.category === 'edit' && s.diff && s.filePath) {
					add(
						s.filePath,
						s.diff,
						s.linesAdded ?? 0,
						s.linesRemoved ?? 0,
						s.id,
						turnIndex,
						s.startedAt
					);
				}
				for (const edit of s.fileEdits ?? []) {
					if (edit.diff)
						add(edit.path, edit.diff, edit.added, edit.removed, s.id, turnIndex, s.startedAt);
				}
			}
		});
		const list = [...files.values()];
		return {
			files: list,
			totalFiles: list.length,
			totalAdditions: list.reduce((a, f) => a + f.additions, 0),
			totalDeletions: list.reduce((a, f) => a + f.deletions, 0),
			totalEdits
		};
	});

	// Context chart: context size at each API call against the window, with cache resets marked.
	const CHART_W = 600;
	const CHART_H = 70;
	const chart = $derived.by(() => {
		const series = view.contextSeries ?? [];
		if (series.length < 2) return undefined;
		const times = series.map((p, i) => (p.timestamp ? Date.parse(p.timestamp) : i));
		const t0 = times[0];
		const span = Math.max(times.at(-1)! - t0, 1);
		const peak = Math.max(view.contextWindow, ...series.map((p) => p.tokens));
		const x = (i: number) => ((times[i] - t0) / span) * CHART_W;
		const y = (tokens: number) => CHART_H - (tokens / peak) * (CHART_H - 4);
		const line = series.map((p, i) => `${x(i).toFixed(1)},${y(p.tokens).toFixed(1)}`).join(' ');
		const at = (stamp?: string) => (stamp ? ((Date.parse(stamp) - t0) / span) * CHART_W : 0);
		return {
			line,
			area: `0,${CHART_H} ${line} ${CHART_W},${CHART_H}`,
			windowY: y(view.contextWindow),
			resets: (view.cacheResets ?? []).map((r) => ({ ...r, x: at(r.timestamp) }))
		};
	});

	function openInsight(insight: ClaudeInsight) {
		if (insight.stepId) jumpToStep(insight.stepId);
		else if (insight.turnId) jumpToTurn(insight.turnId);
	}

	// Links from search and file history land on a turn (#turn-…) or a tool call (#toolu_…).
	$effect(() => {
		const target = decodeURIComponent(page.url.hash.slice(1));
		if (!target || !view) return;
		untrack(() => {
			if (target.startsWith('turn-')) {
				const turnId = target.slice(5);
				requestAnimationFrame(() => jumpToTurn(turnId));
			} else if (view.turns.some((t) => t.steps.some((st) => st.id === target))) {
				jumpToStep(target);
			}
		});
	});

	// --- Asking the local claude CLI about this session ---------------------------------------------------
	const SUGGESTED_QUESTIONS = [
		'What changed and why?',
		'Write a PR description for this work',
		'Why did it cost what it did?',
		'Write a short handoff note for whoever picks this up'
	];
	let question = $state('');
	let asking = $state(false);
	let answer = $state<{ text: string; costUsd?: number; durationMs?: number } | undefined>(
		undefined
	);
	let askError = $state<string | undefined>(undefined);

	async function ask(text = question) {
		const q = text.trim();
		if (!q || asking) return;
		question = q;
		asking = true;
		askError = undefined;
		answer = undefined;
		try {
			const res = await fetch(resolve('/api/claude/session/[id]/ask', { id: view.id }), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ question: q })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
			answer = { text: body.answer, costUsd: body.costUsd, durationMs: body.durationMs };
		} catch (err) {
			askError = err instanceof Error ? err.message : 'The question could not be answered.';
		} finally {
			asking = false;
		}
	}

	const resumeCommand = $derived(
		`${view.cwd ? `cd ${JSON.stringify(view.cwd)} && ` : ''}claude --resume ${view.id}`
	);
	function copyResume() {
		navigator.clipboard.writeText(resumeCommand);
		flash('resume');
	}

	// --- Following a session that is still running -------------------------------------------------------
	const LIVE_WINDOW_MS = 2 * 60_000;
	const POLL_MS = 4_000;
	// Follows each reload's stamp; the poll below overwrites it between reloads.
	let modifiedAt = $derived<string | undefined>(data.stamp?.modifiedAt);
	let now = $state(Date.now());
	const live = $derived(
		!view.imported && modifiedAt !== undefined && now - Date.parse(modifiedAt) < LIVE_WINDOW_MS
	);

	onMount(() => {
		if (view.imported) return;
		let stamp = data.stamp?.stamp;
		let busy = false;
		const timer = setInterval(async () => {
			now = Date.now();
			// Only poll while the page is visible and the session wrote something in the last ten minutes.
			if (busy || document.hidden || !modifiedAt || now - Date.parse(modifiedAt) > 10 * 60_000)
				return;
			busy = true;
			try {
				const res = await fetch(resolve('/api/claude/session/[id]/stamp', { id: view.id }));
				if (!res.ok) return;
				const next = (await res.json()) as { stamp: string; modifiedAt?: string };
				modifiedAt = next.modifiedAt;
				if (next.stamp === stamp) return;
				stamp = next.stamp;
				const atBottom =
					window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200;
				await invalidateAll();
				if (atBottom)
					window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
			} finally {
				busy = false;
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	const failedSteps = $derived(
		exchanges.flatMap((e) =>
			e.turn.steps.filter((s): s is ClaudeToolStep => s.kind === 'tool' && s.status === 'error')
		)
	);
	let failedCursor = $state(0);
	function nextFailure() {
		if (!failedSteps.length) return;
		jumpToStep(failedSteps[failedCursor % failedSteps.length].id);
		failedCursor += 1;
	}

	function jumpToTurn(id: string) {
		document.getElementById(`turn-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function diffClass(line: string) {
		if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
		if (line.startsWith('@@')) return 'hunk';
		if (line.startsWith('+')) return 'add';
		if (line.startsWith('-')) return 'del';
		return '';
	}

	function copyId() {
		navigator.clipboard.writeText(view.id);
		copied = true;
		setTimeout(() => (copied = false), 1600);
	}

	const isLong = (text: string) => text.length > 700 || text.split('\n').length > 10;
	const visibleEdited = $derived(showAllFiles ? editedFiles : editedFiles.slice(0, 8));
</script>

<svelte:head>
	<title>{view.title ?? 'Claude Code session'} — Agent Session Inspect</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		rel="stylesheet"
		href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600&display=swap"
	/>
</svelte:head>

<div class="cv">
	<header class="head">
		<p class="eyebrow">
			<span class="mark" aria-hidden="true"></span>Claude Code
			{#if view.gitBranches.length}<span class="quiet">on {view.gitBranches.join(', ')}</span>{/if}
			{#if view.imported}<span class="imported-tag">Imported copy</span>{/if}
			{#if live}<span class="live-tag" title="Updates as Claude Code writes to this session"
					><i></i>Live</span
				>{/if}
		</p>
		<h1>{view.title ?? 'Untitled Claude Code session'}</h1>
		<p class="meta">
			<span>{day(view.startedAt)}, {clock(view.startedAt)}–{clock(view.endedAt)}</span>
			{#if view.projectName}<span title={view.cwd}>{view.projectName}</span>{/if}
			<span class="actions">
				<button type="button" class="link" onclick={copyId}>{copied ? 'Copied' : 'Copy ID'}</button>
				<a class="link" href={resolve('/api/session/[id]/export', { id: view.id })} download
					>Export</a
				>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string -->
				<a class="link" href={`${resolve('/session/[id]', { id: view.id })}?view=analytics`}
					>Token analytics</a
				>
				{#if view.remoteUrl}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external claude.ai link -->
					<a class="link" href={view.remoteUrl} target="_blank" rel="noreferrer">Open remotely ↗</a>
				{/if}
			</span>
		</p>
	</header>

	<!-- Four numbers that answer "what did this cost and what changed"; the rest is one click away. -->
	<section class="overview" aria-label="Session summary">
		<dl class="stats">
			<div>
				<dt>Cost</dt>
				<dd>{view.cost ? usd(view.cost.usd) : '—'}</dd>
			</div>
			<div>
				<dt>Working time</dt>
				<dd>{duration(activeMs)}</dd>
			</div>
			<div>
				<dt>Tokens</dt>
				<dd>{formatCompactTokens(totalTokens)}</dd>
			</div>
			<div>
				<dt>Changes</dt>
				<dd>
					<span class="add">+{n(linesAdded)}</span>
					<span class="del">−{n(linesRemoved)}</span>
				</dd>
			</div>
		</dl>

		{#if view.turns.length > 1}
			<div class="track" aria-label="Turns, sized by time spent">
				{#each ribbon as seg (seg.turn.id)}
					<button
						type="button"
						class="seg"
						class:interrupted={seg.turn.status === 'interrupted'}
						class:preamble={!seg.turn.prompt}
						style="flex-grow: {seg.grow}"
						onclick={() => jumpToTurn(seg.turn.id)}
						title="{messageLabel(seg.turn)} · {duration(seg.turn.durationMs)} · {seg.turn
							.toolCount} steps"
						aria-label="Go to {messageLabel(seg.turn)}"
					>
						{#each seg.ticks as tick (tick.id)}
							<i class="tick cat-{tick.category}" class:err={tick.error} style="left: {tick.left}%"
							></i>
						{/each}
					</button>
				{/each}
			</div>
		{/if}

		<button
			type="button"
			class="link details-toggle"
			aria-expanded={showDetails}
			onclick={() => (showDetails = !showDetails)}
		>
			{showDetails ? 'Hide usage details' : 'Show usage details'}
		</button>

		{#if view.insights.length}
			<div class="insights">
				<h3>Worth a look</h3>
				<ul>
					{#each view.insights as insight (insight.id)}
						<li class="tone-{insight.tone}">
							<button type="button" class="insight" onclick={() => openInsight(insight)}>
								{insight.text}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if showDetails}
			<div class="details">
				<div>
					<h3>Tokens</h3>
					<div class="mix" role="img" aria-label="Token mix">
						{#each tokenMix.filter((p) => p.pct > 0) as p (p.key)}
							<i class="mix-{p.key}" style="width: {p.pct}%"></i>
						{/each}
					</div>
					<ul class="kv">
						{#each tokenMix as p (p.key)}
							<li>
								<span><i class="dot mix-{p.key}"></i>{p.label}</span><b
									>{formatCompactTokens(p.value)}</b
								>
							</li>
						{/each}
						{#if view.tokens.thinking}
							<li>
								<span>Thinking (in output)</span><b>{formatCompactTokens(view.tokens.thinking)}</b>
							</li>
						{/if}
						<li><span>API calls</span><b>{n(view.tokens.requests)}</b></li>
						<li><span>Served from cache</span><b>{cacheHit}%</b></li>
					</ul>
				</div>
				{#if chart}
					<div class="context-chart">
						<h3>Context over time</h3>
						<svg
							viewBox="0 0 {CHART_W} {CHART_H}"
							preserveAspectRatio="none"
							role="img"
							aria-label="Context size at each API call, peaking at {formatCompactTokens(
								view.peakContext
							)} of {formatCompactTokens(view.contextWindow)}"
						>
							<line class="window" x1="0" x2={CHART_W} y1={chart.windowY} y2={chart.windowY} />
							<polygon class="area" points={chart.area} />
							<polyline class="trace" points={chart.line} />
							{#each chart.resets as reset (reset.id)}
								<line class="reset" x1={reset.x} x2={reset.x} y1="0" y2={CHART_H}>
									<title>{reset.reason === 'expired' ? 'Cache expired' : 'Cache rebuilt'}</title>
								</line>
							{/each}
						</svg>
						<p class="quiet small-text">
							Peak {formatCompactTokens(view.peakContext)} of {formatCompactTokens(
								view.contextWindow
							)}{#if view.cacheResets?.length}
								· <span class="reset-key">|</span> cache rebuilt {view.cacheResets.length}×{/if}
						</p>
					</div>
				{/if}
				<div>
					<h3>Time and context</h3>
					<ul class="kv">
						<li><span>Working time</span><b>{duration(activeMs)}</b></li>
						{#if view.cost?.apiMs}<li>
								<span>Waiting on the model</span><b>{duration(view.cost.apiMs)}</b>
							</li>{/if}
						<li><span>Running tools</span><b>{duration(toolMs)}</b></li>
						<li>
							<span>Peak context</span><b
								>{formatCompactTokens(view.peakContext)} of {formatCompactTokens(
									view.contextWindow
								)}</b
							>
						</li>
						{#if view.compactions}<li><span>Compactions</span><b>{view.compactions}</b></li>{/if}
					</ul>
				</div>
				<div>
					<h3>Steps by kind</h3>
					<ul class="kv">
						{#each CATEGORIES.filter((c) => view.toolCounts[c.key] > 0) as c (c.key)}
							<li>
								<span><i class="dot cat-{c.key}"></i>{c.label}</span><b>{view.toolCounts[c.key]}</b>
							</li>
						{/each}
						{#if !totalTools}<li><span>No tool calls</span></li>{/if}
					</ul>
				</div>
				{#if view.models.length}
					<div>
						<h3>Models</h3>
						<ul class="kv">
							{#each view.models as m (m.model)}
								<li>
									<span class="mono">{m.model}</span><b
										>{m.costUsd !== undefined ? usd(m.costUsd) : `${m.requests} calls`}</b
									>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}
	</section>

	{#if !view.imported}
		<section class="ask" aria-label="Ask about this session">
			<form
				onsubmit={(e) => {
					e.preventDefault();
					ask();
				}}
			>
				<input
					bind:value={question}
					placeholder="Ask about this session…"
					aria-label="Question about this session"
					disabled={asking}
				/>
				<button type="submit" disabled={asking || !question.trim()}
					>{asking ? 'Thinking…' : 'Ask'}</button
				>
			</form>
			{#if !answer && !asking && !askError}
				<div class="ask-chips">
					{#each SUGGESTED_QUESTIONS as q (q)}
						<button type="button" onclick={() => ask(q)}>{q}</button>
					{/each}
				</div>
				<p class="quiet small-text">
					Answered by your local <code>claude</code> CLI from a summary of this session, with no tools.
					Each question uses your plan (usually a few cents, capped at $1).
				</p>
			{/if}
			{#if asking}
				<p class="quiet small-text">
					Reading the session and writing an answer; this can take up to a minute.
				</p>
			{/if}
			{#if askError}<p class="note tone-error">{askError}</p>{/if}
			{#if answer}
				<div class="answer-box">
					<div class="markdown" use:markdown={answer.text}></div>
					<p class="msg-actions pinned">
						<span
							>{answer.costUsd !== undefined
								? `$${answer.costUsd.toFixed(2)}`
								: ''}{answer.durationMs ? ` · ${duration(answer.durationMs)}` : ''}</span
						>
						<button
							type="button"
							class="act"
							onclick={() => {
								navigator.clipboard.writeText(answer?.text ?? '');
								flash('answer');
							}}>{flashed === 'answer' ? 'Copied' : 'Copy'}</button
						>
						<button
							type="button"
							class="act"
							onclick={() => {
								answer = undefined;
								question = '';
							}}>Ask something else</button
						>
					</p>
				</div>
			{/if}
		</section>
	{/if}

	<div class="body">
		<main class="log">
			{#if view.turns.length}
				<div class="toolbar">
					<span class="quiet"
						>{promptTurns} user {promptTurns === 1 ? 'message' : 'messages'} · {totalTools} steps</span
					>
					<span class="toolbar-actions">
						<button type="button" class="link" onclick={selectAll}>Select all</button>
						{#if failedSteps.length}
							<button type="button" class="link del" onclick={nextFailure}
								>Next failed step ({failedSteps.length})</button
							>
						{/if}
						<label class="switch">
							<input
								type="checkbox"
								checked={answersOnly}
								onchange={(e) => setAnswersOnly(e.currentTarget.checked)}
							/>
							<span>Answers only</span>
						</label>
					</span>
				</div>
			{:else}
				<p class="empty">
					Nothing to read here. Claude Code only saved session settings to this transcript, with no
					messages or replies.
				</p>
			{/if}

			{#if selectedCount}
				<div class="selection" role="region" aria-label="Selected messages">
					<span><b>{selectedCount}</b> selected</span>
					<button type="button" class="act" onclick={copySelected}
						>{flashed === 'copy:selection' ? 'Copied' : 'Copy as Markdown'}</button
					>
					<button
						type="button"
						class="act"
						onclick={() =>
							exportParts(selectedItems, `claude-selected-messages-${view.id.slice(0, 8)}.json`)}
						>Export selected</button
					>
					<button type="button" class="act" onclick={() => (selected = {})}>Clear</button>
				</div>
			{/if}

			{#each exchanges as ex (ex.turn.id)}
				{@const t = ex.turn}
				<article class="turn" id="turn-{t.id}">
					{#if t.prompt}
						{@const long = isLong(t.prompt.text)}
						{@const userKey = partKey(t.id, 'user')}
						<div class="user">
							<div class="bubble" class:sel={selected[partKey(t.id, 'user')]}>
								{#if t.prompt.images.length}
									<div class="thumbs">
										{#each t.prompt.images as image (image.index)}
											<button
												type="button"
												class="thumb"
												onclick={() => (lightbox = imageSrc(image))}
												aria-label="Open pasted image"
											>
												<img src={imageSrc(image)} alt="Pasted by you" loading="lazy" />
											</button>
										{/each}
									</div>
								{/if}
								<div class="markdown" class:clamped={long && !open[`prompt-${t.id}`]}>
									<div use:markdown={t.prompt.text}></div>
								</div>
								{#if long}
									<button
										type="button"
										class="link more-btn"
										onclick={() => (open[`prompt-${t.id}`] = !open[`prompt-${t.id}`])}
										>{open[`prompt-${t.id}`] ? 'Show less' : 'Show more'}</button
									>
								{/if}
							</div>
							<div class="msg-actions" class:pinned={selected[userKey]}>
								<span>User · {clock(t.prompt.timestamp)}</span>
								<button type="button" class="act" onclick={() => copyPart(ex, 'user')}
									>{flashed === `copy:${userKey}` ? 'Copied' : 'Copy'}</button
								>
								<button type="button" class="act" onclick={() => exportPart(ex, 'user')}
									>{flashed === `export:${userKey}` ? 'Exported' : 'Export'}</button
								>
								<label class="act">
									<input
										type="checkbox"
										checked={!!selected[userKey]}
										onchange={(e) => (selected[userKey] = e.currentTarget.checked)}
									/>
									Select
								</label>
							</div>
						</div>
					{:else}
						<p class="preamble">Before your first message</p>
					{/if}

					<div class="claude" class:sel={selected[partKey(t.id, 'claude')]}>
						{#if ex.thoughts.length}
							{@const hidden = thoughtsHidden(t.id)}
							<button
								type="button"
								class="thoughts-head"
								aria-expanded={!hidden}
								onclick={() => (hiddenThoughts[t.id] = !hidden)}
							>
								<span class="chev" class:rot={!hidden} aria-hidden="true">›</span>
								<span class="thoughts-label">Thoughts</span>
								{#if ex.thoughtMs}<span>{duration(ex.thoughtMs)}</span>{/if}
								{#if ex.stepCount}<span>{plural(ex.stepCount, 'step')}</span>{/if}
								{#if ex.failed}<span class="del">{ex.failed} failed</span>{/if}
							</button>

							{#if !hidden}
								<div class="thoughts">
									{#each ex.thoughts as seg (seg.kind === 'group' ? seg.id : seg.step.id)}
										{#if seg.kind === 'narration'}
											<div class="narration markdown" use:markdown={seg.step.text}></div>
										{:else if seg.kind === 'note'}
											<p class="note tone-{seg.step.tone}">
												{seg.step.label}{#if seg.step.detail && seg.step.tone === 'error'}: {seg
														.step.detail}{/if}
											</p>
										{:else}
											{@const lines = groupLines(seg)}
											{@const images = seg.tools.flatMap((s) => s.images)}
											{@const links = seg.tools.flatMap((s) => (s.link ? [s.link] : []))}
											<div class="group" class:is-open={open[seg.id]}>
												<button
													type="button"
													class="group-line"
													aria-expanded={!!open[seg.id]}
													onclick={() => (open[seg.id] = !open[seg.id])}
												>
													<span>{groupSummary(seg)}</span>
													{#if seg.errors}<span class="del">({seg.errors} failed)</span>{/if}
													{#if lines.added || lines.removed}
														<span class="lines"
															><span class="add">+{lines.added}</span>
															<span class="del">−{lines.removed}</span></span
														>
													{/if}
													{#if spend(groupCost(seg))}<span class="quiet cost"
															>{spend(groupCost(seg))}</span
														>{/if}
													<span class="chev" class:rot={open[seg.id]} aria-hidden="true">›</span>
												</button>

												{#if open[seg.id]}
													<ul class="rows">
														{#each seg.tools as s (s.id)}
															<li id={s.id} class="cat-{s.category}">
																<button
																	type="button"
																	class="row"
																	class:failed={s.status === 'error'}
																	aria-expanded={!!open[s.id]}
																	onclick={() => (open[s.id] = !open[s.id])}
																>
																	<span class="row-label">{s.label}</span>
																	{#if s.server}<span class="quiet small-text">{s.server}</span
																		>{/if}
																	{#if spend(s.costUsd)}<span class="quiet cost row-cost"
																			>{spend(s.costUsd)}</span
																		>{/if}
																	{#if s.linesAdded || s.linesRemoved}
																		<span class="lines"
																			><span class="add">+{s.linesAdded}</span>
																			<span class="del">−{s.linesRemoved}</span></span
																		>
																	{/if}
																	<span class="chev small" class:rot={open[s.id]} aria-hidden="true"
																		>›</span
																	>
																</button>
																{#if open[s.id]}
																	<div class="detail">
																		<p class="detail-meta">
																			<code>{toolLabel(s.name)}</code>
																			{#if s.summary && s.summary !== s.label}<code
																					>{s.summary}</code
																				>{/if}
																			<span>{duration(s.durationMs)}</span>
																			{#if s.status === 'error'}<span class="del">failed</span>{/if}
																		</p>
																		{#if s.subagentId}
																			<a
																				class="link"
																				href={resolve('/claude/session/[id]', { id: s.subagentId })}
																				>Open subagent transcript →</a
																			>
																		{/if}
																		{#if s.diff}
																			<pre
																				class="io diff">{#each s.diff.split('\n') as line, li (li)}<span
																						class={diffClass(line)}
																						>{line}
</span>{/each}</pre>
																		{:else if s.input}
																			<pre class="io">{s.input}</pre>
																		{/if}
																		{#if s.output && !s.diff}
																			<pre
																				class="io"
																				class:io-err={s.status === 'error'}>{s.output}</pre>
																		{/if}
																	</div>
																{/if}
															</li>
														{/each}
														{#each seg.steps.filter((s) => s.kind !== 'tool') as s (s.id)}
															{#if s.kind === 'thinking'}
																<li class="quiet reasoning">
																	Reasoned{s.text ? '' : ' privately'}{#if s.tokens}&nbsp;· {n(
																			s.tokens
																		)} tokens{/if}
																	{#if s.text}<pre class="io">{s.text}</pre>{/if}
																</li>
															{:else if s.kind === 'event'}
																<li class="quiet reasoning">
																	{s.label}{#if s.detail}<pre class="io">{s.detail}</pre>{/if}
																</li>
															{/if}
														{/each}
													</ul>
												{/if}

												{#if links.length || images.length}
													<div class="media">
														{#each links as link (link.url)}
															<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- dev server the session started -->
															<a class="card" href={link.url} target="_blank" rel="noreferrer">
																<span class="card-title">{link.title}</span>
																<span class="quiet small-text"
																	>{link.url.replace(/^https?:\/\//, '')} · Opened in browser</span
																>
															</a>
														{/each}
														{#each open[`shots-${seg.id}`] ? images : images.slice(0, 3) as image (`${image.line}-${image.index}`)}
															<button
																type="button"
																class="shot"
																onclick={() => (lightbox = imageSrc(image))}
																aria-label="Open screenshot"
															>
																<img
																	src={imageSrc(image)}
																	alt="Screenshot from this step"
																	loading="lazy"
																/>
															</button>
														{/each}
														{#if images.length > 3 && !open[`shots-${seg.id}`]}
															<button
																type="button"
																class="link small-text"
																onclick={() => (open[`shots-${seg.id}`] = true)}
																>+{images.length - 3} more screenshots</button
															>
														{/if}
													</div>
												{/if}
											</div>
										{/if}
									{/each}
								</div>
							{/if}
						{/if}

						{#each ex.answer as s (s.id)}
							<div class="answer markdown" use:markdown={s.text}></div>
						{/each}

						{#if ex.thoughts.length || ex.answer.length}
							{@const key = partKey(t.id, 'claude')}
							<div class="msg-actions claude-actions" class:pinned={selected[key]}>
								<span>Claude · {clock(t.endedAt)}</span>
								{#if spend(t.costUsd)}<span title="Share of the session cost"
										>{spend(t.costUsd)}</span
									>{/if}
								{#if t.durationMs}<span>worked {duration(t.durationMs)}</span>{/if}
								{#if t.tokens.requests}<span
										title="{n(tokensOf(t.tokens))} tokens over {t.tokens.requests} API calls"
										>{formatCompactTokens(tokensOf(t.tokens))} tokens</span
									>{/if}
								{#if t.models.length}<span
										>{t.models.map((m) => m.replace(/^claude-/, '')).join(', ')}</span
									>{/if}
								<button type="button" class="act" onclick={() => copyPart(ex, 'claude')}
									>{flashed === `copy:${key}` ? 'Copied' : 'Copy'}</button
								>
								<button type="button" class="act" onclick={() => exportPart(ex, 'claude')}
									>{flashed === `export:${key}` ? 'Exported' : 'Export'}</button
								>
								<label class="act">
									<input
										type="checkbox"
										checked={!!selected[key]}
										onchange={(e) => (selected[key] = e.currentTarget.checked)}
									/>
									Select
								</label>
							</div>
						{/if}
					</div>
				</article>
			{/each}
		</main>

		<aside class="rail" aria-label="Session context">
			{#if view.recaps.length}
				<section>
					<h3>Recap</h3>
					<p class="recap">{view.recaps.at(-1)?.text}</p>
				</section>
			{/if}

			{#if editedFiles.length}
				<section>
					<h3>Files changed <span class="count">{editedFiles.length}</span></h3>
					{#if changes.files.length}
						<button
							type="button"
							class="link small-text review-link"
							onclick={() => (reviewingChanges = true)}>Review all changes</button
						>
					{/if}
					<ul class="files">
						{#each visibleEdited as f (f.path)}
							<li>
								<button
									type="button"
									class="file"
									title={f.path}
									onclick={() => jumpToStep(f.firstStepId)}
								>
									<span class="fname">{f.path.split('/').at(-1)}</span>
									<span class="lines"
										>{#if f.created}<span class="quiet">new</span>{/if}<span class="add"
											>+{f.linesAdded}</span
										><span class="del">−{f.linesRemoved}</span></span
									>
								</button>
							</li>
						{/each}
					</ul>
					{#if editedFiles.length > 8}
						<button
							type="button"
							class="link small-text"
							onclick={() => (showAllFiles = !showAllFiles)}
						>
							{showAllFiles ? 'Show fewer' : `Show all ${editedFiles.length}`}
						</button>
					{/if}
				</section>
			{/if}

			{#if view.subagents.length}
				{@const totals = view.subagents.reduce(
					(a, sub) => ({
						tokens: a.tokens + (sub.totals?.tokens ?? 0),
						steps: a.steps + (sub.totals?.steps ?? 0)
					}),
					{ tokens: 0, steps: 0 }
				)}
				<section>
					<h3>Subagents <span class="count">{view.subagents.length}</span></h3>
					{#if totals.tokens}
						<p class="quiet small-text sub-total">
							{formatCompactTokens(totals.tokens)} tokens · {plural(totals.steps, 'step')} on top of this
							session
						</p>
					{/if}
					<ul class="files">
						{#each view.subagents as sub (sub.id)}
							<li>
								{#if sub.sessionId}
									<a class="file sub" href={resolve('/claude/session/[id]', { id: sub.sessionId })}>
										<span class="fname">{sub.description ?? sub.type ?? 'Subagent'}</span>
										<span class="quiet small-text"
											>{#if sub.totals}{formatCompactTokens(sub.totals.tokens)} · {sub.totals.steps} steps{#if sub.totals.failed}
													· <span class="del">{sub.totals.failed} failed</span>{/if}{/if} →</span
										>
									</a>
								{:else}
									<button type="button" class="file" onclick={() => jumpToStep(sub.stepId)}>
										<span class="fname">{sub.description ?? sub.type ?? 'Subagent'}</span>
										<span class="quiet small-text">{sub.type ?? ''}</span>
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section>
				<h3>Setup</h3>
				<ul class="kv">
					{#each view.models.filter((m) => m.requests > 0) as m (m.model)}
						<li><span>Model</span><b class="mono">{m.model.replace(/^claude-/, '')}</b></li>
					{/each}
					{#if view.permissionModes.length}<li>
							<span>Permissions</span><b>{view.permissionModes.join(', ')}</b>
						</li>{/if}
					{#if view.efforts.length}<li><span>Effort</span><b>{view.efforts.join(', ')}</b></li>{/if}
					{#if view.entrypoints.length}<li>
							<span>Started from</span><b>{view.entrypoints.join(', ')}</b>
						</li>{/if}
					{#if view.versions.length}<li><span>Version</span><b>{view.versions.at(-1)}</b></li>{/if}
				</ul>
				{#if !view.imported}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string -->
					<a class="link small-text resume" href={`${resolve('/compare')}?a=${view.id}`}
						>Compare with another session</a
					>
					<button
						type="button"
						class="link small-text resume"
						onclick={copyResume}
						title={resumeCommand}
						>{flashed === 'resume'
							? 'Copied resume command'
							: 'Copy command to resume in terminal'}</button
					>
				{/if}
			</section>

			<!-- Reference material: folded so it doesn't compete with the conversation. -->
			<div class="folds">
				{#if view.toolNames.length}
					<details>
						<summary>Tools used <span class="count">{view.toolNames.length}</span></summary>
						<ul class="kv">
							{#each view.toolNames as tool (tool.name)}
								<li>
									<span class="mono">{toolLabel(tool.name)}</span><b
										>{tool.count}{#if tool.errors}<span class="del">
												· {tool.errors} failed</span
											>{/if}</b
									>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
				{#if readOnlyFiles.length}
					<details>
						<summary>Files read <span class="count">{readOnlyFiles.length}</span></summary>
						<ul class="files">
							{#each readOnlyFiles as f (f.path)}
								<li>
									<button
										type="button"
										class="file"
										title={f.path}
										onclick={() => jumpToStep(f.firstStepId)}
									>
										<span class="fname">{f.path.split('/').at(-1)}</span>
									</button>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
				{#if view.mcpServers.length}
					<details>
						<summary>MCP servers <span class="count">{view.mcpServers.length}</span></summary>
						<ul class="kv">
							{#each view.mcpServers as server (server.name)}
								<li>
									<span class="mono" title={server.name}
										>{server.name.length > 24 ? `${server.name.slice(0, 8)}…` : server.name}</span
									><b>{server.calls ? `${server.calls} calls` : 'not used'}</b>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
				{#if view.skills.length || view.slashCommands.length}
					<details>
						<summary
							>Skills & commands <span class="count"
								>{view.skills.length + view.slashCommands.length}</span
							></summary
						>
						<ul class="kv">
							{#each view.skills as skill (skill.name)}
								<li><span class="mono">{skill.name}</span><b>skill · {skill.count}×</b></li>
							{/each}
							{#each view.slashCommands as cmd (cmd.name)}
								<li><span class="mono">{cmd.name}</span><b>command · {cmd.count}×</b></li>
							{/each}
						</ul>
					</details>
				{/if}
				{#if view.hooks.length}
					<details>
						<summary>Hooks <span class="count">{view.hooks.length}</span></summary>
						<ul class="kv">
							{#each view.hooks as hook (hook.name)}
								<li>
									<span class="mono">{hook.name}</span><b
										>{hook.count}×{#if hook.cancelled}
											· {hook.cancelled} cancelled{/if}</b
									>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
				{#if view.instructions.length}
					<details>
						<summary
							>Instructions loaded <span class="count">{view.instructions.length}</span></summary
						>
						<ul class="kv">
							{#each view.instructions as file (file.path)}
								<li title={file.path}>
									<span class="mono">{file.path.split('/').slice(-2).join('/')}</span><b
										>{file.type ?? ''}</b
									>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</div>
		</aside>
	</div>
	<!-- Always-visible session state, like the bar under a Claude Code desktop session. -->
	<footer class="bar" aria-label="Session state">
		{#if replayAt !== undefined && timeline}
			<button type="button" class="act" onclick={() => (playing = !playing)}
				>{playing ? 'Pause' : 'Play'}</button
			>
			<input
				class="scrub"
				type="range"
				min={timeline.start}
				max={timeline.end}
				step={Math.max(1000, (timeline.end - timeline.start) / 1000)}
				value={replayAt}
				oninput={(e) => {
					playing = false;
					replayAt = Number(e.currentTarget.value);
				}}
				aria-label="Replay position"
			/>
			<span class="mono">{clock(new Date(replayAt).toISOString())}</span>
			<span class="quiet">{plural(replayStats.files, 'file')} changed</span>
			{#if view.cost}<span class="mono">{usd(replayStats.costUsd)} so far</span>{/if}
			<button type="button" class="act bar-end" onclick={stopReplay}>Exit replay</button>
		{:else}
			{#if view.gitBranches.length}<span class="mono">⎇ {view.gitBranches.at(-1)}</span>{/if}
			{#each view.pullRequests as pr (pr)}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external pull request -->
				<a class="link mono" href={pr} target="_blank" rel="noreferrer"
					>PR #{pr.match(/(\d+)$/)?.[1]} ↗</a
				>
			{/each}
			<span class="mono"
				><span class="add">+{n(linesAdded)}</span> <span class="del">−{n(linesRemoved)}</span></span
			>
			<span class="quiet">{plural(editedFiles.length, 'file')} changed</span>
			{#if timeline && !live}<button type="button" class="act" onclick={startReplay}>Replay</button
				>{/if}
			{#if view.cost}<span class="bar-end mono"
					>{usd(view.cost.usd)}{#if live}<span class="quiet"> so far</span>{/if}</span
				>{/if}
		{/if}
	</footer>

	{#if reviewingChanges}
		<div
			class="review-backdrop"
			role="presentation"
			onclick={() => (reviewingChanges = false)}
		></div>
		<div class="review" role="dialog" aria-modal="true" aria-label="All changes in this session">
			<FileDiffViewer summary={changes} onClose={() => (reviewingChanges = false)} />
		</div>
	{/if}

	{#if lightbox}
		<div class="lightbox" role="presentation" onclick={() => (lightbox = undefined)}>
			<img src={lightbox} alt="Full size" />
			<button type="button" class="lightbox-close" onclick={() => (lightbox = undefined)}
				>Close</button
			>
		</div>
	{/if}
</div>

<svelte:window
	onkeydown={(e) => {
		if (e.key !== 'Escape') return;
		lightbox = undefined;
		reviewingChanges = false;
	}}
/>

<style>
	.cv {
		--clay: #d97757;
		--clay-soft: rgba(217, 119, 87, 0.1);
		--c-read: #7aa2f7;
		--c-edit: #4ade80;
		--c-shell: #e0af68;
		--c-mcp: #2dd4bf;
		--c-agent: #c084fc;
		--c-web: #f472b6;
		--c-other: #94a3b8;
		--quiet: color-mix(in srgb, var(--muted) 72%, transparent);
		--mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
		--cond: 'IBM Plex Sans Condensed', 'Plus Jakarta Sans', system-ui, sans-serif;
		max-width: 1120px;
		min-width: 0;
		margin: 0 auto;
		color: var(--ink);
	}

	/* Long code lines and wide tables scroll inside their block instead of widening the page. */
	.cv :global(.markdown) {
		min-width: 0;
		overflow-wrap: break-word;
	}
	.cv :global(.markdown pre),
	.cv :global(.markdown table) {
		display: block;
		max-width: 100%;
		overflow-x: auto;
	}

	.cat-read {
		--c: var(--c-read);
	}
	.cat-edit {
		--c: var(--c-edit);
	}
	.cat-shell {
		--c: var(--c-shell);
	}
	.cat-mcp {
		--c: var(--c-mcp);
	}
	.cat-agent {
		--c: var(--c-agent);
	}
	.cat-web {
		--c: var(--c-web);
	}
	.cat-other {
		--c: var(--c-other);
	}

	.add {
		color: var(--c-edit);
	}
	.del {
		color: var(--danger);
	}
	.quiet {
		color: var(--quiet);
	}
	.mono {
		font-family: var(--mono);
		font-size: 12px;
	}
	.small-text {
		font-size: 12px;
	}

	.dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--c, var(--muted));
		flex-shrink: 0;
	}

	.link {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: var(--muted);
		cursor: pointer;
		text-decoration: none;
	}
	.link:hover {
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	button:focus-visible,
	a:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--clay);
		outline-offset: 2px;
		border-radius: 4px;
	}

	h3,
	summary,
	.stats dt {
		font-family: var(--cond);
		font-size: 11.5px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--quiet);
	}

	/* Header */
	.head {
		padding: 8px 0 24px;
	}
	.eyebrow {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--clay);
	}
	.live-tag {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 1px 8px;
		border-radius: 999px;
		background: rgba(74, 222, 128, 0.12);
		color: #4ade80;
		font-size: 11.5px;
		font-weight: 600;
	}
	.live-tag i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.live-tag i {
			animation: none;
		}
	}
	.imported-tag {
		padding: 1px 8px;
		border-radius: 999px;
		background: var(--panel-subtle);
		color: var(--muted);
		font-size: 11.5px;
		font-weight: 500;
	}
	.eyebrow .quiet {
		font-weight: 400;
	}
	.mark {
		width: 8px;
		height: 8px;
		background: var(--clay);
		transform: rotate(45deg);
	}
	h1 {
		margin: 10px 0 12px;
		font-size: clamp(22px, 2.4vw, 28px);
		line-height: 1.25;
		font-weight: 700;
		letter-spacing: -0.015em;
		max-width: 40ch;
		text-wrap: balance;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px 18px;
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	.actions {
		display: inline-flex;
		gap: 14px;
		margin-left: auto;
		font-size: 12.5px;
	}

	/* Overview */
	.overview {
		padding: 18px 0;
		border-block: 1px solid var(--line-subtle);
		margin-bottom: 36px;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 16px;
		margin: 0;
	}
	.stats div {
		min-width: 0;
	}
	.stats dd {
		margin: 4px 0 0;
		font-family: var(--mono);
		font-size: 22px;
		font-weight: 500;
		letter-spacing: -0.02em;
		white-space: nowrap;
	}
	.track {
		display: flex;
		gap: 2px;
		height: 18px;
		margin-top: 18px;
	}
	.seg {
		position: relative;
		flex-basis: 0;
		min-width: 4px;
		padding: 0;
		border: 0;
		border-radius: 2px;
		background: var(--panel-subtle);
		cursor: pointer;
		overflow: hidden;
	}
	.seg:hover {
		background: #2c3242;
	}
	.seg.preamble {
		opacity: 0.5;
	}
	.seg.interrupted {
		background-image: repeating-linear-gradient(
			135deg,
			transparent 0 4px,
			rgba(251, 191, 36, 0.16) 4px 6px
		);
	}
	.tick {
		position: absolute;
		top: 5px;
		bottom: 5px;
		width: 2px;
		border-radius: 1px;
		background: var(--c);
		opacity: 0.75;
	}
	.tick.err {
		background: var(--danger);
		top: 2px;
		bottom: 2px;
		opacity: 1;
	}
	.details-toggle {
		margin-top: 14px;
		font-size: 12.5px;
	}
	.details {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 20px 32px;
		margin-top: 16px;
	}
	.details h3 {
		margin: 0 0 10px;
	}
	.mix {
		display: flex;
		height: 6px;
		margin-bottom: 10px;
		border-radius: 3px;
		overflow: hidden;
		background: var(--panel-subtle);
	}
	.mix i {
		display: block;
		height: 100%;
	}
	.mix-cacheRead {
		--c: var(--token-cached);
		background: var(--token-cached);
	}
	.mix-cacheWrite {
		--c: #0f766e;
		background: #0f766e;
	}
	.mix-fresh {
		--c: var(--token-input);
		background: var(--token-input);
	}
	.mix-output {
		--c: var(--token-output);
		background: var(--token-output);
	}

	.kv {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 7px;
		font-size: 13px;
	}
	.kv li {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		min-width: 0;
	}
	.kv li > span {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--muted);
	}
	.kv b {
		font-family: var(--mono);
		font-size: 12px;
		font-weight: 500;
		text-align: right;
		white-space: nowrap;
	}

	/* Body */
	.body {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: 56px;
		align-items: start;
	}
	.log {
		max-width: 760px;
		min-width: 0;
	}
	.toolbar {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 28px;
		font-size: 12.5px;
		color: var(--quiet);
	}
	.empty {
		color: var(--muted);
		font-size: 15px;
	}

	/* Conversation */
	.toolbar-actions {
		display: inline-flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		gap: 4px 18px;
		white-space: nowrap;
	}
	.switch {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--muted);
		cursor: pointer;
	}
	.switch input {
		accent-color: var(--clay);
	}

	.turn {
		margin-bottom: 44px;
		scroll-margin-top: 80px;
	}
	.preamble {
		margin: 0 0 8px;
		font-size: 12px;
		color: var(--quiet);
	}

	/* Your message: right-aligned bubble, like a chat. */
	.user {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
		margin-bottom: 22px;
	}
	.bubble {
		max-width: min(85%, 620px);
		padding: 12px 16px;
		border-radius: 16px 16px 4px 16px;
		background: var(--panel-subtle);
		font-size: 14.5px;
		line-height: 1.6;
	}
	.bubble .clamped {
		max-height: 180px;
		overflow: hidden;
		mask-image: linear-gradient(to bottom, #000 60%, transparent);
	}
	.more-btn {
		margin-top: 6px;
		font-size: 12.5px;
	}
	/* Per-message actions: quiet until the message is hovered, focused or selected. */
	.msg-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		font-size: 11.5px;
		color: var(--quiet);
	}
	.msg-actions .act {
		opacity: 0;
		transition: opacity 120ms;
	}
	.turn .user:hover .act,
	.turn .user:focus-within .act,
	.claude:hover .claude-actions .act,
	.claude:focus-within .claude-actions .act,
	.msg-actions.pinned .act {
		opacity: 1;
	}
	.claude-actions {
		margin-top: 8px;
	}
	.claude-actions > span:not(:first-child) {
		opacity: 0;
		transition: opacity 120ms;
	}
	.claude:hover .claude-actions > span,
	.claude:focus-within .claude-actions > span,
	.claude-actions.pinned > span {
		opacity: 1;
	}
	.act {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 0;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		cursor: pointer;
	}
	.act:hover {
		color: var(--ink);
	}
	.act input {
		accent-color: var(--clay);
		margin: 0;
	}
	.bubble.sel {
		box-shadow: 0 0 0 1.5px var(--clay);
	}
	.claude {
		border-radius: 8px;
		transition: box-shadow 120ms;
	}
	.claude.sel {
		box-shadow: -12px 0 0 -10px var(--clay);
	}
	.selection {
		position: sticky;
		top: 64px;
		z-index: 6;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 18px;
		margin: -12px 0 24px;
		padding: 8px 14px;
		border: 1px solid rgba(217, 119, 87, 0.4);
		border-radius: 10px;
		background: color-mix(in srgb, var(--panel) 94%, transparent);
		backdrop-filter: blur(8px);
		font-size: 12.5px;
	}
	.thumbs {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 8px;
	}
	.thumb,
	.shot {
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--field);
		overflow: hidden;
		cursor: zoom-in;
	}
	.thumb img {
		display: block;
		max-width: 220px;
		max-height: 140px;
		object-fit: cover;
	}

	/* Claude's side */
	.thoughts-head {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 2px 0;
		border: 0;
		background: none;
		color: var(--quiet);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.thoughts-head:hover {
		color: var(--ink);
	}
	.thoughts-label {
		font-weight: 600;
		color: var(--muted);
	}
	.thoughts {
		margin: 8px 0 18px 4px;
		padding-left: 16px;
		border-left: 1px solid var(--line-subtle);
	}
	.narration {
		margin: 10px 0;
		font-size: 14px;
		line-height: 1.6;
		color: var(--muted);
	}
	.narration :global(p) {
		margin: 0.2em 0;
	}
	.note {
		margin: 10px 0;
		font-size: 13px;
		color: var(--muted);
	}
	.note.tone-warn {
		color: #fbbf24;
	}
	.note.tone-error {
		color: var(--danger);
	}

	.group {
		margin: 6px 0;
	}
	.group-line {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 3px 0;
		border: 0;
		background: none;
		color: var(--quiet);
		font: inherit;
		font-size: 13.5px;
		text-align: left;
		cursor: pointer;
	}
	.group-line:hover {
		color: var(--ink);
	}
	.chev {
		display: inline-block;
		font-size: 14px;
		line-height: 1;
		color: var(--quiet);
		transition: transform 120ms;
	}
	.chev.rot {
		transform: rotate(90deg);
	}
	.chev.small {
		margin-left: auto;
		font-size: 13px;
	}
	.lines {
		display: inline-flex;
		gap: 6px;
		font-family: var(--mono);
		font-size: 12px;
	}

	.rows {
		list-style: none;
		margin: 6px 0 10px;
		padding: 0;
		border: 1px solid var(--line-subtle);
		border-radius: 10px;
		overflow: hidden;
	}
	.rows > li + li {
		border-top: 1px solid var(--line-subtle);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 36px;
		padding: 6px 12px;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
	.row:hover {
		background: var(--panel);
		color: var(--ink);
	}
	.row.failed .row-label {
		color: var(--danger);
	}
	.row-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.reasoning {
		padding: 8px 12px;
		font-size: 12.5px;
		font-style: italic;
	}
	.detail {
		padding: 4px 12px 10px;
		border-top: 1px dashed var(--line-subtle);
		background: color-mix(in srgb, var(--panel) 50%, transparent);
	}

	.media {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 10px;
		margin: 8px 0 12px;
	}
	.shot img {
		display: block;
		width: 180px;
		height: 112px;
		object-fit: cover;
		object-position: top;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 220px;
		padding: 10px 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel);
		color: var(--ink);
		text-decoration: none;
	}
	.card:hover {
		border-color: var(--clay);
	}
	.card-title {
		font-weight: 600;
		font-size: 13.5px;
	}

	.answer {
		margin: 4px 0 10px;
		font-size: 15px;
		line-height: 1.7;
		color: var(--ink);
	}

	/* Session state bar */
	.bar {
		position: sticky;
		bottom: 12px;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 18px;
		margin: 24px 0 12px;
		padding: 10px 16px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: color-mix(in srgb, var(--panel) 92%, transparent);
		backdrop-filter: blur(8px);
		font-size: 12.5px;
	}
	.scrub {
		flex: 1;
		min-width: 120px;
		accent-color: var(--clay);
	}
	.bar-end {
		margin-left: auto;
	}

	.context-chart {
		grid-column: 1 / -1;
	}
	.context-chart svg {
		display: block;
		width: 100%;
		height: 70px;
		overflow: visible;
	}
	.context-chart .area {
		fill: color-mix(in srgb, var(--token-cached) 14%, transparent);
	}
	.context-chart .trace {
		fill: none;
		stroke: var(--token-cached);
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
	}
	.context-chart .window {
		stroke: var(--line);
		stroke-dasharray: 4 4;
		vector-effect: non-scaling-stroke;
	}
	.context-chart .reset {
		stroke: var(--clay);
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
	}
	.context-chart p {
		margin: 6px 0 0;
	}
	.reset-key {
		color: var(--clay);
		font-weight: 700;
	}
	.sub-total {
		margin: -4px 0 8px;
	}

	.ask {
		margin: -12px 0 32px;
	}
	.ask form {
		display: flex;
		gap: 8px;
	}
	.ask input {
		flex: 1;
		min-width: 0;
		padding: 10px 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--field);
		color: var(--ink);
		font: inherit;
		font-size: 14px;
	}
	.ask input:focus {
		outline: 2px solid var(--clay);
		outline-offset: 1px;
	}
	.ask form button {
		padding: 0 18px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel-subtle);
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.ask form button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.ask-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 10px 0 6px;
	}
	.ask-chips button {
		padding: 4px 10px;
		border: 1px solid var(--line-subtle);
		border-radius: 999px;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 12.5px;
		cursor: pointer;
	}
	.ask-chips button:hover {
		border-color: var(--clay);
		color: var(--ink);
	}
	.ask code {
		font-size: 11.5px;
	}
	.answer-box {
		margin-top: 14px;
		padding: 14px 18px;
		border: 1px solid var(--line-subtle);
		border-left: 3px solid var(--clay);
		border-radius: 10px;
		font-size: 14.5px;
		line-height: 1.65;
	}
	.resume {
		display: block;
		margin-top: 10px;
	}

	/* "Worth a look": a few plain lines, each a link to the step it is about. */
	.insights {
		margin-top: 16px;
	}
	.insights h3 {
		margin: 0 0 6px;
	}
	.insights ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.insight {
		display: block;
		width: 100%;
		padding: 4px 0 4px 14px;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 13px;
		line-height: 1.5;
		text-align: left;
		cursor: pointer;
		position: relative;
	}
	.insight::before {
		content: '';
		position: absolute;
		left: 0;
		top: 11px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--quiet);
	}
	.tone-warn .insight::before {
		background: #fbbf24;
	}
	.insight:hover {
		color: var(--ink);
	}
	.cost {
		font-family: var(--mono);
		font-size: 11.5px;
	}
	.row-cost {
		margin-left: auto;
	}
	.review-link {
		display: block;
		margin: -4px 0 8px;
	}
	.review-backdrop {
		position: fixed;
		inset: 0;
		z-index: 59;
		background: rgba(5, 7, 10, 0.7);
	}
	.review {
		position: fixed;
		inset: 24px;
		z-index: 60;
		display: flex;
		flex-direction: column;
		padding: 16px;
		overflow: auto;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--canvas);
		box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
	}

	.lightbox {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: center;
		padding: 32px;
		background: rgba(5, 7, 10, 0.86);
		cursor: zoom-out;
	}
	.lightbox img {
		max-width: 100%;
		max-height: 100%;
		border-radius: 8px;
	}
	.lightbox-close {
		position: absolute;
		top: 16px;
		right: 20px;
		padding: 6px 12px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}

	.detail-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		margin: 4px 0 8px;
		font-size: 12px;
		color: var(--quiet);
	}
	.detail-meta code {
		font-family: var(--mono);
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.io {
		margin: 0 0 8px;
		max-height: 300px;
		overflow: auto;
		padding: 10px 12px;
		border-radius: 6px;
		background: var(--field);
		font-family: var(--mono);
		font-size: 12px;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.io-err {
		box-shadow: inset 2px 0 0 var(--danger);
	}
	.diff {
		white-space: pre;
	}
	.diff span {
		display: block;
	}
	.diff .add {
		background: rgba(74, 222, 128, 0.08);
	}
	.diff .del {
		background: var(--danger-soft);
	}
	.diff .hunk {
		color: var(--c-read);
	}
	.diff .meta {
		color: var(--quiet);
	}

	/* Rail */
	.rail {
		position: sticky;
		top: 72px;
		max-height: calc(100vh - 90px);
		overflow-y: auto;
		padding-bottom: 24px;
		font-size: 13px;
	}
	.rail section {
		margin-bottom: 28px;
	}
	.rail h3 {
		margin: 0 0 10px;
		display: flex;
		gap: 6px;
		align-items: baseline;
	}
	.count {
		font-family: var(--mono);
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
		color: var(--muted);
	}
	.recap {
		margin: 0;
		line-height: 1.6;
		color: var(--muted);
	}
	.files {
		list-style: none;
		margin: 0 0 6px;
		padding: 0;
	}
	.file {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
		padding: 4px 6px;
		margin-left: -6px;
		border: 0;
		border-radius: 5px;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	.file:hover {
		background: var(--panel);
	}
	.fname {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
		font-size: 12px;
	}
	.folds {
		border-top: 1px solid var(--line-subtle);
	}
	details {
		border-bottom: 1px solid var(--line-subtle);
	}
	summary {
		display: flex;
		align-items: baseline;
		gap: 6px;
		padding: 11px 0;
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary::after {
		content: '+';
		margin-left: auto;
		font-family: var(--mono);
		color: var(--quiet);
	}
	details[open] summary::after {
		content: '−';
	}
	summary:hover {
		color: var(--ink);
	}
	details > ul {
		padding-bottom: 12px;
	}

	@media (max-width: 1100px) {
		.body {
			grid-template-columns: minmax(0, 1fr);
			gap: 32px;
		}
		.rail {
			position: static;
			max-height: none;
		}
		.rail section {
			margin-bottom: 20px;
		}
	}
	@media (max-width: 640px) {
		.stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.actions {
			margin-left: 0;
		}
		.tool .summary {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.work-line,
		.chev {
			transition: none;
		}
	}
</style>
