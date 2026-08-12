<script lang="ts">
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import type { ReplyActivity, SessionDetail, SessionInventory, TokenUsage, UsageSnapshot } from '../../../types.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let selectedId = $state('');
	let detail = $state<SessionDetail | null>(null);
	let loading = $state(false);
	let failure = $state<string | null>(null);
	let query = $state('');
	let theme = $state<'light' | 'dark'>('dark');
	let view = $state<'conversation' | 'usage'>('conversation');

	const sessions = () =>
		data.inventory.sessions.filter((session) => `${title(session)} ${session.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
	const title = (session: SessionInventory) => session.displayTitle.value ?? 'Untitled Codex session';
	const shortId = (id: string) => id.slice(0, 8);
	const date = (value?: string) => value?.slice(0, 10) ?? 'Unknown date';
	const clock = (value?: string) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown time';
	const number = (value?: number) => (value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value));
	const duration = (milliseconds?: number) => {
		if (milliseconds === undefined) return '—';
		const seconds = Math.round(milliseconds / 1000);
		return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
	};
	const latestTokens = (session: SessionInventory) => session.token.last?.totalTokens ?? session.token.total?.totalTokens;
	const activityTotal = (activity?: ReplyActivity) => activity?.modelRequests.reduce((sum, request) => sum + (request.usage.totalTokens ?? 0), 0);
	const snapshotTotal = (snapshot: UsageSnapshot) => snapshot.usage.totalTokens ?? 0;
	const maxSnapshotTotal = () => Math.max(1, ...(detail?.usage.snapshots.map(snapshotTotal) ?? [0]));
	const percent = (value: number, total: number) => Math.max(2, Math.round((value / total) * 100));
	const compactUsage = (usage?: TokenUsage) => usage?.totalTokens === undefined ? 'No model step recorded' : `${number(usage.inputTokens)} in · ${number(usage.outputTokens)} out`;

	async function select(id: string) {
		selectedId = id;
		loading = true;
		failure = null;
		try {
			const response = await fetch(`/api/session/${id}`);
			if (!response.ok) throw new Error(await response.text());
			detail = (await response.json()) as SessionDetail;
			view = 'conversation';
		} catch (error) {
			failure = error instanceof Error ? error.message : 'Unable to load session detail.';
		} finally {
			loading = false;
		}
	}

	function setTheme(next: 'light' | 'dark') {
		theme = next;
		document.documentElement.dataset.theme = next;
		localStorage.setItem('agent-session-inspect-theme', next);
	}

	onMount(() => {
		const stored = localStorage.getItem('agent-session-inspect-theme');
		setTheme(stored === 'light' ? 'light' : 'dark');
		selectedId = data.inventory.sessions[0]?.id ?? '';
		if (selectedId) void select(selectedId);
	});
</script>

<svelte:head><title>Agent Session Inspect</title></svelte:head>

<div class="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
	<header class="border-b border-[var(--line)] bg-[var(--panel)]">
		<div class="mx-auto flex max-w-[1540px] items-center justify-between gap-5 px-5 py-3 lg:px-8">
			<div class="flex items-baseline gap-3"><h1 class="text-base font-semibold tracking-tight">Agent Session Inspect</h1><span class="hidden text-xs text-[var(--muted)] sm:inline">Local · read-only</span></div>
			<div class="flex items-center gap-3 text-sm text-[var(--muted)]"><span class="hidden sm:inline">{data.inventory.sessions.length} sessions</span><button class="theme-toggle" onclick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle colour theme">{theme === 'dark' ? 'Light' : 'Dark'}</button></div>
		</div>
	</header>

	<main class="mx-auto grid max-w-[1540px] grid-cols-1 gap-0 lg:grid-cols-[280px_minmax(0,1fr)]">
		<aside class="border-b border-[var(--line)] bg-[var(--panel)] lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-b-0">
			<div class="border-b border-[var(--line)] p-4"><p class="text-sm font-semibold">Sessions</p><input class="session-filter mt-3" bind:value={query} placeholder="Search title or ID" /></div>
			<div class="max-h-[260px] overflow-y-auto lg:max-h-[calc(100vh-82px)]">
				{#each sessions() as session (session.id)}
					<button class:active={selectedId === session.id} class="session-row" onclick={() => select(session.id)}><span class="block truncate text-left text-sm font-medium">{title(session)}</span><span class="mt-1 block text-left text-xs text-[var(--muted)]">{date(session.startedAt)} · {shortId(session.id)} · {number(latestTokens(session))} tokens</span></button>
				{:else}<p class="p-4 text-sm text-[var(--muted)]">No matching sessions.</p>{/each}
			</div>
		</aside>

		<section class="min-w-0 px-4 py-6 sm:px-7 lg:px-10">
			{#if loading}<div class="state-card">Loading session…</div>
			{:else if failure}<div class="state-card border-[var(--danger)] text-[var(--danger)]">{failure}</div>
			{:else if detail}
				<div class="mx-auto max-w-[960px]">
					<div class="session-head">
						<div class="min-w-0"><p class="eyebrow">{detail.displayTitle.source.replace('_', ' ')}</p><h2>{title(detail)}</h2><p class="mt-2 text-sm text-[var(--muted)]">{date(detail.startedAt)} · {shortId(detail.id)} · {detail.conversation.length} messages</p></div>
						<div class="head-metric"><span>Reported total</span><b>{number(detail.usage.latest?.usage.totalTokens)}</b><small>latest model snapshot</small></div>
					</div>
					<div class="tabs" role="tablist"><button class:active={view === 'conversation'} onclick={() => view = 'conversation'} role="tab">Conversation</button><button class:active={view === 'usage'} onclick={() => view = 'usage'} role="tab">Usage</button></div>

					{#if view === 'conversation'}
						<p class="evidence-note">Usage is exact for recorded model steps, not individual message text. Reply activity is grouped by source order.</p>
						<div class="conversation">
							{#each detail.conversation as message (message.id)}
								<details class:from-user={message.role === 'user'} class:from-agent={message.role === 'assistant'} class="chat-message" open>
									<summary><span class="role">{message.role === 'assistant' ? 'Codex' : 'You'}</span><span class="message-stamp">{message.role === 'assistant' && message.activity?.model.name ? message.activity.model.name : ''}{message.role === 'assistant' && message.activity?.model.name ? ' · ' : ''}{clock(message.timestamp)}</span></summary>
									<div class="markdown">{@html renderMarkdown(message.text)}</div>
									{#if message.activity}
										<details class="activity">
											<summary><span><b>Work</b><small>Derived from source order</small></span><span>{message.activity.model.name ?? 'Model unavailable'} · {message.activity.modelRequests.length} steps · {number(activityTotal(message.activity))} tokens</span></summary>
											<div class="activity-body">
												<div class="work-stats"><span><small>Response interval</small><b>{duration(message.activity.breakdown.durationMs)}</b></span><span><small>Measured tools</small><b>{duration(message.activity.breakdown.measuredToolMs)}</b></span><span><small>Unclassified</small><b>{duration(message.activity.breakdown.otherElapsedMs)}</b></span><span><small>Edits</small><b>{message.activity.edits.length}</b></span></div>
												<p class="time-explanation">{message.activity.breakdown.explanation}</p>
												{#if message.activity.task?.timeToFirstTokenMs !== undefined}<p class="time-explanation">Reported time to first token: {duration(message.activity.task.timeToFirstTokenMs)}.</p>{/if}
												{#if message.activity.modelRequests.length}<div class="overflow-x-auto"><p class="section-label">Reported model steps</p><table><thead><tr><th>Time</th><th>Input</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Total</th></tr></thead><tbody>{#each message.activity.modelRequests as request (request.id)}<tr><td>{clock(request.timestamp)}</td><td>{number(request.usage.inputTokens)}</td><td>{number(request.usage.cachedInputTokens)}</td><td>{number(request.usage.outputTokens)}</td><td>{number(request.usage.reasoningOutputTokens)}</td><td>{number(request.usage.totalTokens)}</td></tr>{/each}</tbody></table></div>{/if}
												{#if message.activity.tools.length}<div><p class="section-label">Tools</p>{#each message.activity.tools as tool (tool.id)}<details class="tool"><summary><span><b>{tool.name}</b><small>{tool.status ?? 'recorded'} · {tool.kind}</small></span><span>{duration(tool.durationMs)}</span></summary>{#if tool.input}<div><p>Input</p><pre>{tool.input}</pre></div>{/if}{#if tool.output}<div><p>Output</p><pre>{tool.output}</pre></div>{/if}</details>{/each}</div>{/if}
												{#if message.activity.edits.length}<div><p class="section-label">Edits</p>{#each message.activity.edits as edit (edit.id)}<details class="tool"><summary><span><b>{edit.files.length} file{edit.files.length === 1 ? '' : 's'} changed</b><small>{edit.status ?? 'recorded'}</small></span></summary>{#each edit.files as file (file.path)}<div><p>{file.operation ?? 'update'} · {file.path}</p>{#if file.diff}<pre>{file.diff}</pre>{/if}</div>{/each}</details>{/each}</div>{/if}
											</div>
										</details>
									{/if}
								</details>
							{:else}<p class="state-card">No visible User or Codex messages were found in this log.</p>{/each}
						</div>
					{:else}
						<section class="usage-view"><p class="evidence-note">Reported totals come from Codex token snapshots. No price or text-token estimates are shown.</p><div class="usage-cards"><div><span>Input</span><b>{number(detail.usage.latest?.usage.inputTokens)}</b></div><div><span>Cached input</span><b>{number(detail.usage.latest?.usage.cachedInputTokens)}</b></div><div><span>Output</span><b>{number(detail.usage.latest?.usage.outputTokens)}</b></div><div><span>Reasoning</span><b>{number(detail.usage.latest?.usage.reasoningOutputTokens)}</b></div><div><span>Model steps</span><b>{number(detail.usage.modelStepCount)}</b></div></div>
						<div class="usage-panel"><div class="panel-heading"><div><p class="section-label">Reported token growth</p><p class="text-sm text-[var(--muted)]">Cumulative totals from model snapshots</p></div><span class="evidence-chip">Reported</span></div>{#if detail.usage.snapshots.length}<div class="snapshot-list">{#each detail.usage.snapshots as snapshot (snapshot.id)}<div class="snapshot"><span>{clock(snapshot.timestamp)}</span><div class="bar"><i style:width={`${percent(snapshotTotal(snapshot), maxSnapshotTotal())}%`}></i></div><b>{number(snapshotTotal(snapshot))}</b></div>{/each}</div>{:else}<p class="text-sm text-[var(--muted)]">No reported token snapshots.</p>{/if}</div>
						<div class="usage-panel"><div class="panel-heading"><div><p class="section-label">Response activity</p><p class="text-sm text-[var(--muted)]">Exact model steps grouped under the following Codex response</p></div><span class="evidence-chip">Derived grouping</span></div><div class="overflow-x-auto"><table><thead><tr><th>Response</th><th>Model</th><th>Steps</th><th>Recorded tokens</th><th>Tool time</th><th>Unclassified</th></tr></thead><tbody>{#each detail.conversation.filter((message) => message.role === 'assistant') as message (message.id)}<tr><td>{clock(message.timestamp)}</td><td>{message.activity?.model.name ?? 'Unavailable'}</td><td>{message.activity?.modelRequests.length ?? 0}</td><td>{number(activityTotal(message.activity))}</td><td>{duration(message.activity?.breakdown.measuredToolMs)}</td><td>{duration(message.activity?.breakdown.otherElapsedMs)}</td></tr>{/each}</tbody></table></div></div>
					</section>
					{/if}

					<details class="debug"><summary>Debug data <span>{detail.debug.hiddenMessages.length} hidden messages · {detail.debug.unattachedActivities.length} unattached activity groups</span></summary><div>{#if detail.debug.hiddenMessages.length}<p class="section-label">Hidden developer/system messages</p>{#each detail.debug.hiddenMessages as message (message.id)}<div class="debug-message"><b>{message.role}</b><small>{clock(message.timestamp)} · {message.source.line}</small><pre>{message.text}</pre></div>{/each}{/if}{#if detail.debug.unattachedActivities.length}<p class="section-label mt-4">Unattached activity</p>{#each detail.debug.unattachedActivities as activity, index (activity.startedAt ?? String(index))}<p class="text-sm text-[var(--muted)]">{activity.modelRequests.length} model steps · {activity.tools.length} tools · {activity.edits.length} edits · {duration(activity.breakdown.durationMs)}</p>{/each}{/if}<p class="mt-4 text-xs text-[var(--muted)]">{detail.debug.malformedRecords} malformed and {detail.debug.unknownRecords} unknown records in this session.</p></div></details>
				</div>
			{/if}
		</section>
	</main>
</div>
