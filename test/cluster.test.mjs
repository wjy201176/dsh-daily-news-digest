import assert from 'node:assert/strict'
import { test } from 'node:test'

import { groupStories, linkQuality, orderHits, overlap, rankTopic, readsOf, tokenize, urlKey, usableTitle } from '../lib/cluster.js'
import { isArticleUrl } from '../lib/recency.js'

const hit = (url, title, planId, extra = {}) => ({
  url,
  title,
  snippet: '',
  planId,
  planLabel: planId,
  reach: 1,
  position: 0,
  engagement: null,
  // Derive this the way the digest does, so a test that passes a section URL
  // exercises the real judgement instead of a default.
  isArticle: isArticleUrl(url),
  freshness: { date: null, dated: false, sameDay: false, ageDays: null, from: 'none' },
  ...extra,
})

test('tokenize drops stopwords and short words', () => {
  const tokens = tokenize('OpenAI releases the new GPT-6 model')
  assert.ok(tokens.has('openai'))
  assert.ok(tokens.has('releases'))
  assert.ok(tokens.has('gpt-6'))
  assert.ok(!tokens.has('the'))
  assert.ok(!tokens.has('new'))
})

test('tokenize splits CJK into bigrams', () => {
  const tokens = tokenize('具身智能')
  assert.ok(tokens.has('具身'))
  assert.ok(tokens.has('身智'))
  assert.ok(tokens.has('智能'))
})

test('overlap is relative to the smaller set', () => {
  const left = tokenize('OpenAI releases GPT-6')
  const right = tokenize('OpenAI releases GPT-6 with new safety card')
  assert.ok(overlap(left, right) > 0.5)
  assert.equal(overlap(new Set(), right), 0)
})

test('same event under different headlines groups', () => {
  const stories = groupStories([
    hit('https://a.com/1', 'OpenAI releases GPT-6 with 1M context window', 'outlet:a.com'),
    hit('https://b.com/2', 'OpenAI releases GPT-6 with 1M context window, company says', 'outlet:b.com'),
  ])
  assert.equal(stories.length, 1)
  assert.equal(stories[0].planIds.length, 2)
})

test('different events do not group', () => {
  const stories = groupStories([
    hit('https://a.com/1', 'OpenAI releases GPT-6 with 1M context window', 'outlet:a.com'),
    hit('https://b.com/2', 'Nvidia earnings beat expectations for the quarter', 'outlet:b.com'),
  ])
  assert.equal(stories.length, 2)
})

test('the same URL never counts as two sources', () => {
  const stories = groupStories([
    hit('https://a.com/1?utm_source=x', 'OpenAI releases GPT-6', 'outlet:a.com'),
    hit('https://a.com/1', 'OpenAI releases GPT-6', 'outlet:a.com'),
  ])
  assert.equal(stories.length, 1)
  assert.equal(stories[0].planIds.length, 1)
})

test('urlKey drops tracking parameters', () => {
  assert.equal(urlKey('https://www.a.com/x/?utm_source=news&id=3#top'), 'a.com/x?id=3')
})

test('readsOf sums measured counts and falls back to an estimate', () => {
  const measured = readsOf([
    hit('https://a.com/1', 't', 'a', { engagement: { reads: 120, basis: 'upvotes' } }),
    hit('https://b.com/2', 't', 'b', { engagement: { reads: 30, basis: 'points' } }),
  ])
  assert.equal(measured.reads, 150)
  assert.equal(measured.measured, true)
  assert.equal(measured.signals.length, 2)

  const estimated = readsOf([hit('https://c.com/3', 't', 'c', { position: 0 })])
  assert.ok(estimated.reads > 0)
  assert.equal(estimated.measured, false)
})

test('orderHits prefers the measured, then the earlier position', () => {
  const ordered = orderHits([
    hit('https://a.com/1', 't', 'a', { position: 5 }),
    hit('https://b.com/2', 't', 'b', { engagement: { reads: 900 }, position: 9 }),
  ])
  assert.equal(ordered[0].url, 'https://b.com/2')
})

test('rankTopic ranks by source count first, then reads', () => {
  const ranked = rankTopic(
    'AI',
    [
      // One source, huge reads.
      hit('https://a.com/1', 'OpenAI releases GPT-6 today', 'a', { engagement: { reads: 100000 } }),
      // Three sources, small reads.
      hit('https://b.com/1', 'Nvidia unveils new inference chip', 'b', { position: 1 }),
      hit('https://c.com/2', 'Nvidia unveils new inference chip lineup', 'c', { position: 2 }),
      hit('https://d.com/3', 'Nvidia unveils new inference chip lineup today', 'd', { position: 3 }),
    ],
    10,
  )
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].sourceCount, 3)
  assert.match(ranked[0].title, /Nvidia/)
})

test('rankTopic respects top', () => {
  const titles = [
    'Nvidia unveils a new inference chip for data centers',
    'Regulators open an inquiry into model licensing terms',
    'A startup raises a Series B to build warehouse robots',
    'Researchers publish a benchmark for long context reasoning',
    'Chip export rules tighten across three jurisdictions',
    'A hospital network deploys triage software nationwide',
  ]
  const hits = titles.map((title, index) => hit(`https://a${index}.com/1`, title, `a${index}`))
  assert.equal(rankTopic('AI', hits, 3).length, 3)
})

