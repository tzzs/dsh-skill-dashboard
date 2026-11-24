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
    '    return { filterSkills, runtimeBadge, createRuntime, shouldAutoCheck, Segmented, TabBar, usagePeriodProjection, diagnosisRows, diagnosisTally, previewFileTree, cachedPreview, rememberPreview, PREVIEW_MEMORY, zh, en };\n    // ---------------------------------------------------------------- mount'), context);
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

test('a row update sends its path, and a bind reference only when the form supplies one', async () => {
  const posts = [];
  let reply = { ok: true, name: 'pdf', path: 'C:\\skills\\pdf', changed: false };
  const { createRuntime } = loadClient(async (route, init) => {
    if (route === 'skill-dashboard/action') posts.push(JSON.parse(init.body));
    return { ok: true, json: async () => reply };
  });
  const runtime = createRuntime();
  const skill = { name: 'pdf', path: 'C:\\skills\\pdf' };
  try {
    await runtime.updateSkill(skill);
    assert.deepEqual(posts.at(-1), { action: 'update', name: 'pdf', path: 'C:\\skills\\pdf' });
    assert.equal(runtime.store.getSnapshot().note.key, 'status.upToDate');

    reply = { ...reply, changed: true };
    await runtime.updateSkill(skill);
    assert.equal(runtime.store.getSnapshot().note.key, 'status.updatedSkill');

    reply = { ...reply, changed: false };
    await runtime.updateSkill(skill, 'anthropics/skills#skills/pdf');
    assert.deepEqual(posts.at(-1),
      { action: 'update', name: 'pdf', path: 'C:\\skills\\pdf', ref: 'anthropics/skills#skills/pdf' });
    assert.equal(runtime.store.getSnapshot().note.key, 'status.boundSource', 'a bind with no byte change is a link receipt');
  } finally {
    runtime.dispose();
  }
});

test('the GitHub install form posts a bare reference and takes the name from the Host reply', async () => {
  const posts = [];
  const { createRuntime } = loadClient(async (route, init) => {
    if (route === 'skill-dashboard/action') posts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: true, name: 'pdf', path: 'C:\\skills\\pdf' }) };
  });
  const runtime = createRuntime();
  try {
    assert.equal(await runtime.installSkill({ ref: 'anthropics/skills#skills/pdf' }, ''), true);
    assert.deepEqual(posts.at(-1), { action: 'install', ref: 'anthropics/skills#skills/pdf' });
    assert.equal(runtime.store.getSnapshot().note.params.name, 'pdf');

    assert.equal(await runtime.installSkill({ name: 'pdf', ref: 'skills/pdf' }, 'skills-sh'), true);
    assert.deepEqual(posts.at(-1), { action: 'install', source: 'skills-sh', ref: 'skills/pdf', name: 'pdf' });
  } finally {
    runtime.dispose();
  }
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

test('both shipped dictionaries stay synchronized with runtime strings in both directions', async () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [lang, dictionary] of [['zh', zh], ['en', en]]) {
    const disk = JSON.parse(await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'));
    assert.equal(typeof disk.meta?.title, 'string', `${lang}:meta.title`);
    assert.equal(disk.meta.title.length > 0, true, `${lang}:meta.title empty`);
    assert.equal(typeof disk.meta?.description, 'string', `${lang}:meta.description`);
    assert.equal(disk.meta.description.length > 0, true, `${lang}:meta.description empty`);
    const diskKeys = Object.keys(disk).filter((key) => key !== 'meta').sort();
    assert.deepEqual(diskKeys, Object.keys(dictionary).sort(), `${lang} key sets match`);
    for (const [key, value] of Object.entries(dictionary)) assert.equal(disk[key], value, `${lang}:${key}`);
  }
});

