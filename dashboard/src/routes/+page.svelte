<script lang="ts">
	import { Upload, Sparkles } from '@lucide/svelte';
	import { resolveRoute } from '$app/paths';
</script>

<svelte:head><title>Agent Session Inspect — AI Session Debugger</title></svelte:head>

<div class="flex flex-col items-center justify-center rounded-2xl border border-(--line) bg-(--panel) p-16 text-center shadow-sm">
	<div class="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 shadow-md">
		<Upload class="h-8 w-8" />
	</div>
	<h2 class="text-lg font-bold text-(--ink)">No local sessions discovered</h2>
	<p class="mt-1 max-w-md text-xs text-(--muted)">
		No Codex agent sessions were found in your local workspace directory. You can import offline session logs or single message snippets right now.
	</p>

	<div class="mt-6 flex flex-wrap items-center justify-center gap-3">
		<a
			href={resolveRoute('/import')}
			class="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 transition-all hover:scale-105 no-underline"
		>
			<Sparkles class="h-4 w-4" />
			<span>Open Import Hub</span>
		</a>
	</div>
</div>

