import { marked } from 'marked';

const ALLOWED_TAGS = new Set([
	'A',
	'BLOCKQUOTE',
	'BR',
	'CODE',
	'DEL',
	'EM',
	'H1',
	'H2',
	'H3',
	'HR',
	'LI',
	'OL',
	'P',
	'PRE',
	'STRONG',
	'UL',
	'SPAN',
	'DIV',
	'TABLE',
	'THEAD',
	'TBODY',
	'TR',
	'TH',
	'TD',
	'INPUT',
	'DETAILS',
	'SUMMARY'
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
	A: new Set(['href', 'title', 'target', 'rel']),
	CODE: new Set(['class']),
	SPAN: new Set(['class', 'style']),
	DIV: new Set(['class', 'style']),
	TH: new Set(['class', 'style', 'colspan', 'rowspan']),
	TD: new Set(['class', 'style', 'colspan', 'rowspan']),
	TR: new Set(['class']),
	INPUT: new Set(['type', 'checked', 'disabled']),
	DETAILS: new Set(['class', 'style']),
	SUMMARY: new Set(['class', 'style'])
};

const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED']);
const UNSAFE_URL_SCHEMES = ['javascript:', 'vbscript:', 'data:'];

/** Removes dangerous elements outright; other disallowed elements are replaced by their cleaned children. */
function unwrapDisallowed(el: HTMLElement, tag: string) {
	if (DROPPED_TAGS.has(tag)) {
		el.remove();
		return;
	}
	const fragment = document.createDocumentFragment();
	while (el.firstChild) {
		fragment.appendChild(el.firstChild);
	}
	cleanNode(fragment);
	el.replaceWith(fragment);
}

function isAllowedAttribute(tag: string, name: string, value: string): boolean {
	if (name.startsWith('on') || !ALLOWED_ATTRS[tag]?.has(name)) return false;
	if (name !== 'href') return true;
	const url = value.trim().toLowerCase();
	return !UNSAFE_URL_SCHEMES.some((scheme) => url.startsWith(scheme));
}

function cleanAttributes(el: HTMLElement, tag: string) {
	for (const attr of Array.from(el.attributes)) {
		if (!isAllowedAttribute(tag, attr.name.toLowerCase(), attr.value))
			el.removeAttribute(attr.name);
	}
}

function cleanNode(node: Node) {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === Node.COMMENT_NODE) {
			child.remove();
			continue;
		}
		if (child.nodeType !== Node.ELEMENT_NODE) continue;
		const el = child as HTMLElement;
		const tag = el.tagName.toUpperCase();
		if (!ALLOWED_TAGS.has(tag)) {
			unwrapDisallowed(el, tag);
			continue;
		}
		cleanAttributes(el, tag);
		cleanNode(el);
	}
}

export function sanitizeClientHtml(html: string): string {
	if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
		return html;
	}
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');
	cleanNode(doc.body);
	return doc.body.innerHTML;
}

// Injected instruction sections that are collapsed by default. A section runs from its heading line
// up to the next line that starts one of its `ends` markers (or the end of the text).
const CONTEXT_SECTIONS = [
	{
		start: 'agents.md instructions',
		ends: ['codebase knowledge graph', 'rtk (rust token killer)', '<user_request>']
	},
	{
		start: 'codebase knowledge graph',
		ends: ['rtk (rust token killer)', 'agents.md', '<user_request>']
	},
	{
		start: 'rtk (rust token killer)',
		ends: ['agents.md', 'codebase knowledge graph', '<user_request>']
	}
];

function stripHeadingMarks(line: string): string {
	let at = 0;
	while (line[at] === '#') at += 1;
	return at ? line.slice(at).trimStart() : line;
}

function contextBlock(title: string, body: string[]): string {
	return `\n<details class="system-context-block"><summary><strong>${title.trim()}</strong> <span class="system-context-badge">System Context</span></summary><div class="system-context-body">\n\n${body.join('\n').trim()}\n\n</div></details>\n`;
}

function preprocessSystemContext(value: string): string {
	if (!value) return '';
	const out: string[] = [];
	let current:
		{ section: (typeof CONTEXT_SECTIONS)[number]; title: string; body: string[] } | undefined;
	for (const line of value.split('\n')) {
		const heading = stripHeadingMarks(line);
		const lower = heading.toLowerCase();
		if (current?.section.ends.some((marker) => lower.startsWith(marker))) {
			out.push(contextBlock(current.title, current.body));
			current = undefined;
		}
		const section = current
			? undefined
			: CONTEXT_SECTIONS.find((item) => lower.startsWith(item.start));
		if (section) current = { section, title: heading, body: [] };
		else if (current) current.body.push(line);
		else out.push(line);
	}
	if (current) out.push(contextBlock(current.title, current.body));
	return out.join('\n');
}

export function renderMarkdown(value: string): string {
	const preprocessed = preprocessSystemContext(value);
	const rawHtml = marked.parse(preprocessed, { async: false }) as string;
	const html = sanitizeClientHtml(rawHtml);

	// Force all details elements to default collapsed state
	return html.replace(/<details\b([^>]*)>/gi, (match, attrs) => {
		const cleaned = attrs.replace(/\bopen\b(=["']?[^"'\s>]*["']?)?/gi, '');
		return `<details${cleaned}>`;
	});
}

export function toPlainText(markdown: string): string {
	if (!markdown) return '';
	return (
		markdown
			// Remove code block wrappers but keep contents
			.replace(/```[a-z]*\n([\s\S]*?)\n```/gi, '$1')
			// Remove inline code ticks
			.replace(/`([^`]+)`/g, '$1')
			// Remove images ![alt](url) -> alt
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
			// Remove links [text](url) -> text
			.replace(/\[([^[\]]+)\]\([^()]+\)/g, '$1')
			// Remove bold/italic markers (*, _, ~~)
			.replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, '$2')
			// Remove headers (# Header)
			.replace(/^#{1,6}\s+/gm, '')
			// Remove blockquotes (> Quote)
			.replace(/^>\s+/gm, '')
			// Remove list bullets (- item, * item, 1. item)
			.replace(/^[ \t]*[-*+][ \t]+/gm, '')
			.replace(/^[ \t]*\d+\.[ \t]+/gm, '')
			// Remove horizontal rules
			.replace(/^[-*_]{3,}\s*$/gm, '')
			// Clean up excessive blank lines
			.replace(/\n{3,}/g, '\n\n')
			.trim()
	);
}

/**
 * Svelte action to safely render sanitized Markdown HTML without using {@html}
 */
export function markdown(node: HTMLElement, value: string) {
	node.innerHTML = renderMarkdown(value);
	return {
		update(newValue: string) {
			node.innerHTML = renderMarkdown(newValue);
		}
	};
}
