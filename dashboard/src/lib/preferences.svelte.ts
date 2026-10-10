import { SvelteSet } from 'svelte/reactivity';

// Reactive sets for client-side state
export const pinnedSessions = new SvelteSet<string>();
export const collapsedProjects = new SvelteSet<string>();
export const selectedProjects = new SvelteSet<string>(); // empty means "all"

const PINNED_KEY = 'asi_pinned_sessions';
const COLLAPSED_KEY = 'asi_collapsed_projects';
const SELECTED_KEY = 'asi_selected_projects';
const NONE = '__NONE__';

let isInitialized = false;

function loadSet(target: SvelteSet<string>, key: string, label: string) {
	try {
		const raw = localStorage.getItem(key);
		const values: unknown = raw ? JSON.parse(raw) : undefined;
		if (!Array.isArray(values)) return;
		target.clear();
		for (const value of values) target.add(value);
	} catch (e) {
		console.warn(`Failed to load ${label} from localStorage`, e);
	}
}

function saveSet(target: SvelteSet<string>, key: string) {
	if (typeof window !== 'undefined') localStorage.setItem(key, JSON.stringify(Array.from(target)));
}

function toggle(target: SvelteSet<string>, value: string) {
	if (target.has(value)) target.delete(value);
	else target.add(value);
}

export function initPreferences() {
	if (typeof window === 'undefined' || isInitialized) return;
	isInitialized = true;
	loadSet(pinnedSessions, PINNED_KEY, 'pinned sessions');
	loadSet(collapsedProjects, COLLAPSED_KEY, 'collapsed projects');
	loadSet(selectedProjects, SELECTED_KEY, 'selected projects');
}

export function togglePinSession(sessionId: string) {
	toggle(pinnedSessions, sessionId);
	saveSet(pinnedSessions, PINNED_KEY);
}

export function isPinned(sessionId: string): boolean {
	return pinnedSessions.has(sessionId);
}

export function toggleProjectCollapse(projectKey: string) {
	toggle(collapsedProjects, projectKey);
	saveSet(collapsedProjects, COLLAPSED_KEY);
}

export function isProjectSelected(projectKey: string): boolean {
	if (selectedProjects.size === 0) return true;
	if (selectedProjects.has(NONE)) return false;
	return selectedProjects.has(projectKey);
}

export function toggleProjectSelection(projectKey: string, allKeys: string[]) {
	if (selectedProjects.has(NONE)) {
		// Nothing selected: start a selection with this project.
		selectedProjects.delete(NONE);
		selectedProjects.add(projectKey);
	} else if (selectedProjects.size === 0) {
		// Everything selected: deselect just this project.
		for (const k of allKeys) {
			if (k !== projectKey) selectedProjects.add(k);
		}
	} else {
		toggle(selectedProjects, projectKey);
		if (selectedProjects.size === 0) selectedProjects.add(NONE);
		else if (selectedProjects.size === allKeys.length) selectedProjects.clear();
	}
	saveSet(selectedProjects, SELECTED_KEY);
}

export function selectAllProjects() {
	selectedProjects.clear();
	if (typeof window !== 'undefined') {
		localStorage.removeItem(SELECTED_KEY);
	}
}

export function deselectAllProjects() {
	selectedProjects.clear();
	selectedProjects.add(NONE);
	saveSet(selectedProjects, SELECTED_KEY);
}

/** Same as selecting all: an empty selection means every project. */
export function clearSelectedProjects() {
	selectAllProjects();
}
