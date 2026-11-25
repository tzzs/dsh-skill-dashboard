import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRef } from '../index.js'

/** Parse one reference the table says is valid. */
function locator(ref) {
  const parsed = parseRef(ref)
  assert.equal(parsed.ok, true, `"${String(ref)}" was refused: ${parsed.message}`)
  return parsed.value
}

test('a tencent reference is one kebab-case slug', () => {
  const parsed = parseRef('  multi-search-engine  ')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value, {
    source: 'tencent',
    ref: 'multi-search-engine',
    name: 'multi-search-engine',
    slug: 'multi-search-engine',
    owner: '',
    repo: '',
    path: '',
  })
})

test('every accepted GitHub form lands on one canonical reference', () => {
  const cases = [
    ['anthropics/skills', 'anthropics/skills', 'skills', undefined, ''],
    ['anthropics/skills/', 'anthropics/skills', 'skills', undefined, ''],
    ['anthropics/skills.git', 'anthropics/skills', 'skills', undefined, ''],
    ['anthropics/skills@main', 'anthropics/skills@main', 'skills', 'main', ''],
    ['anthropics/skills@main/', 'anthropics/skills@main', 'skills', 'main', ''],
    ['anthropics/skills#skills/pdf', 'anthropics/skills#skills/pdf', 'pdf', undefined, 'skills/pdf'],
    ['anthropics/skills#skills/pdf/', 'anthropics/skills#skills/pdf', 'pdf', undefined, 'skills/pdf'],
    ['anthropics/skills@main#skills/pdf', 'anthropics/skills@main#skills/pdf', 'pdf', 'main', 'skills/pdf'],
    ['anthropics/skills/skills/pdf', 'anthropics/skills#skills/pdf', 'pdf', undefined, 'skills/pdf'],
    ['anthropics/skills#skills/pdf/SKILL.md', 'anthropics/skills#skills/pdf', 'pdf', undefined, 'skills/pdf'],
    ['anthropics/skills#skills/pdf/skill.md', 'anthropics/skills#skills/pdf', 'pdf', undefined, 'skills/pdf'],
    ['https://github.com/anthropics/skills', 'anthropics/skills', 'skills', undefined, ''],
    ['https://github.com/anthropics/skills.git', 'anthropics/skills', 'skills', undefined, ''],
    ['https://github.com/anthropics/skills/tree/main/skills/pdf', 'anthropics/skills@main#skills/pdf', 'pdf', 'main', 'skills/pdf'],
    ['http://www.github.com/anthropics/skills/tree/main/skills/pdf/', 'anthropics/skills@main#skills/pdf', 'pdf', 'main', 'skills/pdf'],
    ['www.github.com/anthropics/skills/tree/main/skills/pdf', 'anthropics/skills@main#skills/pdf', 'pdf', 'main', 'skills/pdf'],
    ['github.com/anthropics/skills/tree/main/skills/pdf', 'anthropics/skills@main#skills/pdf', 'pdf', 'main', 'skills/pdf'],
    [
      'https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md',
      'anthropics/skills@main#skills/pdf',
      'pdf',
      'main',
      'skills/pdf',
    ],
    ['https://github.com/anthropics/skills/blob/main/skills/pdf/skill.md', 'anthropics/skills@main#skills/pdf', 'pdf', 'main', 'skills/pdf'],
    ['anthropics/skills@e4bb5d960d87126ff3b3a8af1a104b7db67560ba', 'anthropics/skills@e4bb5d960d87126ff3b3a8af1a104b7db67560ba', 'skills', 'e4bb5d960d87126ff3b3a8af1a104b7db67560ba', ''],
  ]
  for (const [input, ref, name, rev, path] of cases) {
    const value = locator(input)
    assert.equal(value.source, 'skills-sh', input)
    assert.equal(value.ref, ref, input)
    assert.equal(value.name, name, input)
    assert.equal(value.rev, rev, input)
    assert.equal(value.path, path, input)
    assert.equal(value.slug, '', input)
    assert.equal(value.owner, 'anthropics', input)
    assert.equal(value.repo, 'skills', input)
  }
})

