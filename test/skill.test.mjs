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
  closedModelOnly,
  matchesQuoted,
  parseReviewReply,
  requiresOpenSource,
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

test('a specific topic is not swept through its category organizations', () => {
  // The reported bug: "LLM Local Deployment" planned "OpenAI Anthropic" queries,
  // which returned general AI news. The sweep exists for a category, which has no
  // reporting under its own name; a specific topic does.
  const specific = buildSkill('LLM Local Deployment', '', { day: DAY })
  assert.equal(specific.isCategory, false)
  assert.deepEqual(specific.qualifiers, ['local', 'deployment'])
  assert.ok(
    !specific.plan.some((entry) => entry.angle === 'beat'),
    `a specific topic must not plan a beat sweep; got ${JSON.stringify(specific.plan.map((entry) => entry.query))}`,
  )

  const category = buildSkill('Geopolitics', '', { day: DAY })
  assert.equal(category.isCategory, true)
  assert.ok(category.plan.some((entry) => entry.angle === 'beat'), 'a category still sweeps its organizations')
})

test('a category topic is still swept when it has only category words', () => {
  // All four are categories, so none is gated by qualifiers. Whether the sweep
  // actually produces queries depends on the beat catalogue: "Science and
  // Technology" maps to no beat, so it plans no entities — correct, not a
  // regression.
  for (const topic of ['AI News', 'Global Economics', 'Science and Technology', 'Geopolitics']) {
    const skill = buildSkill(topic, '', { day: DAY })
    assert.equal(skill.isCategory, true, `${topic} must be treated as a category`)
    assert.deepEqual(skill.qualifiers, [], `${topic} has no qualifying words`)
  }
  for (const topic of ['AI News', 'Global Economics', 'Geopolitics']) {
    const skill = buildSkill(topic, '', { day: DAY })
    assert.ok(skill.plan.some((entry) => entry.angle === 'beat'), `${topic} must sweep its organizations`)
  }
})

// ---------------------------------------------------------------------------
// The open-source rule: a deployment topic can only concern a model whose weights
// you can obtain.
// ---------------------------------------------------------------------------

test('a deployment topic requires an open model, and others do not', () => {
  assert.equal(requiresOpenSource(['local', 'deployment']), true)
  assert.equal(requiresOpenSource(['deployment']), true)
  assert.equal(requiresOpenSource(['self-host']), true)
  assert.equal(requiresOpenSource(['embodied']), false, 'a robotics topic is not a deployment topic')
  assert.equal(requiresOpenSource([]), false, 'a category has no rule to derive')

  assert.equal(buildSkill('LLM Local Deployment', '', { day: DAY }).openSourceOnly, true)
  assert.equal(buildSkill('AI News', '', { day: DAY }).openSourceOnly, false)
  assert.equal(buildSkill('Geopolitics', '', { day: DAY }).openSourceOnly, false)
})

test('the open-source rule appears in the criteria the reviewer applies', () => {
  const skill = buildSkill('LLM Local Deployment', '', { day: DAY })
  const text = skill.criteria.join('\n')
  assert.match(text, /open-source/i, 'the rule must reach the model')
  assert.match(text, /closed model/i)
  // A category must not inherit a rule it has no basis for.
  const news = buildSkill('AI News', '', { day: DAY })
  assert.doesNotMatch(news.criteria.join('\n'), /open-source/i)
})

test('a story about a closed model alone is out of scope for a deployment topic', () => {
  const closed = [
    'Gemini 4 Carbon can now run locally on your laptop',
    'Claude Opus 5.5 review: the best assistant yet',
    'GPT-6.1 Terra cuts API prices, but the weights stay private',
  ]
  for (const title of closed) {
    assert.equal(closedModelOnly({ title }).closedOnly, true, `must read as closed: ${title}`)
  }
})

test('owning an open model, runtime or licence rescues a story that names a closed one', () => {
  const open = [
    'Qwen3.8-27B can be deployed locally on a single RTX 4090',
    'OpenAI releases an open-weight model under Apache 2.0',
    'Ollama adds support for a new quantized runtime',
    'Self-hosting a 27B model on a Mac Mini',
    'Running DeepSeek-V4.1-Flash locally with vLLM',
  ]
  for (const title of open) {
    assert.equal(closedModelOnly({ title }).closedOnly, false, `must read as open: ${title}`)
  }
})

test('deployment language alone does not make a closed model deployable', () => {
  // "runs locally" says where a closed model executes, not that its weights exist.
  // Counting it as open evidence was the first draft of this rule and it let the
  // exact story the reader objected to straight through.
  assert.equal(closedModelOnly({ title: 'Gemini can now run locally on a laptop' }).closedOnly, true)
  assert.equal(closedModelOnly({ title: 'Self-hosted deployment of Claude is still impossible' }).closedOnly, true)
})

test('the open-source filter drops closed-model stories and keeps open ones', () => {
  const skill = buildSkill('LLM Local Deployment', '', { day: DAY })
  const hits = [
    { title: 'Gemini 4 Carbon can now run locally on your laptop', url: 'https://example.com/1' },
    { title: 'Qwen3.8-27B can be deployed locally on a single RTX 4090', url: 'https://example.com/2' },
    { title: 'Ollama adds support for a new quantized runtime', url: 'https://example.com/3' },
  ]
  const result = applySkillFilters(hits, skill)
  assert.equal(result.kept.length, 2)
  assert.ok(!result.kept.some((hit) => /Gemini/.test(hit.title)))
  assert.ok(result.dropped.some((hit) => /closed model/.test(hit.droppedBy)))
})

test('the open-source filter is off for a topic that has no such rule', () => {
  const skill = buildSkill('AI News', '', { day: DAY })
  const hits = [{ title: 'Gemini 4 Carbon can now run locally on your laptop', url: 'https://example.com/1' }]
  const result = applySkillFilters(hits, skill)
  assert.equal(result.kept.length, 1, 'AI News has no reason to reject a closed model')
})
