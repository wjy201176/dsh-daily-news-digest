/**
 * Daily News Digest — is this a news article, and is it from today?
 *
 * Two failures this module exists to prevent, both visible in a real digest:
 *
 *  - a `site:openai.com` query returns `openai.com/research` — the section
 *    landing page — and the digest links there instead of to the article;
 *  - a section page has no publication date, so an evergreen page outranks
 *    today's reporting and the digest stops being a *daily* digest.
 *
 * So every hit is asked two questions before it can become a story: does the
 * URL address one article rather than a section, and does its date say today?
 */

/**
 * Path segments that mark a *collection* rather than an article, wherever they
 * appear in the path.
 *
 * These matter because an id-like tail is normally the strongest article signal,
 * and a listing can carry one: `bbc.com/news/topics/ce1qrvleleqt` is a topic hub
 * whose tail looks exactly like an article id. The collection marker wins over
 * the tail, so a hub is never mistaken for a story.
 *
 * `articles` is deliberately absent: `bbc.com/news/articles/<id>` is one article
 * inside the articles collection, so the marker does not make it a listing.
 */
const LISTING_SEGMENTS = new Set([
  'topics', 'topic', 'tag', 'tags', 'category', 'categories',
  'archive', 'archives', 'author', 'authors', 'search',
])

/** Path segments that address a listing, not an article. */
const SECTION_PATHS = new Set([
  'research', 'news', 'blog', 'blogs', 'index', 'latest', 'topics', 'topic',
  'category', 'categories', 'tag', 'tags', 'archive', 'archives', 'author',
  'authors', 'about', 'contact', 'search', 'feed', 'rss', 'sitemap', 'press',
  'publications', 'papers', 'resources', 'library', 'insights', 'stories',
  'articles', 'posts', 'updates', 'releases', 'events', 'products', 'company',
  'careers', 'jobs', 'pricing', 'docs', 'documentation', 'guide', 'learn',
])

/** Article paths usually carry an id or a slug of several words; a lone segment is a section. */
const DATE_IN_PATH = [
  /\/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/,
  /\/(\d{4})-(\d{2})-(\d{2})(?:\/|$)/,
  /\/(\d{4})(\d{2})(\d{2})(?:\/|$)/,
  /\/(\d{4})\/(\d{1,2})(?:\/|$)/,
]

/**
 * Does this URL address one article?
 *
 * The test is deliberately conservative: a page is an article when it has a
 * dated path, an id-like tail, or a multi-word slug. A bare section root —
 * `openai.com/research`, `cnn.com/tech` — fails all three, which is exactly the
 * page that should never become a story's link.
 * @param {string} url - the result URL.
 * @returns {boolean} whether the URL looks like a single article.
 */
export function isArticleUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!/^https?:$/.test(parsed.protocol)) return false

  const segments = parsed.pathname.split('/').filter((part) => part !== '')
  if (segments.length === 0) return false

  // A collection path is never one article, however article-shaped its tail
  // looks. Checked before the dated and id-like rules, which would otherwise
  // accept a hub such as `bbc.com/news/topics/<id>`.
  const lower = segments.map((part) => part.toLowerCase())
  if (lower.some((part) => LISTING_SEGMENTS.has(part))) return false

  // A dated path is the strongest signal.
  if (DATE_IN_PATH.some((pattern) => pattern.test(parsed.pathname))) return true

  // A permalink shape beats any generic rule: these platforms address one post
  // by a short id, which the generic numeric test below would reject.
  if (isPermalink(parsed)) return true

  // A trailing id or a long numeric segment.
  const last = segments[segments.length - 1].toLowerCase()
  if (/^\d{4,}$/.test(last)) return true
  if (/^(?=.*\d)[a-z0-9-]{6,}$/.test(last) && /\d/.test(last)) return true

  // A slug: several hyphenated words, or one long word that is not a section name.
  if (last.includes('-') && last.split('-').filter((word) => word.length > 1).length >= 2) return true
  if (last.length >= 24 && !SECTION_PATHS.has(last)) return true

  // Everything else is a section root or a landing page.
  return false
}

