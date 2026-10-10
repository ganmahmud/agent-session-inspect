<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { resolve } from '$app/paths';
	import { highlightParts, relativeDay, sessionLink } from '$lib/session-links';
	import type { SearchKind, SearchResults } from '../../../../src/search.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const results = $derived(data.results as SearchResults);

	const KINDS: Array<{ key: SearchKind; label: string }> = [
		{ key: 'prompt', label: 'Your messages' },
		{ key: 'reply', label: 'Answers' },
		{ key: 'note', label: 'Notes' },
		{ key: 'command', label: 'Commands' },
		{ key: 'tool', label: 'Tool calls' }
	];
	const KIND_TAG: Record<SearchKind, string> = {
		prompt: 'You',
		reply: 'Answer',
		note: 'Note',
		command: 'Command',
		tool: 'Tool'
	};
	const RECENT_KEY = 'asi_recent_searches';
	const SHOWN_PER_SESSION = 3;

	// The box keeps what is typed; it only follows the URL when that changes some other way (back/forward, links).
	let q = $state('');
	let lastSent = $state<string | undefined>(undefined);
	$effect(() => {
		if (data.query !== lastSent) q = data.query;
	});

	let input: HTMLInputElement;
	let expanded = $state<Record<string, boolean>>({});
	let active = $state(-1);
	let recent = $state<string[]>([]);
	const searching = $derived(navigating.to?.url.pathname === resolve('/search'));

	function urlFor(changes: Record<string, string | undefined>): string {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- built and turned into a string right away
		const params = new URLSearchParams(page.url.searchParams);
		for (const [key, value] of Object.entries(changes)) {
			if (value) params.set(key, value);
			else params.delete(key);
		}
		const query = params.toString();
		return `${resolve('/search')}${query ? `?${query}` : ''}`;
	}

	function go(changes: Record<string, string | undefined>) {
		active = -1;
		expanded = {};
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- urlFor() builds on resolve('/search')
		goto(urlFor(changes), { replaceState: true, keepFocus: true, noScroll: true });
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			lastSent = q.trim();
			go({ q: q.trim() || undefined });
		}, 250);
	}

	function remember(query = q.trim()) {
		if (query.length < 2) return;
		recent = [query, ...recent.filter((item) => item !== query)].slice(0, 8);
		try {
			localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
		} catch {
			// Private mode or storage disabled: recent searches just aren't kept.
		}
	}

	function useQuery(query: string) {
		q = query;
		lastSent = query;
		go({ q: query });
		input?.focus();
	}

	function toggleKind(kind: SearchKind) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- built and turned into a string right away
		const current = new Set(data.filters.kinds ?? []);
		if (current.has(kind)) current.delete(kind);
		else current.add(kind);
		go({ kind: [...current].join(',') || undefined });
	}

	const filtersActive = $derived(
		Boolean(
			data.filters.agent || data.filters.kinds?.length || data.filters.project || data.filters.days
		)
	);
	function clearFilters() {
		go({ agent: undefined, kind: undefined, project: undefined, days: undefined });
	}

	// Flat list of visible results, for arrow-key movement.
	const visible = $derived(
		results.groups.flatMap((group) =>
			(expanded[group.id] ? group.hits : group.hits.slice(0, SHOWN_PER_SESSION)).map((hit) => ({
				href: sessionLink(group.id, group.agent, hit.doc.anchor),
				key: `${group.id}:${hit.doc.anchor ?? hit.doc.timestamp}:${hit.snippet.slice(0, 40)}`
			}))
		)
	);
	const indexOf = (key: string) => visible.findIndex((item) => item.key === key);

	async function move(step: number) {
		if (!visible.length) return;
		active = (active + step + visible.length) % visible.length;
		await tick();
		document.querySelector(`[data-hit="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	function onKeydown(event: KeyboardEvent) {
		const typing =
			event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
		if (event.key === '/' && !typing) {
			event.preventDefault();
			input?.focus();
			input?.select();
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			move(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			move(-1);
		} else if (event.key === 'Enter' && active >= 0 && visible[active]) {
			event.preventDefault();
			remember();
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- sessionLink() resolves the path
			goto(visible[active].href);
		} else if (event.key === 'Escape' && document.activeElement === input && q) {
			q = '';
			onInput();
		}
	}

	onMount(() => {
		try {
			recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
		} catch {
			recent = [];
		}
	});

	const plural = (n: number, word: string) =>
		`${n} ${word}${n === 1 ? '' : /(s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;
	const time = (stamp?: string) =>
		stamp ? new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
	const agentCount = (agent?: string) =>
		agent
			? (results.facets.agents[agent] ?? 0)
			: Object.values(results.facets.agents).reduce((a, b) => a + b, 0);
</script>

<svelte:head><title>{data.query ? `${data.query} — ` : ''}Search sessions</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<div class="page">
	<form
		role="search"
		class="box"
		onsubmit={(event) => {
			event.preventDefault();
			clearTimeout(timer);
			lastSent = q.trim();
			remember();
			go({ q: q.trim() || undefined });
		}}
	>
		<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"
			><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg
		>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			bind:this={input}
			bind:value={q}
			oninput={onInput}
			name="q"
			autocomplete="off"
			spellcheck="false"
			placeholder="Search everything you and your agents said or ran"
			aria-label="Search all sessions"
			autofocus
		/>
		{#if q}
			<button type="button" class="clear" onclick={() => useQuery('')} aria-label="Clear search"
				>×</button
			>
		{:else}
			<kbd>/</kbd>
		{/if}
	</form>

	{#if data.query}
		<div class="filters" class:dim={searching}>
			<div class="seg" role="group" aria-label="Agent">
				{#each [{ key: undefined, label: 'All' }, { key: 'claude', label: 'Claude Code' }, { key: 'codex', label: 'Codex' }] as option (option.label)}
					<button
						type="button"
						class:on={data.filters.agent === option.key}
						onclick={() => go({ agent: option.key })}
						>{option.label} <span>{agentCount(option.key)}</span></button
					>
				{/each}
			</div>

			<div class="chips" role="group" aria-label="Show">
				{#each KINDS as kind (kind.key)}
					{@const count = results.facets.kinds[kind.key] ?? 0}
					{#if count || data.filters.kinds?.includes(kind.key)}
						<button
							type="button"
							class="chip"
							aria-pressed={data.filters.kinds?.includes(kind.key) ?? false}
							onclick={() => toggleKind(kind.key)}>{kind.label} <span>{count}</span></button
						>
					{/if}
				{/each}
			</div>

			<div class="selects">
				{#if results.facets.projects.length > 1 || data.filters.project}
					<select
						value={data.filters.project ?? ''}
						onchange={(e) => go({ project: e.currentTarget.value || undefined })}
						aria-label="Project"
					>
						<option value="">All projects</option>
						{#each results.facets.projects as project (project.name)}
							<option value={project.name}>{project.name} ({project.count})</option>
						{/each}
					</select>
				{/if}
				<select
					value={String(data.filters.days ?? '')}
					onchange={(e) => go({ days: e.currentTarget.value || undefined })}
					aria-label="Time"
				>
					<option value="">Any time</option>
					<option value="7">Past 7 days</option>
					<option value="30">Past 30 days</option>
					<option value="90">Past 90 days</option>
				</select>
				<select
					value={data.filters.sort ?? 'relevance'}
					onchange={(e) => go({ sort: e.currentTarget.value === 'newest' ? 'newest' : undefined })}
					aria-label="Sort"
				>
					<option value="relevance">Best match</option>
					<option value="newest">Newest first</option>
				</select>
			</div>
		</div>

		<p class="summary" aria-live="polite">
			{#if searching}
				Searching…
			{:else if results.total}
				{plural(results.total, 'match')} in {plural(
					results.sessionCount,
					'session'
				)}{#if results.sessionCount > results.groups.length}
					<span class="quiet">(showing the best {results.groups.length})</span>{/if}
				<span class="quiet">· {data.tookMs} ms</span>
			{:else}
				Nothing matches “{data.query}”{filtersActive ? ' with these filters' : ''}.
			{/if}
			{#if filtersActive}
				<button type="button" class="link" onclick={clearFilters}>Clear filters</button>
			{/if}
		</p>

		{#if !results.total && !searching}
			<ul class="tips">
				{#if filtersActive}<li>Clear the filters to search everything.</li>{/if}
				<li>Every word has to appear; try fewer or shorter words.</li>
				<li>Words can be part of longer ones: <code>deploy</code> also finds “deployment”.</li>
			</ul>
		{/if}

		<div class="results" class:dim={searching}>
			{#each results.groups as group (group.id)}
				{@const shown = expanded[group.id] ? group.hits : group.hits.slice(0, SHOWN_PER_SESSION)}
				<section class="group">
					<header>
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- sessionLink() resolves the path -->
						<a class="title" href={sessionLink(group.id, group.agent)} onclick={() => remember()}
							>{group.title}</a
						>
						<p class="meta">
							<span class="agent agent-{group.agent}"
								>{group.agent === 'claude' ? 'Claude Code' : 'Codex'}</span
							>
							{#if group.project}<span>{group.project}</span>{/if}
							<span>{relativeDay(group.updatedAt)}</span>
							<span>{plural(group.matchCount, 'match')}</span>
						</p>
					</header>
					<ul>
						{#each shown as hit, i (i)}
							{@const key = `${group.id}:${hit.doc.anchor ?? hit.doc.timestamp}:${hit.snippet.slice(0, 40)}`}
							{@const position = indexOf(key)}
							<li>
								<!-- eslint-disable svelte/no-navigation-without-resolve -- sessionLink() resolves the path -->
								<a
									class="hit"
									class:active={position === active}
									data-hit={position}
									href={sessionLink(group.id, group.agent, hit.doc.anchor)}
									onclick={() => remember()}
								>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
									<span class="kind kind-{hit.doc.kind}"
										>{hit.doc.kind === 'reply' && group.agent === 'codex'
											? 'Codex'
											: KIND_TAG[hit.doc.kind]}</span
									>
									<span
										class="snippet"
										class:mono={hit.doc.kind === 'command' || hit.doc.kind === 'tool'}
										>{#each highlightParts(hit.snippet, hit.matches) as part, p (p)}{#if part.hit}<mark
													>{part.text}</mark
												>{:else}{part.text}{/if}{/each}</span
									>
									<span class="when">{time(hit.doc.timestamp)}</span>
								</a>
							</li>
						{/each}
					</ul>
					{#if group.hits.length > SHOWN_PER_SESSION}
						<button
							type="button"
							class="link more"
							onclick={() => (expanded[group.id] = !expanded[group.id])}
						>
							{expanded[group.id]
								? 'Show fewer'
								: `Show ${group.hits.length - SHOWN_PER_SESSION} more${group.matchCount > group.hits.length ? ` of ${group.matchCount - SHOWN_PER_SESSION}` : ''}`}
						</button>
					{/if}
				</section>
			{/each}
		</div>
	{:else}
		<div class="start">
			{#if recent.length}
				<h2>Recent searches</h2>
				<ul class="recent">
					{#each recent as item (item)}
						<li><button type="button" onclick={() => useQuery(item)}>{item}</button></li>
					{/each}
				</ul>
			{/if}
			<h2>How to search</h2>
			<dl class="syntax">
				<dt><code>cache expiry</code></dt>
				<dd>Messages containing both words</dd>
				<dt><code>"bun test"</code></dt>
				<dd>The exact phrase</dd>
				<dt><code>deploy -staging</code></dt>
				<dd>Leave out matches that mention a word</dd>
				<dt><kbd>/</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd></dt>
				<dd>Jump to the search box, move through results, open one</dd>
			</dl>
			<p class="quiet">
				Searches your messages, Claude's and Codex's answers and notes, and every command and tool
				call, across all sessions on this machine.
			</p>
		</div>
	{/if}
</div>

<style>
	.page {
		--clay: #d97757;
		--mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
		max-width: 880px;
		margin: 0 auto;
		padding: 8px 0 80px;
	}
	.quiet {
		color: var(--muted);
	}

	/* Search box */
	.box {
		position: sticky;
		top: 64px;
		z-index: 5;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 14px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--field);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
	}
	.box:focus-within {
		border-color: var(--clay);
	}
	.icon {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		fill: none;
		stroke: var(--muted);
		stroke-width: 2;
		stroke-linecap: round;
	}
	.box input {
		flex: 1;
		min-width: 0;
		padding: 14px 0;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: 16px;
	}
	.box input:focus {
		outline: none;
	}
	.clear {
		width: 26px;
		height: 26px;
		border: 0;
		border-radius: 50%;
		background: var(--panel-subtle);
		color: var(--muted);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
	}
	.clear:hover {
		color: var(--ink);
	}
	kbd {
		padding: 1px 6px;
		border: 1px solid var(--line);
		border-radius: 5px;
		color: var(--muted);
		font-family: var(--mono);
		font-size: 11px;
	}

	/* Filters */
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 14px;
		margin: 16px 0 6px;
		transition: opacity 120ms;
	}
	.seg {
		display: inline-flex;
		padding: 2px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--field);
	}
	.seg button {
		padding: 4px 10px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 12.5px;
		cursor: pointer;
	}
	.seg button.on {
		background: var(--panel-subtle);
		color: var(--ink);
	}
	.seg span,
	.chip span {
		font-family: var(--mono);
		font-size: 11px;
		opacity: 0.7;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		padding: 4px 10px;
		border: 1px solid var(--line-subtle);
		border-radius: 999px;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 12.5px;
		cursor: pointer;
	}
	.chip:hover {
		color: var(--ink);
	}
	.chip[aria-pressed='true'] {
		border-color: var(--clay);
		background: rgba(217, 119, 87, 0.12);
		color: var(--ink);
	}
	.selects {
		display: flex;
		gap: 8px;
		margin-left: auto;
	}
	select {
		padding: 5px 8px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--field);
		color: var(--ink);
		font: inherit;
		font-size: 12.5px;
	}
	button:focus-visible,
	select:focus-visible,
	a:focus-visible {
		outline: 2px solid var(--clay);
		outline-offset: 2px;
	}

	.summary {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 12px;
		margin: 14px 0 4px;
		color: var(--muted);
		font-size: 13px;
	}
	.link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--clay);
		font: inherit;
		font-size: 12.5px;
		cursor: pointer;
	}
	.tips {
		margin: 6px 0 0;
		padding-left: 18px;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.8;
	}
	.dim {
		opacity: 0.55;
	}

	/* Results */
	.results {
		transition: opacity 120ms;
	}
	.group {
		padding: 18px 0 14px;
		border-bottom: 1px solid var(--line-subtle);
	}
	.title {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		color: var(--ink);
		font-size: 15px;
		font-weight: 600;
		line-height: 1.4;
		text-decoration: none;
	}
	.title:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		margin: 4px 0 8px;
		color: var(--muted);
		font-size: 12px;
	}
	.agent {
		font-weight: 600;
	}
	.agent-claude {
		color: var(--clay);
	}
	.agent-codex {
		color: #7aa2f7;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.hit {
		display: grid;
		grid-template-columns: 74px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: baseline;
		padding: 7px 10px;
		margin: 0 -10px;
		border-radius: 8px;
		color: var(--muted);
		font-size: 13.5px;
		line-height: 1.55;
		text-decoration: none;
	}
	.hit:hover,
	.hit.active {
		background: var(--panel);
		color: var(--ink);
	}
	.hit.active {
		box-shadow: inset 2px 0 0 var(--clay);
	}
	.kind {
		font-size: 11.5px;
		font-weight: 600;
	}
	.kind-prompt {
		color: var(--clay);
	}
	.kind-reply {
		color: var(--ink);
	}
	.kind-command,
	.kind-tool,
	.kind-note {
		color: var(--muted);
	}
	.snippet {
		overflow-wrap: anywhere;
	}
	.snippet.mono {
		font-family: var(--mono);
		font-size: 12.5px;
	}
	.when {
		font-family: var(--mono);
		font-size: 11px;
		opacity: 0.7;
	}
	mark {
		padding: 0 1px;
		border-radius: 3px;
		background: rgba(217, 119, 87, 0.28);
		color: var(--ink);
	}
	.more {
		margin-top: 4px;
	}

	/* Empty state */
	.start {
		margin-top: 32px;
		color: var(--muted);
		font-size: 13.5px;
	}
	.start h2 {
		margin: 24px 0 10px;
		font-size: 11.5px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}
	.recent {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.recent button {
		padding: 5px 12px;
		border: 1px solid var(--line-subtle);
		border-radius: 999px;
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.recent button:hover {
		border-color: var(--clay);
	}
	.syntax {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 8px 20px;
		margin: 0 0 20px;
	}
	.syntax dd {
		margin: 0;
	}
	code {
		font-family: var(--mono);
		font-size: 12px;
		color: var(--ink);
	}

	@media (max-width: 640px) {
		.selects {
			flex-wrap: wrap;
			width: 100%;
			margin-left: 0;
		}
		.selects select {
			flex: 1 1 120px;
			min-width: 0;
		}
		.hit {
			grid-template-columns: 1fr;
			gap: 2px;
		}
		.when {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.filters,
		.results {
			transition: none;
		}
	}
</style>