test('usableTitle rejects section pages', () => {
  assert.equal(usableTitle('Home'), false)
  assert.equal(usableTitle('Latest news'), false)
  assert.equal(usableTitle('OpenAI releases GPT-6 with 1M context window'), true)
})

test('a section page is dropped instead of becoming a story', () => {
  // The reported bug: site:openai.com returned the /research section, and the
  // digest linked there instead of to the article.
  const ranked = rankTopic(
    'AI',
    [
      hit('https://openai.com/research', 'OpenAI Research', 'outlet:openai.com', { isArticle: false, position: 0 }),
      hit('https://openai.com/index/gpt-6-is-here', 'Introducing GPT-6', 'outlet:openai.com', { position: 1 }),
    ],
    10,
  )
  assert.equal(ranked.length, 1, 'the section page must not become a story')
  assert.equal(ranked[0].url, 'https://openai.com/index/gpt-6-is-here')
})

test('the representative link prefers the article over the section page', () => {
  // Both hits describe the same event; the section page ranked first, so this
  // is exactly the case where a naive "first hit wins" links to the wrong page.
  const ranked = rankTopic(
    'AI',
    [
      hit('https://openai.com/research', 'OpenAI research update', 'outlet:openai.com', { position: 0 }),
      hit('https://openai.com/index/gpt-6-is-here', 'OpenAI research update ships GPT-6', 'outlet:openai.com', { position: 1 }),
    ],
    10,
  )
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].url, 'https://openai.com/index/gpt-6-is-here', 'the link must be the article, not the section')
})

test('linkQuality ranks today\'s article over a section page and over an old article', () => {
  const section = hit('https://a.com/research', 'x', 'a', { position: 0 })
  const articleOld = hit('https://a.com/2026/01/05/gpt-6-launch-analysis', 'x', 'a', {
    position: 0,
    freshness: { date: new Date('2026-01-01'), dated: true, sameDay: false, ageDays: 100, from: 'meta' },
  })
  const articleToday = hit('https://a.com/2026/10/26/gpt-6-launch-analysis', 'x', 'a', {
    position: 3,
    freshness: { date: new Date(), dated: true, sameDay: true, ageDays: 0, from: 'meta' },
  })
  // The case the bug was about: the section page must never win the link.
  assert.ok(linkQuality(articleToday) > linkQuality(section))
  assert.ok(linkQuality(articleToday) > linkQuality(articleOld))
  // An article of unknown date still beats a section page: right kind of page.
  const articleUndated = hit('https://a.com/index/gpt-6-is-here', 'x', 'a')
  assert.ok(linkQuality(articleUndated) > linkQuality(section))
})

test('a story dated before the window is dropped, an undated one is kept', () => {
  const stale = hit('https://a.com/index/old', 'Old news about chips', 'a', {
    freshness: { date: new Date('2026-01-01'), dated: true, sameDay: false, ageDays: 200, from: 'meta' },
  })
  const undated = hit('https://b.com/index/new', 'Fresh news about chips', 'b')
  const ranked = rankTopic('AI', [stale, undated], 10, { maxAgeDays: 0 })
  assert.equal(ranked.length, 1, 'only the undated story survives the window')
  assert.equal(ranked[0].url, 'https://b.com/index/new')
})

test('same-day stories outrank undated ones', () => {
  const undated = hit('https://a.com/index/one', 'Chip export rules tighten', 'a', { position: 0 })
  const today = hit('https://b.com/index/two', 'Chip export rules tighten further', 'b', {
    position: 5,
    freshness: { date: new Date(), dated: true, sameDay: true, ageDays: 0, from: 'meta' },
  })
  const ranked = rankTopic('AI', [undated, today], 10, { maxAgeDays: 0 })
  assert.equal(ranked[0].sameDay, true)
})

test('a story carries its publication date', () => {
  const date = new Date('2026-10-26T09:00:00Z')
  const ranked = rankTopic('AI', [
    hit('https://a.com/index/one', 'A story about chips', 'a', {
      freshness: { date, dated: true, sameDay: true, ageDays: 0, from: 'meta' },
    }),
  ], 10)
  assert.equal(ranked[0].publishedAt, date.toISOString())
  assert.equal(ranked[0].dated, true)
  assert.equal(ranked[0].sameDay, true)
})

test('the window never empties a digest that only has dated-old coverage', () => {
  // A provider that dates everything last month must not produce a blank topic.
  const old = hit('https://a.com/index/old', 'Old but relevant coverage of chips', 'a', {
    freshness: { date: new Date('2026-01-01'), dated: true, sameDay: false, ageDays: 200, from: 'meta' },
  })
  const ranked = rankTopic('AI', [old], 10, { maxAgeDays: 0 })
  assert.equal(ranked.length, 1, 'the fallback keeps dated coverage rather than showing nothing')
})
