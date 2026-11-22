import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

// Exercise the shipped factory without a browser or an additional test dependency.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function loadClient(fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })) {
  let api;
  const context = {
    window: { __ModuleLoader__: { load(module) {
      api = module.factory(() => ({ createElement() {}, forwardRef: (render) => render, Component: class {} }));
    } } },
    fetch, AbortController, setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(source.replace('    // ---------------------------------------------------------------- mount',
    '    return { filterSkills, runtimeBadge, createRuntime, Segmented, TabBar, usagePeriodProjection, previewFileTree, cachedPreview, rememberPreview, PREVIEW_MEMORY, zh, en };\n    // ---------------------------------------------------------------- mount'), context);
  return api;
}
const { filterSkills, runtimeBadge, zh, en } = loadClient();
const skills = [
  { name: 'beta', description: 'PDF tools', source: 'user-agents', agents: ['a'], runtimes: ['claude-code', 'codex', 'dsh'], modelInvocable: true, writable: true, usage: { count: 12, lastUsedAt: 5 } },
  { name: 'Alpha', description: '文档处理', source: 'bundled', agents: ['a', 'b'], runtimes: ['codex', 'dsh'], modelInvocable: false, writable: false, usage: { count: 2, lastUsedAt: 20 } },
  { name: 'gamma', description: '', source: 'custom', agents: ['b'], runtimes: ['dsh'], modelInvocable: true, writable: true, usage: null },
];
const names = (items) => Array.from(items, (item) => item.name);

test('library combines text, agent and permission filters without mutating its snapshot', () => {
  assert.deepEqual(names(filterSkills(skills, { runtime: 'codex', query: '  pDf ', status: 'enabled' })), ['beta']);
  assert.deepEqual(names(filterSkills(skills, { query: '文档' })), ['Alpha']);
  assert.deepEqual(names(filterSkills(skills, { query: 'BUNDLED' })), ['Alpha']);
  assert.deepEqual(names(filterSkills(skills, { runtime: 'dsh', status: 'writable' })), ['beta', 'gamma']);
  assert.deepEqual(names(filterSkills(skills, { status: 'disabled' })), ['Alpha']);
  assert.equal(filterSkills(skills, { query: 'nothing' }).length, 0);
  assert.deepEqual(names(skills), ['beta', 'Alpha', 'gamma']);
});

test('library sorting handles usage, recency and missing counters', () => {
  assert.deepEqual(names(filterSkills(skills)), ['beta', 'Alpha', 'gamma']);
  assert.deepEqual(names(filterSkills(skills, { sort: 'name' })), ['Alpha', 'beta', 'gamma']);
  assert.deepEqual(names(filterSkills(skills, { sort: 'recent' })), ['Alpha', 'beta', 'gamma']);
});

test('the agent badge names the only agent, counts the rest, and stays away otherwise', () => {
  const runtimes = [
    { id: 'claude-code', title: 'Claude Code', skillCount: 1 },
    { id: 'codex', title: 'Codex', skillCount: 2 },
    { id: 'dsh', title: 'DSH', skillCount: 3 },
  ];
  const shared = runtimeBadge({ runtimes: ['claude-code', 'codex', 'dsh'] }, runtimes);
  assert.equal(shared.kind, 'none', 'every agent reads it, so no badge');
  const one = runtimeBadge({ runtimes: ['dsh'] }, runtimes);
  assert.equal(one.kind, 'one');
  assert.equal(one.agent, 'DSH');
  const some = runtimeBadge({ runtimes: ['codex', 'dsh'] }, runtimes);
  assert.equal(some.kind, 'some');
  assert.equal(some.count, 2);
  assert.equal(some.total, 3);
  assert.equal(some.title, 'Codex · DSH', 'the title names every agent');
  assert.equal(runtimeBadge({ runtimes: [] }, runtimes).kind, 'none');
  assert.equal(runtimeBadge({ runtimes: ['dsh'] }, []).kind, 'none', 'without a detected agent there is no badge');
});

test('switching discovery source invalidates pending success and failure responses', async () => {
  for (const ok of [true, false]) {
    let answer;
    const { createRuntime } = loadClient(() => new Promise((resolve) => { answer = resolve; }));
    const runtime = createRuntime();
    runtime.selectSource('skills-sh');
    const oldSearch = runtime.runDiscover('skills-sh', '');
    runtime.selectSource('tencent');
    answer({ ok, status: ok ? 200 : 502, json: async () => ({ ok, items: [{ name: 'wrong-source', ref: 'owner/repo' }] }) });
    assert.equal(await oldSearch, false);
    const state = runtime.store.getSnapshot().discover;
    assert.equal(state.source, 'tencent');
    assert.equal(state.status, 'idle');
    assert.equal(state.items.length, 0);
    runtime.dispose();
  }
});

test('the latest discovery search wins even when older requests finish last', async () => {
  const pending = [];
  const { createRuntime } = loadClient(() => new Promise((resolve) => pending.push(resolve)));
  const runtime = createRuntime();
  const first = runtime.runDiscover('tencent', 'first');
  const second = runtime.runDiscover('tencent', 'second');
  pending[1]({ ok: true, json: async () => ({ ok: true, items: [{ name: 'second' }] }) });
  await second;
  pending[0]({ ok: true, json: async () => ({ ok: true, items: [{ name: 'first' }] }) });
  await first;
  assert.equal(runtime.store.getSnapshot().discover.items[0].name, 'second');
  runtime.dispose();
});

