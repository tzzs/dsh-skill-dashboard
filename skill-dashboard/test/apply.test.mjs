/**
 * Throwaway integration harness: runs `apply(ctx)` against a fake Host context
 * and drives the three HTTP handlers over temp fixtures.
 *
 * Run with Node.js 20 or later:
 *   node test/apply.test.mjs
 *
 * Nothing here touches the real profile, the real Host, or the network.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rename as fsRename, rm, stat, symlink as fsSymlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { tarArchive } from './tar-fixture.mjs'

const { apply, moveStagedTree, lockProvenanceOf, changedSkillPaths, describeUpdates } = await import('../index.js')

/** Label every printed assertion. */
let passed = 0

const failures = []

function check(name, body) {
  return Promise.resolve()
    .then(body)
    .then(() => {
      passed += 1
      console.log(`  ok  ${name}`)
    })
    .catch((error) => {
      failures.push({ name, error })
      console.log(`FAIL  ${name}\n      ${error.message}`)
    })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One request double that is an async iterable like an IncomingMessage. */
function mockRequest({ method = 'GET', headers = {}, body = '' }) {
  return {
    method,
    url: '/skill-dashboard',
    headers,
    on() {},
    once() {},
    off() {},
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield Buffer.from(body, 'utf8')
    },
  }
}

/** One response double that records status, headers, and the JSON body. */
function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(body) {
      this.writableEnded = true
      this.body = body
    },
    once() {},
    off() {},
  }
}

/** A fake Cordis context: services, events, effects, and the webServer routes. */
function createFakeContext({ cwd, services }) {
  const routes = new Map()
  const listeners = new Map()
  const warnings = []
  const registered = []
  const ctx = {
    logger: {
      info() {},
      warn(message) {
        warnings.push(String(message))
      },
    },
    skills: {
      async list(options) {
        const delegate = services.get('skills')
        return (await delegate?.list?.(options)) ?? []
      },
    },
    get: (name) => services.get(name),
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {}
    },
    effect(factory, label) {
      const disposer = factory()
      registered.push({ label, disposer })
      return disposer
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    workingDirectory: cwd,
  }
  return { ctx, routes, listeners, warnings, registered }
}

/** Invoke one registered route handler and collect its JSON answer. */
async function call(route, { method = 'GET', headers = {}, body = '', raw = false } = {}) {
  const request = mockRequest({ method, headers, body })
  const response = mockResponse()
  route.handler(request, response)
  const deadline = Date.now() + 8000
  while (!response.writableEnded && Date.now() < deadline) await sleep(5)
  if (!response.writableEnded) throw new Error('handler never answered')
  if (raw) return { status: response.statusCode, body: response.body, headers: response.headers }
  return { status: response.statusCode, body: response.body === undefined ? undefined : JSON.parse(response.body) }
}

