/**
 * Daily News Digest — how much a story was actually read.
 *
 * "Total number of reads from all sources" is the second ranking key, so it has
 * to mean something. Public pages publish three kinds of number: a social score
 * (Reddit upvotes, Hacker News points, GitHub stars), a comment count, and a
 * view count (rarely, on news sites). We take whichever the page exposes, and
 * when none is exposed we say so instead of inventing one.
 *
 * Two rules keep this honest:
 *  - a measured number is only used when a page actually contains it;
 *  - a story with no measurement contributes a *position estimate*, and the
 *    digest reports whether the total is measured or estimated.
 */

/** A count with an optional scale suffix: `1,234`, `12.3k`, `4万`. */
const COUNT = String.raw`([\d,.]{1,12}\s*[kmw万亿]?)`

/** Patterns for a social score on a page, in priority order. */
const SCORE_PATTERNS = [
  // Reddit's own markup and its JSON-LD both expose the score.
  { re: /"score"\s*:\s*(\d{1,9})/i, basis: 'upvotes' },
  { re: new RegExp(String.raw`(?:^|>)\s*${COUNT}\s*(?:points?|upvotes?)\b`, 'i'), basis: 'upvotes' },
  // Hacker News: "123 points".
  { re: new RegExp(String.raw`${COUNT}\s+points?\b`, 'i'), basis: 'points' },
  // GitHub: "12.3k stars".
  { re: new RegExp(String.raw`${COUNT}\s*stars?\b`, 'i'), basis: 'stars' },
  // A generic "N views" only when the page states it plainly.
  { re: new RegExp(String.raw`${COUNT}\s*(?:views?|reads?|浏览|阅读)\b`, 'i'), basis: 'views' },
]

/** Comment counts, used at a discount when no score exists. */
const COMMENT_PATTERNS = [
  { re: new RegExp(String.raw`${COUNT}\s+comments?\b`, 'i'), basis: 'comments' },
  { re: /"num_comments"\s*:\s*(\d{1,9})/i, basis: 'comments' },
  { re: /([\d,.]{1,12})\s*(?:条评论|评论)\b/i, basis: 'comments' },
]

/**
 * Parse a count written as `1,234`, `12.3k`, `4万`.
 * @param {string} raw - the matched text.
 * @returns {number} the number, or 0 when it cannot be read.
 */
export function parseCount(raw) {
  const text = String(raw ?? '').trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '')
  if (text === '') return 0
  const scaled = /^([\d.]+)\s*(k|m|万|亿|w)$/.exec(text)
  if (scaled !== null) {
    const value = Number(scaled[1])
    if (!Number.isFinite(value)) return 0
    const factor = { k: 1_000, m: 1_000_000, 万: 10_000, 亿: 100_000_000, w: 10_000 }[scaled[2]] ?? 1
    return Math.round(value * factor)
  }
  const value = Number(text)
  return Number.isFinite(value) ? Math.round(value) : 0
}

/**
 * Extract an engagement reading from one fetched page.
 *
 * HTML is stripped of tags first: the patterns are written against visible text
 * and against JSON blobs, and running them over markup alone would match CSS
 * values and class names.
 * @param {string} html - the page body.
 * @returns {{ reads: number, basis: string } | null} the reading, or null.
 */
export function engagementFromHtml(html) {
  const text = String(html ?? '')
  if (text === '') return null

  for (const pattern of SCORE_PATTERNS) {
    const match = pattern.re.exec(text)
    if (match === null) continue
    const value = parseCount(match[1])
    if (value > 0) return { reads: value, basis: pattern.basis }
  }
  for (const pattern of COMMENT_PATTERNS) {
    const match = pattern.re.exec(text)
    if (match === null) continue
    const value = parseCount(match[1])
    // A comment is weaker evidence of readership than a vote, so it counts for
    // half. The basis string keeps the discount visible.
    if (value > 0) return { reads: Math.round(value / 2), basis: `${pattern.basis} (½ weight)` }
  }
  return null
}

/**
 * Read a count that the search result itself already carried.
 *
 * Aggregators put the number in the snippet — "1.2k points, 340 comments" — and
 * that is a real measurement we get for free, without fetching the page.
 * @param {string} snippet - the result snippet.
 * @returns {{ reads: number, basis: string } | null} the reading, or null.
 */
export function engagementFromSnippet(snippet) {
  const text = String(snippet ?? '')
  if (text === '') return null
  for (const pattern of SCORE_PATTERNS) {
    const match = pattern.re.exec(text)
    if (match === null) continue
    const value = parseCount(match[1])
    if (value > 0) return { reads: value, basis: `${pattern.basis}, from the result snippet` }
  }
  for (const pattern of COMMENT_PATTERNS) {
    const match = pattern.re.exec(text)
    if (match === null) continue
    const value = parseCount(match[1])
    if (value > 0) return { reads: Math.round(value / 2), basis: `${pattern.basis} (½ weight), from the result snippet` }
  }
  return null
}

/** Pages that state a score in their HTML; other hosts are not fetched just for this. */
const MEASURABLE_HOSTS = [
  'reddit.com',
  'news.ycombinator.com',
  'github.com',
  'stackoverflow.com',
  'zhihu.com',
  'weibo.com',
  'weibo.cn',
  'bilibili.com',
  'v2ex.com',
]

/**
 * Is this URL worth fetching to measure engagement?
 * @param {string} url - the story URL.
 * @returns {boolean} whether a measurement is plausible.
 */
export function measurable(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return MEASURABLE_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
  } catch {
    return false
  }
}
