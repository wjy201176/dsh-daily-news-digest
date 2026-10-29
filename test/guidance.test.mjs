/**
 * Tests for per-topic search guidance.
 *
 * Guidance is the user's own description of what they want inside a topic. It
 * has to survive being turned into a search query and a filter, in English and
 * in Chinese, without the parser inventing terms or dropping the ones that
 * matter.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_GUIDANCE, cleanGuidance, exclusionHit, parseGuidance, rankKeywords, splitGuidance, termsOf } from '../lib/guidance.js'

test('an empty guidance parses to nothing and says so', () => {
  for (const empty of ['', '   ', null, undefined, '\n\n']) {
    const parsed = parseGuidance(empty)
    assert.equal(parsed.empty, true, `"${String(empty)}" must be empty`)
    assert.deepEqual(parsed.keywords, [])
    assert.deepEqual(parsed.excludes, [])
    assert.equal(parsed.note, '')
  }
})

test('guidance keeps its words for the model but is capped for storage', () => {
  const long = 'x'.repeat(MAX_GUIDANCE + 500)
  assert.equal(cleanGuidance(long).length, MAX_GUIDANCE)
  assert.equal(cleanGuidance('a\r\nb'), 'a\nb', 'carriage returns are normalised')
  assert.equal(cleanGuidance('a\n\n\n\nb'), 'a\n\nb', 'runaway blank lines collapse')
})

test('the keywords of an English guidance are its substantive terms', () => {
  const parsed = parseGuidance('Only care about open-source inference engines like vLLM and llama.cpp, skip tutorials and homepages')
  assert.ok(parsed.keywords.includes('vLLM'), 'a product name survives with its case')
  assert.ok(parsed.keywords.includes('llama.cpp'), 'a dotted product name stays whole')
  // A generic category word is dropped once real names exist: "inference" would
  // otherwise take a query slot that belongs to a product the user named.
  assert.ok(!parsed.keywords.includes('inference'), 'a generic category word yields to the names')
  // The instruction words are not search terms.
  assert.ok(!parsed.keywords.includes('only'), '"only" is instruction, not subject')
  assert.ok(!parsed.keywords.includes('care'))
  assert.ok(!parsed.keywords.includes('skip'), 'the exclusion marker must not be searched for')
})

test('instruction words from a written brief never become search terms', () => {
  // The reported bug: a detailed brief produced the query "find credible embodied
  // such October 27 2026", which finds nothing, and the digest came back empty
  // while echoing the instruction back to the user.
  const parsed = parseGuidance(
    'Find the credible news on: 1) major AI companies, such as Deepseek, OpenAI, Anthropic, Google, Alibaba, Moonshot, and Zhipu, 2) major AI models, such as Deepseek, chatGPT, Claude, Qwen, Kimi, and GLM.',
  )
  for (const junk of ['find', 'credible', 'major', 'such', 'companies', 'models', 'news']) {
    assert.ok(!parsed.keywords.includes(junk), `"${junk}" is instruction, not a subject`)
  }
  // The subjects the user named are what must survive.
  for (const name of ['OpenAI', 'deepseek', 'chatGPT', 'claude', 'qwen', 'kimi', 'GLM']) {
    assert.ok(
      parsed.keywords.some((word) => word.toLowerCase() === name.toLowerCase()),
      `the named subject "${name}" must be searched`,
    )
  }
})

test('a short guidance made only of generic words keeps them', () => {
  // Dropping every generic word would leave nothing to search, so they are only
  // dropped when a specific term survives.
  const parsed = parseGuidance('model releases')
  assert.ok(parsed.keywords.length > 0, 'a purely generic guidance must still search something')
})

test('the exclusion half of a guidance is separated from the include half', () => {
  const parsed = parseGuidance('only vLLM news, skip tutorials and homepages')
  assert.deepEqual(parsed.excludes.sort(), ['homepages', 'tutorials'])
  assert.ok(!parsed.excludes.includes('vllm'), 'the wanted term is not an exclusion')
  assert.ok(parsed.keywords.some((word) => word.toLowerCase() === 'vllm'))
})

test('a guidance that is only an exclusion still yields search terms', () => {
  // "don't show me tutorials" is a real instruction: it must not become an empty
  // query, or the topic would lose its guidance entirely.
  const parsed = parseGuidance('skip tutorials')
  assert.equal(parsed.empty, false)
  assert.deepEqual(parsed.excludes, ['tutorials'])
  assert.ok(parsed.keywords.length > 0, 'the exclusion terms are promoted rather than dropped')
})

test('a Chinese guidance is split into its concepts', () => {
  const parsed = parseGuidance('关注开源推理引擎（vLLM、SGLang），不要教程和百科')
  assert.ok(parsed.keywords.includes('vLLM'))
  assert.ok(parsed.keywords.includes('SGLang'))
  assert.ok(parsed.keywords.includes('开源推理引擎'), 'the Chinese concept survives whole')
  assert.ok(parsed.excludes.includes('教程'))
  assert.ok(parsed.excludes.includes('百科'))
  // The instruction verb is not a search term.
  assert.ok(!parsed.keywords.includes('关注'))
})

test('splitGuidance finds a Chinese exclusion marker, not only a Latin one', () => {
  const split = splitGuidance('开源推理引擎 不要教程')
  assert.match(split.include, /开源推理引擎/)
  assert.match(split.exclude, /不要教程/)
})

test('a quoted phrase is one term, because the user wrote it deliberately', () => {
  const terms = termsOf('track "mixture of experts" research')
  assert.ok(terms.includes('mixture of experts'), 'a quoted phrase is not split into words')
})

test('termsOf drops stopwords, bare numbers and one-letter fragments', () => {
  const terms = termsOf('I want the news about 42 things and a b')
  for (const junk of ['i', 'want', 'the', 'about', '42', 'a', 'b', 'news']) {
    assert.ok(!terms.includes(junk), `"${junk}" must not be a search term`)
  }
})

test('a Latin exclusion matches the singular and the spaced form', () => {
  // The user writes "tutorials"; the headline says "a tutorial".
  const excludes = parseGuidance('vLLM news, skip tutorials').excludes
  assert.equal(exclusionHit({ title: 'A tutorial on vLLM' }, excludes).excluded, true)
  assert.equal(exclusionHit({ title: 'Tutorials for beginners' }, excludes).excluded, true)
  assert.equal(exclusionHit({ title: 'vLLM merged a KV cache' }, excludes).excluded, false)
})

test('a Latin exclusion matches a spaced compound', () => {
  const excludes = parseGuidance('vLLM news, skip homepages').excludes
  assert.equal(exclusionHit({ title: 'Home page' }, excludes).excluded, true, '"Home page" is the spaced form of homepage')
  assert.equal(exclusionHit({ title: 'A homepage' }, excludes).excluded, true)
})

test('a Chinese exclusion is a substring match', () => {
  const excludes = parseGuidance('开源推理，不要教程和百科').excludes
  assert.equal(exclusionHit({ title: '【教程】vLLM 入门' }, excludes).excluded, true)
  assert.equal(exclusionHit({ title: '百度百科：vLLM' }, excludes).excluded, true)
  assert.equal(exclusionHit({ title: 'vLLM merged a KV cache' }, excludes).excluded, false)
})

test('the exclusion checks the snippet as well as the title', () => {
  const excludes = parseGuidance('vLLM news, skip tutorials').excludes
  const verdict = exclusionHit({ title: 'vLLM ships a scheduler', snippet: 'This tutorial walks through the change.' }, excludes)
  assert.equal(verdict.excluded, true, 'a snippet can say what the title does not')
})

test('an exclusion does not fire on an unrelated word that merely contains it', () => {
  const excludes = parseGuidance('vLLM news, skip guides').excludes
  assert.equal(exclusionHit({ title: 'Guided missiles in the region' }, excludes).excluded, false, 'a prefix match must respect the word boundary')
})

test('no exclusions means nothing is excluded', () => {
  for (const excludes of [[], null, undefined]) {
    assert.equal(exclusionHit({ title: 'anything' }, excludes).excluded, false)
  }
})

test('parseGuidance does not mutate or throw on hostile input', () => {
  for (const bad of [null, undefined, 42, {}, [], { toString: () => 'x' }]) {
    const parsed = parseGuidance(bad)
    assert.equal(typeof parsed.note, 'string')
    assert.ok(Array.isArray(parsed.keywords))
    assert.ok(Array.isArray(parsed.excludes))
  }
})

test('the product names lead the keywords, not the generic category words', () => {
  // Only the first few keywords reach a query, so "engines" must not take the slot
  // that belongs to "llama.cpp" — the user's names are the valuable part.
  const parsed = parseGuidance('only open-source inference engines vLLM and llama.cpp. Skip tutorials and homepages.')
  assert.deepEqual(parsed.keywords.slice(0, 2), ['vLLM', 'llama.cpp'], `got ${JSON.stringify(parsed.keywords)}`)
})

test('a Chinese guidance also puts its names first', () => {
  const parsed = parseGuidance('关注开源推理引擎（vLLM、SGLang），不要教程和百科')
  assert.deepEqual(parsed.keywords.slice(0, 2), ['vLLM', 'SGLang'])
})

test('rankKeywords keeps the user order inside each group', () => {
  const ranked = rankKeywords(['alpha', 'vLLM', 'beta', 'GPT-6', 'gamma'])
  assert.deepEqual(ranked, ['vLLM', 'GPT-6', 'alpha', 'beta', 'gamma'])
})

test('rankKeywords is stable for a list with no names', () => {
  const words = ['quantization', 'rollouts', 'hardware']
  assert.deepEqual(rankKeywords(words), words)
})
