<script lang="ts">
	import { Zap, CircleCheck } from '@lucide/svelte';
	import type { ReplyActivity } from '../../../../src/types';

	let {
		activity,
		highlighted = false
	}: {
		activity: ReplyActivity;
		highlighted?: boolean;
	} = $props();

	const number = (val?: number) =>
		val === undefined ? '0' : new Intl.NumberFormat('en-US').format(val);

	const clock = (val?: string) =>
		val
			? new Date(val).toLocaleTimeString([], {
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit'
				})
			: '—';

	let requests = $derived(activity.modelRequests ?? []);

	let stats = $derived.by(() => {
		let totalInput = 0;
		let totalCached = 0;
		let totalOutput = 0;
		let totalReasoning = 0;
		let grandTotal = 0;

		for (const req of requests) {
			const u = req.usage;
			const input = u.inputTokens ?? 0;
			const cached = u.cachedInputTokens ?? 0;
			const output = u.outputTokens ?? 0;
			const reasoning = u.reasoningOutputTokens ?? 0;
			const reqTotal = u.totalTokens ?? input + output;

			totalInput += input;
			totalCached += cached;
			totalOutput += output;
			totalReasoning += reasoning;
			grandTotal += reqTotal;
		}

		const freshInput = Math.max(0, totalInput - totalCached);
		const netOutput = Math.max(0, totalOutput - totalReasoning);
		const cacheHitRatio = totalInput > 0 ? Math.round((totalCached / totalInput) * 100) : 0;

		const denom = grandTotal > 0 ? grandTotal : 1;
		const pctCached = Math.round((totalCached / denom) * 100);
		const pctFresh = Math.round((freshInput / denom) * 100);
		const pctOutput = Math.round((netOutput / denom) * 100);
		const pctReasoning = Math.round((totalReasoning / denom) * 100);

		return {
			totalInput,
			totalCached,
			freshInput,
			totalOutput,
			netOutput,
			totalReasoning,
			grandTotal,
			cacheHitRatio,
			pctCached,
			pctFresh,
			pctOutput,
			pctReasoning
		};
	});

	function getStepBreakdown(req: (typeof requests)[0]) {
		const u = req.usage;
		const input = u.inputTokens ?? 0;
		const cached = u.cachedInputTokens ?? 0;
		const output = u.outputTokens ?? 0;
		const reasoning = u.reasoningOutputTokens ?? 0;
		const stepTotal = u.totalTokens ?? input + output;

		const freshInput = Math.max(0, input - cached);
		const netOutput = Math.max(0, output - reasoning);

		const denom = stepTotal > 0 ? stepTotal : 1;
		return {
			input,
			cached,
			freshInput,
			output,
			netOutput,
			reasoning,
			stepTotal,
			pctCached: Math.round((cached / denom) * 100),
			pctFresh: Math.round((freshInput / denom) * 100),
			pctOutput: Math.round((netOutput / denom) * 100),
			pctReasoning: Math.round((reasoning / denom) * 100)
		};
	}
</script>

<div
	class="token-breakdown-box space-y-4 rounded-xl border p-4 shadow-xs transition-all duration-500 {highlighted
		? 'border-(--token-cached) bg-(--token-cached-bg) ring-2 ring-(--token-cached)/40'
		: 'border-(--line) bg-(--panel)'}"
	id="token-breakdown-{activity.association || 'box'}"