/** Write one skill directory fixture. */
async function writeSkill(root, name, frontmatter, body = `# ${name}\n\nBody.\n`) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`, 'utf8')
  return join(directory, 'SKILL.md')
}

const workspace = await mkdtemp(join(tmpdir(), 'skd-apply-'))
const home = join(workspace, 'dsh-home')
const agents = join(workspace, 'agents-home')
const agentsSkills = join(agents, 'skills')
const outside = join(workspace, 'outside')
await mkdir(agentsSkills, { recursive: true })
await mkdir(outside, { recursive: true })

process.env.DSH_HOME = home
process.env.DSH_AGENTS_HOME = agents

// A corrupt store must read as empty, never crash the plugin.
await mkdir(join(home, 'skill-dashboard'), { recursive: true })
await writeFile(join(home, 'skill-dashboard', 'usage.json'), '{ this is not json', 'utf8')
await writeFile(join(home, 'skill-dashboard', 'installed.json'), '[]', 'utf8')

const demoPath = await writeSkill(agentsSkills, 'demo-skill', 'name: demo-skill\ndescription: A demo skill for the dashboard.')
const nestedPath = await writeSkill(
  agentsSkills,
  'nested-skill',
  'name: nested-skill\nversion: 1.0.0\ndescription: "Nested: metadata."\nmetadata:\n  requires:\n    bins: ["x"]',
)
const hiddenPath = await writeSkill(
  agentsSkills,
  'hidden-skill',
  'name: hidden-skill\ndescription: Hidden from the model.\ndisable-model-invocation: true',
)
const flatPath = join(agentsSkills, 'flat-skill.md')
await writeFile(flatPath, '---\nname: flat-skill\ndescription: A flat skill.\n---\n\nFlat body.\n', 'utf8')
const outsidePath = join(outside, 'rogue.md')
await writeFile(outsidePath, '---\nname: rogue\ndescription: Outside every root.\n---\n', 'utf8')
const demoOriginal = await readFile(demoPath, 'utf8')

// ---------------------------------------------------------- scenario 1: disk

console.log('scenario 1: no agentPresets — disk fallback')
const servicesNoPresets = new Map([['workingDirectory', { defaultDirectory: workspace }]])
const first = createFakeContext({ cwd: workspace, services: servicesNoPresets })
apply(first.ctx)

await check('registers the four exact routes', () => {
  assert.deepEqual([...first.routes.keys()].sort(), [
    '/skill-dashboard/action',
    '/skill-dashboard/discover',
    '/skill-dashboard/preview',
    '/skill-dashboard/state',
  ])
  for (const route of first.routes.values()) assert.equal(route.kind, 'exact')
})

let state
await check('GET state answers the CONTRACT §4 shape from disk', async () => {
  const response = await call(first.routes.get('/skill-dashboard/state'))
  assert.equal(response.status, 200)
  state = response.body
  assert.equal(state.ok, true)
  assert.equal(typeof state.generatedAt, 'number')
  assert.deepEqual(state.agents, [{ id: 'default', title: 'Default', isDefault: true }])
  assert.equal(state.skills.length, 4, 'every fixture skill is listed')
  const byName = new Map(state.skills.map((skill) => [skill.name, skill]))
  assert.deepEqual([...byName.keys()].sort(), ['demo-skill', 'flat-skill', 'hidden-skill', 'nested-skill'])
  const demo = byName.get('demo-skill')
  assert.equal(demo.description, 'A demo skill for the dashboard.')
  assert.equal(demo.source, 'user-agents')
  assert.equal(demo.provider, 'filesystem')
  assert.equal(demo.path, demoPath)
  assert.equal(demo.dir, join(agentsSkills, 'demo-skill'))
  assert.deepEqual(demo.agents, ['default'])
  assert.equal(demo.modelInvocable, true)
  assert.equal(demo.userInvocable, true)
  assert.equal(demo.writable, true)
  assert.deepEqual(demo.usage, { count: 0, sessions: 0, lastUsedAt: null, days: new Array(14).fill(0), byModel: 0, byUser: 0 })
  assert.equal(byName.get('flat-skill').dir, null, 'flat skills report dir null')
  assert.equal(byName.get('hidden-skill').modelInvocable, false)
  assert.equal(byName.get('nested-skill').description, 'Nested: metadata.')
  assert.deepEqual(state.usage, {
    totalCount: 0,
    activeSkills: 0,
    dayBuckets: state.usage.dayBuckets,
    recent: [],
    history: state.usage.history,
    retentionDays: 60,
    skillUsage: [],
  })
  assert.equal(state.usage.dayBuckets.length, 14)
  assert.deepEqual(state.sources.map((source) => [source.id, source.status]), [
    ['skills-sh', 'ready'],
    ['tencent', 'ready'],
  ], 'an archive locator is followed from a reference and never browsed')
})

await check('a corrupt store is ignored instead of breaking the route', () => {
  assert.equal(state.usage.totalCount, 0, 'the corrupt usage store read as empty')
  assert.equal(state.usage.recent.length, 0)
  assert.equal(first.warnings.some((line) => line.includes('ignoring unreadable store')), true)
})

await check('GET state refuses a POST', async () => {
  const response = await call(first.routes.get('/skill-dashboard/state'), { method: 'POST', raw: true })
  assert.equal(response.status, 405)
  assert.equal(response.headers.allow, 'GET')
})

await check('POST action flips modelInvocable and rewrites only the frontmatter', async () => {
  const response = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: demoPath, modelInvocable: false }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.skill.name, 'demo-skill')
  assert.equal(response.body.skill.modelInvocable, false)
  assert.equal(response.body.skill.userInvocable, true)
  assert.equal(response.body.skill.path, demoPath)
  assert.equal(response.body.skill.writable, true)
  const written = await readFile(demoPath, 'utf8')
  assert.equal(
    written,
    demoOriginal.replace('description: A demo skill for the dashboard.\n---', 'description: A demo skill for the dashboard.\ndisable-model-invocation: true\n---'),
  )
})

await check('the next GET state already shows the edit (stale-catalog overlay)', async () => {
  const response = await call(first.routes.get('/skill-dashboard/state'))
  const demo = response.body.skills.find((skill) => skill.name === 'demo-skill')
  assert.equal(demo.modelInvocable, false)
})

await check('POST action restores the byte-identical original file', async () => {
  const response = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: demoPath, modelInvocable: true }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.skill.modelInvocable, true)
  assert.equal(await readFile(demoPath, 'utf8'), demoOriginal)
})

await check('set-invocation accepts another spelling of the same directory', async () => {
  // Windows names one directory both by its 8.3 short form and by its long
  // form, and the Host resolves the target before comparing it with the
  // writable roots. A second spelling of the same directory must stay
  // editable, otherwise a skill the dashboard installed looks read-only.
  const alias = join(workspace, 'agents-alias')
  try { await fsSymlink(agentsSkills, alias, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') return; throw error }
  const aliased = join(alias, 'demo-skill', 'SKILL.md')
  const response = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: aliased, modelInvocable: false }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.skill.modelInvocable, false)
  const restore = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: aliased, modelInvocable: true }),
  })
  assert.equal(restore.status, 200)
  assert.equal(await readFile(demoPath, 'utf8'), demoOriginal)
})

await check('set-invocation refuses a path outside every writable skill root', async () => {
  const response = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: outsidePath, modelInvocable: false }),
  })
  assert.equal(response.status, 403)
  assert.equal(response.body.code, 'read-only')
  assert.equal(await readFile(outsidePath, 'utf8'), '---\nname: rogue\ndescription: Outside every root.\n---\n')
})

await check('set-invocation rejects a bad body', async () => {
  const missing = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: demoPath }),
  })
  assert.equal(missing.status, 400)
  const wrongType = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: demoPath, modelInvocable: 'nope' }),
  })
  assert.equal(wrongType.status, 400)
  const text = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'nope',
  })
  assert.equal(text.status, 415)
  assert.equal(text.body.code, 'unsupported-media-type')
  const unknown = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'explode' }),
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'unknown-action')
  const huge = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'refresh', pad: 'x'.repeat(1024 * 1024 + 64) }),
  })
  assert.equal(huge.status, 413)
  assert.equal(huge.body.code, 'payload-too-large')
})

await check('POST remove deletes a flat skill file and refuses outsiders', async () => {
  const missing = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', name: 'ghost', path: join(agentsSkills, 'ghost', 'SKILL.md') }),
  })
  assert.equal(missing.status, 404)

  const outsider = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', name: 'rogue', path: outsidePath }),
  })
  assert.equal(outsider.status, 403)
  assert.equal(outsider.body.code, 'read-only')
  assert.equal(existsSync(outsidePath), true)

  const mismatch = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', name: 'wrong-name', path: flatPath }),
  })
  assert.equal(mismatch.status, 409)
  assert.equal(mismatch.body.code, 'name-mismatch')

  const removed = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', name: 'flat-skill', path: flatPath }),
  })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.body.removed, [flatPath])
  assert.equal(existsSync(flatPath), false)
})

await check('POST remove deletes a whole skill directory', async () => {
  const removed = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', name: 'nested-skill', path: nestedPath }),
  })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.body.removed, [join(agentsSkills, 'nested-skill')])
  assert.equal(existsSync(join(agentsSkills, 'nested-skill')), false)
})

await check('POST action refresh bypasses the cache', async () => {
  const response = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'refresh' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(typeof response.body.generatedAt, 'number')
})

await check('POST discover names an unknown source instead of throwing', async () => {
  for (const source of ['nope', 'well-known']) {
    const response = await call(first.routes.get('/skill-dashboard/discover'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, query: 'x' }),
    })
    assert.equal(response.status, 400, source)
    assert.equal(response.body.code, 'unknown-source', source)
  }
})

await check('usage listeners count model loads and user invocations separately', async () => {
  for (const listener of first.listeners.get('tools/result') ?? []) {
    listener({ name: 'skill', arguments: { name: 'demo-skill' }, agent: { id: 'session-1' } }, { isError: false })
    listener({ name: 'skill', arguments: { name: 'demo-skill' }, agent: { id: 'session-2' } }, { isError: false })
    listener({ name: 'skill', arguments: { name: 'demo-skill' }, agent: { id: 'session-2' } }, { isError: true })
    listener({ name: 'bash', arguments: { name: 'demo-skill' } }, { isError: false })
  }
  for (const listener of first.listeners.get('session/event') ?? []) {
    listener({ id: 'session-3' }, { type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'demo-skill' } } })
    listener({ id: 'session-3' }, { type: 'user/message', data: { source: { kind: 'user' } } })
    listener({ id: 'session-3' }, { type: 'turn/start', data: {} })
    listener({ id: 'session-3' }, null)
  }
  await sleep(1_400)
  const stored = JSON.parse(await readFile(join(home, 'skill-dashboard', 'usage.json'), 'utf8'))
  assert.equal(stored.skills['demo-skill'].count, 3)
  assert.equal(stored.skills['demo-skill'].model, 2)
  assert.equal(stored.skills['demo-skill'].user, 1)
  assert.equal(stored.skills['demo-skill'].sessions.length, 3)
  assert.equal(stored.recent.length, 3)
  assert.ok(stored.recent.every((entry) => entry.name === 'demo-skill'))
})

await check('the state response now reports usage and sorts by it', async () => {
  const response = await call(first.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'refresh' }),
  })
  assert.equal(response.status, 200)
  const after = await call(first.routes.get('/skill-dashboard/state'))
  const skills = after.body.skills
  assert.equal(skills[0].name, 'demo-skill', 'the used skill sorts first')
  assert.equal(skills[0].usage.count, 3)
  assert.equal(skills[0].usage.sessions, 3)
  assert.equal(skills[0].usage.byModel, 2)
  assert.equal(skills[0].usage.byUser, 1)
  assert.equal(skills[0].usage.days.length, 14)
  assert.equal(after.body.usage.totalCount, 3)
  assert.equal(after.body.usage.activeSkills, 1)
  assert.equal(after.body.usage.recent.length, 3)
  assert.equal(skills.length, 2, 'the two removed skills are gone')
})

// ------------------------------------------------- scenario 2: preset scopes

console.log('')
console.log('scenario 2: agent presets with scoped catalogs')
const scope2Home = join(workspace, 'dsh-home-2')
process.env.DSH_HOME = scope2Home
const scopeA = { key: { id: 'scope-a' } }
const scopeB = { key: { id: 'scope-b' } }
const disposed = []
let acquired = []
const presets = {
  async remoteExportList() {
    return {
      presets: [
        { id: 'standard', name: 'Standard', isDefault: true },
        { id: 'review', description: 'Reviewer preset' },
        { id: 'broken', broken: 'mount failed' },
      ],
    }
  },
  async acquireScope(id) {
    acquired.push(id)
    if (id === 'broken') throw new Error('preset cannot be leased')
    const lease = id === 'standard' ? scopeA : scopeB
    return {
      key: lease.key,
      async [Symbol.asyncDispose]() {
        disposed.push(id)
      },
    }
  },
}
const catalogFor = (scopeId) => {
  if (scopeId === 'scope-a') {
    return [
      {
        name: 'shared',
        description: 'from standard',
        source: 'user-agents',
        provider: 'filesystem',
        path: demoPath,
        invocation: { modelInvocable: true, userInvocable: true },
      },
      {
        name: 'only-standard',
        description: 'standard only',
        source: 'bundled',
        provider: 'filesystem',
        path: 'D:\\apps\\DeepSeek Harness\\resources\\app.asar\\dsh\\skills\\only-standard\\SKILL.md',
        invocation: { modelInvocable: true, userInvocable: true },
      },
    ]
  }
  return [
    {
      name: 'shared',
      description: 'from review',
      source: 'user-agents',
      provider: 'filesystem',
      path: demoPath,
      invocation: { modelInvocable: false, userInvocable: true },
    },
    {
      name: 'only-review',
      description: 'review only',
      source: 'user-agents',
      provider: 'filesystem',
      path: join(agentsSkills, 'only-review', 'SKILL.md'),
      invocation: { modelInvocable: true, userInvocable: false },
    },
  ]
}
const servicesWithPresets = new Map([
  ['workingDirectory', { defaultDirectory: workspace }],
  ['agentPresets', presets],
])
const skillsDouble = {
  async list(options) {
    const scope = options?.scope
    if (scope === undefined) return []
    return catalogFor(scope.id)
  },
}
servicesWithPresets.set('skills', skillsDouble)
const second = createFakeContext({ cwd: workspace, services: servicesWithPresets })
apply(second.ctx)

await check('state merges every preset catalog and releases every lease', async () => {
  const response = await call(second.routes.get('/skill-dashboard/state'))
  assert.equal(response.status, 200)
  const state2 = response.body
  assert.deepEqual(state2.agents.map((agent) => [agent.id, agent.title, agent.isDefault]), [
    ['standard', 'Standard', true],
    ['review', 'review', false],
    ['broken', 'broken', false],
  ])
  const byName = new Map(state2.skills.map((skill) => [skill.name, skill]))
  assert.deepEqual([...byName.keys()].sort(), ['only-review', 'only-standard', 'shared'])
  assert.deepEqual(byName.get('shared').agents, ['standard', 'review'])
  assert.equal(byName.get('only-standard').agents.length, 1)
  assert.equal(byName.get('only-standard').writable, false, 'bundled skills are read-only')
  assert.equal(byName.get('only-review').writable, false, 'missing files are read-only')
  assert.deepEqual(acquired.sort(), ['broken', 'review', 'standard'])
  assert.deepEqual(disposed.sort(), ['review', 'standard'], 'a failed lease is never leaked')
})

await check('a broken preset does not fail the whole route', () => {
  assert.equal(second.warnings.some((line) => line.includes('preset "broken" catalog read failed')), true)
})

// ------------------------------------ scenario 3: provenance + discover names

console.log('')
console.log('scenario 3: provenance in state and installedName on discover cards')
const provenanceHome = join(workspace, 'dsh-home-3')
const provenanceAgents = join(workspace, 'agents-home-3')
const provenanceSkills = join(provenanceAgents, 'skills')
process.env.DSH_HOME = provenanceHome
process.env.DSH_AGENTS_HOME = provenanceAgents

const pinnedDir = join(provenanceSkills, 'pinned-skill')
const handMadeDir = join(provenanceSkills, 'hand-made')
const twinDir = join(provenanceSkills, 'twin-skill')
const shadowDir = join(provenanceSkills, 'shadow-store')
const pathlessDir = join(provenanceSkills, 'pathless-skill')
for (const directory of [pinnedDir, handMadeDir, twinDir, shadowDir, pathlessDir]) {
  await mkdir(directory, { recursive: true })
}
await writeFile(join(pinnedDir, 'SKILL.md'), '---\nname: pinned-skill\ndescription: Installed by the dashboard.\n---\n', 'utf8')
await writeFile(join(handMadeDir, 'SKILL.md'), '---\nname: hand-made\ndescription: Written by hand.\n---\n', 'utf8')
await writeFile(join(twinDir, 'SKILL.md'), '---\nname: twin-skill\ndescription: Same name, another root.\n---\n', 'utf8')
await writeFile(join(shadowDir, 'SKILL.md'), '---\nname: shadow-store\ndescription: Provenance only in the skill directory.\n---\n', 'utf8')
await writeFile(join(pathlessDir, 'SKILL.md'), '---\nname: pathless-skill\ndescription: Legacy record without a path.\n---\n', 'utf8')
await writeFile(
  join(shadowDir, '.skill-source.json'),
  JSON.stringify({ source: 'skills-sh', ref: 'anthropics/skills', name: 'shadow-store', version: null, installedAt: 1763000004000 }),
  'utf8',
)
await mkdir(join(provenanceHome, 'skill-dashboard'), { recursive: true })
await writeFile(
  join(provenanceHome, 'skill-dashboard', 'installed.json'),
  JSON.stringify({
    version: 1,
    skills: {
      'pinned-skill': { source: 'tencent', ref: 'pin', version: 'v1.0.13', installedAt: 1763000000000, path: pinnedDir },
      // A stale record for the same name in a different root: never borrowed.
      'twin-skill': { source: 'skills-sh', ref: 'o/r', version: '9.9.9', installedAt: 1763000001000, path: join(provenanceSkills, 'twin-skill-elsewhere') },
      'pathless-skill': { source: 'tencent', ref: 'pl', version: '3.0.0', installedAt: 1763000002000 },
      'canned-skill': { source: 'tencent', ref: 'canned-skill', version: '2.0.0', installedAt: 1763000003000, path: join(provenanceSkills, 'canned-skill') },
    },
  }),
  'utf8',
)

const third = createFakeContext({
  cwd: workspace,
  services: new Map([['workingDirectory', { defaultDirectory: workspace }]]),
})
apply(third.ctx)

let provenanceState
await check('state exposes installed provenance, or null when unprovable', async () => {
  const response = await call(third.routes.get('/skill-dashboard/state'))
  assert.equal(response.status, 200)
  provenanceState = response.body
  const byName = new Map(provenanceState.skills.map((skill) => [skill.name, skill]))
  assert.deepEqual([...byName.keys()].sort(), ['hand-made', 'pathless-skill', 'pinned-skill', 'shadow-store', 'twin-skill'])

  assert.deepEqual(byName.get('pinned-skill').installed, {
    source: 'tencent',
    ref: 'pin',
    version: 'v1.0.13',
    installedAt: 1763000000000,
  }, 'a record whose path is this skill directory is used')
  assert.equal(byName.get('hand-made').installed, null, 'a hand-written skill has no provenance')
  assert.equal(byName.get('twin-skill').installed, null, "another root's record is never borrowed")
  assert.deepEqual(byName.get('shadow-store').installed, {
    source: 'skills-sh',
    ref: 'anthropics/skills',
    version: null,
    installedAt: 1763000004000,
  }, 'the skill directory provenance file is the fallback')
  assert.deepEqual(byName.get('pathless-skill').installed, {
    source: 'tencent',
    ref: 'pl',
    version: '3.0.0',
    installedAt: 1763000002000,
  }, 'a record without a path cannot contradict this directory')
})

await check('the installed field is purely additive', () => {
  for (const skill of provenanceState.skills) {
    for (const key of ['name', 'description', 'source', 'provider', 'path', 'dir', 'agents', 'runtimes', 'modelInvocable', 'userInvocable', 'writable', 'usage']) {
      assert.equal(Object.hasOwn(skill, key), true, `${skill.name} lost ${key}`)
    }
    assert.equal(Object.hasOwn(skill, 'installed'), true)
  }
})

await check('set-invocation echoes the full state shape including installed', async () => {
  const flipped = await call(third.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: join(pinnedDir, 'SKILL.md'), modelInvocable: false }),
  })
  assert.equal(flipped.status, 200)
  assert.equal(flipped.body.skill.modelInvocable, false)
  assert.deepEqual(flipped.body.skill.installed, {
    source: 'tencent',
    ref: 'pin',
    version: 'v1.0.13',
    installedAt: 1763000000000,
  })
  for (const key of ['name', 'description', 'source', 'provider', 'path', 'dir', 'agents', 'runtimes', 'userInvocable', 'writable', 'usage']) {
    assert.equal(Object.hasOwn(flipped.body.skill, key), true, `the echo lost ${key}`)
  }
  const restored = await call(third.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: join(pinnedDir, 'SKILL.md'), modelInvocable: true }),
  })
  assert.equal(restored.status, 200)
  assert.match(await readFile(join(pinnedDir, 'SKILL.md'), 'utf8'), /^---\nname: pinned-skill\ndescription: Installed by the dashboard\.\n---\n$/)
})

await check('discover items carry installedName next to installed', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          skills: [
            { slug: 'canned-skill', name: '罐头技能', description_zh: '一个测试技能', version: '2.0.0', downloads: 42 },
            { slug: 'other-skill', name: '其他技能', description_zh: '另一个测试技能', version: '1.0.0' },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  try {
    const response = await call(third.routes.get('/skill-dashboard/discover'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'tencent', query: 'canned', limit: 5 }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    const [first, secondItem] = response.body.items
    assert.equal(first.name, 'canned-skill')
    assert.equal(first.title, '罐头技能')
    assert.equal(first.installedName, 'canned-skill', 'installedName is the identity install and update use')
    assert.equal(first.installed, true, 'installed still marks the card')
    assert.equal(secondItem.installedName, 'other-skill')
    assert.equal(secondItem.installed, false)
    assert.equal(secondItem.title, '其他技能')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ------------------------------- scenario 4: staged move retry + installability

console.log('')
console.log('scenario 4: staged move retries, gives up cleanly, and installability flags')

await check('moveStagedTree retries one transient EPERM and lands the whole tree', async () => {
  const staging = join(workspace, 'move-a-staging')
  const destination = join(workspace, 'move-a-destination')
  await mkdir(staging, { recursive: true })
  await mkdir(join(staging, 'scripts'), { recursive: true })
  await writeFile(join(staging, 'SKILL.md'), '---\nname: moved\ndescription: d\n---\n', 'utf8')
  await writeFile(join(staging, 'scripts', 'run.sh'), 'echo hi\n', 'utf8')
  const delays = []
  let renameCalls = 0
  const outcome = await moveStagedTree(staging, destination, {
    rename: async (from, to) => {
      renameCalls += 1
      if (renameCalls === 1) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      await fsRename(from, to)
    },
    sleep: async (ms) => {
      delays.push(ms)
    },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.via, 'rename')
  assert.equal(outcome.attempts, 2)
  assert.equal(renameCalls, 2)
  assert.deepEqual(delays, [100], 'the first backoff step is 100 ms')
  assert.equal(await readFile(join(destination, 'SKILL.md'), 'utf8'), '---\nname: moved\ndescription: d\n---\n')
  assert.equal(await readFile(join(destination, 'scripts', 'run.sh'), 'utf8'), 'echo hi\n')
  assert.equal(existsSync(staging), false, 'a successful rename leaves no staging tree')
})

await check('moveStagedTree gives up after five attempts and leaves no destination', async () => {
  const staging = join(workspace, 'move-b-staging')
  const destination = join(workspace, 'move-b-destination')
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'SKILL.md'), 'x\n', 'utf8')
  const delays = []
  let renameCalls = 0
  const outcome = await moveStagedTree(staging, destination, {
    rename: async () => {
      renameCalls += 1
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
    },
    copyFile: async () => {
      throw Object.assign(new Error('EACCES: permission denied, copyfile'), { code: 'EACCES' })
    },
    sleep: async (ms) => {
      delays.push(ms)
    },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'write-failed')
  assert.equal(renameCalls, 5, 'four backoffs make five attempts')
  assert.deepEqual(delays, [100, 200, 400, 800])
  assert.equal(existsSync(destination), false, 'no partial destination survives a total failure')
  assert.equal(existsSync(join(staging, 'SKILL.md')), true, 'the staged tree stays for the caller to discard')
  await rm(staging, { recursive: true, force: true })
})

await check('discover marks installability per source', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('skills.sh/api/search')) {
      return new Response(
        JSON.stringify({
          query: 'x',
          count: 3,
          skills: [
            { id: 'anthropics/skills/pdf', source: 'anthropics/skills', skillId: 'pdf', installs: 230923 },
            { id: 'skills.voices.com/voice', source: 'skills.voices.com', skillId: 'voice', installs: 5 },
            { id: 'clawhub.ai/tool', source: 'clawhub.ai', skillId: 'tool' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({
        code: 0,
        data: { skills: [{ slug: 'canned-tencent-two', name: '罐头二号', description_zh: 'd', version: '1.0.0' }] },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const tencent = await call(third.routes.get('/skill-dashboard/discover'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'tencent', query: 'canned-two' }),
    })
    assert.equal(tencent.status, 200)
    assert.equal(tencent.body.items[0].installable, true)
    assert.equal(tencent.body.items[0].installableReason, null)
    assert.equal(tencent.body.items[0].installedName, 'canned-tencent-two', 'previous fields stay unchanged')
    assert.equal(tencent.body.items[0].installed, false)

    const skillsSh = await call(third.routes.get('/skill-dashboard/discover'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'skills-sh', query: 'installability-case' }),
    })
    assert.equal(skillsSh.status, 200)
    const byRef = new Map(skillsSh.body.items.map((item) => [item.ref, item]))
    assert.equal(byRef.get('anthropics/skills').installable, true)
    assert.equal(byRef.get('anthropics/skills').installableReason, null)
    assert.equal(byRef.get('anthropics/skills').installedName, 'pdf')
    assert.equal(byRef.get('skills.voices.com').installable, false)
    assert.equal(byRef.get('skills.voices.com').installableReason, "skills.sh needs an 'owner/repo' reference")
    assert.equal(byRef.get('clawhub.ai').installable, false)
    assert.equal(byRef.get('clawhub.ai').installableReason, "skills.sh needs an 'owner/repo' reference")
    for (const item of skillsSh.body.items) {
      assert.equal(typeof item.installed, 'boolean')
      assert.equal(typeof item.installedName, 'string')
      assert.equal(typeof item.ref, 'string')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

// --------------------------------------------- scenario 4: detected runtimes

console.log('')
console.log('scenario 5: coding agents detected from their skill roots')
const runtimeHome = join(workspace, 'runtime-home')
const runtimeAgents = join(runtimeHome, '.agents')
const runtimeCwd = join(workspace, 'runtime-cwd')
process.env.DSH_HOME = join(runtimeHome, '.dsh')
process.env.DSH_AGENTS_HOME = runtimeAgents
// The detection reads the real home, so the fixture points it at a temporary one.
const originalHomeEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
process.env.HOME = runtimeHome
process.env.USERPROFILE = runtimeHome
await mkdir(join(runtimeAgents, 'skills', 'shared-skill'), { recursive: true })
await mkdir(join(runtimeCwd, '.agents', 'skills', 'project-skill'), { recursive: true })
await mkdir(join(runtimeHome, '.claude'), { recursive: true })
await mkdir(join(runtimeHome, '.claude', 'skills', 'claude-skill'), { recursive: true })
await mkdir(join(runtimeHome, '.codex'), { recursive: true })
await writeFile(
  join(runtimeAgents, 'skills', 'shared-skill', 'SKILL.md'),
  '---\nname: shared-skill\ndescription: Shared by every agent.\n---\n\nBody.\n',
  'utf8',
)
await writeFile(
  join(runtimeCwd, '.agents', 'skills', 'project-skill', 'SKILL.md'),
  '---\nname: project-skill\ndescription: In the project root.\n---\n\nBody.\n',
  'utf8',
)
await writeFile(
  join(runtimeHome, '.claude', 'skills', 'claude-skill', 'SKILL.md'),
  '---\nname: claude-skill\ndescription: Only Claude Code reads this.\n---\n\nBody.\n',
  'utf8',
)
// A link whose target never existed: no agent root may claim it.
const brokenLink = join(runtimeAgents, 'skills', 'broken-skill')
const brokenCreated = await fsSymlink(join(workspace, 'never-existed'), brokenLink, process.platform === 'win32' ? 'junction' : 'dir')
  .then(() => true)
  .catch(() => false)

const runtimeServices = new Map([
  ['workingDirectory', { defaultDirectory: runtimeCwd }],
  ['skills', {
    async list() {
      return [
        {
          name: 'shared-skill',
          description: 'Shared by every agent.',
          source: 'user-agents',
          provider: 'filesystem',
          path: join(runtimeAgents, 'skills', 'shared-skill', 'SKILL.md'),
          invocation: { modelInvocable: true, userInvocable: true },
        },
        {
          name: 'project-skill',
          description: 'In the project root.',
          source: 'project-agents',
          provider: 'filesystem',
          path: join(runtimeCwd, '.agents', 'skills', 'project-skill', 'SKILL.md'),
          invocation: { modelInvocable: true, userInvocable: true },
        },
        {
          name: 'claude-skill',
          description: 'Only Claude Code reads this.',
          source: 'custom',
          provider: 'filesystem',
          path: join(runtimeHome, '.claude', 'skills', 'claude-skill', 'SKILL.md'),
          invocation: { modelInvocable: true, userInvocable: true },
        },
        ...(brokenCreated ? [{
          name: 'broken-skill',
          description: 'A link without a target.',
          source: 'user-agents',
          provider: 'filesystem',
          path: join(brokenLink, 'SKILL.md'),
          invocation: { modelInvocable: true, userInvocable: true },
        }] : []),
      ]
    },
  }],
])
const fourth = createFakeContext({ cwd: runtimeCwd, services: runtimeServices })
apply(fourth.ctx)

let runtimeState
await check('state lists the detected coding agents with their skill counts', async () => {
  const response = await call(fourth.routes.get('/skill-dashboard/state'))
  assert.equal(response.status, 200)
  runtimeState = response.body
  assert.deepEqual(runtimeState.runtimes.map((runtime) => [runtime.id, runtime.skillCount]), [
    ['claude-code', 1],
    ['codex', 2],
    ['dsh', runtimeState.skills.length],
  ], 'DSH is last and every runtime counts its own skills')
  const byName = new Map(runtimeState.skills.map((skill) => [skill.name, skill]))
  assert.deepEqual(byName.get('shared-skill').runtimes, ['codex', 'dsh'], 'a canonical skill reaches the universal agents')
  assert.deepEqual(byName.get('project-skill').runtimes, ['codex', 'dsh'], 'a project root is canonical too')
  assert.deepEqual(byName.get('claude-skill').runtimes, ['claude-code', 'dsh'], 'Claude Code reads only its own root')
  if (brokenCreated) assert.deepEqual(byName.get('broken-skill').runtimes, ['dsh'], 'a broken link belongs to DSH alone')
})

await check('the agent presets stay untouched next to the detected runtimes', () => {
  assert.deepEqual(runtimeState.agents, [{ id: 'default', title: 'Default', isDefault: true }])
  const byName = new Map(runtimeState.skills.map((skill) => [skill.name, skill]))
  assert.deepEqual(byName.get('shared-skill').agents, ['default'], 'the preset dimension is unchanged')
})

await check('a second read returns the same detected runtimes', async () => {
  const again = await call(fourth.routes.get('/skill-dashboard/state'))
  assert.equal(again.status, 200)
  assert.deepEqual(again.body.runtimes, runtimeState.runtimes, 'the detected runtimes are stable')
})

await check('an edit with no cached state does not shrink the detected runtimes', async () => {
  // `remove` drops the state cache without rebuilding it, so the next
  // set-invocation has no cached row to borrow its runtimes from.
  const removed = await call(fourth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', name: 'project-skill', path: join(runtimeCwd, '.agents', 'skills', 'project-skill') }),
  })
  assert.equal(removed.status, 200)
  const flip = await call(fourth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: join(runtimeAgents, 'skills', 'shared-skill', 'SKILL.md'), modelInvocable: false }),
  })
  assert.equal(flip.status, 200)
  const state = await call(fourth.routes.get('/skill-dashboard/state'))
  assert.deepEqual(state.body.runtimes.map((runtime) => runtime.id), ['claude-code', 'codex', 'dsh'], 'a single-skill echo must not poison the runtime cache')
})
process.env.HOME = originalHomeEnv.HOME
process.env.USERPROFILE = originalHomeEnv.USERPROFILE

// ------------------------------- scenario 6: diagnosis, keep, and cleanup on the routes

console.log('')
console.log('scenario 6: diagnosis on the state route, keep, and cleanup')

const diagnosisHome = join(workspace, 'dsh-home-diagnosis')
const diagnosisAgents = join(workspace, 'agents-home-diagnosis')
const diagnosisSkills = join(diagnosisAgents, 'skills')
process.env.DSH_HOME = diagnosisHome
process.env.DSH_AGENTS_HOME = diagnosisAgents
await mkdir(diagnosisSkills, { recursive: true })
await mkdir(join(diagnosisHome, 'skill-dashboard'), { recursive: true })

const keptPath = await writeSkill(diagnosisSkills, 'kept-skill', 'name: kept-skill\ndescription: A skill kept by hand.')
const doomedPath = await writeSkill(diagnosisSkills, 'doomed-skill', 'name: doomed-skill\ndescription: A skill the cleanup disables.')
const removablePath = await writeSkill(diagnosisSkills, 'removable-skill', 'name: removable-skill\ndescription: A skill the cleanup removes.')
const flatDiagnosisPath = join(diagnosisSkills, 'flat-diagnosis.md')
await writeFile(flatDiagnosisPath, '---\nname: flat-diagnosis\ndescription: A flat skill.\n---\n\nFlat body.\n', 'utf8')

const diagnosisServices = new Map([['workingDirectory', { defaultDirectory: workspace }]])
const fifth = createFakeContext({ cwd: workspace, services: diagnosisServices })
apply(fifth.ctx)

await check('GET state carries a diagnosis covering every catalog skill', async () => {
  const response = await call(fifth.routes.get('/skill-dashboard/state'))
  assert.equal(response.status, 200)
  const state = response.body
  const names = state.skills.map((skill) => skill.name).sort()
  assert.deepEqual(names, ['doomed-skill', 'flat-diagnosis', 'kept-skill', 'removable-skill'])
  assert.equal(state.skills.find((skill) => skill.name === 'kept-skill').path, keptPath)
  assert.ok(state.diagnosis !== undefined, 'the new top-level block is on the wire')
  assert.equal(state.diagnosis.evaluatedAt, state.generatedAt)
  assert.ok(state.diagnosis.since > 0)
  assert.ok(Number.isFinite(state.diagnosis.observedDays))
  assert.deepEqual(state.diagnosis.thresholds, { activeDays: 14, staleDays: 30, watchDays: 3 })
  assert.equal(state.diagnosis.counts.total, names.length)
  assert.deepEqual(state.diagnosis.skills.map((row) => row.name).sort(), names)
  const perBucket = {}
  for (const row of state.diagnosis.skills) perBucket[row.bucket] = (perBucket[row.bucket] ?? 0) + 1
  for (const [bucket, count] of Object.entries(perBucket)) assert.equal(state.diagnosis.counts[bucket], count, `${bucket} count matches its rows`)
  assert.equal(Object.values(perBucket).reduce((sum, count) => sum + count, 0), state.diagnosis.counts.total, 'every row is counted once')
  for (const row of state.diagnosis.skills) {
    assert.equal(typeof row.verdict, 'string')
    assert.deepEqual(Object.keys(row.can), ['disable', 'remove', 'keep'])
    assert.equal(row.idleDays === null, row.lastUsedAt === null)
  }
  assert.equal(Object.hasOwn(state.skills[0], 'createdAt'), false, 'the creation time never reaches the wire')
  assert.equal(JSON.stringify(state).includes('birthtimeMs'), false)
})

await check('POST keep marks a row kept and survives a re-read from disk', async () => {
  const kept = await call(fifth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'keep', name: 'kept-skill', keep: true }),
  })
  assert.equal(kept.status, 200)
  assert.deepEqual(Object.keys(kept.body), ['ok', 'name', 'keptAt'])
  assert.equal(kept.body.name, 'kept-skill')
  assert.ok(Number.isFinite(kept.body.keptAt))
  const stored = JSON.parse(await readFile(join(diagnosisHome, 'skill-dashboard', 'usage.json'), 'utf8'))
  assert.equal(stored.skills['kept-skill'].keptAt, kept.body.keptAt, 'the decision is flushed before the reply')

  const reread = await call(fifth.routes.get('/skill-dashboard/state'))
  const row = reread.body.diagnosis.skills.find((item) => item.name === 'kept-skill')
  assert.equal(row.verdict, 'kept')
  assert.equal(row.bucket, 'kept')
  assert.equal(row.keptAt, kept.body.keptAt)

  const restarted = createFakeContext({ cwd: workspace, services: diagnosisServices })
  apply(restarted.ctx)
  try {
    const fresh = await call(restarted.routes.get('/skill-dashboard/state'))
    const freshRow = fresh.body.diagnosis.skills.find((item) => item.name === 'kept-skill')
    assert.equal(freshRow.verdict, 'kept', 'a new plugin activation reads the flushed decision')
  } finally {
    for (const entry of restarted.registered) {
      if (typeof entry.disposer === 'function') entry.disposer()
    }
  }

  const cleared = await call(fifth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'keep', name: 'kept-skill', keep: false }),
  })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.keptAt, null)
  const after = await call(fifth.routes.get('/skill-dashboard/state'))
  const afterRow = after.body.diagnosis.skills.find((item) => item.name === 'kept-skill')
  assert.equal(afterRow.keptAt, null)
  assert.notEqual(afterRow.verdict, 'kept')
})

await check('POST keep validates its body and the catalog name', async () => {
  for (const body of [{ keep: true }, { name: 'kept-skill' }, { name: 'kept-skill', keep: 'yes' }]) {
    const response = await call(fifth.routes.get('/skill-dashboard/action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'keep', ...body }),
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'bad-request')
  }
  const missing = await call(fifth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'keep', name: 'not-installed', keep: true }),
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'not-found')
})

await check('POST cleanup reports one read-only failure beside one writable success', async () => {
  const original = await readFile(doomedPath, 'utf8')
  const response = await call(fifth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'cleanup',
      mode: 'disable',
      targets: [
        { name: 'rogue', path: outsidePath },
        { name: 'doomed-skill', path: doomedPath },
      ],
    }),
  })
  assert.equal(response.status, 200, 'a read-only row does not fail the request')
  assert.equal(response.body.ok, true)
  assert.equal(response.body.mode, 'disable')
  assert.equal(response.body.succeeded, 1)
  assert.equal(response.body.failed, 1)
  assert.equal(response.body.results.length, 2)
  const failed = response.body.results.find((result) => !result.ok)
  assert.equal(failed.name, 'rogue')
  assert.equal(failed.code, 'read-only')
  assert.ok(typeof failed.message === 'string' && failed.message.length > 0)
  const succeeded = response.body.results.find((result) => result.ok)
  assert.deepEqual(succeeded, { name: 'doomed-skill', ok: true })
  const written = await readFile(doomedPath, 'utf8')
  assert.match(written, /disable-model-invocation: true/)
  assert.match(written, /user-invocable: false/)

  const restore = await call(fifth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: doomedPath, modelInvocable: true, userInvocable: true }),
  })
  assert.equal(restore.status, 200)
  assert.equal(await readFile(doomedPath, 'utf8'), original)
})

await check('POST cleanup validates its batch, deduplicates paths, and can remove', async () => {
  for (const body of [
    { mode: 'archive', targets: [{ name: 'doomed-skill', path: doomedPath }] },
    { mode: 'remove', targets: [] },
    { mode: 'remove', targets: [{ name: 'doomed-skill' }] },
    { mode: 'remove', targets: [{ name: 'doomed-skill', path: 'relative.md' }] },
  ]) {
    const response = await call(fifth.routes.get('/skill-dashboard/action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cleanup', ...body }),
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'bad-request')
  }
  const original = await readFile(doomedPath, 'utf8')
  const duplicate = await call(fifth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'cleanup',
      mode: 'disable',
      targets: [
        { name: 'doomed-skill', path: doomedPath },
        { name: 'doomed-skill', path: doomedPath },
      ],
    }),
  })
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.results.length, 1, 'the repeated path is deduplicated to one target')
  assert.deepEqual(duplicate.body.results, [{ name: 'doomed-skill', ok: true }])
  await writeFile(doomedPath, original, 'utf8')

  const removed = await call(fifth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'cleanup',
      mode: 'remove',
      targets: [{ name: 'removable-skill', path: removablePath }],
    }),
  })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.body.results, [{ name: 'removable-skill', ok: true }])
  assert.equal(removed.body.succeeded, 1)
  assert.equal(existsSync(removablePath), false)
  const after = await call(fifth.routes.get('/skill-dashboard/state'))
  assert.deepEqual(after.body.diagnosis.skills.map((row) => row.name).sort(), ['doomed-skill', 'flat-diagnosis', 'kept-skill'])
})

await check('an unknown action verb still answers 400', async () => {
  const response = await call(fifth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'diagnose', name: 'kept-skill' }),
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'unknown-action')
})

// ---------------- scenario 7: GitHub install, one-time bind, pinned update

console.log('')
console.log('scenario 7: GitHub installs, one-time binds, and pinned updates')

const githubHome = join(workspace, 'dsh-home-github')
const githubAgents = join(workspace, 'agents-home-github')
const githubSkills = join(githubAgents, 'skills')
const projectSkills = join(workspace, '.agents', 'skills')
process.env.DSH_HOME = githubHome
process.env.DSH_AGENTS_HOME = githubAgents
await mkdir(join(githubHome, 'skill-dashboard'), { recursive: true })
await mkdir(githubSkills, { recursive: true })
await mkdir(projectSkills, { recursive: true })

const SHA_ONE = 'e4bb5d960d87126ff3b3a8af1a104b7db67560ba'
const SHA_TWO = '1b0e1d3a4c5f60718293a4b5c6d7e8f901234567'
const SHA_THREE = '23c4e5f60718293a4b5c6d7e8f9012345678abcd'
const pdfSkill = '---\nname: pdf\ndescription: Fill in a PDF form.\n---\n\n# pdf\n'
const notesSkill = '---\nname: notes\ndescription: Take notes.\n---\n\n# notes\n'
const legacySkill = '---\nname: legacy\ndescription: An old install.\n---\n\n# legacy\n'
const remoteSkill = '---\nname: remote\ndescription: Served through jsDelivr only.\n---\n\n# remote\n'

/** Stubbed upstream state: repositories of path→text, one head commit, one outage switch. */
const network = { calls: [], sha: SHA_ONE, api: 'ok', raw: 'ok' }
const repos = new Map()
const putRemote = (repo, path, text) => {
  if (!repos.has(repo)) repos.set(repo, new Map())
  repos.get(repo).set(path, text)
}
/** Archive URLs served as gzipped tars, exactly as a well-known registry would. */
const archives = new Map()
putRemote('anthropics/skills', 'skills/pdf/SKILL.md', pdfSkill)
putRemote('anthropics/skills', 'skills/pdf/references/guide.md', 'PDF guide.\n')
putRemote('anthropics/skills', 'skills/docx/SKILL.md', '---\nname: docx\ndescription: A docx skill.\n---\n')
putRemote('anthropics/skills', 'skills/notes/SKILL.md', notesSkill)
putRemote('anthropics/skills', 'skills/legacy/SKILL.md', legacySkill)
putRemote('acme/multi', 'alpha/SKILL.md', '---\nname: multi-alpha\ndescription: First.\n---\n')
putRemote('acme/multi', 'beta/SKILL.md', '---\nname: multi-beta\ndescription: Second.\n---\n')
putRemote('acme/fallback', 'skills/remote/SKILL.md', remoteSkill)

const fetchText = (repo, path) => repos.get(repo)?.get(path)
const repoOf = (address) => address.split('/repos/')[1].split('/').slice(0, 2).join('/')
/** Answer one stubbed GitHub URL: the tree, the file bytes, the commit, and the jsDelivr mirrors. */
const githubAnswer = (address) => {
  if (archives.has(address)) return new Response(archives.get(address), { status: 200 })
  if (address.startsWith('https://api.github.com/repos/')) {
    if (network.api === 'forbidden') return new Response('', { status: 403 })
    if (address.includes('/commits')) return Response.json([{ sha: network.sha }])
    const files = repos.get(repoOf(address)) ?? new Map()
    return Response.json({
      tree: [...files.keys()].map((path) => ({ type: 'blob', path, size: Buffer.byteLength(files.get(path)) })),
      truncated: false,
    })
  }
  if (address.startsWith('https://raw.githubusercontent.com/')) {
    if (network.raw === 'offline') throw new Error('raw read timed out')
    const [owner, repo, , ...rest] = address.slice('https://raw.githubusercontent.com/'.length).split('/')
    const text = fetchText(`${owner}/${decodeURIComponent(repo)}`, rest.map(decodeURIComponent).join('/'))
    return text === undefined ? new Response('', { status: 404 }) : new Response(text)
  }
  if (address.startsWith('https://data.jsdelivr.com/v1/packages/gh/')) {
    const files = repos.get(address.slice('https://data.jsdelivr.com/v1/packages/gh/'.length).split('@')[0])
    if (files === undefined) return new Response('', { status: 404 })
    return Response.json({ files: [...files.keys()].map((path) => ({ name: `/${path}`, size: Buffer.byteLength(files.get(path)) })) })
  }
  if (address.startsWith('https://cdn.jsdelivr.net/gh/')) {
    const [owner, repoTail, ...rest] = address.slice('https://cdn.jsdelivr.net/gh/'.length).split('/')
    const text = fetchText(`${owner}/${repoTail.split('@')[0]}`, rest.map(decodeURIComponent).join('/'))
    return text === undefined ? new Response('', { status: 404 }) : new Response(text)
  }
  throw new Error(`unexpected upstream request ${address}`)
}
const originalGithubFetch = globalThis.fetch
const stubNetwork = () => {
  network.calls = []
  globalThis.fetch = async (url) => {
    network.calls.push(String(url))
    return githubAnswer(String(url))
  }
}
const restoreNetwork = () => {
  globalThis.fetch = originalGithubFetch
}

// An old-shaped record and the skill directory it points at, written before the
// Host reads its store, so the update below sees it exactly as a 1.3.0 install left it.
const legacyDir = join(githubSkills, 'legacy')
await mkdir(legacyDir, { recursive: true })
await writeFile(join(legacyDir, 'SKILL.md'), '---\nname: legacy\ndescription: Hand written.\n---\n', 'utf8')
await writeFile(join(githubHome, 'skill-dashboard', 'installed.json'), JSON.stringify({
  version: 1,
  skills: { legacy: { source: 'skills-sh', ref: 'anthropics/skills', version: null, installedAt: 1763000000000, path: legacyDir } },
}), 'utf8')

/** The catalog the state route merges: every directory under the two fixture roots. */
const githubCatalog = async () => {
  const entries = []
  for (const [root, source] of [[githubSkills, 'user-agents'], [projectSkills, 'project-agents']]) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() !== true) continue
      entries.push({
        name: entry.name,
        description: 'A remote skill.',
        source,
        provider: 'filesystem',
        path: join(root, entry.name, 'SKILL.md'),
        invocation: { modelInvocable: true, userInvocable: true },
      })
    }
  }
  return entries
}
const githubServices = new Map([
  ['workingDirectory', { defaultDirectory: workspace }],
  ['skills', { list: githubCatalog }],
])
const eighth = createFakeContext({ cwd: workspace, services: githubServices })
apply(eighth.ctx)

const act = (body) => call(eighth.routes.get('/skill-dashboard/action'), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const installedStoreFile = join(githubHome, 'skill-dashboard', 'installed.json')

/** Wait for the debounced provenance store to include one skill instead of guessing a delay. */
const installedRecord = async (name) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const parsed = JSON.parse(await readFile(installedStoreFile, 'utf8').catch(() => '{}'))
    if (parsed?.skills?.[name] !== undefined) return parsed.skills[name]
    await sleep(50)
  }
  return undefined
}

await check('install from a /tree/ URL pins the commit in both records', async () => {
  stubNetwork()
  try {
    const installed = await act({ action: 'install', ref: 'https://github.com/anthropics/skills/tree/main/skills/pdf' })
    assert.equal(installed.status, 200, JSON.stringify(installed.body))
    assert.deepEqual(installed.body, { ok: true, name: 'pdf', path: join(githubSkills, 'pdf') })
    assert.equal(await readFile(join(githubSkills, 'pdf', 'SKILL.md'), 'utf8'), pdfSkill)
    assert.equal(await readFile(join(githubSkills, 'pdf', 'references', 'guide.md'), 'utf8'), 'PDF guide.\n')
    assert.equal(network.calls.filter((url) => url.includes('/commits')).length, 1, 'the head commit is asked for once')
    const record = await installedRecord('pdf')
    assert.deepEqual(Object.keys(record), ['source', 'ref', 'commit', 'name', 'version', 'installedAt', 'path'])
    assert.equal(record.source, 'skills-sh')
    assert.equal(record.ref, 'anthropics/skills@main#skills/pdf')
    assert.equal(record.commit, SHA_ONE)
    assert.equal(record.name, 'pdf')
    assert.equal(record.version, null)
    assert.equal(typeof record.installedAt, 'number')
    assert.equal(record.path, join(githubSkills, 'pdf'))
    const sidecar = JSON.parse(await readFile(join(githubSkills, 'pdf', '.skill-source.json'), 'utf8'))
    assert.deepEqual(sidecar, {
      source: 'skills-sh',
      ref: 'anthropics/skills@main#skills/pdf',
      commit: SHA_ONE,
      name: 'pdf',
      version: null,
      installedAt: record.installedAt,
    }, 'the portable record carries the pin and no local path')
  } finally {
    restoreNetwork()
  }
})

await check('a no-op update reports no change and reads upstream fresh', async () => {
  stubNetwork()
  try {
    const before = await readFile(join(githubSkills, 'pdf', 'SKILL.md'), 'utf8')
    const updated = await act({ action: 'update', name: 'pdf' })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.deepEqual(updated.body, { ok: true, name: 'pdf', path: join(githubSkills, 'pdf'), changed: false })
    assert.equal(network.calls.filter((url) => url.includes('/commits')).length, 1, 'the head commit is asked for once')
    assert.equal(network.calls.filter((url) => url.includes('/git/trees/')).length, 1, 'an update refuses a cached tree')
    assert.equal(await readFile(join(githubSkills, 'pdf', 'SKILL.md'), 'utf8'), before, 'an up-to-date skill keeps its bytes')
  } finally {
    restoreNetwork()
  }
})

await check('a moved pin rewrites the tree, records the new commit, and leaves no staging tree', async () => {
  const secondRevision = `${pdfSkill}\nSecond revision.\n`
  putRemote('anthropics/skills', 'skills/pdf/SKILL.md', secondRevision)
  network.sha = SHA_TWO
  stubNetwork()
  const realNow = Date.now
  // Past the 10-minute payload, tree and commit caches, including the timestamp
  // the previous case wrote: an update has to read upstream again.
  Date.now = () => realNow() + 30 * 60_000
  try {
    const updated = await act({ action: 'update', name: 'pdf' })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.changed, true)
    assert.equal(await readFile(join(githubSkills, 'pdf', 'SKILL.md'), 'utf8'), secondRevision, 'the new bytes are on disk')
    const sidecar = JSON.parse(await readFile(join(githubSkills, 'pdf', '.skill-source.json'), 'utf8'))
    assert.equal(sidecar.commit, SHA_TWO, 'the record moved to the new head commit')
    assert.deepEqual(await readdir(join(githubHome, 'skill-dashboard', 'staging')).catch(() => []), [])
  } finally {
    Date.now = realNow
    restoreNetwork()
  }
})

await check('a second update reads upstream instead of the payload cache', async () => {
  const thirdRevision = `${pdfSkill}\nThird revision.\n`
  putRemote('anthropics/skills', 'skills/pdf/SKILL.md', thirdRevision)
  network.sha = SHA_THREE
  stubNetwork()
  try {
    const updated = await act({ action: 'update', name: 'pdf' })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.changed, true, 'the previous update cached the old payload for ten minutes')
    assert.equal(await readFile(join(githubSkills, 'pdf', 'SKILL.md'), 'utf8'), thirdRevision)
    const sidecar = JSON.parse(await readFile(join(githubSkills, 'pdf', '.skill-source.json'), 'utf8'))
    assert.equal(sidecar.commit, SHA_THREE)
  } finally {
    restoreNetwork()
  }
})

await check('an update reads the source fresh on the second click', async () => {
  const fourthRevision = `${pdfSkill}\nFourth revision.\n`
  putRemote('anthropics/skills', 'skills/pdf/SKILL.md', fourthRevision)
  network.sha = SHA_TWO
  stubNetwork()
  try {
    const updated = await act({ action: 'update', name: 'pdf', path: join(githubSkills, 'pdf', 'SKILL.md') })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.changed, true)
    assert.equal(await readFile(join(githubSkills, 'pdf', 'SKILL.md'), 'utf8'), fourthRevision)
  } finally {
    restoreNetwork()
  }
})

await check('a name hint that contradicts the source is refused at install', async () => {
  putRemote('acme/hinted', 'skills/remote-name/SKILL.md', '---\nname: remote-name\ndescription: A renamed skill.\n---\n')
  stubNetwork()
  try {
    const installed = await act({ action: 'install', ref: 'acme/hinted#skills/remote-name', name: 'local-alias' })
    assert.equal(installed.status, 422)
    assert.equal(installed.body.code, 'invalid-skill')
    assert.match(installed.body.message, /remote-name/)
    assert.equal(existsSync(join(githubSkills, 'local-alias')), false, 'no directory is created for a name the source rejects')
    const direct = await act({ action: 'install', ref: 'acme/hinted#skills/remote-name' })
    assert.equal(direct.status, 200, JSON.stringify(direct.body))
    assert.equal(direct.body.name, 'remote-name')
  } finally {
    restoreNetwork()
  }
})

await check('CDN-served bytes are recorded without a pin', async () => {
  putRemote('acme/cdn-only', 'skills/cdn/SKILL.md', '---\nname: cdn\ndescription: Served only through the CDN.\n---\n')
  stubNetwork()
  network.raw = 'offline'
  try {
    const installed = await act({ action: 'install', ref: 'acme/cdn-only#skills/cdn' })
    assert.equal(installed.status, 200, JSON.stringify(installed.body))
    const sidecar = JSON.parse(await readFile(join(githubSkills, 'cdn', '.skill-source.json'), 'utf8'))
    assert.equal(sidecar.commit, null, 'a branch cached by the CDN cannot be pinned to the API head')
  } finally {
    network.raw = 'ok'
    restoreNetwork()
  }
})

await check('a file that declares no skill name cannot be updated by path', async () => {
  const directory = join(githubSkills, 'no-name')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), '# no frontmatter\n', 'utf8')
  stubNetwork()
  try {
    const updated = await act({
      action: 'update', name: 'no-name', path: join(directory, 'SKILL.md'), ref: 'anthropics/skills#skills/pdf',
    })
    assert.equal(updated.status, 409)
    assert.equal(updated.body.code, 'name-mismatch')
    assert.deepEqual(network.calls, [], 'the target is refused before any fetch')
    assert.equal(await readFile(join(directory, 'SKILL.md'), 'utf8'), '# no frontmatter\n')
  } finally {
    restoreNetwork()
  }
})

await check('a refused API degrades to jsDelivr and records no commit', async () => {
  network.api = 'forbidden'
  network.raw = 'offline'
  stubNetwork()
  try {
    const installed = await act({ action: 'install', ref: 'acme/fallback#skills/remote' })
    assert.equal(installed.status, 200, JSON.stringify(installed.body))
    assert.deepEqual(installed.body, { ok: true, name: 'remote', path: join(githubSkills, 'remote') })
    assert.equal(await readFile(join(githubSkills, 'remote', 'SKILL.md'), 'utf8'), remoteSkill)
    assert.equal(network.calls.some((url) => url.includes('/commits')), false, 'a degraded read never guesses a pin')
    assert.equal(network.calls.some((url) => url.includes('data.jsdelivr.com')), true, 'the listing came from jsDelivr')
    assert.equal(network.calls.some((url) => url.includes('cdn.jsdelivr.net')), true, 'the bytes came from the CDN')
    const sidecar = JSON.parse(await readFile(join(githubSkills, 'remote', '.skill-source.json'), 'utf8'))
    assert.equal(sidecar.commit, null)
    assert.equal(sidecar.ref, 'acme/fallback#skills/remote')
  } finally {
    network.api = 'ok'
    network.raw = 'ok'
    restoreNetwork()
  }
})

await check('a one-time bind records the local name, directory, and pin', async () => {
  const localDir = join(projectSkills, 'notes')
  await mkdir(localDir, { recursive: true })
  await writeFile(join(localDir, 'SKILL.md'), '---\nname: notes\ndescription: Local notes, hand edited.\n---\n', 'utf8')
  stubNetwork()
  try {
    const updated = await act({
      action: 'update',
      name: 'notes',
      path: join(localDir, 'SKILL.md'),
      ref: 'anthropics/skills#skills/notes',
    })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.changed, true, 'the remote bytes replaced the local file')
    assert.equal(updated.body.path, localDir)
    assert.equal(await readFile(join(localDir, 'SKILL.md'), 'utf8'), notesSkill)
    await sleep(900)
    const record = JSON.parse(await readFile(installedStoreFile, 'utf8')).skills.notes
    assert.equal(record.source, 'skills-sh')
    assert.equal(record.ref, 'anthropics/skills#skills/notes')
    assert.equal(record.commit, network.sha)
    assert.equal(record.name, 'notes')
    assert.equal(record.version, null)
    assert.equal(record.path, localDir, 'the record points at the local directory, not installRoot')
    assert.notEqual(localDir, join(githubSkills, 'notes'))
    const sidecar = JSON.parse(await readFile(join(localDir, '.skill-source.json'), 'utf8'))
    assert.equal(sidecar.commit, network.sha)
    assert.equal(sidecar.ref, 'anthropics/skills#skills/notes')
  } finally {
    restoreNetwork()
  }
})

await check('a bind whose source declares another name writes nothing', async () => {
  const localDir = join(projectSkills, 'mismatch-local')
  await mkdir(localDir, { recursive: true })
  const local = '---\nname: mismatch-local\ndescription: A local skill.\n---\n'
  await writeFile(join(localDir, 'SKILL.md'), local, 'utf8')
  stubNetwork()
  try {
    const updated = await act({
      action: 'update',
      name: 'mismatch-local',
      path: join(localDir, 'SKILL.md'),
      ref: 'anthropics/skills#skills/notes',
    })
    assert.equal(updated.status, 409)
    assert.equal(updated.body.code, 'name-mismatch')
    assert.match(updated.body.message, /mismatch-local/)
    assert.match(updated.body.message, /notes/)
    assert.equal(await readFile(join(localDir, 'SKILL.md'), 'utf8'), local, 'the local file is untouched')
    assert.equal(existsSync(join(localDir, '.skill-source.json')), false, 'no provenance is written')
    await sleep(900)
    assert.equal(JSON.parse(await readFile(installedStoreFile, 'utf8')).skills['mismatch-local'], undefined)
    assert.deepEqual(await readdir(join(githubHome, 'skill-dashboard', 'staging')).catch(() => []), [])
  } finally {
    restoreNetwork()
  }
})

await check('a bound skill cannot be re-pointed at a differently named source', async () => {
  const skillFile = join(githubSkills, 'pdf', 'SKILL.md')
  const before = await readFile(skillFile, 'utf8')
  stubNetwork()
  try {
    const updated = await act({
      action: 'update', name: 'pdf', path: skillFile, ref: 'anthropics/skills#skills/docx',
    })
    assert.equal(updated.status, 409)
    assert.equal(updated.body.code, 'name-mismatch')
    assert.match(updated.body.message, /docx/)
    assert.equal(await readFile(skillFile, 'utf8'), before, 'the bound skill keeps its own bytes')
  } finally {
    restoreNetwork()
  }
})

await check('a target outside every writable root is refused before any fetch', async () => {
  const outsider = join(outside, 'rogue-notes.md')
  await writeFile(outsider, '---\nname: rogue-notes\ndescription: Outside every root.\n---\n', 'utf8')
  stubNetwork()
  try {
    const updated = await act({
      action: 'update',
      name: 'rogue-notes',
      path: outsider,
      ref: 'anthropics/skills#skills/notes',
    })
    assert.equal(updated.status, 403)
    assert.equal(updated.body.code, 'read-only')
    assert.deepEqual(network.calls, [], 'a refused target never reaches the network')
    assert.equal(existsSync(outsider), true)
  } finally {
    restoreNetwork()
  }
})

await check('a source that disagrees with the reference is a bad request', async () => {
  stubNetwork()
  try {
    const update = await act({ action: 'update', name: 'pdf', source: 'tencent', ref: 'anthropics/skills#skills/pdf' })
    assert.equal(update.status, 400)
    assert.equal(update.body.code, 'bad-request')
    const install = await act({ action: 'install', source: 'tencent', ref: 'anthropics/skills#skills/pdf' })
    assert.equal(install.status, 400)
    assert.equal(install.body.code, 'bad-request')
    assert.deepEqual(network.calls, [], 'a disagreement is refused before any fetch')
  } finally {
    restoreNetwork()
  }
})

await check('a multi-skill repository asks for a subpath instead of guessing', async () => {
  stubNetwork()
  try {
    const ambiguous = await act({ action: 'install', ref: 'acme/multi' })
    assert.equal(ambiguous.status, 409)
    assert.equal(ambiguous.body.code, 'subpath-required')
    assert.match(ambiguous.body.message, /#alpha/)
    assert.match(ambiguous.body.message, /#beta/)
    assert.equal(existsSync(join(githubSkills, 'multi')), false, 'nothing is written while the choice is open')
    const installed = await act({ action: 'install', ref: 'acme/multi#beta' })
    assert.equal(installed.status, 200, JSON.stringify(installed.body))
    assert.equal(installed.body.name, 'multi-beta')
    assert.equal(installed.body.path, join(githubSkills, 'multi-beta'))
    const sidecar = JSON.parse(await readFile(join(githubSkills, 'multi-beta', '.skill-source.json'), 'utf8'))
    assert.equal(sidecar.ref, 'acme/multi#beta')
  } finally {
    restoreNetwork()
  }
})

await check('an old record without a commit updates and gains a pin', async () => {
  stubNetwork()
  try {
    const updated = await act({ action: 'update', name: 'legacy' })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.changed, true)
    assert.equal(updated.body.path, legacyDir)
    assert.equal(await readFile(join(legacyDir, 'SKILL.md'), 'utf8'), legacySkill)
    await sleep(900)
    const record = JSON.parse(await readFile(installedStoreFile, 'utf8')).skills.legacy
    assert.equal(record.ref, 'anthropics/skills', 'the stored reference is kept as it was')
    assert.equal(record.commit, network.sha, 'the update pinned the commit it read')
    assert.equal(record.path, legacyDir)
  } finally {
    restoreNetwork()
  }
})

await check('a flat Markdown skill is refused in place', async () => {
  const flat = join(projectSkills, 'flat-github.md')
  await writeFile(flat, '---\nname: flat-github\ndescription: A flat skill.\n---\n', 'utf8')
  stubNetwork()
  try {
    const updated = await act({
      action: 'update',
      name: 'flat-github',
      path: flat,
      ref: 'anthropics/skills#skills/notes',
    })
    assert.equal(updated.status, 409)
    assert.equal(updated.body.code, 'flat-skill')
    assert.deepEqual(network.calls, [], 'a flat target is refused before any fetch')
    assert.equal(await readFile(flat, 'utf8'), '---\nname: flat-github\ndescription: A flat skill.\n---\n')
  } finally {
    restoreNetwork()
  }
})

await check('an update target must declare the skill the caller names', async () => {
  const localDir = join(projectSkills, 'other-skill')
  await mkdir(localDir, { recursive: true })
  const local = '---\nname: other-skill\ndescription: Not the pdf skill.\n---\n'
  await writeFile(join(localDir, 'SKILL.md'), local, 'utf8')
  stubNetwork()
  try {
    const updated = await act({
      action: 'update',
      name: 'pdf',
      path: join(localDir, 'SKILL.md'),
      ref: 'anthropics/skills#skills/pdf',
    })
    assert.equal(updated.status, 409)
    assert.equal(updated.body.code, 'name-mismatch')
    assert.match(updated.body.message, /other-skill/)
    assert.deepEqual(network.calls, [], 'a mismatched target never reaches the network')
    assert.equal(await readFile(join(localDir, 'SKILL.md'), 'utf8'), local)
  } finally {
    restoreNetwork()
  }
})

await check('a record only describes the directory it was written for', async () => {
  // A same-named install in another root exists in installed.json. Clicking a
  // different directory must not borrow that record's reference.
  const recordDir = join(githubSkills, 'local-pdf')
  const clickedDir = join(projectSkills, 'local-pdf')
  for (const directory of [recordDir, clickedDir]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), '---\nname: local-pdf\ndescription: Two copies.\n---\n', 'utf8')
  }
  const store = JSON.parse(await readFile(installedStoreFile, 'utf8'))
  store.skills['local-pdf'] = {
    source: 'skills-sh', ref: 'anthropics/skills#skills/pdf', commit: network.sha,
    name: 'local-pdf', version: null, installedAt: 1763000000000, path: recordDir,
  }
  await writeFile(installedStoreFile, JSON.stringify(store), 'utf8')
  stubNetwork()
  try {
    const updated = await act({ action: 'update', name: 'local-pdf', path: join(clickedDir, 'SKILL.md') })
    assert.equal(updated.status, 400)
    assert.equal(updated.body.code, 'unknown-ref', 'the other directory has no origin of its own')
    assert.deepEqual(network.calls, [], 'nothing is fetched for a row with no origin')
    assert.equal(await readFile(join(clickedDir, 'SKILL.md'), 'utf8'),
      '---\nname: local-pdf\ndescription: Two copies.\n---\n')
  } finally {
    restoreNetwork()
  }
})

await check('state still exposes exactly the four legacy provenance keys', async () => {
  const record = JSON.parse(await readFile(installedStoreFile, 'utf8')).skills.pdf
  const response = await call(eighth.routes.get('/skill-dashboard/state'))
  assert.equal(response.status, 200)
  const pdf = response.body.skills.find((skill) => skill.name === 'pdf')
  assert.ok(pdf !== undefined, 'the installed skill is in the catalog')
  assert.deepEqual(pdf.installed, {
    source: record.source,
    ref: record.ref,
    version: record.version,
    installedAt: record.installedAt,
  }, 'the pin stays out of the state document')
  assert.deepEqual(Object.keys(pdf.installed), ['source', 'ref', 'version', 'installedAt'])
})

for (const entry of eighth.registered) {
  if (typeof entry.disposer === 'function') entry.disposer()
}
await sleep(50)


// ----------------- scenario 7: cache lifecycle, diagnosis, provenance, tracking

console.log('')
console.log('scenario 7: diagnosis freshness, provenance race, manual tracking, and cache coalescing')

const regHome = join(workspace, 'dsh-home-reg')
const regAgents = join(workspace, 'agents-home-reg')
const regSkills = join(regAgents, 'skills')
process.env.DSH_HOME = regHome
process.env.DSH_AGENTS_HOME = regAgents
await mkdir(regSkills, { recursive: true })
await mkdir(join(regHome, 'skill-dashboard'), { recursive: true })

const staleTargetAPath = await writeSkill(regSkills, 'stale-a', 'name: stale-a\ndescription: First stale skill.')
const staleTargetBPath = await writeSkill(regSkills, 'stale-b', 'name: stale-b\ndescription: Second stale skill.')
await writeSkill(regSkills, 'manual-disk-skill', 'name: manual-disk-skill\ndescription: Placed manually on disk.')
await writeSkill(regSkills, 'removable-prov', 'name: removable-prov\ndescription: Installed with provenance.')
const provSkillDir = join(regSkills, 'removable-prov')

const fortyDaysAgo = Date.now() - 40 * 86_400_000
await writeFile(
  join(regHome, 'skill-dashboard', 'usage.json'),
  JSON.stringify({
    version: 1,
    since: fortyDaysAgo,
    catalog: {
      'stale-a': fortyDaysAgo,
      'stale-b': fortyDaysAgo,
      'manual-disk-skill': fortyDaysAgo,
      'removable-prov': fortyDaysAgo,
    },
    skills: {},
    recent: [],
  }),
  'utf8',
)
await writeFile(
  join(regHome, 'skill-dashboard', 'installed.json'),
  JSON.stringify({
    version: 1,
    skills: {
      'removable-prov': {
        source: 'tencent',
        ref: 'removable-prov',
        version: '1.0.0',
        installedAt: fortyDaysAgo,
        path: provSkillDir,
      },
    },
  }),
  'utf8',
)

const regPresets = {
  async remoteExportList() {
    return []
  },
  presetForSession() {
    return undefined
  },
}
const sixth = createFakeContext({
  cwd: workspace,
  services: new Map([
    ['workingDirectory', { defaultDirectory: workspace }],
    ['agentPresets', regPresets],
  ]),
})
apply(sixth.ctx)

await check('set-invocation and cleanup(mode: disable) update diagnosis immediately', async () => {
  const initial = await call(sixth.routes.get('/skill-dashboard/state'))
  assert.equal(initial.status, 200)
  const rowA = initial.body.diagnosis.skills.find((row) => row.name === 'stale-a')
  const rowB = initial.body.diagnosis.skills.find((row) => row.name === 'stale-b')
  assert.equal(rowA.bucket, 'cleanup')
  assert.equal(rowA.closed, false)
  assert.equal(rowA.can.disable, true)
  assert.equal(rowB.bucket, 'cleanup')
  assert.equal(rowB.closed, false)
  assert.equal(rowB.can.disable, true)

  const toggled = await call(sixth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: staleTargetAPath, modelInvocable: false, userInvocable: false }),
  })
  assert.equal(toggled.status, 200)
  const toggledRowA = toggled.body.diagnosis.skills.find((row) => row.name === 'stale-a')
  assert.equal(toggledRowA.closed, true)
  assert.equal(toggledRowA.bucket, 'dormant')
  assert.equal(toggledRowA.can.disable, false)

  const afterToggle = await call(sixth.routes.get('/skill-dashboard/state'))
  const cachedRowA = afterToggle.body.diagnosis.skills.find((row) => row.name === 'stale-a')
  assert.equal(cachedRowA.closed, true)
  assert.equal(cachedRowA.bucket, 'dormant')
  assert.equal(cachedRowA.can.disable, false)

  const cleaned = await call(sixth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'cleanup',
      mode: 'disable',
      targets: [{ name: 'stale-b', path: staleTargetBPath }],
    }),
  })
  assert.equal(cleaned.status, 200)
  const cleanedRowB = cleaned.body.diagnosis.skills.find((row) => row.name === 'stale-b')
  assert.equal(cleanedRowB.closed, true)
  assert.equal(cleanedRowB.bucket, 'dormant')
  assert.equal(cleanedRowB.can.disable, false)

  const afterCleanup = await call(sixth.routes.get('/skill-dashboard/state'))
  const cachedRowB = afterCleanup.body.diagnosis.skills.find((row) => row.name === 'stale-b')
  assert.equal(cachedRowB.closed, true)
  assert.equal(cachedRowB.bucket, 'dormant')
  assert.equal(cachedRowB.can.disable, false)
})

await check('discover marks manual catalog skills installed and remove clears provenance synchronously', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          skills: [
            { slug: 'removable-prov', name: 'Removable', description: 'Tracked', version: '1.0.0' },
            { slug: 'manual-disk-skill', name: 'Manual', description: 'Manual on disk', version: '1.0.0' },
            { slug: 'never-installed', name: 'Remote Only', description: 'Not local', version: '1.0.0' },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  try {
    const before = await call(sixth.routes.get('/skill-dashboard/discover'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'tencent', query: 'before-remove', limit: 10 }),
    })
    assert.equal(before.status, 200)
    const beforeByName = new Map(before.body.items.map((item) => [item.name, item]))
    assert.equal(beforeByName.get('removable-prov').installed, true)
    assert.equal(beforeByName.get('manual-disk-skill').installed, true)
    assert.equal(beforeByName.get('never-installed').installed, false)

    const removed = await call(sixth.routes.get('/skill-dashboard/action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove', name: 'removable-prov', path: provSkillDir }),
    })
    assert.equal(removed.status, 200)

    const after = await call(sixth.routes.get('/skill-dashboard/discover'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'tencent', query: 'after-remove', limit: 10 }),
    })
    assert.equal(after.status, 200)
    const afterByName = new Map(after.body.items.map((item) => [item.name, item]))
    assert.equal(afterByName.get('removable-prov').installed, false)
    assert.equal(afterByName.get('manual-disk-skill').installed, true)
    assert.equal(afterByName.get('never-installed').installed, false)

    const stored = JSON.parse(await readFile(join(regHome, 'skill-dashboard', 'installed.json'), 'utf8'))
    assert.equal(Object.hasOwn(stored.skills, 'removable-prov'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('manual session/event without a resolved preset records default instead of raw sessionId', async () => {
  for (const listener of sixth.listeners.get('session/event') ?? []) {
    listener({ id: 'raw-session-xyz' }, { type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'manual-disk-skill' } } })
  }
  await sleep(30)
  const refreshed = await call(sixth.routes.get('/skill-dashboard/action'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'refresh' }),
  })
  assert.equal(refreshed.status, 200)
  const stateAfter = await call(sixth.routes.get('/skill-dashboard/state'))
  const entry = stateAfter.body.usage.recent.find((item) => item.name === 'manual-disk-skill')
  const skill = stateAfter.body.skills.find((item) => item.name === 'manual-disk-skill')
  assert.ok(entry !== undefined)
  assert.equal(entry.agentId, 'default')
  assert.equal(skill.usage.byUser, 1)
  assert.equal(skill.usage.sessions, 1)
})

let coalescedScanCount = 0
const coalescedPresets = {
  async remoteExportList() {
    return [{ id: 'standard', title: 'Standard', isDefault: true }]
  },
  async acquireScope() {
    return { scope: { id: 'standard' }, dispose() {} }
  },
}
const coalescedSkills = {
  async list() {
    coalescedScanCount += 1
    await sleep(25)
    return [
      {
        name: 'stale-a',
        description: 'First stale skill.',
        source: 'user-agents',
        provider: 'filesystem',
        path: staleTargetAPath,
        invocation: { modelInvocable: false, userInvocable: false },
      },
    ]
  },
}
const seventh = createFakeContext({
  cwd: workspace,
  services: new Map([
    ['workingDirectory', { defaultDirectory: workspace }],
    ['agentPresets', coalescedPresets],
    ['skills', coalescedSkills],
  ]),
})
apply(seventh.ctx)

await check('concurrent GET state calls coalesce and skills/change debounces cleanly', async () => {
  const [r1, r2, r3] = await Promise.all([
    call(seventh.routes.get('/skill-dashboard/state')),
    call(seventh.routes.get('/skill-dashboard/state')),
    call(seventh.routes.get('/skill-dashboard/state')),
  ])
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  assert.equal(r3.status, 200)
  assert.equal(r1.body.generatedAt, r2.body.generatedAt)
  assert.equal(r2.body.generatedAt, r3.body.generatedAt)
  assert.equal(coalescedScanCount, 1)

  const changeListeners = seventh.listeners.get('skills/change') ?? []
  for (let i = 0; i < 4; i += 1) {
    for (const listener of changeListeners) listener()
    await sleep(15)
  }
  assert.equal(coalescedScanCount, 1)
  await sleep(320)
  assert.equal(coalescedScanCount, 2)

  for (const listener of changeListeners) listener()
  for (const entry of seventh.registered) {
    if (typeof entry.disposer === 'function') entry.disposer()
  }
  await sleep(300)
  assert.equal(coalescedScanCount, 2)
})

const warmHome = join(workspace, 'dsh-home-warm')
const warmSkills = join(workspace, 'warm-skills')
await mkdir(warmSkills, { recursive: true })
await writeSkill(warmSkills, 'never-called', 'name: never-called\ndescription: Observed but never used.')
const savedHome = process.env.DSH_HOME
const savedAgentsHome = process.env.DSH_AGENTS_HOME
process.env.DSH_HOME = warmHome
process.env.DSH_AGENTS_HOME = warmSkills
const ninth = createFakeContext({
  cwd: workspace,
  services: new Map([
    ['workingDirectory', { defaultDirectory: workspace }],
    ['skills', { async list() {
      return [{
        name: 'never-called',
        description: 'Observed but never used.',
        source: 'user-agents',
        provider: 'filesystem',
        path: join(warmSkills, 'never-called', 'SKILL.md'),
        invocation: { modelInvocable: true, userInvocable: true },
      }]
    } }],
  ]),
})
apply(ninth.ctx)

await check('the activation warm-up persists the write-once observation stamps', async () => {
  await sleep(1200)
  const usagePath = join(warmHome, 'skill-dashboard', 'usage.json')
  const stored = JSON.parse(await readFile(usagePath, 'utf8'))
  assert.ok(stored.since > 0, 'the observation start reaches disk without any skill call')
  assert.equal(typeof stored.catalog?.['never-called'], 'number', 'the first-sight stamp reaches disk')

  const reread = await call(ninth.routes.get('/skill-dashboard/state'))
  assert.equal(reread.status, 200)
  const row = reread.body.diagnosis.skills.find((entry) => entry.name === 'never-called')
  assert.equal(row.watchedDays, reread.body.diagnosis.observedDays, 'the window starts at the persisted stamp')
})

for (const entry of ninth.registered) {
  if (typeof entry.disposer === 'function') entry.disposer()
}
await sleep(50)
process.env.DSH_HOME = savedHome
process.env.DSH_AGENTS_HOME = savedAgentsHome

// ------------- scenario 10: lock provenance and bounded, read-only update checks

console.log('')
console.log('scenario 10: lock provenance and bounded update checks')

const lockHome = join(workspace, 'dsh-home-lock')
const lockAgents = join(workspace, 'agents-home-lock')
const lockSkills = join(lockAgents, 'skills')
process.env.DSH_HOME = lockHome
process.env.DSH_AGENTS_HOME = lockAgents
await mkdir(join(lockHome, 'skill-dashboard'), { recursive: true })
await mkdir(lockSkills, { recursive: true })

await writeSkill(lockSkills, 'lock-nested', 'name: lock-nested\ndescription: Locally installed, old bytes.')
await writeSkill(lockSkills, 'lock-root', 'name: lock-root\ndescription: A repository-root skill.')
await writeSkill(lockSkills, 'hand-made', 'name: hand-made\ndescription: No origin at all.')
await writeSkill(lockSkills, 'broken-ref', 'name: broken-ref\ndescription: A record that cannot parse.')
// A well-known registry skill: the CLI records only the archive it came from.
const LARK_URL = 'https://open.feishu.cn/lark-cli/skills/regular/.well-known/agent-skills/lark-doc.tar.gz'
const LARK_SKILL = '---\nname: lark-doc\ndescription: 飞书云文档，读写 Docx 与 Wiki。\n---\n\n# lark-doc\n'
await writeSkill(lockSkills, 'lark-doc', 'name: lark-doc\ndescription: A locally edited copy.')
await mkdir(join(lockSkills, 'lark-doc', 'references'), { recursive: true })
await writeFile(join(lockSkills, 'lark-doc', 'references', 'guide.md'), 'local guide\n', 'utf8')
archives.set(LARK_URL, gzipSync(tarArchive([
  { path: 'references/', type: '5' },
  { path: 'SKILL.md', text: LARK_SKILL },
  { path: 'references/guide.md', text: 'upstream guide\n' },
])))

const LOCK_UPDATED_NESTED = '2026-11-20T10:00:00.000Z'
const LOCK_UPDATED_ROOT = '2026-11-21T10:00:00.000Z'
const LOCK_UPDATED_LARK = '2026-11-22T10:00:00.000Z'
const lockDocument = {
  version: 3,
  skills: {
    'lock-nested': { source: 'acme/lock', sourceType: 'github', skillPath: 'skills/lock-nested/SKILL.md', updatedAt: LOCK_UPDATED_NESTED },
    'lock-root': { source: 'acme/lock', sourceType: 'github', skillPath: 'SKILL.md', updatedAt: LOCK_UPDATED_ROOT },
    'hand-made': { source: 'acme/lock', sourceType: 'github', skillPath: 'skills/other-name/SKILL.md' },
    'lark-doc': {
      source: 'open.feishu.cn',
      sourceType: 'well-known',
      sourceUrl: LARK_URL,
      sourceBaseUrl: 'https://open.feishu.cn/lark-cli/skills/regular',
      skillFolderHash: '',
      installedAt: '2026-11-01T10:00:00.000Z',
      updatedAt: LOCK_UPDATED_LARK,
    },
    'missing-name': { source: 'acme/lock', sourceType: 'github', skillPath: 'skills/SKILL.md' },
    'dot-path': { source: 'acme/lock', sourceType: 'github', skillPath: 'skills/./SKILL.md' },
    'no-skill-file': { source: 'acme/lock', sourceType: 'github', skillPath: 'skills/other-name/README.md' },
    'wrong-source': { source: 'acme/one/two', sourceType: 'github', skillPath: 'skills/wrong-source/SKILL.md' },
    'wrong-type': { source: 'acme/lock', sourceType: 'gitlab', skillPath: 'skills/wrong-type/SKILL.md' },
    'broken-archive': { source: 'open.feishu.cn', sourceType: 'well-known', sourceUrl: 'https://open.feishu.cn/lark-cli/skills/regular/lark-doc' },
  },
}
await writeFile(join(lockAgents, '.skill-lock.json'), JSON.stringify(lockDocument), 'utf8')
await writeFile(join(lockHome, 'skill-dashboard', 'installed.json'), JSON.stringify({
  version: 1,
  skills: {
    'broken-ref': { source: 'skills-sh', ref: 'not a reference', version: null, installedAt: 1763000000000, path: join(lockSkills, 'broken-ref') },
  },
}), 'utf8')

/** Every file under one root with its size and mtime: the proof that a check wrote nothing. */
const snapshotTree = async (root) => {
  const entries = []
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), `${prefix}${entry.name}/`)
        continue
      }
      const info = await stat(join(directory, entry.name))
      entries.push([`${prefix}${entry.name}`, info.size, info.mtimeMs])
    }
  }
  await walk(root, '')
  return entries.sort((left, right) => left[0].localeCompare(right[0]))
}

const lockCatalog = async () => ['lock-nested', 'lock-root', 'hand-made', 'broken-ref', 'lark-doc'].map((name) => ({
  name,
  description: 'A lock-tracked skill.',
  source: 'user-agents',
  provider: 'filesystem',
  path: join(lockSkills, name, 'SKILL.md'),
  invocation: { modelInvocable: true, userInvocable: true },
}))
const tenth = createFakeContext({
  cwd: workspace,
  services: new Map([
    ['workingDirectory', { defaultDirectory: workspace }],
    ['skills', { list: lockCatalog }],
  ]),
})
apply(tenth.ctx)
const lockAct = (body) => call(tenth.routes.get('/skill-dashboard/action'), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

await check('a lock entry maps to a ref only for its exact install directory and a well-formed path', () => {
  assert.deepEqual(lockProvenanceOf({ name: 'lock-nested', dir: join(lockSkills, 'lock-nested') }, lockDocument, lockSkills), {
    source: 'github',
    ref: 'acme/lock#skills/lock-nested',
    version: null,
    installedAt: Date.parse(LOCK_UPDATED_NESTED),
  })
  assert.deepEqual(lockProvenanceOf({ name: 'lock-root', dir: join(lockSkills, 'lock-root') }, lockDocument, lockSkills), {
    source: 'github',
    ref: 'acme/lock',
    version: null,
    installedAt: Date.parse(LOCK_UPDATED_ROOT),
  }, 'a repository-root skillPath becomes a bare owner/repo ref')
  assert.equal(lockProvenanceOf({ name: 'lock-nested', dir: join(lockSkills, 'lock-root') }, lockDocument, lockSkills), null,
    'another directory never borrows the entry')
  assert.deepEqual(lockProvenanceOf({ name: 'hand-made', dir: join(lockSkills, 'hand-made') }, lockDocument, lockSkills), {
    source: 'github',
    ref: 'acme/lock#skills/other-name',
    version: null,
    installedAt: null,
  }, 'the lock key is the installed name, so the source folder may differ from it')
  assert.deepEqual(lockProvenanceOf({ name: 'missing-name', dir: join(lockSkills, 'missing-name') }, lockDocument, lockSkills), {
    source: 'github',
    ref: 'acme/lock#skills',
    version: null,
    installedAt: null,
  }, 'a source folder that carries no skill name is still a source folder')
  assert.equal(lockProvenanceOf({ name: 'dot-path', dir: join(lockSkills, 'dot-path') }, lockDocument, lockSkills), null,
    'a path with a "." segment is refused')
  assert.equal(lockProvenanceOf({ name: 'no-skill-file', dir: join(lockSkills, 'no-skill-file') }, lockDocument, lockSkills), null,
    'a skillPath that does not end in SKILL.md is refused')
  assert.equal(lockProvenanceOf({ name: 'wrong-source', dir: join(lockSkills, 'wrong-source') }, lockDocument, lockSkills), null,
    'a source that is not owner/repo is refused')
  assert.equal(lockProvenanceOf({ name: 'wrong-type', dir: join(lockSkills, 'wrong-type') }, lockDocument, lockSkills), null,
    'an unknown sourceType is refused')
  assert.deepEqual(lockProvenanceOf({ name: 'lark-doc', dir: join(lockSkills, 'lark-doc') }, lockDocument, lockSkills), {
    source: 'well-known',
    ref: LARK_URL,
    version: null,
    installedAt: Date.parse(LOCK_UPDATED_LARK),
  }, 'a well-known entry maps through the archive it recorded')
  assert.equal(lockProvenanceOf({ name: 'broken-archive', dir: join(lockSkills, 'broken-archive') }, lockDocument, lockSkills), null,
    'a well-known entry whose URL is not an archive is refused')
  const noTimestamp = lockProvenanceOf(
    { name: 'lock-root', dir: join(lockSkills, 'lock-root') },
    { version: 3, skills: { 'lock-root': { source: 'acme/lock', skillPath: 'SKILL.md' } } },
    lockSkills,
  )
  assert.equal(noTimestamp.installedAt, null, 'a missing updatedAt is null, not NaN')
})

await check('every renamed repository folder in the real lock shape maps', () => {
  // The ten Leonxlnx/taste-skill entries: the installed name is the lock key, the
  // folder is only where the skill came from.
  const renamed = {
    'design-taste-frontend': 'skills/taste-skill',
    'design-taste-frontend-v1': 'skills/taste-skill-v1',
    'full-output-enforcement': 'skills/output-skill',
    'gpt-taste': 'skills/gpt-tasteskill',
    'high-end-visual-design': 'skills/soft-skill',
    'image-to-code': 'skills/image-to-code-skill',
    'industrial-brutalist-ui': 'skills/brutalist-skill',
    'minimalist-ui': 'skills/minimalist-skill',
    'redesign-existing-projects': 'skills/redesign-skill',
    'stitch-design-taste': 'skills/stitch-skill',
  }
  const entries = {}
  for (const [name, folder] of Object.entries(renamed)) {
    entries[name] = { source: 'Leonxlnx/taste-skill', sourceType: 'github', skillPath: `${folder}/SKILL.md`, updatedAt: LOCK_UPDATED_NESTED }
  }
  const document = { version: 3, skills: entries }
  for (const [name, folder] of Object.entries(renamed)) {
    assert.deepEqual(
      lockProvenanceOf({ name, dir: join(lockSkills, name) }, document, lockSkills),
      { source: 'github', ref: `Leonxlnx/taste-skill#${folder}`, version: null, installedAt: Date.parse(LOCK_UPDATED_NESTED) },
      name,
    )
  }
  assert.equal(lockProvenanceOf(
    { name: 'gpt-taste', dir: join(lockSkills, 'other') },
    document,
    lockSkills,
  ), null, 'a renamed entry is still fenced by its exact install directory')
})

