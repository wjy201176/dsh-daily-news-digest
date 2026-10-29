import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dateFromUrl, dayKey, freshnessOf, isArticleUrl, parseDate, todayKey } from '../lib/recency.js'

test('a section landing page is not an article', () => {
  // The reported bug: openai.com/research became a story's link.
  assert.equal(isArticleUrl('https://openai.com/research'), false)
  assert.equal(isArticleUrl('https://openai.com/research/'), false)
  assert.equal(isArticleUrl('https://www.cnn.com/tech'), false)
  assert.equal(isArticleUrl('https://example.com/news'), false)
  assert.equal(isArticleUrl('https://example.com/blog'), false)
  assert.equal(isArticleUrl('https://example.com/'), false)
})

test('a published article is an article', () => {
  assert.equal(isArticleUrl('https://openai.com/index/gpt-6-is-here'), true)
  assert.equal(isArticleUrl('https://www.cnn.com/2026/10/26/tech/story/index.html'), true)
  assert.equal(isArticleUrl('https://example.com/2026/10/26/some-headline'), true)
  assert.equal(isArticleUrl('https://example.com/news/2026-10-26-launch'), true)
  assert.equal(isArticleUrl('https://example.com/p/1234567890'), true)
  assert.equal(isArticleUrl('https://example.com/a-very-long-article-slug-about-chips'), true)
})

test('a single post on a login-walled platform is an article', () => {
  // These platforms address one post by a short id, which the generic numeric
  // rule rejects — so they need their permalink shapes or every X post is lost.
  assert.equal(isArticleUrl('https://x.com/someone/status/1'), true)
  assert.equal(isArticleUrl('https://twitter.com/someone/status/1'), true)
  assert.equal(isArticleUrl('https://www.zhihu.com/question/123456'), true)
  assert.equal(isArticleUrl('https://zhuanlan.zhihu.com/p/123456'), true)
  assert.equal(isArticleUrl('https://www.reddit.com/r/ai/comments/abc123/a_title'), true)
  assert.equal(isArticleUrl('https://m.weibo.cn/detail/4123456789'), true)
  // A profile or topic page is still not an article.
  assert.equal(isArticleUrl('https://x.com/elonmusk'), false)
  assert.equal(isArticleUrl('https://www.zhihu.com/topic/123'), false)
})

test('a collection page with an article-shaped tail is not an article', () => {
  // A topic hub's tail looks exactly like an article id, so the id rule alone
  // would accept it: bbc.com/news/topics/ce1qrvleleqt was stored as a story.
  assert.equal(isArticleUrl('https://www.bbc.com/news/topics/ce1qrvleleqt'), false)
  assert.equal(isArticleUrl('https://example.com/tag/some-long-tag-name'), false)
  assert.equal(isArticleUrl('https://example.com/category/technology'), false)
  assert.equal(isArticleUrl('https://example.com/author/jane-doe-2026'), false)
  assert.equal(isArticleUrl('https://example.com/archive/2026/10'), false)
  // The same site's real article must still pass: `articles` is a collection
  // name that *contains* articles, so it must not be treated as a listing.
  assert.equal(isArticleUrl('https://www.bbc.com/news/articles/c1e9x8v0d3yo'), true)
  assert.equal(isArticleUrl('https://www.bbc.com/news/articles/c1e9x8v0d3yo/'), true)
})

test('a non-http URL is never an article', () => {
  assert.equal(isArticleUrl('ftp://example.com/x/y/z'), false)
  assert.equal(isArticleUrl('not a url'), false)
  assert.equal(isArticleUrl(''), false)
})

test('parseDate reads ISO, month names, relative and yearless shapes', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0)
  assert.equal(dayKey(parseDate('2026-10-26T08:30:00Z', now)), '2026-10-26')
  assert.equal(dayKey(parseDate('2026-10-26', now)), '2026-10-26')
  assert.equal(dayKey(parseDate('Oct 26, 2026', now)), '2026-10-26')
  assert.equal(dayKey(parseDate('26 October 2026', now)), '2026-10-26')
  assert.equal(dayKey(parseDate('2 days ago', now)), '2026-10-24')
  assert.equal(dayKey(parseDate('yesterday', now)), '2026-10-25')
  assert.equal(parseDate('sometime last spring', now), null)
  assert.equal(parseDate('', now), null)
  assert.equal(parseDate(null, now), null)
})

test('dateFromUrl recovers a date from a dated path', () => {
  const date = dateFromUrl('https://www.cnn.com/2026/10/26/tech/story/index.html')
  assert.equal(dayKey(date), '2026-10-26')
  assert.equal(dayKey(dateFromUrl('https://example.com/2026-10-26-post')), '2026-10-26')
  assert.equal(dateFromUrl('https://example.com/no-date-here'), null)
})

test('freshnessOf marks today as same-day', () => {
  const now = new Date(2026, 9, 26, 15, 0, 0)
  const fresh = freshnessOf({ url: 'https://a.com/x/y', publishedAt: '2026-10-26T09:00:00Z' }, now)
  assert.equal(fresh.dated, true)
  assert.equal(fresh.sameDay, true)
  assert.equal(fresh.ageDays, 0)

  const old = freshnessOf({ url: 'https://a.com/x/y', publishedAt: '2026-10-20T09:00:00Z' }, now)
  assert.equal(old.dated, true)
  assert.equal(old.sameDay, false)
  assert.equal(old.ageDays, 6)

  const undated = freshnessOf({ url: 'https://a.com/x/y' }, now)
  assert.equal(undated.dated, false)
  assert.equal(undated.sameDay, false)
  assert.equal(undated.ageDays, null)
})

test('freshnessOf falls back to the URL when no date is given', () => {
  const now = new Date(2026, 9, 26, 15, 0, 0)
  const fresh = freshnessOf({ url: 'https://cnn.com/2026/10/26/tech/thing', publishedAt: '' }, now)
  assert.equal(fresh.dated, true)
  assert.equal(fresh.sameDay, true)
  assert.equal(fresh.from, 'url')
})

test('todayKey reports the local calendar day', () => {
  assert.equal(todayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})