test('the preview file count, renamed invocation switches, and Host error codes stay localized', () => {
  assert.equal(zh['preview.fileCount'], '共 {count} 个文件');
  assert.equal(en['preview.fileCount'], '{count} files');
  assert.equal(zh['skill.model'], '自动调用');
  assert.equal(zh['skill.user'], '/name 手动');
  assert.equal(en['skill.model'], 'Auto-invoke');
  assert.equal(en['skill.user'], '/name manual');
  assert.equal(zh['skill.modelSwitchAria'], '自动调用：{name}');
  assert.equal(zh['skill.userSwitchAria'], '/name 手动：{name}');
  assert.equal(en['skill.modelSwitchAria'], 'Auto-invoke: {name}');
  assert.equal(en['skill.userSwitchAria'], '/name manual: {name}');
  const errorCodes = [
    'read-only', 'source-unavailable', 'source-rate-limited', 'invalid-response',
    'preview-unavailable', 'preview-failed', 'skill-not-found', 'file-not-found',
    'bad-request', 'not-found', 'unknown-action', 'unknown-source',
    'invalid-frontmatter', 'missing-frontmatter', 'write-failed', 'delete-failed',
    'name-mismatch', 'payload-too-large', 'state-unavailable', 'internal-error',
    'already-installed', 'not-installed', 'not-installable', 'install-failed', 'update-failed',
  ];
  for (const [lang, dictionary] of [['zh', zh], ['en', en]]) {
    for (const key of ['skill.modelHint', 'skill.userHint']) {
      assert.equal(typeof dictionary[key], 'string', `${lang}:${key} is missing`);
      assert.equal(dictionary[key].length > 0, true, `${lang}:${key} is empty`);
    }
    for (const code of errorCodes) {
      const key = 'error.' + code;
      assert.equal(typeof dictionary[key], 'string', `${lang}:${key} is missing`);
      assert.equal(dictionary[key].length > 0, true, `${lang}:${key} is empty`);
    }
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
  assert.equal(en['overview.agents'], 'Detected agents');
});

test('concurrent refreshes coalesce and background refresh failures preserve loaded state', async () => {
  let calls = 0;
  let resolveFirst;
  const { createRuntime } = loadClient(() => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return Promise.reject(new Error('network down'));
  });
  const runtime = createRuntime();
  const a = runtime.refresh();
  const b = runtime.refresh();
  assert.equal(calls, 1, 'concurrent refreshes share one in-flight request');
  resolveFirst({ ok: true, json: async () => ({ ok: true, skills: [{ name: 'alpha' }] }) });
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(runtime.store.getSnapshot().status, 'ready');
  assert.equal(runtime.store.getSnapshot().syncError, false);

  const ok = await runtime.refresh();
  assert.equal(ok, false);
  const after = runtime.store.getSnapshot();
  assert.equal(after.status, 'ready', 'working UI stays mounted when a background refresh fails');
  assert.equal(after.syncError, true);
  assert.equal(after.data.skills[0].name, 'alpha');
  runtime.dispose();
});

test('initial load failure transitions to offline when no snapshot exists', async () => {
  const { createRuntime } = loadClient(async () => { throw new Error('offline'); });
  const runtime = createRuntime();
  assert.equal(await runtime.refresh(), false);
  const snap = runtime.store.getSnapshot();
  assert.equal(snap.data, null);
  assert.equal(snap.status, 'offline');
  assert.equal(snap.syncError, true);
  runtime.dispose();
});

test('mutations apply inline state or perform one authoritative refresh without a delayed refetch', async () => {
  const urls = [];
  const { createRuntime } = loadClient(async (url) => {
    urls.push(url);
    if (url.endsWith('/action')) return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({ ok: true, skills: [{ name: 'alpha', modelInvocable: false }] }) };
  });
  const runtime = createRuntime();
  const ok = await runtime.setInvocation({ path: '/tmp/alpha/SKILL.md' }, { modelInvocable: false });
  assert.equal(ok, true);
  assert.deepEqual(urls, ['skill-dashboard/action', 'skill-dashboard/state']);
  assert.equal(runtime.store.getSnapshot().data.skills[0].modelInvocable, false);
  runtime.dispose();
});

