<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { markdown, toPlainText } from '$lib/markdown';
	import { countTokens } from '$lib/tokenizer';
	import {
		User,
		Sparkles,
		Clock,
		ShieldCheck,
		Terminal,
		ChevronDown,
		ChevronRight,
		Zap,
		BarChart3,
		Filter,
		Copy,
		Check,
		MessageSquare,
		Code,
		FileText
	} from '@lucide/svelte';
	import type { ReplyActivity, SessionDetail, UsageSnapshot } from '../../../../../src/types.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let detail = $derived(data.detail);

	let view = $state<'conversation' | 'usage'>('conversation');
	let roleFilter = $state<'all' | 'user' | 'agent' | 'review'>('all');
	const expandedActivities = new SvelteSet<string>();
	let copiedId = $state(false);
	const copiedMessageIds = new SvelteSet<string>();

	const title = (session: SessionDetail) => session.displayTitle.value ?? 'Untitled Codex session';
	const shortId = (id: string) => id.slice(0, 8);
	const date = (value?: string) => value?.slice(0, 10) ?? 'Unknown date';
	const clock = (value?: string) =>
		value
			? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			: 'Unknown time';
	const number = (value?: number) =>
		value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value);
	const duration = (milliseconds?: number) => {
		if (milliseconds === undefined) return '—';
		const seconds = Math.round(milliseconds / 1000);
		return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
	};
	const activityTotal = (activity?: ReplyActivity) =>
		activity?.modelRequests.reduce((sum, request) => sum + (request.usage.totalTokens ?? 0), 0);
	const snapshotTotal = (snapshot: UsageSnapshot) => snapshot.usage.totalTokens ?? 0;
	const maxSnapshotTotal = () => Math.max(1, ...(detail.usage.snapshots.map(snapshotTotal) ?? [0]));
	const percent = (value: number, total: number) => Math.max(2, Math.round((value / total) * 100));

	const filteredConversation = () => {
		if (roleFilter === 'user')
			return detail.conversation.filter((m) => m.role === 'user' && m.kind !== 'internal_review');
		if (roleFilter === 'agent') return detail.conversation.filter((m) => m.role === 'assistant');
		if (roleFilter === 'review')
			return detail.conversation.filter((m) => m.kind === 'internal_review');
		return detail.conversation;
	};

	function toggleActivity(id: string) {
		if (expandedActivities.has(id)) {
			expandedActivities.delete(id);
		} else {
			expandedActivities.add(id);
		}
	}

	function expandAllActivities() {
		expandedActivities.clear();
		for (const m of detail.conversation) {
			if (m.activity) expandedActivities.add(m.id);
		}
	}

	function collapseAllActivities() {
		expandedActivities.clear();
	}

	function copySessionId() {
		if (!detail.id) return;
		navigator.clipboard.writeText(detail.id);
		copiedId = true;
		setTimeout(() => (copiedId = false), 2000);
	}

	function copyMessageText(id: string, text: string) {
		const plain = toPlainText(text);
		navigator.clipboard.writeText(plain);
		copiedMessageIds.add(id);
		setTimeout(() => {
			copiedMessageIds.delete(id);
		}, 2000);
	}
</script>

<svelte:head>
	<title>{title(detail)} — Agent Session Inspect</title>
</svelte:head>

