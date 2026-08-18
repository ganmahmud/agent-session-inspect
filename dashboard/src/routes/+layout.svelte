<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount, type Snippet } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { page, navigating } from '$app/state';
	import { resolveRoute } from '$app/paths';
	import { goto } from '$app/navigation';
	import SessionSkeleton from '$lib/components/SessionSkeleton.svelte';
	import ImportModal from '$lib/components/ImportModal.svelte';
	import {
		Activity,
		Layers,
		Search,
		X,
		Clock,
		Zap,
		MessageSquare,
		Upload,
		CircleAlert,
		Bot,
		Folder,
		FolderGit2,
		ChevronDown,
		ChevronRight,
		FileText,
		Star
	} from '@lucide/svelte';
	import {
		initPreferences,
		pinnedSessions,
		togglePinSession,
		isPinned,
		collapsedProjects,
		toggleProjectCollapse,
		selectedProjects,
		toggleProjectSelection,
		selectAllProjects,
		deselectAllProjects,
		isProjectSelected
	} from '$lib/preferences.svelte';
	import { extractProjectName, formatCompactTokens } from '$lib/project';
	import type { SessionInventory } from '../../../src/types.ts';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	let query = $state('');
	let sessionFilter = $state<'all' | 'recent' | 'heavy' | 'pinned' | 'imported'>('all');
	let viewMode = $state<'projects' | 'flat'>('flat');
	let isProjectDropdownOpen = $state(false);
	let importLoading = $state(false);
	let importError = $state<string | null>(null);
	let isImportModalOpen = $state(false);
	let fileInput: HTMLInputElement;

	// Draggable sidebar state
	let sidebarWidth = $state(340);
	let isResizing = $state(false);

	onMount(() => {
		initPreferences();

		const savedWidth = localStorage.getItem('asi_sidebar_width');
		if (savedWidth) {
			const parsed = parseInt(savedWidth, 10);
			if (!isNaN(parsed) && parsed >= 240 && parsed <= 800) {
				sidebarWidth = parsed;
			}
		}

		const savedViewMode = localStorage.getItem('asi_view_mode');
		if (savedViewMode === 'projects' || savedViewMode === 'flat') {
			viewMode = savedViewMode;
		}

		const savedSessionFilter = localStorage.getItem('asi_session_filter');
		if (
			savedSessionFilter === 'all' ||
			savedSessionFilter === 'recent' ||
			savedSessionFilter === 'heavy' ||
			savedSessionFilter === 'pinned' ||
			savedSessionFilter === 'imported'
		) {
			sessionFilter = savedSessionFilter;
		}
	});

	// Auto-select and show first session on load (filtered or unfiltered)
	$effect(() => {
		if (typeof window === 'undefined') return;
		if (page.route.id !== '/session/[id]' && page.route.id !== '/') return;

		const list = sessionFilter === 'imported' ? importedSessionsList() : regularSessions();
		if (list.length > 0) {
			const currentId = page.params.id;
			if (!currentId || !list.some((s) => s.id === currentId)) {
				goto(resolveRoute('/session/[id]', { id: list[0].id }), { replaceState: true });
			}
		}
	});

	export function setViewMode(mode: 'projects' | 'flat') {
		viewMode = mode;
		if (typeof window !== 'undefined') localStorage.setItem('asi_view_mode', mode);
	}

	function setSessionFilter(filter: 'all' | 'recent' | 'heavy' | 'pinned' | 'imported') {
		sessionFilter = filter;
		if (typeof window !== 'undefined') localStorage.setItem('asi_session_filter', filter);
	}

	function startResize(e: MouseEvent) {
		e.preventDefault();
		isResizing = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const startX = e.clientX;
		const startWidth = sidebarWidth;

		function onMouseMove(moveEvent: MouseEvent) {
			const delta = moveEvent.clientX - startX;
			const maxAllowed = Math.min(800, Math.round(window.innerWidth * 0.55));
			const newWidth = Math.max(240, Math.min(maxAllowed, startWidth + delta));
			sidebarWidth = newWidth;
		}

		function onMouseUp() {
			isResizing = false;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
			localStorage.setItem('asi_sidebar_width', sidebarWidth.toString());
		}

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
	}

	function resetSidebarWidth() {
		sidebarWidth = 340;
		localStorage.setItem('asi_sidebar_width', '340');
	}

	// Local backlight flag (enabled by default)
	let isBacklightEnabled = $state(true);

	function openImportModal() {
		isImportModalOpen = true;
	}

	function getSessionProject(session: SessionInventory): {
		name: string;
		path?: string;
		key: string;
	} {
		const name =
			session.projectName ||
			(session.cwd ? extractProjectName(session.cwd) : undefined) ||
			'General / No Project';
		const path = session.cwd || undefined;
		const key = session.cwd || name;
		return { name, path, key };
	}

	// Track which sessions were imported
	const importedIds = $derived(new SvelteSet(data.importedSessionIds ?? []));

	// Pre-map parent session IDs to child sessions for O(1) multi-agent resolution
	const parentToChildrenMap = $derived.by(() => {
		const map = new SvelteMap<string, SvelteSet<string>>();
		for (const session of data.inventory.sessions) {
			for (const rel of session.relationships ?? []) {
				if (rel.type === 'parent' && rel.sessionId) {
					let set = map.get(rel.sessionId);
					if (!set) {
						set = new SvelteSet();
						map.set(rel.sessionId, set);
					}
					set.add(session.id);
				}
			}
		}
		return map;
	});

	function getSubagentCount(session: SessionInventory): number {
		const directSubagentIds = (session.relationships ?? [])
			.filter((r) => r.type === 'subagent')
			.map((r) => r.sessionId);

		const inverseChildren = parentToChildrenMap.get(session.id);
		const allIds = new SvelteSet(directSubagentIds);
		if (inverseChildren) {
			for (const id of inverseChildren) {
				allIds.add(id);
			}
		}

		if (allIds.size === 0) {
			const eventSubCount =
				(session.eventCounts?.['sub_agent_activity'] ?? 0) +
				(session.eventCounts?.['subagent_activity'] ?? 0) +
				(session.eventCounts?.['agent_activity'] ?? 0);
			return eventSubCount > 0 ? eventSubCount : 0;
		}
		return allIds.size;
	}

	const title = (session?: SessionInventory | { displayTitle?: { value?: string } }) =>
		session?.displayTitle?.value ?? 'Untitled Codex session';
	const date = (value?: string) => value?.slice(0, 10) ?? 'Unknown date';
	const number = (value?: number) =>
		value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value);
	const latestTokens = (session: SessionInventory) =>
		session.token?.last?.totalTokens ?? session.token?.total?.totalTokens;

	// Available user projects for dropdown selector sorted by latest session activity
	const availableProjects = $derived.by(() => {
		const regular = data.inventory.sessions.filter((s) => !importedIds.has(s.id));
		const map = new SvelteMap<
			string,
			{ key: string; name: string; path?: string; count: number; latestActivity: number }
		>();
		for (const s of regular) {
			const p = getSessionProject(s);
			if (p.name === 'General / No Project') continue;
			const time = new Date(s.updatedAt ?? s.startedAt ?? 0).getTime();
			const existing = map.get(p.key);
			if (existing) {
				existing.count += 1;
				if (time > existing.latestActivity) existing.latestActivity = time;
			} else {
				map.set(p.key, { key: p.key, name: p.name, path: p.path, count: 1, latestActivity: time });
			}
		}
		return Array.from(map.values()).sort((a, b) => b.latestActivity - a.latestActivity);
	});

	const regularSessionsTotalCount = $derived(
		data.inventory.sessions.filter((s) => !importedIds.has(s.id)).length
	);

	const ungroupedSessionsCount = $derived.by(() => {
		const regular = data.inventory.sessions.filter((s) => !importedIds.has(s.id));
		return regular.filter((s) => getSessionProject(s).name === 'General / No Project').length;
	});

	const allProjectKeys = $derived.by(() => {
		const keys = availableProjects.map((p) => p.key);
		if (ungroupedSessionsCount > 0) keys.push('__ungrouped__');
		return keys;
	});

	const dropdownLabel = $derived.by(() => {
		if (selectedProjects.has('__NONE__')) {
			return '0 Projects Selected';
		}
		if (selectedProjects.size === 0 || selectedProjects.size === allProjectKeys.length) {
			return `All Projects & Sessions (${regularSessionsTotalCount})`;
		}
		if (selectedProjects.size === 1) {
			const onlyKey = Array.from(selectedProjects)[0];
			if (onlyKey === '__ungrouped__') return `Ungrouped Sessions (${ungroupedSessionsCount})`;
			const found = availableProjects.find((p) => p.key === onlyKey);
			if (found) return `${found.name} (${found.count})`;
		}
		return `${selectedProjects.size} of ${allProjectKeys.length} Projects Selected`;
	});

	const pinnedSessionsList = $derived.by(() => {
		const regular = data.inventory.sessions.filter((s) => !importedIds.has(s.id));
		return regular.filter((s) => pinnedSessions.has(s.id));
	});

	// Filter and sort session list
	const regularSessions = () => {
		if (sessionFilter === 'imported') return [];
		let list = data.inventory.sessions.filter((session) => {
			if (importedIds.has(session.id)) return false;
			if (sessionFilter === 'pinned' && !pinnedSessions.has(session.id)) return false;

			const proj = getSessionProject(session);
			const projKey = proj.name === 'General / No Project' ? '__ungrouped__' : proj.key;

			// Unified project filter using isProjectSelected
			if (!isProjectSelected(projKey)) {
				return false;
			}

			const subCount = getSubagentCount(session);
			const subText = subCount > 0 ? `subagent subagents ${subCount}` : '';
			const matchText =
				`${title(session)} ${session.id} ${proj.name} ${proj.path ?? ''} ${subText}`.toLocaleLowerCase();
			return matchText.includes(query.toLocaleLowerCase());
		});
		if (sessionFilter === 'recent') {
			list = [...list].sort(
				(a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime()
			);
		} else if (sessionFilter === 'heavy') {
			list = [...list].sort((a, b) => (latestTokens(b) ?? 0) - (latestTokens(a) ?? 0));
		}
		return list;
	};

	interface LayoutProjectGroup {
		key: string;
		name: string;
		path?: string;
		sessions: SessionInventory[];
		totalTokens: number;
		latestActivity: number;
	}

	const groupedProjects = $derived.by(() => {
		const regular = regularSessions();
		const groupsMap = new SvelteMap<string, LayoutProjectGroup>();

		for (const session of regular) {
			const proj = getSessionProject(session);
			if (proj.name === 'General / No Project') continue;

			const time = new Date(session.updatedAt ?? session.startedAt ?? 0).getTime();
			let group = groupsMap.get(proj.key);
			if (!group) {
				group = {
					key: proj.key,
					name: proj.name,
					path: proj.path,
					sessions: [],
					totalTokens: 0,
					latestActivity: time
				};
				groupsMap.set(proj.key, group);
			} else {
				if (time > group.latestActivity) {
					group.latestActivity = time;
				}
			}
			group.sessions.push(session);
			group.totalTokens += latestTokens(session) ?? 0;
		}

		// Sort sessions inside each project by most recent activity
		for (const group of groupsMap.values()) {
			group.sessions.sort((a, b) => {
				const timeA = new Date(a.updatedAt ?? a.startedAt ?? 0).getTime();
				const timeB = new Date(b.updatedAt ?? b.startedAt ?? 0).getTime();
				return timeB - timeA;
			});
		}

		// Sort project groups by latest session used descending
		return Array.from(groupsMap.values()).sort((a, b) => b.latestActivity - a.latestActivity);
	});

	const ungroupedSessions = $derived.by(() => {
		const regular = regularSessions();
		return regular.filter((session) => getSessionProject(session).name === 'General / No Project');
	});

	const importedSessionsList = () => {
		return data.inventory.sessions.filter((session) => {
			if (!importedIds.has(session.id)) return false;
			const proj = getSessionProject(session);
			const subCount = getSubagentCount(session);
			const subText = subCount > 0 ? `subagent subagents ${subCount}` : '';
			const matchText =
				`${title(session)} ${session.id} ${proj.name} ${subText}`.toLocaleLowerCase();
			return matchText.includes(query.toLocaleLowerCase());
		});
	};

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

<svelte:window
	onclick={(e) => {
		const target = e.target as HTMLElement | null;
		if (isProjectDropdownOpen && target && !target.closest('.project-dropdown-container')) {
			isProjectDropdownOpen = false;
		}
	}}
/>

<ImportModal bind:isOpen={isImportModalOpen} />

<div
	class="relative min-h-screen bg-(--canvas) text-(--ink)"
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
	role="region"
	aria-label="Workspace Dropzone"
>
	<!-- Fixed Ambient Backlight & Tech Grid Backdrop -->
	{#if isBacklightEnabled}
		<div class="github-backlight-fixed"></div>
		<div class="github-grid-backdrop-fixed"></div>
	{/if}
	{#if isDragging}
		<div
			class="animate-in fade-in pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-indigo-950/80 p-6 text-white backdrop-blur-md transition-all duration-200"
		>
			<div
				class="flex h-16 w-16 items-center justify-center rounded-2xl border border-indigo-400/50 bg-indigo-600/30 shadow-2xl"
			>
				<Upload class="h-8 w-8 animate-bounce text-indigo-200" />
			</div>
			<h2 class="text-xl font-bold tracking-tight">Drop JSON file here to import</h2>
			<p class="text-xs font-medium text-indigo-200/80">
				Supports full session exports or single message snippets
			</p>
		</div>
	{/if}
	<!-- Top Navigation Header Aligned to Workspace Grid -->
	<header class="sticky top-0 z-30 border-b border-(--line) bg-(--panel) backdrop-blur-md">
		<div
			class="workspace-layout-grid mx-auto grid max-w-[1600px] grid-cols-1"
			style="--sidebar-width: {sidebarWidth}px;"
		>
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
					{#if page.data.detail}
						<span class="hidden text-(--line) sm:inline">|</span>
						<span
							class="max-w-75 truncate font-mono text-xs font-medium text-(--ink)"
							title={title(page.data.detail)}
						>
							{title(page.data.detail)}
						</span>
					{/if}
				</div>

				<div class="flex items-center gap-3">
					<a
						href={resolveRoute('/import')}
						class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-xs font-bold text-indigo-400 no-underline transition-colors hover:bg-indigo-500 hover:text-white"
						title="Open Import Hub & Studio"
					>
						<Upload class="h-3.5 w-3.5" />
						<span>Import Hub</span>
					</a>

					<button
						type="button"
						class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-(--line) bg-(--panel-subtle) px-3 py-1 text-xs font-semibold text-(--ink) transition-colors hover:border-(--accent) hover:bg-(--panel)"
						onclick={openImportModal}
						title="Quick import session JSON"
					>
						<Upload class="h-3.5 w-3.5 text-(--accent)" />
						<span class="text-xs">Quick Import</span>
					</button>

					<div
						class="hidden items-center gap-1.5 rounded-lg border border-(--line) bg-(--panel-subtle) px-2.5 py-1 text-xs font-medium text-(--muted) md:flex"
					>
						<Layers class="h-3.5 w-3.5 text-(--accent)" />
						<span>{data.inventory.sessions.length} sessions</span>
					</div>
				</div>
			</div>
		</div>
	</header>

	<!-- Main Workspace Grid -->
	<main
		class="workspace-layout-grid mx-auto grid max-w-[1600px] grid-cols-1 gap-0"
		style="--sidebar-width: {sidebarWidth}px;"
	>
		<!-- Sidebar Navigation with automatic viewport prefetching -->
		<aside
			data-sveltekit-preload-code="viewport"
			data-sveltekit-preload-data="hover"
			class="relative flex flex-col border-b border-(--line) bg-(--panel) lg:sticky lg:top-13.25 lg:h-[calc(100vh-53px)] lg:border-r lg:border-b-0"
		>
			<!-- Draggable Sidebar Resizer Handle (Desktop) -->
			<button
				type="button"
				class="sidebar-resizer hidden lg:flex {isResizing ? 'is-resizing' : ''}"
				onmousedown={startResize}
				ondblclick={resetSidebarWidth}
				onkeydown={(e) => {
					if (e.key === 'ArrowLeft') {
						sidebarWidth = Math.max(240, sidebarWidth - 10);
						localStorage.setItem('asi_sidebar_width', sidebarWidth.toString());
					} else if (e.key === 'ArrowRight') {
						sidebarWidth = Math.min(800, sidebarWidth + 10);
						localStorage.setItem('asi_sidebar_width', sidebarWidth.toString());
					}
				}}
				aria-label="Resize sidebar width"
				title="Drag to resize sidebar (double-click to reset, Left/Right arrows to adjust)"
			></button>
			<!-- Search & Filter Controls -->
			<div class="space-y-2.5 border-b border-(--line) p-3.5">
				<div class="flex items-center justify-between text-xs font-bold text-(--muted)">
					<span>SESSIONS ({regularSessions().length + importedSessionsList().length})</span>
					<!-- View Mode Toggle: Projects vs Flat List -->
					<div class="flex items-center rounded-lg border border-(--line) bg-(--field) p-0.5">
						<button
							type="button"
							class="flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold transition-all {viewMode ===
							'projects'
								? 'bg-indigo-600 text-white shadow-xs'
								: 'text-(--muted) hover:text-(--ink)'}"
							onclick={() => (viewMode = 'projects')}
							title="Group sessions by project / workspace directory"
						>
							<FolderGit2 class="h-3 w-3" />
							<span>Projects</span>
						</button>
						<button
							type="button"
							class="flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold transition-all {viewMode ===
							'flat'
								? 'bg-indigo-600 text-white shadow-xs'
								: 'text-(--muted) hover:text-(--ink)'}"
							onclick={() => (viewMode = 'flat')}
							title="View flat chronological session list"
						>
							<Layers class="h-3 w-3" />
							<span>Flat</span>
						</button>
					</div>
				</div>

				<div class="search-wrapper">
					<Search class="search-icon h-4 w-4" />
					<input
						class="session-filter"
						bind:value={query}
						placeholder="Search title, project, ID..."
					/>
					{#if query}
						<button
							class="absolute right-2.5 text-(--muted) hover:text-(--ink)"
							onclick={() => (query = '')}
						>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
				<!-- Clear Segmented Sidebar Filter Control -->
				<div
					class="grid grid-cols-5 gap-1 rounded-lg border border-(--line) bg-(--field) p-1 text-xs"
				>
					<button
						type="button"
						class="flex cursor-pointer items-center justify-center gap-1 rounded-md px-1 py-1 text-[10px] font-bold transition-all {sessionFilter ===
						'all'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'text-(--muted) hover:bg-(--panel-subtle) hover:text-(--ink)'}"
						onclick={() => setSessionFilter('all')}
						title="Show all sessions"
					>
						<Layers class="h-3 w-3" />
						<span>All</span>
					</button>

					<button
						type="button"
						class="flex cursor-pointer items-center justify-center gap-1 rounded-md px-1 py-1 text-[10px] font-bold transition-all {sessionFilter ===
						'recent'
							? 'bg-blue-600 text-white shadow-xs'
							: 'text-(--muted) hover:bg-(--panel-subtle) hover:text-(--ink)'}"
						onclick={() => setSessionFilter('recent')}
						title="Sort by most recent start date"
					>
						<Clock class="h-3 w-3" />
						<span>Recent</span>
					</button>

					<button
						type="button"
						class="flex cursor-pointer items-center justify-center gap-1 rounded-md px-1 py-1 text-[10px] font-bold transition-all {sessionFilter ===
						'heavy'
							? 'bg-amber-600 text-white shadow-xs'
							: 'text-(--muted) hover:bg-(--panel-subtle) hover:text-(--ink)'}"
						onclick={() => setSessionFilter('heavy')}
						title="Sort by highest token usage"
					>
						<Zap class="h-3 w-3" />
						<span>Heavy</span>
					</button>

					<button
						type="button"
						class="flex cursor-pointer items-center justify-center gap-1 rounded-md px-1 py-1 text-[10px] font-bold transition-all {sessionFilter ===
						'pinned'
							? 'bg-amber-500 text-black shadow-xs'
							: 'text-(--muted) hover:bg-(--panel-subtle) hover:text-(--ink)'}"
						onclick={() => setSessionFilter('pinned')}
						title="Show only favorite/pinned sessions ({pinnedSessionsList.length})"
					>
						<Star class="h-3 w-3 {sessionFilter === 'pinned' ? 'fill-black' : ''}" />
						<span>Pinned</span>
					</button>

					<button
						type="button"
						class="flex cursor-pointer items-center justify-center gap-1 rounded-md px-1 py-1 text-[10px] font-bold transition-all {sessionFilter ===
						'imported'
							? 'bg-purple-600 text-white shadow-xs'
							: 'text-(--muted) hover:bg-(--panel-subtle) hover:text-(--ink)'}"
						onclick={() => setSessionFilter('imported')}
						title="Show imported session files ({importedIds.size})"
					>
						<Upload class="h-3 w-3" />
						<span>Import</span>
					</button>
				</div>

				<!-- Unified Merged Project Dropdown with Select/Deselect All -->
				{#if sessionFilter !== 'imported' && (availableProjects.length > 0 || ungroupedSessionsCount > 0)}
					<div class="project-dropdown-container relative pt-0.5">
						<button
							type="button"
							class="flex w-full cursor-pointer items-center justify-between rounded-lg border border-(--line) bg-(--field) py-1.5 pr-2.5 pl-2.5 text-xs font-semibold text-(--ink) transition-colors hover:border-indigo-500/50 focus:border-indigo-500 focus:outline-none"
							onclick={() => (isProjectDropdownOpen = !isProjectDropdownOpen)}
							aria-expanded={isProjectDropdownOpen}
						>
							<div class="flex min-w-0 items-center gap-2 truncate">
								<FolderGit2 class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
								<span class="truncate text-xs">{dropdownLabel}</span>
							</div>
							<ChevronDown
								class="h-3.5 w-3.5 shrink-0 text-(--muted) transition-transform {isProjectDropdownOpen
									? 'rotate-180 text-indigo-400'
									: ''}"
							/>
						</button>

						<!-- Dropdown Menu Popover -->
						{#if isProjectDropdownOpen}
							<div
								class="animate-in fade-in zoom-in-95 absolute right-0 left-0 z-50 mt-1 space-y-1.5 rounded-xl border border-(--line) bg-(--panel) p-2 shadow-2xl backdrop-blur-md duration-100"
							>
								<!-- Top Action Bar: Select All / Deselect All -->
								<div class="flex items-center justify-between border-b border-(--line) px-1 pb-1.5">
									<button
										type="button"
										class="cursor-pointer text-xs font-bold text-indigo-400 hover:text-indigo-300 hover:underline"
										onclick={() => selectAllProjects()}
									>
										<span class="text-xs">Select All</span>
									</button>
									<span class="text-(--line)">•</span>
									<button
										type="button"
										class="cursor-pointer text-xs font-bold text-(--muted) hover:text-(--ink) hover:underline"
										onclick={() => deselectAllProjects()}
									>
										<span class="text-xs">Deselect All</span>
									</button>
								</div>

								<!-- Project List with Checkboxes -->
								<div class="no-scrollbar max-h-56 space-y-0.5 overflow-y-auto py-0.5">
									{#each availableProjects as proj (proj.key)}
										{@const checked = isProjectSelected(proj.key)}
										<label
											class="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-(--panel-subtle) {checked
												? 'text-(--ink)'
												: 'text-(--muted)'}"
											title={proj.path ? `Project: ${proj.name}\nLocation: ${proj.path}` : `Project: ${proj.name}`}
										>
											<div class="flex min-w-0 items-center gap-2">
												<input
													type="checkbox"
													{checked}
													onchange={() => toggleProjectSelection(proj.key, allProjectKeys)}
													class="h-3.5 w-3.5 cursor-pointer rounded border-(--line) text-indigo-600 focus:ring-indigo-500"
												/>
												<FolderGit2 class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
												<span class="truncate font-semibold">{proj.name} ({proj.count})</span>
											</div>
										</label>
									{/each}

									{#if ungroupedSessionsCount > 0}
										{@const checked = isProjectSelected('__ungrouped__')}
										<label
											class="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-(--panel-subtle) {checked
												? 'text-(--ink)'
												: 'text-(--muted)'}"
										>
											<div class="flex min-w-0 items-center gap-2">
												<input
													type="checkbox"
													{checked}
													onchange={() => toggleProjectSelection('__ungrouped__', allProjectKeys)}
													class="h-3.5 w-3.5 cursor-pointer rounded border-(--line) text-indigo-600 focus:ring-indigo-500"
												/>
												<FileText class="h-3.5 w-3.5 shrink-0 text-(--muted)" />
												<span class="truncate font-semibold"
													>Ungrouped Sessions ({ungroupedSessionsCount})</span
												>
											</div>
										</label>
									{/if}
								</div>
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Session List -->
			<div class="max-h-75 flex-1 divide-y divide-(--line) overflow-y-auto lg:max-h-none">
				<!-- Pinned / Favorites Quick Access Block (when not already filtering solely on Pinned) -->
				{#if sessionFilter !== 'imported' && sessionFilter !== 'pinned' && pinnedSessionsList.length > 0}
					<div class="border-b-2 border-amber-500/30 bg-amber-950/15">
						<div
							class="flex items-center justify-between border-b border-amber-500/20 px-3.5 py-2 font-mono text-[10px] font-bold tracking-wider text-amber-400 uppercase"
						>
							<div class="flex items-center gap-1.5">
								<Star class="h-3 w-3 fill-amber-400 text-amber-400" />
								<span>Pinned Favorites ({pinnedSessionsList.length})</span>
							</div>
							<span
								class="rounded bg-amber-500/20 px-1.5 py-0.5 font-sans text-[9px] font-normal text-amber-300"
								>Quick Access</span
							>
						</div>
						<div class="divide-y divide-amber-500/10">
							{#each pinnedSessionsList as session (session.id)}
								{@const subCount = getSubagentCount(session)}
								{@const proj = getSessionProject(session)}
								<a
									href={resolveRoute('/session/[id]', { id: session.id })}
									data-sveltekit-preload-code="viewport"
									data-sveltekit-preload-data="hover"
									class:active={page.params.id === session.id}
									class="session-row group relative block border-l-2 border-l-amber-400 bg-amber-500/5 no-underline hover:bg-amber-500/15"
								>
									<div class="flex items-start justify-between gap-2">
										<span
											class="block truncate text-left text-xs font-semibold group-hover:text-amber-300"
											title={title(session)}
										>
											{title(session)}
										</span>
										<div class="flex shrink-0 items-center gap-1">
											<button
												type="button"
												class="rounded p-0.5 text-amber-400 transition-colors hover:text-red-400"
												title="Unpin from favorites"
												onclick={(e) => {
													e.preventDefault();
													e.stopPropagation();
													togglePinSession(session.id);
												}}
											>
												<Star class="h-3 w-3 fill-amber-400 text-amber-400" />
											</button>
										</div>
									</div>
									<div
										class="mt-1.5 flex items-center justify-between text-[11px] font-medium text-(--muted)"
									>
										<div class="flex min-w-0 items-center gap-1.5">
											<span class="inline-flex items-center gap-1 font-mono">
												<Clock class="h-3 w-3" />
												{date(session.startedAt)}
											</span>
											{#if proj.name !== 'General / No Project'}
												<span
													class="project-badge max-w-24 truncate font-mono text-[9px]"
													title={proj.path ? `Project: ${proj.name}\nLocation: ${proj.path}` : `Project: ${proj.name}`}
												>
													{proj.name}
												</span>
											{/if}
										</div>
										<div class="flex shrink-0 items-center gap-1.5">
											{#if subCount > 0}
												<span
													class="subagent-badge"
													title="{subCount} subagent{subCount === 1
														? ''
														: 's'} used in this session"
												>
													<Bot class="h-2.5 w-2.5" />
													<span>{subCount}</span>
												</span>
											{/if}
											<span
												class="inline-flex items-center gap-1 rounded bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold"
												title="{number(latestTokens(session))} tokens used"
											>
												<Zap class="h-3 w-3 text-amber-500" />
												{formatCompactTokens(latestTokens(session))}
											</span>
										</div>
									</div>
								</a>
							{/each}
						</div>
					</div>
				{/if}

				{#if importedSessionsList().length > 0}
					<div class="border-b-2 border-indigo-500/30 bg-indigo-950/20">
						<div
							class="flex items-center justify-between border-b border-indigo-500/20 px-3.5 py-2 font-mono text-[10px] font-bold tracking-wider text-indigo-400 uppercase"
						>
							<div class="flex items-center gap-1.5">
								<Upload class="h-3 w-3 text-indigo-400" />
								<span>Imported Items ({importedSessionsList().length})</span>
							</div>
							<span
								class="rounded bg-indigo-500/20 px-1.5 py-0.5 font-sans text-[9px] font-normal text-indigo-300"
								>In Memory</span
							>
						</div>
						<div class="divide-y divide-indigo-500/10">
							{#each importedSessionsList() as session (session.id)}
								{@const subCount = getSubagentCount(session)}
								<a
									href={resolveRoute('/session/[id]', { id: session.id })}
									data-sveltekit-preload-code="viewport"
									data-sveltekit-preload-data="hover"
									class:active={page.params.id === session.id}
									class="session-row group relative block border-l-2 border-l-indigo-500 bg-indigo-500/5 no-underline hover:bg-indigo-500/15"
								>
									<div class="flex items-start justify-between gap-2">
										<span
											class="block truncate text-left text-xs font-semibold group-hover:text-indigo-400"
											title={title(session)}
										>
											{title(session)}
										</span>
										<div class="flex shrink-0 items-center gap-1.5">
											<button
												type="button"
												class="rounded p-0.5 text-(--muted) transition-colors hover:text-amber-400"
												title={isPinned(session.id) ? 'Unpin' : 'Pin to favorites'}
												onclick={(e) => {
													e.preventDefault();
													e.stopPropagation();
													togglePinSession(session.id);
												}}
											>
												<Star
													class="h-3 w-3 {isPinned(session.id)
														? 'fill-amber-400 text-amber-400'
														: ''}"
												/>
											</button>
											<span class="imported-badge">Imported</span>
											<button
												type="button"
												class="rounded p-0.5 text-(--muted) transition-colors hover:text-red-500"
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
										<div class="flex shrink-0 items-center gap-1.5">
											{#if subCount > 0}
												<span
													class="subagent-badge"
													title="{subCount} subagent{subCount === 1
														? ''
														: 's'} used in this session"
												>
													<Bot class="h-2.5 w-2.5" />
													<span>{subCount}</span>
												</span>
											{/if}
											<span
												class="inline-flex items-center gap-1 rounded bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold"
												title="{number(latestTokens(session))} tokens used"
											>
												<Zap class="h-3 w-3 text-amber-500" />
												{formatCompactTokens(latestTokens(session))}
											</span>
										</div>
									</div>
								</a>
							{/each}
						</div>
					</div>
				{/if}

				{#if sessionFilter !== 'imported' && regularSessions().length > 0}
					{#if viewMode === 'projects'}
						<!-- Project Grouped View (Codex / ChatGPT App Style) -->
						{#if groupedProjects.length > 0 || ungroupedSessions.length > 0}
							<div class="divide-y divide-(--line)">
								<!-- 1. Grouped Projects -->
								{#each groupedProjects as group (group.key)}
									{@const isCollapsed = collapsedProjects.has(group.key)}
									<div class="group/project">
										<!-- Project Header Card -->
										<button
											type="button"
											class="project-group-header flex w-full cursor-pointer items-center justify-between px-3.5 py-2.5 transition-colors hover:bg-indigo-500/10"
											onclick={() => toggleProjectCollapse(group.key)}
											title={group.path ? `Path: ${group.path}` : group.name}
										>
											<div class="flex min-w-0 items-center gap-2">
												{#if isCollapsed}
													<ChevronRight class="h-3.5 w-3.5 text-(--muted) transition-transform" />
												{:else}
													<ChevronDown class="h-3.5 w-3.5 text-indigo-400 transition-transform" />
												{/if}
												<div
													class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-indigo-500/20 text-indigo-400"
												>
													<FolderGit2 class="h-3 w-3" />
												</div>
												<div class="min-w-0 text-left">
													<div
														class="truncate text-xs font-bold text-(--ink)"
														title={group.path ? `Project: ${group.name}\nLocation: ${group.path}` : `Project: ${group.name}`}
													>
														<span>{group.name}</span>
														<span class="font-normal opacity-75">({group.sessions.length})</span>
													</div>
													{#if group.path && group.path !== group.name}
														<div
															class="truncate font-mono text-[9px] font-normal text-(--muted) opacity-75"
															title={`Location: ${group.path}`}
														>
															{group.path}
														</div>
													{/if}
												</div>
											</div>

											<div class="flex shrink-0 items-center gap-1.5">
												{#if group.totalTokens > 0}
													<span
														class="inline-flex items-center gap-0.5 rounded bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold text-(--muted)"
													>
														<Zap class="h-2.5 w-2.5 text-amber-500" />
														{formatCompactTokens(group.totalTokens)}
													</span>
												{/if}
											</div>
										</button>

										<!-- Project Sessions (when expanded) -->
										{#if !isCollapsed}
											<div class="divide-y divide-(--line-subtle) bg-(--panel)/50 pl-3">
												{#each group.sessions as session (session.id)}
													{@const subCount = getSubagentCount(session)}
													<a
														href={resolveRoute('/session/[id]', { id: session.id })}
														data-sveltekit-preload-code="viewport"
														data-sveltekit-preload-data="hover"
														class:active={page.params.id === session.id}
														class="session-row group relative block border-l border-(--line) no-underline hover:border-indigo-400"
													>
														<div class="flex items-start justify-between gap-2">
															<span
																class="block truncate text-left text-xs font-semibold group-hover:text-(--accent)"
																title={title(session)}
															>
																{title(session)}
															</span>
															<button
																type="button"
																class="rounded p-0.5 text-(--muted) transition-colors hover:text-amber-400 {isPinned(
																	session.id
																)
																	? 'text-amber-400 opacity-100'
																	: 'opacity-0 group-hover:opacity-100'}"
																title={isPinned(session.id)
																	? 'Unpin from favorites'
																	: 'Pin to favorites'}
																onclick={(e) => {
																	e.preventDefault();
																	e.stopPropagation();
																	togglePinSession(session.id);
																}}
															>
																<Star
																	class="h-3 w-3 {isPinned(session.id)
																		? 'fill-amber-400 text-amber-400'
																		: ''}"
																/>
															</button>
														</div>
														<div
															class="mt-1.5 flex items-center justify-between text-[11px] font-medium text-(--muted)"
														>
															<span class="inline-flex items-center gap-1 font-mono">
																<Clock class="h-3 w-3" />
																{date(session.startedAt)}
															</span>
															<div class="flex shrink-0 items-center gap-1.5">
																{#if subCount > 0}
																	<span
																		class="subagent-badge"
																		title="{subCount} subagent{subCount === 1
																			? ''
																			: 's'} used in this session"
																	>
																		<Bot class="h-2.5 w-2.5" />
																		<span>{subCount}</span>
																	</span>
																{/if}
																<span
																	class="inline-flex items-center gap-1 rounded bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold"
																	title="{number(latestTokens(session))} tokens used"
																>
																	<Zap class="h-3 w-3 text-amber-500" />
																	{formatCompactTokens(latestTokens(session))}
																</span>
															</div>
														</div>
													</a>
												{/each}
											</div>
										{/if}
									</div>
								{/each}

								<!-- 2. Ungrouped / Other Sessions Section (Shown below grouped projects) -->
								{#if ungroupedSessions.length > 0}
									<div class="group/ungrouped">
										<div
											class="flex items-center justify-between border-b border-(--line) bg-(--panel-subtle) px-3.5 py-2"
										>
											<div class="flex items-center gap-2">
												<div
													class="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-(--line) text-(--muted)"
												>
													<FileText class="h-2.5 w-2.5" />
												</div>
												<span class="text-xs font-bold tracking-wider text-(--muted) uppercase">
													Ungrouped Sessions ({ungroupedSessions.length})
												</span>
											</div>
										</div>
										<div class="divide-y divide-(--line)">
											{#each ungroupedSessions as session (session.id)}
												{@const subCount = getSubagentCount(session)}
												<a
													href={resolveRoute('/session/[id]', { id: session.id })}
													data-sveltekit-preload-code="viewport"
													data-sveltekit-preload-data="hover"
													class:active={page.params.id === session.id}
													class="session-row group relative block no-underline"
												>
													<div class="flex items-start justify-between gap-2">
														<span
															class="block truncate text-left text-xs font-semibold group-hover:text-(--accent)"
															title={title(session)}
														>
															{title(session)}
														</span>
														<button
															type="button"
															class="rounded p-0.5 text-(--muted) transition-colors hover:text-amber-400 {isPinned(
																session.id
															)
																? 'text-amber-400 opacity-100'
																: 'opacity-0 group-hover:opacity-100'}"
															title={isPinned(session.id)
																? 'Unpin from favorites'
																: 'Pin to favorites'}
															onclick={(e) => {
																e.preventDefault();
																e.stopPropagation();
																togglePinSession(session.id);
															}}
														>
															<Star
																class="h-3 w-3 {isPinned(session.id)
																	? 'fill-amber-400 text-amber-400'
																	: ''}"
															/>
														</button>
													</div>
													<div
														class="mt-1.5 flex items-center justify-between text-[11px] font-medium text-(--muted)"
													>
														<span class="inline-flex items-center gap-1 font-mono">
															<Clock class="h-3 w-3" />
															{date(session.startedAt)}
														</span>
														<div class="flex shrink-0 items-center gap-1.5">
															{#if subCount > 0}
																<span
																	class="subagent-badge"
																	title="{subCount} subagent{subCount === 1
																		? ''
																		: 's'} used in this session"
																>
																	<Bot class="h-2.5 w-2.5" />
																	<span>{subCount}</span>
																</span>
															{/if}
															<span
																class="inline-flex items-center gap-1 rounded bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold"
																title="{number(latestTokens(session))} tokens used"
															>
																<Zap class="h-3 w-3 text-amber-500" />
																{formatCompactTokens(latestTokens(session))}
															</span>
														</div>
													</div>
												</a>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						{:else}
							<div class="p-6 text-center text-xs text-(--muted)">
								<FolderGit2 class="mx-auto mb-2 h-8 w-8 text-indigo-400 opacity-40" />
								No project repositories found. Switch to Flat view to see all sessions.
							</div>
						{/if}
					{:else}
						<!-- Flat Chronological View with Project Badges -->
						<div class="divide-y divide-(--line)">
							{#each regularSessions() as session (session.id)}
								{@const subCount = getSubagentCount(session)}
								{@const proj = getSessionProject(session)}
								<a
									href={resolveRoute('/session/[id]', { id: session.id })}
									data-sveltekit-preload-code="viewport"
									data-sveltekit-preload-data="hover"
									class:active={page.params.id === session.id}
									class="session-row group relative block no-underline"
								>
									<div class="flex items-start justify-between gap-2">
										<span
											class="block truncate text-left text-xs font-semibold group-hover:text-(--accent)"
											title={title(session)}
										>
											{title(session)}
										</span>
										<button
											type="button"
											class="rounded p-0.5 text-(--muted) transition-colors hover:text-amber-400 {isPinned(
												session.id
											)
												? 'text-amber-400 opacity-100'
												: 'opacity-0 group-hover:opacity-100'}"
											title={isPinned(session.id) ? 'Unpin from favorites' : 'Pin to favorites'}
											onclick={(e) => {
												e.preventDefault();
												e.stopPropagation();
												togglePinSession(session.id);
											}}
										>
											<Star
												class="h-3 w-3 {isPinned(session.id)
													? 'fill-amber-400 text-amber-400'
													: ''}"
											/>
										</button>
									</div>
									<div
										class="mt-1.5 flex items-center justify-between text-[11px] font-medium text-(--muted)"
									>
										<div class="flex min-w-0 items-center gap-2">
											<span class="inline-flex items-center gap-1 font-mono">
												<Clock class="h-3 w-3" />
												{date(session.startedAt)}
											</span>
											{#if proj.name !== 'General / No Project'}
												<span
													class="project-badge max-w-28 truncate"
													title={proj.path ? `Project: ${proj.name}\nLocation: ${proj.path}` : `Project: ${proj.name}`}
												>
													<Folder class="h-2.5 w-2.5" />
													<span class="truncate">{proj.name}</span>
												</span>
											{/if}
										</div>
										<div class="flex shrink-0 items-center gap-1.5">
											{#if subCount > 0}
												<span
													class="subagent-badge"
													title="{subCount} subagent{subCount === 1
														? ''
														: 's'} used in this session"
												>
													<Bot class="h-2.5 w-2.5" />
													<span>{subCount}</span>
												</span>
											{/if}
											<span
												class="inline-flex items-center gap-1 rounded bg-(--panel-subtle) px-1.5 py-0.5 font-mono text-[10px] font-semibold"
												title="{number(latestTokens(session))} tokens used"
											>
												<Zap class="h-3 w-3 text-amber-500" />
												{formatCompactTokens(latestTokens(session))}
											</span>
										</div>
									</div>
								</a>
							{/each}
						</div>
					{/if}
				{:else if sessionFilter === 'pinned' && regularSessions().length === 0}
					<div class="p-8 text-center text-xs text-(--muted)">
						<Star class="mx-auto mb-2 h-8 w-8 text-amber-400 opacity-40" />
						<div class="font-bold text-(--ink)">No pinned sessions yet</div>
						<p class="mt-1 text-[11px]">
							Click the star on any session to pin it here for quick access.
						</p>
					</div>
				{:else if sessionFilter !== 'imported' && importedSessionsList().length === 0}
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
				<button class="import-btn" onclick={() => fileInput?.click()} disabled={importLoading}>
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
						<CircleAlert class="h-3.5 w-3.5 shrink-0" />
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
			{#if navigating.to}
				<SessionSkeleton />
			{:else}
				{@render children()}
			{/if}
		</section>
	</main>
</div>
