<script lang="ts">
	import { Upload, FileJson } from '@lucide/svelte';

	let fileInput = $state<HTMLInputElement>();
	let isDragging = $state(false);

	async function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		await processFile(file);
		input.value = '';
	}

	async function processFile(file: File) {
		const text = await file.text();
		try {
			const res = await fetch('/api/session/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: text
			});
			if (res.ok) {
				const result = (await res.json()) as { id: string };
				const { invalidateAll } = await import('$app/navigation');
				await invalidateAll();
				window.location.href = `/session/${result.id}`;
			}
		} catch {
			// silent catch
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		isDragging = true;
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		const file = e.dataTransfer?.files?.[0];
		if (file) {
			await processFile(file);
		}
	}
</script>

<svelte:head>
	<title>Import Session — Agent Session Inspect</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-extrabold tracking-tight text-(--ink)">
			Import Session
		</h1>
		<p class="text-xs text-(--muted) mt-1">
			Drop or select an exported JSON file to load session telemetry into memory.
		</p>
	</div>

	<!-- Simple Clean Drag & Drop Target -->
	<div
		class="relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-16 text-center transition-all {isDragging
			? 'scale-[0.99] border-indigo-500 bg-indigo-500/10'
			: 'border-(--line) bg-(--panel) hover:border-indigo-500/50 hover:bg-(--panel-subtle)/30'}"
		ondragover={handleDragOver}
		ondragleave={handleDragLeave}
		ondrop={handleDrop}
		onclick={() => fileInput?.click()}
		onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput?.click()}
		role="button"
		tabindex="0"
	>
		<input
			type="file"
			accept=".json,application/json"
			class="hidden"
			bind:this={fileInput}
			onchange={handleFileSelect}
		/>

		<div
			class="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-indigo-500/20 bg-indigo-500/10 text-indigo-500 shadow-md"
		>
			<FileJson class="h-8 w-8" />
		</div>

		<h2 class="text-lg font-bold text-(--ink)">Drop Agent Session JSON Here</h2>
		<p class="mt-1 max-w-sm text-xs text-(--muted)">
			Select JSON file to import session data instantly into active memory workspace.
		</p>

		<button
			type="button"
			class="mt-6 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white shadow-md hover:bg-indigo-500 transition-colors"
		>
			<Upload class="h-4 w-4" />
			<span>Browse File</span>
		</button>
	</div>
</div>
