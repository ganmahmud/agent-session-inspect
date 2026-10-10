import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { scanClaude } from '../src/claude.ts';
import { readClaudeSessionView } from '../src/claude-view.ts';
import { isCorrection, permissionRule } from '../src/habits.ts';
import { fileHistories, parseQuery, queryTerms, search, searchSessions, type SearchKind, type SessionIndex } from '../src/search.ts';

const sessionId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const base = { sessionId, cwd: '/work/app', version: '2.1.0', isSidechain: false };

function usage(fresh: number, cacheWrite: number, cacheRead: number, oneHour = cacheWrite) {
  return {
    input_tokens: fresh,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: 100,
    cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: cacheWrite - oneHour },
  };
}

function reply(uuid: string, timestamp: string, id: string, tokens: ReturnType<typeof usage>, model = 'claude-opus-5-5') {
  return { ...base, type: 'assistant', uuid, timestamp, message: { id, role: 'assistant', model, content: [{ type: 'text', text: `reply ${uuid}` }], usage: tokens } };
}

test('finds a cache that went cold after a break longer than its lifetime, and prices the re-cache', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-session-inspect-insights-'));
  try {
    const file = join(directory, 'projects', '-work-app', `${sessionId}.jsonl`);
    mkdirSync(join(file, '..'), { recursive: true });
    const records = [
      { type: 'cost-state', sessionId, totalCostUSD: 1, startTime: Date.parse('2026-09-01T09:00:00Z'), modelUsage: { 'claude-opus-5-5': { costUSD: 1 } } },
      { ...base, type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: 'first' } },
      reply('a1', '2026-09-01T10:00:05.000Z', 'm1', usage(10, 50_000, 0)), // cold start: normal
      reply('a2', '2026-09-01T10:01:00.000Z', 'm2', usage(10, 1_000, 50_000)), // warm
      { ...base, type: 'user', uuid: 'u2', timestamp: '2026-09-01T12:30:00.000Z', message: { role: 'user', content: 'back again' } },
      reply('a3', '2026-09-01T12:30:05.000Z', 'm3', usage(10, 51_000, 0)), // 2.5h later: the 1-hour cache expired
    ];
    writeFileSync(file, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
    const [session] = (await scanClaude(join(directory, 'projects'))).sessions;
    const view = await readClaudeSessionView(session);

    assert.equal(view.cacheResets.length, 1);
    const [reset] = view.cacheResets;
    assert.equal(reset.reason, 'expired');
    assert.equal(reset.ttlMs, 60 * 60_000);
    assert.equal(reset.gapMs, 2.5 * 60 * 60_000 - 55_000);
    assert.equal(reset.tokens, 51_000);
    assert.ok(reset.extraUsd && reset.extraUsd > 0 && reset.extraUsd < 1);
    // The reset shows in the conversation just before the reply that paid for it.
    const steps = view.turns[1].steps;
    assert.deepEqual(steps.map((step) => step.kind), ['event', 'text']);
    assert.match(steps[0].kind === 'event' ? steps[0].label : '', /^Cache expired after a 2h 29m break: re-cached 51K tokens \(\+\$0\.\d\d\)$/);
    assert.equal(view.insights[0].id, 'cache-expired');
    assert.equal(view.contextSeries.length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('searches every session, matching all words and phrases, once per replayed message', () => {
  const doc = (sessionId: string, kind: 'prompt' | 'command' | 'reply', text: string, timestamp: string) => ({ sessionId, agent: 'claude' as const, kind, text, timestamp });
  const original: SessionIndex = { docs: [doc('a', 'prompt', 'Fix the bun test runner', '2026-09-01T10:00:00Z'), doc('a', 'command', 'bun test --watch', '2026-09-01T10:01:00Z')], edits: [] };
  // A resumed copy repeats the original's messages.
  const resumed: SessionIndex = { docs: [doc('b', 'prompt', 'Fix the bun test runner', '2026-09-01T10:00:00Z'), doc('b', 'reply', 'now the tests pass', '2026-09-01T10:05:00Z')], edits: [] };
  assert.deepEqual(queryTerms('"bun test" runner'), ['bun test', 'runner']);
  assert.deepEqual(parseQuery('cache -expiry "bun test" -"npm run"'), { terms: ['cache', 'bun test'], excluded: ['expiry', 'npm run'], phrase: 'cache bun test' });

  const hits = search([original, resumed], '"bun test" runner');
  assert.deepEqual(hits.map((hit) => [hit.doc.sessionId, hit.doc.kind]), [['a', 'prompt']]);
  assert.equal(hits[0].snippet.slice(hits[0].matches[0][0], hits[0].matches[0][1]), 'bun test');
  // Your messages rank above commands for the same words.
  assert.deepEqual(search([original, resumed], 'test').map((hit) => hit.doc.kind), ['prompt', 'reply', 'command']);
  assert.deepEqual(search([original, resumed], 'test -watch -pass').map((hit) => hit.doc.text), ['Fix the bun test runner']);
});

test('shows the part of a long message where the search words meet', () => {
  const text = `${'filler words here. '.repeat(40)}the cache expired after lunch${' and more filler'.repeat(40)}`;
  const [hit] = search([{ docs: [{ sessionId: 's', agent: 'claude', kind: 'reply', text }], edits: [] }], 'cache lunch');
  assert.match(hit.snippet, /^….*the cache expired after lunch.*…$/);
  assert.deepEqual(hit.matches.map(([start, end]) => hit.snippet.slice(start, end)), ['cache', 'lunch']);
});

test('groups matches by session and counts them by agent, kind and project', () => {
  const entry = (id: string, agent: 'claude' | 'codex', project: string, docs: Array<[SearchKind, string]>) => ({
    session: { id, agent, title: id, project, updatedAt: '2026-09-01' },
    index: { docs: docs.map(([kind, text], i) => ({ sessionId: id, agent, kind, text, timestamp: `2026-09-01T10:0${i}:00Z` })), edits: [] },
  });
  const entries = [
    entry('s1', 'claude', 'app', [['prompt', 'deploy the app'], ['command', 'npm run deploy'], ['reply', 'deployed']]),
    entry('s2', 'codex', 'site', [['prompt', 'deploy the site']]),
  ];
  const all = searchSessions(entries, 'deploy');
  assert.equal(all.total, 4);
  assert.equal(all.sessionCount, 2);
  assert.deepEqual(all.groups.map((group) => [group.id, group.matchCount]), [['s1', 3], ['s2', 1]]);
  assert.deepEqual(all.facets.agents, { claude: 3, codex: 1 });
  assert.deepEqual(all.facets.kinds, { prompt: 2, command: 1, reply: 1 });

  // Filters narrow the results; each facet still counts matches as if its own filter were off.
  const commands = searchSessions(entries, 'deploy', { kinds: ['command'] });
  assert.equal(commands.total, 1);
  assert.deepEqual(commands.facets.kinds, { prompt: 2, command: 1, reply: 1 });
  assert.deepEqual(commands.facets.agents, { claude: 1 });
  assert.deepEqual(searchSessions(entries, 'deploy', { agent: 'codex' }).groups.map((group) => group.id), ['s2']);
});

test('groups a file’s edits across sessions, oldest first', () => {
  const edit = (sessionId: string, anchor: string, timestamp: string, added: number) => ({ path: '/work/app/src/a.ts', sessionId, agent: 'claude' as const, timestamp, added, removed: 0, created: false, anchor });
  const histories = fileHistories(
    [
      { docs: [], edits: [edit('s2', 'x', '2026-09-02', 3)] },
      { docs: [], edits: [edit('s1', 'y', '2026-09-01', 5), { ...edit('s1', 'z', '2026-09-01', 1), path: '/work/app/README.md' }] },
    ],
    'a.ts',
  );
  assert.deepEqual(histories.map((item) => [item.path, item.sessions, item.added, item.edits.map((e) => e.sessionId)]), [['/work/app/src/a.ts', 2, 8, ['s1', 's2']]]);
});

test('suggests permission rules only for simple, non-destructive commands', () => {
  assert.equal(permissionRule('npm test -- --watch'), 'Bash(npm test:*)');
  assert.equal(permissionRule('git status'), 'Bash(git status:*)');
  assert.equal(permissionRule('cd app && npm test'), undefined);
  assert.equal(permissionRule('ls -la | head'), undefined);
  assert.equal(permissionRule('rm -rf dist'), undefined);
  assert.equal(permissionRule('python3 script.py'), undefined);
  assert.equal(permissionRule('git push origin main'), undefined);
});

test('spots follow-up messages that correct Claude', () => {
  assert.equal(isCorrection("no, use bun instead of npm"), true);
  assert.equal(isCorrection("Don't add comments to the code"), true);
  assert.equal(isCorrection('Use pnpm instead of npm here'), true);
  assert.equal(isCorrection('Add a dark mode toggle to the header'), false);
  assert.equal(isCorrection(`no ${'x'.repeat(400)}`), false);
});

test('digests a session for the CLI and compares two sessions', async () => {
  const { viewFromTurns } = await import('../src/claude-view.ts');
  const { sessionDigest } = await import('../src/session-digest.ts');
  const { fileOverlap, sessionMetrics } = await import('../src/compare.ts');
  const tool = (id: string, path: string, status: 'completed' | 'error') => ({
    kind: 'tool' as const,
    id,
    name: 'Edit',
    category: 'edit' as const,
    label: `Edited ${path}`,
    verb: 'edit' as const,
    images: [],
    status,
    filePath: path,
    linesAdded: 2,
    linesRemoved: 1,
    output: status === 'error' ? 'old_string not found' : 'ok',
  });
  const turn = (id: string, steps: ReturnType<typeof tool>[]) => ({
    index: 0,
    id,
    prompt: { text: `please do ${id}`, images: [] },
    durationSource: 'unavailable' as const,
    status: 'completed' as const,
    steps: [...steps, { kind: 'text' as const, id: `${id}-a`, text: `done ${id}` }],
    tokens: { fresh: 10, cacheWrite: 0, cacheRead: 90, output: 5, thinking: 0, requests: 1 },
    peakContext: 100,
    models: ['claude-opus-5-5'],
    toolCount: steps.length,
    errorCount: steps.filter((step) => step.status === 'error').length,
  });
  const a = viewFromTurns({ id: 'a', title: 'Task A' }, [turn('t1', [tool('x', 'src/a.ts', 'completed'), tool('y', 'src/b.ts', 'error')])]);
  const b = viewFromTurns({ id: 'b', title: 'Task B' }, [turn('t2', [tool('z', 'src/a.ts', 'completed')])]);

  const digest = sessionDigest(a);
  assert.match(digest, /## User message 1/);
  assert.match(digest, /- Edited src\/b\.ts \(\+2 −1\) \[FAILED: old_string not found\]/);
  assert.match(digest, /### Claude's answer\ndone t1/);
  assert.ok(sessionDigest(a, 200).length <= 230);

  const ma = sessionMetrics(a);
  const mb = sessionMetrics(b);
  assert.deepEqual([ma.steps, ma.failed, ma.cacheHitPct, mb.steps], [2, 1, 90, 1]);
  assert.deepEqual(fileOverlap(ma, mb), { both: ['src/a.ts'], onlyA: ['src/b.ts'], onlyB: [] });
});
