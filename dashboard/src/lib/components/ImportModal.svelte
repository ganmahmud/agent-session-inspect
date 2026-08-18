<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { Upload, X, CircleCheck, CircleAlert, ArrowRight, FileJson } from '@lucide/svelte';

	let {
		isOpen = $bindable(false),
		onImportSuccess
	}: {
		isOpen: boolean;
		onImportSuccess?: (sessionId: string) => void;
	} = $props();

	let rawJsonInput = $state('');
	let isDragging = $state(false);
	let importLoading = $state(false);
	let errorMessage = $state<string | null>(null);
	let parsedPreview = $state<{
		type: 'session' | 'message';
		title: string;
		recordCount?: number;
		role?: string;
	} | null>(null);

	let fileInput = $state<HTMLInputElement>();

	function close() {
		isOpen = false;
		errorMessage = null;
		parsedPreview = null;
		rawJsonInput = '';
	}

	function validateAndPreviewJson(jsonText: string) {
		errorMessage = null;
		parsedPreview = null;
		if (!jsonText.trim()) return;

		try {
			const parsed = JSON.parse(jsonText);
			if (!parsed || typeof parsed !== 'object') {
				errorMessage = 'Invalid JSON structure. Expected an object envelope.';
				return;
			}

			if (parsed.exportVersion !== 1) {
				errorMessage = 'Unsupported export format. Expected exportVersion: 1.';
				return;
			}

			if (parsed.session && parsed.session.id) {
				const s = parsed.session;
				parsedPreview = {
					type: 'session',
					title: s.displayTitle?.value ?? s.id,
					recordCount: s.conversation?.length ?? s.recordCount ?? 0
				};
			} else if (parsed.message && parsed.message.id) {
				const m = parsed.message;
				parsedPreview = {
					type: 'message',
					title: parsed.sessionTitle
						? `[${m.role}] ${parsed.sessionTitle}`
						: `[${m.role} snippet] ${m.text?.slice(0, 50)}...`,
					recordCount: 1,
					role: m.role
				};
			} else {
				errorMessage = 'JSON object does not contain a valid "session" or "message" payload.';
			}
		} catch {
			errorMessage = 'Malformed JSON text. Syntax error parsing input.';
		}
	}

	async function submitImport(jsonText: string) {
		errorMessage = null;
		importLoading = true;

		try {
			const res = await fetch('/api/session/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: jsonText
			});

			if (!res.ok) {
				const err = await res.json().catch(() => null);
				errorMessage = err?.message ?? `Import endpoint returned error status ${res.status}`;
				return;
			}

			const result = (await res.json()) as { id: string; title: string };
			const { invalidateAll } = await import('$app/navigation');
			await invalidateAll();
			close();
			if (onImportSuccess) {
				onImportSuccess(result.id);
			} else {
				window.location.href = `/session/${result.id}`;
			}
		} catch {
			errorMessage = 'Network connection failed during import submission.';
		} finally {
			importLoading = false;
		}
	}

	async function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const text = await file.text();
		validateAndPreviewJson(text);
		if (!errorMessage && text) {
			await submitImport(text);
		}
		input.value = '';
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
		if (!file) return;
		const text = await file.text();
		validateAndPreviewJson(text);
		if (!errorMessage && text) {
			await submitImport(text);
		}
	}

	function handleRawInput() {
		validateAndPreviewJson(rawJsonInput);
	}
</script>