/** Path shapes that address exactly one item on a known platform. */
const PERMALINK_PATHS = [
  // x.com/<user>/status/<id>, twitter.com/<user>/status/<id>
  /^\/[^/]+\/status\/\d+/,
  // zhihu.com/question/<id>/answer/<id>, zhuanlan.zhihu.com/p/<id>
  /^\/question\/\d+(?:\/answer\/\d+)?/,
  /^\/p\/\d+/,
  // weibo.com/<uid>/<mid>, m.weibo.cn/detail/<id>
  /^\/\d+\/[A-Za-z0-9]+/,
  /^\/detail\/\d+/,
  // reddit.com/r/<sub>/comments/<id>/...
  /^\/r\/[^/]+\/comments\/[A-Za-z0-9]+/,
  // linkedin.com/posts/<slug>, /feed/update/<urn>
  /^\/posts\/[^/]+/,
  /^\/feed\/update\//,
  // medium.com/@user/<slug>-<hash>, substack /p/<slug>
  /^\/@[^/]+\/[^/]+/,
  /^\/p\/[^/]+/,
]

/**
 * Does the path address one post on a known platform?
 * @param {URL} parsed - the parsed URL.
 * @returns {boolean} whether the path is a permalink.
 */
function isPermalink(parsed) {
  return PERMALINK_PATHS.some((pattern) => pattern.test(parsed.pathname))
}

/** Month names, for `Oct 26, 2026` style dates. */
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
}

/** The local calendar day of a date, as `YYYY-MM-DD`. */
export function dayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Midnight local time for a date. */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * The window a publication date must fall in to be believed.
 *
 * Search providers occasionally return a date that is simply wrong — a forum
 * timestamp rendered as the year 7969, a millisecond epoch read as a year — and
 * a parsed-but-absurd date is worse than no date at all: it looks precise, it
 * survives the recency filter because it is not "old", and it can outrank real
 * news. So a date outside this window is treated as *undated*, not as truth.
 */
const EARLIEST_YEAR = 1995
/** How far ahead of "now" a date may sit and still be believed (timezone slack). */
const FUTURE_SLACK_DAYS = 2

/**
 * Is a parsed date believable as a publication date?
 * @param {Date} date - the parsed date.
 * @param {Date} now - the reference clock.
 * @returns {boolean} whether it is plausible.
 */
export function plausibleDate(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false
  const year = date.getFullYear()
  if (year < EARLIEST_YEAR) return false
  if (year > now.getFullYear() + 1) return false
  const ahead = date.getTime() - now.getTime()
  if (ahead > FUTURE_SLACK_DAYS * 86_400_000) return false
  return true
}

/**
 * Parse a date from a search result.
 *
 * Providers disagree: some send ISO timestamps, some a date, some a relative
 * phrase, and some only a URL with the date in it. Every shape seen in practice
 * is handled here, and anything unrecognised — or implausible — returns null
 * rather than a guess.
 * @param {unknown} value - the raw `publishedAt` (or a snippet fragment).
 * @param {Date} [now] - the reference clock, for relative phrases.
 * @returns {Date|null} the parsed date.
 */
export function parseDate(value, now = new Date()) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text === '') return null

  // ISO 8601, with or without a time and zone.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text)
  if (iso !== null) {
    const [, year, month, day, hour, minute, second] = iso
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
      Number(second ?? 0),
    )
    if (Number.isNaN(date.getTime())) return null
    return plausibleDate(date, now) ? date : null
  }

  // "Oct 26, 2026" and "26 October 2026".
  const monthFirst = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text)
  if (monthFirst !== null) {
    const month = MONTHS[monthFirst[1].toLowerCase()]
    if (month !== undefined) return new Date(Number(monthFirst[3]), month, Number(monthFirst[2]))
  }
  const dayFirst = /^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i.exec(text)
  if (dayFirst !== null) {
    const month = MONTHS[dayFirst[2].toLowerCase()]
    if (month !== undefined) return new Date(Number(dayFirst[3]), month, Number(dayFirst[1]))
  }

  // "2 hours ago", "3 days ago", "yesterday".
  const relative = /^(\d+)\s*(second|minute|hour|day|week|month)s?\s+ago$/i.exec(text)
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const ms = {
      second: 1_000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_592_000_000,
    }[unit]
    if (ms !== undefined) return new Date(now.getTime() - amount * ms)
  }
  if (/^yesterday$/i.test(text)) return new Date(now.getTime() - 86_400_000)
  if (/^(today|just now)$/i.test(text)) return new Date(now.getTime())

  // A bare year is too coarse to call a day.
  return null
}