await check('the update block is only as fresh as its oldest tracked skill', () => {
  const first = { name: 'a', dir: 'C:\\skills\\a', installed: { source: 'github', ref: 'o/r#a' } }
  const second = { name: 'b', dir: 'C:\\skills\\b', installed: { source: 'github', ref: 'o/r#b' } }
  const partial = describeUpdates({ skills: {
    a: { available: true, changedPaths: ['SKILL.md'], checkedAt: 100 },
  } }, [first, second])
  assert.equal(partial.checkedAt, 0, 'a tracked skill with no record keeps the whole block stale')
  assert.deepEqual(partial.available.map((entry) => entry.name), ['a'])
  const full = describeUpdates({ skills: {
    a: { available: false, checkedAt: 300 },
    b: { available: false, checkedAt: 200 },
  } }, [first, second])
  assert.equal(full.checkedAt, 200, 'the oldest record decides freshness')
  assert.equal(describeUpdates({ skills: {} }, [first]).checkedAt, 0)
  assert.deepEqual(describeUpdates({ skills: {
    a: { available: true, changedPaths: [1, 'x'], checkedAt: 300 },
  } }, [first]).available[0].changedPaths, ['x'], 'only string paths survive')
  assert.deepEqual(describeUpdates({ skills: {
    gone: { available: true, changedPaths: [], checkedAt: 300 },
  } }, [first]).available, [], 'records outside the catalog are not listed')
})

