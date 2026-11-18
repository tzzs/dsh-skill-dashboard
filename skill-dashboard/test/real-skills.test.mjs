/**
 * Read-only sweep over the real user skill roots, plus a live registry probe.
 *
 * Run with the DSH runtime:
 *   C:\Users\itanz\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe real-skills.test.mjs
 *
 * This script never writes to `~/.agents/skills` or to the real `$DSH_HOME`:
 * frontmatter edits are applied in memory, and every install, provenance
 * record, and usage record goes to a throwaway temp directory.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const { applyInvocationEdit, parseSkillFrontmatter } = await import('../index.js')
const { apply } = await import('../index.js')

let passed = 0
const failures = []

async function check(name, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One response double that records status, headers, and the JSON body. */
function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body) {
      this.writableEnded = true
      this.body = body
    },
    once() {},
    off() {},
  }
}

/** Install one fake Host context and return its route table. */
function installFakeHost(routes, warnings) {
  const services = new Map()
  const ctx = {
    logger: {
      info() {},
      warn(message) {
        warnings.push(String(message))
      },
    },
    skills: {
      async list() {
        return []
      },
    },
    get: (name) => services.get(name),
    on() {
      return () => {}
    },
    effect(factory) {
      return factory()
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
  }
  apply(ctx)
  return {
    services,
    async call(path, { method = 'GET', headers = {}, body = '' } = {}) {
      const request = {
        method,
        headers,
        on() {},
        once() {},
        off() {},
        resume() {},
        async *[Symbol.asyncIterator]() {
          if (body.length > 0) yield Buffer.from(body, 'utf8')
        },
      }
      const response = mockResponse()
      routes.get(path).handler(request, response)
      const deadline = Date.now() + 20000
      while (!response.writableEnded && Date.now() < deadline) await sleep(10)
      if (!response.writableEnded) throw new Error('handler never answered')
      return { status: response.statusCode, body: response.body === undefined ? undefined : JSON.parse(response.body) }
    },
  }
}

// ------------------------------------------------ part 1: the real skill files

const agentsRoot = join(process.env.DSH_AGENTS_HOME || join(homedir(), '.agents'), 'skills')
const dshRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills')

/** Every directory-bundle SKILL.md and flat .md skill directly under one root. */
async function collectSkillFiles(root) {
  const files = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(join(root, entry.name, 'SKILL.md'))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(root, entry.name))
  }
  return files
}

console.log('real skill roots')
const realFiles = [...(await collectSkillFiles(agentsRoot)), ...(await collectSkillFiles(dshRoot))]
console.log(`  found ${realFiles.length} skill files under ${agentsRoot} and ${dshRoot}`)

await check('every real SKILL.md parses with the rules the provider uses', async () => {
  const problems = []
  const parsedFiles = []
  for (const file of realFiles) {
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) {
      problems.push(`${file}: unreadable`)
      continue
    }
    const result = parseSkillFrontmatter(text)
    if (result.ok !== true) problems.push(`${file}: ${result.message}`)
    else parsedFiles.push({ file, text, flags: result })
  }
  console.log(`  parsed ${parsedFiles.length}/${realFiles.length}`)
  for (const problem of problems) console.log(`  note  ${problem}`)
  assert.ok(parsedFiles.length > 100, `expected the real profile, parsed ${parsedFiles.length}`)
  return parsedFiles
})

