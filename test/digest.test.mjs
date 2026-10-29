import assert from 'node:assert/strict'
import { test } from 'node:test'

import { outletPlan, runDigest } from '../lib/digest.js'
import { screenTopic } from '../lib/relevance.js'

/**
 * A web service stub whose search returns canned sources per query.
 *
 * Keys are matched as substrings, because a real query now carries the day
 * ("AI News news October 26 2026 site:cnn.com"): a table keyed by the stable
 * part ("site:cnn.com") must still answer, or every fixture would have to embed
 * a date that changes daily.
 */
function fakeWeb(table) {
  const queries = []
  return {
    queries,
    async search(request) {
      queries.push(request.query)
      let match = []
      for (const [needle, sources] of Object.entries(table)) {
        if (request.query.includes(needle)) {
          match = sources
          break
        }
      }
      return { sources: match, truncated: false }
    },
    async fetch() {
      return { url: '', statusCode: 200, body: { kind: 'text', content: '' }, truncated: false }
    },
  }
}

/**
 * An llm stub that answers with a fixed JSON per topic, recording each prompt.
 *
 * Two kinds of prompt reach the model now — the grey-zone relevance veto and the
 * per-topic summary — so the stub answers each with the shape that prompt asks
 * for. A single fixed answer would be fed to the wrong one.
 */
function fakeLlm(answer, { veto = [], review = [] } = {}) {
  const prompts = []
  const systems = []
  return {
    prompts,
    systems,
    vetoPrompts: [],
    reviewPrompts: [],
    listProviders: () => [{ id: 'test-provider' }],
    listModels: async () => [{ id: 'test-model' }],
    resolveModelInfo: async () => ({}),
    async *stream(request) {
      const text = request.messages?.[0]?.content?.[0]?.text ?? ''
      const system = typeof request.system === 'string' ? request.system : ''
      const isVeto = system.includes('screening search results')
      const isReview = system.includes('reviewing candidate news stories')
      if (isVeto) {
        this.vetoPrompts.push(text)
        yield { type: 'text-delta', text: JSON.stringify({ drop: veto }) }
      } else if (isReview) {
        this.reviewPrompts.push(text)
        yield { type: 'text-delta', text: JSON.stringify({ drop: review }) }
      } else {
        prompts.push(text)
        systems.push(system)
        yield { type: 'text-delta', text: JSON.stringify(answer) }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('outletPlan labels an unnamed outlet from its host', () => {
  const plan = outletPlan('https://www.example.com/story')
  assert.equal(plan.label, 'Example')
  assert.equal(plan.kind, 'outlet')
})

test('runDigest searches each topic, ranks, and summarizes', async () => {
  const day = localDay()
  const web = fakeWeb({
    'site:cnn.com': [
      { url: 'https://cnn.com/1', title: 'OpenAI releases GPT-6 with 1M context', snippet: 'The model ships.', publishedAt: day },
    ],
    'AI News news': [
      { url: 'https://example.com/2', title: 'OpenAI releases GPT-6 with 1M context window', snippet: '', publishedAt: day },
    ],
  })
  const llm = fakeLlm({ brief: 'GPT-6 shipped.', stories: [{ id: 1, line: 'OpenAI released GPT-6.' }] })

  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm,
    provider: 'test-provider',
    model: 'test-model',
    limits: { deadlineMs: 20_000, llmTimeoutMs: 5_000 },
  })

  assert.equal(digest.topics.length, 1)
  const topic = digest.topics[0]
  assert.equal(topic.topic, 'AI News')
  assert.equal(topic.summarized, true)
  assert.equal(topic.brief, 'GPT-6 shipped.')
  assert.equal(topic.stories.length, 1)
  // Both hits are the same event, so one story carried by two sources.
  assert.equal(topic.stories[0].sourceCount, 2)
  assert.equal(topic.stories[0].line, 'OpenAI released GPT-6.')
  assert.equal(digest.model, 'test-model')
})

test('runDigest falls back to the ranking when no model is available', async () => {
  const web = fakeWeb({
    'site:cnn.com': [{ url: 'https://cnn.com/1', title: 'A sufficiently long headline about chips', snippet: 'Details.', publishedAt: localDay() }],
  })
  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  assert.equal(digest.topics[0].summarized, false)
  assert.equal(digest.topics[0].stories.length, 1)
  assert.equal(digest.topics[0].stories[0].line, 'Details.')
})

test('runDigest reports an empty topic without failing the run', async () => {
  const web = fakeWeb({})
  const digest = await runDigest({
    topics: ['Nothing Happens'],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 10_000 },
  })
  assert.equal(digest.topics[0].stories.length, 0)
  assert.equal(digest.topics[0].reason, 'no results')
})

test('runDigest survives a search that throws', async () => {
  const web = {
    async search() {
      throw new Error('provider down')
    },
    async fetch() {
      throw new Error('nope')
    },
  }
  const digest = await runDigest({
    topics: ['AI'],
    sources: ['reddit'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 10_000 },
  })
  assert.equal(digest.topics.length, 1)
  assert.equal(digest.topics[0].stories.length, 0)
})

test('runDigest includes an open sweep beyond the named sources', async () => {
  const web = fakeWeb({
    'AI News news': [{ url: 'https://other.com/x', title: 'OpenAI ships a new model to developers', snippet: '', publishedAt: localDay() }],
  })
  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 10_000 },
  })
  // The open sweep must be dated, not a bare topic: a bare topic returns
  // definitions, which is the reported bug.
  assert.ok(
    web.queries.some((query) => query.startsWith('AI News news ') && /\d{4}$/.test(query)),
    `an open query must ask for news on a specific day; got ${JSON.stringify(web.queries.slice(0, 4))}`,
  )
  assert.ok(web.queries.some((query) => query.includes('Anthropic')), 'the AI beat must sweep its organisations')
  assert.equal(digest.topics[0].stories.length, 1)
  // The unnamed outlet is credited to its own host, not to CNN.
  assert.deepEqual(digest.topics[0].stories[0].sources, ['Other'])
})

