/**
 * Daily News Digest — grouping search hits into stories and ranking them.
 *
 * One story is reported by several outlets under several headlines. The digest
 * the user asked for ranks a story by (1) how many *different sources* carried
 * it and (2) the total reads across those sources, in that order. That makes
 * grouping the load-bearing step: two hits are the same story when their
 * headlines share enough significant words, and the same URL is always the same
 * story.
 *
 * Headline comparison has to work for English and Chinese without a segmenter,
 * so a headline becomes a token set: lower-cased words for Latin text and
 * overlapping character bigrams for CJK runs.
 */

/** Words that carry no story identity in a headline. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'after', 'before', 'over', 'under', 'into', 'about', 'than', 'then', 'now',
  'new', 'says', 'said', 'say', 'will', 'would', 'can', 'could', 'may', 'might', 'has', 'have',
  'had', 'do', 'does', 'did', 'not', 'no', 'you', 'your', 'we', 'our', 'they', 'their', 'he',
  'she', 'his', 'her', 'how', 'why', 'what', 'when', 'where', 'who', 'more', 'most', 'up',
  'out', 'off', 'via', 'amp', 'news', 'report', 'reports', 'reported', 'update', 'updates',
  'live', 'breaking', 'today', 'yesterday', 'week', 'day', 'year', 'first', 'latest',
])

/** CJK runs are compared as bigrams; a single character carries too little. */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u

/**
 * Split text into comparison tokens.
 * @param {string} text - a headline or snippet.
 * @returns {Set<string>} the significant tokens.
 */
