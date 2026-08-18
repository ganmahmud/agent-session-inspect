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

function cleanNode(node: Node) {
	const children = Array.from(node.childNodes);
	for (const child of children) {
		if (child.nodeType === 1) {
			// Element node
			const el = child as HTMLElement;
			const tag = el.tagName.toUpperCase();

			if (!ALLOWED_TAGS.has(tag)) {
				if (
					tag === 'SCRIPT' ||
					tag === 'STYLE' ||
					tag === 'IFRAME' ||
					tag === 'OBJECT' ||
					tag === 'EMBED'
				) {
					el.remove();
				} else {
					const fragment = document.createDocumentFragment();
					while (el.firstChild) {
						fragment.appendChild(el.firstChild);
					}
					cleanNode(fragment);
					el.replaceWith(fragment);
				}
				continue;
			}

			const allowedAttrs = ALLOWED_ATTRS[tag];
			const attrs = Array.from(el.attributes);
			for (const attr of attrs) {
				const attrName = attr.name.toLowerCase();

				if (attrName.startsWith('on')) {
					el.removeAttribute(attr.name);
					continue;
				}

				if (!allowedAttrs || !allowedAttrs.has(attrName)) {
					el.removeAttribute(attr.name);
					continue;
				}

				if (attrName === 'href') {
					const val = attr.value.trim().toLowerCase();
					if (
						val.startsWith('javascript:') ||
						val.startsWith('vbscript:') ||
						val.startsWith('data:')
					) {
						el.removeAttribute(attr.name);
					}
				}
			}

			cleanNode(el);
		} else if (child.nodeType === 8) {
			// Comment node
			child.remove();
		}
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

function preprocessSystemContext(value: string): string {
	if (!value) return '';

	let processed = value;

	// Wrap AGENTS.md instructions section
	processed = processed.replace(
		/(?:^|\n)(#+\s*)?(AGENTS\.md instructions[^\n]*)\n([\s\S]*?)(?=\n(?:#+\s*)?(?:Codebase Knowledge Graph|RTK \(Rust Token Killer\)|<USER_REQUEST>|$)|$)/gi,
		(match, hash, title, content) => {
			return `\n\n<details class="system-context-block"><summary><strong>${title.trim()}</strong> <span class="system-context-badge">System Context</span></summary><div class="system-context-body">\n\n${content.trim()}\n\n</div></details>\n\n`;
		}
	);

	// Wrap Codebase Knowledge Graph section
	processed = processed.replace(
		/(?:^|\n)(#+\s*)?(Codebase Knowledge Graph[^\n]*)\n([\s\S]*?)(?=\n(?:#+\s*)?(?:RTK \(Rust Token Killer\)|AGENTS\.md|<USER_REQUEST>|$)|$)/gi,
		(match, hash, title, content) => {
			return `\n\n<details class="system-context-block"><summary><strong>${title.trim()}</strong> <span class="system-context-badge">System Context</span></summary><div class="system-context-body">\n\n${content.trim()}\n\n</div></details>\n\n`;
		}
	);

	// Wrap RTK (Rust Token Killer) section
	processed = processed.replace(
		/(?:^|\n)(#+\s*)?(RTK \(Rust Token Killer\)[^\n]*)\n([\s\S]*?)(?=\n(?:#+\s*)?(?:AGENTS\.md|Codebase Knowledge Graph|<USER_REQUEST>|$)|$)/gi,
		(match, hash, title, content) => {
			return `\n\n<details class="system-context-block"><summary><strong>${title.trim()}</strong> <span class="system-context-badge">System Context</span></summary><div class="system-context-body">\n\n${content.trim()}\n\n</div></details>\n\n`;
		}
	);

	return processed;
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
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			// Remove bold/italic markers (*, _, ~~)
			.replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, '$2')
			// Remove headers (# Header)
			.replace(/^#{1,6}\s+/gm, '')
			// Remove blockquotes (> Quote)
			.replace(/^>\s+/gm, '')
			// Remove list bullets (- item, * item, 1. item)
			.replace(/^[\s]*[-*+]\s+/gm, '')
			.replace(/^[\s]*\d+\.\s+/gm, '')
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