test('a large Top reaches the model intact instead of being cut at the prompt budget', async () => {
  // 30 genuinely distinct stories — more than the old fixed budget of 24. The
  // headlines must not look like one event, or the grouping would correctly
  // fold them and the test would be measuring the wrong thing. They must also
  // be on-topic, because the relevance screen runs before ranking: an unrelated
  // headline is dropped, which is the behaviour a different test pins.
  const subjects = [
    'Nvidia unveils a rack scale inference accelerator',
    'Regulators open an inquiry into model licensing terms',
    'A robotics startup raises a Series B round for warehouse arms',
    'Researchers publish a long context reasoning benchmark',
    'Chip export rules tighten across three jurisdictions',
    'A hospital network deploys AI triage software nationwide',
    'Open source weights ship for a small speech model',
    'An AI supplier recalls a faulty sensor module',
    'Cloud provider announces a new AI inference region',
    'University lab demonstrates a photonic AI interconnect',
    'Battery maker expands a plant for AI datacenter storage',
    'A standards body ratifies a new model evaluation spec',
    'Insurer prices cyber risk with machine learning telemetry',
    'A satellite operator uses AI to plan a launch window',
    'Retailer replaces its warehouse picking fleet with robots',
    'Drug trial reports an AI-discovered secondary endpoint',
    'A browser vendor ships an on-device AI sandbox change',
    'Telecom operator auctions spectrum for AI edge inference',
    'A compiler team lands a new tensor register allocator',
    'Shipping line reroutes around a canal closure with AI planning',
    'A payments network publishes new fraud detection model rules',
    'An airport tests biometric boarding gates with vision models',
    'A grid operator commissions AI-driven storage capacity',
    'A publisher settles a copyright dispute over training data',
    'A chip foundry reports a yield improvement for AI accelerators',
    'A weather agency upgrades its forecast model',
    'A logistics firm automates customs paperwork with language models',
    'A museum restores a manuscript using AI imaging',
    'A utility pilots residential demand response with AI forecasting',
    'A university opens a semiconductor research center for AI chips',
  ]
  const sources = subjects.map((title, index) => ({
    url: `https://outlet${index}.com/story`,
    title,
    snippet: '',
    // Dated: the newsworthiness screen keeps undated pages only when they carry
    // an event verb, and this fixture is about the prompt budget, not about the
    // news judgement.
    publishedAt: localDay(),
  }))
  const web = fakeWeb({ 'site:cnn.com': sources })
  const llm = fakeLlm({ brief: 'Many things.', stories: [] })

  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 30,
    web,
    llm,
    provider: 'test-provider',
    model: 'test-model',
    limits: { deadlineMs: 20_000, llmTimeoutMs: 5_000 },
  })

  assert.equal(digest.storyBudget, 30, 'the run reports the budget it used')
  assert.equal(digest.topics[0].stories.length, 30, 'all 30 stories must survive ranking')
  const prompt = llm.prompts[0] ?? ''
  const described = (prompt.match(/^\[\d+\]/gm) ?? []).length
  assert.equal(described, 30, `every one of the 30 stories must be described (got ${described})`)
  assert.match(prompt, /\[30\]/, 'the last story must be in the prompt')
})