{#if isOpen}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
		transition:fade={{ duration: 150 }}
		onclick={close}
		onkeydown={(e) => e.key === 'Escape' && close()}
		role="presentation"
	>
		<!-- Modal Dialog Box -->
		<div
			class="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-(--line) bg-(--panel) shadow-2xl transition-all"
			transition:scale={{ start: 0.95, duration: 150 }}
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="modal-title"
		>
			<!-- Header -->
			<div
				class="flex items-center justify-between border-b border-(--line) bg-(--panel-subtle) px-6 py-4"
			>
				<div class="flex items-center gap-3">
					<div
						class="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-500/10 text-indigo-500"
					>
						<Upload class="h-5 w-5" />
					</div>
					<div>
						<h2 id="modal-title" class="text-base font-bold text-(--ink)">Import Session JSON</h2>
						<p class="text-xs text-(--muted)">Drop session file or paste raw telemetry JSON</p>
					</div>
				</div>
				<button
					type="button"
					class="rounded-lg p-1.5 text-(--muted) transition-colors hover:bg-(--panel-subtle) hover:text-(--ink)"
					onclick={close}
				>
					<X class="h-5 w-5" />
				</button>
			</div>

			<!-- Tab Content Body -->
			<div class="space-y-6 p-6">
				<!-- File Upload Dropzone -->
				<div
					class="relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-all {isDragging
						? 'scale-[0.99] border-indigo-500 bg-indigo-500/10'
						: 'border-(--line) hover:border-indigo-500/50 hover:bg-(--panel-subtle)/40'}"
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
						class="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-indigo-500/20 bg-indigo-500/10 text-indigo-500 shadow-sm"
					>
						<FileJson class="h-7 w-7" />
					</div>
					<h3 class="text-sm font-bold text-(--ink)">Drag and drop session JSON file here</h3>
					<p class="mt-1 text-xs text-(--muted)">
						Supports full session exports or single message envelopes
					</p>

					<button
						type="button"
						class="mt-4 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-md transition-colors hover:bg-indigo-500"
					>
						<Upload class="h-4 w-4" />
						<span>Browse File</span>
					</button>
				</div>

				<!-- Raw JSON Textarea -->
				<div class="space-y-2.5">
					<label
						for="raw-json-input"
						class="block text-xs font-bold tracking-wider text-(--muted) uppercase"
					>
						Or Paste Raw JSON Code
					</label>
					<textarea
						id="raw-json-input"
						bind:value={rawJsonInput}
						oninput={handleRawInput}
						placeholder="Paste valid JSON envelope containing exportVersion: 1..."
						rows="5"
						class="w-full rounded-xl border border-(--line) bg-(--field) p-3 font-mono text-xs text-(--ink) placeholder:text-(--muted) focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
					></textarea>

					{#if parsedPreview}
						<div
							class="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-400"
						>
							<div class="flex items-center gap-2">
								<CircleCheck class="h-4 w-4 shrink-0" />
								<span class="truncate font-semibold">Ready: {parsedPreview.title}</span>
							</div>
							<span
								class="rounded bg-emerald-500/20 px-2 py-0.5 font-mono text-[10px] font-bold uppercase"
							>
								{parsedPreview.type}
							</span>
						</div>
					{/if}

					<div class="flex justify-end pt-1">
						<button
							type="button"
							class="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2 text-xs font-semibold text-white shadow-md transition-colors hover:bg-indigo-500 disabled:opacity-50"
							disabled={!rawJsonInput.trim() || importLoading || !!errorMessage}
							onclick={() => submitImport(rawJsonInput)}
						>
							{#if importLoading}
								<span
									class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
								></span>
								<span>Processing...</span>
							{:else}
								<ArrowRight class="h-4 w-4" />
								<span>Import JSON</span>
							{/if}
						</button>
					</div>
				</div>

				{#if errorMessage}
					<div
						class="flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400"
					>
						<CircleAlert class="mt-0.5 h-4 w-4 shrink-0" />
						<div class="flex-1">
							<p class="font-semibold">Validation Error</p>
							<p class="mt-0.5 text-[11px] opacity-90">{errorMessage}</p>
						</div>
					</div>
				{/if}
			</div>

			<!-- Footer Info -->
			<div
				class="flex items-center justify-between border-t border-(--line) bg-(--panel-subtle)/40 px-6 py-3 text-[11px] text-(--muted)"
			>
				<span>In-memory active session import.</span>
				<button type="button" class="font-medium hover:text-(--ink)" onclick={close}>Cancel</button>
			</div>
		</div>
	</div>
{/if}