await check('the shared byte-compare helper reports only the fetched files that differ', async () => {
  const directory = join(workspace, 'compare-fixture')
  await mkdir(join(directory, 'references'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), 'same\n', 'utf8')
  await writeFile(join(directory, 'references', 'guide.md'), 'old\n', 'utf8')
  const changed = await changedSkillPaths(directory, [
    { path: 'SKILL.md', text: 'same\n' },
    { path: 'references/guide.md', text: 'new\n' },
    { path: 'references/added.md', text: 'added\n' },
    { path: '../escape.md', text: 'refused' },
  ])
  assert.deepEqual(changed, ['references/guide.md', 'references/added.md'])
  assert.equal(existsSync(join(directory, 'references', 'added.md')), false, 'the helper only reads')
})

await check('state borrows lock provenance for the exact install root and writes nothing', async () => {
  const response = await call(tenth.routes.get('/skill-dashboard/state'))
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const byName = new Map(response.body.skills.map((skill) => [skill.name, skill]))
  assert.deepEqual(byName.get('lock-nested').installed, {
    source: 'github', ref: 'acme/lock#skills/lock-nested', version: null, installedAt: Date.parse(LOCK_UPDATED_NESTED),
  })
  assert.deepEqual(byName.get('lock-root').installed, {
    source: 'github', ref: 'acme/lock', version: null, installedAt: Date.parse(LOCK_UPDATED_ROOT),
  })
  assert.deepEqual(byName.get('hand-made').installed, {
    source: 'github', ref: 'acme/lock#skills/other-name', version: null, installedAt: null,
  }, 'the lock key is the installed name, so its source folder may differ')
  assert.deepEqual(byName.get('lark-doc').installed, {
    source: 'well-known', ref: LARK_URL, version: null, installedAt: Date.parse(LOCK_UPDATED_LARK),
  }, 'a well-known entry is followed through its recorded archive')
  assert.deepEqual(byName.get('broken-ref').installed, {
    source: 'skills-sh', ref: 'not a reference', version: null, installedAt: 1763000000000,
  }, 'the provenance store still wins')
  assert.deepEqual(response.body.updates, { checkedAt: 0, available: [] })
  assert.equal(existsSync(join(lockSkills, 'lock-nested', '.skill-source.json')), false, 'reading never writes a sidecar')
  const stored = JSON.parse(await readFile(join(lockHome, 'skill-dashboard', 'installed.json'), 'utf8'))
  assert.deepEqual(Object.keys(stored.skills), ['broken-ref'], 'no lock skill was added to the provenance store')
})