test('the automatic update check runs once per window and only when a skill is tracked', () => {
  const { shouldAutoCheck } = loadClient();
  const now = 1796000000000;
  const sixHours = 6 * 60 * 60 * 1000;
  const tracked = [{ name: 'a', installed: { source: 'github', ref: 'o/r#skills/a' }, dir: '/skills/a' }];
  assert.equal(shouldAutoCheck(undefined, tracked, now), true, 'no block at all is due');
  assert.equal(shouldAutoCheck({ checkedAt: 0, available: [] }, tracked, now), true);
  assert.equal(shouldAutoCheck({ checkedAt: now - 60_000 }, tracked, now), false, 'a fresh record is left alone');
  assert.equal(shouldAutoCheck({ checkedAt: now - sixHours + 1 }, tracked, now), false);
  assert.equal(shouldAutoCheck({ checkedAt: now - sixHours }, tracked, now), true);
  assert.equal(shouldAutoCheck(undefined, [{ name: 'b', installed: null, dir: '/skills/b' }], now), false,
    'a skill with no provenance is not checked');
  assert.equal(shouldAutoCheck(undefined, [{ name: 'c', installed: { source: 'github', ref: 'o/r' }, dir: null }], now), false,
    'a flat skill has no directory to compare');
  assert.equal(shouldAutoCheck(undefined, [], now), false);
});

test('an update check walks the Host in bounded chunks and refreshes once at the end', async () => {
  const posts = [];
  const urls = [];
  const { createRuntime } = loadClient(async (url, init) => {
    urls.push(url);
    if (url.endsWith('/action')) {
      const body = JSON.parse(init.body);
      posts.push(body);
      const nextCursor = Math.min(body.cursor + 4, 10);
      return { ok: true, json: async () => ({ ok: true, total: 10, cursor: body.cursor, nextCursor, done: nextCursor >= 10, checked: [] }) };
    }
    return { ok: true, json: async () => ({ ok: true, skills: [], updates: { checkedAt: 2, available: [] } }) };
  });
  const runtime = createRuntime();
  try {
    const run = runtime.checkUpdates({ refresh: true });
    assert.equal(runtime.store.getSnapshot().updatesChecking, true);
    assert.equal(runtime.checkUpdates(), run, 'a second gesture joins the running check');
    assert.equal(await run, true);
    assert.deepEqual(posts.map((body) => [body.action, body.cursor, body.limit, body.refresh]), [
      ['check-updates', 0, 4, true],
      ['check-updates', 4, 4, true],
      ['check-updates', 8, 4, true],
    ]);
    assert.equal(urls.at(-1), 'skill-dashboard/state', 'one state read lands the new block');
    const snapshot = runtime.store.getSnapshot();
    assert.equal(snapshot.updatesChecking, false);
    assert.equal(snapshot.updatesProgress.done, 10);
    assert.equal(snapshot.updatesProgress.total, 10);
    assert.equal(snapshot.data.updates.checkedAt, 2);
  } finally {
    runtime.dispose();
  }
});

test('an older Host without the check action fails quietly and clears its flag', async () => {
  const { createRuntime } = loadClient(async (url) => {
    if (url.endsWith('/action')) {
      return { ok: false, status: 400, json: async () => ({ ok: false, code: 'unknown-action', message: 'unknown action' }) };
    }
    return { ok: true, json: async () => ({ ok: true, skills: [] }) };
  });
  const runtime = createRuntime();
  try {
    assert.equal(await runtime.checkUpdates({ refresh: true }), false);
    const snapshot = runtime.store.getSnapshot();
    assert.equal(snapshot.updatesChecking, false);
    assert.equal(snapshot.note, null, 'a failed check adds no error note');
  } finally {
    runtime.dispose();
  }
});

