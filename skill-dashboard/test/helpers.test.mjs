/**
 * Throwaway assertions for the pure helpers of `skill-dashboard/index.js`.
 *
 * Run with Node.js 20 or later:
 *   node test/helpers.test.mjs
 *
 * Nothing here touches the profile, the Host, or the network.
 */

import assert from 'node:assert/strict'
import { join, sep } from 'node:path'

import {
  applyInvocationEdit,
  applyUsageEvent,
  foldDayBuckets,
  isInsidePath,
  isProtectedInstallPath,
  mergeAgentSkills,
  normalizePathKey,
  parseSkillFrontmatter,
  pruneDayBuckets,
  sanitizeSkillRelativePath,
  skillDirectoryOf,
  splitTextLines,
  joinTextLines,
  summarizeSkillUsage,
  summarizeUsage,
} from '../index.js'

let passed = 0
const failures = []

/** Run one named assertion group. */
function test(name, body) {
  try {
    body()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

// --------------------------------------------------------------------- lines

test('splitTextLines/joinTextLines round-trip LF and CRLF exactly', () => {
  const lf = '---\nname: a\ndescription: b\n---\n\nbody\n'
  assert.equal(joinTextLines(splitTextLines(lf)), lf)
  const crlf = '---\r\nname: a\r\ndescription: b\r\n---\r\n\r\nbody\r\n'
  assert.equal(joinTextLines(splitTextLines(crlf)), crlf)
  const mixed = '---\r\nname: a\ndescription: b\r\n---\ntail'
  assert.equal(joinTextLines(splitTextLines(mixed)), mixed)
  const noTrailingNewline = '---\nname: a\n---'
  assert.equal(joinTextLines(splitTextLines(noTrailingNewline)), noTrailingNewline)
  assert.equal(splitTextLines('').length, 0)
})

// --------------------------------------------------------------- frontmatter

const PLAIN = ['---', 'name: demo-skill', 'description: Does a demo thing.', '---', '', '# Demo', '', 'Body text.', ''].join('\n')

const NESTED = [
  '---',
  'name: lark-ish',
  'version: 1.0.0',
  'description: "A quoted: description with an escaped \\"quote\\"."',
  'metadata:',
  '  requires:',
  '    bins: ["lark-cli"]',
  '  cliHelp: "lark-cli apps --help"',
  'license: Complete terms in LICENSE.txt',
  '---',
  '',
  'Body.',
  '',
].join('\n')

test('parseSkillFrontmatter reads a plain skill', () => {
  const parsed = parseSkillFrontmatter(PLAIN)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.name, 'demo-skill')
  assert.equal(parsed.description, 'Does a demo thing.')
  assert.equal(parsed.modelInvocable, true)
  assert.equal(parsed.userInvocable, true)
})

test('parseSkillFrontmatter unquotes and unescapes a quoted description', () => {
  const parsed = parseSkillFrontmatter(NESTED)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.description, 'A quoted: description with an escaped "quote".')
})

test('parseSkillFrontmatter resolves both invocation keys', () => {
  const text = ['---', 'name: demo', 'description: d', 'disable-model-invocation: true', 'user-invocable: false', '---', ''].join('\n')
  const parsed = parseSkillFrontmatter(text)
  assert.equal(parsed.modelInvocable, false)
  assert.equal(parsed.userInvocable, false)
})

test('parseSkillFrontmatter rejects what the provider rejects', () => {
  assert.equal(parseSkillFrontmatter('no frontmatter here').ok, false)
  assert.equal(parseSkillFrontmatter('---\nname: demo\n---\n').code, 'invalid-frontmatter')
  assert.equal(parseSkillFrontmatter('---\ndescription: d\n---\n').code, 'invalid-frontmatter')
  assert.equal(parseSkillFrontmatter('---\nname: Not_Kebab\ndescription: d\n---\n').code, 'invalid-frontmatter')
  const legacy = ['---', 'name: demo', 'description: d', 'modelInvocable: false', '---', ''].join('\n')
  assert.equal(parseSkillFrontmatter(legacy).ok, false)
  const repeated = ['---', 'name: demo', 'name: other', 'description: d', '---', ''].join('\n')
  assert.equal(parseSkillFrontmatter(repeated).ok, false)
})

test('applyInvocationEdit appends a key and preserves every other byte', () => {
  const edited = applyInvocationEdit(PLAIN, { modelInvocable: false })
  assert.equal(edited.ok, true)
  assert.equal(edited.changed, true)
  const lines = edited.text.split('\n')
  assert.equal(lines[0], '---')
  assert.equal(lines[1], 'name: demo-skill')
  assert.equal(lines[2], 'description: Does a demo thing.')
  assert.equal(lines[3], 'disable-model-invocation: true')
  assert.equal(lines[4], '---')
  // Body is untouched.
  assert.equal(edited.text.slice(edited.text.indexOf('---\n\n# Demo')), '---\n\n# Demo\n\nBody text.\n')
  assert.equal(parseSkillFrontmatter(edited.text).modelInvocable, false)
})

