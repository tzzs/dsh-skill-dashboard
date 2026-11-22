/**
 * Pure-function assertions for the skill diagnosis of CONTRACT §8.
 *
 * Run with Node.js 20 or later:
 *   node --test test/diagnosis.test.mjs
 *
 * Nothing here touches the profile, the Host, the disk, or the network: the
 * clock is fixed and every store is a literal.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DIAGNOSIS_POLICY, diagnoseSkills, stampUsage, usageEpoch } from '../index.js'

// A fixed local clock, like `usage-periods.test.mjs`, so the day arithmetic is
// reproducible on any machine.
const now = new Date(2026, 10, 18, 12).getTime()
const DAY_MS = 86_400_000

/** An instant exactly `offset` days before `now`; exact milliseconds, so no DST drift. */
function ago(offset) {
  return now - offset * DAY_MS
}

/** One local day key `offset` days before `now`. */
function day(offset) {
  const date = new Date(ago(offset))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Local noon of the day `offset` days before `now`. */
function noonOf(offset) {
  const date = new Date(now)
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() - offset)
  return date.getTime()
}

/** One catalog entry: everything is open and writable unless a case says otherwise. */
function entry(name, overrides = {}) {
  return { name, modelInvocable: true, userInvocable: true, writable: true, ...overrides }
}

/** One hand-made usage store with a known horizon and per-name stamps. */
function store({ since = ago(120), stamps = {}, records = {} } = {}) {
  return { version: 1, since, catalog: { ...stamps }, skills: { ...records }, recent: [] }
}

/** One usage record with only the fields diagnosis reads. */
function record({ lastUsedAt = null, keptAt, count = 1, days } = {}) {
  const value = { count, sessions: [], lastUsedAt: lastUsedAt ?? 0, model: count, user: 0, days: days ?? {} }
  if (keptAt !== undefined) value.keptAt = keptAt
  return value
}

/** Freeze a fixture deeply so any mutation inside the callee throws. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Index diagnosis rows by name. */
function rowsOf(document) {
  return new Map(document.skills.map((row) => [row.name, row]))
}

// ------------------------------------------------------------------- policy

test('the policy is one frozen constant carrying the three day windows', () => {
  assert.deepEqual({ ...DIAGNOSIS_POLICY }, { activeDays: 14, staleDays: 30, watchDays: 3 })
  assert.equal(Object.isFrozen(DIAGNOSIS_POLICY), true)
  assert.deepEqual(Object.keys(DIAGNOSIS_POLICY), ['activeDays', 'staleDays', 'watchDays'])
})

// --------------------------------------------------------------- boundaries

test('idle days 13 and 14 stay active, 15 cools, 29 cools and 30 goes stale', () => {
  const skill = (name, idle) => entry(name)
  const catalog = [skill('idle-13'), skill('idle-14'), skill('idle-15'), skill('idle-29'), skill('idle-30')]
  const records = {}
  for (const [name, idle] of [['idle-13', 13], ['idle-14', 14], ['idle-15', 15], ['idle-29', 29], ['idle-30', 30]]) {
    records[name] = record({ lastUsedAt: ago(idle), count: idle })
  }
  const document = diagnoseSkills(catalog, store({ stamps: { 'idle-13': ago(120) }, records }), { now })
  const rows = rowsOf(document)
  assert.deepEqual(
    [rows.get('idle-13').verdict, rows.get('idle-13').bucket, rows.get('idle-13').idleDays],
    ['active', 'active', 13],
  )
  assert.deepEqual(
    [rows.get('idle-14').verdict, rows.get('idle-14').bucket, rows.get('idle-14').idleDays],
    ['active', 'active', 14],
  )
  assert.deepEqual(
    [rows.get('idle-15').verdict, rows.get('idle-15').bucket, rows.get('idle-15').idleDays],
    ['cooling', 'active', 15],
  )
  assert.deepEqual(
    [rows.get('idle-29').verdict, rows.get('idle-29').bucket, rows.get('idle-29').idleDays],
    ['cooling', 'active', 29],
  )
  assert.deepEqual(
    [rows.get('idle-30').verdict, rows.get('idle-30').bucket, rows.get('idle-30').idleDays],
    ['stale', 'cleanup', 30],
  )
  assert.equal(rows.get('idle-30').can.remove, true)
  assert.equal(rows.get('idle-30').can.disable, true)
  assert.equal(rows.get('idle-15').can.remove, false, 'cooling is never a cleanup candidate')
})

