/**
 * Tests for per-topic search skills.
 *
 * A skill turns the reader's guidance into an operational plan: which queries to
 * ask first, which to fall back on, which hosts and terms to reject outright, and
 * what criteria a reviewer should apply. The ordering matters as much as the
 * content, because the plan is spent in order under a query budget.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseGuidance } from '../lib/guidance.js'
import {
  MAX_FALLBACK_QUERIES,
  MAX_PLAN_QUERIES,
  applySkillFilters,
  avoidHostHit,
  buildReviewPrompt,
  buildSkill,
  matchesQuoted,
  parseReviewReply,
  reviewCriteria,
} from '../lib/skill.js'

const DAY = '2026-10-29'

test('a skill always plans at least the topic itself', () => {
  const skill = buildSkill('Geopolitics', '', { day: DAY })
  assert.equal(skill.topic, 'Geopolitics')
  assert.ok(skill.plan.length >= 2, 'a bare topic still gets a news and a roundup query')
  const queries = skill.plan.map((entry) => entry.query)
  assert.ok(queries.some((query) => /Geopolitics news/.test(query)))
  assert.ok(queries.some((query) => /top stories/.test(query)))
  assert.equal(skill.hasGuidance, false)
})

test('every planned query carries the day, and each records its angle', () => {
  const skill = buildSkill('AI News', 'OpenAI and Anthropic', { day: DAY })
  for (const entry of skill.plan) {
    if (entry.angle === 'preferred-host') continue
    assert.match(entry.query, /October 29 2026/, `no day in ${entry.query}`)
    assert.equal(typeof entry.angle, 'string')
  }
  // The angles are the reason the plan is readable in a log.
  const angles = new Set(skill.plan.map((entry) => entry.angle))
  assert.ok(angles.has('topic'))
  assert.ok(angles.has('subject'))
})

test('the reader\'s own subjects appear early in the plan', () => {
  const skill = buildSkill('LLM Local Deployment', 'vLLM and llama.cpp', { day: DAY })
  const index = skill.plan.findIndex((entry) => /vLLM/.test(entry.query))
  assert.ok(index >= 0, 'a named subject must be planned')
  // The subject queries come before the wide beat sweep.
  const firstBeat = skill.plan.findIndex((entry) => entry.angle === 'beat')
  if (firstBeat >= 0) assert.ok(index < firstBeat, 'subjects must be asked before the beat sweep')
})

test('a quoted phrase is planned first, because the reader wrote it down', () => {
  const skill = buildSkill('AI Research', 'track "mixture of experts" work', { day: DAY })
  assert.equal(skill.plan[0].angle, 'quoted')
  assert.match(skill.plan[0].query, /mixture of experts/)
  assert.equal(skill.quoted[0], 'mixture of experts')
})

test('a named source becomes a site query and a host veto', () => {
  const skill = buildSkill('AI News', 'prefer reuters.com, never pinterest.com', { day: DAY })
  assert.deepEqual(skill.preferHosts, ['reuters.com'])
  assert.deepEqual(skill.avoidHosts, ['pinterest.com'])
  assert.ok(skill.plan.some((entry) => entry.angle === 'preferred-host' && /site:reuters\.com/.test(entry.query)))
  // The host must not also be searched as a subject keyword.
  assert.ok(!skill.keywords.some((word) => /reuters|pinterest/.test(word)))
})

test('the plan is bounded, so a long guidance cannot flood the search budget', () => {
  const many = Array.from({ length: 40 }, (_, index) => `subject${index}`).join(', ')
  const skill = buildSkill('Topic', many, { day: DAY })
  assert.ok(skill.plan.length <= MAX_PLAN_QUERIES, `plan was ${skill.plan.length}`)
  assert.ok(skill.fallback.length <= MAX_FALLBACK_QUERIES, `fallback was ${skill.fallback.length}`)
})

test('the plan is deduplicated', () => {
  const skill = buildSkill('AI News', 'AI News, AI News, AI News', { day: DAY })
  const queries = skill.plan.map((entry) => entry.query.toLowerCase())
  assert.equal(new Set(queries).size, queries.length, 'a repeated query must appear once')
})

test('fallback queries are broader: undated, and never the whole plan', () => {
  const skill = buildSkill('AI News', 'OpenAI', { day: DAY })
  assert.ok(skill.fallback.length > 0)
  for (const query of skill.fallback) {
    assert.doesNotMatch(query, /October 29 2026/, 'a fallback must not repeat the brittle date')
  }
  assert.ok(skill.fallback.includes('AI News news'))
})

test('criteria restate the guidance in terms a reviewer can apply', () => {
  const skill = buildSkill('LLM Local Deployment', 'only vLLM, skip tutorials, never pinterest.com', { day: DAY })
  const text = skill.criteria.join('\n')
  assert.match(text, /LLM Local Deployment/)
  assert.match(text, /vLLM/)
  assert.match(text, /tutorials/)
  assert.match(text, /pinterest\.com/)
})

test('reviewCriteria tolerates a bare object and a skill', () => {
  const direct = reviewCriteria({ topic: 'X', keywords: ['a'], excludes: [], quoted: [], preferHosts: [], avoidHosts: [] })
  assert.ok(direct.length >= 2)
  const viaSkill = reviewCriteria({ topic: 'X', guidance: { keywords: ['a'], excludes: [], quoted: [], preferHosts: [], avoidHosts: [] } })
  assert.ok(viaSkill.length >= 2)
})

test('a quoted phrase matches case-insensitively in title or snippet', () => {
  const quoted = ['Mixture of Experts']
  assert.equal(matchesQuoted({ title: 'A mixture of experts routing trick' }, quoted), true)
  assert.equal(matchesQuoted({ title: 'Routing', snippet: 'uses MIXTURE OF EXPERTS' }, quoted), true)
  assert.equal(matchesQuoted({ title: 'Dense models only' }, quoted), false)
  assert.equal(matchesQuoted({ title: 'x' }, []), false)
})

test('a rejected host is matched exactly, not as a substring', () => {
  assert.equal(avoidHostHit({ url: 'https://pinterest.com/x' }, ['pinterest.com']), 'pinterest.com')
  assert.equal(avoidHostHit({ url: 'https://www.pinterest.com/x' }, ['pinterest.com']), 'pinterest.com')
  assert.equal(avoidHostHit({ url: 'https://blog.pinterest.com/x' }, ['pinterest.com']), 'pinterest.com')
  // A lookalike domain must not be caught.
  assert.equal(avoidHostHit({ url: 'https://notpinterest.com/x' }, ['pinterest.com']), '')
  assert.equal(avoidHostHit({ url: 'https://example.com/x' }, []), '')
  assert.equal(avoidHostHit({ url: 'not a url' }, ['pinterest.com']), '')
})

test('the deterministic filters drop rejected hosts and rejected terms', () => {
  const skill = buildSkill('AI News', 'skip tutorials, never pinterest.com', { day: DAY })
  const hits = [
    { title: 'OpenAI launches a model', url: 'https://example.com/a' },
    { title: 'A tutorial on prompting', url: 'https://example.com/b' },
    { title: 'OpenAI news', url: 'https://pinterest.com/c' },
  ]
  const result = applySkillFilters(hits, skill)
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0].title, 'OpenAI launches a model')
  assert.equal(result.dropped.length, 2)
  assert.match(result.dropped.map((hit) => hit.droppedBy).join(' '), /tutorials|pinterest\.com/)
})

test('the deterministic filters match a plural and a singular exclusion', () => {
  const skill = buildSkill('AI News', 'skip tutorial', { day: DAY })
  const result = applySkillFilters(
    [
      { title: 'A tutorial about models', url: 'https://example.com/a' },
      { title: 'Tutorials for beginners', url: 'https://example.com/b' },
      { title: 'OpenAI ships a model', url: 'https://example.com/c' },
    ],
    skill,
  )
  assert.equal(result.kept.length, 1)
  assert.equal(result.dropped.length, 2)
})

test('a CJK exclusion is a substring match', () => {
  const skill = buildSkill('AI 新闻', '不要教程', { day: DAY })
  const result = applySkillFilters(
    [
      { title: '【教程】vLLM 入门', url: 'https://example.com/a' },
      { title: 'vLLM 合并了新特性', url: 'https://example.com/b' },
    ],
    skill,
  )
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0].title, 'vLLM 合并了新特性')
})

test('a skill with no guidance filters nothing but still plans', () => {
  const skill = buildSkill('Geopolitics', '', { day: DAY })
  const hits = [{ title: 'anything at all', url: 'https://example.com/a' }]
  const result = applySkillFilters(hits, skill)
  assert.equal(result.kept.length, 1)
  assert.equal(result.dropped.length, 0)
})

test('the review prompt carries the guidance, the criteria and every candidate', () => {
  const skill = buildSkill('LLM Local Deployment', 'only vLLM. Skip tutorials.', { day: DAY })
  const { system, user } = buildReviewPrompt(skill, [
    { id: 1, title: 'vLLM ships a cache', publishedAt: '2026-10-29T01:00:00Z', snippet: 'detail' },
    { id: 2, title: 'A tutorial', publishedAt: '', snippet: '' },
  ])
  assert.match(system, /JSON/)
  assert.match(system, /may only remove|Never invent/i)
  assert.match(user, /only vLLM/)
  assert.match(user, /Criteria:/)
  assert.match(user, /\[1\] vLLM ships a cache/)
  assert.match(user, /\[2\] A tutorial/)
  assert.match(user, /published: unknown/, 'an undated candidate says so')
})

test('a review reply is read from an object, an array or a code fence', () => {
  assert.deepEqual([...parseReviewReply('{"drop":[{"id":1,"reason":"a tutorial"}]}', [1, 2])], [[1, 'a tutorial']])
  assert.deepEqual([...parseReviewReply('```json\n{"drop":[{"id":2,"reason":"off-topic"}]}\n```', [1, 2])], [[2, 'off-topic']])
  assert.deepEqual([...parseReviewReply('[{"id":1,"reason":"x"}]', [1, 2])], [[1, 'x']])
})

test('a review reply cannot remove a candidate it was not offered', () => {
  // A hallucinated or out-of-range id must not delete an unreviewed story.
  assert.equal(parseReviewReply('{"drop":[{"id":99,"reason":"made up"}]}', [1, 2]).size, 0)
  assert.equal(parseReviewReply('{"drop":[{"id":0}]}', [1, 2]).size, 0)
  assert.equal(parseReviewReply('{"drop":[{"id":"abc"}]}', [1, 2]).size, 0)
})

test('a malformed review reply means no drops, never a crash', () => {
  for (const reply of ['', 'not json', '{"drop": "nope"}', '{"drop": null}', '{"other": 1}', null, undefined]) {
    assert.equal(parseReviewReply(reply, [1, 2]).size, 0)
  }
})

test('reviewCriteria names every part of the guidance it was given', () => {
  const criteria = reviewCriteria({
    topic: 'T',
    keywords: ['alpha'],
    quoted: ['exact phrase'],
    excludes: ['tutorials'],
    preferHosts: ['reuters.com'],
    avoidHosts: ['pinterest.com'],
  })
  const text = criteria.join('\n')
  assert.match(text, /alpha/)
  assert.match(text, /exact phrase/)
  assert.match(text, /tutorials/)
  assert.match(text, /reuters\.com/)
  assert.match(text, /pinterest\.com/)
})

test('buildSkill does not throw on hostile input', () => {
  for (const guidance of [null, undefined, 42, {}, []]) {
    for (const topic of ['', 'X', null]) {
      const skill = buildSkill(topic, guidance, { day: DAY })
      assert.equal(typeof skill.topic, 'string')
      assert.ok(Array.isArray(skill.plan))
      assert.ok(Array.isArray(skill.fallback))
    }
  }
})

test('the parsed guidance and the skill agree on the hard sets', () => {
  const text = 'only vLLM, skip tutorials, never pinterest.com'
  const parsed = parseGuidance(text)
  const skill = buildSkill('Topic', text, { day: DAY })
  assert.deepEqual(skill.keywords, parsed.keywords)
  assert.deepEqual(skill.excludes, parsed.excludes)
  assert.deepEqual(skill.preferHosts, parsed.preferHosts)
  assert.deepEqual(skill.avoidHosts, parsed.avoidHosts)
})
