<script lang="ts">
	import { relativeDay, sessionLink } from '$lib/session-links';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let open = $state<Record<string, boolean>>({});

	const shortPath = (path: string) =>
		data.home && path.startsWith(`${data.home}/`) ? `~${path.slice(data.home.length)}` : path;
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const excerpt = (text?: string) =>
		text ? (text.length > 160 ? `${text.slice(0, 159).replace(/\s+\S*$/, '')}…` : text) : '';

	function diffClass(line: string) {
		if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
		if (line.startsWith('@@')) return 'hunk';
		if (line.startsWith('+')) return 'add';
		if (line.startsWith('-')) return 'del';
		return '';
	}
</script>

<svelte:head><title>File history — Agent Session Inspect</title></svelte:head>

<div class="page">
	<h1>File history</h1>
	<p class="hint">Every file an agent edited, and which sessions changed it and why.</p>
	<form method="GET" class="search">
		<input
			name="q"
			value={data.query}
			placeholder="Filter by path, e.g. session-data.ts"
			aria-label="Filter files by path"
		/>
		<button type="submit">Filter</button>
	</form>

	{#if !data.files.length}
		<p class="hint">
			{data.query
				? `No edited file path contains “${data.query}”.`
				: 'No file edits found in any session yet.'}
		</p>
	{/if}

	<ul class="files">
		{#each data.files as file (file.path)}
			{@const parts = shortPath(file.path).split('/')}
			<li class="file">
				<button
					type="button"
					class="file-line"
					aria-expanded={!!open[file.path]}
					onclick={() => (open[file.path] = !open[file.path])}
				>
					<span class="name"
						><span class="dir">{parts.slice(0, -1).join('/')}/</span>{parts.at(-1)}</span
					>
					<span class="meta">
						{plural(file.sessions, 'session')} · {plural(file.edits.length, 'edit')} ·
						<span class="add">+{file.added}</span> <span class="del">−{file.removed}</span> · {relativeDay(
							file.lastEditedAt
						)}
					</span>
				</button>
				{#if open[file.path]}
					<ol class="timeline">
						{#each file.edits as edit, i (i)}
							{@const key = `${file.path}#${i}`}
							<li>
								<div class="edit-head">
									<span class="when"
										>{new Date(edit.timestamp ?? 0).toLocaleString([], {
											dateStyle: 'medium',
											timeStyle: 'short'
										})}</span
									>
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- sessionLink() resolves the path -->
									<a href={sessionLink(edit.sessionId, edit.agent, edit.anchor)}
										>{data.titles[edit.sessionId]?.title ?? 'Session'}</a
									>
									<span class="meta"
										>{edit.created ? 'created' : 'edited'} · <span class="add">+{edit.added}</span>
										<span class="del">−{edit.removed}</span></span
									>
								</div>
								{#if edit.prompt}<p class="why">“{excerpt(edit.prompt)}”</p>{/if}
								{#if edit.diff}
									<button type="button" class="more" onclick={() => (open[key] = !open[key])}
										>{open[key] ? 'Hide diff' : 'Show diff'}</button
									>
									{#if open[key]}
										<pre class="diff">{#each edit.diff.split('\n') as line, l (l)}<span
													class={diffClass(line)}
													>{line}
</span>{/each}</pre>
									{/if}
								{/if}
							</li>
						{/each}
					</ol>
				{/if}
			</li>
		{/each}
	</ul>
</div>

<style>
	.page {
		max-width: 900px;
		margin: 0 auto;
		padding: 8px 0 60px;
	}
	h1 {
		margin: 0 0 6px;
		font-size: 24px;
		letter-spacing: -0.01em;
	}
	.hint,
	.meta {
		color: var(--muted);
		font-size: 13px;
	}
	.search {
		display: flex;
		gap: 8px;
		margin: 16px 0 20px;
	}
	.search input {
		flex: 1;
		min-width: 0;
		padding: 10px 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--field);
		color: var(--ink);
		font: inherit;
	}
	.search input:focus {
		outline: 2px solid #d97757;
		outline-offset: 1px;
	}
	.search button {
		padding: 0 18px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel-subtle);
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.files {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.file {
		border-bottom: 1px solid var(--line-subtle);
	}
	.file-line {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 4px 16px;
		width: 100%;
		padding: 12px 8px;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.file-line:hover {
		background: var(--panel);
	}
	.name {
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.dir {
		color: var(--muted);
	}
	.add {
		color: #4ade80;
	}
	.del {
		color: var(--danger);
	}
	.timeline {
		list-style: none;
		margin: 0 0 12px 16px;
		padding: 0 0 0 16px;
		border-left: 1px solid var(--line);
	}
	.timeline li {
		padding: 10px 0;
	}
	.edit-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 12px;
		font-size: 13px;
	}
	.edit-head a {
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
	}
	.edit-head a:hover {
		text-decoration: underline;
	}
	.when {
		color: var(--muted);
		font-size: 12px;
	}
	.why {
		margin: 4px 0;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.5;
	}
	.more {
		padding: 0;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 12.5px;
		cursor: pointer;
	}
	.more:hover {
		color: var(--ink);
	}
	.diff {
		margin: 8px 0 0;
		max-height: 360px;
		overflow: auto;
		padding: 10px 12px;
		border-radius: 6px;
		background: var(--field);
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
		font-size: 12px;
		line-height: 1.5;
	}
	.diff span {
		display: block;
	}
	.diff .add {
		background: rgba(74, 222, 128, 0.08);
		color: inherit;
	}
	.diff .del {
		background: var(--danger-soft);
		color: inherit;
	}
	.diff .hunk {
		color: #7aa2f7;
	}
	.diff .meta {
		color: var(--muted);
		font-size: 12px;
	}
</style>