test('period projection counts retained daily calls instead of cumulative or recent records', () => {
  const { usagePeriodProjection: project } = loadClient();
  const dates = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 10, 18 - 59 + i)).toISOString().slice(0, 10));
  const buckets = (n) => dates.map((date) => ({ date, count: n }));
  const data = { skills: [{ name: 'alpha' }, { name: 'idle' }], usage: {
    totalCount: 999, history: buckets(3), skillUsage: [
      { name: 'alpha', count: 500, dayBuckets: buckets(2) },
      { name: 'removed', count: 499, dayBuckets: buckets(1) },
    ], recent: [{ name: 'alpha', at: 0 }],
  } };
  for (const days of [1, 7, 14, 30, 60]) {
    const p = project(data, { period: String(days), query: 'ALP', selected: 'removed' });
    assert.equal(p.total, days * 3); assert.equal(p.active, 2); assert.equal(p.trendTotal, days);
    assert.equal(p.rows.length, 1); assert.equal(p.rows[0].count, days * 2); assert.equal(p.rows[0].share, 2 / 3);
    assert.equal(p.allRows.find((row) => row.name === 'idle').count, 0);
    assert.equal(p.allRows.find((row) => row.name === 'removed').removed, true);
  }
  assert.equal(project(data, { period: 'custom', start: '2026-11-17', end: '2026-11-18' }).total, 6);
  for (const [start, end, error] of [['', '', 'required'], ['2026-11-18', '2026-11-17', 'order'], ['2026-02-30', '2026-11-18', 'invalid'], ['2025-01-01', '2026-11-18', 'bounds']]) {
    assert.equal(project(data, { period: 'custom', start, end }).error, error);
  }
  const legacy = { skills: [{ name: 'old', usage: { days: Array(14).fill(2) } }], usage: { dayBuckets: buckets(2).slice(-14) } };
  const old = project(legacy, { period: '60' });
  assert.equal(old.total, 28); assert.equal(old.rows[0].count, 28); assert.equal(old.bounded, true);
});

test('a skill named all has a distinct trend from the aggregate', () => {
  const { usagePeriodProjection: project } = loadClient();
  const date = '2026-11-18';
  const data = {
    skills: [{ name: 'all' }, { name: 'other' }],
    usage: {
      history: [{ date, count: 5 }],
      skillUsage: [{ name: 'all', count: 2, dayBuckets: [{ date, count: 2 }] }],
    },
  };
  assert.equal(project(data).trendTotal, 5);
  assert.equal(project(data, { selected: 'all' }).trendTotal, 2);
});

test('preview hierarchy retains paths and cached file-only responses retain the tree', () => {
  const { previewFileTree, rememberPreview, cachedPreview, PREVIEW_MEMORY } = loadClient();
  const files = ['SKILL.md', 'references/nested/guide.md', 'references/quick.md', '__proto__/safe.txt'].map((path) => ({ path, kind: 'text' }));
  const tree = previewFileTree(files);
  const references = tree.find((node) => node.name === 'references');
  assert.equal(references.children.find((node) => node.name === 'nested').children[0].file.path, 'references/nested/guide.md');
  assert.equal(tree.find((node) => node.name === '__proto__').children[0].path, '__proto__/safe.txt');
  rememberPreview('demo', { ok: true, files, skill: { name: 'demo' }, file: { path: 'SKILL.md', kind: 'text', content: 'main' } });
  rememberPreview('demo', { ok: true, file: { path: 'references/quick.md', kind: 'binary', content: null } });
  assert.equal(cachedPreview('demo', 'references/quick.md').files.length, 4);
  assert.equal(cachedPreview('demo', '').file.content, 'main');
  assert.equal(cachedPreview('demo', 'references/quick.md').files.find((f) => f.path === 'references/quick.md').kind, 'binary');
  PREVIEW_MEMORY.get('demo').at = Date.now() - 31_000;
  assert.equal(cachedPreview('demo', ''), null);
});

test('both shipped dictionaries stay synchronized with runtime strings', async () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [lang, dictionary] of [['zh', zh], ['en', en]]) {
    const disk = JSON.parse(await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'));
    for (const [key, value] of Object.entries(dictionary)) assert.equal(disk[key], value, `${lang}:${key}`);
  }
});

test('the detected agent strings exist in both dictionaries and the old badge is gone', () => {
  for (const dictionary of [zh, en]) {
    for (const key of ['filter.agentOption', 'skill.runtimesOne', 'skill.runtimesSome', 'overview.agents']) {
      assert.equal(typeof dictionary[key], 'string', `${key} is missing`);
      assert.equal(dictionary[key].length > 0, true, `${key} is empty`);
    }
    assert.equal(Object.hasOwn(dictionary, 'skill.agents'), false, 'the preset badge string is gone');
  }
  assert.equal(zh['skill.runtimesSome'], '{count}/{total} 个 Agent');
  assert.equal(en['skill.runtimesSome'], '{count}/{total} agents');
  assert.equal(zh['skill.runtimesOne'], '仅 {agent}');
  assert.equal(en['skill.runtimesOne'], '{agent} only');
  assert.equal(zh['overview.agents'], '已检测 Agent');
  assert.equal(en['overview.agents'], 'Coding agents');
});