<div class="mx-auto max-w-245 space-y-6">
	<!-- Session Overview Header -->
	<div class="rounded-xl border border-(--line) bg-(--panel) p-5 shadow-sm sm:p-6">
		<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
			<div class="min-w-0 space-y-1.5">
				<div class="flex items-center gap-2">
					<span
						class="inline-flex items-center gap-1 rounded bg-(--accent-soft) px-2 py-0.5 text-[10px] font-bold tracking-wider text-(--accent) uppercase"
					>
						<Code class="h-3 w-3" />
						{detail.displayTitle.source.replace('_', ' ')}
					</span>
					<button
						class="inline-flex items-center gap-1 font-mono text-[11px] text-(--muted) transition-colors hover:text-(--ink)"
						onclick={copySessionId}
						title="Copy session ID"
					>
						{#if copiedId}
							<Check class="h-3 w-3 text-(--success)" />
							<span class="font-medium text-(--success)">Copied ID</span>
						{:else}
							<Copy class="h-3 w-3" />
							<span>{shortId(detail.id)}</span>
						{/if}
					</button>
				</div>

				<h2 class="text-xl leading-snug font-bold tracking-tight text-(--ink) sm:text-2xl">
					{title(detail)}
				</h2>

				<div class="flex flex-wrap items-center gap-3 pt-1 text-xs font-medium text-(--muted)">
					<span class="inline-flex items-center gap-1">
						<Clock class="h-3.5 w-3.5" />
						{date(detail.startedAt)} · {clock(detail.startedAt)}
					</span>
					<span>·</span>
					<span class="inline-flex items-center gap-1">
						<MessageSquare class="h-3.5 w-3.5" />
						{detail.conversation.length} messages
					</span>
				</div>
			</div>

			<!-- Metric Card Pill -->
			<div
				class="min-w-37.5 rounded-lg border border-(--line) bg-(--panel-subtle) p-3 text-right sm:text-right"
			>
				<span class="block text-[10px] font-bold tracking-wider text-(--muted) uppercase"
					>Total Model Tokens</span
				>
				<b class="mt-0.5 block text-2xl font-black text-(--accent)">
					{number(detail.usage.latest?.usage.totalTokens)}
				</b>
				<small class="block text-[10px] font-medium text-(--muted)">latest recorded snapshot</small>
			</div>
		</div>

		<!-- Tabs Switcher -->
		<div class="tabs mt-6">
			<button
				class="tab-btn"
				class:active={view === 'conversation'}
				onclick={() => (view = 'conversation')}
			>
				<MessageSquare class="h-4 w-4" />
				<span>Conversation ({detail.conversation.length})</span>
			</button>
			<button class="tab-btn" class:active={view === 'usage'} onclick={() => (view = 'usage')}>
				<BarChart3 class="h-4 w-4" />
				<span>Usage & Token Analytics</span>
			</button>
		</div>
	</div>

	{#if view === 'conversation'}
		<!-- Conversation Toolbar -->
		<div
			class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-(--line) bg-(--panel) p-2.5 px-4 text-xs"
		>
			<!-- Role Filter Toggle -->
			<div class="flex items-center gap-1.5">
				<Filter class="h-3.5 w-3.5 text-(--muted)" />
				<span class="mr-1 font-bold text-(--muted)">Filter:</span>
				<button
					class="rounded px-2.5 py-1 text-[11px] font-semibold transition-colors {roleFilter ===
					'all'
						? 'bg-(--pill-active-bg) text-(--pill-active-text)'
						: 'text-(--muted) hover:text-(--ink)'}"
					onclick={() => (roleFilter = 'all')}
				>
					All
				</button>
				<button
					class="rounded px-2.5 py-1 text-[11px] font-semibold transition-colors {roleFilter ===
					'user'
						? 'bg-(--user-border) text-white'
						: 'text-(--muted) hover:text-(--ink)'}"
					onclick={() => (roleFilter = 'user')}
				>
					User Prompts
				</button>
				<button
					class="rounded px-2.5 py-1 text-[11px] font-semibold transition-colors {roleFilter ===
					'agent'
						? 'bg-(--agent-border) text-white'
						: 'text-(--muted) hover:text-(--ink)'}"
					onclick={() => (roleFilter = 'agent')}
				>
					Codex Agent
				</button>
				<button
					class="rounded px-2.5 py-1 text-[11px] font-semibold transition-colors {roleFilter ===
					'review'
						? 'bg-(--review-border) text-white'
						: 'text-(--muted) hover:text-(--ink)'}"
					onclick={() => (roleFilter = 'review')}
				>
					Security Reviews
				</button>
			</div>

			<!-- Accordion Actions -->
			<div class="flex items-center gap-2">
				<button
					class="text-[11px] font-semibold text-(--accent) hover:underline"
					onclick={expandAllActivities}
				>
					Expand details
				</button>
				<span class="text-(--line)">|</span>
				<button
					class="text-[11px] font-semibold text-(--muted) hover:underline"
					onclick={collapseAllActivities}
				>
					Collapse details
				</button>
			</div>
		</div>

		<!-- Chat Messages Timeline -->
		<div class="conversation">
			{#each filteredConversation() as message (message.id)}
				<div
					class="chat-card"
					class:from-user={message.role === 'user' && message.kind !== 'internal_review'}
					class:from-agent={message.role === 'assistant'}
					class:internal-review={message.kind === 'internal_review'}
				>
					<!-- Card Header -->
					<div class="card-header">
						<div class="flex items-center gap-2">
							{#if message.kind === 'internal_review'}
								<span class="role-badge">
									<ShieldCheck class="h-3.5 w-3.5" />
									Security Review
								</span>
							{:else if message.role === 'assistant'}
								<span class="role-badge">
									<Sparkles class="h-3.5 w-3.5" />
									Codex Agent
								</span>
								{#if message.activity?.model.name}
									<span
										class="hidden rounded border border-(--line) bg-(--panel-subtle) px-2 py-0.5 font-mono text-[11px] text-(--muted) sm:inline"
									>
										{message.activity.model.name}
									</span>
								{/if}
							{:else}
								<span class="role-badge">
									<User class="h-3.5 w-3.5" />
									User
								</span>
							{/if}
						</div>

						<div class="flex items-center gap-2 font-mono text-[11px] text-(--muted)">
							{#if message.role === 'assistant' && message.activity}
								<span class="hidden md:inline">
									{message.activity.modelRequests.length} steps · {number(
										activityTotal(message.activity)
									)} tokens
								</span>
								<span>·</span>
							{/if}
							<span>{clock(message.timestamp)}</span>

							{#if message.role === 'user' && message.kind !== 'internal_review'}
								{@const userTokens = countTokens(message.text)}
								<span>·</span>
								<span
									class="inline-flex items-center gap-1 rounded border border-(--line) bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] text-(--muted)"
									title="Token count calculated using {userTokens.method}"
								>
									<Zap class="h-3 w-3 text-amber-500" />
									{number(userTokens.count)} tokens
									<span class="hidden text-[9px] opacity-75 lg:inline"
										>({userTokens.method.split(' ')[0]})</span
									>
								</span>
							{/if}

							<!-- Icon-only plain text copy button -->
							<button
								type="button"
								class="ml-0.5 inline-flex items-center justify-center rounded border border-transparent p-1 text-(--muted) transition-colors hover:border-(--line) hover:bg-(--panel-subtle) hover:text-(--ink)"
								onclick={() => copyMessageText(message.id, message.text)}
								title="Copy plain text to clipboard"
								aria-label="Copy plain text"
							>
								{#if copiedMessageIds.has(message.id)}
									<Check class="h-3.5 w-3.5 text-(--success)" />
								{:else}
									<Copy class="h-3.5 w-3.5" />
								{/if}
							</button>
						</div>
					</div>

					<!-- Card Body -->
					<div class="card-body">
						<div class="markdown" use:markdown={message.text}></div>

						<!-- Assistant Tool / Activity Accordion -->
						{#if message.activity}
							<div class="activity-box">
								<button
									class="activity-toggle"
									type="button"
									aria-expanded={expandedActivities.has(message.id)}
									onclick={() => toggleActivity(message.id)}
								>
									<div class="flex items-center gap-2 font-medium">
										<Terminal class="h-3.5 w-3.5 text-(--accent)" />
										<span>Execution Details & Tools ({message.activity.tools.length} calls)</span>
									</div>
									<div class="flex items-center gap-1 text-[11px] text-(--muted)">
										<span
											>{expandedActivities.has(message.id) ? 'Hide details' : 'Show details'}</span
										>
										{#if expandedActivities.has(message.id)}
											<ChevronDown class="h-3.5 w-3.5" />
										{:else}
											<ChevronRight class="h-3.5 w-3.5" />
										{/if}
									</div>
								</button>

								{#if expandedActivities.has(message.id)}
									<div class="activity-body">
										<!-- Work Metrics Grid -->
										<div class="metric-grid">
											<div class="metric-card">
												<small>Response duration</small>
												<b>{duration(message.activity.breakdown.durationMs)}</b>
											</div>
											<div class="metric-card">
												<small>Tool execution time</small>
												<b>{duration(message.activity.breakdown.measuredToolMs)}</b>
											</div>
											<div class="metric-card">
												<small>Unclassified time</small>
												<b>{duration(message.activity.breakdown.otherElapsedMs)}</b>
											</div>
											<div class="metric-card">
												<small>File edits</small>
												<b>{message.activity.edits.length} changes</b>
											</div>
										</div>

										{#if message.activity.breakdown.explanation}
											<p
												class="rounded border border-(--line) bg-(--panel-subtle) p-2.5 text-xs leading-relaxed text-(--muted) italic"
											>
												{message.activity.breakdown.explanation}
											</p>
										{/if}

										<!-- Model Steps Table -->
										{#if message.activity.modelRequests.length}
											<div class="space-y-1.5">
												<span class="text-[10px] font-bold tracking-wider text-(--muted) uppercase"
													>Reported Model Steps</span
												>
												<div class="overflow-x-auto rounded-lg border border-(--line)">
													<table>
														<thead>
															<tr>
																<th>Timestamp</th>
																<th>Input</th>
																<th>Cached</th>
																<th>Output</th>
																<th>Reasoning</th>
																<th>Total</th>
															</tr>
														</thead>
														<tbody>
															{#each message.activity.modelRequests as request (request.id)}
																<tr>
																	<td class="font-mono">{clock(request.timestamp)}</td>
																	<td>{number(request.usage.inputTokens)}</td>
																	<td>{number(request.usage.cachedInputTokens)}</td>
																	<td>{number(request.usage.outputTokens)}</td>
																	<td>{number(request.usage.reasoningOutputTokens)}</td>
																	<td class="font-bold text-(--accent)"
																		>{number(request.usage.totalTokens)}</td
																	>
																</tr>
															{/each}
														</tbody>
													</table>
												</div>
											</div>
										{/if}

										<!-- Tool Executions Accordions -->
										{#if message.activity.tools.length}
											<div class="space-y-2">
												<span class="text-[10px] font-bold tracking-wider text-(--muted) uppercase"
													>Tools Invoked</span
												>
												{#each message.activity.tools as tool (tool.id)}
													<details class="tool-item">
														<summary>
															<div class="flex items-center gap-2">
																<Code class="h-3.5 w-3.5 text-(--accent)" />
																<b class="font-mono text-xs">{tool.name}</b>
																<span
																	class="rounded border border-(--line) bg-(--panel) px-1.5 py-0.5 font-mono text-[10px] text-(--muted)"
																>
																	{tool.status ?? 'recorded'}
																</span>
															</div>
															<span class="font-mono text-[11px] text-(--muted)"
																>{duration(tool.durationMs)}</span
															>
														</summary>
														{#if tool.input}
															<div class="px-3 pt-2">
																<span class="text-[10px] font-semibold text-(--muted) uppercase"
																	>Input</span
																>
																<pre>{tool.input}</pre>
															</div>
														{/if}
														{#if tool.output}
															<div class="px-3 pt-2 pb-2">
																<span class="text-[10px] font-semibold text-(--muted) uppercase"
																	>Output</span
																>
																<pre>{tool.output}</pre>
															</div>
														{/if}
													</details>
												{/each}
											</div>
										{/if}

										<!-- File Edits Diffs -->
										{#if message.activity.edits.length}
											<div class="space-y-2">
												<span class="text-[10px] font-bold tracking-wider text-(--muted) uppercase"
													>File Modifications</span
												>
												{#each message.activity.edits as edit (edit.id)}
													<details class="tool-item">
														<summary>
															<div class="flex items-center gap-2">
																<FileText class="h-3.5 w-3.5 text-(--success)" />
																<b class="text-xs"
																	>{edit.files.length} file{edit.files.length === 1 ? '' : 's'} modified</b
																>
																<span
																	class="rounded border border-(--line) bg-(--panel) px-1.5 py-0.5 text-[10px] text-(--muted)"
																>
																	{edit.status ?? 'recorded'}
																</span>
															</div>
														</summary>
														{#each edit.files as file (file.path)}
															<div class="space-y-1 px-3 py-2">
																<p class="font-mono text-xs text-(--muted)">
																	<span class="font-semibold text-(--ink)"
																		>{file.operation ?? 'update'}</span
																	>
																	· {file.path}
																</p>
																{#if file.diff}
																	<pre class="font-mono text-xs">{file.diff}</pre>
																{/if}
															</div>
														{/each}
													</details>
												{/each}
											</div>
										{/if}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			{:else}
				<div
					class="rounded-xl border border-(--line) bg-(--panel) p-12 text-center text-xs text-(--muted)"
				>
					No messages matching the selected role filter.
				</div>
			{/each}
		</div>
	{:else}
		<!-- Usage & Token Analytics View -->
		<div class="space-y-6">
			<div
				class="flex items-center gap-2 rounded-xl border border-(--accent)/30 bg-(--accent-soft) p-4 text-xs text-(--accent)"
			>
				<Zap class="h-4 w-4 shrink-0" />
				<span>Token totals are reported directly from Codex model execution snapshots.</span>
			</div>

			<!-- Usage Stat Cards Grid -->
			<div class="usage-cards-grid">
				<div class="usage-stat-card">
					<span>Input Tokens</span>
					<b>{number(detail.usage.latest?.usage.inputTokens)}</b>
				</div>
				<div class="usage-stat-card">
					<span>Cached Input</span>
					<b>{number(detail.usage.latest?.usage.cachedInputTokens)}</b>
				</div>
				<div class="usage-stat-card">
					<span>Output Tokens</span>
					<b>{number(detail.usage.latest?.usage.outputTokens)}</b>
				</div>
				<div class="usage-stat-card">
					<span>Reasoning</span>
					<b>{number(detail.usage.latest?.usage.reasoningOutputTokens)}</b>
				</div>
				<div class="usage-stat-card">
					<span>Model Steps</span>
					<b>{number(detail.usage.modelStepCount)}</b>
				</div>
			</div>

			<!-- Token Growth Timeline -->
			<div class="space-y-4 rounded-xl border border-(--line) bg-(--panel) p-5 shadow-sm">
				<div class="flex items-center justify-between">
					<div>
						<h3 class="text-sm font-bold text-(--ink)">Reported Token Growth Timeline</h3>
						<p class="text-xs text-(--muted)">
							Cumulative tokens recorded across execution snapshots
						</p>
					</div>
					<span
						class="rounded border border-(--line) bg-(--panel-subtle) px-2 py-0.5 text-[10px] font-bold text-(--muted) uppercase"
					>
						Snapshot Stream
					</span>
				</div>

				{#if detail.usage.snapshots.length}
					<div class="max-h-100 space-y-3 overflow-y-auto pr-1">
						{#each detail.usage.snapshots as snapshot (snapshot.id)}
							<div class="grid grid-cols-[60px_minmax(100px,1fr)_90px] items-center gap-3 text-xs">
								<span class="font-mono text-(--muted)">{clock(snapshot.timestamp)}</span>
								<div class="snapshot-bar-wrapper">
									<div
										class="snapshot-bar-fill"
										style:width={`${percent(snapshotTotal(snapshot), maxSnapshotTotal())}%`}
									></div>
								</div>
								<b class="text-right font-mono text-(--ink)">{number(snapshotTotal(snapshot))}</b>
							</div>
						{/each}
					</div>
				{:else}
					<p class="py-4 text-center text-xs text-(--muted)">
						No token growth snapshots available for this session.
					</p>
				{/if}
			</div>

			<!-- Response Activity Breakdown Table -->
			<div class="space-y-4 rounded-xl border border-(--line) bg-(--panel) p-5 shadow-sm">
				<div>
					<h3 class="text-sm font-bold text-(--ink)">Response Activity Summary</h3>
					<p class="text-xs text-(--muted)">Recorded steps grouped under assistant responses</p>
				</div>

				<div class="overflow-x-auto rounded-lg border border-(--line)">
					<table>
						<thead>
							<tr>
								<th>Response Time</th>
								<th>Model</th>
								<th>Steps</th>
								<th>Recorded Tokens</th>
								<th>Tool Duration</th>
								<th>Unclassified Time</th>
							</tr>
						</thead>
						<tbody>
							{#each detail.conversation.filter((m) => m.role === 'assistant') as message (message.id)}
								<tr>
									<td class="font-mono">{clock(message.timestamp)}</td>
									<td class="font-mono">{message.activity?.model.name ?? 'Unavailable'}</td>
									<td>{message.activity?.modelRequests.length ?? 0}</td>
									<td class="font-bold text-(--accent)"
										>{number(activityTotal(message.activity))}</td
									>
									<td class="font-mono">{duration(message.activity?.breakdown.measuredToolMs)}</td>
									<td class="font-mono text-(--muted)"
										>{duration(message.activity?.breakdown.otherElapsedMs)}</td
									>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	{/if}

	<!-- Debug & Raw Data Accordion -->
	<details class="rounded-xl border border-(--line) bg-(--panel-subtle) p-4 text-xs">
		<summary class="flex cursor-pointer items-center justify-between font-medium text-(--muted)">
			<span>Debug & Hidden Record Logs</span>
			<span class="rounded border border-(--line) bg-(--panel) px-2 py-0.5 text-[10px]">
				{detail.debug.hiddenMessages.length} hidden · {detail.debug.unattachedActivities.length} unattached
			</span>
		</summary>
		<div class="mt-4 space-y-3 border-t border-(--line) pt-3">
			{#if detail.debug.hiddenMessages.length}
				<span class="text-[10px] font-bold tracking-wider text-(--muted) uppercase"
					>Developer & System Messages</span
				>
				{#each detail.debug.hiddenMessages as message (message.id)}
					<div class="space-y-1 rounded-lg border border-(--line) bg-(--panel) p-3">
						<div class="flex items-center justify-between font-mono text-[11px] text-(--muted)">
							<b class="text-(--ink)">{message.role}</b>
							<span>{clock(message.timestamp)} · Line {message.source.line}</span>
						</div>
						<pre
							class="overflow-x-auto rounded border border-(--line) bg-(--field) p-2 text-xs">{message.text}</pre>
					</div>
				{/each}
			{/if}

			<p class="font-mono text-[11px] text-(--muted)">
				{detail.debug.malformedRecords} malformed and {detail.debug.unknownRecords} unknown records in
				session.
			</p>
		</div>
	</details>
</div>