await check('default-flag skills round-trip byte-for-byte through the editor', async () => {
  let strict = 0
  let tolerant = 0
  for (const file of realFiles) {
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const parsed = parseSkillFrontmatter(text)
    if (parsed.ok !== true) continue
    if (parsed.modelInvocable !== true || parsed.userInvocable !== true) {
      // A skill already switched off: the editor must still be a no-op for the
      // current values, and must restore the same resolved flags after a flip.
      const noop = applyInvocationEdit(text, { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable })
      assert.equal(noop.ok, true)
      assert.equal(noop.changed, false, `${file} rewrote a no-op edit`)
      assert.equal(noop.text, text)
      const flipped = applyInvocationEdit(text, { modelInvocable: true, userInvocable: true })
      assert.equal(flipped.ok, true)
      const back = applyInvocationEdit(flipped.text, {
        modelInvocable: parsed.modelInvocable,
        userInvocable: parsed.userInvocable,
      })
      const backFlags = parseSkillFrontmatter(back.text)
      assert.equal(backFlags.ok, true)
      assert.equal(backFlags.modelInvocable, parsed.modelInvocable)
      assert.equal(backFlags.userInvocable, parsed.userInvocable)
      tolerant += 1
      continue
    }
    for (const change of [
      { modelInvocable: false },
      { userInvocable: false },
      { modelInvocable: false, userInvocable: false },
    ]) {
      const applied = applyInvocationEdit(text, change)
      assert.equal(applied.ok, true, `${file} rejected ${JSON.stringify(change)}: ${applied.message}`)
      assert.equal(applied.changed, true, `${file} reported no change for ${JSON.stringify(change)}`)
      const flags = parseSkillFrontmatter(applied.text)
      assert.equal(flags.ok, true)
      if (change.modelInvocable !== undefined) assert.equal(flags.modelInvocable, change.modelInvocable)
      if (change.userInvocable !== undefined) assert.equal(flags.userInvocable, change.userInvocable)
      const restored = applyInvocationEdit(applied.text, { modelInvocable: true, userInvocable: true })
      assert.equal(restored.ok, true)
      assert.equal(restored.text, text, `${file} did not restore byte-for-byte`)
    }
    strict += 1
  }
  console.log(`  ${strict} default skills restored byte-for-byte (${strict * 3} edits), ${tolerant} switched-off skills kept stable`)
  assert.ok(strict > 50, `expected many default skills, saw ${strict}`)
})

// ----------------------------------- part 2: the state route over the real roots

console.log('')
console.log('state route over the real roots (read-only)')
const workspace = await mkdtemp(join(tmpdir(), 'skd-real-'))
const routes = new Map()
const warnings = []
const host = installFakeHost(routes, warnings)
host.services.set('workingDirectory', { defaultDirectory: workspace })

await check('GET state lists the real skills with writable=true and correct flags', async () => {
  const started = Date.now()
  const response = await host.call('/skill-dashboard/state')
  assert.equal(response.status, 200)
  const state = response.body
  assert.equal(state.ok, true)
  assert.equal(state.agents.length, 1)
  console.log(`  ${state.skills.length} skills merged in ${Date.now() - started}ms`)
  assert.ok(state.skills.length > 100, `expected the real profile's skills, got ${state.skills.length}`)
  const demo = state.skills.find((skill) => skill.name === 'code-review')
  assert.ok(demo !== undefined, 'code-review is expected in this profile')
  assert.equal(demo.source, 'user-agents')
  assert.equal(demo.writable, true)
  assert.equal(typeof demo.path, 'string')
  assert.equal(demo.dir.endsWith('code-review'), true)
  assert.equal(demo.modelInvocable, true)
  for (const skill of state.skills) {
    assert.equal(typeof skill.writable, 'boolean')
    assert.equal(skill.usage.days.length, 14)
    assert.equal(Array.isArray(skill.agents), true)
  }
  const off = state.skills.filter((skill) => skill.modelInvocable === false)
  console.log(`  ${state.skills.filter((skill) => skill.dir === null).length} flat skills, ${off.length} switched off for the model`)
  const provenance = state.skills.filter((skill) => skill.installed !== null)
  console.log(`  ${provenance.length} skills carry dashboard provenance: ${provenance.slice(0, 6).map((skill) => `${skill.name}(${skill.installed.source})`).join(', ')}`)
  for (const skill of state.skills) {
    assert.equal(Object.hasOwn(skill, 'installed'), true, `${skill.name} has no installed field`)
    if (skill.installed !== null) {
      assert.equal(typeof skill.installed.source, 'string')
      assert.equal(typeof skill.installed.ref, 'string')
    }
  }
})

await check('a burst of fetches reuses one merge', async () => {
  const first = await host.call('/skill-dashboard/state')
  const second = await host.call('/skill-dashboard/state')
  assert.equal(first.body.generatedAt, second.body.generatedAt, 'a second fetch inside 1.5s reuses the merge')
})

