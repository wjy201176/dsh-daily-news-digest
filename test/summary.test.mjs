import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyMerges, buildTopicPrompt, fallbackTopicDigest, parseTopicReply, STORY_BUDGET, STORY_BUDGET_MAX, storyBudget } from '../lib/summary.js'

const story = (id, title, sourceCount, extra = {}) => ({
  id,
  title,
  url: `https://a.com/${id}`,
  snippet: '',
  sources: Array.from({ length: sourceCount }, (_, index) => `story${id}-src${index}`),
  sourceCount,
  reads: 10,
  measured: false,
  links: Array.from({ length: sourceCount }, (_, index) => ({ url: `https://story${id}-${index}.com/`, title, source: `story${id}-src${index}`, reads: null })),
  ...extra,
})

test('buildTopicPrompt numbers the stories and states the ranking', () => {
  const { system, user } = buildTopicPrompt('AI News', [story(1, 'OpenAI ships GPT-6', 3)])
  assert.match(system, /ONE JSON object/)
  assert.match(user, /Topic: AI News/)
  assert.match(user, /\[1\] OpenAI ships GPT-6/)
  assert.match(user, /sources \(3\)/)
})

test('storyBudget follows Top above the floor and is capped', () => {
  // Below the floor, a prompt still describes the floor's worth.
  assert.equal(storyBudget(3), STORY_BUDGET)
  assert.equal(storyBudget(undefined), STORY_BUDGET)
  // Above it, the budget follows Top, so a digest of 30 stories describes 30.
  assert.equal(storyBudget(30), 30)
  assert.equal(storyBudget(45), 45)
  // A pathological Top cannot make an unbounded prompt.
  assert.equal(storyBudget(500), STORY_BUDGET_MAX)
  assert.equal(storyBudget(9999), STORY_BUDGET_MAX)
})

test('buildTopicPrompt describes every story within the budget', () => {
  const stories = Array.from({ length: 30 }, (_, index) => story(index + 1, `Story number ${index + 1} about chips`, 1))
  const { user } = buildTopicPrompt('AI News', stories, storyBudget(30))
  // The last story the user asked for must be described, not silently dropped.
  assert.match(user, /\[30\] Story number 30 about chips/)
  assert.equal((user.match(/^\[\d+\]/gm) ?? []).length, 30)
})

test('buildTopicPrompt honours a smaller budget', () => {
  const stories = Array.from({ length: 30 }, (_, index) => story(index + 1, `Story ${index + 1} about chips`, 1))
  const { user } = buildTopicPrompt('AI News', stories, 5)
  assert.equal((user.match(/^\[\d+\]/gm) ?? []).length, 5)
})

test('parseTopicReply reads the JSON, tolerating a fence and prose', () => {
  const reply = parseTopicReply('Here you go:\n```json\n{"brief":"Two things happened.","stories":[{"id":1,"line":"GPT-6 shipped."}],"merged":[{"keep":1,"drop":[2]}]}\n```')
  assert.equal(reply.parsed, true)
  assert.equal(reply.brief, 'Two things happened.')
  assert.equal(reply.lines.get(1), 'GPT-6 shipped.')
  assert.deepEqual(reply.merged, [{ keep: 1, drop: [2] }])
})

test('parseTopicReply keeps the text when the reply is not JSON', () => {
  const reply = parseTopicReply('I could not produce JSON today.')
  assert.equal(reply.parsed, false)
  assert.match(reply.brief, /could not produce JSON/)
  assert.equal(reply.lines.size, 0)
})

test('parseTopicReply ignores malformed entries', () => {
  const reply = parseTopicReply(JSON.stringify({ brief: 'x', stories: [{ id: 'a', line: 'y' }, { id: 2, line: '' }, null], merged: [{ keep: 1, drop: [1] }] }))
  assert.equal(reply.lines.size, 0)
  assert.deepEqual(reply.merged, [])
})

test('applyMerges folds a dropped story into the kept one', () => {
  const kept = story(1, 'OpenAI ships GPT-6', 3)
  const dropped = story(2, 'OpenAI GPT-6 launch details', 2)
  const merged = applyMerges([kept, dropped], [{ keep: 1, drop: [2] }])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].sourceCount, 5)
  assert.equal(merged[0].reads, 20)
})

test('applyMerges refuses to fold a wider story into a narrower one', () => {
  const narrow = story(1, 'a', 1)
  const wide = story(2, 'b', 4)
  const merged = applyMerges([narrow, wide], [{ keep: 1, drop: [2] }])
  assert.equal(merged.length, 2)
})

test('applyMerges re-sorts after absorbing sources', () => {
  const first = story(1, 'first', 3)
  const second = story(2, 'second', 2)
  const third = story(3, 'third', 2)
  const merged = applyMerges([first, second, third], [{ keep: 2, drop: [3] }])
  assert.equal(merged[0].id, 2)
  assert.equal(merged[0].sourceCount, 4)
})

test('fallbackTopicDigest renders the ranking with snippets', () => {
  const digest = fallbackTopicDigest('AI', [story(1, 'OpenAI ships GPT-6', 2, { snippet: 'The model is out.' })], 'no model')
  assert.equal(digest.summarized, false)
  assert.equal(digest.stories.length, 1)
  assert.equal(digest.stories[0].line, 'The model is out.')
  assert.equal(digest.reason, 'no model')
})