test('applyInvocationEdit removes the key when the value returns to the default', () => {
  const off = applyInvocationEdit(PLAIN, { modelInvocable: false })
  const back = applyInvocationEdit(off.text, { modelInvocable: true })
  assert.equal(back.ok, true)
  assert.equal(back.changed, true)
  assert.equal(back.text, PLAIN)
})

test('applyInvocationEdit handles user-invocable independently', () => {
  const edited = applyInvocationEdit(PLAIN, { userInvocable: false })
  assert.match(edited.text, /\nuser-invocable: false\n---\n/)
  assert.equal(parseSkillFrontmatter(edited.text).modelInvocable, true)
  assert.equal(parseSkillFrontmatter(edited.text).userInvocable, false)
  const both = applyInvocationEdit(edited.text, { modelInvocable: false })
  assert.match(both.text, /disable-model-invocation: true\nuser-invocable: false\n---\n/)
  const restored = applyInvocationEdit(both.text, { modelInvocable: true, userInvocable: true })
  assert.equal(restored.text, PLAIN)
})

test('applyInvocationEdit never disturbs nested frontmatter or CRLF endings', () => {
  const edited = applyInvocationEdit(NESTED, { modelInvocable: false })
  assert.equal(edited.ok, true)
  const expected = NESTED.replace('license: Complete terms in LICENSE.txt\n---', 'license: Complete terms in LICENSE.txt\ndisable-model-invocation: true\n---')
  assert.equal(edited.text, expected)

  const crlf = NESTED.replace(/\n/g, '\r\n')
  const editedCrlf = applyInvocationEdit(crlf, { modelInvocable: false })
  assert.equal(editedCrlf.ok, true)
  assert.ok(editedCrlf.text.includes('license: Complete terms in LICENSE.txt\r\ndisable-model-invocation: true\r\n---\r\n'))
  assert.equal(editedCrlf.text.includes('\n\n'), false, 'no bare LF may be introduced')
})

test('applyInvocationEdit reports a no-op instead of rewriting', () => {
  const same = applyInvocationEdit(PLAIN, { modelInvocable: true, userInvocable: true })
  assert.equal(same.ok, true)
  assert.equal(same.changed, false)
  assert.equal(same.text, PLAIN)
})

test('applyInvocationEdit refuses a file the provider would reject', () => {
  const legacy = ['---', 'name: demo', 'description: d', 'userInvocable: false', '---', ''].join('\n')
  const outcome = applyInvocationEdit(legacy, { modelInvocable: false })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'invalid-frontmatter')
  const broken = ['---', 'name: demo', '---', ''].join('\n')
  assert.equal(applyInvocationEdit(broken, { modelInvocable: false }).ok, false)
})

test('applyInvocationEdit works on a flat <name>.md file', () => {
  const flat = ['---', 'name: flat-skill', 'description: A flat skill.', '---', '', 'Body.', ''].join('\n')
  const edited = applyInvocationEdit(flat, { modelInvocable: false })
  assert.equal(edited.ok, true)
  assert.equal(parseSkillFrontmatter(edited.text).modelInvocable, false)
  assert.equal(applyInvocationEdit(edited.text, { modelInvocable: true }).text, flat)
})

// -------------------------------------------------------------- day buckets

test('foldDayBuckets returns 14 buckets oldest → today', () => {
  const now = new Date(2026, 10, 17, 9, 30, 0).getTime() // 2026-11-17 local
  const buckets = foldDayBuckets({ '2026-11-17': 3, '2026-11-04': 1, '2020-01-01': 9 }, now)
  assert.equal(buckets.length, 14)
  assert.deepEqual(buckets[13], { date: '2026-11-17', count: 3 })
  assert.deepEqual(buckets[0], { date: '2026-11-04', count: 1 })
  assert.equal(buckets.filter((bucket) => bucket.count === 9).length, 0, 'out-of-window days never appear')
  assert.equal(foldDayBuckets(undefined, now).every((bucket) => bucket.count === 0), true)
  assert.equal(foldDayBuckets({ '2026-11-17': 'x' }, now)[13].count, 0)
})

test('pruneDayBuckets keeps 60 days and drops the rest', () => {
  const now = new Date(2026, 10, 17, 12, 0, 0).getTime()
  const pruned = pruneDayBuckets({ '2026-11-17': 1, '2026-10-01': 2, '2026-08-01': 3, '2020-01-01': 4 }, now)
  assert.deepEqual(Object.keys(pruned).sort(), ['2026-10-01', '2026-11-17'])
  assert.deepEqual(pruneDayBuckets(undefined, now), {})
})