await check('set-invocation refuses a path that does not exist', async () => {
  const response = await host.call('/skill-dashboard/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-invocation', path: join(workspace, 'SKILL.md'), modelInvocable: false }),
  })
  assert.equal(response.status, 404)
})

// ------------------------------- part 3: live registry probe (temp writes only)

console.log('')
console.log('live registry probe (installs land in a temp root)')
const liveRoot = await mkdtemp(join(tmpdir(), 'skd-live-'))
process.env.DSH_HOME = join(liveRoot, 'home')
process.env.DSH_AGENTS_HOME = join(liveRoot, 'agents')
const liveRoutes = new Map()
const liveWarnings = []
const live = installFakeHost(liveRoutes, liveWarnings)
live.services.set('workingDirectory', { defaultDirectory: liveRoot })
/** Carried between the live install checks. */
let liveItem
let liveInstalled

const probe = async (source, query) => {
  const started = Date.now()
  const response = await live.call('/skill-dashboard/discover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, query, limit: 5 }),
  })
  console.log(`  ${source} "${query}" → HTTP ${response.status} in ${Date.now() - started}ms`)
  if (response.body?.ok === true) {
    for (const item of response.body.items.slice(0, 3)) {
      console.log(`      ${item.id} | ref=${item.ref} | name=${item.name} | v=${item.version} | ${String(item.description).slice(0, 60)}`)
    }
    console.log(`      note=${response.body.note ?? 'null'} installed=${response.body.items.filter((item) => item.installed).length}`)
  } else {
    console.log(`      failure: ${JSON.stringify(response.body)}`)
  }
  return response
}

const tencentProbe = await probe('tencent', 'pdf')
const skillsShProbe = await probe('skills-sh', 'pdf')
await probe('tencent', '')

await check('tencent search returns normalized items', () => {
  assert.equal(tencentProbe.status, 200, JSON.stringify(tencentProbe.body))
  assert.equal(tencentProbe.body.ok, true)
  assert.ok(tencentProbe.body.items.length > 0)
  const item = tencentProbe.body.items[0]
  assert.equal(typeof item.ref, 'string')
  assert.equal(typeof item.name, 'string')
  assert.equal(item.source, 'tencent')
  assert.equal(item.installed, false)
})

await check('skills.sh search returns normalized items', () => {
  assert.equal(skillsShProbe.status, 200, JSON.stringify(skillsShProbe.body))
  assert.equal(skillsShProbe.body.ok, true)
  assert.ok(skillsShProbe.body.items.length > 0)
  const item = skillsShProbe.body.items[0]
  assert.match(item.ref, /^[^/]+\/[^/]+$/)
  assert.equal(item.source, 'skills-sh')
})

await check('install + update one real tencent skill into a temp root', async () => {
  const item = tencentProbe.body.items[0]
  liveItem = item
  const installed = await live.call('/skill-dashboard/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'install', source: 'tencent', ref: item.ref, name: item.name }),
  })
  console.log(`  install → HTTP ${installed.status} ${JSON.stringify(installed.body)}`)
  assert.equal(installed.status, 200, JSON.stringify(installed.body))
  assert.equal(installed.body.ok, true)
  liveInstalled = installed.body
  const text = await readFile(join(installed.body.path, 'SKILL.md'), 'utf8')
  const parsed = parseSkillFrontmatter(text)
  assert.equal(parsed.ok, true, 'the installed SKILL.md must parse')
  const provenance = JSON.parse(await readFile(join(installed.body.path, '.skill-source.json'), 'utf8'))
  assert.equal(provenance.source, 'tencent')
  assert.equal(provenance.ref, item.ref)
  const files = await readdir(installed.body.path)
  console.log(`  installed ${files.length} files: ${files.join(', ')}`)
  const stagingAfterInstall = await readdir(join(process.env.DSH_HOME, 'skill-dashboard', 'staging')).catch(() => [])
  assert.deepEqual(stagingAfterInstall, [], 'no staging or backup tree survives a successful install')

  const duplicate = await live.call('/skill-dashboard/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'install', source: 'tencent', ref: item.ref, name: item.name }),
  })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.body.code, 'already-installed')

  const updated = await live.call('/skill-dashboard/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'update', source: 'tencent', ref: item.ref, name: item.name }),
  })
  console.log(`  update → HTTP ${updated.status} ${JSON.stringify(updated.body)}`)
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(updated.body.changed, false, 'an unchanged re-fetch reports changed=false')

  await sleep(1_200)
  const storedText = await readFile(join(process.env.DSH_HOME, 'skill-dashboard', 'installed.json'), 'utf8').catch(() => undefined)
  assert.notEqual(storedText, undefined, 'installed.json must be written')
  const store = JSON.parse(storedText)
  assert.equal(store.skills[item.name].source, 'tencent')

  const rediscover = await probe('tencent', 'pdf')
  const again = rediscover.body.items.find((entry) => entry.name === item.name)
  if (again !== undefined) assert.equal(again.installed, true, 'discover marks an installed skill')
})