test('watched days 2 are still unknown and 3 make a never-called skill unused', () => {
  const catalog = [entry('watched-2'), entry('watched-3')]
  const usage = store({
    since: ago(2),
    stamps: { 'watched-2': ago(2), 'watched-3': ago(3) },
  })
  const rows = rowsOf(diagnoseSkills(catalog, usage, { now }))
  assert.deepEqual([rows.get('watched-2').verdict, rows.get('watched-2').bucket, rows.get('watched-2').watchedDays], ['unknown', 'unknown', 2])
  assert.deepEqual([rows.get('watched-3').verdict, rows.get('watched-3').bucket, rows.get('watched-3').watchedDays], ['unused', 'cleanup', 3])
  assert.equal(rows.get('watched-2').can.remove, false, 'a two-day window proves nothing')
  assert.equal(rows.get('watched-2').can.keep, true)
})

test('never-called and long-silent are different verdicts and different order', () => {
  const catalog = [entry('never-called'), entry('long-silent')]
  const usage = store({
    stamps: { 'never-called': ago(60), 'long-silent': ago(60) },
    records: { 'long-silent': record({ lastUsedAt: ago(45) }) },
  })
  const document = diagnoseSkills(catalog, usage, { now })
  const rows = rowsOf(document)
  assert.equal(rows.get('never-called').verdict, 'unused')
  assert.equal(rows.get('never-called').idleDays, null)
  assert.equal(rows.get('never-called').lastUsedAt, null)
  assert.equal(rows.get('long-silent').verdict, 'stale')
  assert.equal(rows.get('long-silent').idleDays, 45)
  assert.deepEqual(document.skills.map((row) => row.name), ['long-silent', 'never-called'], 'stale outranks unused in the queue')
})

test('a call after a keep voids it, and a keep on a never-called skill stands', () => {
  const catalog = [entry('kept-then-called'), entry('kept-never-called'), entry('kept-quiet')]
  const usage = store({
    stamps: { 'kept-then-called': ago(120), 'kept-never-called': ago(120), 'kept-quiet': ago(120) },
    records: {
      'kept-then-called': record({ lastUsedAt: ago(20), keptAt: ago(40), count: 3 }),
      'kept-never-called': record({ keptAt: ago(20) }),
      'kept-quiet': record({ lastUsedAt: ago(45), keptAt: ago(10), count: 2 }),
    },
  })
  const rows = rowsOf(diagnoseSkills(catalog, usage, { now }))
  assert.equal(rows.get('kept-then-called').verdict, 'cooling', 'a later call voids the keep without a writer')
  assert.equal(rows.get('kept-then-called').bucket, 'active')
  assert.equal(rows.get('kept-then-called').keptAt, ago(40), 'the raw decision is still reported')
  assert.equal(rows.get('kept-never-called').verdict, 'kept')
  assert.equal(rows.get('kept-never-called').bucket, 'kept')
  assert.equal(rows.get('kept-never-called').can.keep, true)
  assert.equal(rows.get('kept-quiet').verdict, 'kept', 'a keep at or after the last call holds')
  assert.equal(rows.get('kept-quiet').can.remove, false, 'kept rows are not cleanup candidates')
})

