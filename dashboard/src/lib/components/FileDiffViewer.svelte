<script lang="ts">
	import {
		Copy,
		Check,
		Search,
		ChevronRight,
		GitCommit,
		Plus,
		Minus,
		FileCode,
		Download
	} from '@lucide/svelte';
	import type { SessionFileChangesSummary, FileChangeRecord } from '$lib/diff-parser';
	import { highlight } from '$lib/syntax-highlighter';

	interface Props {
		summary: SessionFileChangesSummary;
		initialSelectedPath?: string;
		onClose?: () => void;
	}

	let { summary, initialSelectedPath, onClose }: Props = $props();

	let searchQuery = $state('');
	let selectedPath = $state<string | undefined>(undefined);
	let activeSelectedPath = $derived(
		selectedPath || initialSelectedPath || summary.files[0]?.path || ''
	);
	let copiedAll = $state(false);
	let copiedPath = $state<string | null>(null);
	let copiedDiff = $state<string | null>(null);
	let viewMode = $state<'split' | 'flow'>('split'); // split: sidebar + current file; flow: all diffs in vertical stream

	// Filtered files list
	let filteredFiles = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return summary.files;
		return summary.files.filter(
			(f) => f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q)
		);
	});

	// Ensure selected file remains valid when list filters
	$effect(() => {
		if (filteredFiles.length > 0 && !filteredFiles.some((f) => f.path === activeSelectedPath)) {
			selectedPath = filteredFiles[0].path;
		}
	});

	let selectedFile = $derived.by(() => {
		return summary.files.find((f) => f.path === activeSelectedPath) || filteredFiles[0];
	});

	function copyAllDiffs() {
		const fullText = summary.files
			.map((f) => `### File: ${f.path} (${f.operation})\n\n${f.diffs.join('\n\n')}`)
			.join('\n\n---\n\n');
		navigator.clipboard.writeText(fullText);
		copiedAll = true;
		setTimeout(() => (copiedAll = false), 2000);
	}

	function copyFilePath(path: string, e?: Event) {
		if (e) e.stopPropagation();
		navigator.clipboard.writeText(path);
		copiedPath = path;
		setTimeout(() => {
			if (copiedPath === path) copiedPath = null;
		}, 2000);
	}

	function copyFileDiff(file: FileChangeRecord, e?: Event) {
		if (e) e.stopPropagation();
		const diffText = file.diffs.join('\n\n');
		navigator.clipboard.writeText(diffText);
		copiedDiff = file.path;
		setTimeout(() => {
			if (copiedDiff === file.path) copiedDiff = null;
		}, 2000);
	}

	function downloadPatchFile() {
		const patchContent = summary.files
			.map((f) => {
				return `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n${f.diffs.join('\n')}`;
			})
			.join('\n\n');

		const blob = new Blob([patchContent], { type: 'text/x-diff' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `session-changes-${Date.now()}.patch`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	const numberFormat = (n: number) => new Intl.NumberFormat('en-US').format(n);
</script>

<div class="file-diff-workbench space-y-4">
	<!-- Top Diff Header Toolbar -->
	<div
		class="flex flex-col gap-3 rounded-xl border border-(--line) bg-(--panel) p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between"
	>
		<div class="flex flex-wrap items-center gap-3">
			<div class="flex items-center gap-2">
				<div
					class="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
				>
					<GitCommit class="h-4.5 w-4.5" />
				</div>
				<div>
					<div class="flex items-center gap-2">
						<h3 class="text-sm font-bold text-(--ink) sm:text-base">
							File Changes & Modifications
						</h3>
						<span
							class="rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 font-mono text-xs font-bold text-emerald-400"
						>
							{summary.totalFiles} file{summary.totalFiles === 1 ? '' : 's'}
						</span>
					</div>
					<div class="flex items-center gap-3 font-mono text-xs text-(--muted)">
						<span class="inline-flex items-center gap-1 font-semibold text-emerald-400">
							<Plus class="h-3 w-3" />
							{numberFormat(summary.totalAdditions)} additions
						</span>
						<span>·</span>
						<span class="inline-flex items-center gap-1 font-semibold text-rose-400">
							<Minus class="h-3 w-3" />
							{numberFormat(summary.totalDeletions)} deletions
						</span>
						{#if summary.totalEdits > summary.totalFiles}
							<span>·</span>
							<span>{summary.totalEdits} patch operations</span>
						{/if}
					</div>
				</div>
			</div>
		</div>

		<!-- Toolbar Actions -->
		<div class="flex flex-wrap items-center gap-2">
			<!-- Mode switch -->
			<div class="flex items-center rounded-lg border border-(--line) bg-(--panel-subtle) p-0.5">
				<button
					type="button"
					class="rounded-md px-2.5 py-1 text-xs font-semibold transition-colors {viewMode ===
					'split'
						? 'bg-(--field) text-(--ink) shadow-xs'
						: 'text-(--muted) hover:text-(--ink)'}"
					onclick={() => (viewMode = 'split')}
					title="Sidebar file picker + diff view"
				>
					Selected File
				</button>
				<button
					type="button"
					class="rounded-md px-2.5 py-1 text-xs font-semibold transition-colors {viewMode === 'flow'
						? 'bg-(--field) text-(--ink) shadow-xs'
						: 'text-(--muted) hover:text-(--ink)'}"
					onclick={() => (viewMode = 'flow')}
					title="All files in single vertical stream"
				>
					All Diffs Stream
				</button>
			</div>

			<button
				type="button"
				class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-(--line) bg-(--panel-subtle) px-3 py-1.5 font-mono text-xs text-(--muted) transition-all hover:border-(--accent) hover:bg-(--panel) hover:text-(--ink)"
				onclick={copyAllDiffs}
				title="Copy all diffs to clipboard"
			>
				{#if copiedAll}
					<Check class="h-3.5 w-3.5 text-emerald-400" />
					<span class="font-bold text-emerald-400">Copied All</span>
				{:else}
					<Copy class="h-3.5 w-3.5" />
					<span>Copy All Diffs</span>
				{/if}
			</button>

			<button
				type="button"
				class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 font-mono text-xs font-semibold text-emerald-400 transition-all hover:bg-emerald-500/20"
				onclick={downloadPatchFile}
				title="Download unified .patch file"
			>
				<Download class="h-3.5 w-3.5" />
				<span>Download .patch</span>
			</button>

			{#if onClose}
				<button
					type="button"
					class="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-(--line) bg-(--panel-subtle) px-2.5 py-1.5 text-xs text-(--muted) hover:text-(--ink)"
					onclick={onClose}
				>
					Close
				</button>
			{/if}
		</div>
	</div>

	<!-- Main Workbench Body -->
	{#if summary.files.length === 0}
		<div
			class="rounded-xl border border-(--line) bg-(--panel) p-12 text-center text-xs text-(--muted)"
		>
			<FileCode class="mx-auto mb-2 h-8 w-8 text-(--muted)/50" />
			<p class="font-semibold">No file modifications recorded in this session.</p>
			<p class="mt-1 text-[11px] text-(--muted)/80">
				Apply patch and edit tool outputs will appear here when files are changed.
			</p>
		</div>
	{:else if viewMode === 'split'}
		<!-- Split View: Left File List + Right Active Diff Viewer -->
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-12">
			<!-- Left File Selector Sidebar -->
			<div class="space-y-2 lg:col-span-4">
				<div class="relative">
					<Search class="absolute top-2.5 left-2.5 h-3.5 w-3.5 text-(--muted)" />
					<input
						type="text"
						bind:value={searchQuery}
						placeholder="Filter changed files ({summary.files.length})..."
						class="w-full rounded-lg border border-(--line) bg-(--field) py-1.5 pr-3 pl-8 font-mono text-xs text-(--ink) placeholder:text-(--muted)/60 focus:border-emerald-500/50 focus:outline-none"
					/>
				</div>

				<div
					class="max-h-150 space-y-1 overflow-y-auto rounded-xl border border-(--line) bg-(--panel) p-2 shadow-xs"
				>
					{#if filteredFiles.length === 0}
						<p class="p-4 text-center text-xs text-(--muted)">No files match "{searchQuery}"</p>
					{:else}
						{#each filteredFiles as file (file.path)}
							<button
								type="button"
								class="group flex w-full cursor-pointer items-center justify-between rounded-lg p-2.5 text-left transition-all {activeSelectedPath ===
								file.path
									? 'border border-emerald-500/40 bg-emerald-500/10 text-(--ink)'
									: 'border border-transparent text-(--muted) hover:bg-(--panel-subtle) hover:text-(--ink)'}"
								onclick={() => (selectedPath = file.path)}
							>
								<div class="flex min-w-0 items-center gap-2">
									<!-- Status Badge Pill -->
									<span
										class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold uppercase {file.status ===
										'added'
											? 'bg-emerald-500/20 text-emerald-400'
											: file.status === 'deleted'
												? 'bg-rose-500/20 text-rose-400'
												: 'bg-sky-500/20 text-sky-400'}"
										title={file.operation}
									>
										{file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
									</span>

									<div class="min-w-0 flex-1">
										<p class="truncate font-mono text-xs font-bold text-(--ink)">
											{file.basename}
										</p>
										<p class="truncate font-mono text-[10px] text-(--muted)/80">
											{file.directory}
										</p>
									</div>
								</div>

								<div class="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
									{#if file.additions > 0}
										<span class="font-bold text-emerald-400">+{file.additions}</span>
									{/if}
									{#if file.deletions > 0}
										<span class="font-bold text-rose-400">-{file.deletions}</span>
									{/if}
									<ChevronRight
										class="h-3 w-3 text-(--muted) transition-transform {selectedPath === file.path
											? 'text-emerald-400'
											: ''}"
									/>
								</div>
							</button>
						{/each}
					{/if}
				</div>
			</div>

			<!-- Right Diff Canvas for Selected File -->
			<div class="space-y-3 lg:col-span-8">
				{#if selectedFile}
					<div class="diff-file-card rounded-xl border border-(--line) bg-(--panel) shadow-xs">
						<!-- File Banner Header -->
						<div
							class="flex flex-wrap items-center justify-between gap-2 border-b border-(--line) bg-(--panel-subtle)/50 p-3 px-4"
						>
							<div class="flex min-w-0 items-center gap-2 font-mono text-xs">
								<FileCode class="h-4 w-4 shrink-0 text-emerald-400" />
								<span
									class="truncate font-bold text-(--ink)"
									title={selectedFile.path}
								>
									{selectedFile.path}
								</span>
								<span
									class="rounded border border-(--line) bg-(--field) px-1.5 py-0.5 text-[10px] font-semibold text-(--muted) uppercase"
								>
									{selectedFile.operation}
								</span>
							</div>

							<div class="flex items-center gap-2">
								<div class="flex items-center gap-1.5 font-mono text-xs">
									<span class="rounded bg-emerald-500/10 px-1.5 py-0.5 font-bold text-emerald-400">
										+{selectedFile.additions}
									</span>
									<span class="rounded bg-rose-500/10 px-1.5 py-0.5 font-bold text-rose-400">
										-{selectedFile.deletions}
									</span>
								</div>

								<button
									type="button"
									class="inline-flex cursor-pointer items-center gap-1 rounded border border-(--line) bg-(--field) px-2 py-1 font-mono text-[11px] text-(--muted) hover:text-(--ink)"
									onclick={(e) => copyFilePath(selectedFile.path, e)}
									title="Copy file path"
								>
									{#if copiedPath === selectedFile.path}
										<Check class="h-3 w-3 text-emerald-400" />
										<span class="text-[10px] text-emerald-400">Copied</span>
									{:else}
										<Copy class="h-3 w-3" />
										<span class="text-[10px]">Path</span>
									{/if}
								</button>

								<button
									type="button"
									class="inline-flex cursor-pointer items-center gap-1 rounded border border-(--line) bg-(--field) px-2 py-1 font-mono text-[11px] text-(--muted) hover:text-(--ink)"
									onclick={(e) => copyFileDiff(selectedFile, e)}
									title="Copy diff text"
								>
									{#if copiedDiff === selectedFile.path}
										<Check class="h-3 w-3 text-emerald-400" />
										<span class="text-[10px] text-emerald-400">Copied</span>
									{:else}
										<Copy class="h-3 w-3" />
										<span class="text-[10px]">Diff</span>
									{/if}
								</button>
							</div>
						</div>

						<!-- Parsed Diffs Container -->
						<div class="overflow-x-auto p-0 font-mono text-xs">
							{#if selectedFile.parsedDiffs.length}
								{#each selectedFile.parsedDiffs as parsed, pIdx (pIdx)}
									{#if selectedFile.parsedDiffs.length > 1}
										<div
											class="border-b border-(--line-subtle) bg-(--field) px-3 py-1 text-[10px] font-bold text-(--muted)"
										>
											Patch #{pIdx + 1}
										</div>
									{/if}
									{#each parsed.hunks as hunk, hIdx (hIdx)}
										<div class="diff-hunk">
											<div class="diff-hunk-header">
												{hunk.header}
											</div>
											<table class="diff-table w-full border-collapse">
												<tbody>
													{#each hunk.lines as line, lIdx (lIdx)}
														{#if line.type !== 'hunk-header'}
															<tr
																class="diff-row"
																class:diff-row-add={line.type === 'add'}
																class:diff-row-del={line.type === 'del'}
																class:diff-row-context={line.type === 'context'}
																class:diff-row-meta={line.type === 'meta'}
															>
																<td class="diff-gutter-num select-none">
																	{line.oldLineNumber ?? ''}
																</td>
																<td class="diff-gutter-num select-none">
																	{line.newLineNumber ?? ''}
																</td>
																<td class="diff-gutter-marker select-none">
																	{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
																</td>
																<td class="diff-line-content">
																	<pre
																		class="m-0 bg-transparent p-0 font-mono text-xs whitespace-pre-wrap"
																		use:highlight={{ code: line.content || ' ', path: selectedFile.path }}
																	></pre>
																</td>
															</tr>
														{/if}
													{/each}
												</tbody>
											</table>
										</div>
									{/each}
								{/each}
							{:else if selectedFile.diffs.length}
								<!-- Fallback for raw diff string if no hunks parsed -->
								<pre class="m-0 bg-(--field) p-4 font-mono text-xs whitespace-pre-wrap text-(--ink)">{selectedFile.diffs.join('\n\n')}</pre>
							{:else}
								<div class="p-6 text-center text-xs text-(--muted)">
									File was marked as modified, but no unified diff was captured.
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		</div>
	{:else}
		<!-- Flow View: All Files in Continuous Stream -->
		<div class="space-y-4">
			{#each filteredFiles as file (file.path)}
				<div class="diff-file-card rounded-xl border border-(--line) bg-(--panel) shadow-xs">
					<!-- File Header -->
					<div
						class="flex flex-wrap items-center justify-between gap-2 border-b border-(--line) bg-(--panel-subtle)/50 p-3 px-4"
					>
						<div class="flex min-w-0 items-center gap-2 font-mono text-xs">
							<span
								class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold uppercase {file.status ===
								'added'
									? 'bg-emerald-500/20 text-emerald-400'
									: file.status === 'deleted'
										? 'bg-rose-500/20 text-rose-400'
										: 'bg-sky-500/20 text-sky-400'}"
							>
								{file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
							</span>
							<b class="truncate text-(--ink)">{file.path}</b>
							<span
								class="rounded border border-(--line) bg-(--field) px-1.5 py-0.5 text-[10px] text-(--muted) uppercase"
							>
								{file.operation}
							</span>
						</div>

						<div class="flex items-center gap-2">
							<div class="flex items-center gap-1.5 font-mono text-xs">
								<span class="rounded bg-emerald-500/10 px-1.5 py-0.5 font-bold text-emerald-400">
									+{file.additions}
								</span>
								<span class="rounded bg-rose-500/10 px-1.5 py-0.5 font-bold text-rose-400">
									-{file.deletions}
								</span>
							</div>

							<button
								type="button"
								class="inline-flex cursor-pointer items-center gap-1 rounded border border-(--line) bg-(--field) px-2 py-1 font-mono text-[11px] text-(--muted) hover:text-(--ink)"
								onclick={(e) => copyFilePath(file.path, e)}
							>
								{#if copiedPath === file.path}
									<Check class="h-3 w-3 text-emerald-400" />
									<span class="text-[10px] text-emerald-400">Copied</span>
								{:else}
									<Copy class="h-3 w-3" />
									<span class="text-[10px]">Path</span>
								{/if}
							</button>

							<button
								type="button"
								class="inline-flex cursor-pointer items-center gap-1 rounded border border-(--line) bg-(--field) px-2 py-1 font-mono text-[11px] text-(--muted) hover:text-(--ink)"
								onclick={(e) => copyFileDiff(file, e)}
							>
								{#if copiedDiff === file.path}
									<Check class="h-3 w-3 text-emerald-400" />
									<span class="text-[10px] text-emerald-400">Copied</span>
								{:else}
									<Copy class="h-3 w-3" />
									<span class="text-[10px]">Diff</span>
								{/if}
							</button>
						</div>
					</div>

					<!-- Parsed Hunks Stream -->
					<div class="overflow-x-auto p-0 font-mono text-xs">
						{#if file.parsedDiffs.length}
							{#each file.parsedDiffs as parsed, pIdx (pIdx)}
								{#each parsed.hunks as hunk, hIdx (hIdx)}
									<div class="diff-hunk">
										<div class="diff-hunk-header">
											{hunk.header}
										</div>
										<table class="diff-table w-full border-collapse">
											<tbody>
												{#each hunk.lines as line, lIdx (lIdx)}
													{#if line.type !== 'hunk-header'}
														<tr
															class="diff-row"
															class:diff-row-add={line.type === 'add'}
															class:diff-row-del={line.type === 'del'}
															class:diff-row-context={line.type === 'context'}
															class:diff-row-meta={line.type === 'meta'}
														>
															<td class="diff-gutter-num select-none">
																{line.oldLineNumber ?? ''}
															</td>
															<td class="diff-gutter-num select-none">
																{line.newLineNumber ?? ''}
															</td>
															<td class="diff-gutter-marker select-none">
																{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
															</td>
															<td class="diff-line-content">
																<pre
																	class="m-0 bg-transparent p-0 font-mono text-xs whitespace-pre-wrap"
																	use:highlight={{ code: line.content || ' ', path: file.path }}
																></pre>
															</td>
														</tr>
													{/if}
												{/each}
											</tbody>
										</table>
									</div>
								{/each}
							{/each}
						{:else if file.diffs.length}
							<pre class="m-0 bg-(--field) p-4 font-mono text-xs whitespace-pre-wrap text-(--ink)">{file.diffs.join('\n\n')}</pre>
						{:else}
							<div class="p-6 text-center text-xs text-(--muted)">
								File was modified, no unified diff available.
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.diff-hunk {
		border-bottom: 1px solid var(--line-subtle);
	}
	.diff-hunk:last-child {
		border-bottom: none;
	}

	.diff-hunk-header {
		padding: 4px 12px;
		background: rgba(99, 102, 241, 0.12);
		color: #a5b4fc;
		font-family: monospace;
		font-size: 11px;
		border-top: 1px solid rgba(99, 102, 241, 0.2);
		border-bottom: 1px solid rgba(99, 102, 241, 0.2);
	}

	.diff-table {
		width: 100%;
		border-collapse: collapse;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 12px;
		line-height: 1.45;
	}

	.diff-table td {
		border-bottom: none;
		padding: 0;
	}

	.diff-row {
		border: none;
	}

	.diff-row-add {
		background: rgba(74, 222, 128, 0.12);
		color: #4ade80;
	}

	.diff-row-del {
		background: rgba(248, 113, 113, 0.14);
		color: #f87171;
	}

	.diff-row-context {
		background: transparent;
		color: var(--ink);
	}

	.diff-row-meta {
		background: var(--field);
		color: var(--muted);
		font-style: italic;
	}

	.diff-gutter-num {
		width: 42px;
		min-width: 42px;
		max-width: 42px;
		padding: 1px 6px;
		text-align: right;
		font-size: 11px;
		color: var(--muted);
		opacity: 0.55;
		border-right: 1px solid var(--line-subtle);
		user-select: none;
		vertical-align: top;
		white-space: nowrap;
	}

	.diff-gutter-marker {
		width: 20px;
		min-width: 20px;
		max-width: 20px;
		text-align: center;
		padding: 1px 0;
		font-weight: bold;
		user-select: none;
		vertical-align: top;
		white-space: nowrap;
	}

	.diff-row-add .diff-gutter-marker {
		color: #4ade80;
	}

	.diff-row-del .diff-gutter-marker {
		color: #f87171;
	}

	.diff-line-content {
		padding: 1px 12px;
		width: 100%;
		text-align: left;
		vertical-align: top;
		overflow-x: auto;
	}

	.diff-line-content pre {
		margin: 0;
		padding: 0;
		text-align: left;
		white-space: pre-wrap;
		word-break: break-all;
		tab-size: 2;
	}
</style>
