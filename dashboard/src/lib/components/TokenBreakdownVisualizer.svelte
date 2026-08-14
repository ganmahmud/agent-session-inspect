<script lang="ts">
	import {
		CircleCheck,
		Server,
		Terminal,
		Cpu,
		FileText,
		User,
		Sparkles,
		Zap,
		ChevronDown,
		ChevronRight
	} from '@lucide/svelte';
	import type { ReplyActivity, ToolCallDetail } from '../../../../src/types';

	let {
		activity,
		highlighted = false
	}: {
		activity: ReplyActivity;
		highlighted?: boolean;
	} = $props();

	// Collapsible section states — collapsed initially
	let expandedGroups = $state<Record<string, boolean>>({
		user: false,
		mcp: false,
		exec: false,
		steps: false
	});

	let expandedToolIds = $state<Record<string, boolean>>({});

	function toggleGroup(group: string) {
		expandedGroups[group] = !expandedGroups[group];
	}

	function toggleToolDetails(id: string) {
		expandedToolIds[id] = !expandedToolIds[id];
	}

	const number = (val?: number) =>
		val === undefined ? '0' : new Intl.NumberFormat('en-US').format(val);

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

	let toolPayloads = $derived.by(() => {
		const tools = activity.tools ?? [];
		const mcpTools: Array<{ tool: ToolCallDetail; tokens: number; chars: number }> = [];
		const execTools: Array<{ tool: ToolCallDetail; tokens: number; chars: number }> = [];

		let mcpEstTokens = 0;
		let execEstTokens = 0;

		for (const t of tools) {
			const isMcp = t.kind === 'mcp' || t.name.startsWith('mcp') || t.name.includes('mcp_');
			const charCount = (t.input?.length ?? 0) + (t.output?.length ?? 0);
			const estTokens = Math.round(charCount / 3.8);

			if (isMcp) {
				mcpTools.push({ tool: t, tokens: estTokens, chars: charCount });
				mcpEstTokens += estTokens;
			} else {
				execTools.push({ tool: t, tokens: estTokens, chars: charCount });
				execEstTokens += estTokens;
			}
		}

		const totalToolEstTokens = mcpEstTokens + execEstTokens;
		const systemPromptEstTokens = Math.max(0, stats.freshInput - totalToolEstTokens);

		return {
			tools,
			mcpTools,
			execTools,
			mcpEstTokens,
			execEstTokens,
			totalToolEstTokens,
			systemPromptEstTokens
		};
	});
</script>

<div
	class="token-breakdown-box space-y-4 rounded-xl border p-4 shadow-xs transition-all duration-300 {highlighted
		? 'border-(--accent) bg-(--panel-subtle) ring-2 ring-(--accent)/30'
		: 'border-(--line) bg-(--panel)'}"
	id="token-breakdown-{activity.association || 'box'}"
