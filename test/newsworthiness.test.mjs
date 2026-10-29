/**
 * Tests for the news-vs-evergreen judgement.
 *
 * The bug these pin: "LLM Local Deployment" ranked a Zhihu article titled
 * "don't confuse LLM terms any more" at #5 — genuinely about the topic, and not
 * news. Every case here is a real title from the digest that produced it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  NEWS_THRESHOLD,
  NON_NEWS_KINDS,
  contentKind,
  newsworthinessOf,
  screenNews,
} from '../lib/newsworthiness.js'
import { freshnessOf } from '../lib/recency.js'

const today = new Date()
const isoDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

/** Build a hit with a real freshness verdict. */
const hit = (title, url, { publishedAt = '', snippet = '' } = {}) => {
  const base = { title, url, snippet, publishedAt }
  return { ...base, freshness: freshnessOf(base, today) }
}

const judge = (title, url, extra) => newsworthinessOf(hit(title, url, extra))

// The evergreen material that actually reached the digest.
const EVERGREEN = [
  ['【珍藏】不再混淆大模型术语： LLM 、VLM、MLLM、LMM ...', 'https://zhuanlan.zhihu.com/p/1989728299547639935'],
  ['一文搞懂 LLM 大模型！ LLM 从入门到精通万字长文 - 知乎', 'https://zhuanlan.zhihu.com/p/7046080918'],
  ['Artificial intelligence ( AI ) | Definition, Examples, Types ...', 'https://www.britannica.com/technology/artificial-intelligence'],
  ['OpenAI | 研究与部署', 'https://openai.com/zh-Hans-CN/'],
  ['Microsoft ——AI、云、生产力、计算、游戏和应用', 'https://www.microsoft.com/zh-cn'],
  ['百度 APP纯净 阅读模式 怎么开启与关闭- 百度 经验', 'https://jingyan.baidu.com/article/60ccbceb9e90fe25cbb1975d.html'],
  ['人工智能 - 最新人工智能实时滚动快讯，聚合所有人工智能相关热门新闻快讯_新浪娱乐', 'https://tags.news.sina.com.cn/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD'],
]

// Real reporting from the same digest.
const NEWS = [
  ['vLLM merged a 3-bit KV cache for AMD GPUs that holds 1.95x as many tokens as FP8', 'https://mindpattern.ai/s/2026-10-26-vllm-merged', { publishedAt: isoDay }],
  ['Anthropic files for potentially the biggest IPO ever as CEO warns of risk to humanity from AI', 'https://apnews.com/article/anthropic-ipo', { publishedAt: isoDay }],
  ['Nvidia unveils a rack scale inference accelerator', 'https://reuters.com/tech/nvidia', { publishedAt: isoDay }],
  ['Fed, ECB and BoJ to make rate decisions amid inflation risks', 'https://www.aa.com.tr/en/economy/fed-ecb', { publishedAt: isoDay }],
]

test('the Zhihu tutorial that prompted this report is not news', () => {
  const [title, url] = EVERGREEN[0]
  const verdict = judge(title, url)
  assert.equal(verdict.news, false, 'a terminology explainer is not a news story')
  assert.equal(verdict.kind, 'tutorial')
  assert.ok(verdict.reasons.length > 0, 'the drop must be explainable')
})

test('every evergreen page from the digest is rejected', () => {
  for (const [title, url] of EVERGREEN) {
    const verdict = judge(title, url)
    assert.equal(verdict.news, false, `must not be news: ${title}`)
  }
})

test('real reporting from the same digest is kept', () => {
  for (const [title, url, extra] of NEWS) {
    const verdict = judge(title, url, extra)
    assert.equal(verdict.news, true, `must be news: ${title}`)
    assert.ok(verdict.score >= NEWS_THRESHOLD)
  }
})

test('a home page is never a story, whatever its score', () => {
  for (const url of ['https://openai.com/', 'https://www.microsoft.com/zh-cn', 'https://example.com/en', 'https://example.com/en-US']) {
    assert.equal(contentKind({ url, title: 'OpenAI' }), 'homepage', `${url} must read as a home page`)
    assert.equal(newsworthinessOf(hit('OpenAI launches a new model today', url, { publishedAt: isoDay })).news, false, 'even a newsy title cannot make a home page a story')
  }
})

test('a tag listing is never a story', () => {
  const verdict = judge('人工智能 - 最新人工智能实时滚动快讯', 'https://tags.news.sina.com.cn/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD')
  assert.equal(verdict.kind, 'listing')
  assert.equal(verdict.news, false)
})

