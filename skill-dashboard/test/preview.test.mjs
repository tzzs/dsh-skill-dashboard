import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { apply } from '../index.js'

// Isolated Host doubles: no installed profile or live network is used.
const temporary = await mkdtemp(join(tmpdir(), 'skd-preview-'))
const originalEnv = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME, DSH_INSTALL_DIR: process.env.DSH_INSTALL_DIR }
process.env.DSH_HOME = join(temporary, 'home')
process.env.DSH_AGENTS_HOME = join(temporary, 'agents')
process.env.DSH_INSTALL_DIR = join(temporary, 'bundled')
after(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(temporary, { recursive: true, force: true })
})
const markdown = '---\nname: demo\ndescription: Preview fixture.\n---\n\n# Demo\n'
async function put(path, content = markdown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}
const main = await put(join(temporary, 'local', 'demo', 'SKILL.md'))
await put(join(dirname(main), 'references', 'nested.md'), 'Nested reference.')
await put(join(dirname(main), 'image.png'), Buffer.from([137, 80, 78, 71, 0, 255]))
await put(join(dirname(main), 'large.txt'), '€'.repeat(100000))
await put(join(dirname(main), 'invalid.dat'), Buffer.from([255, 254, 253]))
await put(join(dirname(main), 'node_modules', 'secret.md'), 'excluded')
await put(join(dirname(main), '.git', 'config'), 'excluded')
const flat = await put(join(temporary, 'flat', 'single.md'))
await put(join(dirname(flat), 'private.md'), 'PRIVATE')
const bundled = await put(join(temporary, 'bundled', 'demo', 'SKILL.md'))
const catalog = [main, flat, bundled].map((path, index) => ({ name: `fixture-${index}`, description: 'Catalog description.', path, source: index === 2 ? 'bundled' : 'custom', provider: 'filesystem' }))

function host(skills = catalog, rejection) {
  const routes = new Map()
  const ctx = {
    skills: { list: async () => skills },
    get: (name) => name === 'connection' && rejection !== undefined ? { requestRejection: () => rejection } : undefined,
    logger: { info() {}, warn() {} },
    on() {},
    effect: (factory) => factory(),
    webServer: { register(route) { routes.set(route.path, route); return () => {} } },
  }
  apply(ctx)
  return async (body = { path: main }, options = {}) => {
    let resolveReply
    const reply = new Promise((resolve) => { resolveReply = resolve })
    const req = {
      method: options.method ?? 'POST', url: '/skill-dashboard/preview',
      headers: { 'content-type': options.type ?? 'application/json' },
      once() {}, off() {}, resume() {},
      async *[Symbol.asyncIterator]() { yield Buffer.from(options.raw ?? JSON.stringify(body)) },
    }
    const res = {
      headers: {}, writableEnded: false,
      setHeader(name, value) { this.headers[name] = value },
      once() {}, off() {},
      end(text) { this.writableEnded = true; resolveReply({ status: this.statusCode, headers: this.headers, body: text ? JSON.parse(text) : null }) },
    }
    routes.get('/skill-dashboard/preview').handler(req, res)
    return reply
  }
}
const call = host()

test('catalog preview returns details, default file, nested list and no writes', async () => {
  const response = await call()
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(response.body.skill, { name: 'fixture-0', description: 'Catalog description.', path: main, source: 'custom', version: null, readonly: false, agents: ['default'] })
  assert.equal(response.body.file.path, 'SKILL.md')
  assert.equal(response.body.file.content, markdown)
  assert.equal(response.body.truncatedFiles, false)
  assert(response.body.files.some((file) => file.path === 'references/nested.md' && file.kind === 'text'))
  assert(!response.body.files.some((file) => /node_modules|\.git/.test(file.path)))
  const nested = await call({ path: main, file: 'references/nested.md' })
  assert.equal(nested.body.file.content, 'Nested reference.')
  const windowsNested = await call({ path: main, file: 'references\\nested.md' })
  assert.equal(windowsNested.body.file.path, 'references/nested.md')
  assert.equal(await readFile(main, 'utf8'), markdown)
})

test('rejects traversal, absolute, drive, null, wrong types and unknown catalog paths', async () => {
  for (const file of ['../private.md', 'references/../../private.md', '/etc/passwd', 'C:\\private.md', '\\\\server\\share', 'C:private.md', 'ref\0.md', 'references/./nested.md', 1, null, '.git/config']) {
    const response = await call({ path: main, file })
    assert.equal(response.status, 400, JSON.stringify(file))
    assert.equal(response.body.code, 'bad-request')
  }
  assert.equal((await call({ path: 'relative/SKILL.md' })).status, 400)
  assert.equal((await call({ path: main + '\0' })).status, 400)
  assert.equal((await call({ path: join(temporary, 'unknown.md') })).body.code, 'skill-not-found')
  assert.equal((await call({ path: main, file: 'missing.md' })).body.code, 'file-not-found')
})