await check('check-updates records changed paths without writing a skill file', async () => {
  putRemote('acme/lock', 'skills/lock-nested/SKILL.md',
    '---\nname: lock-nested\ndescription: Upstream bytes.\n---\n\nnew\n')
  putRemote('acme/lock', 'skills/lock-root/SKILL.md',
    '---\nname: lock-root\ndescription: Upstream root bytes.\n---\n\nnew\n')
  // The lock entry for "hand-made" names this folder, but the skill it holds is
  // another one: the only thing that can catch that is the fetched name.
  putRemote('acme/lock', 'skills/other-name/SKILL.md',
    '---\nname: other-name\ndescription: A different skill entirely.\n---\n')
  const before = await snapshotTree(lockSkills)
  const lockBefore = await readFile(join(lockAgents, '.skill-lock.json'), 'utf8')
  stubNetwork()
  network.sha = SHA_ONE
  try {
    const response = await lockAct({ action: 'check-updates', limit: 8 })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.total, 5, 'only installed entries with a directory are tracked')
    assert.equal(response.body.cursor, 0)
    assert.equal(response.body.nextCursor, 5)
    assert.equal(response.body.done, true)
    assert.equal(typeof response.body.checkedAt, 'number')
    const checked = new Map(response.body.checked.map((entry) => [entry.name, entry]))
    assert.deepEqual([...checked.keys()].sort(), ['broken-ref', 'hand-made', 'lark-doc', 'lock-nested', 'lock-root'])
    assert.equal(checked.get('broken-ref').error, 'bad-request', 'a bad stored ref is one row error, not an action failure')
    assert.equal(checked.get('broken-ref').available, false)
    assert.equal(checked.get('lock-nested').available, true)
    assert.deepEqual(checked.get('lock-nested').changedPaths, ['SKILL.md'])
    assert.equal(checked.get('lock-root').available, true)
    assert.equal(checked.get('lark-doc').available, true, 'a well-known archive is compared like any other source')
    assert.deepEqual(checked.get('lark-doc').changedPaths, ['SKILL.md', 'references/guide.md'])
    assert.deepEqual(await snapshotTree(lockSkills), before, 'a check writes no skill file')
    assert.equal(await readFile(join(lockAgents, '.skill-lock.json'), 'utf8'), lockBefore, 'the lock file is untouched')
    assert.equal(existsSync(join(lockSkills, 'lock-nested', '.skill-source.json')), false, 'a check writes no provenance')
    assert.equal(existsSync(join(lockSkills, 'lock-root', '.skill-source.json')), false)
    assert.equal(existsSync(join(lockSkills, 'lark-doc', '.skill-source.json')), false)
    const persisted = JSON.parse(await readFile(join(lockHome, 'skill-dashboard', 'updates.json'), 'utf8'))
    assert.equal(persisted.version, 1)
    assert.equal(persisted.skills['lock-nested'].available, true)
    assert.deepEqual(persisted.skills['lock-nested'].changedPaths, ['SKILL.md'])
    assert.equal(persisted.skills['lark-doc'].available, true)
    assert.equal(persisted.skills['broken-ref'].error, 'bad-request')
  } finally {
    restoreNetwork()
  }
})