>
	<!-- Top Title & Total -->
	<div class="flex flex-wrap items-center justify-between gap-2 border-b border-(--line) pb-3">
		<div class="flex items-center gap-2.5">
			<div
				class="flex h-8 w-8 items-center justify-center rounded-lg border border-(--line) bg-amber-500/10 text-amber-500 shadow-xs"
			>
				<Zap class="h-4 w-4" />
			</div>
			<div>
				<h4 class="text-xs font-extrabold tracking-wider text-(--ink) uppercase">
					Why Were Tokens Spent?
				</h4>
				<p class="text-[11px] font-medium text-(--muted)">
					Simple breakdown of User vs Codex side token consumption for this turn
				</p>
			</div>
		</div>

		<div class="flex items-center gap-2 font-mono">
			{#if stats.totalCached > 0}
				<span
					class="inline-flex items-center gap-1 rounded-full border border-teal-500/30 bg-teal-500/10 px-2.5 py-0.5 text-[10px] font-bold text-teal-700 dark:text-teal-300"
				>
					<CircleCheck class="h-3 w-3 text-teal-500" />
					<span>{stats.cacheHitRatio}% Cache Hit</span>
				</span>
			{/if}

			<div
				class="rounded-lg border border-(--line) bg-(--panel-subtle) px-3 py-1 text-right shadow-2xs"
			>
				<span class="block text-[9px] font-bold tracking-wider text-(--muted) uppercase"
					>Turn Total</span
				>
				<b class="text-sm font-black text-(--ink)">{number(stats.grandTotal)} tokens</b>
			</div>
		</div>
	</div>

	<!-- Turn Activity Summary Cards -->
	<div class="space-y-2.5 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3.5 text-xs">
		<div class="flex items-center justify-between border-b border-indigo-500/15 pb-2">
			<span
				class="flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400"
			>
				<Sparkles class="h-3.5 w-3.5" />
				What Happened In This Turn
			</span>
			<span
				class="rounded border border-(--line) bg-(--panel) px-2 py-0.5 font-mono text-[10px] text-(--muted)"
			>
				{requests.length} API step{requests.length === 1 ? '' : 's'}
			</span>
		</div>

		<!-- Scannable Activity Grid -->
		<div class="grid gap-2 text-xs font-medium text-(--ink) sm:grid-cols-2">
			<div
				class="flex items-start gap-2 rounded-lg border border-(--line)/60 bg-(--panel)/70 p-2.5"
			>
				<span class="shrink-0 rounded bg-indigo-500/15 p-1 text-indigo-600 dark:text-indigo-300">
					<Terminal class="h-3.5 w-3.5" />
				</span>
				<div class="min-w-0">
					<b class="block text-[10px] font-bold tracking-wider text-(--muted) uppercase"
						>Tools Invoked</b
					>
					<span class="block truncate">
						{#if (activity.tools?.length ?? 0) > 0}
							{activity.tools.length} call{activity.tools.length === 1 ? '' : 's'} ({toolPayloads
								.mcpTools.length} MCP, {toolPayloads.execTools.length} local)
						{:else}
							Direct response (no tool calls)
						{/if}
					</span>
				</div>
			</div>

			{#if stats.totalReasoning > 0}
				<div
					class="flex items-start gap-2 rounded-lg border border-(--line)/60 bg-(--panel)/70 p-2.5"
				>
					<span class="shrink-0 rounded bg-purple-500/15 p-1 text-purple-600 dark:text-purple-300">
						<Cpu class="h-3.5 w-3.5" />
					</span>
					<div>
						<b class="block text-[10px] font-bold tracking-wider text-(--muted) uppercase"
							>Internal Thinking</b
						>
						<span>{number(stats.totalReasoning)} reasoning tokens</span>
					</div>
				</div>
			{/if}

			{#if stats.totalCached > 0}
				<div
					class="flex items-start gap-2 rounded-lg border border-(--line)/60 bg-(--panel)/70 p-2.5"
				>
					<span class="shrink-0 rounded bg-teal-500/15 p-1 text-teal-600 dark:text-teal-300">
						<CircleCheck class="h-3.5 w-3.5" />
					</span>
					<div>
						<b class="block text-[10px] font-bold tracking-wider text-(--muted) uppercase"
							>Context Cache</b
						>
						<span>Reused {number(stats.totalCached)} tokens ({stats.cacheHitRatio}% hit)</span>
					</div>
				</div>
			{/if}

			<div
				class="flex items-start gap-2 rounded-lg border border-(--line)/60 bg-(--panel)/70 p-2.5"
			>
				<span class="shrink-0 rounded bg-blue-500/15 p-1 text-blue-600 dark:text-blue-300">
					<FileText class="h-3.5 w-3.5" />
				</span>
				<div>
					<b class="block text-[10px] font-bold tracking-wider text-(--muted) uppercase"
						>Output Written</b
					>
					<span>Generated {number(stats.netOutput)} tokens text output</span>
				</div>
			</div>
		</div>
	</div>

	<!-- Simple Side-by-Side: User Side vs Codex Side -->
	<div class="grid gap-3 sm:grid-cols-2">
		<!-- User Side Card (Prompt, Context, Cache) -->
		<div class="space-y-2 rounded-xl border border-blue-500/25 bg-blue-500/5 p-3.5 text-xs">
			<div class="flex items-center justify-between border-b border-blue-500/20 pb-2">
				<span class="flex items-center gap-1.5 font-bold text-blue-700 dark:text-blue-300">
					<User class="h-4 w-4 text-blue-500" />
					User Side (Prompt & Context)
				</span>
				<b class="font-mono text-xs text-(--ink)"
					>~{number(stats.freshInput + stats.totalCached)} tokens</b
				>
			</div>

			<div class="space-y-1.5 font-mono text-[11px]">
				<div class="flex items-center justify-between text-(--muted)">
					<span>• System Instructions & Setup:</span>
					<b class="text-(--ink)">~{number(toolPayloads.systemPromptEstTokens)} tokens</b>
				</div>
				<div class="flex items-center justify-between text-(--muted)">
					<span>• Conversation Context (Cached):</span>
					<b class="text-teal-600 dark:text-teal-300">{number(stats.totalCached)} tokens</b>
				</div>
				<div class="flex items-center justify-between text-(--muted)">
					<span>• Fresh Prompt Input:</span>
					<b class="text-blue-600 dark:text-blue-300">{number(stats.freshInput)} tokens</b>
				</div>
			</div>
		</div>

		<!-- Codex Side Card (Tools, Reasoning, Response) -->
		<div class="space-y-2 rounded-xl border border-purple-500/25 bg-purple-500/5 p-3.5 text-xs">
			<div class="flex items-center justify-between border-b border-purple-500/20 pb-2">
				<span class="flex items-center gap-1.5 font-bold text-purple-700 dark:text-purple-300">
					<Sparkles class="h-4 w-4 text-purple-500" />
					Codex Side (Work & Response)
				</span>
				<b class="font-mono text-xs text-(--ink)"
					>~{number(stats.totalOutput + toolPayloads.totalToolEstTokens)} tokens</b
				>
			</div>

			<div class="space-y-1.5 font-mono text-[11px]">
				<div class="flex items-center justify-between text-(--muted)">
					<span>• MCP Server Tools ({toolPayloads.mcpTools.length}):</span>
					<b class="text-emerald-600 dark:text-emerald-300"
						>~{number(toolPayloads.mcpEstTokens)} tokens</b
					>
				</div>
				<div class="flex items-center justify-between text-(--muted)">
					<span>• Local Tools & Shell ({toolPayloads.execTools.length}):</span>
					<b class="text-blue-600 dark:text-blue-300"
						>~{number(toolPayloads.execEstTokens)} tokens</b
					>
				</div>
				<div class="flex items-center justify-between text-(--muted)">
					<span>• Internal Reasoning / CoT:</span>
					<b class="text-purple-600 dark:text-purple-300">{number(stats.totalReasoning)} tokens</b>
				</div>
				<div class="flex items-center justify-between text-(--muted)">
					<span>• Written Response Text:</span>
					<b class="text-(--ink)">{number(stats.netOutput)} tokens</b>
				</div>
			</div>
		</div>
	</div>

	<!-- Stacked Composition Bar -->
	<div class="space-y-1">
		<div class="flex items-center justify-between text-[11px] font-bold text-(--muted)">
			<span class="tracking-wider uppercase">Turn Token Composition</span>
			<span class="font-mono text-[10px]">100% = {number(stats.grandTotal)} tokens</span>
		</div>

		<div
			class="relative flex h-3 w-full overflow-hidden rounded-full border border-(--line) bg-(--field) p-0.5 shadow-inner"
		>
			{#if stats.pctCached > 0}
				<div
					class="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full"
					style="width: {stats.pctCached}%; background: var(--token-cached);"
					title="Reused Context: {number(stats.totalCached)} ({stats.pctCached}%)"
				></div>
			{/if}
			{#if stats.pctFresh > 0}
				<div
					class="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full"
					style="width: {stats.pctFresh}%; background: var(--token-input);"
					title="Fresh Input: {number(stats.freshInput)} ({stats.pctFresh}%)"
				></div>
			{/if}
			{#if stats.pctOutput > 0}
				<div
					class="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full"
					style="width: {stats.pctOutput}%; background: var(--token-output);"
					title="Output Generation: {number(stats.netOutput)} ({stats.pctOutput}%)"
				></div>
			{/if}
			{#if stats.pctReasoning > 0}
				<div
					class="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full"
					style="width: {stats.pctReasoning}%; background: var(--token-reasoning);"
					title="Reasoning: {number(stats.totalReasoning)} ({stats.pctReasoning}%)"
				></div>
			{/if}
		</div>
	</div>

	<!-- Collapsible Tool Inspection Accordions (Collapsed Initially) -->
	{#if toolPayloads.mcpTools.length > 0}
		<div class="border-t border-(--line) pt-2">
			<button
				type="button"
				class="flex w-full cursor-pointer items-center justify-between py-1 text-xs font-bold text-emerald-600 dark:text-emerald-400"
				onclick={() => toggleGroup('mcp')}
			>
				<div class="flex items-center gap-2">
					<Server class="h-4 w-4" />
					<span
						>Inspect MCP Tool Calls ({toolPayloads.mcpTools.length} call{toolPayloads.mcpTools
							.length === 1
							? ''
							: 's'})</span
					>
				</div>
				<div class="flex items-center gap-1.5 font-mono text-[11px]">
					<span>~{number(toolPayloads.mcpEstTokens)} tokens</span>
					<ChevronDown
						class="h-4 w-4 transition-transform duration-200 {expandedGroups.mcp
							? 'rotate-180'
							: ''}"
					/>
				</div>
			</button>

			{#if expandedGroups.mcp}
				<div class="mt-2 space-y-2">
					{#each toolPayloads.mcpTools as item (item.tool.id)}
						<div
							class="space-y-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs"
						>
							<button
								type="button"
								class="flex w-full cursor-pointer items-center justify-between text-left"
								onclick={() => toggleToolDetails(item.tool.id)}
							>
								<div class="flex min-w-0 items-center gap-2">
									<span
										class="rounded bg-emerald-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-700 dark:text-emerald-300"
									>
										MCP
									</span>
									<b class="truncate font-mono text-xs font-extrabold text-(--ink)"
										>{item.tool.name}</b
									>
									{#if item.tool.durationMs}
										<span class="font-mono text-[11px] text-(--muted)"
											>({item.tool.durationMs}ms)</span
										>
									{/if}
								</div>

								<div class="flex shrink-0 items-center gap-2 font-mono text-xs">
									<span class="font-bold text-(--ink)">~{number(item.tokens)} tokens</span>
									{#if expandedToolIds[item.tool.id]}
										<ChevronDown class="h-4 w-4 text-(--muted)" />
									{:else}
										<ChevronRight class="h-4 w-4 text-(--muted)" />
									{/if}
								</div>
							</button>

							{#if expandedToolIds[item.tool.id]}
								<div class="space-y-2 border-t border-emerald-500/20 pt-2 font-mono text-[11px]">
									{#if item.tool.input}
										<div>
											<span
												class="block text-[10px] font-bold tracking-wider text-(--muted) uppercase"
												>Input Sent To MCP:</span
											>
											<pre
												class="mt-1 overflow-x-auto rounded border border-(--line) bg-(--panel) p-2 text-xs text-(--ink)">{item
													.tool.input}</pre>
										</div>
									{/if}
									{#if item.tool.output}
										<div>
											<span
												class="block text-[10px] font-bold tracking-wider text-(--muted) uppercase"
												>Output Returned From MCP:</span
											>
											<pre
												class="mt-1 max-h-40 overflow-y-auto rounded border border-(--line) bg-(--panel) p-2 text-xs text-(--ink)">{item
													.tool.output}</pre>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if toolPayloads.execTools.length > 0}
		<div class="border-t border-(--line) pt-2">
			<button
				type="button"
				class="flex w-full cursor-pointer items-center justify-between py-1 text-xs font-bold text-blue-600 dark:text-blue-400"
				onclick={() => toggleGroup('exec')}
			>
				<div class="flex items-center gap-2">
					<Terminal class="h-4 w-4" />
					<span
						>Inspect Local Tools ({toolPayloads.execTools.length} call{toolPayloads.execTools
							.length === 1
							? ''
							: 's'})</span
					>
				</div>
				<div class="flex items-center gap-1.5 font-mono text-[11px]">
					<span>~{number(toolPayloads.execEstTokens)} tokens</span>
					<ChevronDown
						class="h-4 w-4 transition-transform duration-200 {expandedGroups.exec
							? 'rotate-180'
							: ''}"
					/>
				</div>
			</button>

			{#if expandedGroups.exec}
				<div class="mt-2 space-y-2">
					{#each toolPayloads.execTools as item (item.tool.id)}
						<div class="space-y-2 rounded-xl border border-blue-500/25 bg-blue-500/5 p-3 text-xs">
							<button
								type="button"
								class="flex w-full cursor-pointer items-center justify-between text-left"
								onclick={() => toggleToolDetails(item.tool.id)}
							>
								<div class="flex min-w-0 items-center gap-2">
									<span
										class="rounded bg-blue-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-blue-700 dark:text-blue-300"
									>
										Local Tool
									</span>
									<b class="truncate font-mono text-xs font-extrabold text-(--ink)"
										>{item.tool.name}</b
									>
									{#if item.tool.durationMs}
										<span class="font-mono text-[11px] text-(--muted)"
											>({item.tool.durationMs}ms)</span
										>
									{/if}
								</div>

								<div class="flex shrink-0 items-center gap-2 font-mono text-xs">
									<span class="font-bold text-(--ink)">~{number(item.tokens)} tokens</span>
									{#if expandedToolIds[item.tool.id]}
										<ChevronDown class="h-4 w-4 text-(--muted)" />
									{:else}
										<ChevronRight class="h-4 w-4 text-(--muted)" />
									{/if}
								</div>
							</button>

							{#if expandedToolIds[item.tool.id]}
								<div class="space-y-2 border-t border-blue-500/20 pt-2 font-mono text-[11px]">
									{#if item.tool.input}
										<div>
											<span
												class="block text-[10px] font-bold tracking-wider text-(--muted) uppercase"
												>Input Arguments:</span
											>
											<pre
												class="mt-1 overflow-x-auto rounded border border-(--line) bg-(--panel) p-2 text-xs text-(--ink)">{item
													.tool.input}</pre>
										</div>
									{/if}
									{#if item.tool.output}
										<div>
											<span
												class="block text-[10px] font-bold tracking-wider text-(--muted) uppercase"
												>Terminal / Output Returned:</span
											>
											<pre
												class="mt-1 max-h-40 overflow-y-auto rounded border border-(--line) bg-(--panel) p-2 text-xs text-(--ink)">{item
													.tool.output}</pre>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