// -------------------------------------------------------------- usage store

test('applyUsageEvent counts, dedupes sessions, and caps recent', () => {
  const state = { version: 1, skills: {}, recent: [] }
  const at = new Date(2026, 10, 17, 10, 0, 0).getTime()
  applyUsageEvent(state, { name: 'alpha', at, agentId: 'standard', sessionId: 's1', channel: 'model' })
  applyUsageEvent(state, { name: 'alpha', at, agentId: 'standard', sessionId: 's1', channel: 'model' })
  applyUsageEvent(state, { name: 'alpha', at, agentId: 'review', sessionId: 's2', channel: 'user' })
  const record = state.skills.alpha
  assert.equal(record.count, 3)
  assert.deepEqual(record.sessions, ['s1', 's2'])
  assert.equal(record.model, 2)
  assert.equal(record.user, 1)
  assert.equal(record.days['2026-11-17'], 3)
  assert.equal(state.recent.length, 3)
  assert.deepEqual(state.recent[0], { name: 'alpha', at, agentId: 'review' })

  for (let index = 0; index < 30; index += 1) {
    applyUsageEvent(state, { name: 'alpha', at: at + index, agentId: 'standard', sessionId: `x${index}`, channel: 'model' })
  }
  assert.equal(state.recent.length, 20)
  assert.equal(state.skills.alpha.sessions.length, 32)
  for (let index = 0; index < 250; index += 1) {
    applyUsageEvent(state, { name: 'alpha', at: at, agentId: 'standard', sessionId: `cap${index}`, channel: 'model' })
  }
  assert.equal(state.skills.alpha.sessions.length, 200, 'distinct sessions are capped at 200')
})

test('applyUsageEvent ignores malformed events', () => {
  const state = { version: 1, skills: {}, recent: [] }
  applyUsageEvent(state, { name: '', at: 1 })
  applyUsageEvent(state, null)
  assert.deepEqual(state.skills, {})
})

test('summarizeSkillUsage and summarizeUsage produce the response shape', () => {
  const now = new Date(2026, 10, 17, 12, 0, 0).getTime()
  const state = { version: 1, skills: {}, recent: [] }
  applyUsageEvent(state, { name: 'alpha', at: now - 1000, agentId: 'standard', sessionId: 's1', channel: 'model' })
  applyUsageEvent(state, { name: 'beta', at: now - 500, agentId: 'review', sessionId: 's2', channel: 'user' })
  const alpha = summarizeSkillUsage(state.skills.alpha, now)
  assert.equal(alpha.count, 1)
  assert.equal(alpha.sessions, 1)
  assert.equal(alpha.lastUsedAt, now - 1000)
  assert.equal(alpha.days.length, 14)
  assert.equal(alpha.byModel, 1)
  assert.equal(alpha.byUser, 0)
  const summary = summarizeUsage(state, now)
  assert.equal(summary.totalCount, 2)
  assert.equal(summary.activeSkills, 2)
  assert.equal(summary.dayBuckets.length, 14)
  assert.equal(summary.dayBuckets[13].count, 2)
  assert.equal(summary.recent.length, 2)
  const empty = summarizeSkillUsage(undefined, now)
  assert.equal(empty.count, 0)
  assert.equal(empty.lastUsedAt, null)
})

// -------------------------------------------------------------------- merge

