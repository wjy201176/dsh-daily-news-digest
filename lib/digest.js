/**
 * Daily News Digest — one digest run, from topics and sources to ranked topics.
 *
 * A run is: for every topic, ask every source; attribute each hit back to the
 * source that carried it; measure what can be measured; rank by source count and
 * reads; then let the model write the brief and fold duplicate events. Sources
 * the user did not name are welcome — a hit that no named source claims is still
 * a story, credited to its own outlet.
 *
 * Everything is bounded. A digest with ten topics and ten sources would be a
 * hundred searches, so queries run under a concurrency cap, a deadline, and a
 * per-topic result cap; a run that hits the deadline still returns what it has.
 */

import { attribute, DEFAULT_REACH, labelForHost, normalizeHost, openQueries, plansForSources, queryFor } from './sources.js'
import { rankTopic } from './cluster.js'
import { engagementFromHtml, engagementFromSnippet, measurable } from './engagement.js'
import { freshnessOf, isArticleUrl, todayKey } from './recency.js'
import { screenTopic } from './relevance.js'
import { screenNews } from './newsworthiness.js'
import { exclusionHit, parseGuidance } from './guidance.js'
import { describeCookies } from './cookies.js'
import { fetchAuthenticated, needsAuth } from './fetch-auth.js'
import {
  applyMerges,
  buildRelevancePrompt,
  buildTopicPrompt,
  fallbackTopicDigest,
  parseRelevanceReply,
  parseTopicReply,
  storyBudget,
} from './summary.js'

/** Defaults for one run; the profile patch may override any of them. */
export const DEFAULTS = {
  searchConcurrency: 4,
  fetchConcurrency: 3,
  perTopicResults: 6,
  deadlineMs: 180_000,
  fetchBudget: 24,
  searchTimeoutMs: 20_000,
  fetchTimeoutMs: 12_000,
  llmTimeoutMs: 90_000,
  /** 0 keeps only stories dated today; a hit with no date is still kept. */
  maxAgeDays: 0,
  /** Page fetches that use the user's Edge cookies, per run. */
  authBudget: 16,
}

/** Run `tasks` with at most `limit` in flight; rejections become `undefined`. */
async function mapLimited(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await task(items[index], index)
      } catch {
        results[index] = undefined
      }
    }
  })
  await Promise.all(workers)
  return results
}

/** A per-run clock. */
function clock(deadlineMs) {
  const endsAt = Date.now() + deadlineMs
  return {
    get expired() {
      return Date.now() >= endsAt
    },
    get remaining() {
      return Math.max(0, endsAt - Date.now())
    },
    endsAt,
  }
}

/** Bound one promise by a timeout, resolving `fallback` instead of throwing. */
function bounded(promise, ms, fallback) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(1, ms))
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * A plan for an outlet the user did not name.
 * @param {string} url - the result URL.
 * @returns {object} a synthetic plan.
 */
export function outletPlan(url) {
  const host = normalizeHost(url)
  return {
    id: `outlet:${host}`,
    label: labelForHost(host),
    kind: 'outlet',
    hosts: [host],
    query: '',
    reach: DEFAULT_REACH,
    synthetic: true,
  }
}

/**
 * Collect the hits for one topic.
 * @param {object} input - the run input.
 * @param {string} topic - one topic.
 * @param {object[]} plans - the named source plans.
 * @param {object} run - `{ web, limits, clock, logger }`.
 * @returns {Promise<object[]>} attributed hits.
 */
