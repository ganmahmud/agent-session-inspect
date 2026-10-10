import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { scanClaude } from '../src/claude.ts';
import { claudeViewFromDetail, readClaudeSessionView, viewFromTurns } from '../src/claude-view.ts';
import { readClaudeSessionDetail } from '../src/claude.ts';

const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const base = { sessionId, cwd: '/work/demo-app', version: '2.1.0', gitBranch: 'main', entrypoint: 'cli', isSidechain: false };
const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 } };

function assistant(uuid: string, timestamp: string, messageId: string, content: unknown[]) {
  return { ...base, type: 'assistant', uuid, timestamp, message: { id: messageId, role: 'assistant', model: 'claude-opus-5-5', content, usage } };
}

function transcript(): unknown[] {
  return [
    { ...base, type: 'system', subtype: 'local_command', uuid: 's1', timestamp: '2026-09-01T09:59:00.000Z', content: '<command-name>/model</command-name>\n<command-args></command-args>' },
    { ...base, type: 'system', subtype: 'local_command', uuid: 's2', timestamp: '2026-09-01T09:59:00.000Z', content: '<local-command-stdout>Set model to opus</local-command-stdout>' },
    { ...base, type: 'attachment', uuid: 'a1', timestamp: '2026-09-01T09:59:30.000Z', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart' } },
    { ...base, type: 'attachment', uuid: 'a2', timestamp: '2026-09-01T09:59:30.000Z', attachment: { type: 'instructions', files: [{ path: '/work/demo-app/CLAUDE.md', type: 'Project', content: 'Use bun.' }] } },
    { ...base, type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z', permissionMode: 'auto', message: { role: 'user', content: 'Add a greeting file' } },
    // One response streamed as two thinking blocks, a text block and a tool call.
    assistant('m1', '2026-09-01T10:00:01.000Z', 'msg-1', [{ type: 'thinking', thinking: '', signature: 'x' }]),
    assistant('m2', '2026-09-01T10:00:01.500Z', 'msg-1', [{ type: 'thinking', thinking: '', signature: 'y' }]),
    assistant('m3', '2026-09-01T10:00:02.000Z', 'msg-1', [{ type: 'text', text: 'Writing it now.' }]),
    assistant('m4', '2026-09-01T10:00:02.000Z', 'msg-1', [{ type: 'tool_use', id: 'tool-write', name: 'Write', input: { file_path: '/work/demo-app/hello.txt', content: 'hi\nthere' } }]),
    {
      ...base,
      type: 'user',
      uuid: 'r1',
      timestamp: '2026-09-01T10:00:04.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-write', content: 'File created' }] },
      toolUseResult: { type: 'create', filePath: '/work/demo-app/hello.txt', content: 'hi\nthere', structuredPatch: [] },
    },
    assistant('m5', '2026-09-01T10:00:05.000Z', 'msg-2', [{ type: 'tool_use', id: 'tool-mcp', name: 'mcp__github__get_me', input: {} }]),
    { ...base, type: 'user', uuid: 'r2', timestamp: '2026-09-01T10:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-mcp', content: 'denied', is_error: true }] } },
    { ...base, type: 'system', subtype: 'turn_duration', uuid: 's3', timestamp: '2026-09-01T10:00:07.000Z', durationMs: 6500 },
    { ...base, type: 'user', uuid: 'u2', timestamp: '2026-09-01T10:01:00.000Z', message: { role: 'user', content: 'Now run the tests' } },
    { ...base, type: 'user', uuid: 'u3', timestamp: '2026-09-01T10:01:02.000Z', message: { role: 'user', content: '[Request interrupted by user]' } },
    { type: 'cost-state', sessionId, totalCostUSD: 0.42, totalAPIDuration: 3000, totalToolDuration: 2500, totalDuration: 90_000, totalLinesAdded: 2, totalLinesRemoved: 0, modelUsage: { 'claude-opus-5-5': { costUSD: 0.42, outputTokens: 100 } } },
  ];
}