test('flat skills expose only their own file; bundled skills remain readable', async () => {
  const response = await call({ path: flat })
  assert.deepEqual(response.body.files.map((file) => file.path), ['single.md'])
  assert.equal(response.body.file.path, 'single.md')
  assert.equal((await call({ path: flat, file: 'private.md' })).status, 404)
  const readonly = await call({ path: bundled })
  assert.equal(readonly.status, 200)
  assert.equal(readonly.body.skill.readonly, true)
  assert.equal(readonly.body.file.content, markdown)
})

test('symlink/junction escapes and symlink skill files cannot expose external bytes', async (t) => {
  const outside = join(temporary, 'outside')
  await put(join(outside, 'secret.md'), 'PRIVATE')
  const link = join(dirname(main), 'escape')
  try { await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') return t.skip('platform does not permit symlinks'); throw error }
  const response = await call()
  assert(!response.body.files.some((file) => file.path.startsWith('escape/')))
  assert.equal((await call({ path: main, file: 'escape/secret.md' })).status, 404)
  const linkedMain = join(temporary, 'linked.md')
  try { await symlink(main, linkedMain, 'file') }
  catch (error) { if (error.code === 'EPERM') return; throw error }
  assert.equal((await host([{ name: 'linked', path: linkedMain }])({ path: linkedMain })).status, 403)
})

test('binary bytes stay metadata and large UTF-8 text is truncated by bytes', async () => {
  for (const file of ['image.png', 'invalid.dat']) {
    const response = await call({ path: main, file })
    assert.equal(response.body.file.kind, 'binary')
    assert.equal(response.body.file.content, null)
    assert.equal(response.body.file.truncated, false)
  }
  const response = await call({ path: main, file: 'large.txt' })
  assert.equal(response.body.file.size, 300000)
  assert.equal(response.body.file.truncated, true)
  assert.equal(Buffer.byteLength(response.body.file.content), 128 * 1024 - 2)
  assert(!response.body.file.content.includes('\ufffd'))
})

test('file count and directory depth caps report omitted entries', async () => {
  const path = await put(join(temporary, 'bounded', 'SKILL.md'))
  await Promise.all(Array.from({ length: 205 }, (_, index) => put(join(dirname(path), `file-${index}.txt`), 'x')))
  const response = await host([{ name: 'bounded', path }])({ path })
  assert.equal(response.body.files.length, 200)
  assert.equal(response.body.truncatedFiles, true)
  const deep = await put(join(temporary, 'deep', 'SKILL.md'))
  await put(join(dirname(deep), ...Array(8).fill('sub'), 'hidden.md'), 'x')
  const nested = await host([{ name: 'deep', path: deep }])({ path: deep })
  assert.equal(nested.body.truncatedFiles, true)
  assert.deepEqual(nested.body.files.map((file) => file.path), ['SKILL.md'])
})

test('method, JSON size/type and trust fences match other Host routes', async () => {
  const method = await call({}, { method: 'GET' })
  assert.equal(method.status, 405)
  assert.equal(method.headers.allow, 'POST')
  assert.equal((await call({}, { type: 'text/plain' })).status, 415)
  assert.equal((await call({}, { raw: '{' })).status, 400)
  assert.equal((await call({}, { raw: '[]' })).status, 400)
  assert.equal((await call({}, { raw: 'x'.repeat(1024 * 1024 + 1) })).status, 413)
  assert.equal((await host(catalog, 403)({}, { method: 'GET', raw: '{' })).status, 403)
  assert.equal((await call({ source: 'unknown', ref: 'demo', name: 'demo' })).status, 400)
  for (const ref of ['../repo', 'owner/../repo', 'https://example.com', 'owner/repo?x']) {
    assert.equal((await call({ source: 'skills-sh', ref, name: 'demo' })).status, 400)
  }
})

test('local metadata listings open only the selected file and fileOnly reuses the listing', async () => {
  const path = await put(join(temporary, 'counted', 'SKILL.md'))
  await put(join(dirname(path), 'references', 'one.md'), 'One')
  await put(join(dirname(path), 'references', 'two.md'), 'Two')
  const local = host([{ name: 'counted', path }])
  const originalOpen = fsPromises.open
  const originalOpendir = fsPromises.opendir
  const reads = []
  const scans = []
  fsPromises.open = async (...args) => { reads.push(args[0]); return originalOpen(...args) }
  fsPromises.opendir = async (...args) => { scans.push(args[0]); return originalOpendir(...args) }
  syncBuiltinESMExports()
  try {
    const initial = await local({ path })
    assert.equal(initial.status, 200)
    assert.deepEqual(reads, [path], 'listing metadata never opens contained file content')
    const initialScans = scans.length
    assert.equal(initialScans, 2)
    const selected = await local({ path, file: 'references/one.md', fileOnly: true })
    assert.equal(selected.body.files, undefined)
    assert.equal(selected.body.file.content, 'One')
    assert.equal(selected.body.skill.name, 'counted')
    assert.equal(scans.length, initialScans, 'file selection never rescans cached directories')
    assert.equal(reads.length, 2, 'one bounded content read per local selection')
    await put(join(dirname(path), 'references', 'new.md'), 'New')
    const cached = await local({ path })
    assert(!cached.body.files.some((file) => file.path === 'references/new.md'))
    assert.equal(scans.length, initialScans)
    const refreshed = await local({ path, refresh: true })
    assert(refreshed.body.files.some((file) => file.path === 'references/new.md'))
    assert.equal(scans.length, initialScans * 2, 'explicit refresh rebuilds listing')
    await put(join(dirname(path), 'root-new.md'), 'Root change')
    const stale = await local({ path })
    assert(stale.body.files.some((file) => file.path === 'root-new.md'))
    assert.equal(scans.length, initialScans * 3, 'root metadata change invalidates listing')
  } finally {
    fsPromises.open = originalOpen
    fsPromises.opendir = originalOpendir
    syncBuiltinESMExports()
  }
})

test('cached selected files are revalidated against symlink escapes', async (t) => {
  const path = await put(join(temporary, 'stale-link', 'SKILL.md'))
  const selected = await put(join(dirname(path), 'references', 'safe.md'), 'Safe')
  const external = await put(join(temporary, 'outside-secret.md'), 'PRIVATE')
  const local = host([{ name: 'stale-link', path }])
  await local({ path })
  await rm(selected)
  try { await symlink(external, selected, 'file') }
  catch (error) { if (error.code === 'EPERM') return t.skip('platform does not permit file symlinks'); throw error }
  const response = await local({ path, file: 'references/safe.md', fileOnly: true })
  assert.equal(response.status, 200)
  assert.equal(response.body.file.kind, 'unavailable')
  assert.equal(response.body.file.content, null)
})

test('Tencent discovery uses lazy cached source text without installation', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (url.endsWith('/files')) return Response.json({ data: { version: '1.2.3', files: [{ path: 'SKILL.md' }, { path: 'references/guide.md' }, { path: 'logo.png' }] } })
    const path = new URL(url).searchParams.get('path')
    return new Response(path === 'SKILL.md' ? markdown : 'Remote guide.')
  }
  try {
    const remote = host()
    const body = { source: 'tencent', ref: 'demo', name: 'demo' }
    const response = await remote(body)
    assert.equal(response.status, 200)
    assert.equal(response.body.skill.name, 'demo')
    assert.equal(response.body.skill.description, 'Preview fixture.')
    assert.equal(response.body.skill.version, '1.2.3')
    assert.equal(response.body.skill.readonly, true)
    assert.equal(response.body.file.content, markdown)
    assert.deepEqual(response.body.files.map((file) => file.path), ['SKILL.md', 'references/guide.md', 'logo.png'])
    assert.equal(calls.length, 2, 'initial preview fetches metadata and only SKILL.md')
    assert(!calls.some((url) => url.includes('guide.md') || url.includes('logo.png')))
    const guide = await remote({ ...body, file: 'references/guide.md', fileOnly: true })
    assert.equal(guide.body.file.content, 'Remote guide.')
    assert.equal(guide.body.files, undefined)
    assert.equal(calls.length, 3, 'file selection fetches only that file')
    await remote({ ...body, file: 'references/guide.md', fileOnly: true })
    assert.equal(calls.length, 3, 'repeat selection uses selected-content cache')
    const binary = await remote({ ...body, file: 'logo.png', fileOnly: true })
    assert.equal(binary.body.file.kind, 'binary')
    assert.equal(binary.body.file.content, null)
    assert.equal(calls.length, 3, 'known binary selection never downloads binary content')
    await remote({ ...body, refresh: true })
    assert.equal(calls.length, 5, 'explicit refresh reloads directory metadata and selected file')
    await remote({ ...body, file: 'references/guide.md', fileOnly: true })
    assert.equal(calls.length, 6, 'refresh invalidates content cached against the previous listing')
    assert.equal((await remote({ ...body, file: '../outside.md' })).status, 400)
  } finally { globalThis.fetch = originalFetch }
})

