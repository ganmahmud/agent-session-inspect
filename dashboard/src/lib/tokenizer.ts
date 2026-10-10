export interface TokenCountResult {
	count: number;
	method: 'js-tiktoken (cl100k_base)' | 'BPE Estimator (cl100k_base)';
}

let encoder: { encode: (text: string) => { length: number } } | null = null;
let attempted = false;

// Pre-tokenizer splits matching tiktoken cl100k_base, tried in order.
const BPE_PARTS = [
	String.raw`'(?:[stmd]|re|ve|ll)`, // contractions
	String.raw` ?\p{L}+`, // words
	String.raw` ?\p{N}+`, // numbers
	String.raw` ?[^\s\p{L}\p{N}]+`, // punctuation runs
	String.raw`\s+(?!\S)`, // trailing whitespace
	String.raw`\s+`
];
const BPE_SPLIT = new RegExp(BPE_PARTS.join('|'), 'gu');

function estimateTokens(text: string): number {
	if (!text) return 0;
	const matches = text.match(BPE_SPLIT);
	if (!matches) return 0;

	let count = 0;
	for (const chunk of matches) {
		const len = chunk.length;
		if (len <= 4) {
			count += 1;
		} else {
			count += Math.ceil(len / 3.5);
		}
	}
	return count;
}

export function countTokens(text: string): TokenCountResult {
	if (!text) return { count: 0, method: 'BPE Estimator (cl100k_base)' };
	if (!encoder && !attempted) {
		attempted = true;
		try {
			const modName = 'js-tiktoken';
			import(/* @vite-ignore */ modName)
				.then((m) => {
					if (m && typeof m.getEncoding === 'function') {
						encoder = m.getEncoding('cl100k_base');
					}
				})
				.catch(() => {});
		} catch {
			// Fallback to estimation
		}
	}
	if (encoder) {
		try {
			return {
				count: encoder.encode(text).length,
				method: 'js-tiktoken (cl100k_base)'
			};
		} catch {
			// Fallback to estimation
		}
	}
	return {
		count: estimateTokens(text),
		method: 'BPE Estimator (cl100k_base)'
	};
}