test('builds a Claude Code session view with turns, steps and session context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-session-inspect-claude-view-'));
  try {
    const file = join(directory, 'projects', '-work-demo-app', `${sessionId}.jsonl`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${transcript().map((item) => JSON.stringify(item)).join('\n')}\n`);
    const [session] = (await scanClaude(join(directory, 'projects'))).sessions;
    const view = await readClaudeSessionView(session);

    assert.deepEqual(view.gitBranches, ['main']);
    assert.deepEqual(view.entrypoints, ['cli']);
    assert.deepEqual(view.permissionModes, ['auto']);
    assert.equal(view.cost?.usd, 0.42);
    assert.deepEqual(view.models.map((model) => [model.model, model.requests, model.costUsd]), [['claude-opus-5-5', 2, 0.42]]);
    assert.deepEqual(view.slashCommands, [{ name: '/model', count: 1 }]);
    assert.deepEqual(view.hooks.map((hook) => [hook.name, hook.count]), [['SessionStart:startup', 1]]);
    assert.deepEqual(view.instructions, [{ path: '/work/demo-app/CLAUDE.md', type: 'Project', chars: 8 }]);
    assert.deepEqual(view.mcpServers, [{ name: 'github', calls: 1, connected: false }]);
    assert.deepEqual(view.files.map((item) => [item.path, item.edits, item.created, item.linesAdded]), [['hello.txt', 1, true, 2]]);
    assert.deepEqual(view.toolCounts, { read: 0, edit: 1, shell: 0, web: 0, agent: 0, mcp: 1, other: 0 });

    // The slash command ran before any prompt, so it gets a preamble turn.
    assert.deepEqual(view.turns.map((turn) => [turn.prompt?.text, turn.status]), [
      [undefined, 'completed'],
      ['Add a greeting file', 'completed'],
      ['Now run the tests', 'interrupted'],
    ]);
    assert.deepEqual(view.turns[0].steps.map((step) => step.kind === 'event' && [step.label, step.detail]), [['Ran /model', 'Set model to opus']]);

    const turn = view.turns[1];
    assert.equal(turn.durationMs, 6500);
    assert.equal(turn.durationSource, 'recorded');
    assert.equal(turn.tokens.requests, 2);
    assert.equal(turn.errorCount, 1);
    assert.deepEqual(turn.steps.map((step) => step.kind), ['thinking', 'text', 'tool', 'tool']);
    const thinking = turn.steps[0];
    assert.equal(thinking.kind === 'thinking' && thinking.tokens, 20);
    const write = turn.steps[2];
    assert.ok(write.kind === 'tool');
    assert.equal(write.summary, 'hello.txt');
    assert.equal(write.durationMs, 2000);
    assert.equal(write.status, 'completed');
    assert.match(write.diff ?? '', /\+\+\+ b\/work\/demo-app\/hello.txt/);
    const mcp = turn.steps[3];
    assert.ok(mcp.kind === 'tool');
    assert.equal(mcp.category, 'mcp');
    assert.equal(mcp.status, 'error');
    assert.deepEqual([write.label, write.verb], ['Wrote hello.txt', 'edit']);

    // Recorded cost is split across responses by token mix, then across the steps each response produced.
    const allocated = view.turns.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
    assert.ok(Math.abs(allocated - 0.42) < 1e-9);
    const stepTotal = view.turns.flatMap((item) => item.steps).reduce((sum, step) => sum + (step.kind === 'event' ? 0 : (step.costUsd ?? 0)), 0);
    assert.ok(Math.abs(stepTotal - 0.42) < 1e-9);
    assert.ok(Math.abs((write.costUsd ?? 0) - 0.42 / 2 / 3) < 1e-9);
    assert.deepEqual([mcp.label, mcp.verb, mcp.server], ['Get me', 'tool', 'Github']);
    assert.deepEqual(view.pullRequests, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rebuilds a Claude view from a generic export and from selected turns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-session-inspect-claude-view-'));
  try {
    const file = join(directory, 'projects', '-work-demo-app', `${sessionId}.jsonl`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${transcript().map((item) => JSON.stringify(item)).join('\n')}\n`);
    const [session] = (await scanClaude(join(directory, 'projects'))).sessions;

    // Exports written before Claude views were included only have the generic conversation.
    const converted = claudeViewFromDetail(await readClaudeSessionDetail(session));
    assert.equal(converted.imported, true);
    assert.deepEqual(converted.turns.map((turn) => turn.prompt?.text), ['Add a greeting file', 'Now run the tests']);
    const tools = converted.turns[0].steps.filter((step) => step.kind === 'tool');
    assert.deepEqual(tools.map((step) => [step.label, step.status]), [['Wrote hello.txt', 'completed'], ['Get me', 'error']]);
    assert.deepEqual(converted.files.map((item) => [item.path, item.linesAdded, item.created]), [['hello.txt', 2, true]]);
    assert.equal(converted.toolCounts.mcp, 1);

    // A selection export carries turns only; totals are recomputed from them.
    const view = await readClaudeSessionView(session);
    const picked = viewFromTurns({ id: 'picked', title: 'Picked' }, [view.turns[1]]);
    assert.equal(picked.turns[0].index, 0);
    assert.equal(picked.tokens.requests, 2);
    assert.deepEqual(picked.toolNames.map((tool) => [tool.name, tool.count, tool.errors]), [['Write', 1, 0], ['mcp__github__get_me', 1, 1]]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('points out repeated failures and re-run commands', () => {
  const tool = (id: string, command: string, status: 'completed' | 'error', output = '') => ({
    kind: 'tool' as const,
    id,
    name: 'Bash',
    category: 'shell' as const,
    label: command,
    verb: 'command' as const,
    images: [],
    status,
    input: JSON.stringify({ command }),
    output,
    costUsd: 0.1,
  });
  const view = viewFromTurns({ id: 'x', title: 'x' }, [
    {
      index: 0,
      id: 't1',
      prompt: { text: 'go', images: [] },
      durationSource: 'unavailable',
      status: 'completed',
      steps: [
        tool('a', 'npm test', 'error', 'Error: cannot find module /a/b/c.js\nat line 12'),
        tool('b', 'npm test', 'error', 'Error: cannot find module /x/y.js\nat line 99'),
        tool('c', 'npm test', 'completed'),
        tool('d', 'python3 - <<EOF\nprint(1)\nEOF', 'completed'),
        tool('e', 'python3 - <<EOF\nprint(2)\nEOF', 'completed'),
        tool('f', 'python3 - <<EOF\nprint(3)\nEOF', 'completed'),
      ],
      tokens: { fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, requests: 0 },
      peakContext: 0,
      models: [],
      toolCount: 6,
      errorCount: 2,
    },
  ]);
  assert.deepEqual(view.insights.map((item) => [item.text, item.stepId]), [
    ['2 Bash calls failed the same way: “Error: cannot find module …” · $0.20', 'a'],
    ['Ran the same command 3 times: npm test', 'a'],
  ]);
});
