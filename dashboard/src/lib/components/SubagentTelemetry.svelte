<script lang="ts">
	import {
		Bot,
		Cpu,
		HardDrive,
		Percent,
		Layers,
		Terminal,
		FileCode,
		User,
		ChevronRight
	} from '@lucide/svelte';
	import type { SessionDetail, ReplyActivity } from '../../../../src/types.ts';
	import FileDiffViewer from '$lib/components/FileDiffViewer.svelte';
	import { extractSessionFileChanges } from '$lib/diff-parser';
	import { markdown } from '$lib/markdown';
	import { SvelteSet } from 'svelte/reactivity';

	interface Props {
		mainSession: SessionDetail;
		subagents: SessionDetail[];
	}

	let { mainSession, subagents }: Props = $props();

	let selectedSubagentId = $state<string | undefined>(undefined);
	let activeSubagentId = $derived(selectedSubagentId || subagents[0]?.id || '');
	const expandedSubagentActivities = new SvelteSet<string>();

	$effect(() => {
		if (subagents.length > 0 && !subagents.some((s) => s.id === activeSubagentId)) {
			selectedSubagentId = subagents[0].id;
		}
	});

	let activeSubagent = $derived.by(() => {
		return subagents.find((s) => s.id === activeSubagentId) || subagents[0];
	});

	const numberFormat = (n?: number) => (n === undefined ? '—' : new Intl.NumberFormat('en-US').format(n));
	const shortId = (id?: string) => (id ? id.slice(0, 8) : '');
	const clock = (value?: string) =>
		value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown time';
	const duration = (milliseconds?: number) => {
		if (milliseconds === undefined) return '—';
		const seconds = Math.round(milliseconds / 1000);
		return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
	};

	const activityTotal = (activity?: ReplyActivity) =>
		activity?.modelRequests.reduce((sum, request) => sum + (request.usage.totalTokens ?? 0), 0);

	const getSessionTokens = (session: SessionDetail) => {
		if (session.usage?.latest?.usage.totalTokens) return session.usage.latest.usage.totalTokens;
		if (session.token?.last?.totalTokens) return session.token.last.totalTokens;
		if (session.token?.total?.totalTokens) return session.token.total.totalTokens;
		return session.conversation.reduce((sum, m) => sum + (activityTotal(m.activity) ?? 0), 0);
	};

	// Aggregate statistics
	let fleetStats = $derived.by(() => {
		const mainTokens = getSessionTokens(mainSession);
		let totalSubagentsTokens = 0;
		let totalSubagentsToolMs = 0;
		let totalSubagentSteps = 0;

		for (const sub of subagents) {
			totalSubagentsTokens += getSessionTokens(sub);
			for (const m of sub.conversation ?? []) {
				if (m.role === 'assistant' && m.activity?.breakdown) {
					totalSubagentsToolMs += m.activity.breakdown.measuredToolMs ?? 0;
				}
				totalSubagentSteps += m.activity?.modelRequests?.length ?? 0;
			}
		}

		const combinedTokens = mainTokens + totalSubagentsTokens;
		const mainTokenPct = combinedTokens > 0 ? Math.round((mainTokens / combinedTokens) * 100) : 100;
		const subTokenPct = combinedTokens > 0 ? 100 - mainTokenPct : 0;

		return {
			mainTokens,
			totalSubagentsTokens,
			combinedTokens,
			mainTokenPct,
			subTokenPct,
			totalSubagentsToolMs,
			totalSubagentSteps,
			subagentCount: subagents.length
		};
	});

	// Subagent specific KPI stats
	let activeSubagentStats = $derived.by(() => {
		if (!activeSubagent) return null;
		const latest = activeSubagent.usage?.latest;
		const maxContext = latest?.modelContextWindow || 200000;
		const latestTotal = getSessionTokens(activeSubagent);
		const saturationPct = Math.min(100, Math.round((latestTotal / maxContext) * 100));

		const latestInput = latest?.usage.inputTokens ?? activeSubagent.token?.last?.inputTokens ?? 0;
		const latestCached = latest?.usage.cachedInputTokens ?? activeSubagent.token?.last?.cachedInputTokens ?? 0;
		const latestFresh = Math.max(0, latestInput - latestCached);
		const latestOutput = latest?.usage.outputTokens ?? activeSubagent.token?.last?.outputTokens ?? 0;
		const latestReasoning = latest?.usage.reasoningOutputTokens ?? activeSubagent.token?.last?.reasoningOutputTokens ?? 0;

		const cacheHitRatio = latestInput > 0 ? Math.round((latestCached / latestInput) * 100) : 0;
		const reasoningRatio = latestOutput > 0 ? Math.round((latestReasoning / latestOutput) * 100) : 0;

		let totalToolMs = 0;
		let totalOtherMs = 0;
		for (const m of activeSubagent.conversation ?? []) {
			if (m.role === 'assistant' && m.activity?.breakdown) {
				totalToolMs += m.activity.breakdown.measuredToolMs ?? 0;
				totalOtherMs += m.activity.breakdown.otherElapsedMs ?? 0;
			}
		}

		const fileChanges = extractSessionFileChanges(activeSubagent);

		return {
			maxContext,
			latestTotal,
			saturationPct,
			latestInput,
			latestCached,
			latestFresh,
			latestOutput,
			latestReasoning,
			cacheHitRatio,
			reasoningRatio,
			totalToolMs,
			totalOtherMs,
			fileChanges,
			stepCount:
				activeSubagent.usage?.modelStepCount ||
				activeSubagent.conversation.reduce((sum, m) => sum + (m.activity?.modelRequests?.length ?? 0), 0)
		};
	});

	function toggleSubagentActivity(id: string) {
		if (expandedSubagentActivities.has(id)) {
			expandedSubagentActivities.delete(id);
		} else {
			expandedSubagentActivities.add(id);
		}
	}
