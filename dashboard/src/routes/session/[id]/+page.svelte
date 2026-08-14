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
		FileText,
		Download
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
	let exportedSession = $state(false);
	const exportedMessageIds = new SvelteSet<string>();

	// Multi-select messages state
	const selectedMessageIds = new SvelteSet<string>();

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
		let list = detail.conversation;
		if (roleFilter === 'user') {
			list = detail.conversation.filter((m) => m.role === 'user' && m.kind !== 'internal_review');
		} else if (roleFilter === 'agent') {
			list = detail.conversation.filter((m) => m.role === 'assistant');
		} else if (roleFilter === 'review') {
			list = detail.conversation.filter((m) => m.kind === 'internal_review');
		}
		// Sort strictly by timestamp ascending
		return [...list].sort(
			(a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime()
		);
	};

	function toggleMessageSelect(id: string) {
		if (selectedMessageIds.has(id)) {
			selectedMessageIds.delete(id);
		} else {
			selectedMessageIds.add(id);
		}
	}

	function selectAllMessages() {
		for (const m of filteredConversation()) {
			selectedMessageIds.add(m.id);
		}
	}

	function clearMessageSelection() {
		selectedMessageIds.clear();
	}

	function exportSelectedMessages() {
		if (selectedMessageIds.size === 0) return;
		const selectedEntries = detail.conversation.filter((m) => selectedMessageIds.has(m.id));
		const payload = {
			exportVersion: 1,
			exportedAt: new Date().toISOString(),
			sessionId: detail.id,
			sessionTitle: title(detail),
			selectedCount: selectedEntries.length,
			messages: selectedEntries
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `selected-messages-${detail.id.slice(0, 8)}.json`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

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

	async function exportSession() {
		try {
			const res = await fetch(`/api/session/${detail.id}/export`);
			if (!res.ok) return;
			const blob = await res.blob();
			const disposition = res.headers.get('Content-Disposition') ?? '';
			const match = disposition.match(/filename="(.+)"/);
			const filename = match?.[1] ?? `session-${detail.id.slice(0, 8)}.json`;
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = filename;
			a.click();
			URL.revokeObjectURL(a.href);
			exportedSession = true;
			setTimeout(() => (exportedSession = false), 2500);
		} catch {
			// Silent fail — no UI disruption
		}
	}

	function exportMessage(message: import('../../../../../src/types.ts').ConversationEntry) {
		const payload = {
			exportVersion: 1,
			exportedAt: new Date().toISOString(),
			sessionId: detail.id,
			sessionTitle: title(detail),
			message: {
				id: message.id,
				role: message.role,
				kind: message.kind,
				timestamp: message.timestamp,
				text: message.text,
				phase: message.phase,
				activity: message.activity
			}
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `message-${message.role}-${message.id.slice(0, 8)}.json`;
		a.click();
		URL.revokeObjectURL(a.href);
		exportedMessageIds.add(message.id);
		setTimeout(() => exportedMessageIds.delete(message.id), 2500);
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

<div class="relative mx-auto max-w-245 space-y-5">
	<!-- Session Overview Header Box -->
	<div class="rounded-2xl border border-(--line) bg-(--panel) p-5 shadow-xs sm:p-6">
		<div class="github-light-strip"></div>
		<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
			<!-- Header Left: Source pill + Title + Unified Meta Row -->
			<div class="min-w-0 flex-1 space-y-2">
				<div class="flex items-center gap-2">
					<span
						class="inline-flex items-center gap-1.5 rounded-md border border-(--line) bg-(--panel-subtle) px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-(--muted) uppercase"
					>
						<Code class="h-3 w-3 text-cyan-500" />
						{detail.displayTitle.source.replace('_', ' ')}
					</span>
					<span class="font-mono text-xs text-(--muted)">#{shortId(detail.id)}</span>
				</div>

				<h2
					class="line-clamp-2 text-xl leading-snug font-extrabold tracking-tight wrap-break-word text-(--ink) sm:text-2xl"
					title={title(detail)}
				>
					{title(detail)}
				</h2>

				<!-- Concise Integrated Metadata Line -->
				<div
					class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 font-mono text-xs text-(--muted)"
				>
					<span class="inline-flex items-center gap-1.5">
						<Clock class="h-3.5 w-3.5 text-(--muted)" />
						{date(detail.startedAt)} · {clock(detail.startedAt)}
					</span>
					<span>·</span>
					<span class="inline-flex items-center gap-1.5">
						<MessageSquare class="h-3.5 w-3.5 text-indigo-500" />
						{detail.conversation.length} messages
					</span>
					{#if detail.tools?.calls}
						<span>·</span>
						<span class="inline-flex items-center gap-1.5">
							<Terminal class="h-3.5 w-3.5 text-emerald-500" />
							{detail.tools.calls} tools
						</span>
					{/if}
					<span>·</span>
					<button
						type="button"
						class="inline-flex cursor-pointer items-center gap-1 font-bold text-amber-600 hover:underline dark:text-amber-400"
						onclick={() => (view = 'usage')}
						title="Click to view full usage analytics"
					>
						<Zap class="h-3.5 w-3.5 text-amber-500" />
						<span
							>{number(
								detail.usage.latest?.usage.totalTokens ??
									detail.conversation.reduce((sum, m) => sum + (activityTotal(m.activity) ?? 0), 0)
							)} tokens</span
						>
					</button>
				</div>
			</div>

			<!-- Header Right: Quick Actions Group -->
			<div class="flex shrink-0 items-center gap-2 pt-1 sm:pt-0">
				<button
					class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-(--line) bg-(--panel-subtle) px-3 py-1.5 font-mono text-xs text-(--muted) transition-all hover:border-(--accent) hover:bg-(--panel) hover:text-(--ink)"
					onclick={copySessionId}
					title="Copy session ID to clipboard"
				>
					{#if copiedId}
						<Check class="h-3.5 w-3.5 text-(--success)" />
						<span class="font-bold text-(--success)">Copied ID</span>
					{:else}
						<Copy class="h-3.5 w-3.5 text-(--muted)" />
						<span class="text-xs">Copy ID</span>
					{/if}
				</button>

				<button
					class="export-btn-primary"
					onclick={exportSession}
					title="Export full session as JSON file"
				>
					{#if exportedSession}
						<span class="export-toast">
							<Check class="h-3.5 w-3.5 text-emerald-400" />
							<span class="font-bold text-emerald-400">Exported</span>
						</span>
					{:else}
						<Download class="h-3.5 w-3.5" />
						<span class="font-bold">Export Session</span>
					{/if}
				</button>
			</div>
		</div>

		<!-- Segmented View Tabs Switcher (Underline Active State) -->
		<div
			class="mt-5 -mb-5 flex items-center justify-between border-t border-(--line) pt-3 sm:-mb-6"
		>
			<div class="flex items-center gap-6">
				<button
					type="button"
					class="group relative inline-flex cursor-pointer items-center gap-2 border-b-2 pb-3 text-xs font-bold transition-all {view ===
					'conversation'
						? 'border-indigo-500 text-(--ink)'
						: 'border-transparent text-(--muted) hover:border-(--line) hover:text-(--ink)'}"
					onclick={() => (view = 'conversation')}
				>
					<MessageSquare
						class="h-3.5 w-3.5 {view === 'conversation' ? 'text-indigo-400' : 'text-(--muted)'}"
					/>
					<span>Conversation</span>
					<span
						class="rounded-full px-1.5 py-0.5 font-mono text-[10px] font-extrabold transition-colors {view ===
						'conversation'
							? 'border border-indigo-500/30 bg-indigo-500/20 text-indigo-400'
							: 'bg-(--panel-subtle) text-(--muted)'}"
					>
						{detail.conversation.length}
					</span>
				</button>

				<button
					type="button"
					class="group relative inline-flex cursor-pointer items-center gap-2 border-b-2 pb-3 text-xs font-bold transition-all {view ===
					'usage'
						? 'border-amber-500 text-amber-600 dark:text-amber-300'
						: 'border-transparent text-(--muted) hover:border-(--line) hover:text-(--ink)'}"
					onclick={() => (view = 'usage')}
				>
					<BarChart3 class="h-3.5 w-3.5 {view === 'usage' ? 'text-amber-500' : 'text-(--muted)'}" />
					<span>Usage & Analytics</span>
				</button>
			</div>

			<div class="hidden items-center gap-2 pb-3 font-mono text-xs text-(--muted) md:flex">
				<span class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"></span>
				<span
					>{detail.usage.modelStepCount && detail.usage.modelStepCount > 0
						? detail.usage.modelStepCount
						: detail.conversation.reduce(
								(sum, m) => sum + (m.activity?.modelRequests?.length ?? 0),
								0
							)} API steps</span
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

			<!-- Accordion & Multi-Select Actions -->
			<div class="flex items-center gap-3">
				{#if selectedMessageIds.size > 0}
					<div
						class="flex items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1"
					>
						<span class="font-mono text-[11px] font-bold text-indigo-400">
							{selectedMessageIds.size} selected
						</span>
						<button
							type="button"
							class="rounded bg-indigo-600 px-2 py-0.5 font-bold text-white hover:bg-indigo-500"
							onclick={exportSelectedMessages}
						>
							Export Selected
						</button>
						<button
							type="button"
							class="text-(--muted) hover:text-(--ink)"
							onclick={clearMessageSelection}
						>
							Clear
						</button>
					</div>
				{:else}
					<button
						type="button"
						class="text-[11px] font-semibold text-(--muted) hover:text-(--ink)"
						onclick={selectAllMessages}
					>
						Select All
					</button>
				{/if}

				<span class="text-(--line)">|</span>
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
					class="chat-card group relative"
					class:from-user={message.role === 'user' && message.kind !== 'internal_review'}
					class:from-agent={message.role === 'assistant'}
					class:internal-review={message.kind === 'internal_review'}
					class:ring-2={selectedMessageIds.has(message.id)}
					class:ring-indigo-500={selectedMessageIds.has(message.id)}
				>
					<!-- Card Header -->
					<div class="card-header">
						<div class="flex min-w-0 items-center gap-2">
							<input
								type="checkbox"
								checked={selectedMessageIds.has(message.id)}
								onchange={() => toggleMessageSelect(message.id)}
								class="h-4 w-4 cursor-pointer rounded border-(--line) text-indigo-600 focus:ring-indigo-500"
								title="Select message for batch export"
							/>
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

						<div class="flex shrink-0 items-center gap-2 font-mono text-[11px] text-(--muted)">
							{#if message.role === 'assistant' && message.activity}
								{@const totalTokens = activityTotal(message.activity)}
								{#if totalTokens && totalTokens > 0}
									<button
										type="button"
										class="group inline-flex cursor-pointer items-center gap-1 rounded-md border border-(--line) bg-(--panel-subtle) px-2 py-0.5 font-mono text-[11px] font-medium text-(--muted) transition-all hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-300"
										onclick={(e) => openTokenBreakdown(message.id, e)}
										title="Click to view prompt breakdown"
									>
										<Zap class="h-3 w-3 text-amber-500" />
										<b
											class="font-bold text-(--ink) group-hover:text-amber-600 dark:group-hover:text-amber-300"
											>{number(totalTokens)}</b
										>
										<span class="text-[10px] text-(--muted)">tokens</span>
										<ChevronDown
											class="h-3 w-3 transition-transform duration-200 {expandedActivities.has(
												message.id
											)
												? 'rotate-180'
												: ''}"
										/>
									</button>
								{/if}
							{:else if message.role === 'user' && message.kind !== 'internal_review'}
								{@const userTokens = countTokens(message.text)}
								{#if userTokens.count > 0}
									<span
										class="inline-flex items-center gap-1 rounded-md border border-(--line) bg-(--panel-subtle) px-2 py-0.5 font-mono text-[11px] text-(--muted)"
										title="Token count calculated using {userTokens.method}"
									>
										<Zap class="h-3 w-3 text-blue-500" />
										<span>{number(userTokens.count)} tokens</span>
									</span>
								{/if}
							{/if}

							{#if message.kind === 'internal_review'}
								<button
									type="button"
									class="inline-flex cursor-pointer items-center gap-1 rounded border border-(--line) bg-(--panel-subtle) px-2 py-0.5 text-[10px] font-bold text-(--ink) uppercase transition-all hover:bg-(--field)"
									onclick={(e) => {
										e.stopPropagation();
										toggleReview(message.id);
									}}
								>
									<span>{expandedReviews.has(message.id) ? 'Hide review' : 'Show review'}</span>
									<ChevronDown
										class="h-3 w-3 transition-transform duration-200 {expandedReviews.has(
											message.id
										)
											? 'rotate-180'
											: ''}"
									/>
								</button>
							{/if}

							<span class="font-medium text-(--muted)">{clock(message.timestamp)}</span>

							<!-- Action Icon Group (Copy & Export) -->
							<div
								class="flex items-center gap-1 border-l border-(--line) pl-1.5 opacity-80 transition-opacity hover:opacity-100"
							>
								<button
									type="button"
									class="inline-flex items-center justify-center rounded p-1 text-(--muted) transition-colors hover:bg-(--panel-subtle) hover:text-(--ink)"
									onclick={(e) => {
										e.stopPropagation();
										copyMessageText(message.id, message.text);
									}}
									title="Copy message text"
									aria-label="Copy plain text"
								>
									{#if copiedMessageIds.has(message.id)}
										<Check class="h-3.5 w-3.5 text-(--success)" />
									{:else}
										<Copy class="h-3.5 w-3.5" />
									{/if}
								</button>

								<button
									type="button"
									class="inline-flex items-center justify-center rounded p-1 text-(--muted) transition-colors hover:bg-(--panel-subtle) hover:text-(--ink)"
									onclick={(e) => {
										e.stopPropagation();
										exportMessage(message);
									}}
									title="Export message JSON"
									aria-label="Export message"
								>
									{#if exportedMessageIds.has(message.id)}
										<Check class="h-3.5 w-3.5 text-(--success)" />
									{:else}
										<Download class="h-3.5 w-3.5" />
									{/if}
								</button>
							</div>
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

											<!-- Token Breakdown Visualizer & Tool Inspector -->
											{#if message.activity.modelRequests.length}
												<TokenBreakdownVisualizer
													activity={message.activity}
													highlighted={highlightedTokenMessageId === message.id}
												/>
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