test('a transiently empty chunk is retried instead of ending the walk early', async () => {
  const cursors = [];
  let calls = 0;
  const { createRuntime } = loadClient(async (url, init) => {
    if (url.endsWith('/action')) {
      const body = JSON.parse(init.body);
      cursors.push(body.cursor);
      calls += 1;
      if (calls === 2) {
        return { ok: true, json: async () => ({ ok: true, total: 0, cursor: body.cursor, nextCursor: 0, done: true, checked: [] }) };
      }
      const nextCursor = Math.min(body.cursor + 4, 8);
      return { ok: true, json: async () => ({ ok: true, total: 8, cursor: body.cursor, nextCursor, done: nextCursor >= 8, checked: [] }) };
    }
    return { ok: true, json: async () => ({ ok: true, skills: [] }) };
  });
  const runtime = createRuntime();
  try {
    assert.equal(await runtime.checkUpdates(), true);
    assert.deepEqual(cursors, [0, 4, 4], 'the collapsed cursor is retried before the walk ends');
    assert.equal(runtime.store.getSnapshot().updatesProgress.done, 8);
  } finally {
    runtime.dispose();
  }
});

const diagnosis = {
  evaluatedAt: 1796000000000,
  since: 1795000000000,
  observedDays: 11,
  thresholds: { activeDays: 14, staleDays: 30, watchDays: 3 },
  counts: { active: 2, cleanup: 3, dormant: 1, kept: 1, unknown: 1, total: 8 },
  skills: [
    { name: 'pdf-merge', verdict: 'stale', bucket: 'cleanup', idleDays: 41, watchedDays: 11, lastUsedAt: 1792500000000, useCount: 2, keptAt: null, closed: false, writable: true, can: { disable: true, remove: true, keep: true } },
    { name: 'never-used', verdict: 'unused', bucket: 'cleanup', idleDays: null, watchedDays: 11, lastUsedAt: null, useCount: 0, keptAt: null, closed: false, writable: true, can: { disable: true, remove: true, keep: true } },
    { name: 'bundled-tool', verdict: 'unused', bucket: 'cleanup', idleDays: null, watchedDays: 30, lastUsedAt: null, useCount: 0, keptAt: null, closed: false, writable: false, can: { disable: false, remove: false, keep: true } },
    { name: 'old-notes', verdict: 'stale', bucket: 'dormant', idleDays: 53, watchedDays: 60, lastUsedAt: 1791500000000, useCount: 4, keptAt: null, closed: true, writable: true, can: { disable: false, remove: true, keep: true } },
    { name: 'code-review', verdict: 'active', bucket: 'active', idleDays: 2, watchedDays: 60, lastUsedAt: 1795800000000, useCount: 12, keptAt: null, closed: false, writable: true, can: { disable: false, remove: false, keep: false } },
    { name: 'archived', verdict: 'kept', bucket: 'kept', idleDays: 70, watchedDays: 60, lastUsedAt: 1790000000000, useCount: 1, keptAt: 1795000000000, closed: false, writable: true, can: { disable: true, remove: true, keep: true } },
    { name: 'just-added', verdict: 'unknown', bucket: 'unknown', idleDays: null, watchedDays: 1, lastUsedAt: null, useCount: 0, keptAt: null, closed: false, writable: true, can: { disable: false, remove: false, keep: true } },
    { name: 'cooling-skill', verdict: 'cooling', bucket: 'active', idleDays: 22, watchedDays: 60, lastUsedAt: 1794100000000, useCount: 3, keptAt: null, closed: false, writable: true, can: { disable: false, remove: false, keep: false } },
  ],
};