test('a URL and its bare equivalent are the same canonical reference', () => {
  const url = locator('https://github.com/anthropics/skills/tree/main/skills/pdf').ref
  for (const bare of ['anthropics/skills@main#skills/pdf', 'anthropics/skills/skills/pdf@main', 'github.com/anthropics/skills/tree/main/skills/pdf']) {
    assert.equal(locator(bare).ref, url, bare)
  }
})

test('parsing a canonical reference is a fixed point', () => {
  const inputs = [
    'multi-search-engine',
    'anthropics/skills',
    'anthropics/skills@main',
    'anthropics/skills#skills/pdf',
    'anthropics/skills@v1.0.0#skills/pdf',
    'https://github.com/anthropics/skills/tree/main/skills/pdf',
    'https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/pdf/SKILL.md',
    'github.com/owner/repo.git/tree/main/docs/deep/skill',
  ]
  for (const input of inputs) {
    const once = locator(input)
    const twice = locator(once.ref)
    assert.deepEqual(twice, once, input)
    assert.equal(twice.ref, once.ref, input)
  }
})

test('a public archive URL is one well-known reference', () => {
  const url = 'https://open.feishu.cn/lark-cli/skills/regular/.well-known/agent-skills/lark-doc.tar.gz'
  const value = locator(url)
  assert.deepEqual(value, {
    source: 'well-known',
    ref: url,
    url,
    name: '',
    slug: '',
    owner: '',
    repo: '',
    path: '',
  })
  assert.deepEqual(locator(value.ref), value, 'an archive reference is its own canonical form')
  assert.equal(
    locator('  HTTPS://Open.Feishu.CN/x/LARK-DOC.TAR.GZ  ').ref,
    'HTTPS://Open.Feishu.CN/x/LARK-DOC.TAR.GZ',
    'the stored form keeps the spelling the lock recorded',
  )
})

test('only a public https archive is a well-known reference', () => {
  const refused = [
    'http://open.feishu.cn/x.tar.gz',
    'https://localhost/x.tar.gz',
    'https://127.0.0.1/x.tar.gz',
    'https://192.168.1.5/x.tar.gz',
    'https://[::1]/x.tar.gz',
    'https://intranet/x.tar.gz',
    'https://open.feishu.cn/x.tar',
    'https://open.feishu.cn/x.gz',
    'https://open.feishu.cn/',
    'https://open.feishu.cn',
  ]
  for (const input of refused) {
    const parsed = parseRef(input)
    assert.equal(parsed.ok, false, `${input} was accepted as ${JSON.stringify(parsed.value)}`)
    assert.equal(parsed.code, 'bad-request', input)
  }
})

test('malformed, unsafe and non-GitHub references are refused', () => {
  const refused = [
    '',
    '   ',
    'a'.repeat(513),
    'owner\u0000/repo',
    'owner/repo\u0001',
    'owner\\repo',
    'https://example.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://example.com',
    'own er/repo',
    'owner/re po',
    'owner/repo!',
    '../repo',
    './repo',
    'owner/..',
    'owner/repo@fix/bug',
    'owner/repo@main branch',
    `owner/repo@${'a'.repeat(201)}`,
    'owner/repo#skills/./pdf',
    'owner/repo#../pdf',
    'owner/repo#/abs',
    `owner/repo#${'a'.repeat(201)}`,
    'https://github.com/owner/repo/blob/main/skills/pdf/README.md',
    'Multi_Search',
    'multi_search',
    42,
    null,
    undefined,
    { ref: 'owner/repo' },
  ]
  for (const input of refused) {
    const parsed = parseRef(input)
    assert.equal(parsed.ok, false, `${JSON.stringify(input)} was accepted as ${JSON.stringify(parsed.value)}`)
    assert.equal(parsed.code, 'bad-request', String(input))
    assert.equal(typeof parsed.message, 'string')
    assert.ok(parsed.message.length > 0, String(input))
  }
})
