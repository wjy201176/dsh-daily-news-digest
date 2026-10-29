/**
 * Tests for topical relevance screening.
 *
 * The bug these pin: "AI News" ranked a Cadillac XT5 forum thread at #3, because
 * the pipeline never asked whether a hit was about the topic at all. Every case
 * here is a real title from the stored digest that produced that result, so the
 * fixtures are evidence rather than invention.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GREY_LOW,
  relevanceOf,
  screenTopic,
  screenVerdict,
  topicQualifiers,
  topicTerms,
} from '../lib/relevance.js'
import { buildRelevancePrompt, parseRelevanceReply, applyRelevanceVeto } from '../lib/summary.js'

const verdictOf = (topic, title, extra = {}) =>
  relevanceOf({ title, url: 'https://example.com/x', snippet: '', ...extra }, topicTerms(topic))

const decisionOf = (topic, title, extra = {}) => screenVerdict(verdictOf(topic, title, extra))

// The junk that actually reached the digest.
const JUNK_AI = [
  '【图】浅谈一下XT5的通病，希对各位有帮助_凯迪拉克XT5 ...',
  '【图】教你怎么换车钥匙电池_凯迪拉克XT5论坛_汽车之家论坛',
  'File Explorer in Windows | Microsoft Support',
  '火锅 （以沸水或汤底涮煮食材并随煮随食的烹饪方式）_百度百科',
  '金山文档怎么修改文件下载默认保存位置 - 百度经验',
  '狼派lm89怎么蓝牙连接 - 百度知道',
  'Microsoft Community',
]

// Real AI coverage, none of which says "AI News" verbatim.
const REAL_AI = [
  "Anthropic warns of AI's catastrophic risks ahead of major IPO",
  'OpenAI releases GPT-6 with 1M context window',
  'Nvidia unveils a rack scale inference accelerator',
  'Chip export rules tighten across three jurisdictions',
  'Researchers publish a long context reasoning benchmark',
  'A publisher settles a copyright dispute over training data',
  'Humanoid robot startup raises a Series B round',
]

test('the Cadillac forum post is dropped from AI News', () => {
  // The exact reported bug, title and all.
  const decision = decisionOf('AI News', '【图】浅谈一下XT5的通病，希对各位有帮助_凯迪拉克XT5 ...')
  assert.equal(decision, 'drop', 'a Cadillac XT5 thread is not AI news')

  const verdict = verdictOf('AI News', '【图】浅谈一下XT5的通病，希对各位有帮助_凯迪拉克XT5 ...')
  assert.deepEqual(verdict.matched, [], 'nothing in that title is AI vocabulary')
})

test('every unrelated title from the stored digest is dropped', () => {
  for (const title of JUNK_AI) {
    assert.equal(decisionOf('AI News', title), 'drop', `must drop: ${title}`)
  }
})

test('real AI coverage is kept even when it never says "AI News"', () => {
  for (const title of REAL_AI) {
    assert.equal(decisionOf('AI News', title), 'keep', `must keep: ${title}`)
  }
})

test('"ai" matches the word, never a substring of a brand', () => {
  // "Cadillac" contains "ai" as letters; a substring match would pass it.
  assert.equal(decisionOf('AI', 'Cadillac XT5 review'), 'drop')
  assert.equal(decisionOf('AI', 'The chain reaction explained'), 'drop')
  assert.equal(decisionOf('AI', 'AI safety researchers publish a report'), 'keep')
})

test('a short generic topic does not match inside longer words', () => {
  // "llm" must not match "llm-master" being used as a repository brand name,
  // nor "global" match inside "globalization" only by accident — but a topic word
  // that IS present as a word must count.
  assert.equal(decisionOf('LLM', 'llm-master: a full stack course'), 'keep', 'the hyphen is a boundary')
  assert.equal(decisionOf('LLM', 'A llama model runs on a phone'), 'keep', 'llama is LLM vocabulary')
  assert.equal(decisionOf('LLM', '火锅的起源与做法'), 'drop')
})

test('a topic of only stopwords keeps everything rather than emptying the digest', () => {
  // "News" alone constrains nothing: every page is news.
  const screened = screenTopic('News', [
    { url: 'https://a.com/1', title: 'Something happened somewhere', snippet: '' },
    { url: 'https://b.com/2', title: 'Another unrelated report', snippet: '' },
  ])
  assert.equal(screened.stats.kept, 2, 'an unconstrained topic must not filter')
})

test('the Chinese topic keeps its own news and drops unrelated pages', () => {
  // The topic is 具身智能; the article says 人形机器人, which is the same subject.
  assert.equal(decisionOf('具身智能', '人形机器人公司完成新一轮融资'), 'keep')
  assert.equal(decisionOf('具身智能', '火锅的起源与做法'), 'drop')
})

test('a topic with a distinctive word matches that word across languages', () => {
  assert.equal(decisionOf('Global Economics', 'IMF cuts global growth forecast as tariffs bite'), 'keep')
  assert.equal(decisionOf('Global Economics', 'Global 是什么意思？详解英文单词 global 的用法与例句'), 'drop')
})

test('relevance reports what matched and what was missing', () => {
  const verdict = verdictOf('LLM Local Deployment', 'Running Llama 3 locally with llama.cpp on a laptop')
  assert.ok(verdict.matched.length > 0, 'the match must be explainable')
  assert.ok(verdict.score > 0)
  assert.ok(Array.isArray(verdict.missing))
  assert.ok(verdict.evidence.literalTotal > 0, 'the evidence counts must be reported')
})

test('the grey zone exists for genuinely ambiguous hits', () => {
  // "model" is weak AI vocabulary: the title mentions one and could be either.
  const weather = verdictOf('AI News', 'A weather agency upgrades its forecast model')
  const policy = verdictOf('AI News', 'Regulators open an inquiry into model licensing terms')
  for (const verdict of [weather, policy]) {
    assert.equal(verdict.relevant, false, 'a single weak word is not certain evidence')
    assert.equal(screenVerdict(verdict), 'grey', 'but it is worth a second look, not a drop')
  }
  assert.ok(GREY_LOW > 0 && GREY_LOW < 1, 'the fallback floor must be a real threshold')
})

test('screening drops the junk and keeps the news in one pass', () => {
  const hits = [...JUNK_AI, ...REAL_AI].map((title, index) => ({
    url: `https://example.com/${index}`,
    title,
    snippet: '',
  }))
  const screened = screenTopic('AI News', hits)
  assert.equal(screened.stats.total, hits.length)
  assert.equal(screened.stats.kept, REAL_AI.length, 'only the real coverage survives')
  assert.equal(screened.stats.dropped, JUNK_AI.length)
  for (const hit of screened.kept) {
    assert.ok(hit.relevance.decision === 'keep' || hit.relevance.decision === 'grey')
  }
  for (const hit of screened.dropped) {
    assert.equal(hit.relevance.decision, 'drop')
  }
})

test('an all-unrelated topic reports nothing rather than rescuing junk', () => {
  // A rescue here would put the original bug straight back: the fail-safe must
  // only rescue hits that show *some* evidence of the topic.
  const screened = screenTopic(
    'AI News',
    JUNK_AI.map((title, index) => ({ url: `https://example.com/${index}`, title, snippet: '' })),
  )
  assert.equal(screened.kept.length, 0, 'unrelated pages must not be rescued')
  assert.equal(screened.stats.rescued, false)
})

test('the fail-safe rescues terse-but-related hits instead of reporting no news', () => {
  // One weak word and nothing else: the screen drops it, but it is evidence of
  // the topic, so the digest still shows something rather than claiming silence.
  const screened = screenTopic('AI News', [{ url: 'https://example.com/x', title: 'Model model model', snippet: '' }])
  assert.ok(screened.stats.kept + screened.stats.dropped > 0)
  // A single weak word lands in grey, which is already kept.
  assert.equal(screened.kept.length, 1)
})

test('screening does not mutate the hits it is given', () => {
  const hits = [{ url: 'https://example.com/1', title: 'OpenAI ships a model', snippet: '' }]
  const before = JSON.stringify(hits)
  screenTopic('AI News', hits)
  assert.equal(JSON.stringify(hits), before, 'the caller keeps its own list')
})

test('the relevance prompt offers only the grey zone and asks for ids', () => {
  const prompt = buildRelevancePrompt('AI News', [
    { id: 1, title: 'A weather agency upgrades its forecast model', snippet: 'Rain.', url: 'https://a.com/1' },
  ])
  assert.match(prompt.system, /ONE JSON object/)
  assert.match(prompt.system, /\{"drop": \[id, \.\.\.\]\}/)
  assert.match(prompt.user, /Topic: AI News/)
  assert.match(prompt.user, /\[1\] A weather agency/)
})

test('the veto parser ignores ids that were never offered', () => {
  const dropped = parseRelevanceReply('{"drop":[1,9,"2",3]}', [1, 2])
  assert.deepEqual([...dropped].sort(), [1, 2], 'only offered ids may be dropped')
  assert.equal(parseRelevanceReply('not json', [1]).size, 0, 'prose must veto nothing')
  assert.equal(parseRelevanceReply('{"drop":[]}', [1]).size, 0)
})

test('a veto only removes hits the screen was already unsure about', () => {
  const grey = { url: 'https://a.com/1', id: 1, relevance: { decision: 'grey' } }
  const certain = { url: 'https://b.com/2', id: 2, relevance: { decision: 'keep' } }
  const result = applyRelevanceVeto([grey, certain], new Set([1, 2]))
  assert.deepEqual(result.kept.map((hit) => hit.url), ['https://b.com/2'], 'a certain hit is never vetoed')
  assert.deepEqual(result.vetoed.map((hit) => hit.url), ['https://a.com/1'])
})

test('a car forum thread that says "model" is dropped, not sent to the grey zone', () => {
  // The replay found this: the Cadillac post's *body* said "the model's common
  // problems", so a weak AI word matched and the hit survived as grey. "Model"
  // is what a car reviewer calls a car; the page is not ambiguous, it is a car.
  const hits = [
    {
      url: 'https://club.autohome.com.cn/bbs/thread/a22f7f3ed8d2cfd4/79637190-1.html',
      title: '【图】浅谈一下XT5的通病，希对各位有帮助_凯迪拉克XT5 ...',
      snippet: "A Cadillac XT5 owner's forum post reviews the model's common problems after roughly 30,000",
    },
  ]
  const screened = screenTopic('AI News', hits)
  assert.equal(screened.kept.length, 0, 'the car thread must not survive')
  assert.equal(screened.dropped.length, 1)
})

test('a hit is never reported as both kept and dropped', () => {
  // The replay found this: the fail-safe rescued copies of hits but removed the
  // originals by identity, so the same URL appeared in both lists.
  const hits = [
    { url: 'https://a.com/1', title: 'A weather agency upgrades its forecast model', snippet: '' },
    { url: 'https://b.com/2', title: 'Another forecast model upgrade', snippet: '' },
  ]
  const screened = screenTopic('AI News', hits)
  const keptUrls = new Set(screened.kept.map((hit) => hit.url))
  for (const hit of screened.dropped) {
    assert.ok(!keptUrls.has(hit.url), `both lists contain ${hit.url}`)
  }
  assert.equal(screened.kept.length + screened.dropped.length, hits.length, 'every hit is accounted for exactly once')
})

test('real geopolitics briefings survive despite generic headlines', () => {
  // The replay found this: "Morning Briefing" and "Foreign Affairs" are real
  // world coverage whose headlines carry no geopolitical vocabulary, but whose
  // bodies do. Neither may be dropped.
  const briefing = {
    title: 'Morning Briefing: Oct. 26, 2026',
    snippet: "Anadolu's morning briefing recaps top stories from around the globe.",
  }
  const briefingDecision = decisionOf('Geopolitics', briefing.title, { snippet: briefing.snippet })
  assert.notEqual(briefingDecision, 'drop', 'a world-news briefing must not be dropped')
  // "briefing" is weak vocabulary, so the honest answer is grey — kept for the
  // model pass to confirm, not asserted as certain.
  assert.equal(briefingDecision, 'grey')

  const affairs = {
    title: 'Foreign Affairs',
    snippet: "Trump called Norway a 'shithouse country', Politico reported.",
  }
  assert.equal(decisionOf('Geopolitics', affairs.title, { snippet: affairs.snippet }), 'keep', 'named actors are conclusive')
})

test('a Windows help page is dropped from Geopolitics', () => {
  assert.equal(
    decisionOf('Geopolitics', 'How to get help in Windows - Microsoft Support', {
      snippet: 'Learn how to get help in Windows.',
    }),
    'drop',
  )
})

// ---------------------------------------------------------------------------
// The qualifier gate: a compound topic is not satisfied by its category word.
//
// The reported bug: "LLM Local Deployment" ranked three general AI stories --
// a Gemini model review, a Gemini cyber-defender policy note and an AI-safety
// piece about who can pull the plug -- because the head word "llm" matched their
// vocabulary and nothing asked for "local" or "deployment".
// ---------------------------------------------------------------------------

test('a specific topic is not satisfied by its category word alone', () => {
  const bad = [
    "Google's Gemini 4 Carbon looks like a diamond in the rough",
    'Anthropic and OpenAI diverge on who should pull the plug on risky AI',
    'Daily Update: Google says Gemini 4 Carbon will go first to a subset of cyber defenders',
  ]
  for (const title of bad) {
    assert.equal(decisionOf('LLM Local Deployment', title), 'drop', `must drop for this topic: ${title}`)
  }
})

test('a specific topic keeps stories that address its qualifiers', () => {
  // Kept and flagged, not dropped: the headline says where it runs without naming
  // a model, so it is evidence-backed but not certain. Dropping it would be the
  // opposite failure from the one being fixed.
  assert.notEqual(
    decisionOf('LLM Local Deployment', 'Locals runs many coding agents on a Mac, three times faster'),
    'drop',
    '"locals" and "Mac" are local-deployment evidence',
  )
  assert.equal(
    decisionOf('LLM Local Deployment', 'Running vLLM locally on a single RTX 4090'),
    'keep',
  )
  assert.equal(
    decisionOf('LLM Local Deployment', 'Self-hosting a Qwen model on your own desktop'),
    'keep',
    'a synonym of "local" counts',
  )
})

test('a category topic is unaffected by the gate', () => {
  // "AI News" has no qualifying words, so its alias expansion remains the test.
  assert.deepEqual(topicQualifiers('AI News'), [])
  assert.equal(decisionOf('AI News', "Google's Gemini 4 Carbon looks like a diamond in the rough"), 'keep')
  assert.deepEqual(topicQualifiers('Geopolitics'), [])
  assert.deepEqual(topicQualifiers('Global Economics'), [], '"global" and "economics" are both category words')
  assert.deepEqual(topicQualifiers('Science and Technology'), [])
})

test('the qualifiers are the topic words minus its category words', () => {
  assert.deepEqual(topicQualifiers('LLM Local Deployment'), ['local', 'deployment'])
  assert.deepEqual(topicQualifiers('Embodied AI'), ['embodied'])
  assert.deepEqual(topicQualifiers('????'), [], 'a single CJK topic has no separable qualifier')
})

test('a subject named in the guidance satisfies the qualifier gate', () => {
  // The reader said what "local deployment" means for them, so their vocabulary is
  // evidence. Without this, a story that says "Ollama" but never "local" is lost.
  const verdict = relevanceOf(
    { title: 'Ollama ships a new quantized runtime', url: 'https://example.com/a' },
    topicTerms('LLM Local Deployment', { extraTerms: ['ollama'] }),
  )
  assert.notEqual(screenVerdict(verdict, 'ollama ships a new quantized runtime'), 'drop')
})

test('the rescue path never restores a hit that failed the qualifier gate', () => {
  // A topic whose only hits are category news must report "no relevant news",
  // not rescue them back because they carry strong AI vocabulary.
  const result = screenTopic('LLM Local Deployment', [
    { url: 'https://example.com/a', title: "Google's Gemini 4 Carbon looks like a diamond in the rough" },
    { url: 'https://example.com/b', title: 'Anthropic and OpenAI diverge on who should pull the plug on risky AI' },
  ])
  assert.equal(result.kept.length, 0, `nothing should survive; got ${JSON.stringify(result.kept.map((hit) => hit.title))}`)
})
