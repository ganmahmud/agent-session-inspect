/**
 * High-performance, lightweight, multi-language syntax tokenizing highlighter for diff viewers.
 * Produces safe HTML token spans that preserve whitespace and indentation.
 */

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

export type SupportedLanguage =
	| 'typescript'
	| 'javascript'
	| 'svelte'
	| 'html'
	| 'css'
	| 'json'
	| 'python'
	| 'go'
	| 'rust'
	| 'shell'
	| 'sql'
	| 'markdown'
	| 'yaml'
	| 'generic';

export function detectLanguage(filePath?: string): SupportedLanguage {
	if (!filePath) return 'generic';
	const ext = filePath.split('.').pop()?.toLowerCase();
	switch (ext) {
		case 'ts':
		case 'tsx':
		case 'mts':
		case 'cts':
			return 'typescript';
		case 'js':
		case 'jsx':
		case 'mjs':
		case 'cjs':
			return 'javascript';
		case 'svelte':
			return 'svelte';
		case 'html':
		case 'htm':
		case 'xml':
		case 'svg':
			return 'html';
		case 'css':
		case 'scss':
		case 'less':
			return 'css';
		case 'json':
		case 'jsonl':
		case 'jsonc':
			return 'json';
		case 'py':
		case 'pyw':
			return 'python';
		case 'go':
			return 'go';
		case 'rs':
			return 'rust';
		case 'sh':
		case 'bash':
		case 'zsh':
			return 'shell';
		case 'sql':
			return 'sql';
		case 'md':
		case 'markdown':
		case 'mdx':
			return 'markdown';
		case 'yaml':
		case 'yml':
			return 'yaml';
		default:
			return 'generic';
	}
}

interface Rule {
	pattern: RegExp;
	cls: string;
}

