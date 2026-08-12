import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const allowedTags = ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'ul'];

export function renderMarkdown(value: string): string {
	return sanitizeHtml(marked.parse(value, { async: false }), {
		allowedTags,
		allowedAttributes: { a: ['href', 'title'], code: ['class'] },
		allowedSchemes: ['http', 'https', 'mailto']
	});
}