await check('state lists the available checks and keeps the last run time', async () => {
  const response = await call(tenth.routes.get('/skill-dashboard/state'))
  assert.equal(response.body.updates.checkedAt > 0, true)
  assert.deepEqual(response.body.updates.available.map((entry) => entry.name), ['hand-made', 'lark-doc', 'lock-nested', 'lock-root'])
  assert.deepEqual(response.body.updates.available[0].changedPaths, ['SKILL.md'])
})

await check('a fresh result is reused for six hours and read again after that', async () => {
  stubNetwork()
  try {
    network.calls = []
    const reused = await lockAct({ action: 'check-updates', limit: 8 })
    assert.equal(reused.status, 200)
    assert.deepEqual(network.calls, [], 'a record younger than six hours costs no upstream read')
    assert.equal(reused.body.checked.find((entry) => entry.name === 'lock-root').available, true)
    const realNow = Date.now
    Date.now = () => realNow() + 7 * 60 * 60 * 1000
    try {
      network.calls = []
      const refreshed = await lockAct({ action: 'check-updates', limit: 8 })
      assert.equal(refreshed.status, 200)
      assert.equal(network.calls.some((url) => url.includes('acme/lock')), true, 'a stale record is read upstream again')
      assert.deepEqual(refreshed.body.checked.find((entry) => entry.name === 'lock-nested').changedPaths, ['SKILL.md'])
    } finally {
      Date.now = realNow
    }
  } finally {
    restoreNetwork()
  }
})

