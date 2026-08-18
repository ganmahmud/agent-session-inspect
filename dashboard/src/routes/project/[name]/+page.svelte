<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		FolderGit2,
		Clock,
		Zap,
		Layers,
		Bot,
		Cpu,
		Search,
		Star,
		ArrowRight,
		Copy,
		Check,
		Calendar
	} from '@lucide/svelte';
	import { formatCompactTokens, projectName } from '$lib/project';
	import { isPinned, togglePinSession } from '$lib/preferences.svelte';
	import type { SessionInventory } from '../../../../../src/types.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let searchQuery = $state('');
	let sortMode = $state<'newest' | 'oldest' | 'tokens'>('newest');
	let copiedPath = $state(false);

	const decodedProjectName = $derived(decodeURIComponent(page.params.name ?? ''));

	// Find all sessions belonging to this project
	const projectSessions = $derived.by(() => {
		const regular = data.inventory.sessions;
		return regular.filter((s) => {
			const p = projectName(s);
			return p.toLowerCase() === decodedProjectName.toLowerCase();
		});
	});

	// Primary workspace directory path (from newest session with cwd)
	const primaryWorkspacePath = $derived.by(() => {
		const withCwd = projectSessions.find((s) => Boolean(s.cwd));
		return withCwd?.cwd || undefined;
	});

	// Aggregated metrics
	const totalTokens = $derived(
		projectSessions.reduce((sum, s) => {
			const tok = s.token?.last?.totalTokens ?? s.token?.total?.totalTokens ?? 0;
			return sum + tok;
		}, 0)
	);

	function getSubagentCount(session: SessionInventory): number {
		const directSubagentIds = (session.relationships ?? [])
			.filter((r) => r.type === 'subagent')
			.map((r) => r.sessionId);
		if (directSubagentIds.length > 0) return directSubagentIds.length;
		const eventSubCount =
			(session.eventCounts?.['sub_agent_activity'] ?? 0) +
			(session.eventCounts?.['subagent_activity'] ?? 0) +
			(session.eventCounts?.['agent_activity'] ?? 0);
		return eventSubCount > 0 ? eventSubCount : 0;
	}

	const totalSubagents = $derived(
		projectSessions.reduce((sum, s) => {
			return sum + getSubagentCount(s);
		}, 0)
	);

	const earliestDate = $derived.by(() => {
		if (projectSessions.length === 0) return undefined;
		const times = projectSessions
			.map((s) => new Date(s.startedAt ?? 0).getTime())
			.filter((t) => t > 0);
		return times.length > 0 ? new Date(Math.min(...times)) : undefined;
	});

	const latestDate = $derived.by(() => {
		if (projectSessions.length === 0) return undefined;
		const times = projectSessions
			.map((s) => new Date(s.updatedAt ?? s.startedAt ?? 0).getTime())
			.filter((t) => t > 0);
		return times.length > 0 ? new Date(Math.max(...times)) : undefined;
	});

	// Providers distribution
	const providerDistribution = $derived.by(() => {
		const map = new SvelteMap<string, number>();
		for (const s of projectSessions) {
			const p = s.provider || 'codex';
			map.set(p, (map.get(p) ?? 0) + 1);
		}
		return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
	});

	// Filtered & sorted session list
	const filteredSessions = $derived.by(() => {
		let list = projectSessions.filter((s) => {
			const titleStr = s.displayTitle?.value || s.id;
			const matchText = `${titleStr} ${s.id} ${s.provider ?? ''}`.toLowerCase();
			return matchText.includes(searchQuery.toLowerCase());
		});

		if (sortMode === 'newest') {
			list = [...list].sort(
				(a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime()
			);
		} else if (sortMode === 'oldest') {
			list = [...list].sort(
				(a, b) => new Date(a.startedAt ?? 0).getTime() - new Date(b.startedAt ?? 0).getTime()
			);
		} else if (sortMode === 'tokens') {
			list = [...list].sort(
				(a, b) =>
					(b.token?.last?.totalTokens ?? b.token?.total?.totalTokens ?? 0) -
					(a.token?.last?.totalTokens ?? a.token?.total?.totalTokens ?? 0)
			);
		}
		return list;
	});

	function formatDate(d?: Date): string {
		if (!d) return '—';
		return d.toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function formatTime(dStr?: string): string {
		if (!dStr) return '—';
		const d = new Date(dStr);
		return d.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function formatNumber(num: number): string {
		return new Intl.NumberFormat('en-US').format(num);
	}

	function copyPath() {
		if (!primaryWorkspacePath) return;
		navigator.clipboard.writeText(primaryWorkspacePath);
		copiedPath = true;
		setTimeout(() => (copiedPath = false), 2000);
	}
</script>

<svelte:head>
	<title>{decodedProjectName} — Project Overview</title>
</svelte:head>

<div class="relative mx-auto w-[92%] max-w-[92%] space-y-6 pb-12">
	<!-- Project Overview Header Banner -->
	<div class="rounded-2xl border border-(--line) bg-(--panel) p-6 shadow-xs sm:p-8">
		<div class="github-light-strip"></div>
		<div class="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
			<!-- Header Left: Title & Path Info -->
			<div class="min-w-0 flex-1 space-y-3">
				<div class="flex flex-wrap items-center gap-2">
					<span
						class="inline-flex items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 font-mono text-xs font-bold tracking-wider text-indigo-400 uppercase"
					>
						<FolderGit2 class="h-3.5 w-3.5" />
						<span>Project Workspace</span>
					</span>
					<span class="font-mono text-xs text-(--muted)">
						{projectSessions.length} session{projectSessions.length === 1 ? '' : 's'}
					</span>
				</div>

				<h1 class="text-2xl font-extrabold tracking-tight wrap-break-word text-(--ink) sm:text-3xl">
					{decodedProjectName}
				</h1>

				{#if primaryWorkspacePath}
					<div class="flex items-center gap-2 pt-1 font-mono text-xs text-(--muted)">
						<span class="max-w-xl truncate text-(--muted)" title={primaryWorkspacePath}>
							{primaryWorkspacePath}
						</span>
						<button
							type="button"
							class="inline-flex cursor-pointer items-center gap-1 rounded border border-(--line) bg-(--panel-subtle) px-2 py-0.5 text-[11px] transition-colors hover:bg-(--panel) hover:text-(--ink)"
							onclick={copyPath}
							title="Copy workspace path"
						>
							{#if copiedPath}
								<Check class="h-3 w-3 text-emerald-400" />
								<span class="font-bold text-emerald-400">Copied</span>
							{:else}
								<Copy class="h-3 w-3" />
								<span>Copy Path</span>
							{/if}
						</button>
					</div>
				{/if}
			</div>

			<!-- Header Right: Quick Action to Open Latest Session -->
			{#if projectSessions.length > 0}
				{@const latestSession = projectSessions[0]}
				<div class="shrink-0 pt-2 lg:pt-0">
					<a
						href={resolve('/session/[id]', { id: latestSession.id })}
						class="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white no-underline shadow-lg shadow-indigo-600/25 transition-all hover:scale-102 hover:bg-indigo-500"
					>
						<span>Open Latest Session</span>
						<ArrowRight class="h-4 w-4" />
					</a>
				</div>
			{/if}
		</div>

		<!-- Key Metrics Cards Grid -->
		<div class="mt-8 grid grid-cols-2 gap-3 border-t border-(--line) pt-6 sm:grid-cols-4 sm:gap-4">
			<!-- Total Tokens -->
			<div class="rounded-xl border border-(--line) bg-(--field) p-3.5">
				<div class="flex items-center gap-1.5 text-xs font-medium text-(--muted)">
					<Zap class="h-3.5 w-3.5 text-amber-500" />
					<span>Total Tokens</span>
				</div>
				<div class="mt-2 font-mono text-xl font-bold text-(--ink)">
					{formatCompactTokens(totalTokens)}
				</div>
				<div class="mt-0.5 font-mono text-[11px] text-(--muted)">
					{formatNumber(totalTokens)} tokens
				</div>
			</div>

			<!-- Total Sessions -->
			<div class="rounded-xl border border-(--line) bg-(--field) p-3.5">
				<div class="flex items-center gap-1.5 text-xs font-medium text-(--muted)">
					<Layers class="h-3.5 w-3.5 text-indigo-400" />
					<span>Total Sessions</span>
				</div>
				<div class="mt-2 font-mono text-xl font-bold text-(--ink)">
					{projectSessions.length}
				</div>
				<div class="mt-0.5 text-[11px] text-(--muted)">In local workspace</div>
			</div>

			<!-- Subagents Fleet -->
			<div class="rounded-xl border border-(--line) bg-(--field) p-3.5">
				<div class="flex items-center gap-1.5 text-xs font-medium text-(--muted)">
					<Bot class="h-3.5 w-3.5 text-purple-400" />
					<span>Subagents Spawned</span>
				</div>
				<div class="mt-2 font-mono text-xl font-bold text-(--ink)">
					{totalSubagents}
				</div>
				<div class="mt-0.5 text-[11px] text-(--muted)">Across fleet executions</div>
			</div>

			<!-- Active Range -->
			<div class="rounded-xl border border-(--line) bg-(--field) p-3.5">
				<div class="flex items-center gap-1.5 text-xs font-medium text-(--muted)">
					<Calendar class="h-3.5 w-3.5 text-cyan-400" />
					<span>Activity Window</span>
				</div>
				<div class="mt-2 font-mono text-sm font-bold text-(--ink)">
					{formatDate(latestDate)}
				</div>
				<div class="mt-0.5 font-mono text-[11px] text-(--muted)">
					Since {formatDate(earliestDate)}
				</div>
			</div>
		</div>

		<!-- Providers Distribution Pills -->
		{#if providerDistribution.length > 0}
			<div class="mt-4 flex flex-wrap items-center gap-2 border-t border-(--line-subtle) pt-2">
				<span class="text-xs font-bold tracking-wider text-(--muted) uppercase">Providers:</span>
				{#each providerDistribution as [providerName, count] (providerName)}
					<span
						class="inline-flex items-center gap-1.5 rounded-md border border-(--line) bg-(--panel-subtle) px-2.5 py-1 font-mono text-xs text-(--ink)"
					>
						<Cpu class="h-3 w-3 text-cyan-400" />
						<span class="font-semibold uppercase">{providerName}</span>
						<span class="text-[10px] text-(--muted)">({count} session{count === 1 ? '' : 's'})</span
						>
					</span>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Project Sessions Section -->
	<div class="space-y-4">
		<!-- Section Header with Search and Sort -->
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<h2 class="text-lg font-bold text-(--ink)">Project Sessions</h2>
				<p class="text-xs text-(--muted)">
					Showing {filteredSessions.length} of {projectSessions.length} session{projectSessions.length ===
					1
						? ''
						: 's'}
				</p>
			</div>

			<div class="flex flex-wrap items-center gap-2">
				<!-- Search -->
				<div class="relative w-56">
					<Search
						class="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 text-(--muted)"
					/>
					<input
						type="text"
						bind:value={searchQuery}
						placeholder="Filter project sessions..."
						class="w-full rounded-lg border border-(--line) bg-(--field) py-1.5 pr-3 pl-8 text-xs text-(--ink) placeholder:text-xs placeholder:text-(--muted) focus:border-indigo-500 focus:outline-none"
					/>
				</div>

				<!-- Sort -->
				<select
					bind:value={sortMode}
					class="cursor-pointer rounded-lg border border-(--line) bg-(--field) px-3 py-1.5 text-xs font-semibold text-(--ink) focus:border-indigo-500 focus:outline-none"
				>
					<option value="newest">Sort: Newest First</option>
					<option value="oldest">Sort: Oldest First</option>
					<option value="tokens">Sort: Token Usage</option>
				</select>
			</div>
		</div>

		<!-- Sessions Tabular List -->
		{#if filteredSessions.length > 0}
			<div class="overflow-hidden rounded-xl border border-(--line) bg-(--panel) shadow-xs">
				<div class="overflow-x-auto">
					<table class="w-full table-fixed text-left text-xs">
						<thead>
							<tr
								class="border-b border-(--line) bg-(--field)/60 font-mono text-[11px] font-bold tracking-wider text-(--muted) uppercase"
							>
								<th class="w-10 px-2 py-3 text-center">Pin</th>
								<th class="px-4 py-3">Session Title</th>
								<th class="w-40 px-3 py-3">Started</th>
								<th class="w-28 px-3 py-3 text-center">Subagents</th>
								<th class="w-32 px-4 py-3 text-right">Tokens</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-(--line)">
							{#each filteredSessions as session (session.id)}
								{@const subCount = getSubagentCount(session)}
								{@const sTokens =
									session.token?.last?.totalTokens ?? session.token?.total?.totalTokens ?? 0}
								{@const sessionTitle = session.displayTitle?.value || session.id}
								<tr class="group transition-colors hover:bg-indigo-500/5">
									<!-- Pin Action -->
									<td class="w-10 px-2 py-3 text-center">
										<button
											type="button"
											class="cursor-pointer rounded p-1 text-(--muted) transition-colors hover:text-amber-400 {isPinned(
												session.id
											)
												? 'text-amber-400 opacity-100'
												: 'opacity-40 group-hover:opacity-100'}"
											title={isPinned(session.id) ? 'Unpin from favorites' : 'Pin to favorites'}
											onclick={(e) => {
												e.preventDefault();
												e.stopPropagation();
												togglePinSession(session.id);
											}}
										>
											<Star
												class="h-3.5 w-3.5 {isPinned(session.id)
													? 'fill-amber-400 text-amber-400'
													: ''}"
											/>
										</button>
									</td>

									<!-- Session Title (Truncated with tooltip) - No ID -->
									<td class="min-w-0 px-4 py-3">
										<a
											href={resolve('/session/[id]', { id: session.id })}
											class="block truncate text-xs font-semibold text-(--ink) no-underline transition-colors hover:text-indigo-400"
											title={sessionTitle}
										>
											{sessionTitle}
										</a>
									</td>

									<!-- Started Timestamp -->
									<td class="w-40 px-3 py-3 font-mono text-[11px] text-(--muted)">
										<div class="flex items-center gap-1.5 whitespace-nowrap">
											<Clock class="h-3 w-3 shrink-0 text-(--muted)" />
											<span class="truncate">{formatTime(session.startedAt)}</span>
										</div>
									</td>

									<!-- Subagents Count -->
									<td class="w-28 px-3 py-3 text-center font-mono">
										{#if subCount > 0}
											<span
												class="subagent-badge inline-flex items-center gap-1"
												title="{subCount} subagents used in session"
											>
												<Bot class="h-2.5 w-2.5 shrink-0" />
												<span>{subCount}</span>
											</span>
										{:else}
											<span class="text-(--muted) opacity-40">—</span>
										{/if}
									</td>

									<!-- Token Usage -->
									<td class="w-32 px-4 py-3 text-right">
										<span
											class="inline-flex items-center gap-1 rounded bg-(--field) px-2 py-0.5 font-mono text-xs font-semibold text-(--ink)"
											title="{formatNumber(sTokens)} tokens used"
										>
											<Zap class="h-3 w-3 shrink-0 text-amber-500" />
											<span>{formatCompactTokens(sTokens)}</span>
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{:else}
			<div
				class="rounded-xl border border-(--line) bg-(--panel) p-12 text-center text-xs text-(--muted)"
			>
				<FolderGit2 class="mx-auto mb-3 h-10 w-10 text-indigo-400 opacity-30" />
				<div class="text-sm font-bold text-(--ink)">No matching sessions found</div>
				<p class="mt-1">Try adjusting your search query.</p>
			</div>
		{/if}
	</div>
</div>