export function tokenize(text) {
  const tokens = new Set()
  const plain = String(text ?? '').toLowerCase().replace(/[\u2018\u2019\u201c\u201d]/g, "'")
  // Latin words and numbers.
  for (const word of plain.match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) {
    const cleaned = word.replace(/[.'-]+$/g, '')
    if (cleaned.length < 3) continue
    if (STOPWORDS.has(cleaned)) continue
    tokens.add(cleaned)
  }
  // CJK: one token per adjacent character pair.
  const runs = plain.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []
  for (const run of runs) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

/**
 * How much two token sets overlap, relative to the smaller one.
 *
 * Relative to the *smaller* set on purpose: outlets pad a headline differently
 * ("OpenAI releases GPT-6" vs "OpenAI's GPT-6 launch: everything announced"),
 * and dividing by the union would call those different stories.
 * @param {Set<string>} left - one token set.
 * @param {Set<string>} right - the other.
 * @returns {number} a score in [0, 1].
 */
export function overlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.min(left.size, right.size)
}

/**
 * The comparison key for a URL: scheme and tracking noise removed.
 * @param {string} url - a result URL.
 * @returns {string} a normalised key.
 */
export function urlKey(url) {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    const drop = []
    for (const [name] of parsed.searchParams) {
      if (/^(utm_|fbclid|gclid|ref|ref_src|source|spm)/i.test(name)) drop.push(name)
    }
    for (const name of drop) parsed.searchParams.delete(name)
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.hostname}${path}${parsed.search}`
  } catch {
    return String(url ?? '')
  }
}

/**
 * Does this headline look like a story rather than a section page?
 * @param {string} title - the result title.
 * @returns {boolean} whether it is usable.
 */
export function usableTitle(title) {
  const text = String(title ?? '').trim()
  if (text.length < 12) return false
  // Navigation and index pages, which search engines return for site: queries.
  if (/^(home|homepage|news|index|all news|latest news|top stories|登录|首页)\b/i.test(text) && text.length < 40) return false
  return true
}

/**
 * Score a hit as a candidate representative link for its story.
 *
 * The digest must link to *the article*, so being an article dominates: no
 * section page may outrank a real article, however old that article is. Recency
 * then separates articles from each other, and "undated" sits between "today"
 * and "old" because an undated article is at least the right kind of page.
 *
 * Search position and engagement are deliberately absent — they break ties in
 * {@link orderHits} — so a section landing page can never win merely by ranking
 * first for a `site:` query.
 * @param {object} hit - one hit, with `freshness` attached.
 * @returns {number} a sortable score; higher is better.
 */
export function linkQuality(hit) {
  const freshness = hit.freshness ?? {}
  // Article-ness is worth more than the whole recency range, so the two never
  // trade off: an article always beats a section page.
  let score = hit.isArticle === true ? 1_000 : 0
  if (freshness.sameDay === true) score += 100
  else if (freshness.dated === true) {
    // Recent-but-not-today still beats undated, but loses to today.
    score += Math.max(1, 50 - Math.max(0, freshness.ageDays ?? 99))
  } else {
    // Undated: the right kind of page, date unknown.
    score += 25
  }
  return score
}

/**
 * Group hits into stories.
 *
 * The first hit of a group is its representative; later hits join the group
 * whose headline is most similar, provided the similarity clears
 * {@link GROUP_THRESHOLD}. A repeated URL always joins its own group, so the
 * same page found by two queries never counts as two sources.
 * @param {object[]} hits - `{ url, title, snippet, planId, planLabel, reach, engagement }`.
 * @param {object} [options] - tuning.
 * @returns {object[]} stories with their hits.
 */
export function groupStories(hits, options = {}) {
  const threshold = options.threshold ?? 0.5
  const stories = []
  const byUrl = new Map()

  for (const hit of Array.isArray(hits) ? hits : []) {
    const url = String(hit.url ?? '')
    if (url === '') continue
    const key = urlKey(url)
    const existing = byUrl.get(key)
    if (existing !== undefined) {
      existing.hits.push(hit)
      addOutlet(existing, hit)
      continue
    }

    const tokens = tokenize(hit.title)
    let best = null
    let bestScore = 0
    for (const story of stories) {
      if (story.planIds.length > 0 && story.planIds.includes(hit.planId) && story.hits.length >= 2) continue
      const score = overlap(story.tokens, tokens)
      if (score > bestScore) {
        bestScore = score
        best = story
      }
    }

    if (best !== null && bestScore >= threshold) {
      best.hits.push(hit)
      best.tokens = union(best.tokens, tokens)
      if (!best.planIds.includes(hit.planId)) best.planIds.push(hit.planId)
      addOutlet(best, hit)
      byUrl.set(key, best)
      continue
    }

    const story = {
      tokens,
      hits: [hit],
      planIds: [hit.planId],
      // Outlets are tracked separately from plans: a plan is *how we searched*
      // (a named source row, or a synthetic per-host outlet), and two plans can
      // describe the same publisher. The ranking counts outlets, because that is
      // what "how many independent sources carried this" actually means.
      outlets: [],
      key,
    }
    addOutlet(story, hit)
    stories.push(story)
    byUrl.set(key, story)
  }

  return stories
}

/**
 * Record the outlet a hit came from.
 *
 * The outlet is the registrable publisher, not the subdomain: `club.autohome.com.cn`
 * and `bbs.autohome.com.cn` are one outlet, and counting them as two would let a
 * single publisher's duplicate listing rank a story as if it were corroborated.
 * @param {object} story - the story being built.
 * @param {object} hit - the hit to attribute.
 */
function addOutlet(story, hit) {
  const outlet = hit.outlet ?? hit.planLabel ?? hit.planId ?? ''
  const name = String(outlet).trim().toLowerCase()
  if (name === '') return
  if (!story.outlets.includes(name)) story.outlets.push(name)
}

/** Union two token sets into a new one. */
function union(left, right) {
  const merged = new Set(left)
  for (const token of right) merged.add(token)
  return merged
}

/**
 * The reads a story has accumulated across its hits.
 *
 * `engagement` is measured when the page exposed a number (points, upvotes,
 * comments) and absent otherwise, in which case the hit contributes a small
 * position-based estimate scaled by the source's reach. The digest marks the
 * total as measured or estimated so the number is never presented as more than
 * it is.
 * @param {object[]} hits - one story's hits.
 * @returns {{ reads: number, measured: boolean, signals: string[] }}
 */
export function readsOf(hits) {
  let reads = 0
  let measured = false
  const signals = []
  for (const hit of hits) {
    const engagement = hit.engagement
    if (engagement !== null && engagement !== undefined && Number.isFinite(engagement.reads) && engagement.reads > 0) {
      reads += engagement.reads
      measured = true
      if (typeof engagement.basis === 'string' && engagement.basis !== '') signals.push(`${hit.planLabel}: ${engagement.basis}`)
      continue
    }
    // No measurement: an early organic result is worth more than a late one, and
    // a result on a bigger outlet is worth more than the same position on a
    // small one. The constants keep this an estimate, well below a measured hit.
    const position = Number.isFinite(hit.position) ? Math.max(0, hit.position) : 4
    const reach = Number.isFinite(hit.reach) ? Math.max(0.5, hit.reach) : 1
    reads += Math.round((6 / (1 + position * 0.35)) * reach)
  }
  return { reads, measured, signals }
}

/**
 * Rank a story's hits so the representative link is the most substantial one.
 *
 * This is what decides which URL the reader clicks, so it prefers a dated
 * article over a section page even when the section page ranked first.
 * @param {object[]} hits - one story's hits.
 * @returns {object[]} the same hits, best first.
 */
export function orderHits(hits) {
  return [...hits].sort((left, right) => {
    const byQuality = linkQuality(right) - linkQuality(left)
    if (byQuality !== 0) return byQuality
    const measuredLeft = left.engagement?.reads ?? 0
    const measuredRight = right.engagement?.reads ?? 0
    if (measuredLeft !== measuredRight) return measuredRight - measuredLeft
    return (left.position ?? 99) - (right.position ?? 99)
  })
}

/**
 * Build the ranked digest for one topic.
 *
 * Every hit is judged before grouping: a section page is not a story, and a
 * story dated days ago is not today's news. Undated hits are kept — a provider
 * that sends no dates must not empty the digest — but they rank below dated
 * ones and are labelled as undated on the page.
 * @param {string} topic - the topic text.
 * @param {object[]} hits - every hit collected for it, with `isArticle` and `freshness`.
 * @param {number} top - how many stories to keep.
 * @param {object} [options] - `{ maxAgeDays }`; 0 keeps only today.
 * @returns {object[]} ranked stories.
 */
export function rankTopic(topic, hits, top, options = {}) {
  const maxAgeDays = Number.isFinite(options.maxAgeDays) ? options.maxAgeDays : 0

  // A section page is never a story: it addresses a listing, not a news item.
  // But a provider whose URLs simply do not look article-shaped must not empty
  // the digest, so section pages are dropped only when a real article survives.
  const all = Array.isArray(hits) ? hits : []
  const articles = all.filter((hit) => hit.isArticle !== false)
  const pool = articles.length > 0 ? articles : all

  // Prefer today's reporting. A hit dated outside the window is dropped only
  // when it is actually dated — an undated hit is unknown, not stale.
  const fresh = pool.filter((hit) => {
    const freshness = hit.freshness
    if (freshness === undefined || freshness.dated !== true) return true
    return (freshness.ageDays ?? 0) <= maxAgeDays
  })
  // If the window leaves nothing, fall back to everything dated rather than
  // showing an empty digest for a topic that clearly has coverage.
  const usable = fresh.length > 0 ? fresh : pool

  const grouped = groupStories(usable)
  const scored = grouped.map((story) => {
    const ordered = orderHits(story.hits)
    const reads = readsOf(story.hits)
    const lead = ordered[0] ?? {}
    const hostCount = new Set(ordered.map((hit) => safeHost(hit.url))).size
    const leadFreshness = lead.freshness ?? {}
    // Distinct publishers, not distinct search plans: one outlet's two
    // subdomains, or the same page found by two queries, is one source.
    const outletCount = story.outlets.length
    return {
      topic,
      title: String(lead.title ?? '').trim(),
      url: String(lead.url ?? ''),
      snippet: String(lead.snippet ?? '').trim().slice(0, 400),
      // The article's own publication date, so the page can show that the link
      // is today's news rather than an evergreen section page.
      publishedAt: leadFreshness.date instanceof Date ? leadFreshness.date.toISOString() : null,
      dated: leadFreshness.dated === true,
      sameDay: leadFreshness.sameDay === true,
      sources: story.outlets.slice(),
      sourceCount: outletCount,
      outletCount: hostCount,
      reads: reads.reads,
      measured: reads.measured,
      signals: reads.signals.slice(0, 6),
      // Carried through so the page can say why a story was kept, and so a
      // grey-zone hit is visible as such rather than silently trusted.
      relevance: lead.relevance ?? null,
      links: ordered.slice(0, 8).map((hit) => ({
        url: String(hit.url ?? ''),
        title: String(hit.title ?? ''),
        source: String(hit.planLabel ?? ''),
        publishedAt: hit.freshness?.date instanceof Date ? hit.freshness.date.toISOString() : null,
        reads: Number.isFinite(hit.engagement?.reads) ? hit.engagement.reads : null,
      })),
      score: outletCount * 1_000_000 + reads.reads,
    }
  })

  // Same-day stories outrank undated ones before the source/read ranking applies.
  scored.sort((left, right) => {
    const freshRank = Number(right.sameDay) - Number(left.sameDay)
    if (freshRank !== 0) return freshRank
    return right.score - left.score
  })
  return scored.slice(0, Math.max(1, top))
}

/** The host of a URL, or the URL itself when it does not parse. */
function safeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return String(url ?? '')
  }
}