/**
 * Recover a date from the URL path, for providers that send none.
 * @param {string} url - the article URL.
 * @returns {Date|null} the date the path states.
 */
export function dateFromUrl(url) {
  let path
  try {
    path = new URL(url).pathname
  } catch {
    return null
  }
  // The date can sit at the start of the path (`/2026/10/26/...`) or after a
  // section prefix (`/tech/2026/10/26/...`), so the patterns are not anchored.
  // A date followed by a slug separator (`2026-10-26-launch`) counts too.
  for (const pattern of [
    /\/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/,
    /\/(\d{4})-(\d{2})-(\d{2})(?:[-/.]|$)/,
    /\/(\d{4})(\d{2})(\d{2})(?:[-/.]|$)/,
  ]) {
    const match = pattern.exec(path)
    if (match === null) continue
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (Number.isNaN(date.getTime())) return null
    return plausibleDate(date) ? date : null
  }
  return null
}

/**
 * Where a hit's date came from, and whether it is today's.
 *
 * `sameDay` is true only when a date was actually recovered. An undated article
 * is `sameDay: false` but `dated: false`, which the ranking treats differently
 * from a story it knows is old: a provider that sends no dates must not empty
 * the digest, while a story dated last month must not outrank today's.
 * @param {object} hit - `{ url, snippet, publishedAt }`.
 * @param {Date} [now] - the reference clock.
 * @returns {{ date: Date|null, dated: boolean, sameDay: boolean, ageDays: number|null, from: string }}
 */
export function freshnessOf(hit, now = new Date()) {
  let date = parseDate(hit?.publishedAt, now)
  let from = 'meta'
  if (date === null) {
    date = dateFromUrl(hit?.url)
    from = 'url'
  }
  if (date === null) {
    // A date printed in the snippet.
    const inSnippet = /(\d{4}-\d{2}-\d{2})/.exec(String(hit?.snippet ?? ''))
    if (inSnippet !== null) {
      date = parseDate(inSnippet[1], now)
      from = 'snippet'
    }
  }
  if (date === null) {
    // A date printed in the title. Roundups and briefings put the day there
    // ("International News Briefs for Monday, October 26, 2026") while their URL
    // carries no date at all, so without this a real dated report looks
    // undated — and an undated page has to clear a higher bar to count as news.
    date = dateFromTitle(hit?.title, now)
    from = 'title'
  }
  if (date === null) return { date: null, dated: false, sameDay: false, ageDays: null, from: 'none' }

  const today = startOfDay(now)
  const day = startOfDay(date)
  const ageDays = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  return { date, dated: true, sameDay: ageDays === 0, ageDays, from }
}

/** Month names as a headline writes them, including abbreviations. */
const TITLE_MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8,
  sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
}

/**
 * Recover a date written into a headline.
 *
 * Handles "October 26, 2026", "26 October 2026" and "Oct 26 2026". A bare year is
 * not enough to name a day, so it is ignored.
 * @param {string} title - the result title.
 * @param {Date} [now] - the reference clock, for plausibility.
 * @returns {Date|null} the date the title states.
 */
export function dateFromTitle(title, now = new Date()) {
  const text = String(title ?? '')
  if (text === '') return null

  const monthFirst = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(text)
  if (monthFirst !== null) {
    const month = TITLE_MONTHS[monthFirst[1].toLowerCase()]
    if (month !== undefined) {
      const date = new Date(Number(monthFirst[3]), month, Number(monthFirst[2]))
      if (!Number.isNaN(date.getTime()) && plausibleDate(date, now)) return date
    }
  }

  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(text)
  if (dayFirst !== null) {
    const month = TITLE_MONTHS[dayFirst[2].toLowerCase()]
    if (month !== undefined) {
      const date = new Date(Number(dayFirst[3]), month, Number(dayFirst[1]))
      if (!Number.isNaN(date.getTime()) && plausibleDate(date, now)) return date
    }
  }

  return null
}

/**
 * A date stamped on the digest, for the page header and the prompt.
 * @param {Date} [now] - the reference clock.
 * @returns {string} `YYYY-MM-DD`.
 */
export function todayKey(now = new Date()) {
  return dayKey(now)
}
