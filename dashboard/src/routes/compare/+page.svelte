<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { formatCompactTokens } from '$lib/project';
	import type { FileOverlap, SessionMetrics } from '../../../../src/compare.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const a = $derived(data.a as SessionMetrics | undefined);
	const b = $derived(data.b as SessionMetrics | undefined);
	const overlap = $derived(data.overlap as FileOverlap | undefined);

	function pick(side: 'a' | 'b', id: string) {
		const params = new URLSearchParams({
			a: side === 'a' ? id : (a?.id ?? ''),
			b: side === 'b' ? id : (b?.id ?? '')
		});
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string
		goto(`${resolve('/compare')}?${params}`);
	}

	const usd = (v?: number) => (v === undefined ? '—' : `$${v.toFixed(2)}`);
	function duration(ms: number): string {
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		return m < 60
			? `${m}m ${String(s % 60).padStart(2, '0')}s`
			: `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
	}

	type Row = {
		label: string;
		a?: number;
		b?: number;
		show: (v: number) => string;
		lowerIsBetter?: boolean;
	};
	const rows = $derived<Row[]>(
		a && b
			? [
					{ label: 'Cost', a: a.costUsd, b: b.costUsd, show: (v) => usd(v), lowerIsBetter: true },
					{
						label: 'Working time',
						a: a.workingMs,
						b: b.workingMs,
						show: duration,
						lowerIsBetter: true
					},
					{
						label: 'Messages from you',
						a: a.messages,
						b: b.messages,
						show: String,
						lowerIsBetter: true
					},
					{
						label: 'Tokens',
						a: a.tokens,
						b: b.tokens,
						show: formatCompactTokens,
						lowerIsBetter: true
					},
					{ label: 'Served from cache', a: a.cacheHitPct, b: b.cacheHitPct, show: (v) => `${v}%` },
					{
						label: 'Peak context',
						a: a.peakContext,
						b: b.peakContext,
						show: formatCompactTokens,
						lowerIsBetter: true
					},
					{ label: 'Steps', a: a.steps, b: b.steps, show: String, lowerIsBetter: true },
					{ label: 'Failed steps', a: a.failed, b: b.failed, show: String, lowerIsBetter: true },
					{ label: 'Lines added', a: a.linesAdded, b: b.linesAdded, show: String },
					{ label: 'Lines removed', a: a.linesRemoved, b: b.linesRemoved, show: String },
					{
						label: 'Cache rebuilt',
						a: a.cacheResets,
						b: b.cacheResets,
						show: String,
						lowerIsBetter: true
					},
					{
						label: 'Compactions',
						a: a.compactions,
						b: b.compactions,
						show: String,
						lowerIsBetter: true
					}
				]
			: []
	);

	/** "B used 40% less" style comparison; only for metrics where lower is clearly better. */
	function verdict(row: Row): { text: string; good?: boolean } | undefined {
		if (row.a === undefined || row.b === undefined || row.a === row.b) return undefined;
		if (!row.a) return { text: row.b > 0 ? 'new in B' : '' };
		const pct = Math.round(((row.b - row.a) / row.a) * 100);
		if (pct === 0) return undefined;
		const text = `${pct > 0 ? '+' : ''}${pct}%`;
		return {
			text,
			good: row.lowerIsBetter === undefined ? undefined : row.lowerIsBetter ? pct < 0 : pct > 0
		};
	}
	const short = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');
</script>

<svelte:head><title>Compare sessions — Agent Session Inspect</title></svelte:head>

<div class="page">
	<h1>Compare sessions</h1>
	<p class="quiet">
		Two Claude Code sessions side by side, for example the same task with a different model or
		prompt.
	</p>

	<div class="pickers">
		{#each ['a', 'b'] as const as side (side)}
			{@const current = side === 'a' ? a : b}
			<label>
				<span class="side">{side.toUpperCase()}</span>
				<select value={current?.id ?? ''} onchange={(e) => pick(side, e.currentTarget.value)}>
					<option value="" disabled>Choose a session…</option>
					{#each data.options as option (option.id)}
						<option value={option.id}
							>{option.title.slice(0, 80)} · {option.updatedAt?.slice(0, 10)}</option
						>
					{/each}
				</select>
			</label>
		{/each}
	</div>

	{#if a && b}
		<table>
			<thead>
				<tr>
					<th></th>
					<th
						><a href={resolve('/claude/session/[id]', { id: a.id })}>A</a>
						<span class="quiet">{a.models.join(', ')}</span></th
					>
					<th
						><a href={resolve('/claude/session/[id]', { id: b.id })}>B</a>
						<span class="quiet">{b.models.join(', ')}</span></th
					>
					<th>B vs A</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.label)}
					{@const v = verdict(row)}
					<tr>
						<th scope="row">{row.label}</th>
						<td>{row.a === undefined ? '—' : row.show(row.a)}</td>
						<td>{row.b === undefined ? '—' : row.show(row.b)}</td>
						<td class:good={v?.good === true} class:bad={v?.good === false}>{v?.text ?? ''}</td>
					</tr>
				{/each}
			</tbody>
		</table>

		{#if overlap}
			<section class="files">
				<h2>Files changed</h2>
				<div class="cols">
					<div>
						<h3>Both <span class="quiet">{overlap.both.length}</span></h3>
						<ul>
							{#each overlap.both as f (f)}<li>{short(f)}</li>{/each}
						</ul>
					</div>
					<div>
						<h3>Only A <span class="quiet">{overlap.onlyA.length}</span></h3>
						<ul>
							{#each overlap.onlyA as f (f)}<li>{short(f)}</li>{/each}
						</ul>
					</div>
					<div>
						<h3>Only B <span class="quiet">{overlap.onlyB.length}</span></h3>
						<ul>
							{#each overlap.onlyB as f (f)}<li>{short(f)}</li>{/each}
						</ul>
					</div>
				</div>
			</section>
		{/if}
	{:else}
		<p class="quiet">Pick two sessions to compare.</p>
	{/if}
</div>

<style>
	.page {
		max-width: 940px;
		margin: 0 auto;
		padding: 8px 0 60px;
	}
	h1 {
		margin: 0 0 4px;
		font-size: 24px;
	}
	.quiet {
		color: var(--muted);
		font-size: 13px;
	}
	.pickers {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		margin: 20px 0 24px;
	}
	label {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.side {
		font-weight: 700;
		color: #d97757;
	}
	select {
		flex: 1;
		min-width: 0;
		padding: 9px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--field);
		color: var(--ink);
		font: inherit;
		font-size: 13px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13.5px;
	}
	th,
	td {
		padding: 9px 10px;
		border-bottom: 1px solid var(--line-subtle);
		text-align: right;
	}
	th:first-child,
	tbody th {
		text-align: left;
		font-weight: 500;
		color: var(--muted);
	}
	thead th {
		font-size: 12px;
		color: var(--muted);
	}
	thead a {
		color: var(--ink);
		font-weight: 700;
	}
	td {
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
		font-size: 12.5px;
	}
	td.good {
		color: #4ade80;
	}
	td.bad {
		color: var(--danger);
	}
	.files {
		margin-top: 28px;
	}
	h2 {
		margin: 0 0 10px;
		font-size: 12px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--muted);
	}
	h3 {
		margin: 0 0 6px;
		font-size: 13px;
	}
	.cols {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 20px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
		font-size: 12px;
		line-height: 1.7;
		overflow-wrap: anywhere;
		color: var(--muted);
	}
	@media (max-width: 720px) {
		.pickers,
		.cols {
			grid-template-columns: 1fr;
		}
	}
</style>
