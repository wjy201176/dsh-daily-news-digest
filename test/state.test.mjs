import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cleanList, cleanTopics, clampTop, normalizeState, emptyState, digestPatch, historySummary, removeFromHistory, DIGEST_HISTORY, MAX_ROWS } from '../lib/state.js'

test('cleanList trims, drops empties, dedupes case-insensitively and keeps order', () => {
  assert.deepEqual(cleanList([' AI News ', '', 'ai news', '具身智能', '  ']), ['AI News', '具身智能'])
})

test('cleanList ignores non-arrays and caps the length', () => {
  assert.deepEqual(cleanList(null), [])
  assert.deepEqual(cleanList(undefined), [])
  const long = Array.from({ length: MAX_ROWS + 10 }, (_, index) => `topic ${index}`)
  assert.equal(cleanList(long).length, MAX_ROWS)
})

test('clampTop bounds and defaults', () => {
  assert.equal(clampTop(undefined), 10)
  assert.equal(clampTop('7'), 7)
  assert.equal(clampTop(0), 1)
  assert.equal(clampTop(999), 50)
  assert.equal(clampTop('abc'), 10)
  assert.equal(clampTop(3.9), 3)
})

test('normalizeState fills every field from a partial file', () => {
  const state = normalizeState({ topics: ['AI'], top: 5 })
  assert.deepEqual(state.topics, [{ topic: 'AI', guidance: '' }])
  assert.deepEqual(state.sources, [])
  assert.equal(state.top, 5)
  assert.equal(state.digest, null)
  assert.deepEqual(state.history, [])
})

test('normalizeState reads a legacy string topic list as topics without guidance', () => {
  // The file on disk predates per-topic guidance. It must open, not be discarded.
  const state = normalizeState({ topics: ['AI News', 'Embodied AI'], sources: ['CNN.com'] })
  assert.deepEqual(state.topics, [
    { topic: 'AI News', guidance: '' },
    { topic: 'Embodied AI', guidance: '' },
  ])
  assert.deepEqual(state.sources, ['CNN.com'])
})

test('normalizeState keeps guidance and drops it only for an empty topic name', () => {
  const state = normalizeState({
    topics: [
      { topic: 'LLM Local Deployment', guidance: 'only vLLM\nskip tutorials' },
      { topic: '', guidance: 'orphaned guidance' },
      { topic: 'AI News' },
    ],
  })
  assert.deepEqual(state.topics, [
    { topic: 'LLM Local Deployment', guidance: 'only vLLM\nskip tutorials' },
    { topic: 'AI News', guidance: '' },
  ])
})

test('cleanTopics de-duplicates by name, keeping the first guidance', () => {
  const topics = cleanTopics([
    { topic: 'AI News', guidance: 'first' },
    { topic: 'ai news', guidance: 'second' },
    { topic: 'Embodied AI', guidance: '' },
  ])
  assert.equal(topics.length, 2)
  assert.equal(topics[0].guidance, 'first')
})

test('cleanTopics caps guidance length', () => {
  const long = 'x'.repeat(5000)
  const topics = cleanTopics([{ topic: 'AI News', guidance: long }])
  assert.ok(topics[0].guidance.length <= 600, 'guidance must be bounded')
  assert.ok(topics[0].guidance.length > 0)
})

test('cleanTopics collapses runaway blank lines but keeps paragraph breaks', () => {
  const topics = cleanTopics([{ topic: 'AI News', guidance: 'one\n\n\n\ntwo' }])
  assert.equal(topics[0].guidance, 'one\n\ntwo')
})

test('normalizeState survives garbage', () => {
  assert.deepEqual(normalizeState(null), emptyState())
  assert.deepEqual(normalizeState('nope'), emptyState())
  assert.deepEqual(normalizeState({ topics: 'not a list' }).topics, [])
})

test('digestPatch keeps the newest digests first and bounded', () => {
  let state = emptyState()
  for (let index = 0; index < DIGEST_HISTORY + 8; index += 1) {
    state = { ...state, ...digestPatch(state, { id: `d${index}` }) }
  }
  assert.equal(state.history.length, DIGEST_HISTORY)
  assert.equal(state.history[0].id, `d${DIGEST_HISTORY + 7}`)
  assert.equal(state.digest.id, `d${DIGEST_HISTORY + 7}`)
})

test('historySummary reduces a digest to a timeline row', () => {
  const summary = historySummary({
    id: 'digest-1',
    createdAt: '2026-10-26T10:00:00.000Z',
    day: '2026-10-26',
    top: 10,
    model: 'p/m',
    durationMs: 1234,
    topics: [
      { topic: 'AI News', stories: [{ id: 1 }, { id: 2 }] },
      { topic: '具身智能', stories: [{ id: 3 }] },
    ],
  })
  assert.equal(summary.id, 'digest-1')
  assert.equal(summary.topicCount, 2)
  assert.equal(summary.storyCount, 3)
  assert.deepEqual(summary.topics, ['AI News', '具身智能'])
  assert.equal(summary.top, 10)
  assert.equal(summary.day, '2026-10-26')
})

test('historySummary survives a malformed entry', () => {
  const summary = historySummary({ id: 42 })
  assert.equal(summary.id, '42')
  assert.deepEqual(summary.topics, [])
  assert.equal(summary.topicCount, 0)
  assert.equal(summary.storyCount, 0)
})

test('removeFromHistory drops one entry and leaves the rest in order', () => {
  const state = {
    ...emptyState(),
    history: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    digest: { id: 'b' },
  }
  const patch = removeFromHistory(state, 'b')
  assert.equal(patch.removed, true)
  assert.deepEqual(patch.history.map((entry) => entry.id), ['a', 'c'])
  // Deleting the digest that is currently displayed clears it too.
  assert.equal(patch.digest, null)
})

test('removeFromHistory keeps a different current digest', () => {
  const state = { ...emptyState(), history: [{ id: 'a' }, { id: 'b' }], digest: { id: 'a' } }
  const patch = removeFromHistory(state, 'b')
  assert.equal(patch.removed, true)
  assert.deepEqual(patch.digest, { id: 'a' })
})

test('removeFromHistory reports an unknown id as not removed', () => {
  const state = { ...emptyState(), history: [{ id: 'a' }], digest: { id: 'a' } }
  const patch = removeFromHistory(state, 'zzz')
  assert.equal(patch.removed, false)
  assert.equal(patch.history.length, 1)
  assert.deepEqual(patch.digest, { id: 'a' })
})
