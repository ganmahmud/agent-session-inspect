<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount, type Snippet } from 'svelte';
	import { page, navigating } from '$app/stores';
	import { resolveRoute } from '$app/paths';
	import SessionSkeleton from '$lib/components/SessionSkeleton.svelte';
	import {
		Activity,
		Layers,
		Sun,
		Moon,
		Search,
		X,
		Clock,
		Zap,
		MessageSquare,
		Upload,
		AlertCircle
	} from '@lucide/svelte';
	import type { SessionInventory } from '../../../src/types.ts';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	let query = $state('');
	let theme = $state<'light' | 'dark'>('dark');
	let sessionFilter = $state<'all' | 'recent' | 'heavy' | 'imported'>('all');
	let importLoading = $state(false);
	let importError = $state<string | null>(null);
	let fileInput: HTMLInputElement;

	// Track which sessions were imported
	const importedIds = $derived(new Set(data.importedSessionIds ?? []));

	const title = (session?: SessionInventory | { displayTitle?: { value?: string } }) =>
		session?.displayTitle?.value ?? 'Untitled Codex session';
	const date = (value?: string) => value?.slice(0, 10) ?? 'Unknown date';
	const number = (value?: number) =>
		value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value);
	const latestTokens = (session: SessionInventory) =>
		session.token?.last?.totalTokens ?? session.token?.total?.totalTokens;

	// Filter and sort session list
	const regularSessions = () => {
		if (sessionFilter === 'imported') return [];
		let list = data.inventory.sessions.filter(
			(session) =>
				!importedIds.has(session.id) &&
				`${title(session)} ${session.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
		);
		if (sessionFilter === 'recent') {
			list = [...list].sort(
				(a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime()
			);
		} else if (sessionFilter === 'heavy') {
			list = [...list].sort((a, b) => (latestTokens(b) ?? 0) - (latestTokens(a) ?? 0));
		}
		return list;
	};

	const importedSessionsList = () => {
		return data.inventory.sessions.filter(
			(session) =>
				importedIds.has(session.id) &&
				`${title(session)} ${session.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
		);
	};

	function setTheme(next: 'light' | 'dark') {
		theme = next;
		document.documentElement.dataset.theme = next;
		localStorage.setItem('agent-session-inspect-theme', next);
	}

	onMount(() => {
		const stored = localStorage.getItem('agent-session-inspect-theme');
		setTheme(stored === 'light' ? 'light' : 'dark');
	});

	let isDragging = $state(false);

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer?.types?.includes('Files')) {
			isDragging = true;
		}
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		// Only hide overlay when leaving window/outer container
		if (!e.relatedTarget || (e.relatedTarget as HTMLElement).tagName === 'HTML') {
			isDragging = false;
		}
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		const file = e.dataTransfer?.files?.[0];
		if (file) {
			await processImportFile(file);
		}
	}

	async function processImportFile(file: File) {
		importError = null;
		importLoading = true;

		try {
			const text = await file.text();
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				importError = 'Invalid JSON file. Expected a session export.';
				return;
			}

			const envelope = parsed as { exportVersion?: number };
			if (!envelope || envelope.exportVersion !== 1) {
				importError = 'Unrecognized format. Expected exportVersion: 1.';
				return;
			}

			const res = await fetch('/api/session/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: text
			});

			if (!res.ok) {
				const errBody = await res.json().catch(() => null);
				importError = errBody?.message ?? `Import failed (${res.status})`;
				return;
			}

			const result = (await res.json()) as { id: string; title: string };
			const { invalidateAll } = await import('$app/navigation');
			await invalidateAll();
			window.location.href = `/session/${result.id}`;
		} catch {
			importError = 'Failed to import session. Check file format.';
		} finally {
			importLoading = false;
		}
	}

	async function deleteImported(id: string, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		try {
			const res = await fetch(`/api/session/${id}`, { method: 'DELETE' });
			if (res.ok) {
				const { invalidateAll } = await import('$app/navigation');
				await invalidateAll();
				if (window.location.pathname.includes(id)) {
					window.location.href = '/';
				}
			}
		} catch {
			// silent catch
		}
	}

	async function handleImportFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		await processImportFile(file);
		input.value = '';
	}
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div
	class="relative min-h-screen bg-(--canvas) text-(--ink)"
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
	role="region"
	aria-label="Workspace Dropzone"