>
	<!-- Header Banner -->
	<div class="flex flex-wrap items-center justify-between gap-2 border-b border-(--line) pb-3">
		<div class="flex items-center gap-2.5">
			<div
				class="flex h-8 w-8 items-center justify-center rounded-lg border border-(--line) bg-(--panel-subtle) text-(--ink) shadow-xs"
			>
				<Zap class="h-4 w-4 text-amber-500" />
			</div>
			<div>
				<h4 class="text-xs font-bold tracking-wider text-(--ink) uppercase">
					Token Allocation & Breakdown
				</h4>
				<p class="text-[11px] font-medium text-(--muted)">
					Detailed usage across {requests.length} step{requests.length === 1 ? '' : 's'} in this Codex
					turn
				</p>
			</div>
		</div>

		<div class="flex items-center gap-2">
			{#if stats.totalCached > 0}
				<span
					class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold shadow-2xs"
					style="background: var(--token-cached-bg); border-color: var(--token-cached-border); color: var(--token-cached-text);"
					title="{number(stats.totalCached)} prompt tokens served from cache"
				>
					<CircleCheck class="h-3.5 w-3.5" />
					<span>{stats.cacheHitRatio}% Cache Hit</span>
				</span>
			{/if}

			<div
				class="rounded-lg border border-(--line) bg-(--panel-subtle) px-3 py-1 text-right font-mono text-xs shadow-2xs"
			>
				<span class="block text-[9px] font-bold uppercase tracking-wider text-(--muted)">Total Turn Tokens</span>
				<b class="text-sm font-black text-(--ink)">{number(stats.grandTotal)}</b>
			</div>
		</div>
	</div>

	<!-- Stacked Token Proportion Bar -->
	<div class="space-y-1.5">
		<div class="flex items-center justify-between text-[11px] font-bold text-(--muted)">
			<span class="uppercase tracking-wider">Composition</span>
			<span class="font-mono text-[10px]">
				100% = {number(stats.grandTotal)} tokens
			</span>
		</div>

		<div
			class="relative flex h-4 w-full overflow-hidden rounded-full border border-(--line) bg-(--field) p-0.5 shadow-inner"
		>
			{#if stats.pctCached > 0}
				<div
					class="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full hover:brightness-110"
					style="width: {stats.pctCached}%; background: var(--token-cached);"
					title="Cached Input: {number(stats.totalCached)} ({stats.pctCached}%)"
				></div>
			{/if}
			{#if stats.pctFresh > 0}
				<div
					class="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full hover:brightness-110"
					style="width: {stats.pctFresh}%; background: var(--token-input);"
					title="Fresh Input: {number(stats.freshInput)} ({stats.pctFresh}%)"
				></div>
			{/if}
			{#if stats.pctOutput > 0}
				<div
					class="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full hover:brightness-110"
					style="width: {stats.pctOutput}%; background: var(--token-output);"
					title="Output Generation: {number(stats.netOutput)} ({stats.pctOutput}%)"
				></div>
			{/if}
			{#if stats.pctReasoning > 0}
				<div
					class="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full hover:brightness-110"
					style="width: {stats.pctReasoning}%; background: var(--token-reasoning);"
					title="Reasoning / CoT: {number(stats.totalReasoning)} ({stats.pctReasoning}%)"
				></div>
			{/if}
		</div>
	</div>

	<!-- 4 Category Cards -->
	<div class="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
		<!-- Cached Input -->
		<div
			class="rounded-lg border p-3 shadow-2xs transition-all hover:shadow-xs"
			style="background: var(--token-cached-bg); border-color: var(--token-cached-border);"
		>
			<div
				class="flex items-center justify-between text-[11px] font-bold"
				style="color: var(--token-cached-text);"
			>
				<span class="inline-flex items-center gap-1.5">
					<span class="h-2.5 w-2.5 rounded-full" style="background: var(--token-cached);"></span>
					Cached Input
				</span>
				<span class="font-mono text-[10px]">{stats.pctCached}%</span>
			</div>
			<div class="mt-1 font-mono text-base font-extrabold text-(--ink)">
				{number(stats.totalCached)}
			</div>
			<p class="truncate text-[10px] font-medium text-(--muted)">Reused prompt context</p>
		</div>

		<!-- Fresh Input -->
		<div
			class="rounded-lg border p-3 shadow-2xs transition-all hover:shadow-xs"
			style="background: var(--token-input-bg); border-color: var(--token-input-border);"
		>
			<div
				class="flex items-center justify-between text-[11px] font-bold"
				style="color: var(--token-input-text);"
			>
				<span class="inline-flex items-center gap-1.5">
					<span class="h-2.5 w-2.5 rounded-full" style="background: var(--token-input);"></span>
					Fresh Input
				</span>
				<span class="font-mono text-[10px]">{stats.pctFresh}%</span>
			</div>
			<div class="mt-1 font-mono text-base font-extrabold text-(--ink)">
				{number(stats.freshInput)}
			</div>
			<p class="truncate text-[10px] font-medium text-(--muted)">New prompt & tool inputs</p>
		</div>

		<!-- Output Text -->
		<div
			class="rounded-lg border p-3 shadow-2xs transition-all hover:shadow-xs"
			style="background: var(--token-output-bg); border-color: var(--token-output-border);"
		>
			<div
				class="flex items-center justify-between text-[11px] font-bold"
				style="color: var(--token-output-text);"
			>
				<span class="inline-flex items-center gap-1.5">
					<span class="h-2.5 w-2.5 rounded-full" style="background: var(--token-output);"></span>
					Output Text
				</span>
				<span class="font-mono text-[10px]">{stats.pctOutput}%</span>
			</div>
			<div class="mt-1 font-mono text-base font-extrabold text-(--ink)">
				{number(stats.netOutput)}
			</div>
			<p class="truncate text-[10px] font-medium text-(--muted)">Model text & tool calls</p>
		</div>

		<!-- Reasoning -->
		<div
			class="rounded-lg border p-3 shadow-2xs transition-all hover:shadow-xs"
			style="background: var(--token-reasoning-bg); border-color: var(--token-reasoning-border);"
		>
			<div
				class="flex items-center justify-between text-[11px] font-bold"
				style="color: var(--token-reasoning-text);"
			>
				<span class="inline-flex items-center gap-1.5">
					<span class="h-2.5 w-2.5 rounded-full" style="background: var(--token-reasoning);"></span>
					Reasoning
				</span>
				<span class="font-mono text-[10px]">{stats.pctReasoning}%</span>
			</div>
			<div class="mt-1 font-mono text-base font-extrabold text-(--ink)">
				{number(stats.totalReasoning)}
			</div>
			<p class="truncate text-[10px] font-medium text-(--muted)">Internal thought tokens</p>
		</div>
	</div>

	<!-- Step-by-Step Execution Table -->
	{#if requests.length > 0}
		<div class="space-y-1.5">
			<div
				class="flex items-center justify-between text-[11px] font-bold tracking-wider text-(--muted) uppercase"
			>
				<span>Step-by-Step Breakdown</span>
				<span class="font-mono text-[10px] text-(--muted) lowercase">
					{requests.length} API call{requests.length === 1 ? '' : 's'}
				</span>
			</div>

			<div class="overflow-x-auto rounded-lg border border-(--line) bg-(--panel-subtle)">
				<table>
					<thead>
						<tr class="bg-(--field) text-[11px]">
							<th class="px-3 py-2 text-left font-bold text-(--ink)">Step</th>
							<th class="px-3 py-2 text-left font-bold text-(--muted)">Time</th>
							<th class="px-3 py-2 text-right font-bold text-(--muted)">Fresh Input</th>
							<th class="px-3 py-2 text-right font-bold text-(--muted)">Cached</th>
							<th class="px-3 py-2 text-right font-bold text-(--muted)">Output</th>
							<th class="px-3 py-2 text-right font-bold text-(--muted)">Reasoning</th>
							<th class="px-3 py-2 text-right font-bold text-(--ink)">Total</th>
							<th class="px-3 py-2 text-center font-bold text-(--muted)">Micro Map</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-(--line) bg-(--panel) font-mono text-xs">
						{#each requests as req, idx (req.id)}
							{@const step = getStepBreakdown(req)}
							<tr class="transition-colors hover:bg-(--panel-subtle)">
								<td class="px-3 py-2 font-bold text-(--ink)">
									Step {idx + 1}
								</td>
								<td class="px-3 py-2 text-[11px] text-(--muted)">
									{clock(req.timestamp)}
								</td>
								<td class="px-3 py-2 text-right font-semibold" style="color: var(--token-input-text);">
									{number(step.freshInput)}
								</td>
								<td class="px-3 py-2 text-right font-bold" style="color: var(--token-cached-text);">
									{number(step.cached)}
								</td>
								<td class="px-3 py-2 text-right font-semibold" style="color: var(--token-output-text);">
									{number(step.netOutput)}
								</td>
								<td class="px-3 py-2 text-right font-semibold" style="color: var(--token-reasoning-text);">
									{number(step.reasoning)}
								</td>
								<td class="px-3 py-2 text-right font-black text-(--ink)">
									{number(step.stepTotal)}
								</td>
								<td class="px-3 py-2">
									<div class="mx-auto flex h-2.5 w-16 overflow-hidden rounded-full bg-(--field) shadow-inner">
										{#if step.pctCached > 0}
											<div class="h-full" style="width: {step.pctCached}%; background: var(--token-cached);"></div>
										{/if}
										{#if step.pctFresh > 0}
											<div class="h-full" style="width: {step.pctFresh}%; background: var(--token-input);"></div>
										{/if}
										{#if step.pctOutput > 0}
											<div class="h-full" style="width: {step.pctOutput}%; background: var(--token-output);"></div>
										{/if}
										{#if step.pctReasoning > 0}
											<div class="h-full" style="width: {step.pctReasoning}%; background: var(--token-reasoning);"></div>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
