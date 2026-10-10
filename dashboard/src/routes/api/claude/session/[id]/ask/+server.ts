import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { claudeSessionView } from '$lib/server/session-data';
import { sessionDigest } from '../../../../../../../../src/session-digest.ts';

const TIMEOUT_MS = 3 * 60_000;
/** Spending cap for one question, passed to the CLI's own budget guard. */
const BUDGET_USD = '1.00';

const INSTRUCTIONS = [
	'You are helping someone review one of their past Claude Code sessions.',
	'The session transcript is given on stdin as a digest: user messages, what Claude did, and what it answered.',
	'Answer their question about that session in concise Markdown, grounded only in the digest.',
	'Refer to user messages by number ("message 3") when it helps them find the spot. Say so when the digest does not show something.'
].join(' ');

interface CliResult {
	result?: string;
	is_error?: boolean;
	total_cost_usd?: number;
	duration_ms?: number;
}

/**
 * Asks the user's own Claude Code CLI a question about a session. It runs with no tools, no MCP servers and no
 * saved session, from a temporary directory, so it can only read the digest it is given.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { question?: unknown };
	const question = typeof body.question === 'string' ? body.question.trim() : '';
	if (!question || question.length > 2_000) error(400, 'Ask a question of up to 2,000 characters.');

	const view = await claudeSessionView(params.id);
	if (!view) error(404, 'Claude Code session not found.');
	const digest = sessionDigest(view);

	const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
		(done, fail) => {
			const child = spawn(
				process.env.ASI_CLAUDE_BIN || 'claude',
				[
					'-p',
					question,
					'--append-system-prompt',
					INSTRUCTIONS,
					'--tools',
					'',
					'--strict-mcp-config',
					'--no-session-persistence',
					'--output-format',
					'json',
					'--max-budget-usd',
					BUDGET_USD
				],
				{ cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] }
			);
			let stdout = '';
			let stderr = '';
			const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
			child.stdout.on('data', (chunk) => (stdout += chunk));
			child.stderr.on('data', (chunk) => (stderr += chunk));
			child.on('error', fail);
			child.on('close', (code) => {
				clearTimeout(timer);
				done({ stdout, stderr, code });
			});
			child.stdin.end(digest);
		}
	).catch((err: NodeJS.ErrnoException) => {
		if (err.code === 'ENOENT') {
			error(
				503,
				'The claude CLI is not on PATH. Install Claude Code or set ASI_CLAUDE_BIN to its path.'
			);
		}
		throw err;
	});

	let parsed: CliResult | undefined;
	try {
		parsed = JSON.parse(output.stdout) as CliResult;
	} catch {
		parsed = undefined;
	}
	if (!parsed || parsed.is_error || !parsed.result) {
		const reason = parsed?.result ?? output.stderr.trim().split('\n').at(-1) ?? 'no output';
		error(502, `The claude CLI could not answer: ${reason}`);
	}
	return json({
		answer: parsed.result,
		costUsd: parsed.total_cost_usd,
		durationMs: parsed.duration_ms,
		digestChars: digest.length
	});
};