</script>

<div class="subagents-cockpit space-y-6">
	{#if subagents.length === 0}
		<div class="rounded-2xl border border-(--line) bg-(--panel) p-10 text-center shadow-xs">
			<div
				class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-purple-500/30 bg-purple-500/10 text-purple-400"
			>
				<Bot class="h-7 w-7" />
			</div>
			<h3 class="mt-4 text-base font-bold text-(--ink)">No Subagent Delegations in This Session</h3>
			<p class="mx-auto mt-2 max-w-md text-xs leading-relaxed text-(--muted)">
				This Codex session was executed solely by the main agent thread without delegating to child subagents or spawning secondary agent threads.
			</p>
			<div
				class="mx-auto mt-6 max-w-lg rounded-xl border border-(--line-subtle) bg-(--panel-subtle) p-4 text-left font-mono text-xs text-(--muted)"
			>
				<p class="font-bold text-(--ink)">How Subagent Observability Works:</p>
				<ul class="mt-2 list-disc space-y-1 pl-4">
					<li>When Codex executes <code>sub_agent_activity</code> or spawns child threads, they are tracked automatically.</li>
					<li>Each subagent receives segregated telemetry, KPI context saturation, and dedicated conversation transcripts.</li>
				</ul>
			</div>
		</div>
	{:else}
		<!-- Fleet Multi-Agent Architecture Summary -->
		<div class="rounded-xl border border-(--line) bg-(--panel) p-5 shadow-xs">
		<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
			<div class="space-y-1">
				<div class="flex items-center gap-2">
					<div
						class="flex h-8 w-8 items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/10 text-purple-400"
					>
						<Bot class="h-4.5 w-4.5" />
					</div>
					<div>
						<h3 class="text-base font-bold text-(--ink)">
							Subagents Fleet & Distributed Telemetry
						</h3>
						<p class="text-xs text-(--muted)">
							Dedicated resource consumption and execution analytics for autonomous child agents
						</p>
					</div>
				</div>
			</div>

			<div class="flex items-center gap-3">
				<span
					class="inline-flex items-center gap-1.5 rounded-lg border border-purple-500/30 bg-purple-500/15 px-3 py-1.5 font-mono text-xs font-bold text-purple-300"
				>
					<Bot class="h-3.5 w-3.5" />
					{fleetStats.subagentCount} Subagent{fleetStats.subagentCount === 1 ? '' : 's'} Active
				</span>
			</div>
		</div>

		<!-- Token Footprint Multi-Agent Allocation Bar -->
		<div class="mt-4 space-y-2 border-t border-(--line) pt-4">
			<div class="flex items-center justify-between text-xs font-semibold">
				<div class="flex items-center gap-2">
					<span class="inline-flex h-2.5 w-2.5 rounded-full bg-indigo-500"></span>
					<span class="text-(--ink)">Main Agent ({fleetStats.mainTokenPct}%)</span>
					<span class="font-mono text-(--muted)">{numberFormat(fleetStats.mainTokens)} tokens</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="inline-flex h-2.5 w-2.5 rounded-full bg-purple-500"></span>
					<span class="text-(--ink)">Subagents Fleet ({fleetStats.subTokenPct}%)</span>
					<span class="font-mono text-purple-300"
						>{numberFormat(fleetStats.totalSubagentsTokens)} tokens</span
					>
				</div>
			</div>

			<div class="h-2.5 w-full overflow-hidden rounded-full bg-(--field)">
				<div class="flex h-full">
					<div
						class="bg-indigo-500 transition-all duration-300"
						style:width={`${fleetStats.mainTokenPct}%`}
						title="Main Agent Tokens: {numberFormat(fleetStats.mainTokens)}"
					></div>
					<div
						class="bg-purple-500 transition-all duration-300"
						style:width={`${fleetStats.subTokenPct}%`}
						title="Subagents Tokens: {numberFormat(fleetStats.totalSubagentsTokens)}"
					></div>
				</div>
			</div>
		</div>
	</div>

	<!-- Subagent Selector Cards Grid -->
	<div class="space-y-3">
		<div class="flex items-center justify-between">
			<h4 class="text-xs font-bold tracking-wider text-(--muted) uppercase">
				Select Subagent To Inspect
			</h4>
			<span class="font-mono text-xs text-(--muted)">
				{subagents.length} subagent thread{subagents.length === 1 ? '' : 's'}
			</span>
		</div>

		<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each subagents as sub (sub.id)}
				{@const isSelected = activeSubagentId === sub.id}
				{@const subTokens = getSessionTokens(sub)}
				{@const subTitle = sub.displayTitle?.value || `Subagent Thread #${shortId(sub.id)}`}
				<div
					class="group relative flex cursor-pointer flex-col justify-between rounded-xl border p-4 transition-all {isSelected
						? 'border-purple-500/60 bg-purple-500/10 shadow-sm'
						: 'border-(--line) bg-(--panel) hover:border-(--line-subtle) hover:bg-(--panel-subtle)'}"
					role="button"
					tabindex="0"
					onclick={() => (selectedSubagentId = sub.id)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') selectedSubagentId = sub.id;
					}}
				>
					<div class="space-y-2">
						<div class="flex items-center justify-between gap-2">
							<span
								class="inline-flex items-center gap-1 rounded-md border border-purple-500/30 bg-purple-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-purple-300 uppercase"
							>
								<Bot class="h-3 w-3" />
								Subagent
							</span>
							<span class="font-mono text-xs text-(--muted)">#{shortId(sub.id)}</span>
						</div>

						<h4
							class="line-clamp-2 text-sm font-bold text-(--ink) transition-colors group-hover:text-purple-300"
							title={subTitle}
						>
							{subTitle}
						</h4>
					</div>

					<div class="mt-4 space-y-2 border-t border-(--line-subtle) pt-3">
						<div class="flex items-center justify-between font-mono text-xs">
							<span class="text-(--muted)">Tokens:</span>
							<span class="font-bold text-amber-400">{numberFormat(subTokens)}</span>
						</div>
						<div class="flex items-center justify-between font-mono text-xs">
							<span class="text-(--muted)">Messages:</span>
							<span class="font-medium text-(--ink)">{sub.conversation?.length ?? 0}</span>
						</div>

						<div class="flex items-center justify-between pt-1">
							<span
								class="inline-flex items-center gap-1 text-[11px] font-semibold transition-colors {isSelected
									? 'text-purple-300 font-bold'
									: 'text-purple-400 group-hover:underline'}"
							>
								<span>{isSelected ? '✓ Currently Inspecting' : 'Inspect Telemetry'}</span>
							</span>
							<span class="rounded border border-(--line) bg-(--field) px-2 py-0.5 font-mono text-[10px] text-(--muted)">
								{sub.conversation?.length ?? 0} msgs
							</span>
						</div>
					</div>
				</div>
			{/each}
		</div>
	</div>

	<!-- Selected Subagent Detailed Telemetry Workbench -->
	{#if activeSubagent && activeSubagentStats}
		{@const sub = activeSubagent}
		{@const stats = activeSubagentStats}
		<div class="space-y-6 rounded-2xl border border-purple-500/30 bg-(--panel) p-5.5 shadow-sm">
			<!-- Subagent Header Banner -->
			<div
				class="flex flex-col gap-3 border-b border-(--line) pb-4 sm:flex-row sm:items-center sm:justify-between"
			>
				<div class="space-y-1">
					<div class="flex items-center gap-2">
						<span
							class="inline-flex items-center gap-1 rounded bg-purple-500/20 px-2 py-0.5 font-mono text-xs font-bold text-purple-300"
						>
							<Bot class="h-3.5 w-3.5" />
							SUBAGENT COCKPIT
						</span>
						<span class="font-mono text-xs text-(--muted)">#{sub.id}</span>
					</div>
					<h3 class="text-lg font-extrabold text-(--ink)">
						{sub.displayTitle?.value || `Subagent Thread #${shortId(sub.id)}`}
					</h3>
					<div class="flex flex-wrap items-center gap-3 font-mono text-xs text-(--muted)">
						<span>Started: {clock(sub.startedAt)}</span>
						<span>·</span>
						<span>{sub.conversation?.length ?? 0} messages</span>
						{#if sub.cwd}
							<span>·</span>
							<span class="truncate max-w-xs">{sub.cwd}</span>
						{/if}
					</div>
				</div>

				<div class="flex items-center gap-2">
					<span
						class="inline-flex items-center gap-1.5 rounded-lg border border-purple-500/40 bg-purple-500/15 px-3 py-1.5 font-mono text-xs font-bold text-purple-300"
					>
						<Bot class="h-3.5 w-3.5" />
						<span>Autonomous Subagent Stream</span>
					</span>
				</div>
			</div>

			<!-- Subagent 4 Executive KPI Cards -->
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<!-- KPI 1: Context Saturation -->
				<div class="space-y-2 rounded-xl border border-(--line) bg-(--panel-subtle)/50 p-4 shadow-xs">
					<div class="flex items-center justify-between text-xs font-semibold text-(--muted)">
						<span>Context Saturation</span>
						<HardDrive class="h-4 w-4 text-(--muted)" />
					</div>
					<div class="flex items-baseline justify-between">
						<b class="font-mono text-xl text-(--ink)">{numberFormat(stats.latestTotal)}</b>
						<span class="font-mono text-xs text-(--muted)">/ {numberFormat(stats.maxContext)}</span>
					</div>
					<div class="h-2 w-full overflow-hidden rounded-full bg-(--field)">
						<div
							class="h-full bg-purple-500 transition-all duration-300"
							style:width={`${stats.saturationPct}%`}
						></div>
					</div>
					<p class="text-[11px] text-(--muted)">
						{stats.saturationPct}% context window utilization
					</p>
				</div>

				<!-- KPI 2: Prompt Cache Hit Rate -->
				<div class="space-y-2 rounded-xl border border-(--line) bg-(--panel-subtle)/50 p-4 shadow-xs">
					<div class="flex items-center justify-between text-xs font-semibold text-(--muted)">
						<span>Prompt Cache Savings</span>
						<Percent class="h-4 w-4 text-teal-400" />
					</div>
					<div class="flex items-baseline gap-2">
						<b class="font-mono text-xl text-teal-400">{stats.cacheHitRatio}%</b>
						<span class="text-xs text-(--muted)">cached input</span>
					</div>
					<div class="font-mono text-xs text-(--muted)">
						{numberFormat(stats.latestCached)} of {numberFormat(stats.latestInput)} tokens
					</div>
					<p class="text-[11px] font-medium text-teal-400/90">
						{stats.cacheHitRatio > 50 ? 'High prompt cache reuse' : 'Standard prompt loading'}
					</p>
				</div>

				<!-- KPI 3: Reasoning Overhead -->
				<div class="space-y-2 rounded-xl border border-(--line) bg-(--panel-subtle)/50 p-4 shadow-xs">
					<div class="flex items-center justify-between text-xs font-semibold text-(--muted)">
						<span>Reasoning Output</span>
						<Cpu class="h-4 w-4 text-purple-400" />
					</div>
					<div class="flex items-baseline gap-2">
						<b class="font-mono text-xl text-purple-400">{numberFormat(stats.latestReasoning)}</b>
						<span class="text-xs text-(--muted)">({stats.reasoningRatio}%)</span>
					</div>
					<div class="font-mono text-xs text-(--muted)">
						{numberFormat(stats.latestOutput)} total net output
					</div>
					<p class="text-[11px] text-purple-400/90">Chain-of-thought tokens</p>
				</div>

				<!-- KPI 4: Execution Cycles & Work -->
				<div class="space-y-2 rounded-xl border border-(--line) bg-(--panel-subtle)/50 p-4 shadow-xs">
					<div class="flex items-center justify-between text-xs font-semibold text-(--muted)">
						<span>Execution Cycles</span>
						<Layers class="h-4 w-4 text-sky-400" />
					</div>
					<div class="flex items-baseline gap-2">
						<b class="font-mono text-xl text-sky-400">{stats.stepCount}</b>
						<span class="text-xs text-(--muted)">model steps</span>
					</div>
					<div class="font-mono text-xs text-(--muted)">
						{duration(stats.totalToolMs)} tool work runtime
					</div>
					<p class="text-[11px] text-(--muted)">Subagent tool cycles</p>
				</div>
			</div>

			<!-- Subagent File Modifications (if any) -->
			{#if stats.fileChanges.totalFiles > 0}
				<div class="space-y-3 rounded-xl border border-(--line) bg-(--panel-subtle)/30 p-4">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2">
							<FileCode class="h-4 w-4 text-emerald-400" />
							<h4 class="text-sm font-bold text-(--ink)">
								File Modifications by this Subagent ({stats.fileChanges.totalFiles})
							</h4>
						</div>
						<div class="flex items-center gap-2 font-mono text-xs">
							<span class="text-emerald-400">+{stats.fileChanges.totalAdditions}</span>
							<span class="text-rose-400">-{stats.fileChanges.totalDeletions}</span>
						</div>
					</div>

					<FileDiffViewer summary={stats.fileChanges} />
				</div>
			{/if}

			<!-- Subagent Conversation Transcript Stream -->
			<div class="space-y-3">
				<div class="flex items-center justify-between border-t border-(--line) pt-4">
					<div class="flex items-center gap-2">
						<Bot class="h-4 w-4 text-purple-400" />
						<h4 class="text-sm font-bold text-(--ink)">Subagent Activity & Conversation Flow</h4>
					</div>
					<span class="font-mono text-xs text-(--muted)">
						{sub.conversation?.length ?? 0} turn{sub.conversation?.length === 1 ? '' : 's'}
					</span>
				</div>

				{#if !sub.conversation || sub.conversation.length === 0}
					<div class="rounded-xl border border-(--line) bg-(--field) p-8 text-center text-xs text-(--muted)">
						No conversation entries recorded for this subagent.
					</div>
				{:else}
					<div class="space-y-3">
						{#each sub.conversation as msg (msg.id)}
							<div
								class="rounded-xl border p-4 transition-colors {msg.role === 'assistant'
									? 'border-(--agent-border)/60 bg-(--agent-bg)'
									: 'border-(--user-border)/60 bg-(--user-bg)'}"
							>
								<!-- Message Header -->
								<div class="flex items-center justify-between border-b border-(--line-subtle) pb-2">
									<div class="flex items-center gap-2">
										{#if msg.role === 'assistant'}
											<span
												class="inline-flex items-center gap-1 rounded bg-purple-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-purple-300 uppercase"
											>
												<Bot class="h-3 w-3" />
												Subagent Reply
											</span>
											{#if msg.activity?.model?.name}
												<span class="font-mono text-[10px] text-(--muted)">
													{msg.activity.model.name}
												</span>
											{/if}
										{:else}
											<span
												class="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-blue-300 uppercase"
											>
												<User class="h-3 w-3" />
												Subagent Prompt
											</span>
										{/if}
									</div>

									<div class="flex items-center gap-2 font-mono text-[11px] text-(--muted)">
										{#if msg.role === 'assistant' && msg.activity}
											{@const totalT = activityTotal(msg.activity)}
											{#if totalT && totalT > 0}
												<span class="font-bold text-amber-400">{numberFormat(totalT)} tokens</span>
											{/if}
										{/if}
										<span>{clock(msg.timestamp)}</span>
									</div>
								</div>

								<!-- Message Body -->
								<div class="pt-3">
									<div class="markdown text-xs text-(--ink)" use:markdown={msg.text}></div>

									<!-- Assistant Activity & Tools -->
									{#if msg.activity && msg.activity.tools.length > 0}
										<div class="mt-3 space-y-2 border-t border-(--line-subtle) pt-2">
											<button
												type="button"
												class="flex w-full cursor-pointer items-center justify-between rounded-lg bg-(--field) p-2 text-xs font-semibold text-(--muted) hover:text-(--ink)"
												onclick={() => toggleSubagentActivity(msg.id)}
											>
												<div class="flex items-center gap-2">
													<Terminal class="h-3.5 w-3.5 text-purple-400" />
													<span>Execution Details ({msg.activity.tools.length} tool calls)</span>
												</div>
												<ChevronRight
													class="h-3.5 w-3.5 transition-transform {expandedSubagentActivities.has(
														msg.id
													)
														? 'rotate-90'
														: ''}"
												/>
											</button>

											{#if expandedSubagentActivities.has(msg.id)}
												<div class="space-y-2 p-2">
													{#each msg.activity.tools as tool (tool.id)}
														<div class="rounded-lg border border-(--line-subtle) bg-(--field) p-2.5 font-mono text-xs">
															<div class="flex items-center justify-between text-[11px]">
																<div class="flex items-center gap-1.5">
																	<span class="h-2 w-2 rounded-full bg-purple-400"></span>
																	<b class="text-purple-300">{tool.name}</b>
																	{#if tool.status}
																		<span class="rounded bg-purple-500/20 px-1.5 py-0.2 text-[10px] text-purple-300">
																			{tool.status}
																		</span>
																	{/if}
																</div>
																<span class="text-(--muted)">{duration(tool.durationMs)}</span>
															</div>
															{#if tool.input}
																<div class="mt-2 space-y-1">
																	<span class="text-[10px] font-bold text-(--muted) uppercase tracking-wider">Input / Prompt:</span>
																	<pre class="max-h-36 overflow-x-auto rounded bg-(--canvas) p-2 text-[11px] text-(--ink) whitespace-pre-wrap">{tool.input}</pre>
																</div>
															{/if}
															{#if tool.output}
																<div class="mt-2 space-y-1">
																	<span class="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">Output / Result:</span>
																	<pre class="max-h-48 overflow-x-auto rounded bg-(--canvas) p-2 text-[11px] text-(--ink) whitespace-pre-wrap">{tool.output}</pre>
																</div>
															{/if}
														</div>
													{/each}
												</div>
											{/if}
										</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
{/if}
</div>
