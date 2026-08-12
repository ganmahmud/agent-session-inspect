import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readCodexCatalog } from '../src/catalog.ts';
import { scanCodex } from '../src/codex.ts';
import { readCodexSessionDetail } from '../src/detail.ts';

const sessionOne = '11111111-1111-1111-1111-111111111111';
const sessionTwo = '22222222-2222-2222-2222-222222222222';
const sessionThree = '33333333-3333-3333-3333-333333333333';

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'agent-session-inspect-'));
}

function jsonLine(type: string, payload: unknown, timestamp = '2026-08-12T10:00:00.000Z'): string {
  return JSON.stringify({ timestamp, type, payload });
}

function writeLog(directory: string, name: string, lines: string[]): string {
  const file = join(directory, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function createLegacyCatalog(directory: string, rows: Array<{ id: string; title: string; path: string; updatedAt?: number }>): void {
  const db = new DatabaseSync(join(directory, 'state_test.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER, rollout_path TEXT NOT NULL)');
  const statement = db.prepare('INSERT INTO threads (id, title, updated_at, rollout_path) VALUES (?, ?, ?, ?)');
  for (const row of rows) statement.run(row.id, row.title, row.updatedAt ?? 1, row.path);
  db.close();
}

test('prefers a matching Codex catalog title and preserves measured inventory', async () => {
  const directory = tempDirectory();
  try {
    const log = writeLog(directory, 'rollout.jsonl', [
      jsonLine('session_meta', { id: sessionOne, cwd: '/repo', cli_version: '0.147.0', model_provider: 'openai' }),
      jsonLine('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      jsonLine('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, total_tokens: 12 }, last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, total_tokens: 12 }, model_context_window: 100 } }),
      jsonLine('response_item', { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"secret":"redacted"}' }),
      jsonLine('event_msg', { type: 'exec_command_end', call_id: 'call-1', status: 'completed', aggregated_output: 'do not expose' }),
      jsonLine('event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
    ]);
    createLegacyCatalog(directory, [{ id: sessionOne, title: 'Build agent session profiler', path: log, updatedAt: 10 }]);
    const catalog = readCodexCatalog(directory);
    const result = await scanCodex(log, { catalogTitles: catalog.titles, catalogErrors: catalog.errors });
    const session = result.sessions[0];
    assert.equal(session.displayTitle.value, 'Build agent session profiler');
    assert.equal(session.displayTitle.source, 'provider_catalog');
    assert.equal(session.token.last?.totalTokens, 12);
    assert.equal(session.tools.calls, 1);
    assert.equal(session.tools.execCompleted, 1);
    assert.equal(JSON.stringify(result).includes('do not expose'), false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('falls back to the newest log title, then renders absent title', async () => {
  const directory = tempDirectory();
  try {
    const first = writeLog(directory, 'one.jsonl', [
      jsonLine('session_meta', { session_id: sessionOne }),
      jsonLine('event_msg', { type: 'thread_name_updated', thread_name: 'First title' }, '2026-08-12T10:01:00.000Z'),
      jsonLine('event_msg', { type: 'thread_name_updated', thread_name: 'Newest title' }, '2026-08-12T10:02:00.000Z'),
    ]);
    writeLog(directory, 'two.jsonl', [jsonLine('session_meta', { id: sessionTwo }), '{broken json']);
    const result = await scanCodex(directory);
    const titled = result.sessions.find((session) => session.id === sessionOne)!;
    const untitled = result.sessions.find((session) => session.id === sessionTwo)!;
    assert.equal(first.endsWith('one.jsonl'), true);
    assert.deepEqual(titled.displayTitle, { value: 'Newest title', source: 'session_event', observedAt: '2026-08-12T10:02:00.000Z' });
    assert.deepEqual(untitled.displayTitle, { value: null, source: 'absent' });
    assert.equal(untitled.malformedRecords, 1);
    assert.equal(result.diagnostics.malformedRecords, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ignores stale catalog paths and keeps separate sessions with duplicate titles', async () => {
  const directory = tempDirectory();
  try {
    const one = writeLog(directory, 'one.jsonl', [jsonLine('session_meta', { id: sessionOne })]);
    const two = writeLog(directory, 'two.jsonl', [jsonLine('session_meta', { id: sessionTwo })]);
    const result = await scanCodex(directory, {
      catalogTitles: [
        { sessionId: sessionOne, title: 'Duplicate task', rolloutPath: one, source: 'provider_catalog', updatedAt: 3 },
        { sessionId: sessionTwo, title: 'Duplicate task', rolloutPath: two, source: 'provider_catalog', updatedAt: 2 },
        { sessionId: sessionThree, title: 'Stale title', rolloutPath: join(directory, 'missing.jsonl'), source: 'provider_catalog' },
      ],
    });
    assert.equal(result.sessions.length, 2);
    assert.equal(result.sessions.every((session) => session.displayTitle.value === 'Duplicate task'), true);
    assert.equal(JSON.stringify(result), JSON.stringify(await scanCodex(directory, { catalogTitles: result.sessions.map((session) => ({ sessionId: session.id, title: 'Duplicate task', rolloutPath: session.sourceFiles[0], source: 'provider_catalog' })) })));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI asks for an ID or file path when a title is ambiguous', () => {
  const directory = tempDirectory();
  try {
    const sessions = join(directory, 'sessions', '2026', '08', '12');
    mkdirSync(sessions, { recursive: true });
    const one = writeLog(sessions, 'one.jsonl', [jsonLine('session_meta', { id: sessionOne })]);
    const two = writeLog(sessions, 'two.jsonl', [jsonLine('session_meta', { id: sessionTwo })]);
    createLegacyCatalog(directory, [
      { id: sessionOne, title: 'Duplicate task', path: one },
      { id: sessionTwo, title: 'Duplicate task', path: two },
    ]);
    const result = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'inspect', 'Duplicate task'], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: directory },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /More than one session matched/);
    assert.match(result.stderr, /Use an ID or file path/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('assembles a visible conversation with source-order activity and exact model-step usage', async () => {
	const directory = tempDirectory();
	try {
		const log = writeLog(directory, 'detail.jsonl', [
			jsonLine('session_meta', { id: sessionOne }),
			jsonLine('turn_context', { model: 'gpt-5.6-terra' }, '2026-08-12T09:59:59.000Z'),
			jsonLine('event_msg', { type: 'task_started', turn_id: 'turn-1' }, '2026-08-12T10:00:00.000Z'),
			jsonLine('event_msg', { type: 'user_message', message: 'Please inspect this run.' }, '2026-08-12T10:00:01.000Z'),
			jsonLine('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Hidden instruction' }] }, '2026-08-12T10:00:01.100Z'),
			jsonLine('response_item', { type: 'function_call', call_id: 'call-1', name: 'exec', arguments: '{"cmd":"git status"}' }, '2026-08-12T10:00:02.000Z'),
			jsonLine('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'clean' }, '2026-08-12T10:00:03.000Z'),
			jsonLine('event_msg', { type: 'exec_command_end', call_id: 'call-1', duration: { secs: 0, nanos: 500000000 }, status: 'completed', aggregated_output: 'clean' }, '2026-08-12T10:00:03.000Z'),
			jsonLine('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, total_tokens: 13 }, total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, total_tokens: 13 }, model_context_window: 100 } }, '2026-08-12T10:00:03.100Z'),
			jsonLine('event_msg', { type: 'agent_message', message: 'The run is clean.', phase: 'final_answer' }, '2026-08-12T10:00:04.000Z'),
			jsonLine('event_msg', { type: 'patch_apply_end', call_id: 'patch-1', status: 'completed', changes: { '/repo/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@' } } }, '2026-08-12T10:00:05.000Z'),
			jsonLine('event_msg', { type: 'task_complete', turn_id: 'turn-1', duration_ms: 6000, time_to_first_token_ms: 1000 }, '2026-08-12T10:00:06.000Z'),
		]);
		const scan = await scanCodex(log);
		const detail = await readCodexSessionDetail(scan.sessions[0]);
		assert.deepEqual(detail.conversation.map((message) => message.role), ['user', 'assistant']);
		const reply = detail.conversation[1];
		assert.equal(reply.activity?.model.name, 'gpt-5.6-terra');
		assert.equal(reply.activity?.association, 'source_order');
		assert.equal(reply.activity?.modelRequests[0].evidence, 'reported_snapshot');
		assert.equal(reply.activity?.tools.find((tool) => tool.id === 'call-1')?.durationMs, 500);
		assert.equal(reply.activity?.breakdown.durationMs, 6000);
		assert.equal(reply.activity?.breakdown.source, 'task_complete');
		assert.equal(detail.usage.latest?.modelContextWindow, 100);
		assert.equal(detail.usage.modelStepTotal.totalTokens, 13);
		assert.equal(detail.debug.hiddenMessages[0]?.text, 'Hidden instruction');
		assert.deepEqual(detail.debug.unattachedActivities[0]?.edits[0].files[0], { path: '/repo/a.ts', operation: 'update', diff: '@@ -1 +1 @@' });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('falls back to legacy response messages and merges overlapping tool time', async () => {
	const directory = tempDirectory();
	try {
		const log = writeLog(directory, 'legacy-detail.jsonl', [
			jsonLine('session_meta', { id: sessionOne }),
			jsonLine('event_msg', { type: 'task_started', turn_id: 'legacy' }, '2026-08-12T10:00:00.000Z'),
			jsonLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Legacy prompt' }] }, '2026-08-12T10:00:01.000Z'),
			jsonLine('response_item', { type: 'function_call', call_id: 'a', name: 'exec', arguments: '{}' }, '2026-08-12T10:00:01.000Z'),
			jsonLine('response_item', { type: 'function_call', call_id: 'b', name: 'exec', arguments: '{}' }, '2026-08-12T10:00:02.000Z'),
			jsonLine('event_msg', { type: 'exec_command_end', call_id: 'a', duration: { secs: 3, nanos: 0 } }, '2026-08-12T10:00:04.000Z'),
			jsonLine('event_msg', { type: 'exec_command_end', call_id: 'b', duration: { secs: 3, nanos: 0 } }, '2026-08-12T10:00:05.000Z'),
			jsonLine('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 8 }, total_token_usage: { total_tokens: 8 } } }, '2026-08-12T10:00:05.100Z'),
			jsonLine('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Legacy response' }] }, '2026-08-12T10:00:05.500Z'),
			jsonLine('event_msg', { type: 'task_complete', turn_id: 'legacy', duration_ms: 6000 }, '2026-08-12T10:00:06.000Z'),
		]);
		const scan = await scanCodex(log);
		const detail = await readCodexSessionDetail(scan.sessions[0]);
		const activity = detail.conversation[1].activity!;
		assert.deepEqual(detail.conversation.map((message) => message.text), ['Legacy prompt', 'Legacy response']);
		assert.equal(activity.modelRequests[0].usage.totalTokens, 8);
		assert.equal(activity.breakdown.measuredToolMs, 4000);
		assert.equal(activity.breakdown.otherElapsedMs, 2000);
		assert.match(activity.breakdown.explanation, /unclassified/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
