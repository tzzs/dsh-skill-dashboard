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
import { mkdir, mkdtemp, readFile, rename as fsRename, rm, symlink as fsSymlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, moveStagedTree } = await import('../index.js')

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
  ])
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
  const response = await call(first.routes.get('/skill-dashboard/discover'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'nope', query: 'x' }),
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'unknown-source')
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

// ------------------------------------------------------------------- teardown

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