await check('update replaces a locally modified tree through staging + backup', async () => {
  const item = liveItem
  const directory = liveInstalled.path
  const skillFile = join(directory, 'SKILL.md')
  const upstreamText = await readFile(skillFile, 'utf8')
  await writeFile(skillFile, `${upstreamText}\nlocal hand edit\n`, 'utf8')

  const updated = await live.call('/skill-dashboard/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'update', source: 'tencent', ref: item.ref, name: item.name }),
  })
  console.log(`  changed update → HTTP ${updated.status} ${JSON.stringify(updated.body)}`)
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(updated.body.changed, true, 'a modified tree reports changed=true')
  assert.equal(await readFile(skillFile, 'utf8'), upstreamText, 'the upstream tree replaced the local edit')
  assert.equal(existsSync(join(directory, '.skill-source.json')), true, 'provenance survives the swap')
  const leftovers = await readdir(join(process.env.DSH_HOME, 'skill-dashboard', 'staging')).catch(() => [])
  assert.deepEqual(leftovers, [], 'staging and backup trees are removed after a swap')

  // The very next update is a no-op again: the swap left the tree identical.
  const again = await live.call('/skill-dashboard/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'update', source: 'tencent', ref: item.ref, name: item.name }),
  })
  assert.equal(again.status, 200)
  assert.equal(again.body.changed, false)
})

await check('install from skills.sh into a temp root', async () => {
  const item = skillsShProbe.body.items[0]
  const installed = await live.call('/skill-dashboard/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'install', source: 'skills-sh', ref: item.ref, name: item.name }),
  })
  console.log(`  install ${item.ref}#${item.name} → HTTP ${installed.status} ${JSON.stringify(installed.body)}`)
  if (installed.status !== 200) {
    // A missing skill in that repo or a GitHub rate limit is a documented,
    // structured degradation rather than a bug.
    assert.equal(installed.body.ok, false)
    assert.equal(typeof installed.body.code, 'string')
    assert.equal(['source-unavailable', 'source-rate-limited', 'invalid-skill'].includes(installed.body.code), true)
    return
  }
  const files = await readdir(installed.body.path)
  console.log(`  installed ${files.length} files: ${files.join(', ')}`)
  const parsed = parseSkillFrontmatter(await readFile(join(installed.body.path, 'SKILL.md'), 'utf8'))
  assert.equal(parsed.ok, true)
})

await check('a failing upstream degrades to source-unavailable', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('simulated outage')
  }
  try {
    const response = await live.call('/skill-dashboard/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'SKILLS-SH-NOT-CACHED', query: 'zzz-unique-query' }),
    })
    assert.equal(response.status, 400, 'an unknown source is a client error')

    const tencentFailure = await live.call('/skill-dashboard/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'tencent', query: 'zzz-unique-query-2' }),
    })
    assert.equal(tencentFailure.status, 502)
    assert.equal(tencentFailure.body.ok, false)
    assert.equal(tencentFailure.body.code, 'source-unavailable')
    assert.equal(String(tencentFailure.body.message).includes('keyword='), false, 'messages never leak the query string')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await rm(workspace, { recursive: true, force: true })
await rm(liveRoot, { recursive: true, force: true })

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
  console.log(`all ${passed} real-data assertions passed`)
}
