import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { readClaudeSessionDetail, scanClaude } from '../src/claude.ts';
import { scanSessions } from '../src/sessions.ts';

const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const codexSessionId = '11111111-1111-1111-1111-111111111111';

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'agent-session-inspect-claude-'));
}

function writeLog(file: string, records: unknown[]): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
  return file;
}

const base = { sessionId, cwd: '/work/demo-app', version: '2.1.0', isSidechain: false, userType: 'external' };
const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 } };

function user(uuid: string, timestamp: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { ...base, type: 'user', uuid, timestamp, message: { role: 'user', content }, ...extra };
}

function assistant(uuid: string, timestamp: string, messageId: string, block: unknown, extra: Record<string, unknown> = {}) {
  return { ...base, type: 'assistant', uuid, timestamp, requestId: `req-${messageId}`, message: { id: messageId, role: 'assistant', model: 'claude-sonnet-4-5', content: [block], usage }, ...extra };
}

function transcript(): unknown[] {
  return [
    user('u1', '2026-09-01T10:00:00.000Z', 'Add a greeting file'),
    // One API response streamed as three records sharing a message id: usage must be counted once.
    assistant('a1', '2026-09-01T10:00:01.000Z', 'msg-1', { type: 'thinking', thinking: 'plan' }),
    assistant('a2', '2026-09-01T10:00:01.500Z', 'msg-1', { type: 'tool_use', id: 'tool-bash', name: 'Bash', input: { command: 'ls' } }),
    assistant('a3', '2026-09-01T10:00:02.000Z', 'msg-1', { type: 'tool_use', id: 'tool-write', name: 'Write', input: { file_path: '/work/demo-app/hello.txt', content: 'hi' } }),
    user('u2', '2026-09-01T10:00:03.000Z', [{ type: 'tool_result', tool_use_id: 'tool-bash', content: 'README.md' }], { toolUseResult: { stdout: 'README.md' } }),
    user('u3', '2026-09-01T10:00:04.000Z', [{ type: 'tool_result', tool_use_id: 'tool-write', content: 'File created' }], {
      toolUseResult: { type: 'create', filePath: '/work/demo-app/hello.txt', content: 'hi\nthere', structuredPatch: [] },
    }),
    assistant('a4', '2026-09-01T10:00:05.000Z', 'msg-2', { type: 'tool_use', id: 'tool-mcp', name: 'mcp__github__get_me', input: {} }),
    user('u4', '2026-09-01T10:00:06.000Z', [{ type: 'tool_result', tool_use_id: 'tool-mcp', content: [{ type: 'text', text: 'octocat' }] }]),
    assistant('a5', '2026-09-01T10:00:07.000Z', 'msg-3', { type: 'text', text: 'Created hello.txt.' }),
    user('u5', '2026-09-01T10:00:08.000Z', 'Caveat: local command', { isMeta: true }),
    { ...base, type: 'system', subtype: 'compact_boundary', uuid: 's1', timestamp: '2026-09-01T10:00:09.000Z', content: 'Conversation compacted' },
    user('u6', '2026-09-01T10:00:10.000Z', 'Now edit it'),
    assistant('a6', '2026-09-01T10:00:11.000Z', 'msg-4', { type: 'tool_use', id: 'tool-edit', name: 'Edit', input: { file_path: '/work/demo-app/hello.txt' } }),
    user('u7', '2026-09-01T10:00:12.000Z', [{ type: 'tool_result', tool_use_id: 'tool-edit', content: 'ok' }], {
      toolUseResult: { filePath: '/work/demo-app/hello.txt', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-hi', '+hello'] }] },
    }),
    user('u8', '2026-09-01T10:00:13.000Z', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    { type: 'summary', summary: 'Greeting file setup', leafUuid: 'a5' },
    'not json',
  ];
}

function writeFixture(directory: string): { main: string; subagent: string } {
  const project = join(directory, 'projects', '-work-demo-app');
  const lines = transcript().map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
  const main = join(project, `${sessionId}.jsonl`);
  mkdirSync(project, { recursive: true });
  writeFileSync(main, `${lines.join('\n')}\n`);
  const subagent = writeLog(join(project, sessionId, 'subagents', 'agent-beef.jsonl'), [
    { ...user('s-u1', '2026-09-01T10:00:20.000Z', 'Find all TODOs'), isSidechain: true, agentId: 'beef' },
    { ...assistant('s-a1', '2026-09-01T10:00:21.000Z', 'msg-sub', { type: 'text', text: 'Found 2 TODOs.' }), isSidechain: true, agentId: 'beef' },
  ]);
  return { main, subagent };
}

test('scans Claude Code transcripts into the shared inventory shape', async () => {
  const directory = tempDirectory();
  try {
    const { subagent } = writeFixture(directory);
    const result = await scanClaude(join(directory, 'projects'));
    assert.equal(result.provider, 'claude');
    assert.equal(result.diagnostics.malformedRecords, 1);
    const session = result.sessions.find((item) => item.id === sessionId)!;
    assert.equal(session.agent, 'claude');
    assert.equal(session.provider, 'anthropic');
    assert.deepEqual(session.displayTitle, { value: 'Greeting file setup', source: 'session_event' });
    assert.equal(session.projectName, 'demo-app');
    assert.deepEqual(session.cliVersions, ['2.1.0']);
    assert.equal(session.token.observations, 4);
    assert.deepEqual(session.token.last, { inputTokens: 1110, cachedInputTokens: 1000, outputTokens: 50, reasoningOutputTokens: 20, totalTokens: 1160 });
    assert.equal(session.token.total?.totalTokens, 4 * 1160);
    assert.equal(session.token.modelContextWindow, 200_000);
    assert.deepEqual(session.tools, { calls: 4, outputs: 4, execCompleted: 1, mcpCompleted: 1 });
    assert.equal(session.taskCount, 2);
    assert.equal(session.abortedTaskCount, 1);
    assert.equal(session.completedTaskCount, 1);
    assert.equal(session.compactionCount, 1);
    assert.equal(session.malformedRecords, 1);
    assert.deepEqual(session.relationships, [{ type: 'subagent', sessionId: `${sessionId}-agent-beef` }]);

    const child = result.sessions.find((item) => item.id === `${sessionId}-agent-beef`)!;
    assert.deepEqual(child.sourceFiles, [subagent]);
    assert.deepEqual(child.relationships, [{ type: 'parent', sessionId }]);
    assert.equal(child.displayTitle.value, 'Find all TODOs');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('counts replayed records from a resumed transcript once', async () => {
  const directory = tempDirectory();
  try {
    const { main } = writeFixture(directory);
    const replay = transcript().filter((item) => typeof item !== 'string');
    writeLog(join(main, '..', 'resumed.jsonl'), replay);
    const result = await scanClaude(join(directory, 'projects'));
    const session = result.sessions.find((item) => item.id === sessionId)!;
    assert.equal(session.sourceFiles.length, 2);
    assert.equal(session.token.total?.totalTokens, 4 * 1160);
    assert.equal(session.tools.calls, 4);
    assert.equal(session.taskCount, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('assembles Claude Code conversation, tool timing, edits and usage', async () => {
  const directory = tempDirectory();
  try {
    writeFixture(directory);
    const result = await scanClaude(join(directory, 'projects'));
    const detail = await readClaudeSessionDetail(result.sessions.find((item) => item.id === sessionId)!);
    assert.deepEqual(
      detail.conversation.map((entry) => [entry.role, entry.text]),
      [
        ['user', 'Add a greeting file'],
        ['assistant', 'Created hello.txt.'],
        ['user', 'Now edit it'],
        ['assistant', ''],
        ['user', '[Request interrupted by user for tool use]'],
      ],
    );

    const reply = detail.conversation[1].activity!;
    assert.equal(reply.model.name, 'claude-sonnet-4-5');
    assert.equal(reply.modelRequests.length, 3);
    assert.deepEqual(reply.tools.map((tool) => [tool.name, tool.kind, tool.durationMs, tool.status]), [
      ['Bash', 'exec', 1500, 'completed'],
      ['Write', 'patch', 2000, 'completed'],
      ['mcp__github__get_me', 'mcp', 1000, 'completed'],
    ]);
    assert.equal(reply.tools[2].output, 'octocat');
    assert.deepEqual(reply.edits[0].files[0], { path: '/work/demo-app/hello.txt', operation: 'add', diff: '--- /dev/null\n+++ b/work/demo-app/hello.txt\n@@ -0,0 +1,2 @@\n+hi\n+there' });
    assert.equal(reply.task?.status, 'completed');
    assert.equal(reply.task?.durationMs, 7000);

    // The interrupted turn produced no assistant text; its tool work stays in the conversation as a text-less reply.
    const toolOnly = detail.conversation[3];
    assert.equal(toolOnly.phase, 'tool_activity');
    assert.equal(toolOnly.activity?.task?.status, 'aborted');
    assert.equal(detail.debug.unattachedActivities.length, 0);
    assert.equal(toolOnly.activity!.edits[0].files[0].diff, '--- a/work/demo-app/hello.txt\n+++ b/work/demo-app/hello.txt\n@@ -1,1 +1,1 @@\n-hi\n+hello');
    assert.deepEqual(detail.debug.hiddenMessages.map((message) => message.role), ['meta', 'system:compact_boundary']);

    assert.equal(detail.usage.modelStepCount, 4);
    assert.equal(detail.usage.snapshots.length, 4);
    assert.equal(detail.usage.latest?.usage.totalTokens, 4 * 1160);
    assert.equal(detail.usage.modelStepTotal.cachedInputTokens, 4000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('titles a Claude Code session that only ran local slash commands by those commands', async () => {
  const directory = tempDirectory();
  try {
    const command = (uuid: string, name: string) => ({ ...base, type: 'system', subtype: 'local_command', uuid, timestamp: '2026-09-03T10:00:00.000Z', content: `<command-name>${name}</command-name>\n<command-args></command-args>` });
    writeLog(join(directory, 'projects', '-work-demo-app', `${sessionId}.jsonl`), [
      command('c1', '/login'),
      { ...base, type: 'system', subtype: 'local_command', uuid: 'c2', content: '<local-command-stdout>ok</local-command-stdout>' },
      command('c3', '/skills'),
    ]);
    const [session] = (await scanClaude(join(directory, 'projects'))).sessions;
    assert.deepEqual(session.displayTitle, { value: '/login, /skills', source: 'session_event' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scanSessions merges Codex and Claude Code sessions from one path', async () => {
  const directory = tempDirectory();
  try {
    writeFixture(directory);
    writeLog(join(directory, 'projects', 'codex', 'rollout.jsonl'), [
      { timestamp: '2026-09-02T10:00:00.000Z', type: 'session_meta', payload: { id: codexSessionId, cwd: '/work/other' } },
    ]);
    const all = await scanSessions({ path: join(directory, 'projects') });
    assert.equal(all.provider, 'all');
    assert.deepEqual(all.sessions.map((session) => session.agent), ['codex', 'claude', 'claude']);
    const claudeOnly = await scanSessions({ path: join(directory, 'projects'), agent: 'claude' });
    assert.equal(claudeOnly.sessions.every((session) => session.agent === 'claude'), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