test('a closed cleanup candidate escalates to dormant and loses can.disable', () => {
  const catalog = [
    entry('closed-stale', { modelInvocable: false, userInvocable: false }),
    entry('closed-unused', { modelInvocable: false, userInvocable: false }),
    entry('open-stale'),
  ]
  const usage = store({
    stamps: { 'closed-stale': ago(120), 'closed-unused': ago(120), 'open-stale': ago(120) },
    records: { 'closed-stale': record({ lastUsedAt: ago(45) }), 'open-stale': record({ lastUsedAt: ago(45) }) },
  })
  const document = diagnoseSkills(catalog, usage, { now })
  const rows = rowsOf(document)
  assert.deepEqual([rows.get('closed-stale').verdict, rows.get('closed-stale').bucket, rows.get('closed-stale').closed], ['stale', 'dormant', true])
  assert.equal(rows.get('closed-stale').can.disable, false, 'it is off both paths already')
  assert.equal(rows.get('closed-stale').can.remove, true)
  assert.equal(rows.get('closed-unused').bucket, 'dormant')
  assert.equal(rows.get('open-stale').bucket, 'cleanup')
  assert.deepEqual(document.skills.map((row) => row.bucket).slice(0, 1), ['cleanup'], 'cleanup sorts before dormant')
})

test('a read-only candidate can be kept but never removed', () => {
  const catalog = [entry('read-only-stale', { writable: false }), entry('read-only-active', { writable: false })]
  const usage = store({
    stamps: { 'read-only-stale': ago(120), 'read-only-active': ago(120) },
    records: { 'read-only-stale': record({ lastUsedAt: ago(45) }), 'read-only-active': record({ lastUsedAt: ago(1) }) },
  })
  const rows = rowsOf(diagnoseSkills(catalog, usage, { now }))
  assert.equal(rows.get('read-only-stale').bucket, 'cleanup')
  assert.equal(rows.get('read-only-stale').writable, false)
  assert.equal(rows.get('read-only-stale').can.remove, false)
  assert.equal(rows.get('read-only-stale').can.disable, false)
  assert.equal(rows.get('read-only-stale').can.keep, true, '保留 is the only action left')
  assert.equal(rows.get('read-only-active').can.keep, false)
})

test('counts partition the catalog and every row carries the wire shape', () => {
  const catalog = [
    entry('a-active'),
    entry('b-cooling'),
    entry('c-stale'),
    entry('d-unused'),
    entry('e-kept'),
    entry('f-unknown'),
    entry('g-dormant', { modelInvocable: false, userInvocable: false }),
    entry('h-readonly', { writable: false }),
  ]
  const usage = store({
    since: ago(60),
    stamps: {
      'a-active': ago(60), 'b-cooling': ago(60), 'c-stale': ago(60), 'd-unused': ago(60),
      'e-kept': ago(60), 'f-unknown': ago(2), 'g-dormant': ago(60), 'h-readonly': ago(60),
    },
    records: {
      'a-active': record({ lastUsedAt: ago(1) }),
      'b-cooling': record({ lastUsedAt: ago(20) }),
      'c-stale': record({ lastUsedAt: ago(45) }),
      'e-kept': record({ lastUsedAt: ago(50), keptAt: ago(1) }),
      'g-dormant': record({ lastUsedAt: ago(45) }),
      'h-readonly': record({ lastUsedAt: ago(45) }),
    },
  })
  const document = diagnoseSkills(catalog, usage, { now })
  assert.deepEqual(Object.keys(document), ['evaluatedAt', 'since', 'observedDays', 'thresholds', 'counts', 'skills'])
  assert.deepEqual(Object.keys(document.counts), ['active', 'cleanup', 'dormant', 'kept', 'unknown', 'total'])
  assert.equal(document.skills.length, catalog.length)
  assert.equal(document.counts.total, catalog.length)
  const bucketed = document.counts.active + document.counts.cleanup + document.counts.dormant + document.counts.kept + document.counts.unknown
  assert.equal(bucketed, document.counts.total, 'the five buckets partition the catalog')
  assert.deepEqual(
    [document.counts.active, document.counts.cleanup, document.counts.dormant, document.counts.kept, document.counts.unknown],
    [2, 3, 1, 1, 1],
  )
  assert.equal(document.evaluatedAt, now)
  assert.equal(document.since, ago(60))
  assert.equal(document.observedDays, 60)
  assert.deepEqual(document.thresholds, { activeDays: 14, staleDays: 30, watchDays: 3 })
  const rowKeys = ['bucket', 'can', 'closed', 'idleDays', 'keptAt', 'lastUsedAt', 'name', 'useCount', 'verdict', 'watchedDays', 'writable']
  for (const row of document.skills) {
    assert.deepEqual(Object.keys(row).sort(), rowKeys, `${row.name} has exactly the wire keys`)
    assert.deepEqual(Object.keys(row.can), ['disable', 'remove', 'keep'])
    assert.equal(row.idleDays === null, row.lastUsedAt === null, `${row.name}: idleDays is null exactly when lastUsedAt is`)
  }
  assert.deepEqual(
    document.skills.map((row) => row.name),
    ['c-stale', 'h-readonly', 'd-unused', 'g-dormant', 'f-unknown', 'e-kept', 'a-active', 'b-cooling'],
  )
})

