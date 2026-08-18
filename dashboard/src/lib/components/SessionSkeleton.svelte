<script lang="ts">
</script>

<div class="mx-auto max-w-245 space-y-6">
	<!-- Session Overview Header Skeleton -->
	<div class="space-y-4 rounded-xl border border-(--line) bg-(--panel) p-5 shadow-sm sm:p-6">
		<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
			<div class="min-w-0 flex-1 space-y-2.5">
				<div class="flex items-center gap-2">
					<div class="skeleton-box h-4 w-24"></div>
					<div class="skeleton-box h-4 w-16"></div>
				</div>
				<div class="skeleton-box h-7 w-3/4"></div>
				<div class="flex items-center gap-3 pt-1">
					<div class="skeleton-box h-3.5 w-32"></div>
					<div class="skeleton-box h-3.5 w-24"></div>
				</div>
			</div>
			<div
				class="min-w-37.5 space-y-1.5 rounded-lg border border-(--line) bg-(--panel-subtle) p-3 text-right"
			>
				<div class="skeleton-box ml-auto h-3 w-24"></div>
				<div class="skeleton-box ml-auto h-7 w-20"></div>
				<div class="skeleton-box ml-auto h-2.5 w-28"></div>
			</div>
		</div>

		<!-- Tabs Switcher Skeleton -->
		<div class="flex gap-4 border-b border-(--line) pt-2 pb-1">
			<div class="skeleton-box h-7 w-32"></div>
			<div class="skeleton-box h-7 w-40"></div>
		</div>
	</div>

	<!-- Conversation Toolbar Skeleton -->
	<div class="flex items-center justify-between rounded-lg border border-(--line) bg-(--panel) p-3">
		<div class="flex items-center gap-2">
			<div class="skeleton-box h-4 w-12"></div>
			<div class="skeleton-box h-6 w-14"></div>
			<div class="skeleton-box h-6 w-24"></div>
			<div class="skeleton-box h-6 w-24"></div>
		</div>
		<div class="skeleton-box h-4 w-28"></div>
	</div>

	<!-- Chat Messages Timeline Skeleton -->
	<div class="space-y-4">
		<!-- User Prompt Message Skeleton -->
		<div class="space-y-3 rounded-xl border border-(--line) bg-(--user-bg) p-4">
			<div class="flex items-center justify-between">
				<div class="skeleton-box h-5 w-20"></div>
				<div class="skeleton-box h-3.5 w-16"></div>
			</div>
			<div class="space-y-2">
				<div class="skeleton-box h-4 w-full"></div>
				<div class="skeleton-box h-4 w-2/3"></div>
			</div>
		</div>

		<!-- Agent Message Skeleton -->
		<div class="space-y-3 rounded-xl border border-(--line) bg-(--agent-bg) p-4">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					<div class="skeleton-box h-5 w-28"></div>
					<div class="skeleton-box h-4 w-20"></div>
				</div>
				<div class="skeleton-box h-3.5 w-24"></div>
			</div>
			<div class="space-y-2">
				<div class="skeleton-box h-4 w-full"></div>
				<div class="skeleton-box h-4 w-5/6"></div>
				<div class="skeleton-box h-4 w-3/4"></div>
			</div>
			<!-- Tool Activity Accordion Skeleton -->
			<div class="space-y-2 rounded-lg border border-(--line) bg-(--panel) p-3">
				<div class="flex items-center justify-between">
					<div class="skeleton-box h-4 w-48"></div>
					<div class="skeleton-box h-3.5 w-16"></div>
				</div>
			</div>
		</div>
	</div>
</div>
