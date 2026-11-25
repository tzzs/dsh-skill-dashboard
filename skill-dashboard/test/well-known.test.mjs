import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readTarEntries } from '../index.js'
import { tarArchive as tar } from './tar-fixture.mjs'

/** The relative paths one archive yields, in returned order. */
function paths(entries) {
  const parsed = readTarEntries(tar(entries))
  assert.equal(parsed.ok, true, parsed.message)
  return parsed.entries.map((entry) => entry.path)
}

test('a tar archive yields its textual files with SKILL.md first', () => {
  const parsed = readTarEntries(tar([
    { path: 'references/guide.md', text: '# guide\n' },
    { path: 'SKILL.md', text: '---\nname: demo\n---\n' },
    { path: 'references/summary.txt', text: 'summary\n' },
  ]))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.truncated, false)
  assert.deepEqual(parsed.entries.map((entry) => entry.path), ['SKILL.md', 'references/guide.md', 'references/summary.txt'])
  assert.equal(parsed.entries[0].text, '---\nname: demo\n---\n')
})

test('directories, links, binaries and extension headers are not skill files', () => {
  assert.deepEqual(
    paths([
      { path: 'references/', type: '5' },
      { path: 'SKILL.md', text: 'x' },
      { path: 'assets/logo.png', text: 'binary-ish' },
      { path: 'escape', type: '2' },
      { path: 'PaxHeaders/x', type: 'x', text: '30 path=comment.txt\n' },
      { path: 'comment.txt', type: 'g', text: 'global' },
      { path: 'LongLink', type: 'K', text: 'target' },
    ]),
    ['SKILL.md'],
  )
})

test('an absolute or parent path never becomes a skill file', () => {
  assert.deepEqual(
    paths([
      { path: 'SKILL.md', text: 'x' },
      { path: '/etc/passwd', text: 'root' },
      { path: '../escape.md', text: 'escape' },
      { path: 'deep/../../escape.md', text: 'escape' },
      { path: 'C:/windows/win.ini', text: 'os' },
    ]),
    ['SKILL.md'],
  )
})

test('the zero block ends the archive', () => {
  const trailer = tar([{ path: 'SKILL.md', text: 'x' }, { path: 'after.md', text: 'ignored' }])
  // A second archive appended after the terminator must not be read.
  const parsed = readTarEntries(Buffer.concat([trailer, tar([{ path: 'smuggled.md', text: 'no' }])]))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.entries.map((entry) => entry.path), ['SKILL.md', 'after.md'])
})

test('a malformed or truncated archive is refused', () => {
  const good = tar([{ path: 'SKILL.md', text: 'hello' }])
  const badSize = Buffer.from(good)
  badSize.write('zzzzzzzzzzz\0', 124, 12, 'latin1')
  assert.equal(readTarEntries(badSize).ok, false)
  assert.equal(readTarEntries(good.subarray(0, 514)).ok, false, 'a body shorter than its entry data is truncated')
  assert.equal(readTarEntries(Buffer.alloc(0)).ok, true, 'an empty archive has no entries')
  assert.equal(readTarEntries('not a buffer').ok, false)
})

test('the entry and text budgets cap one archive', () => {
  const many = Array.from({ length: 240 }, (_, index) => ({ path: `references/f${index}.md`, text: 'x' }))
  const capped = readTarEntries(tar([{ path: 'SKILL.md', text: 'x' }, ...many]))
  assert.equal(capped.ok, true)
  assert.equal(capped.truncated, true)
  assert.equal(capped.entries.length, 200, 'the scan stops at 200 entries including SKILL.md')

  const huge = readTarEntries(tar([
    { path: 'SKILL.md', text: 'x' },
    { path: 'references/big.md', text: 'y'.repeat(1024 * 1024 + 1) },
  ]))
  assert.equal(huge.ok, true)
  assert.equal(huge.truncated, true)
  assert.deepEqual(huge.entries.map((entry) => entry.path), ['SKILL.md'], 'an over-budget file is dropped, not truncated')
})
