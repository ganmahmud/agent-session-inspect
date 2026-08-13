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
	import TokenBreakdownVisualizer from '$lib/components/TokenBreakdownVisualizer.svelte';
	import type { ReplyActivity, SessionDetail, UsageSnapshot } from '../../../../../src/types.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let detail = $derived(data.detail);

	let view = $state<'conversation' | 'usage'>('conversation');
	let roleFilter = $state<'all' | 'user' | 'agent' | 'review'>('all');
	const expandedActivities = new SvelteSet<string>();
	const expandedReviews = new SvelteSet<string>();
	let copiedId = $state(false);
	const copiedMessageIds = new SvelteSet<string>();
	let highlightedTokenMessageId = $state<string | null>(null);

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

	function toggleReview(id: string) {
		if (expandedReviews.has(id)) {
			expandedReviews.delete(id);
		} else {
			expandedReviews.add(id);
		}
	}

	function expandAllActivities() {
		expandedActivities.clear();
		expandedReviews.clear();
		for (const m of detail.conversation) {
			if (m.activity) expandedActivities.add(m.id);
			if (m.kind === 'internal_review') expandedReviews.add(m.id);
		}
	}

	function collapseAllActivities() {
		expandedActivities.clear();
		expandedReviews.clear();
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

	function openTokenBreakdown(messageId: string, event?: Event) {
		if (event) event.stopPropagation();

		if (view !== 'conversation') {
			view = 'conversation';
		}

		if (expandedActivities.has(messageId)) {
			expandedActivities.delete(messageId);
			if (highlightedTokenMessageId === messageId) {
				highlightedTokenMessageId = null;
			}
			return;
		}

		expandedActivities.add(messageId);
		highlightedTokenMessageId = messageId;

		setTimeout(() => {
			const el = document.getElementById(`token-breakdown-${messageId}`);
			if (el) {
				el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		}, 80);

		setTimeout(() => {
			if (highlightedTokenMessageId === messageId) {
				highlightedTokenMessageId = null;
			}
		}, 4000);
	}
</script>

<svelte:head>
	<title>{title(detail)} — Agent Session Inspect</title>
</svelte:head>

<div class="mx-auto max-w-245 space-y-6">
	<!-- Session Overview Header Box -->
	<div
		class="rounded-xl border-[1.5px] border-(--line) bg-(--panel) p-5 shadow-[var(--hard-shadow)] sm:p-6"
	>
		<div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
			<div class="min-w-0 flex-1 space-y-2.5">
				<!-- Header Pill Badges -->
				<div class="flex flex-wrap items-center gap-2">
					<span
						class="inline-flex items-center gap-1.5 rounded-full border border-(--line) bg-(--panel-subtle) px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-(--muted) uppercase"
					>
						<Code class="h-3 w-3 text-cyan-500" />
						{detail.displayTitle.source.replace('_', ' ')}
					</span>

					<button
						class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-(--line) bg-(--panel-subtle) px-2.5 py-0.5 font-mono text-[11px] text-(--muted) transition-all hover:border-(--accent) hover:bg-(--panel) hover:text-(--ink)"
						onclick={copySessionId}
						title="Copy session ID to clipboard"
					>
						{#if copiedId}
							<Check class="h-3 w-3 text-(--success)" />
							<span class="font-bold text-(--success)">Copied ID</span>
						{:else}
							<Copy class="h-3 w-3 text-(--muted)" />
							<span>{shortId(detail.id)}</span>
						{/if}
					</button>
				</div>

				<!-- Session Title -->
				<h2
					class="line-clamp-2 text-xl leading-snug font-extrabold tracking-tight wrap-break-word text-(--ink) sm:text-2xl"
					title={title(detail)}
				>
					{title(detail)}
				</h2>

				<!-- Session Meta Badges -->
				<div class="flex flex-wrap items-center gap-2 pt-1 text-xs font-medium">
					<span
						class="inline-flex items-center gap-1.5 rounded-md border border-(--line)/80 bg-(--panel-subtle)/60 px-2.5 py-1 font-mono text-[11px] text-(--muted)"
					>
						<Clock class="h-3.5 w-3.5 text-(--muted)" />
						{date(detail.startedAt)} · {clock(detail.startedAt)}
					</span>

					<span
						class="inline-flex items-center gap-1.5 rounded-md border border-(--line)/80 bg-(--panel-subtle)/60 px-2.5 py-1 font-mono text-[11px] text-(--muted)"
					>
						<MessageSquare class="h-3.5 w-3.5 text-indigo-500" />
						{detail.conversation.length} message{detail.conversation.length === 1 ? '' : 's'}
					</span>

					{#if detail.tools?.calls}
						<span
							class="inline-flex items-center gap-1.5 rounded-md border border-(--line)/80 bg-(--panel-subtle)/60 px-2.5 py-1 font-mono text-[11px] text-(--muted)"
						>
							<Terminal class="h-3.5 w-3.5 text-emerald-500" />
							{detail.tools.calls} tool call{detail.tools.calls === 1 ? '' : 's'}
						</span>
					{/if}
				</div>
			</div>

			<!-- Metric Card Pill (Interactive Stat Widget) -->
			<button
				type="button"
				class="group relative min-w-55 cursor-pointer overflow-hidden rounded-xl border border-(--line) bg-linear-to-br from-(--panel) to-(--panel-subtle) p-3.5 text-left shadow-2xs transition-all duration-200 hover:scale-[1.01] hover:border-amber-500/50 hover:shadow-md active:scale-[0.99]"
				onclick={() => (view = 'usage')}
				title="Click to explore full Usage & Token Analytics"
			>
				<!-- Subtle background ambient glow -->
				<div
					class="pointer-events-none absolute -top-6 -right-6 h-20 w-20 rounded-full bg-amber-500/10 blur-xl transition-all group-hover:bg-amber-500/20"
				></div>

				<div class="flex items-center justify-between gap-3">
					<span class="font-mono text-[10px] font-bold tracking-widest text-(--muted) uppercase">
						Total Model Tokens
					</span>
					<span
						class="flex h-6 w-6 items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-500 transition-transform duration-200 group-hover:scale-110 group-hover:bg-amber-500/20"
					>
						<Zap class="h-3.5 w-3.5" />
					</span>
				</div>

				<div class="mt-1 flex items-baseline justify-between gap-2">
					<b class="font-mono text-2xl font-black tracking-tight text-(--ink) sm:text-3xl">
						{number(detail.usage.latest?.usage.totalTokens)}
					</b>
				</div>

				<div
					class="mt-2 flex items-center justify-between border-t border-(--line)/60 pt-2 text-[10px] font-medium text-(--muted)"
				>
					<span
						>{detail.usage.modelStepCount ?? 0} API step{detail.usage.modelStepCount === 1
							? ''
							: 's'}</span
					>
					<span
						class="inline-flex items-center gap-0.5 font-semibold text-(--ink) transition-colors group-hover:text-amber-500"
					>
						Analytics
						<span class="transition-transform duration-200 group-hover:translate-x-1">→</span>
					</span>
				</div>
			</button>
		</div>

		<!-- Tabs Switcher (Flush Card Bottom Tabs) -->
		<div
			class="mt-6 -mb-5 flex items-center justify-between border-t border-(--line) px-1 sm:-mb-6"
		>
			<div class="flex items-center gap-6">
				<button
					type="button"
					class="group inline-flex cursor-pointer items-center gap-2 border-b-2 py-3 text-xs font-bold transition-all {view ===
					'conversation'
						? 'border-indigo-500 text-(--ink)'
						: 'border-transparent text-(--muted) hover:text-(--ink)'}"
					onclick={() => (view = 'conversation')}
				>
					<MessageSquare
						class="h-4 w-4 transition-colors {view === 'conversation'
							? 'text-indigo-500'
							: 'text-(--muted) group-hover:text-(--ink)'}"
					/>
					<span>Conversation</span>
					<span
						class="rounded-full px-2 py-0.5 font-mono text-[10px] font-black transition-colors {view ===
						'conversation'
							? 'bg-indigo-600 text-white shadow-2xs'
							: 'border border-(--line) bg-(--field) text-(--ink) group-hover:bg-indigo-500/20 group-hover:text-indigo-900 dark:group-hover:text-indigo-200'}"
					>
						{detail.conversation.length}
					</span>
				</button>

				<button
					type="button"
					class="group inline-flex cursor-pointer items-center gap-2 border-b-2 py-3 text-xs font-bold transition-all {view ===
					'usage'
						? 'border-amber-500 text-(--ink)'
						: 'border-transparent text-(--muted) hover:text-(--ink)'}"
					onclick={() => (view = 'usage')}
				>
					<BarChart3
						class="h-4 w-4 transition-colors {view === 'usage'
							? 'text-amber-500'
							: 'text-(--muted) group-hover:text-(--ink)'}"
					/>
					<span>Usage & Token Analytics</span>
				</button>
			</div>

			<div class="hidden items-center gap-2 font-mono text-xs font-bold text-(--ink) md:flex">
				<span class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"></span>
				<span>{detail.conversation.length} messages · {detail.usage.modelStepCount ?? 0} steps</span
				>
			</div>
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
						<div class="flex min-w-0 items-center gap-2">
							{#if message.kind === 'internal_review'}
								<span class="role-badge shrink-0">
									<ShieldCheck class="h-3.5 w-3.5" />
									Security Review
								</span>
								{#if !expandedReviews.has(message.id)}
									<span class="truncate text-xs font-medium text-(--muted) italic">
										{toPlainText(message.text).slice(0, 90)}
									</span>
								{/if}
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

						<div
							class="flex shrink-0 items-center gap-2 font-mono text-[11px] font-bold text-(--ink)"
						>
							{#if message.role === 'assistant' && message.activity}
								{@const totalTokens = activityTotal(message.activity)}
								{#if totalTokens && totalTokens > 0}
									<button
										type="button"
										class="group inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-(--line) bg-(--panel-subtle) px-2 py-0.5 font-mono text-[11px] font-medium text-(--ink) shadow-2xs transition-all hover:border-slate-800 hover:bg-slate-900 hover:text-white hover:shadow-xs active:scale-95 dark:hover:border-teal-500/60 dark:hover:bg-teal-950/80 dark:hover:text-teal-100"
										onclick={(e) => openTokenBreakdown(message.id, e)}
										title="Click to expand token allocation & breakdown"
									>
										<Zap
											class="h-3 w-3 text-amber-500 transition-transform group-hover:scale-110 group-hover:text-amber-400"
										/>
										<span class="hidden sm:inline"
											>{message.activity.modelRequests.length} step{message.activity.modelRequests
												.length === 1
												? ''
												: 's'} ·
										</span>
										<b class="text-(--ink) group-hover:text-white dark:group-hover:text-teal-200"
											>{number(totalTokens)} tokens</b
										>
										<span
											class="rounded border border-(--line) bg-(--panel) px-1.25 py-px text-[9px] font-bold tracking-wider text-(--muted) uppercase transition-colors group-hover:border-transparent group-hover:bg-teal-500/30 group-hover:text-teal-200 dark:group-hover:bg-teal-500/30 dark:group-hover:text-teal-200"
										>
											Breakdown
										</span>
										<span
											class="inline-block transition-transform duration-200"
											class:rotate-180={expandedActivities.has(message.id)}
										>
											<ChevronDown
												class="h-3 w-3 text-(--muted) group-hover:text-white dark:group-hover:text-teal-200"
											/>
										</span>
									</button>
									<span>·</span>
								{/if}
							{/if}
							<span class="font-bold text-(--ink)">{clock(message.timestamp)}</span>

							{#if message.role === 'user' && message.kind !== 'internal_review'}
								{@const userTokens = countTokens(message.text)}
								{#if userTokens.count > 0}
									<span>·</span>
									<span
										class="inline-flex items-center gap-1.5 rounded-md border border-(--line) bg-(--panel-subtle) px-2 py-0.5 font-mono text-[11px] font-medium text-(--ink) shadow-2xs"
										title="Token count calculated using {userTokens.method}"
									>
										<Zap class="h-3 w-3 text-blue-600 dark:text-blue-400" />
										<b class="text-(--ink)">{number(userTokens.count)} tokens</b>
										<span
											class="hidden rounded bg-(--panel) px-1 py-px text-[9px] font-bold tracking-wider text-(--muted) uppercase lg:inline"
										>
											{userTokens.method.split(' ')[0]}
										</span>
									</span>
								{/if}
							{/if}

							{#if message.kind === 'internal_review'}
								<span>·</span>
								<button
									type="button"
									class="inline-flex cursor-pointer items-center gap-1 rounded border border-(--line) bg-(--panel-subtle) px-2 py-0.5 text-[10px] font-bold tracking-wider text-(--ink) uppercase transition-all hover:bg-(--field)"
									onclick={(e) => {
										e.stopPropagation();
										toggleReview(message.id);
									}}
								>
									<span>{expandedReviews.has(message.id) ? 'Hide review' : 'Show review'}</span>
									<span
										class="inline-block transition-transform duration-200"
										class:rotate-180={expandedReviews.has(message.id)}
									>
										<ChevronDown class="h-3 w-3" />
									</span>
								</button>
							{/if}

							<!-- Icon-only plain text copy button -->
							<button
								type="button"
								class="ml-0.5 inline-flex items-center justify-center rounded border border-transparent p-1 text-(--muted) transition-colors hover:border-(--line) hover:bg-(--panel-subtle) hover:text-(--ink)"
								onclick={(e) => {
									e.stopPropagation();
									copyMessageText(message.id, message.text);
								}}
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
					{#if message.kind !== 'internal_review' || expandedReviews.has(message.id)}
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
												>{expandedActivities.has(message.id)
													? 'Hide details'
													: 'Show details'}</span
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

											<!-- Token Breakdown Visualizer -->
											{#if message.activity.modelRequests.length}
												<TokenBreakdownVisualizer
													activity={message.activity}
													highlighted={highlightedTokenMessageId === message.id}
												/>
											{/if}

											<!-- Tool Executions Accordions -->
											{#if message.activity.tools.length}
												<div class="space-y-2">
													<span
														class="text-[10px] font-bold tracking-wider text-(--muted) uppercase"
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
													<span
														class="text-[10px] font-bold tracking-wider text-(--muted) uppercase"
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
					{/if}
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
								<tr class="transition-colors hover:bg-(--panel-subtle)/60">
									<td class="font-mono">{clock(message.timestamp)}</td>
									<td class="font-mono">{message.activity?.model.name ?? 'Unavailable'}</td>
									<td>{message.activity?.modelRequests.length ?? 0}</td>
									<td>
										{#if message.activity?.modelRequests.length}
											<button
												type="button"
												class="inline-flex cursor-pointer items-center gap-1 font-bold text-teal-700 hover:underline dark:text-teal-400"
												onclick={(e) => openTokenBreakdown(message.id, e)}
												title="Click to view full breakdown in conversation"
											>
												<Zap class="h-3 w-3 text-amber-500" />
												<span>{number(activityTotal(message.activity))}</span>
											</button>
										{:else}
											<span class="font-bold text-(--accent)"
												>{number(activityTotal(message.activity))}</span
											>
										{/if}
									</td>
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
