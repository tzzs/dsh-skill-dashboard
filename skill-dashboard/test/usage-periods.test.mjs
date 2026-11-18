import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyUsageEvent, foldDayBuckets, pruneDayBuckets, summarizeSkillUsage, summarizeUsage } from '../index.js'

// Local calendar arithmetic deliberately covers month and daylight-saving boundaries.
const now = new Date(2026, 10, 18, 12).getTime()
function daysAgo(offset) {
  const date = new Date(now)
  date.setDate(date.getDate() - offset)
  return date.getTime()
}
function day(offset) {
  const date = new Date(daysAgo(offset))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function total(buckets, length) {
  return buckets.slice(-length).reduce((sum, bucket) => sum + bucket.count, 0)
}
function usageFixture() {
  const store = { version: 1, skills: {}, recent: [] }
  // Six events older than retention still belong to the cumulative totals.
  for (let offset = 65; offset >= 0; offset -= 1) {
    applyUsageEvent(store, { name: 'present-skill', at: daysAgo(offset), agentId: 'default', channel: offset % 2 ? 'model' : 'user' })
  }
  // This skill need not appear in any current catalog: the usage store owns it.
  for (const offset of [60, 59, 0, 0]) {
    applyUsageEvent(store, { name: 'removed-skill', at: daysAgo(offset), agentId: 'old-agent', channel: offset ? 'user' : 'model' })
  }
  return store
}

test('60-day aggregate and skill histories support exact 1/7/14/30/60-day boundaries', () => {
  const state = usageFixture()
  const summary = summarizeUsage(state, now)
  assert.equal(summary.retentionDays, 60)
  assert.equal(summary.history.length, 60)
  assert.equal(summary.history[0].date, day(59))
  assert.equal(summary.history[59].date, day(0))
  const present = summary.skillUsage.find((record) => record.name === 'present-skill')
  const removed = summary.skillUsage.find((record) => record.name === 'removed-skill')
  assert.equal(present.dayBuckets.length, 60)
  assert.equal(removed.dayBuckets.length, 60)
  for (const length of [1, 7, 14, 30, 60]) {
    assert.equal(total(present.dayBuckets, length), length, `present skill ${length}-day total`)
    assert.equal(total(removed.dayBuckets, length), length === 60 ? 3 : 2, `removed skill ${length}-day total`)
    assert.equal(total(summary.history, length), length + 2 + (length === 60 ? 1 : 0), `aggregate ${length}-day total`)
    assert.equal(present.dayBuckets.slice(-length)[0].date, day(length - 1))
  }
  assert.deepEqual(summary.dayBuckets, summary.history.slice(-14), 'legacy aggregate remains the latest 14 days')
  assert.deepEqual(summarizeSkillUsage(state.skills['present-skill'], now).days, present.dayBuckets.slice(-14).map((bucket) => bucket.count))
})

test('cumulative totals and channel totals survive daily pruning and removed skills', () => {
  const state = usageFixture()
  const summary = summarizeUsage(state, now)
  assert.equal(summary.totalCount, 70)
  assert.equal(summary.activeSkills, 2)
  assert.equal(total(summary.history, 60), 63)
  assert.equal(summary.recent.length, 20)
  assert.deepEqual(summary.skillUsage.map((record) => [record.name, record.count, record.byModel, record.byUser]), [
    ['present-skill', 66, 33, 33], ['removed-skill', 4, 2, 2],
  ])
  for (const record of summary.skillUsage) {
    assert.equal(record.lastUsedAt, now)
    assert(!Object.hasOwn(record, 'modelDayBuckets'), 'daily per-channel history was never recorded')
    assert(record.dayBuckets.every((bucket) => Object.keys(bucket).sort().join(',') === 'count,date'))
  }
  assert(!Object.hasOwn(state.skills['present-skill'].days, day(60)))
  assert.equal(state.skills['present-skill'].count, 66)
})

test('pruning includes today through day 59 and drops day 60, future and malformed keys', () => {
  const days = { [day(0)]: 1, [day(6)]: 7, [day(13)]: 14, [day(29)]: 30,
    [day(59)]: 60, [day(60)]: 61, [day(-1)]: 9, nonsense: 5, [day(3)]: -1 }
  const retained = pruneDayBuckets(days, now)
  assert.deepEqual(Object.keys(retained).sort(), [day(0), day(6), day(13), day(29), day(59)].sort())
  const buckets = foldDayBuckets(retained, now, 60)
  assert.equal(total(buckets, 1), 1)
  assert.equal(total(buckets, 7), 8)
  assert.equal(total(buckets, 14), 22)
  assert.equal(total(buckets, 30), 52)
  assert.equal(total(buckets, 60), 112)
  assert.equal(days[day(60)], 61, 'pruning does not mutate the input')
})

test('empty or malformed records produce aligned zero histories without changing old fields', () => {
  const empty = summarizeUsage(undefined, now)
  assert.equal(empty.totalCount, 0)
  assert.equal(empty.activeSkills, 0)
  assert.equal(empty.dayBuckets.length, 14)
  assert.equal(empty.history.length, 60)
  assert.equal(total(empty.history, 60), 0)
  assert.deepEqual(empty.skillUsage, [])
  const state = { skills: { broken: null, zero: {}, historic: { count: 100, model: 80, user: 20, lastUsedAt: daysAgo(70), days: { [day(70)]: 100 } } } }
  const summary = summarizeUsage(state, now)
  assert.equal(summary.totalCount, 100)
  assert.equal(total(summary.history, 60), 0)
  assert.deepEqual(summary.skillUsage.map((record) => record.name), ['historic', 'zero'])
  assert.equal(summary.skillUsage[0].count, 100)
  assert.equal(summary.skillUsage[1].lastUsedAt, null)
})