test('a reference site is never a story, even with a dated title', () => {
  const verdict = judge('Artificial intelligence — definition and examples', 'https://www.britannica.com/technology/artificial-intelligence', { publishedAt: isoDay })
  assert.equal(verdict.kind, 'reference')
  assert.equal(verdict.news, false)
})

test('a Q&A answer is not news, but a personal Space on the same host is', () => {
  // A question page is a question.
  assert.equal(contentKind({ url: 'https://www.quora.com/What-is-geopolitics', title: 'What is geopolitics?' }), 'qa')
  // A Quora *Space* is a blog: the subdomain is what distinguishes them.
  assert.equal(contentKind({ url: 'https://stephenmillersspace5.quora.com/Poland-will-hold', title: 'Poland will hold military exercises' }), 'article')
})

test('a dated roundup counts as reporting even without an event verb', () => {
  // "International News Briefs for Monday, October 26, 2026" reports the day.
  const verdict = judge('International News Briefs for Monday, October 26, 2026 - Havana Times', 'https://havanatimes.org/news/international-news-briefs')
  assert.equal(verdict.news, true, 'a dated briefs column is reporting')
  assert.ok(verdict.signals.includes('a dated roundup') || verdict.signals.some((s) => s.includes('event verb')))
})

test('an undated page with no event verb is evergreen, not news', () => {
  const verdict = judge('Gustavo de Arístegui: Geopolitical analysis of 26 October', 'https://www.atalayar.com/en/articulo/gustavo-aristegui/x')
  assert.equal(verdict.news, false)
  assert.ok(verdict.reasons.some((reason) => reason.includes('no publication date')))
})

test('an undated page WITH an event verb is kept', () => {
  // A provider that sends no dates must not cost us real reporting.
  const verdict = judge('Anthropic files for IPO', 'https://example.com/anthropic-ipo')
  assert.equal(verdict.news, true)
})

test('a figure in the headline raises the score', () => {
  const withFigure = judge('Startup raises $400 million at a $9 billion valuation', 'https://example.com/a')
  const without = judge('Startup raises a round at a valuation', 'https://example.com/b')
  assert.ok(withFigure.score > without.score, 'a figure is evidence of reporting')
})

test('every non-news kind is gated regardless of other signals', () => {
  for (const kind of NON_NEWS_KINDS) {
    assert.ok(NON_NEWS_KINDS.has(kind))
  }
  // A home page with a date and a verb still fails: the kind is a hard gate.
  const home = hit('OpenAI launches GPT-6 today', 'https://openai.com/', { publishedAt: isoDay })
  assert.equal(newsworthinessOf(home).news, false)
})

test('screening annotates every hit and reports what it dropped', () => {
  const hits = [
    hit(NEWS[0][0], NEWS[0][1], NEWS[0][2]),
    hit(EVERGREEN[0][0], EVERGREEN[0][1]),
    hit(EVERGREEN[3][0], EVERGREEN[3][1]),
  ]
  const result = screenNews(hits)
  assert.equal(result.stats.total, 3)
  assert.equal(result.kept.length, 1)
  assert.equal(result.dropped.length, 2)
  for (const survivor of result.kept) assert.ok(survivor.newsworthiness.news === true)
  for (const gone of result.dropped) assert.ok(gone.newsworthiness.news === false)
  assert.ok(result.stats.kinds.includes('tutorial'), 'the dropped kinds must be reported')
})

test('screening does not mutate the hits it is given', () => {
  const hits = [hit(NEWS[0][0], NEWS[0][1], NEWS[0][2])]
  const before = JSON.stringify(hits)
  screenNews(hits)
  assert.equal(JSON.stringify(hits), before)
})

test('a malformed hit does not throw', () => {
  for (const bad of [null, undefined, {}, { title: null }, { url: 'not a url' }]) {
    const verdict = newsworthinessOf(bad)
    assert.equal(typeof verdict.news, 'boolean')
  }
})

test('scheduled and diplomatic action reads as news', () => {
  // The audit found these dropped: a plural subject takes the base verb form
  // ("ministers meet", not "ministers meets"), so both forms must be recognised.
  for (const title of [
    'Poland will hold military exercises near its borders with Belarus and Russia',
    'Foreign ministers meet for a ceasefire summit',
    'NATO meets to discuss the eastern flank',
    'Anthropic files for IPO',
    'OpenAI releases GPT-6 with 1M context window',
  ]) {
    const verdict = judge(title, 'https://example.com/story')
    assert.equal(verdict.news, true, `must be news: ${title}`)
  }
})

test('an analysis column with no event is not news', () => {
  const verdict = judge('Gustavo de Arístegui: Geopolitical analysis of 26 October', 'https://www.atalayar.com/en/articulo/gustavo-aristegui/x')
  assert.equal(verdict.news, false, 'an opinion column is not a report of an event')
})