const JS_TS_RULES: Rule[] = [
	{ pattern: /\/\/[^\n]*/g, cls: 'syn-cmt' },
	{ pattern: /\/\*[\s\S]*?\*\//g, cls: 'syn-cmt' },
	{ pattern: /`(?:\\[\s\S]|[^`\\])*`/g, cls: 'syn-str' },
	{ pattern: /"(?:\\[\s\S]|[^"\\])*"/g, cls: 'syn-str' },
	{ pattern: /'(?:\\[\s\S]|[^'\\])*'/g, cls: 'syn-str' },
	{
		pattern:
			/\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|class|extends|interface|type|enum|implements|public|private|protected|readonly|static|get|set|async|await|yield|import|export|from|as|new|delete|typeof|instanceof|void|this|super|throw|try|catch|finally)\b/g,
		cls: 'syn-kwd'
	},
	{ pattern: /\b(true|false|null|undefined|NaN|Infinity)\b/g, cls: 'syn-lit' },
	{
		pattern:
			/\b(string|number|boolean|symbol|bigint|any|unknown|never|void|object|Array|Record|Promise|Map|Set|Date|RegExp|Error)\b/g,
		cls: 'syn-typ'
	},
	{ pattern: /\b([A-Z][a-zA-Z0-9_$]*)\b/g, cls: 'syn-typ' },
	{ pattern: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g, cls: 'syn-fn' },
	{ pattern: /\b0x[a-fA-F0-9]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, cls: 'syn-num' },
	{
		pattern: /(=>|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|&|\||\^|~|<<|>>|\?|:)/g,
		cls: 'syn-op'
	}
];

const JSON_RULES: Rule[] = [
	{ pattern: /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/g, cls: 'syn-prop' },
	{ pattern: /"(?:\\[\s\S]|[^"\\])*"/g, cls: 'syn-str' },
	{ pattern: /\b(true|false|null)\b/g, cls: 'syn-lit' },
	{ pattern: /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, cls: 'syn-num' }
];

const SVELTE_HTML_RULES: Rule[] = [
	{ pattern: /<!--[\s\S]*?-->/g, cls: 'syn-cmt' },
	{ pattern: /\{#(if|each|await|key|snippet)\b[^}]*\}/g, cls: 'syn-block' },
	{ pattern: /\{:(else|then|catch)\b[^}]*\}/g, cls: 'syn-block' },
	{ pattern: /\{\/(if|each|await|key|snippet)\}/g, cls: 'syn-block' },
	{ pattern: /<\/?[a-zA-Z0-9_:-]+(?=[\s>/]|$)/g, cls: 'syn-tag' },
	{ pattern: /\b[a-zA-Z0-9_:-]+(?==)/g, cls: 'syn-attr' },
	{ pattern: /"[^"]*"|'[^']*'/g, cls: 'syn-str' },
	{ pattern: /\{[^{}]*\}/g, cls: 'syn-expr' }
];

const CSS_RULES: Rule[] = [
	{ pattern: /\/\*[\s\S]*?\*\//g, cls: 'syn-cmt' },
	{ pattern: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, cls: 'syn-str' },
	{ pattern: /@[a-zA-Z-]+/g, cls: 'syn-kwd' },
	{ pattern: /--[a-zA-Z0-9_-]+/g, cls: 'syn-var' },
	{ pattern: /\b[a-zA-Z-]+(?=\s*:)/g, cls: 'syn-prop' },
	{ pattern: /#[a-fA-F0-9]{3,8}\b/g, cls: 'syn-num' },
	{ pattern: /\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms|deg|fr)\b/g, cls: 'syn-num' },
	{
		pattern:
			/\b(important|auto|inherit|initial|none|block|flex|grid|absolute|relative|fixed|sticky)\b/g,
		cls: 'syn-lit'
	}
];

const PYTHON_RULES: Rule[] = [
	{ pattern: /#[^\n]*/g, cls: 'syn-cmt' },
	{ pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''/g, cls: 'syn-cmt' },
	{ pattern: /f?"(?:\\[\s\S]|[^"\\])*"|f?'(?:\\[\s\S]|[^'\\])*'/g, cls: 'syn-str' },
	{
		pattern:
			/\b(def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|global|nonlocal|lambda|pass|break|continue|yield|async|await|raise|assert|del|in|is|not|and|or)\b/g,
		cls: 'syn-kwd'
	},
	{ pattern: /\b(True|False|None)\b/g, cls: 'syn-lit' },
	{ pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, cls: 'syn-typ' },
	{ pattern: /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=\()/g, cls: 'syn-fn' },
	{ pattern: /\b0x[a-fA-F0-9]+\b|\b\d+(?:\.\d+)?\b/g, cls: 'syn-num' },
	{ pattern: /(@[a-zA-Z0-9_.]+)/g, cls: 'syn-var' }
];

const GO_RULES: Rule[] = [
	{ pattern: /\/\/[^\n]*/g, cls: 'syn-cmt' },
	{ pattern: /\/\*[\s\S]*?\*\//g, cls: 'syn-cmt' },
	{ pattern: /`[^`]*`|"(?:\\[\s\S]|[^"\\])*"/g, cls: 'syn-str' },
	{
		pattern:
			/\b(package|import|func|return|var|type|struct|interface|map|chan|const|if|else|for|range|switch|case|default|select|go|defer|break|continue|fallthrough)\b/g,
		cls: 'syn-kwd'
	},
	{ pattern: /\b(true|false|nil|iota)\b/g, cls: 'syn-lit' },
	{
		pattern:
			/\b(string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|bool|byte|rune|error|any)\b/g,
		cls: 'syn-typ'
	},
	{ pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, cls: 'syn-typ' },
	{ pattern: /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=\()/g, cls: 'syn-fn' },
	{ pattern: /\b\d+(?:\.\d+)?\b/g, cls: 'syn-num' }
];

const SHELL_RULES: Rule[] = [
	{ pattern: /#[^\n]*/g, cls: 'syn-cmt' },
	{ pattern: /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/g, cls: 'syn-str' },
	{ pattern: /\$[a-zA-Z0-9_]+|\$\{[^}]+\}/g, cls: 'syn-var' },
	{
		pattern:
			/\b(if|then|else|elif|fi|case|esac|for|while|until|do|done|in|function|select|time|return|exit|export|source|alias|set|unset|local)\b/g,
		cls: 'syn-kwd'
	},
	{
		pattern:
			/\b(cd|ls|grep|rg|cat|echo|mkdir|rm|cp|mv|touch|find|curl|wget|git|npm|node|npx|pnpm|yarn|docker|sudo|chmod|chown)\b/g,
		cls: 'syn-fn'
	},
	{ pattern: /--?[a-zA-Z0-9-]+/g, cls: 'syn-prop' }
];

