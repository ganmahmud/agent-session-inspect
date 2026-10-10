<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatCompactTokens } from '$lib/project';
	import { sessionLink } from '$lib/session-links';
	import type { Habits } from '../../../../src/habits.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const h = $derived(data.habits as Habits);
	let copied = $state<string | undefined>(undefined);

	const usd = (v: number) => (v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);
	function duration(ms: number): string {
		const m = Math.round(ms / 60_000);
		if (m < 60) return `${m}m`;
		return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
	}
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
	/** Error signatures blur numbers and paths; one with no words left says nothing useful. */
	const describeError = (signature: string) =>
		/[a-z]{3}/i.test(signature) ? signature : 'no error message';
	const short = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');

	function copy(key: string, text: string) {
		navigator.clipboard.writeText(text);
		copied = key;
		setTimeout(() => copied === key && (copied = undefined), 1500);
	}

	// Weekly bars show Claude spend; when nothing in range has recorded cost, they show tokens instead.
	const byCost = $derived(h.weeks.some((w) => w.costUsd > 0));
	const weekMax = $derived(Math.max(1e-9, ...h.weeks.map((w) => (byCost ? w.costUsd : w.tokens))));
	const timeTotal = $derived(Math.max(1, h.time.modelMs + h.time.toolMs + h.time.waitingOnYouMs));
	const safeRules = $derived(h.blocked.filter((b) => b.rule).map((b) => b.rule!));
	const unused = $derived(
		h.contextTrim.filter((t) => t.kind !== 'instructions' && t.usedIn < t.loadedIn)
	);
	const instructionFiles = $derived(h.contextTrim.filter((t) => t.kind === 'instructions'));
</script>

<svelte:head><title>Habits — Agent Session Inspect</title></svelte:head>

