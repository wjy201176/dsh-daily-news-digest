import assert from 'node:assert/strict'
import { test } from 'node:test'

import { attribute, labelForHost, normalizeHost, openQueries, planForSource, plansForSources, queryFor, spokenDate } from '../lib/sources.js'

test('a domain row becomes a site plan', () => {
  const plan = planForSource('CNN.com')
  assert.equal(plan.kind, 'site')
  assert.deepEqual(plan.hosts, ['cnn.com'])
  assert.equal(plan.query, 'site:cnn.com')
})

test('an unknown TLD domain still resolves', () => {
  const plan = planForSource('top81.ws')
  assert.equal(plan.kind, 'site')
  assert.deepEqual(plan.hosts, ['top81.ws'])
})

test('a platform row searches its hosts', () => {
  const reddit = planForSource('reddit')
  assert.equal(reddit.kind, 'forum')
  assert.deepEqual(reddit.hosts, ['reddit.com'])

  const twitter = planForSource('Twitter')
  assert.deepEqual(twitter.hosts, ['x.com', 'twitter.com'])
})

test('a named publication resolves by title, case and spacing insensitive', () => {
  const qbitai = planForSource('QbitAI')
  assert.equal(qbitai.label, 'QbitAI')
  assert.deepEqual(qbitai.hosts, ['qbitai.com'])

  const bair = planForSource('The Berkeley Artificial Intelligence Research Blog')
  assert.equal(bair.label, 'BAIR Blog')
  assert.deepEqual(bair.hosts, ['bair.berkeley.edu'])
})

test('a data provider row is its own kind', () => {
  const openbb = planForSource('OpenBB')
  assert.equal(openbb.kind, 'data')
  assert.deepEqual(openbb.hosts, ['openbb.co', 'github.com/openbb-finance'])
})

test('an unknown named blog searches its name and matches by word', () => {
  const plan = planForSource('Some Indie Robotics Blog')
  assert.equal(plan.kind, 'named')
  assert.deepEqual(plan.hosts, [])
  assert.equal(plan.query, '"Some Indie Robotics Blog"')
  const matched = attribute('https://roboticsblog.example/post/1', 'A post', [plan])
  assert.equal(matched, plan)
})

test('empty rows are dropped and duplicates collapse', () => {
  const plans = plansForSources(['CNN.com', '', 'cnn.com', '  ', 'reddit'])
  assert.equal(plans.length, 2)
})

test('queryFor joins topic, news framing, the day and the source query', () => {
  const plan = planForSource('CNN.com')
  assert.equal(queryFor('AI News', plan, '2026-10-26'), 'AI News news October 26 2026 site:cnn.com')
  // Without a day it still asks for news, never a bare topic.
  assert.equal(queryFor('AI News', plan), 'AI News news site:cnn.com')
})

test('a bare topic is never sent as a query, because it returns definitions', () => {
  // The reported bug: "AI News news today" returned the Britannica entry and a
  // list of AI tool directories instead of the day's reporting.
  const plan = planForSource('CNN.com')
  const query = queryFor('AI News', plan, '2026-10-26')
  assert.notEqual(query, 'AI News site:cnn.com', 'the raw topic must not be the whole query')
  assert.match(query, /news/, 'the query must ask for news')
  assert.match(query, /October 26 2026/, 'the query must carry the day')
})

test('spokenDate renders a day the way a search engine reads it', () => {
  assert.equal(spokenDate('2026-10-26'), 'October 26 2026')
  assert.equal(spokenDate('2026-01-05'), 'January 5 2026')
  assert.equal(spokenDate(''), '', 'no day yields no phrase')
  assert.equal(spokenDate('nope'), '')
  assert.equal(spokenDate('2026-13-01'), '', 'an impossible month yields no phrase')
})

test('a category topic is searched through its named organisations', () => {
  // "AI News" is a category: the day's biggest story ("Anthropic files for IPO")
  // never says "AI News". The entity sweep is what makes it findable.
  const queries = openQueries('AI News', '2026-10-26')
  assert.ok(queries.some((query) => query.includes('Anthropic')), 'the AI beat must include Anthropic')
  assert.ok(queries.some((query) => query.includes('OpenAI')))
  assert.ok(queries.some((query) => query.includes('Nvidia')))
  for (const query of queries) assert.match(query, /October 26 2026/, 'every open query carries the day')
})