test('mergeAgentSkills unions by name and keeps the highest-ranked resolution', () => {
  const lists = [
    {
      id: 'standard',
      skills: [
        { name: 'alpha', description: 'from bundled', source: 'bundled', provider: 'filesystem', path: 'D:\\apps\\DeepSeek Harness\\resources\\app.asar\\dsh\\skills\\alpha\\SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
        { name: 'beta', description: 'from user', source: 'user-agents', provider: 'filesystem', path: join('fixture', 'agents', 'skills', 'beta', 'SKILL.md'), invocation: { modelInvocable: true, userInvocable: true } },
      ],
    },
    {
      id: 'review',
      skills: [
        { name: 'alpha', description: 'from user', source: 'user-agents', provider: 'filesystem', path: join('fixture', 'agents', 'skills', 'alpha', 'SKILL.md'), invocation: { modelInvocable: false, userInvocable: true } },
        { name: 'gamma', description: 'flat', source: 'user-agents', provider: 'filesystem', path: join('fixture', 'agents', 'skills', 'gamma.md'), invocation: { modelInvocable: true, userInvocable: false } },
      ],
    },
  ]
  const merged = mergeAgentSkills(lists)
  const byName = new Map(merged.map((entry) => [entry.name, entry]))
  assert.deepEqual([...byName.keys()].sort(), ['alpha', 'beta', 'gamma'])
  assert.equal(byName.get('alpha').description, 'from user', 'user-agents (rank 500) beats bundled (600)')
  assert.deepEqual(byName.get('alpha').agents, ['standard', 'review'])
  assert.equal(byName.get('alpha').modelInvocable, false)
  assert.equal(byName.get('beta').agents.length, 1)
  assert.equal(byName.get('gamma').dir, null, 'flat .md skills have no directory')
  assert.equal(byName.get('beta').dir, join('fixture', 'agents', 'skills', 'beta'))
  for (const entry of merged) assert.equal(entry.writable, false)
})

test('mergeAgentSkills sorts by usage count then name', () => {
  const now = Date.now()
  const lists = [
    {
      id: 'standard',
      skills: ['delta', 'alpha', 'charlie', 'bravo'].map((name) => ({
        name,
        description: 'd',
        source: 'user-agents',
        provider: 'filesystem',
        path: join('fixture', 'agents', 'skills', name, 'SKILL.md'),
        invocation: { modelInvocable: true, userInvocable: true },
      })),
    },
  ]
  const usage = { alpha: 1, bravo: 5, charlie: 0, delta: 5 }
  const merged = mergeAgentSkills(lists, { usageOf: (name) => summarizeSkillUsage({ count: usage[name] }, now) })
  assert.deepEqual(merged.map((entry) => entry.name), ['bravo', 'delta', 'alpha', 'charlie'])
})

test('mergeAgentSkills tolerates junk input', () => {
  assert.deepEqual(mergeAgentSkills(undefined), [])
  assert.deepEqual(mergeAgentSkills([null, { id: 'x' }, { id: 'y', skills: [null, {}] }]), [])
})

// -------------------------------------------------------------------- paths

test('normalizePathKey and isInsidePath compare Windows paths safely', () => {
  assert.equal(normalizePathKey('C:\\Users\\a\\skills\\'), ['c:', 'users', 'a', 'skills'].join(sep))
  assert.equal(isInsidePath('C:\\Users\\a\\skills', 'C:\\Users\\a\\skills\\demo\\SKILL.md'), true)
  assert.equal(isInsidePath('C:\\Users\\a\\skills', 'C:\\Users\\a\\skills'), true)
  assert.equal(isInsidePath('C:\\Users\\a\\skills', 'C:\\Users\\a\\skills-extra\\x.md'), false, 'sibling prefix is not containment')
  assert.equal(isInsidePath('C:\\Users\\a\\skills', 'C:\\Users\\a\\SKILL.md'), false)
  assert.equal(isInsidePath('', 'C:\\x'), false)
})

test('isProtectedInstallPath blocks the installation and any .asar', () => {
  const roots = ['D:\\apps\\DeepSeek Harness']
  assert.equal(isProtectedInstallPath('D:\\apps\\DeepSeek Harness\\resources\\app.asar\\dsh\\skills\\x\\SKILL.md', roots), true)
  assert.equal(isProtectedInstallPath('D:\\apps\\DeepSeek Harness\\skills\\x\\SKILL.md', roots), true)
  assert.equal(isProtectedInstallPath('C:\\Users\\you\\.agents\\skills\\x\\SKILL.md', roots), false)
  assert.equal(isProtectedInstallPath('D:\\apps\\DeepSeek Harness2\\x\\SKILL.md', roots), false)
  assert.equal(isProtectedInstallPath('\\\\?\\D:\\x\\app.asar\\y.md', roots), true)
  assert.equal(isProtectedInstallPath('', roots), true)
})

test('skillDirectoryOf distinguishes bundled and flat skills', () => {
  assert.equal(skillDirectoryOf(join('fixture', 'agents', 'skills', 'demo', 'SKILL.md')), join('fixture', 'agents', 'skills', 'demo'))
  assert.equal(skillDirectoryOf(join('fixture', 'agents', 'skills', 'demo.md')), null)
  assert.equal(skillDirectoryOf(undefined), null)
})

test('sanitizeSkillRelativePath refuses escapes and absolute paths', () => {
  assert.equal(sanitizeSkillRelativePath('SKILL.md'), 'SKILL.md')
  assert.equal(sanitizeSkillRelativePath('scripts/run.sh'), 'scripts/run.sh')
  assert.equal(sanitizeSkillRelativePath('.\\scripts\\run.sh'), 'scripts/run.sh')
  assert.equal(sanitizeSkillRelativePath('../outside.md'), null)
  assert.equal(sanitizeSkillRelativePath('a/../../b.md'), null)
  assert.equal(sanitizeSkillRelativePath('/etc/passwd'), null)
  assert.equal(sanitizeSkillRelativePath('C:\\Windows\\x.md'), null)
  assert.equal(sanitizeSkillRelativePath('a//b.md'), null)
  assert.equal(sanitizeSkillRelativePath(''), null)
  assert.equal(sanitizeSkillRelativePath(undefined), null)
})

// ------------------------------------------------------------------- report

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
  console.log(`all ${passed} helper assertions passed`)
}
