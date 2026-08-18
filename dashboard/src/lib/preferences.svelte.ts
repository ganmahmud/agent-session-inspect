import { SvelteSet } from 'svelte/reactivity';

// Reactive sets for client-side state
export const pinnedSessions = new SvelteSet<string>();
export const collapsedProjects = new SvelteSet<string>();
export const selectedProjects = new SvelteSet<string>(); // empty means "all"

let isInitialized = false;

export function initPreferences() {
	if (typeof window === 'undefined' || isInitialized) return;
	isInitialized = true;

	// 1. Load Pinned Sessions
	try {
		const rawPinned = localStorage.getItem('asi_pinned_sessions');
		if (rawPinned) {
			const arr = JSON.parse(rawPinned);
			if (Array.isArray(arr)) {
				pinnedSessions.clear();
				for (const id of arr) pinnedSessions.add(id);
			}
		}
	} catch (e) {
		console.warn('Failed to load pinned sessions from localStorage', e);
	}

	// 2. Load Collapsed Projects
	try {
		const rawCollapsed = localStorage.getItem('asi_collapsed_projects');
		if (rawCollapsed) {
			const arr = JSON.parse(rawCollapsed);
			if (Array.isArray(arr)) {
				collapsedProjects.clear();
				for (const key of arr) collapsedProjects.add(key);
			}
		}
	} catch (e) {
		console.warn('Failed to load collapsed projects from localStorage', e);
	}

	// 3. Load Selected Projects
	try {
		const rawSelected = localStorage.getItem('asi_selected_projects');
		if (rawSelected) {
			const arr = JSON.parse(rawSelected);
			if (Array.isArray(arr)) {
				selectedProjects.clear();
				for (const key of arr) selectedProjects.add(key);
			}
		}
	} catch (e) {
		console.warn('Failed to load selected projects from localStorage', e);
	}
}

export function togglePinSession(sessionId: string) {
	if (pinnedSessions.has(sessionId)) {
		pinnedSessions.delete(sessionId);
	} else {
		pinnedSessions.add(sessionId);
	}
	if (typeof window !== 'undefined') {
		localStorage.setItem('asi_pinned_sessions', JSON.stringify(Array.from(pinnedSessions)));
	}
}

export function isPinned(sessionId: string): boolean {
	return pinnedSessions.has(sessionId);
}

export function toggleProjectCollapse(projectKey: string) {
	if (collapsedProjects.has(projectKey)) {
		collapsedProjects.delete(projectKey);
	} else {
		collapsedProjects.add(projectKey);
	}
	if (typeof window !== 'undefined') {
		localStorage.setItem('asi_collapsed_projects', JSON.stringify(Array.from(collapsedProjects)));
	}
}

export function isProjectSelected(projectKey: string): boolean {
	if (selectedProjects.size === 0) return true;
	if (selectedProjects.has('__NONE__')) return false;
	return selectedProjects.has(projectKey);
}

export function toggleProjectSelection(projectKey: string, allKeys: string[]) {
	if (selectedProjects.has('__NONE__')) {
		selectedProjects.delete('__NONE__');
		selectedProjects.add(projectKey);
	} else if (selectedProjects.size === 0) {
		for (const k of allKeys) {
			if (k !== projectKey) selectedProjects.add(k);
		}
	} else {
		if (selectedProjects.has(projectKey)) {
			selectedProjects.delete(projectKey);
			if (selectedProjects.size === 0) {
				selectedProjects.add('__NONE__');
			}
		} else {
			selectedProjects.add(projectKey);
			if (selectedProjects.size === allKeys.length) {
				selectedProjects.clear();
			}
		}
	}
	if (typeof window !== 'undefined') {
		localStorage.setItem('asi_selected_projects', JSON.stringify(Array.from(selectedProjects)));
	}
}

export function selectAllProjects() {
	selectedProjects.clear();
	if (typeof window !== 'undefined') {
		localStorage.removeItem('asi_selected_projects');
	}
}

export function deselectAllProjects() {
	selectedProjects.clear();
	selectedProjects.add('__NONE__');
	if (typeof window !== 'undefined') {
		localStorage.setItem('asi_selected_projects', JSON.stringify(['__NONE__']));
	}
}

export function clearSelectedProjects() {
	selectedProjects.clear();
	if (typeof window !== 'undefined') {
		localStorage.removeItem('asi_selected_projects');
	}
}