test('diagnosis queue filters by bucket and searches names without regard to case', () => {
  const { diagnosisRows } = loadClient();
  assert.deepEqual(names(diagnosisRows(diagnosis, { bucket: 'cleanup' })), ['pdf-merge', 'never-used', 'bundled-tool']);
  assert.deepEqual(names(diagnosisRows(diagnosis, { bucket: 'cleanup', query: '  PDF ' })), ['pdf-merge']);
  assert.deepEqual(names(diagnosisRows(diagnosis, { bucket: 'cleanup', query: 'never' })), ['never-used']);
  assert.deepEqual(names(diagnosisRows(diagnosis, { bucket: 'active' })), ['code-review', 'cooling-skill']);
  assert.deepEqual(names(diagnosisRows(diagnosis, { bucket: 'cleanup', query: 'nothing' })), []);
  assert.deepEqual(names(diagnosisRows(diagnosis, { bucket: 'cleanup', sort: 'name' })), ['bundled-tool', 'never-used', 'pdf-merge']);
  assert.equal(diagnosisRows(diagnosis, { bucket: 'cleanup' })[0].verdict, 'stale', 'the Host verdict is copied, not recomputed');
  assert.equal(diagnosisRows(diagnosis, { bucket: 'cleanup' })[0].can.remove, true);
  assert.equal(diagnosis.skills[0].name, 'pdf-merge', 'the projection does not mutate its input');
});

test('the five buckets partition the catalog and match the Host counts', () => {
  const { diagnosisRows } = loadClient();
  const buckets = ['cleanup', 'dormant', 'active', 'kept', 'unknown'];
  const lists = buckets.map((bucket) => diagnosisRows(diagnosis, { bucket }));
  const all = lists.flat();
  assert.equal(all.length, diagnosis.counts.total);
  assert.equal(all.length, diagnosis.skills.length);
  assert.equal(new Set(all.map((row) => row.name)).size, diagnosis.counts.total);
  buckets.forEach((bucket, index) => assert.equal(lists[index].length, diagnosis.counts[bucket], bucket));
  assert.deepEqual(names(diagnosisRows(diagnosis, { bucket: '' })), diagnosis.skills.map((skill) => skill.name));
});

test('a read-only row never enters a disable target list', () => {
  const { diagnosisRows, diagnosisTally } = loadClient();
  const rows = diagnosisRows(diagnosis, { bucket: 'cleanup' });
  const tally = diagnosisTally(rows, ['pdf-merge', 'bundled-tool']);
  assert.deepEqual(Array.from(tally.names), ['pdf-merge', 'bundled-tool']);
  assert.deepEqual(Array.from(tally.disable), ['pdf-merge']);
  assert.deepEqual(Array.from(tally.remove), ['pdf-merge']);
  assert.deepEqual(Array.from(tally.readonly), ['bundled-tool']);
  assert.deepEqual(Array.from(tally.keep, (entry) => ({ name: entry.name, keep: entry.keep })),
    [{ name: 'pdf-merge', keep: true }, { name: 'bundled-tool', keep: true }]);
  const dormant = diagnosisTally(diagnosisRows(diagnosis, { bucket: 'dormant' }), ['old-notes']);
  assert.deepEqual(Array.from(dormant.disable), [], 'a closed skill cannot be disabled');
  assert.deepEqual(Array.from(dormant.remove), ['old-notes']);
  assert.deepEqual(Array.from(diagnosisTally(rows, []).names), []);
  assert.deepEqual(Array.from(diagnosisTally(rows, ['code-review']).names), [], 'a row outside the queue is not a target');
});

test('a kept row in the tally offers unkeep rather than keep', () => {
  const { diagnosisRows, diagnosisTally } = loadClient();
  const tally = diagnosisTally(diagnosisRows(diagnosis, { bucket: 'kept' }), ['archived']);
  assert.deepEqual(Array.from(tally.keep, (entry) => ({ name: entry.name, keep: entry.keep })), [{ name: 'archived', keep: false }]);
  assert.equal(tally.keep[0].keep, false);
  assert.deepEqual(Array.from(diagnosisTally(diagnosisRows(diagnosis, { bucket: 'active' }), ['code-review']).keep), [],
    'a row the Host marked cannot be kept is not a target');
});