test('active rows sort most recent first and ties fall back to the name', () => {
  const catalog = [entry('b-one'), entry('a-one'), entry('z-one')]
  const usage = store({
    stamps: { 'b-one': ago(120), 'a-one': ago(120), 'z-one': ago(120) },
    records: {
      'b-one': record({ lastUsedAt: ago(1) }),
      'a-one': record({ lastUsedAt: ago(1) }),
      'z-one': record({ lastUsedAt: ago(3) }),
    },
  })
  const document = diagnoseSkills(catalog, usage, { now })
  assert.deepEqual(document.skills.map((row) => row.name), ['a-one', 'b-one', 'z-one'], 'idle 1 beats idle 3, then the name decides')
})

// -------------------------------------------------------------- immutability

test('diagnoseSkills does not mutate its inputs and is deterministic', () => {
  const catalog = deepFreeze([
    entry('one'),
    entry('two', { modelInvocable: false, userInvocable: false, writable: false }),
  ])
  const usage = deepFreeze(store({
    since: ago(40),
    stamps: { one: ago(40), two: ago(40) },
    records: { one: record({ lastUsedAt: ago(1), keptAt: ago(1) }) },
  }))
  const before = JSON.stringify({ catalog, usage })
  const first = diagnoseSkills(catalog, usage, { now, since: usage.since })
  const second = diagnoseSkills(catalog, usage, { now, since: usage.since })
  assert.equal(JSON.stringify({ catalog, usage }), before)
  assert.deepEqual(first, second)
  assert.equal(first.since, ago(40))
})

test('diagnoseSkills tolerates an absent, corrupt, or duplicated input', () => {
  const empty = diagnoseSkills(undefined, undefined, { now })
  assert.deepEqual(empty.counts, { active: 0, cleanup: 0, dormant: 0, kept: 0, unknown: 0, total: 0 })
  assert.deepEqual(empty.skills, [])
  assert.equal(empty.since, now)
  assert.equal(empty.observedDays, 0)

  const catalog = [{ name: '' }, null, entry('ghost'), entry('ghost'), entry('junk')]
  const usage = {
    version: 1,
    since: 'yesterday',
    catalog: { ghost: ago(10), junk: ago(10) },
    skills: { ghost: null, junk: { count: 'many', lastUsedAt: 'never', keptAt: -5, days: 3 } },
    recent: 'no',
  }
  const document = diagnoseSkills(catalog, usage, { now })
  assert.deepEqual(document.skills.map((row) => row.name), ['ghost', 'junk'], 'each name appears exactly once')
  const rows = rowsOf(document)
  assert.equal(rows.get('ghost').verdict, 'unused')
  assert.equal(rows.get('ghost').useCount, 0)
  assert.equal(rows.get('junk').useCount, 0)
  assert.equal(rows.get('junk').keptAt, null)
  assert.equal(rows.get('junk').lastUsedAt, null)
})

// -------------------------------------------------------------------- epoch