async function collectTopic(input, topic, plans, run) {
  const queries = []
  const guidance = input.guidance ?? null
  // Each named source is asked its own question, so a source that reports the
  // topic differently still surfaces; the union is what the ranking counts. The
  // day rides along so the query asks for that day's reporting rather than a
  // definition of the topic.
  for (const plan of plans) {
    const query = queryFor(topic, plan, run.day, guidance)
    if (query !== '') queries.push({ query, plan })
  }
  // "as well as any other sources valuable": the open queries are what find the
  // day's biggest story even when no named source carried it.
  for (const query of openQueries(topic, run.day, guidance)) queries.push({ query, plan: null })

  const deadline = run.clock.endsAt - Date.now()
  const searchBudget = Math.min(run.limits.searchTimeoutMs, Math.max(1_000, deadline))

  // A search that fails must not look like a search that found nothing. The two
  // are indistinguishable downstream — both leave a topic with zero stories — so
  // failures are collected and reported on the digest instead of being swallowed
  // into an empty result the page shows as "no news found".
  const failures = []
  const responses = await mapLimited(queries, run.limits.searchConcurrency, async (entry) => {
    if (run.clock.expired) return undefined
    if (run.web === undefined || run.web === null || typeof run.web.search !== 'function') {
      failures.push({ query: entry.query, error: 'the search service is unavailable' })
      return undefined
    }
    return bounded(
      run.web.search({ query: entry.query, maxResults: run.limits.perTopicResults }, AbortSignal.timeout(searchBudget)),
      searchBudget + 500,
      undefined,
    ).catch((error) => {
      failures.push({ query: entry.query, error: String(error?.message ?? error) })
      return undefined
    })
  })
  if (failures.length > 0) {
    run.notes.searches = {
      failed: failures.length,
      of: queries.length,
      error: failures[0].error,
      query: failures[0].query,
    }
    run.logger?.warn?.(
      `daily-news-digest: ${failures.length}/${queries.length} searches failed for "${topic}" — first: ${failures[0].error} (${failures[0].query})`,
    )
  }

  const hits = []
  const seen = new Set()
  const outletPlans = new Map()
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index]
    if (response === undefined || response === null) continue
    const asked = queries[index]
    for (const source of response.sources ?? []) {
      const url = String(source?.url ?? '')
      if (url === '') continue
      const key = `${url}`
      const title = String(source?.title ?? '').trim()
      if (!/^https?:/i.test(url)) continue

      // Attribution: the named source that asked this query wins when it matches
      // (a site: query returns that site), otherwise any plan whose hosts match,
      // otherwise the outlet itself.
      let plan = null
      if (asked.plan !== null && asked.plan.hosts.length > 0) {
        const matched = attribute(url, title, [asked.plan])
        if (matched !== null) plan = matched
      }
      if (plan === null) plan = attribute(url, title, plans)
      if (plan === null) {
        const outlet = outletPlan(url)
        if (!outletPlans.has(outlet.id)) outletPlans.set(outlet.id, outlet)
        plan = outletPlans.get(outlet.id)
      }

      const dedupe = `${key}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)

      const engagement = engagementFromSnippet(source?.snippet)
      const hit = {
        url,
        title,
        snippet: String(source?.snippet ?? '').trim(),
        publishedAt: typeof source?.publishedAt === 'string' ? source.publishedAt : '',
        planId: plan.id,
        planLabel: plan.label,
        // The publisher, for counting independent sources: a plan is *how we
        // searched*, and two plans can name the same publisher.
        outlet: plan.label,
        reach: plan.reach,
        position: hits.length % run.limits.perTopicResults,
        engagement,
      }
      // Judge the hit once, here: whether the URL addresses one article and
      // whether its date says today. Ranking and link choice both read these.
      hit.isArticle = isArticleUrl(url)
      hit.freshness = freshnessOf(hit, run.now)
      hits.push(hit)
    }
  }
  return hits
}

/**
 * Enrich hits from login-walled sources with the page the user can actually see.
 *
 * A search engine indexes x.com and zhihu.com, but the page it links to is a
 * sign-in wall for an anonymous client. With the user's Edge cookies the same URL
 * returns the real post, which gives the digest a real title, a real snippet and
 * a real publication date instead of "Log in to X".
 *
 * This is bounded like every other fetch: a budget, a timeout, and a hard stop
 * when the run's deadline passes. A source that stays walled is left as it was
 * and reported, never silently dropped.
 * @param {object} run - `{ jar, limits, clock, logger, notes }`.
 * @param {object[]} hits - the hits for one topic.
 * @returns {Promise<void>} mutates hits in place.
 */
async function authenticateTopic(run, hits) {
  if (run.jar === null || run.jar === undefined) return
  const targets = []
  for (const hit of hits) {
    if (!needsAuth(hit.url)) continue
    if (run.authBudget <= 0) break
    run.authBudget -= 1
    targets.push(hit)
  }
  if (targets.length === 0) return

  const snapshot = await run.jar.get()
  if (snapshot.ok !== true) {
    // One note per run, not one per hit: the reason is the same for all of them.
    if (run.notes.cookies === undefined) {
      run.notes.cookies = describeCookies(snapshot).note
    }
    return
  }

  await mapLimited(targets, run.limits.fetchConcurrency, async (hit) => {
    if (run.clock.expired) return undefined
    const budget = Math.min(run.limits.fetchTimeoutMs, Math.max(1_000, run.clock.remaining))
    const page = await fetchAuthenticated(hit.url, run.jar, { timeoutMs: budget, signal: AbortSignal.timeout(budget + 500) }).catch(() => null)
    if (page === null) return undefined
    if (page.ok !== true) {
      if (page.wall === true && run.notes.walls === undefined) run.notes.walls = page.reason
      return undefined
    }
    // The signed-in page is the authority for the headline and the lede: the
    // search engine's copy is often the wall's text.
    if (typeof page.title === 'string' && page.title !== '') hit.title = page.title
    if (typeof page.text === 'string' && page.text !== '') hit.snippet = page.text.slice(0, 400)
    // A page that only renders behind a session may also carry a date the
    // search index never saw.
    const fresh = freshnessOf({ ...hit, snippet: page.text ?? '' }, run.now)
    if (fresh.dated === true) hit.freshness = fresh
    hit.authenticated = true
    return undefined
  })
}

/**
 * Measure engagement for hits whose host publishes a number.
 *
 * Fetching is expensive and rate-limited, so only the story's lead link is
 * fetched, only for hosts that expose a score, and only until the budget runs
 * out. A failed fetch is simply no measurement.
 * @param {object} run - `{ web, limits, clock, logger }`.
 * @param {object[]} hits - the hits for one topic.
 * @returns {Promise<void>} mutates hits in place.
 */
async function measureTopic(run, hits) {
  const targets = []
  for (const hit of hits) {
    if (hit.engagement !== null && hit.engagement !== undefined) continue
    if (!measurable(hit.url)) continue
    if (run.fetchBudget <= 0) break
    run.fetchBudget -= 1
    targets.push(hit)
  }
  if (targets.length === 0) return

  await mapLimited(targets, run.limits.fetchConcurrency, async (hit) => {
    if (run.clock.expired) return undefined
    const budget = Math.min(run.limits.fetchTimeoutMs, Math.max(1_000, run.clock.remaining))
    const page = await bounded(
      run.web.fetch({ url: hit.url }, AbortSignal.timeout(budget)),
      budget + 500,
      undefined,
    )
    const content = page?.body?.content
    if (typeof content !== 'string' || content === '') return undefined
    const reading = engagementFromHtml(content)
    if (reading !== null) hit.engagement = reading
    return undefined
  })
}

/**
 * Ask the model for one topic's brief and merge plan.
 * @param {object} llm - the harness LLM service.
 * @param {string} provider - the provider id.
 * @param {string} model - the model id.
 * @param {string} topic - the topic text.
 * @param {object[]} stories - ranked stories with ids.
 * @param {object} run - `{ limits, clock, logger }`.
 * @returns {Promise<object|null>} the parsed reply, or null.
 */
async function summarizeTopic(llm, provider, model, topic, stories, run, top, guidance = '') {
  if (typeof llm?.stream !== 'function') return null
  const { system, user } = buildTopicPrompt(topic, stories, storyBudget(top), run.day ?? '', guidance)
  const budget = Math.min(run.limits.llmTimeoutMs, Math.max(1_000, run.clock.remaining))

  let text = ''
  let failure = null
  try {
    for await (const chunk of llm.stream({
      provider,
      model,
      system,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin:dsh-daily-news-digest' },
        },
      ],
      maxTokens: 2_400,
      signal: AbortSignal.timeout(budget),
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && text === '') {
        text = chunk.block.text
      } else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
        failure = String(chunk.reason.failure?.message ?? 'the summarizer failed')
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError' && text.trim() !== '') {
      // A partial answer is still usable.
      return parseTopicReply(text)
    }
    throw error
  }
  if (failure !== null && text.trim() === '') throw new Error(failure)
  if (text.trim() === '') return null
  return parseTopicReply(text)
}

/**
 * Ask the model to veto off-topic hits the lexical screen could not settle.
 *
 * Only the grey zone is offered — hits with some topic vocabulary but no
 * conclusive evidence. A failure here is not a failure of the run: the lexical
 * screen already kept the digest honest, so a model that is slow, unavailable,
 * or confused simply means the grey hits stay as they are, marked unconfirmed.
 * @param {object} input - `{ llm, provider, model }`.
 * @param {string} topic - the topic text.
 * @param {object[]} hits - the screened hits, with `id` on the grey ones.
 * @param {object} run - `{ limits, clock, logger }`.
 * @returns {Promise<object[]>} the surviving hits.
 */
async function vetoGreyZone(input, topic, hits, run) {
  const grey = hits.filter((hit) => hit.relevance?.decision === 'grey')
  if (grey.length === 0) return hits
  if (typeof input.llm?.stream !== 'function') return hits
  if (run.clock.expired) return hits

  const offered = grey.map((hit, index) => ({ ...hit, id: index + 1 }))
  const { system, user } = buildRelevancePrompt(topic, offered)
  const budget = Math.min(run.limits.llmTimeoutMs, Math.max(1_000, run.clock.remaining))

  let text = ''
  try {
    for await (const chunk of input.llm.stream({
      provider: input.provider,
      model: input.model,
      system,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin:dsh-daily-news-digest' },
        },
      ],
      maxTokens: 600,
      signal: AbortSignal.timeout(budget),
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && text === '') {
        text = chunk.block.text
      }
    }
  } catch (error) {
    run.logger?.warn?.(`daily-news-digest: relevance veto for "${topic}" failed — ${String(error?.message ?? error)}`)
    return hits
  }

  const dropped = parseRelevanceReply(text, offered.map((hit) => hit.id))
  if (dropped.size === 0) return hits

  const byId = new Map(offered.map((hit) => [hit.id, hit]))
  const vetoedUrls = new Set([...dropped].map((id) => byId.get(id)?.url).filter((url) => typeof url === 'string'))
  run.logger?.info?.(`daily-news-digest: "${topic}" the model vetoed ${vetoedUrls.size} off-topic hit(s)`)
  return hits.filter((hit) => !vetoedUrls.has(hit.url))
}

/**
 * Drop the hits the user's guidance explicitly excluded.
 *
 * The exclusions are the user's own words ("skip tutorials"), so they are
 * honoured before any other judgement: a page the user asked not to see must not
 * reach the model, however well it scores on relevance or newsworthiness.
 * @param {object[]} hits - the screened hits.
 * @param {object} guidance - a parsed guidance, or null.
 * @returns {{ kept: object[], dropped: object[] }} the survivors and the removed.
 */
function excludeByGuidance(hits, guidance) {
  const excludes = Array.isArray(guidance?.excludes) ? guidance.excludes : []
  if (excludes.length === 0) return { kept: Array.isArray(hits) ? hits : [], dropped: [] }
  const kept = []
  const dropped = []
  for (const hit of hits) {
    const verdict = exclusionHit(hit, excludes)
    if (verdict.excluded) dropped.push({ ...hit, excludedBy: verdict.term })
    else kept.push(hit)
  }
  return { kept, dropped }
}

/**
 * Build the digest for one topic, from collection to the model's brief.
 * @param {object} input - `{ topics, plans, limits, llm, provider, model, top }`.
 * @param {string} topic - one topic.
 * @param {object} run - shared run state.
 * @returns {Promise<object>} a topic digest.
 */
async function digestTopic(input, topic, run) {
  const guidance = input.guidance ?? null
  const hits = await collectTopic(input, topic, input.plans, run)
  /** What the relevance screen removed, carried on every return path. */
  const emptyFiltered = { total: 0, dropped: 0 }
  if (hits.length === 0) {
    return {
      topic,
      guidance: guidance?.note ?? '',
      brief: '',
      stories: [],
      summarized: false,
      reason: 'no results',
      measured: false,
      filtered: emptyFiltered,
    }
  }

  // Relevance first: a hit that is not about the topic must not be ranked,
  // measured, or summarized, however many sources carried it. The screen is
  // lexical and deterministic, and it fails safe — it never empties a digest.
  //
  // The user's guidance widens what counts as relevant: if they wrote "vLLM" and
  // "llama.cpp", a page about vLLM is about this topic for them, even though the
  // topic label alone would not say so.
  const screened = screenTopic(topic, hits, { extraTerms: guidance?.keywords ?? [] })
  const filtered = { total: screened.stats.total, dropped: screened.stats.dropped, kept: screened.stats.kept }
  run.logger?.info?.(
    `daily-news-digest: "${topic}" relevance — kept ${screened.stats.kept}/${screened.stats.total}, dropped ${screened.stats.dropped}`,
  )
  const relevant = screened.kept
  if (relevant.length === 0) {
    return { topic, guidance: guidance?.note ?? '', brief: '', stories: [], summarized: false, reason: 'no relevant news', measured: false, filtered }
  }

  // The guidance's exclusions are the user's own words about what they do not
  // want, so they are applied before anything else is judged: a tutorial the user
  // explicitly excluded must not reach the model, however well it scores.
  const allowed = excludeByGuidance(relevant, guidance)
  filtered.excluded = allowed.dropped.length
  if (allowed.dropped.length > 0) {
    run.logger?.info?.(`daily-news-digest: "${topic}" guidance excluded ${allowed.dropped.length} hit(s)`)
  }
  if (allowed.kept.length === 0) {
    return { topic, guidance: guidance?.note ?? '', brief: '', stories: [], summarized: false, reason: 'no news found', measured: false, filtered }
  }
  // The lexical screen cannot tell "model licensing terms" from "forecast
  // model": both say "model". The model can, so the grey zone gets a second
  // opinion before anything is ranked or measured.
  const vetted = await vetoGreyZone(input, topic, allowed.kept, run)
  if (vetted.length === 0) {
    return {
      topic,
      guidance: guidance?.note ?? '',
      brief: '',
      stories: [],
      summarized: false,
      reason: 'no relevant news',
      measured: false,
      filtered: { ...filtered, dropped: screened.stats.total, kept: 0 },
    }
  }

  // Relevance says the page is *about* the topic. This says it is *news*: the
  // second judgement that keeps a Britannica entry, a home page or a tutorial
  // out of the digest even though they are genuinely on-topic.
  const newsy = screenNews(vetted)
  filtered.evergreen = newsy.stats.dropped
  filtered.kinds = newsy.stats.kinds
  run.logger?.info?.(
    `daily-news-digest: "${topic}" newsworthiness — kept ${newsy.stats.kept}/${newsy.stats.total}, dropped ${newsy.stats.dropped}`,
  )
  if (newsy.kept.length === 0) {
    return { topic, guidance: guidance?.note ?? '', brief: '', stories: [], summarized: false, reason: 'no news found', measured: false, filtered }
  }

  // Login-walled sources are read as the signed-in user first: their title,
  // snippet and date come from the real page, not from the search index.
  await authenticateTopic(run, newsy.kept)
  await measureTopic(run, newsy.kept)

  const ranked = rankTopic(topic, newsy.kept, input.top, { maxAgeDays: run.limits.maxAgeDays })
  // Ids are the model's handles for merging and for writing one line per story.
  ranked.forEach((story, index) => {
    story.id = index + 1
  })

  const fallback = (reason) => ({ ...fallbackTopicDigest(topic, ranked, reason), guidance: guidance?.note ?? '', filtered })

  if (input.llm === null) return fallback('no model available')
  if (run.clock.expired) return fallback('the run hit its time limit before summarizing')

  let reply
  try {
    reply = await summarizeTopic(input.llm, input.provider, input.model, topic, ranked, run, input.top, guidance?.note ?? '')
  } catch (error) {
    run.logger?.warn?.(`daily-news-digest: summarizing "${topic}" failed — ${String(error?.message ?? error)}`)
    return fallback(String(error?.message ?? error))
  }
  if (reply === null) return fallback('the model returned no text')

  const merged = applyMerges(ranked, reply.merged)
  const stories = merged.slice(0, input.top).map((story) => ({
    id: story.id,
    title: story.title,
    url: story.url,
    line: reply.lines.get(story.id) ?? (story.snippet !== '' ? story.snippet.slice(0, 220) : ''),
    // The article's publication date travels with the story: it is what makes
    // the link a news item rather than an evergreen section page.
    publishedAt: story.publishedAt ?? null,
    dated: story.dated === true,
    sameDay: story.sameDay === true,
    sources: story.links.map((link) => link.source).filter((name) => name !== ''),
    sourceCount: story.sourceCount,
    reads: story.reads,
    measured: story.measured,
    links: story.links,
  }))

  return {
    topic,
    // The guidance the user wrote for this topic, echoed back so the page can
    // show what the search was told and a stored digest keeps its context.
    guidance: guidance?.note ?? '',
    brief: reply.brief,
    stories,
    summarized: reply.parsed,
    reason: reply.parsed ? '' : 'the model reply was not valid JSON, so its text is shown as the brief',
    measured: stories.some((story) => story.measured),
    filtered,
  }
}

/**
 * Run a whole digest.
 * @param {object} input - `{ topics, sources, top, llm, provider, model, logger, limits, onProgress }`.
 *   `topics` is either a list of names or a list of `{ topic, guidance }`
 *   entries; a bare name is a topic with no guidance.
 * @returns {Promise<object>} the digest document.
 */
export async function runDigest(input) {
  const limits = { ...DEFAULTS, ...(input.limits ?? {}) }
  const topics = Array.isArray(input.topics) ? input.topics : []
  const plans = plansForSources(input.sources)
  const run = {
    web: input.web,
    limits,
    logger: input.logger,
    clock: clock(limits.deadlineMs),
    fetchBudget: limits.fetchBudget,
    authBudget: limits.authBudget,
    // The cookie jar is shared for the whole run: one decrypt, many requests.
    jar: input.jar ?? null,
    // Notes gathered once per run and reported with the digest, so a locked Edge
    // or a source that stayed walled is explained rather than silently thin.
    notes: {},
    // One clock for the whole run: "today" must not shift between topics when a
    // run straddles midnight.
    now: input.now instanceof Date ? input.now : new Date(),
  }
  run.day = todayKey(run.now)

  const startedAt = Date.now()
  const results = []
  // Topics run one after another: each already fans out over its sources, and
  // running topics in parallel only multiplies the same rate limits.
  for (const entry of topics) {
    // A topic may arrive as a bare name or as `{ topic, guidance }`; both shapes
    // are accepted so an older caller keeps working.
    const topic = typeof entry === 'string' ? entry : String(entry?.topic ?? '')
    const guidance = typeof entry === 'string' ? null : parseGuidance(entry?.guidance)
    if (topic === '') continue
    if (run.clock.expired && results.length > 0) {
      results.push({
        topic,
        guidance: guidance?.note ?? '',
        brief: '',
        stories: [],
        summarized: false,
        reason: 'the run hit its time limit before this topic was searched',
        measured: false,
      })
      input.onProgress?.(results.length, topics.length)
      continue
    }
    results.push(
      await digestTopic(
        { topics, plans, top: input.top, llm: input.llm, provider: input.provider, model: input.model, guidance },
        topic,
        run,
      ),
    )
    input.onProgress?.(results.length, topics.length)
  }

  // Per-topic filtering totals, so the page can say how much search noise was
  // removed rather than silently returning a shorter digest. `dropped` counts
  // off-topic hits, `evergreen` counts on-topic pages that were not news; either
  // one alone is worth reporting.
  const filtered = results
    .filter(
      (topic) =>
        (Number.isFinite(topic.filtered?.dropped) && topic.filtered.dropped > 0) ||
        (Number.isFinite(topic.filtered?.evergreen) && topic.filtered.evergreen > 0),
    )
    .map((topic) => ({
      topic: topic.topic,
      dropped: Number.isFinite(topic.filtered?.dropped) ? topic.filtered.dropped : 0,
      ...(Number.isFinite(topic.filtered?.evergreen) && topic.filtered.evergreen > 0
        ? { evergreen: topic.filtered.evergreen }
        : {}),
    }))

  return {
    id: `digest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    /** The calendar day the digest covers, so the page can say what "today" meant. */
    day: todayKey(run.now),
    durationMs: Date.now() - startedAt,
    topics: results,
    top: input.top,
    sources: plans.map((plan) => ({ id: plan.id, label: plan.label, kind: plan.kind })),
    summarized: results.some((topic) => topic.summarized === true),
    model: input.model ?? '',
    partial: run.clock.expired,
    storyBudget: storyBudget(input.top),
    // What the relevance screen removed, so the filtering is visible rather than
    // an unexplained absence.
    filtered,
    // Why a login-walled source may have come back thin, in the user's terms.
    notes: {
      ...(run.notes.cookies === undefined ? {} : { cookies: run.notes.cookies }),
      ...(run.notes.walls === undefined ? {} : { walls: run.notes.walls }),
      // A failed search is a broken run, not an empty day. Saying so is the
      // difference between "there is no news" and "we could not look".
      ...(run.notes.searches === undefined ? {} : { searches: run.notes.searches }),
    },
  }
}