<div class="page">
	<header class="head">
		<div>
			<h1>Habits</h1>
			<p class="quiet">
				Patterns across your sessions. Worked out locally from transcripts on this machine.
			</p>
		</div>
		<nav class="range" aria-label="Period">
			<a class:on={data.range === '30'} href={resolve('/habits')}>Last 30 days</a>
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved path plus a query string -->
			<a class:on={data.range === 'all'} href={`${resolve('/habits')}?range=all`}>All time</a>
		</nav>
	</header>

	<dl class="stats">
		<div>
			<dt>Claude Code spend</dt>
			<dd>{usd(h.totals.costUsd)}</dd>
			<span class="quiet">{plural(h.totals.claudeSessions, 'session')}</span>
		</div>
		<div>
			<dt>Working time</dt>
			<dd>{duration(h.totals.workingMs)}</dd>
			<span class="quiet">{plural(h.totals.messages, 'message')}</span>
		</div>
		<div>
			<dt>Tokens</dt>
			<dd>{formatCompactTokens(h.totals.tokens)}</dd>
			<span class="quiet">incl. {plural(h.totals.codexSessions, 'Codex session')}</span>
		</div>
		<div>
			<dt>Lost to cache expiry</dt>
			<dd class:warn={h.totals.cacheWasteUsd > 0}>{usd(h.totals.cacheWasteUsd)}</dd>
			<span class="quiet">{plural(h.totals.cacheExpiries, 'break')} past the cache lifetime</span>
		</div>
	</dl>

	<div class="grid">
		<section>
			<h2>{byCost ? 'Spend' : 'Tokens'} by week</h2>
			{#if h.weeks.length}
				<ul class="weeks">
					{#each h.weeks.slice(-12) as w (w.week)}
						{@const value = byCost ? w.costUsd : w.tokens}
						<li title="{plural(w.sessions, 'session')} · {formatCompactTokens(w.tokens)} tokens">
							<span class="bar" style="height: {Math.max(2, (value / weekMax) * 100)}%"></span>
							<span class="wk"
								>{new Date(w.week).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span
							>
							<span class="val">{byCost ? usd(w.costUsd) : formatCompactTokens(w.tokens)}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="quiet">No sessions in this period.</p>
			{/if}
		</section>

		<section>
			<h2>Where the time goes</h2>
			<div class="split" role="img" aria-label="Model, tool and waiting time">
				<i class="model" style="width: {(h.time.modelMs / timeTotal) * 100}%"></i>
				<i class="tools" style="width: {(h.time.toolMs / timeTotal) * 100}%"></i>
				<i class="you" style="width: {(h.time.waitingOnYouMs / timeTotal) * 100}%"></i>
			</div>
			<ul class="kv">
				<li>
					<span><i class="dot model"></i>Waiting on the model</span><b>{duration(h.time.modelMs)}</b
					>
				</li>
				<li><span><i class="dot tools"></i>Running tools</span><b>{duration(h.time.toolMs)}</b></li>
				<li>
					<span><i class="dot you"></i>Waiting on your answers</span><b
						>{duration(h.time.waitingOnYouMs)}</b
					>
				</li>
			</ul>
			<p class="quiet small">Model and tool time come from Claude Code's own records.</p>
		</section>
	</div>

	<section>
		<h2>By project</h2>
		<ul class="kv rows">
			{#each h.projects.slice(0, 8) as p (p.name)}
				<li>
					<span>{p.name}</span>
					<b
						>{p.costUsd ? usd(p.costUsd) : '—'} · {formatCompactTokens(p.tokens)} tokens · {plural(
							p.sessions,
							'session'
						)}</b
					>
				</li>
			{/each}
		</ul>
	</section>

	{#if h.failures.length}
		<section>
			<h2>Keeps failing</h2>
			<p class="quiet small">The same tool failing the same way, across sessions.</p>
			<ul class="list">
				{#each h.failures as f (f.tool + f.signature)}
					<li>
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- sessionLink() resolves the path -->
						<a href={sessionLink(f.example.sessionId, 'claude', f.example.stepId)}>
							<b>{f.count}×</b>
							<span class="mono">{f.tool}</span>
							<span class="quiet">{describeError(f.signature)}</span>
							<span class="quiet nowrap"
								>{plural(f.sessions, 'session')}{f.costUsd >= 0.01
									? ` · ${usd(f.costUsd)}`
									: ''}</span
							>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if unused.length || instructionFiles.length}
		<section>
			<h2>Loaded on every request</h2>
			<p class="quiet small">
				Context that rides along with each API call. Removing what you never use makes every call
				cheaper and leaves room for the actual work.
			</p>
			<ul class="kv rows">
				{#each unused as t (t.kind + t.name)}
					<li>
						<span
							><span class="tag">{t.kind === 'mcp' ? 'MCP server' : 'Skills'}</span>
							<span class="mono">{t.name.length > 28 ? `${t.name.slice(0, 8)}…` : t.name}</span
							></span
						>
						<b
							>~{formatCompactTokens(t.tokensPerRequest)} tokens · loaded in {t.loadedIn}, used in
							{t.usedIn}</b
						>
					</li>
				{/each}
				{#each instructionFiles as t (t.name)}
					<li>
						<span
							><span class="tag">Instructions</span> <span class="mono">{short(t.name)}</span></span
						>
						<b
							>~{formatCompactTokens(t.tokensPerRequest)} tokens · {plural(
								t.loadedIn,
								'session'
							)}</b
						>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if h.corrections.length}
		<section>
			<h2>Things you keep telling Claude</h2>
			<p class="quiet small">
				Follow-up messages that push back on what Claude did. If one is a standing preference, put
				it in CLAUDE.md so you only say it once.
			</p>
			<ul class="list">
				{#each h.corrections as c, i (i)}
					<li class="correction">
						<span class="quote">“{c.text.length > 220 ? `${c.text.slice(0, 219)}…` : c.text}”</span>
						<span class="actions">
							<!-- eslint-disable svelte/no-navigation-without-resolve -- sessionLink() resolves the path -->
							<a
								class="quiet"
								href={sessionLink(
									c.sessionId,
									c.turnId ? 'claude' : 'codex',
									c.turnId ? `turn-${c.turnId}` : undefined
								)}>{c.title.length > 40 ? `${c.title.slice(0, 39)}…` : c.title}</a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							<button
								type="button"
								class="act"
								onclick={() => copy(`c${i}`, `- ${c.text.replace(/\s+/g, ' ').trim()}`)}
								>{copied === `c${i}` ? 'Copied' : 'Copy as CLAUDE.md line'}</button
							>
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if h.blocked.length}
		<section>
			<h2>Blocked by permission checks</h2>
			<p class="quiet small">
				Commands Claude Code stopped before running. Only add a rule if you are sure the command is
				always safe to run without asking; chained and destructive commands get no suggestion.
			</p>
			<ul class="kv rows">
				{#each h.blocked as b (b.key)}
					<li>
						<span
							><span class="mono">{b.rule ?? b.key}</span>
							<span class="quiet">{b.examples[0] ?? ''}</span></span
						>
						<b>{b.count}×</b>
					</li>
				{/each}
			</ul>
			{#if safeRules.length}
				<button
					type="button"
					class="act"
					onclick={() =>
						copy('rules', JSON.stringify({ permissions: { allow: safeRules } }, null, 2))}
					>{copied === 'rules'
						? 'Copied'
						: `Copy ${plural(safeRules.length, 'rule')} as settings.json`}</button
				>
			{/if}
		</section>
	{/if}

	{#if h.compacted.length}
		<section>
			<h2>Ran out of context</h2>
			<ul class="kv rows">
				{#each h.compacted as c (c.sessionId)}
					<li>
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- sessionLink() resolves the path -->
						<a href={sessionLink(c.sessionId, 'claude')}>{c.title}</a>
						<b>compacted {c.count}×</b>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.page {
		max-width: 980px;
		margin: 0 auto;
		padding: 8px 0 60px;
		--clay: #d97757;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: flex-end;
		gap: 12px;
		margin-bottom: 20px;
	}
	h1 {
		margin: 0 0 4px;
		font-size: 24px;
		letter-spacing: -0.01em;
	}
	h2 {
		margin: 0 0 10px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--muted);
	}
	section {
		padding: 20px 0;
		border-top: 1px solid var(--line-subtle);
	}
	.quiet {
		color: var(--muted);
	}
	.small {
		margin: -4px 0 10px;
		font-size: 12.5px;
		line-height: 1.5;
	}
	.mono {
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
		font-size: 12px;
	}
	.nowrap {
		white-space: nowrap;
	}
	.range {
		display: inline-flex;
		padding: 2px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--field);
		font-size: 12.5px;
	}
	.range a {
		padding: 4px 12px;
		border-radius: 6px;
		color: var(--muted);
		text-decoration: none;
	}
	.range a.on {
		background: var(--panel-subtle);
		color: var(--ink);
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 16px;
		margin: 0 0 8px;
	}
	.stats dt {
		font-size: 12px;
		color: var(--muted);
	}
	.stats dd {
		margin: 4px 0 2px;
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
		font-size: 24px;
		font-weight: 500;
	}
	.stats dd.warn {
		color: #fbbf24;
	}
	.stats span {
		font-size: 12px;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		gap: 40px;
	}
	.weeks {
		display: flex;
		align-items: flex-end;
		gap: 6px;
		height: 140px;
		margin: 0;
		padding: 0 0 34px;
		list-style: none;
	}
	.weeks li {
		position: relative;
		flex: 1;
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		align-items: center;
	}
	.bar {
		width: 100%;
		max-width: 34px;
		border-radius: 3px 3px 0 0;
		background: color-mix(in srgb, var(--clay) 70%, transparent);
	}
	.wk,
	.val {
		position: absolute;
		font-size: 10.5px;
		color: var(--muted);
		white-space: nowrap;
	}
	.wk {
		bottom: -18px;
	}
	.val {
		bottom: -32px;
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
	}
	.split {
		display: flex;
		height: 8px;
		margin-bottom: 12px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--panel-subtle);
	}
	.split i {
		display: block;
	}
	.model {
		background: #7aa2f7;
	}
	.tools {
		background: #e0af68;
	}
	.you {
		background: var(--clay);
	}
	.dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		margin-right: 8px;
		border-radius: 50%;
	}
	.kv {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
		font-size: 13.5px;
	}
	.kv li {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 16px;
		min-width: 0;
	}
	.kv li > span,
	.kv li > a {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink);
		text-decoration: none;
	}
	.kv b {
		flex-shrink: 0;
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
		font-size: 12px;
		font-weight: 500;
		color: var(--muted);
	}
	.rows li {
		padding-bottom: 8px;
		border-bottom: 1px solid var(--line-subtle);
	}
	.tag {
		display: inline-block;
		min-width: 86px;
		font-size: 11.5px;
		color: var(--muted);
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.list li a {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 12px;
		padding: 7px 8px;
		margin: 0 -8px;
		border-radius: 6px;
		color: var(--ink);
		font-size: 13.5px;
		text-decoration: none;
	}
	.list li a:hover {
		background: var(--panel);
	}
	.correction {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 4px 16px;
		padding: 8px 0;
		border-bottom: 1px solid var(--line-subtle);
		font-size: 13.5px;
	}
	.quote {
		min-width: 0;
		flex: 1 1 360px;
		line-height: 1.5;
	}
	.actions {
		display: inline-flex;
		gap: 14px;
		font-size: 12.5px;
	}
	.actions a {
		text-decoration: none;
	}
	.act {
		padding: 0;
		margin-top: 10px;
		border: 0;
		background: none;
		color: var(--clay);
		font: inherit;
		font-size: 12.5px;
		cursor: pointer;
	}
	.actions .act {
		margin: 0;
	}
	@media (max-width: 760px) {
		.stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.grid {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
	}
</style>