test('skills.sh nested discovery selects named directory without downloading unopened files', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (url.includes('/git/trees/')) return Response.json({ tree: ['skills/demo/SKILL.md', 'skills/demo/references/guide.md', 'skills/demo/image.png', 'other/SKILL.md'].map((path) => ({ type: 'blob', path })) })
    return new Response(url.endsWith('/SKILL.md') ? markdown : 'GitHub guide.')
  }
  try {
    const response = await host()({ source: 'skills-sh', ref: 'owner/repo', name: 'demo', file: 'references/guide.md' })
    assert.equal(response.status, 200)
    assert.equal(response.body.file.content, 'GitHub guide.')
    assert.equal(response.body.skill.source, 'skills-sh')
    assert.equal(calls.length, 2)
    assert(calls.slice(1).every((url) => url.includes('/skills/demo/')))
    assert(!calls.some((url) => url.endsWith('/SKILL.md') || url.endsWith('/image.png')))
    assert(response.body.files.some((file) => file.path === 'image.png' && file.kind === 'binary'))
  } finally { globalThis.fetch = originalFetch }
})

test('remote display and adapter file caps report truncation', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url.endsWith('/files')) return Response.json({ data: { files: [
      { path: 'SKILL.md' }, { path: 'large.txt', size: 160000 }, { path: 'too-large.txt', size: 2 * 1024 * 1024 },
      ...Array.from({ length: 45 }, (_, index) => ({ path: `file-${index}.txt` })),
    ] } })
    const path = new URL(url).searchParams.get('path')
    return new Response(path === 'SKILL.md' ? markdown : path === 'large.txt' ? 'x'.repeat(160000) : 'small')
  }
  try {
    const response = await host()({ source: 'tencent', ref: 'bounded', name: 'bounded', file: 'large.txt' })
    assert.equal(response.status, 200)
    assert.equal(response.body.files.length, 40)
    assert.equal(response.body.truncatedFiles, true)
    assert.equal(response.body.file.truncated, true)
    assert.equal(response.body.file.content.length, 128 * 1024)
    assert.equal(response.body.file.size, 160000)
  } finally { globalThis.fetch = originalFetch }
})