const MARKDOWN_RULES: Rule[] = [
	{ pattern: /^#{1,6}\s+[^\n]+/g, cls: 'syn-kwd' },
	{ pattern: /^---$/g, cls: 'syn-block' },
	{ pattern: /`[^`]+`/g, cls: 'syn-str' },
	{ pattern: /^\s*[-*+]\s+/g, cls: 'syn-op' },
	{ pattern: /^\s*\d+\.\s+/g, cls: 'syn-num' },
	{ pattern: /^[a-zA-Z0-9_-]+(?=\s*:)/g, cls: 'syn-prop' },
	{ pattern: /:\s*(.+)$/g, cls: 'syn-str' },
	{
		pattern: /\b(Draft|Approved|Pending|Active|Done|Closed|True|False|true|false|null)\b/gi,
		cls: 'syn-lit'
	},
	{ pattern: /\b\d{4}-\d{2}-\d{2}\b/g, cls: 'syn-num' }
];

const YAML_RULES: Rule[] = [
	{ pattern: /#[^\n]*/g, cls: 'syn-cmt' },
	{ pattern: /^[a-zA-Z0-9_-]+(?=\s*:)/g, cls: 'syn-prop' },
	{ pattern: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, cls: 'syn-str' },
	{ pattern: /\b(true|false|null|yes|no|Draft|Approved|Pending)\b/gi, cls: 'syn-lit' },
	{ pattern: /\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?\b/g, cls: 'syn-num' },
	{ pattern: /^\s*-\s+/g, cls: 'syn-op' }
];

const GENERIC_RULES: Rule[] = [
	{ pattern: /\/\/[^\n]*|#[^\n]*/g, cls: 'syn-cmt' },
	{ pattern: /^[a-zA-Z0-9_-]+(?=\s*:)/g, cls: 'syn-prop' },
	{ pattern: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, cls: 'syn-str' },
	{ pattern: /\b(true|false|null|nil|None|Draft|Approved)\b/gi, cls: 'syn-lit' },
	{ pattern: /\b\d+(?:\.\d+)?\b/g, cls: 'syn-num' }
];

function getRulesForLang(lang: SupportedLanguage): Rule[] {
	switch (lang) {
		case 'typescript':
		case 'javascript':
			return JS_TS_RULES;
		case 'svelte':
		case 'html':
			return SVELTE_HTML_RULES;
		case 'css':
			return CSS_RULES;
		case 'json':
			return JSON_RULES;
		case 'python':
			return PYTHON_RULES;
		case 'go':
			return GO_RULES;
		case 'shell':
			return SHELL_RULES;
		case 'yaml':
			return YAML_RULES;
		case 'markdown':
			return MARKDOWN_RULES;
		case 'sql':
		case 'generic':
		default:
			return GENERIC_RULES;
	}
}

interface MatchToken {
	start: number;
	end: number;
	cls: string;
	text: string;
}

/**
 * Tokenizes a single code line into styled HTML spans.
 */
export function highlightCodeLine(line: string, filePath?: string): string {
	if (!line) return ' ';
	const lang = detectLanguage(filePath);
	const rules = getRulesForLang(lang);

	const matches: MatchToken[] = [];

	for (const rule of rules) {
		const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
		let m: RegExpExecArray | null;
		while ((m = regex.exec(line)) !== null) {
			const start = m.index;
			const end = start + m[0].length;
			// Ignore if overlapping with an already matched range
			const overlaps = matches.some(
				(existing) => !(end <= existing.start || start >= existing.end)
			);
			if (!overlaps) {
				matches.push({ start, end, cls: rule.cls, text: m[0] });
			}
		}
	}

	if (matches.length === 0) {
		return escapeHtml(line);
	}

	matches.sort((a, b) => a.start - b.start);

	let result = '';
	let lastIndex = 0;

	for (const tok of matches) {
		if (tok.start > lastIndex) {
			result += escapeHtml(line.slice(lastIndex, tok.start));
		}
		result += `<span class="${tok.cls}">${escapeHtml(tok.text)}</span>`;
		lastIndex = tok.end;
	}

	if (lastIndex < line.length) {
		result += escapeHtml(line.slice(lastIndex));
	}

	return result;
}

export interface HighlightOptions {
	code: string;
	path?: string;
}

/**
 * Svelte DOM action for safe, reactive syntax highlighting without `{@html}` warnings.
 */
export function highlight(node: HTMLElement, options: HighlightOptions) {
	function update(opts: HighlightOptions) {
		node.innerHTML = highlightCodeLine(opts.code || ' ', opts.path);
	}
	update(options);
	return {
		update(opts: HighlightOptions) {
			update(opts);
		}
	};
}