await check('a failed check is retried after ten minutes, not six hours', async () => {
  stubNetwork()
  const realNow = Date.now
  const savedRepo = repos.get('acme/lock')
  try {
    repos.delete('acme/lock')
    network.calls = []
    const failed = await lockAct({ action: 'check-updates', limit: 8, refresh: true })
    assert.equal(failed.status, 200)
    const stored = JSON.parse(await readFile(join(lockHome, 'skill-dashboard', 'updates.json'), 'utf8'))
    assert.equal(typeof stored.skills['lock-nested'].error, 'string', 'an unavailable repository records an error')
    repos.set('acme/lock', savedRepo)
    network.calls = []
    const soon = await lockAct({ action: 'check-updates', limit: 8 })
    assert.equal(soon.status, 200)
    assert.deepEqual(network.calls, [], 'an error record younger than ten minutes is not retried')
    Date.now = () => realNow() + 20 * 60 * 1000
    network.calls = []
    const retried = await lockAct({ action: 'check-updates', limit: 8 })
    assert.equal(retried.status, 200)
    assert.equal(retried.body.checked.find((entry) => entry.name === 'lock-nested').available, true,
      'a stale error is retried and becomes a real verdict')
  } finally {
    repos.set('acme/lock', savedRepo)
    Date.now = realNow
    restoreNetwork()
  }
})