test('selected remote streams stop at the display cap and cancel unread content', async () => {
  const originalFetch = globalThis.fetch
  let chunks = 0
  let cancelled = false
  globalThis.fetch = async (url) => {
    if (url.endsWith('/files')) return Response.json({ files: [{ path: 'SKILL.md', size: 1024 * 1024 }] })
    return new Response(new ReadableStream({
      pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(65536).fill(65)) },
      cancel() { cancelled = true },
    }), { headers: { 'content-length': String(1024 * 1024) } })
  }
  try {
    const response = await host()({ source: 'tencent', ref: 'streamed', name: 'streamed' })
    assert.equal(response.status, 200)
    assert.equal(response.body.file.size, 1024 * 1024)
    assert.equal(response.body.file.content.length, 128 * 1024)
    assert.equal(response.body.file.truncated, true)
    assert.equal(cancelled, true)
    assert(chunks <= 4, 'stream is cancelled after its prefix, including at most one prefetched chunk')
  } finally { globalThis.fetch = originalFetch }
})

test('GitHub rate-limit fallback fetches and caches only conventional SKILL.md', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return url.includes('/git/trees/') ? new Response('', { status: 403 }) : new Response(markdown)
  }
  try {
    const remote = host()
    const body = { source: 'skills-sh', ref: 'owner/repo', name: 'demo' }
    const response = await remote(body)
    assert.equal(response.status, 200)
    assert.equal(response.body.file.content, markdown)
    assert.equal(response.body.truncatedFiles, true)
    assert.equal(calls.length, 2)
    await remote({ ...body, file: 'SKILL.md', fileOnly: true })
    assert.equal(calls.length, 2)
  } finally { globalThis.fetch = originalFetch }
})

test('preview cache expiry refreshes metadata without live timers', async () => {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return url.endsWith('/files') ? Response.json({ files: [{ path: 'SKILL.md' }] }) : new Response(markdown)
  }
  try {
    const remote = host()
    const body = { source: 'tencent', ref: 'expiring', name: 'expiring' }
    await remote(body)
    assert.equal(calls.length, 2)
    Date.now = () => originalNow() + 15001
    await remote(body)
    assert.equal(calls.length, 4, 'both metadata and selected prefix expire after 15 seconds')
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow }
})

test('a catalog file which no longer exists returns preview-unavailable', async () => {
  const path = join(temporary, 'removed', 'SKILL.md')
  const response = await host([{ name: 'removed', path }])({ path })
  assert.equal(response.status, 404)
  assert.equal(response.body.code, 'preview-unavailable')
})

test('remote errors and rate limits produce reasonable source failures', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('', { status: 429 })
    const response = await host()({ source: 'tencent', ref: 'unavailable', name: 'unavailable' })
    assert.equal(response.status, 502)
    assert.equal(response.body.code, 'source-rate-limited')
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.equal((await host()({ source: 'tencent', ref: 'offline', name: 'offline' })).body.code, 'source-unavailable')
  } finally { globalThis.fetch = originalFetch }
})
