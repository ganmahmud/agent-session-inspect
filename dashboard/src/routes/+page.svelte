<script lang="ts">
	import { MessageSquare } from '@lucide/svelte';
</script>

<svelte:head><title>Agent Session Inspect — AI Session Debugger</title></svelte:head>

<div class="rounded-xl border border-(--line) bg-(--panel) p-16 text-center text-xs text-(--muted)">
	<MessageSquare class="mx-auto mb-3 h-10 w-10 opacity-40 text-(--muted)" />
	<p class="text-sm font-semibold text-(--ink)">No sessions found</p>
	<p class="mt-1">No Codex agent sessions were discovered in the workspace directory.</p>
</div>