/**
 * Today as the digest defines it: the LOCAL calendar day.
 *
 * `toISOString()` is UTC, so for a few hours every evening (in any zone west of
 * Greenwich) it names tomorrow and every "today" assertion here flips. The
 * digest compares local days, so the fixture must build the same one.
 * @returns {string} `YYYY-MM-DD` in local time.
 */
function localDay() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

test('the digest links to the same-day article, never the section page', async () => {
  // The reported bug: a site: query returns the /research section first, so the
  // digest linked to "OpenAI Research" instead of the news published that day.
  const iso = localDay()
  const web = fakeWeb({
    'site:openai.com': [
      { url: 'https://openai.com/research', title: 'OpenAI Research', snippet: '' },
      {
        url: 'https://openai.com/index/introducing-gpt-6',
        title: 'Introducing GPT-6',
        snippet: 'Our new model ships today.',
        publishedAt: iso,
      },
    ],
  })
  const llm = fakeLlm({ brief: 'GPT-6 shipped.', stories: [{ id: 1, line: 'OpenAI released GPT-6.' }] })

  const digest = await runDigest({
    topics: ['OpenAI'],
    sources: ['openai.com'],
    top: 5,
    web,
    llm,
    provider: 'test-provider',
    model: 'test-model',
    limits: { deadlineMs: 20_000, llmTimeoutMs: 5_000 },
  })

  const stories = digest.topics[0].stories
  assert.equal(stories.length, 1, 'the section page must not become a second story')
  assert.equal(stories[0].url, 'https://openai.com/index/introducing-gpt-6', 'the link must be the article')
  assert.equal(stories[0].sameDay, true, 'the article is today’s news')
  assert.ok(typeof stories[0].publishedAt === 'string' && stories[0].publishedAt.startsWith(iso), 'the publication date travels with the story')
  assert.equal(digest.day, iso, 'the digest reports the day it covers')
})

test('the queries ask for the day, and a category topic sweeps its organisations', async () => {
  // The reported bug: a day with the biggest IPO in history produced "no
  // concrete news" under "AI News", because every query was the bare topic and
  // returned definitions (Britannica, tool directories) instead of reporting.
  const web = fakeWeb({})
  await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com', 'BBC.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })

  const queries = web.queries
  // A query without the day is allowed only as a *fallback*: the skill's broader
  // phrasings, which run only because the dated plan found nothing. Those are
  // deliberately undated — a brittle date is the thing being escaped.
  const dated = queries.filter((query) => /[A-Z][a-z]+ \d{1,2} \d{4}|site:[a-z.]+/.test(query))
  assert.ok(dated.length > 0, 'the plan must send dated queries')
  for (const query of dated) {
    assert.match(query, /[A-Z][a-z]+ \d{1,2} \d{4}$|site:[a-z.]+$/, `no day in query: ${query}`)
  }
  // 2. The bare topic must never be the whole plan; it may only be a fallback.
  assert.ok(dated.includes('AI News') === false, 'the bare topic must not be a dated query')
  // 3. A category topic must sweep the organisations that make its news.
  assert.ok(queries.some((query) => query.includes('Anthropic')), 'Anthropic must be swept for the AI beat')
  assert.ok(queries.some((query) => query.includes('OpenAI')))
  // 4. The named sources must still be asked, with the day attached.
  assert.ok(queries.some((query) => query.includes('site:cnn.com') && /2026|20\d\d/.test(query)))
})