await check('update without a stored ref falls back to the lock entry and records its provenance', async () => {
  stubNetwork()
  network.sha = SHA_ONE
  try {
    const updated = await lockAct({ action: 'update', name: 'lock-nested', path: join(lockSkills, 'lock-nested', 'SKILL.md') })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.deepEqual(updated.body, { ok: true, name: 'lock-nested', path: join(lockSkills, 'lock-nested'), changed: true })
    assert.equal(await readFile(join(lockSkills, 'lock-nested', 'SKILL.md'), 'utf8'),
      '---\nname: lock-nested\ndescription: Upstream bytes.\n---\n\nnew\n')
    const sidecar = JSON.parse(await readFile(join(lockSkills, 'lock-nested', '.skill-source.json'), 'utf8'))
    assert.equal(sidecar.ref, 'acme/lock#skills/lock-nested')
    assert.equal(sidecar.commit, SHA_ONE)
    await sleep(900)
    const record = JSON.parse(await readFile(join(lockHome, 'skill-dashboard', 'installed.json'), 'utf8')).skills['lock-nested']
    assert.equal(record.ref, 'acme/lock#skills/lock-nested')
    assert.equal(record.path, join(lockSkills, 'lock-nested'))
    const updates = JSON.parse(await readFile(join(lockHome, 'skill-dashboard', 'updates.json'), 'utf8')).skills['lock-nested']
    assert.equal(updates.available, false, 'a successful update clears its available record')
  } finally {
    restoreNetwork()
  }
})

await check('update follows a well-known lock entry through its archive and records it', async () => {
  stubNetwork()
  try {
    const updated = await lockAct({ action: 'update', name: 'lark-doc', path: join(lockSkills, 'lark-doc', 'SKILL.md') })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.deepEqual(updated.body, { ok: true, name: 'lark-doc', path: join(lockSkills, 'lark-doc'), changed: true })
    assert.equal(await readFile(join(lockSkills, 'lark-doc', 'SKILL.md'), 'utf8'), LARK_SKILL, 'the archive bytes are restored')
    assert.equal(await readFile(join(lockSkills, 'lark-doc', 'references', 'guide.md'), 'utf8'), 'upstream guide\n')
    const sidecar = JSON.parse(await readFile(join(lockSkills, 'lark-doc', '.skill-source.json'), 'utf8'))
    assert.deepEqual(sidecar, {
      source: 'well-known', ref: LARK_URL, commit: null, name: 'lark-doc', version: null, installedAt: sidecar.installedAt,
    })
    assert.equal(typeof sidecar.installedAt, 'number')
    assert.deepEqual(network.calls, [LARK_URL], 'an update reads the archive and nothing else')
    await sleep(900)
    const record = JSON.parse(await readFile(join(lockHome, 'skill-dashboard', 'installed.json'), 'utf8')).skills['lark-doc']
    assert.equal(record.ref, LARK_URL)
    assert.equal(record.source, 'well-known')
    const again = await lockAct({ action: 'check-updates', limit: 8, refresh: true })
    assert.equal(again.body.checked.find((entry) => entry.name === 'lark-doc').available, false,
      'the restored bytes are byte-identical to the archive')
  } finally {
    restoreNetwork()
  }
})

await check('a renamed lock folder that points at another skill is refused by the fetched name', async () => {
  stubNetwork()
  const before = await snapshotTree(lockSkills)
  try {
    const refused = await lockAct({ action: 'update', name: 'hand-made', path: join(lockSkills, 'hand-made', 'SKILL.md') })
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.code, 'name-mismatch')
    assert.deepEqual(await snapshotTree(lockSkills), before, 'a refused update writes nothing')
  } finally {
    restoreNetwork()
  }
})

for (const entry of tenth.registered) {
  if (typeof entry.disposer === 'function') entry.disposer()
}
await sleep(50)
process.env.DSH_HOME = savedHome
process.env.DSH_AGENTS_HOME = savedAgentsHome

// ------------------------------------------------------------------- teardown

for (const entry of sixth.registered) {
  if (typeof entry.disposer === 'function') entry.disposer()
}
for (const entry of fifth.registered) {
  if (typeof entry.disposer === 'function') entry.disposer()
}
for (const entry of first.registered) {
  if (typeof entry.disposer === 'function') entry.disposer()
}
for (const entry of second.registered) {
  if (typeof entry.disposer === 'function') entry.disposer()
}
for (const entry of third.registered) {
  if (typeof entry.disposer === 'function') entry.disposer()
}
for (const entry of fourth.registered) {
  if (typeof entry.disposer === 'function') entry.disposer()
}
await sleep(50)
await rm(workspace, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} failing, ${passed} passing`)
  for (const failure of failures) {
    console.log('')
    console.log(`--- ${failure.name}`)
    console.log(failure.error.stack)
  }
  process.exitCode = 1
} else {
  console.log(`all ${passed} route assertions passed`)
}