test('a real beat is searched as itself, and also through its organisations', () => {
  const embodied = openQueries('Embodied AI', '2026-10-26')
  assert.ok(embodied.some((query) => query.startsWith('Embodied AI news')))
  assert.ok(embodied.some((query) => query.includes('Figure AI')))
  // The AI entity list must not leak into the robotics beat.
  assert.ok(!embodied.some((query) => query.includes('Anthropic')), 'beats stay separate')
})

test('an unknown topic still gets dated open queries without an entity sweep', () => {
  const queries = openQueries('Medieval Poetry', '2026-10-26')
  assert.equal(queries.length, 2, 'no beat means no entity queries')
  assert.ok(queries.every((query) => query.includes('Medieval Poetry')))
})

test('without a day the open queries still ask for news', () => {
  const queries = openQueries('AI News')
  assert.ok(queries.some((query) => query.includes('news')))
  assert.ok(!queries.some((query) => /October/.test(query)), 'no invented date')
})

test('guidance keywords are added to the queries, not substituted for the topic', () => {
  const guidance = { keywords: ['vLLM', 'llama.cpp'], excludes: [], note: 'only vLLM and llama.cpp' }
  const queries = openQueries('LLM Local Deployment', '2026-10-26', guidance)
  // The keyword-only query finds exactly what the user described.
  assert.ok(queries.some((query) => query.startsWith('vLLM llama.cpp')), 'the guidance gets its own query')
  // The anchored query keeps the result tied to the topic.
  assert.ok(queries.some((query) => query.startsWith('LLM Local Deployment vLLM llama.cpp')))
  // The plain topic queries survive, so guidance narrows rather than replaces.
  assert.ok(queries.some((query) => query === 'LLM Local Deployment news October 26 2026'))
})

test('guidance keywords reach the per-source query too', () => {
  const plan = planForSource('CNN.com')
  const guidance = { keywords: ['vLLM'], excludes: [], note: 'vLLM only' }
  const query = queryFor('LLM Local Deployment', plan, '2026-10-26', guidance)
  assert.match(query, /vLLM/)
  assert.match(query, /site:cnn\.com/)
})

test('no guidance leaves the queries exactly as they were', () => {
  const plain = openQueries('AI News', '2026-10-26')
  const nullGuidance = openQueries('AI News', '2026-10-26', null)
  const emptyGuidance = openQueries('AI News', '2026-10-26', { keywords: [], excludes: [], note: '' })
  assert.deepEqual(nullGuidance, plain)
  assert.deepEqual(emptyGuidance, plain)
})

test('guidance keywords are capped so a long list cannot flood the query', () => {
  const guidance = { keywords: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'], excludes: [], note: 'x' }
  const query = queryFor('Topic', planForSource('CNN.com'), '2026-10-26', guidance)
  assert.ok(!query.includes('e5'), 'only the first four keywords are used')
})

test('attribute prefers host matches, including subdomains', () => {
  const cnn = planForSource('CNN.com')
  const reddit = planForSource('reddit')
  assert.equal(attribute('https://edition.cnn.com/2026/01/01/story', 'x', [reddit, cnn]), cnn)
  assert.equal(attribute('https://www.reddit.com/r/ai/comments/1', 'x', [cnn, reddit]), reddit)
  assert.equal(attribute('https://example.com/a', 'x', [cnn, reddit]), null)
})

test('normalizeHost strips scheme, www, path and port', () => {
  assert.equal(normalizeHost('https://www.CNN.com:443/story?x=1'), 'cnn.com')
  assert.equal(normalizeHost('edition.cnn.com/path'), 'edition.cnn.com')
})

test('labelForHost keeps the registrable name readable', () => {
  assert.equal(labelForHost('top81.ws'), 'Top81')
  assert.equal(labelForHost('bair.berkeley.edu'), 'Berkeley')
  assert.equal(labelForHost('cnn.com'), 'CNN')
  assert.equal(labelForHost('bbc.co.uk'), 'BBC')
})
