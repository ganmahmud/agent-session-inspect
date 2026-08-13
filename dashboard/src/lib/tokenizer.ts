export interface TokenCountResult {
	count: number;
	method: 'js-tiktoken (cl100k_base)' | 'BPE Estimator (cl100k_base)';
}

let encoder: { encode: (text: string) => { length: number } } | null = null;
let attempted = false;

function estimateTokens(text: string): number {
	if (!text) return 0;
	// BPE regex matching tiktoken cl100k_base token splits
	const bpeRegex = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
	const matches = text.match(bpeRegex);
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