>
	{#if isDragging}
		<div
			class="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-indigo-950/80 p-6 text-white backdrop-blur-md transition-all animate-in fade-in duration-200"
		>
			<div class="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-600/30 border border-indigo-400/50 shadow-2xl">
				<Upload class="h-8 w-8 animate-bounce text-indigo-200" />
			</div>
			<h2 class="text-xl font-bold tracking-tight">Drop JSON file here to import</h2>
			<p class="text-xs text-indigo-200/80 font-medium">Supports full session exports or single message snippets</p>
		</div>
	{/if}
	<!-- Top Navigation Header Aligned to Workspace Grid -->
	<header class="sticky top-0 z-30 border-b border-(--line) bg-(--panel) backdrop-blur-md">
		<div class="mx-auto grid max-w-[1540px] grid-cols-1 lg:grid-cols-[310px_minmax(0,1fr)]">
			<!-- Header Left: App Branding (matches sidebar width & right border) -->
			<div
				class="flex items-center gap-3 border-b border-(--line) bg-(--panel) px-4 py-3 lg:border-r lg:border-b-0 lg:border-(--line)"
			>
				<div
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-indigo-500 via-blue-600 to-sky-500 text-white shadow-sm"
				>
					<Activity class="h-4.5 w-4.5 stroke-[2.5]" />
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<a
							href={resolveRoute('/')}
							class="truncate text-xs font-bold tracking-tight text-inherit no-underline hover:underline sm:text-sm"
						>
							Agent Session Inspect
						</a>
						<span
							class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-(--success-soft) px-2 py-0.5 text-[10px] font-semibold text-(--success)"
						>
							<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-(--success)"></span>
							Local
						</span>
					</div>
					<p class="truncate text-[10px] text-(--muted)">Session inspector & audit log</p>
				</div>
			</div>

			<!-- Header Right: Context Stats & Theme Switcher (matches main pane padding) -->
			<div
				class="flex items-center justify-between gap-4 bg-(--panel) px-4 py-2.5 sm:px-7 lg:px-10"
			>
				<div class="flex items-center gap-3">
					<span class="hidden text-xs font-semibold text-(--muted) sm:inline"
						>Workspace Inspector</span
					>
					{#if $page.data.detail}
						<span class="hidden text-(--line) sm:inline">|</span>
						<span
							class="max-w-75 truncate font-mono text-xs font-medium text-(--ink)"
							title={title($page.data.detail)}
						>
							{title($page.data.detail)}
						</span>
					{/if}
				</div>

				<div class="flex items-center gap-3">
					<button
						type="button"
						class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-(--line) bg-(--panel-subtle) px-3 py-1 text-xs font-semibold text-(--ink) transition-colors hover:border-(--accent) hover:bg-(--panel)"
						onclick={() => fileInput?.click()}
						title="Import full session or single message JSON"
					>
						<Upload class="h-3.5 w-3.5 text-(--accent)" />
						<span>Import</span>
					</button>

					<div
						class="hidden items-center gap-1.5 rounded-lg border border-(--line) bg-(--panel-subtle) px-2.5 py-1 text-xs font-medium text-(--muted) md:flex"
					>
						<Layers class="h-3.5 w-3.5 text-(--accent)" />
						<span>{data.inventory.sessions.length} sessions</span>
					</div>

					<button
						class="theme-toggle"
						onclick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
						title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
						aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
					>
						{#if theme === 'dark'}
							<Sun class="h-4 w-4 text-amber-400" />
						{:else}
							<Moon class="h-4 w-4 text-indigo-600" />
						{/if}
					</button>
				</div>
			</div>
		</div>
	</header>

	<!-- Main Workspace Grid -->
	<main class="mx-auto grid max-w-[1540px] grid-cols-1 gap-0 lg:grid-cols-[310px_minmax(0,1fr)]">
		<!-- Sidebar Navigation with automatic viewport prefetching -->
		<aside
			data-sveltekit-preload-code="viewport"
			data-sveltekit-preload-data="hover"
			class="flex flex-col border-b border-(--line) bg-(--panel) lg:sticky lg:top-13.25 lg:h-[calc(100vh-53px)] lg:border-r lg:border-b-0"
		>
			<!-- Search & Filter Controls -->
			<div class="space-y-2.5 border-b border-(--line) p-3.5">
				<div class="flex items-center justify-between text-xs font-bold text-(--muted)">
					<span>SESSIONS ({regularSessions().length + importedSessionsList().length})</span>
					<span
						class="rounded border border-(--line) bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase"
						>⌘K / Filter</span
					>
				</div>
				<div class="search-wrapper">
					<Search class="search-icon h-4 w-4" />
					<input class="session-filter" bind:value={query} placeholder="Search title, ID..." />
					{#if query}
						<button
							class="absolute right-2.5 text-(--muted) hover:text-(--ink)"
							onclick={() => (query = '')}
						>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
				<!-- Filter Tags -->
				<div class="flex flex-wrap items-center gap-1 text-xs">
					<button
						class="rounded px-2 py-0.5 text-[11px] font-semibold transition-colors {sessionFilter ===
						'all'
							? 'bg-(--pill-active-bg) text-(--pill-active-text)'
							: 'bg-(--panel-subtle) text-(--muted) hover:text-(--ink)'}"
						onclick={() => (sessionFilter = 'all')}
					>
						All
					</button>
					<button
						class="rounded px-2 py-0.5 text-[11px] font-semibold transition-colors {sessionFilter ===
						'recent'
							? 'bg-(--pill-active-bg) text-(--pill-active-text)'
							: 'bg-(--panel-subtle) text-(--muted) hover:text-(--ink)'}"
						onclick={() => (sessionFilter = 'recent')}
					>
						Recent
					</button>
					<button
						class="rounded px-2 py-0.5 text-[11px] font-semibold transition-colors {sessionFilter ===
						'heavy'
							? 'bg-(--pill-active-bg) text-(--pill-active-text)'
							: 'bg-(--panel-subtle) text-(--muted) hover:text-(--ink)'}"
						onclick={() => (sessionFilter = 'heavy')}
					>
						High Tokens
					</button>
					<button
						class="rounded px-2 py-0.5 text-[11px] font-semibold transition-colors {sessionFilter ===
						'imported'
							? 'bg-indigo-600 text-white'
							: 'bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20'}"
						onclick={() => (sessionFilter = 'imported')}
					>
						Imported ({importedIds.size})
					</button>
				</div>
			</div>

			<!-- Session List -->
			<div class="max-h-75 flex-1 divide-y divide-(--line) overflow-y-auto lg:max-h-none">
				{#if importedSessionsList().length > 0}
					<div class="border-b-2 border-indigo-500/30 bg-indigo-950/20">
						<div class="px-3.5 py-2 font-mono text-[10px] font-bold tracking-wider text-indigo-400 uppercase flex items-center justify-between border-b border-indigo-500/20">
							<div class="flex items-center gap-1.5">
								<Upload class="h-3 w-3 text-indigo-400" />
								<span>Imported Items ({importedSessionsList().length})</span>
							</div>
							<span class="text-[9px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded font-sans font-normal">In Memory</span>
						</div>
						<div class="divide-y divide-indigo-500/10">
							{#each importedSessionsList() as session (session.id)}
								<a
									href={resolveRoute('/session/[id]', { id: session.id })}
									data-sveltekit-preload-code="viewport"
									data-sveltekit-preload-data="hover"
									class:active={$page.params.id === session.id}
									class="session-row group relative block no-underline border-l-2 border-l-indigo-500 bg-indigo-500/5 hover:bg-indigo-500/15"
								>
									<div class="flex items-start justify-between gap-2">
										<span
											class="block truncate text-left text-xs font-semibold group-hover:text-indigo-400"
											title={title(session)}
										>
											{title(session)}
										</span>
										<div class="flex items-center gap-1 shrink-0">
											<span class="imported-badge">Imported</span>
											<button
												type="button"
												class="p-0.5 text-(--muted) hover:text-red-500 rounded transition-colors"
												title="Delete imported item"
												onclick={(e) => deleteImported(session.id, e)}
											>
												<X class="h-3 w-3" />
											</button>
										</div>
									</div>
									<div
										class="mt-1.5 flex items-center justify-between text-[11px] font-medium text-(--muted)"
									>
										<span class="inline-flex items-center gap-1 font-mono">
											<Clock class="h-3 w-3" />
											{date(session.startedAt)}
										</span>
										<span
											class="inline-flex items-center gap-1 rounded bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold"
										>
											<Zap class="h-3 w-3 text-amber-500" />
											{number(latestTokens(session))}
										</span>
									</div>
								</a>
							{/each}
						</div>
					</div>
				{/if}

				{#if regularSessions().length > 0}
					{#if importedSessionsList().length > 0}
						<div class="px-3.5 py-2 font-mono text-[10px] font-bold tracking-wider text-(--muted) uppercase border-b border-(--line) bg-(--panel-subtle)/30">
							Local Sessions ({regularSessions().length})
						</div>
					{/if}
					{#each regularSessions() as session (session.id)}
						<a
							href={resolveRoute('/session/[id]', { id: session.id })}
							data-sveltekit-preload-code="viewport"
							data-sveltekit-preload-data="hover"
							class:active={$page.params.id === session.id}
							class="session-row group relative block no-underline"
						>
							<div class="flex items-start justify-between gap-2">
								<span
									class="block truncate text-left text-xs font-semibold group-hover:text-(--accent)"
									title={title(session)}
								>
									{title(session)}
								</span>
							</div>
							<div
								class="mt-1.5 flex items-center justify-between text-[11px] font-medium text-(--muted)"
							>
								<span class="inline-flex items-center gap-1 font-mono">
									<Clock class="h-3 w-3" />
									{date(session.startedAt)}
								</span>
								<span
									class="inline-flex items-center gap-1 rounded bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold"
								>
									<Zap class="h-3 w-3 text-amber-500" />
									{number(latestTokens(session))}
								</span>
							</div>
						</a>
					{/each}
				{:else if importedSessionsList().length === 0}
					<div class="p-6 text-center text-xs text-(--muted)">
						<MessageSquare class="mx-auto mb-2 h-8 w-8 opacity-40" />
						No matching sessions found.
					</div>
				{/if}
			</div>

			<!-- Import Session Footer -->
			<div class="import-section">
				<input
					type="file"
					accept=".json,application/json"
					class="hidden"
					bind:this={fileInput}
					onchange={handleImportFile}
				/>
				<button
					class="import-btn"
					onclick={() => fileInput?.click()}
					disabled={importLoading}
				>
					{#if importLoading}
						<span class="import-spinner"></span>
						<span>Importing…</span>
					{:else}
						<Upload class="h-4 w-4" />
						<span>Import session</span>
					{/if}
				</button>
				{#if importError}
					<div class="import-error">
						<AlertCircle class="h-3.5 w-3.5 shrink-0" />
						<span>{importError}</span>
						<button
							class="ml-auto shrink-0 text-(--danger) hover:text-(--ink)"
							onclick={() => (importError = null)}
						>
							<X class="h-3 w-3" />
						</button>
					</div>
				{/if}
			</div>
		</aside>

		<!-- Right Content Pane -->
		<section class="min-w-0 px-4 py-6 sm:px-7 lg:px-10">
			{#if $navigating}
				<SessionSkeleton />
			{:else}
				{@render children()}
			{/if}
		</section>
	</main>
</div>