test('usageEpoch derives the horizon from legacy records and never runs into the future', () => {
  assert.equal(usageEpoch(undefined, now), now)
  assert.equal(usageEpoch({ version: 1, since: 0, skills: {} }, now), now)
  assert.equal(usageEpoch({ version: 1, since: ago(11), skills: {} }, now), ago(11))
  assert.equal(
    usageEpoch({ skills: { alpha: { lastUsedAt: ago(50) } } }, now),
    ago(50),
    'the oldest call timestamp is the latest provable start',
  )
  assert.equal(
    usageEpoch({ skills: { alpha: { days: { [day(30)]: 2 } } } }, now),
    noonOf(30),
    'a surviving day key is read at local noon',
  )
  assert.equal(
    usageEpoch({ skills: { alpha: { lastUsedAt: ago(4), days: { [day(30)]: 1 } }, beta: { lastUsedAt: ago(50) } } }, now),
    ago(50),
    'the oldest provable instant wins',
  )
  assert.equal(usageEpoch({ since: now + DAY_MS, skills: { alpha: { lastUsedAt: ago(5) } } }, now), ago(5), 'a future since is not trusted')
  assert.equal(usageEpoch({ since: -1, skills: {} }, now), now)
  assert.equal(usageEpoch({ skills: { alpha: { days: { [day(-2)]: 4, nonsense: 2, [day(3)]: 0 } } } }, now), now, 'future keys and zero counts prove nothing')
  const frozen = deepFreeze({ since: 0, skills: { alpha: { lastUsedAt: ago(9), days: { [day(9)]: 1 } } } })
  const snapshot = JSON.stringify(frozen)
  assert.equal(usageEpoch(frozen, now), ago(9))
  assert.equal(JSON.stringify(frozen), snapshot, 'the epoch derivation never mutates the store')
})

// ------------------------------------------------------------------ stamping

test('stampUsage fills the horizon and each unseen name exactly once', () => {
  const usage = { version: 1, since: 0, catalog: {}, skills: { legacy: { lastUsedAt: ago(50) } }, recent: [] }
  const catalog = [entry('alpha'), entry('beta'), entry('gamma')]
  const presence = new Map([['alpha', ago(10)]])
  assert.equal(stampUsage(usage, catalog, presence, now), true)
  assert.equal(usage.since, ago(50), 'a legacy call dates the store')
  assert.deepEqual(usage.catalog, { alpha: ago(10), beta: now, gamma: now }, 'a known creation time beats now')

  const stamps = { ...usage.catalog }
  assert.equal(stampUsage(usage, catalog, new Map([['beta', ago(40)]]), now), false, 'nothing to fill, nothing to flush')
  assert.deepEqual(usage.catalog, stamps, 'an existing stamp is never rewritten')
  assert.equal(usage.since, ago(50))

  const fresh = { version: 1, since: 0, catalog: {}, skills: {}, recent: [] }
  assert.equal(stampUsage(fresh, ['solo'], new Map([['solo', ago(30)]]), now), true)
  assert.equal(fresh.since, now, 'an empty store can only prove the moment it was stamped')
  assert.equal(fresh.catalog.solo, now, 'even an old creation time is clamped to the new horizon')
})

test('stampUsage clamps into the observation window and tolerates junk', () => {
  const usage = { version: 1, skills: { alpha: { lastUsedAt: ago(30), days: { [day(30)]: 1 } } } }
  const catalog = ['alpha', 'beta', '', null, { name: 'gamma' }, { name: 'delta' }]
  const presence = { alpha: ago(5), gamma: ago(400), delta: now + 10 * DAY_MS }
  assert.equal(stampUsage(usage, catalog, presence, now), true)
  assert.equal(usage.since, Math.min(ago(30), noonOf(30)), 'a legacy store dates itself from its surviving evidence')
  assert.equal(usage.catalog.alpha, ago(5), 'alpha is stamped from its creation time')
  assert.equal(usage.catalog.gamma, usage.since, 'a creation time older than the horizon is clamped up')
  assert.equal(usage.catalog.delta, now, 'a future creation time is clamped down')
  assert.equal(stampUsage(null, catalog, presence, now), false)
  assert.equal(stampUsage({ version: 1 }, [], undefined, now), true, 'a store without a catalog object gains one')
  assert.equal(stampUsage({ version: 1, since: 0, catalog: [], skills: {} }, [], undefined, now), true, 'a corrupt catalog is replaced by a record')

  const fractional = { version: 1, since: ago(30), catalog: {}, skills: {}, recent: [] }
  assert.equal(stampUsage(fractional, ['ntfs'], new Map([['ntfs', ago(5) + 0.1328]]), now), true)
  assert.equal(Number.isInteger(fractional.catalog.ntfs), true, 'a fractional birth time is stored as whole milliseconds')
})