test('a topic whose plan finds nothing retries once with the broader queries', async () => {
  // A precise, date-bounded query is brittle. When the plan returns nothing the
  // skill's fallbacks are tried, so a reachable topic is not reported empty.
  const seen = []
  const web = {
    async search(request) {
      seen.push(request.query)
      // Only the undated fallback shapes return anything.
      const dated = /[A-Z][a-z]+ \d{1,2} \d{4}/.test(request.query) || request.query.includes('site:')
      if (dated) return { sources: [], truncated: false }
      return {
        sources: [{ url: 'https://example.com/a', title: 'OpenAI launches a model', snippet: '', publishedAt: localDay() }],
        truncated: false,
      }
    },
    async fetch() {
      return { url: '', statusCode: 200, body: { kind: 'text', content: '' }, truncated: false }
    },
  }
  const digest = await runDigest({
    topics: [{ topic: 'AI News', guidance: 'OpenAI launches' }],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  const topic = digest.topics[0]
  assert.ok(topic.stories.length > 0, `the fallback must rescue the topic; queries were ${JSON.stringify(seen.slice(0, 8))}`)
  // The undated shapes only appear after the dated plan failed.
  const undated = seen.filter((query) => !/[A-Z][a-z]+ \d{1,2} \d{4}/.test(query) && !query.includes('site:'))
  assert.ok(undated.length > 0, 'the retry must use an undated fallback')
  assert.equal(topic.filtered.viaFallback >= 1, true, 'the digest must record that the fallback found it')
})

test('the Anthropic IPO story survives screening when the new queries find it', () => {
  // The exact headlines the dated, entity-swept queries return for 2026-10-26.
  // None of them says "AI News"; the entity sweep is what surfaces them, and the
  // relevance screen must not throw them away.
  const hits = [
    { title: 'Anthropic files for potentially the biggest IPO ever as CEO warns of risk to humanity from AI', url: 'https://apnews.com/article/anthropic-ipo', snippet: 'Artificial intelligence giant Anthropic filed paperwork Monday.' },
    { title: 'AI giant Anthropic files for an IPO that could break records', url: 'https://www.npr.org/2026/10/26/anthropic-ai-ipo', snippet: 'The AI company, which makes the Claude chatbot, has filed for an initial public offering.' },
    { title: "What's Riding on Anthropic Going Public? Nearly Everything.", url: 'https://www.nytimes.com/2026/10/26/technology/anthropic-going-public-stakes.html', snippet: 'Its initial public offering will have widespread implications.' },
    { title: 'Anthropic officially files for its public debut', url: 'https://techcrunch.com/2026/10/26/anthropic-officially-files/', snippet: 'Anthropic officially files for its public debut.' },
  ]
  const screened = screenTopic('AI News', hits)
  assert.equal(screened.dropped.length, 0, 'every real IPO story must survive the screen')
  assert.equal(screened.kept.length, hits.length)
  for (const hit of screened.kept) {
    assert.ok(
      hit.relevance.decision === 'keep' || hit.relevance.decision === 'grey',
      `${hit.title} must not be dropped`,
    )
  }
})

test('guidance keywords reach the search queries', async () => {
  const web = fakeWeb({})
  await runDigest({
    topics: [{ topic: 'LLM Local Deployment', guidance: 'only vLLM and llama.cpp, skip tutorials' }],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  // The user's own terms must be searched, not just the topic label: that is the
  // whole point of guidance for a vague topic.
  assert.ok(web.queries.some((query) => /vllm/i.test(query)), `a guidance keyword must reach a query; got ${JSON.stringify(web.queries.slice(0, 6))}`)
  assert.ok(web.queries.some((query) => /llama\.cpp/i.test(query)))
  // The topic is still searched, so guidance narrows rather than replaces.
  assert.ok(web.queries.some((query) => query.startsWith('LLM Local Deployment news')))
})

test('guidance exclusions remove hits the user asked not to see', async () => {
  const day = localDay()
  const web = fakeWeb({
    'AI News news': [
      { url: 'https://example.com/news', title: 'OpenAI launches a new model', snippet: '', publishedAt: day },
      // Relevant to the topic, and explicitly excluded by the guidance: this is
      // the case that must be removed by the guidance rather than by relevance.
      { url: 'https://example.com/tutorial', title: 'OpenAI tutorial on prompt engineering', snippet: '', publishedAt: day },
    ],
  })
  const digest = await runDigest({
    topics: [{ topic: 'AI News', guidance: 'OpenAI model launches, skip tutorials' }],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  const titles = digest.topics[0].stories.map((story) => story.title)
  assert.ok(!titles.some((title) => /tutorial/i.test(title)), 'the excluded tutorial must not be in the digest')
  assert.ok(titles.some((title) => /OpenAI launches/i.test(title)), 'the wanted story must survive')
  assert.ok(digest.topics[0].filtered.excluded >= 1, 'the exclusion must be reported, not silent')
})

test('guidance is echoed on the topic so the page can show what was searched', async () => {
  const web = fakeWeb({})
  const digest = await runDigest({
    topics: [{ topic: 'AI News', guidance: 'only funding rounds' }],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  assert.equal(digest.topics[0].guidance, 'only funding rounds')
})

test('a topic without guidance still runs, and echoes an empty guidance', async () => {
  const day = localDay()
  const web = fakeWeb({
    'AI News news': [{ url: 'https://example.com/a', title: 'OpenAI launches a model', snippet: '', publishedAt: day }],
  })
  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  assert.equal(digest.topics[0].guidance, '')
  assert.equal(digest.topics[0].stories.length, 1, 'a bare topic string must still work')
})

test('the summarizer prompt carries the guidance as editorial direction', async () => {
  const day = localDay()
  const web = fakeWeb({
    'AI News news': [{ url: 'https://example.com/a', title: 'OpenAI launches a model', snippet: '', publishedAt: day }],
  })
  const llm = fakeLlm({ brief: 'x', stories: [] })
  await runDigest({
    topics: [{ topic: 'AI News', guidance: 'focus on model releases, not policy' }],
    sources: ['CNN.com'],
    top: 3,
    web,
    llm,
    provider: 'test-provider',
    model: 'test-model',
    limits: { deadlineMs: 20_000, llmTimeoutMs: 5_000 },
  })
  // With guidance the run makes two model calls per topic: the review, then the
  // summarizer. The summarizer's guidance line is the one under test here.
  assert.ok(llm.prompts.length >= 1, 'the summarizer must be called')
  const summarizer = llm.prompts[0]
  assert.match(summarizer, /focus on model releases, not policy/, 'the model must see the guidance verbatim')
  assert.match(summarizer, /Reader guidance for this topic:/, 'the guidance must be labelled, not appended as a stray line')
})

test('a topic with guidance is reviewed against that guidance before summarizing', async () => {
  const day = localDay()
  const web = fakeWeb({
    'AI News news': [
      { url: 'https://example.com/keep', title: 'OpenAI launches a frontier model', snippet: '', publishedAt: day },
      { url: 'https://example.com/drop', title: 'OpenAI hires a policy lobbyist', snippet: '', publishedAt: day },
    ],
  })
  // The reviewer drops the policy story; the summarizer then writes the brief.
  const llm = fakeLlm({ brief: 'One launch.', stories: [] }, { review: [{ id: 2, reason: 'policy, not a model release' }] })
  const digest = await runDigest({
    topics: [{ topic: 'AI News', guidance: 'model releases only, not policy' }],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm,
    provider: 'test-provider',
    model: 'test-model',
    limits: { deadlineMs: 20_000, llmTimeoutMs: 5_000 },
  })
  assert.equal(llm.reviewPrompts.length, 1, 'the review must run once')
  assert.match(llm.reviewPrompts[0], /model releases only, not policy/, 'the reviewer sees the guidance verbatim')
  assert.match(llm.reviewPrompts[0], /Criteria:/, 'the reviewer is given criteria, not just a topic')
  const titles = digest.topics[0].stories.map((story) => story.title)
  assert.ok(!titles.some((title) => /lobbyist/.test(title)), `the reviewed-out story must be gone; got ${JSON.stringify(titles)}`)
  assert.ok(titles.some((title) => /launches a frontier model/.test(title)), 'the wanted story must survive the review')
})

test('a review that drops every candidate is ignored rather than emptying the topic', async () => {
  // A confused or hostile reply must not blank a topic the deterministic screens
  // already accepted.
  const day = localDay()
  const web = fakeWeb({
    'AI News news': [{ url: 'https://example.com/a', title: 'OpenAI launches a model', snippet: '', publishedAt: day }],
  })
  const llm = fakeLlm({ brief: 'x', stories: [] }, { review: [{ id: 1, reason: 'nope' }] })
  const digest = await runDigest({
    topics: [{ topic: 'AI News', guidance: 'model releases' }],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm,
    provider: 'test-provider',
    model: 'test-model',
    limits: { deadlineMs: 20_000, llmTimeoutMs: 5_000 },
  })
  assert.equal(digest.topics[0].stories.length, 1, 'the topic must not be emptied by a blanket rejection')
})

test('without a model the plan and the hard filters still work', async () => {
  // The deterministic path must stand on its own: no model means no review, but
  // the query plan and the exclusions are unaffected.
  const day = localDay()
  const web = fakeWeb({
    'AI News news': [
      { url: 'https://example.com/a', title: 'OpenAI launches a model', snippet: '', publishedAt: day },
      { url: 'https://example.com/b', title: 'A tutorial on prompt engineering', snippet: '', publishedAt: day },
    ],
  })
  const digest = await runDigest({
    topics: [{ topic: 'AI News', guidance: 'OpenAI launches, skip tutorials' }],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  const titles = digest.topics[0].stories.map((story) => story.title)
  assert.ok(titles.some((title) => /launches a model/.test(title)), 'the plan still finds the story')
  assert.ok(!titles.some((title) => /tutorial/i.test(title)), 'the hard exclusion still applies')
})

test('a topic with no guidance sends no guidance line to the model', async () => {
  const day = localDay()
  const web = fakeWeb({
    'AI News news': [{ url: 'https://example.com/a', title: 'OpenAI launches a model', snippet: '', publishedAt: day }],
  })
  const llm = fakeLlm({ brief: 'x', stories: [] })
  await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 3,
    web,
    llm,
    provider: 'test-provider',
    model: 'test-model',
    limits: { deadlineMs: 20_000, llmTimeoutMs: 5_000 },
  })
  const prompt = llm.prompts[0] ?? ''
  assert.doesNotMatch(prompt, /Reader guidance for this topic:/, 'no empty guidance line may be sent')
})

test('a failed search is reported, never passed off as an empty day', async () => {
  // The reported bug: the search service was broken, every search threw, and the
  // run reported success with zero stories. The page showed "no news found", which
  // reads as a quiet news day rather than a broken run.
  const web = {
    async search() {
      throw new Error('configured web provider "ddg" is not registered')
    },
    async fetch() {
      return { url: '', statusCode: 200, body: { kind: 'text', content: '' }, truncated: false }
    },
  }
  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  const note = digest.notes?.searches
  assert.ok(note !== undefined, 'a failed search must be reported on the digest')
  assert.ok(note.failed > 0, 'the failure count must be non-zero')
  assert.ok(note.of >= note.failed, 'the total must include the failures')
  assert.match(String(note.error), /ddg|not registered/, 'the reason must be carried through')
})

test('a missing search service is reported rather than silently empty', async () => {
  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 5,
    web: undefined,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  assert.ok(digest.notes?.searches !== undefined, 'a missing service must be reported')
  assert.match(String(digest.notes.searches.error), /unavailable/)
})

test('a successful run carries no search-failure note', async () => {
  const day = localDay()
  const web = fakeWeb({
    'AI News news': [{ url: 'https://example.com/a', title: 'OpenAI launches a model', snippet: '', publishedAt: day }],
  })
  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 5,
    web,
    llm: null,
    limits: { deadlineMs: 20_000 },
  })
  assert.equal(digest.notes?.searches, undefined, 'a healthy run must not claim a failure')
})

test('the prompt tells the model the date and that a story is an article', async () => {
  const iso = localDay()
  const web = fakeWeb({
    'site:cnn.com': [
      { url: 'https://cnn.com/2026/10/26/tech/chip-rules', title: 'Chip rules tighten', snippet: '', publishedAt: iso },
    ],
  })
  const llm = fakeLlm({ brief: 'x', stories: [] })
  await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 3,
    web,
    llm,
    provider: 'test-provider',
    model: 'test-model',
    limits: { deadlineMs: 20_000, llmTimeoutMs: 5_000 },
  })
  const prompt = llm.prompts[0] ?? ''
  assert.match(prompt, new RegExp(`Date of the digest: ${iso}`), 'the prompt must state the day')
  assert.match(prompt, /published: \d{4}-\d{2}-\d{2}/, 'each story must carry its publication date')
})
