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
		MessageSquare
	} from '@lucide/svelte';
	import type { SessionInventory } from '../../../src/types.ts';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	let query = $state('');
	let theme = $state<'light' | 'dark'>('dark');
	let sessionFilter = $state<'all' | 'recent' | 'heavy'>('all');

	const title = (session?: SessionInventory | { displayTitle?: { value?: string } }) =>
		session?.displayTitle?.value ?? 'Untitled Codex session';
	const date = (value?: string) => value?.slice(0, 10) ?? 'Unknown date';
	const number = (value?: number) => (value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value));
	const latestTokens = (session: SessionInventory) => session.token.last?.totalTokens ?? session.token.total?.totalTokens;

	// Filter and sort session list
	const filteredSessions = () => {
		let list = data.inventory.sessions.filter((session) =>
			`${title(session)} ${session.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
		);
		if (sessionFilter === 'recent') {
			list = [...list].sort((a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime());
		} else if (sessionFilter === 'heavy') {
			list = [...list].sort((a, b) => (latestTokens(b) ?? 0) - (latestTokens(a) ?? 0));
		}
		return list;
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
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="min-h-screen bg-(--canvas) text-(--ink)">
	<!-- Top Navigation Header Aligned to Workspace Grid -->
	<header class="sticky top-0 z-30 border-b border-(--line) bg-(--panel) backdrop-blur-md">
		<div class="mx-auto grid max-w-[1540px] grid-cols-1 lg:grid-cols-[310px_minmax(0,1fr)]">
			<!-- Header Left: App Branding (matches sidebar width & right border) -->
			<div class="flex items-center gap-3 border-b border-(--line) bg-(--panel) px-4 py-3 lg:border-b-0 lg:border-r lg:border-(--line)">
				<div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-(--accent) text-white shadow-sm">
					<Activity class="h-4 w-4" />
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<a href={resolveRoute('/')} class="truncate text-xs font-bold tracking-tight text-inherit no-underline hover:underline sm:text-sm">
							Agent Session Inspect
						</a>
						<span class="inline-flex shrink-0 items-center gap-1 rounded-full bg-(--success-soft) px-1.5 py-0.5 text-[9px] font-semibold text-(--success)">
							<span class="h-1.5 w-1.5 rounded-full bg-(--success) animate-pulse"></span>
							Local
						</span>
					</div>
					<p class="truncate text-[10px] text-(--muted)">Session inspector & audit log</p>
				</div>
			</div>

			<!-- Header Right: Context Stats & Theme Switcher (matches main pane padding) -->
			<div class="flex items-center justify-between gap-4 bg-(--panel) px-4 py-2.5 sm:px-7 lg:px-10">
				<div class="flex items-center gap-3">
					<span class="hidden text-xs font-semibold text-(--muted) sm:inline">Workspace Inspector</span>
					{#if $page.data.detail}
						<span class="hidden text-(--line) sm:inline">|</span>
						<span class="max-w-75 truncate font-mono text-xs font-medium text-(--ink)">
							{title($page.data.detail)}
						</span>
					{/if}
				</div>

				<div class="flex items-center gap-3">
					<div class="hidden items-center gap-1.5 rounded-lg border border-(--line) bg-(--panel-subtle) px-2.5 py-1 text-xs font-medium text-(--muted) md:flex">
						<Layers class="h-3.5 w-3.5" />
						<span>{data.inventory.sessions.length} sessions</span>
					</div>

					<button class="theme-toggle" onclick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle colour theme">
						{#if theme === 'dark'}
							<Sun class="h-3.5 w-3.5 text-amber-400" />
							<span>Light</span>
						{:else}
							<Moon class="h-3.5 w-3.5 text-indigo-600" />
							<span>Dark</span>
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
			class="flex flex-col border-b border-(--line) bg-(--panel) lg:sticky lg:top-13.25 lg:h-[calc(100vh-53px)] lg:border-b-0 lg:border-r"
		>
			<!-- Search & Filter Controls -->
			<div class="space-y-2.5 border-b border-(--line) p-3.5">
				<div class="flex items-center justify-between text-xs font-bold text-(--muted)">
					<span>SESSIONS ({filteredSessions().length})</span>
					<span class="rounded border border-(--line) bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase">⌘K / Filter</span>
				</div>
				<div class="search-wrapper">
					<Search class="search-icon h-4 w-4" />
					<input class="session-filter" bind:value={query} placeholder="Search title, ID..." />
					{#if query}
						<button class="absolute right-2.5 text-(--muted) hover:text-(--ink)" onclick={() => (query = '')}>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
				<!-- Filter Tags -->
				<div class="flex items-center gap-1 text-xs">
					<button
						class="rounded px-2.5 py-1 text-[11px] font-semibold transition-colors {sessionFilter === 'all' ? 'bg-(--pill-active-bg) text-(--pill-active-text)' : 'bg-(--panel-subtle) text-(--muted) hover:text-(--ink)'}"
						onclick={() => (sessionFilter = 'all')}
					>
						All
					</button>
					<button
						class="rounded px-2.5 py-1 text-[11px] font-semibold transition-colors {sessionFilter === 'recent' ? 'bg-(--pill-active-bg) text-(--pill-active-text)' : 'bg-(--panel-subtle) text-(--muted) hover:text-(--ink)'}"
						onclick={() => (sessionFilter = 'recent')}
					>
						Recent
					</button>
					<button
						class="rounded px-2.5 py-1 text-[11px] font-semibold transition-colors {sessionFilter === 'heavy' ? 'bg-(--pill-active-bg) text-(--pill-active-text)' : 'bg-(--panel-subtle) text-(--muted) hover:text-(--ink)'}"
						onclick={() => (sessionFilter = 'heavy')}
					>
						High Tokens
					</button>
				</div>
			</div>

			<!-- Session List -->
			<div class="max-h-75 flex-1 divide-y divide-(--line) overflow-y-auto lg:max-h-none">
				{#each filteredSessions() as session (session.id)}
					<a
						href={resolveRoute('/session/[id]', { id: session.id })}
						data-sveltekit-preload-code="viewport"
						data-sveltekit-preload-data="hover"
						class:active={$page.params.id === session.id}
						class="session-row group relative block no-underline"
					>
						<div class="flex items-start justify-between gap-2">
							<span class="block truncate text-left text-xs font-semibold group-hover:text-(--accent)" title={title(session)}>
								{title(session)}
							</span>
						</div>
						<div class="mt-1.5 flex items-center justify-between text-[11px] font-medium text-(--muted)">
							<span class="inline-flex items-center gap-1 font-mono">
								<Clock class="h-3 w-3" /> {date(session.startedAt)}
							</span>
							<span class="inline-flex items-center gap-1 rounded bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold">
								<Zap class="h-3 w-3 text-amber-500" /> {number(latestTokens(session))}
							</span>
						</div>
					</a>
				{:else}
					<div class="p-6 text-center text-xs text-(--muted)">
						<MessageSquare class="mx-auto mb-2 h-8 w-8 opacity-40" />
						No matching sessions found.
					</div>
				{/each}
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
