/**
 * Daily News Digest — per-topic search guidance.
 *
 * A topic is a label, and a label is a weak query. "LLM Local Deployment" says
 * nothing about whether you care about vLLM's scheduler, consumer laptops, or
 * enterprise on-prem rollouts — so the search has to guess, and a guess pulls in
 * tutorials and home pages that are on-topic and useless.
 *
 * Guidance is the user telling the search what they actually want, in their own
 * words. It behaves like a prompt for the search step and a skill for the
 * filtering step, and it is deliberately *not* pasted into the query verbatim:
 * a sentence like "only care about open-source inference engines, skip
 * tutorials" would make a terrible search query.
 *
 * So guidance is parsed into three things a query can use:
 *
 *   - `keywords` — the concrete terms to search for, which also become extra
 *     vocabulary for the relevance screen ("vLLM" is now part of what "LLM Local
 *     Deployment" means for this user);
 *   - `excludes` — terms that disqualify a hit ("tutorial", "教程");
 *   - `note` — the guidance as written, handed to the model as editorial
 *     direction for the brief and the per-story lines.
 */

/** How long a guidance string may be. Long enough for a paragraph, not a page. */
export const MAX_GUIDANCE = 600

/** Words that mark an exclusion in guidance prose. */
const EXCLUDE_MARKERS = /\b(?:exclude|excluding|except|ignore|ignoring|skip|skipping|avoid|no|not|without|minus)\b|(?:不要|排除|忽略|除了|不看|跳过|无需|别)/gi

/** Words that carry no search value inside guidance. */
const GUIDANCE_STOPWORDS = new Set([
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'the', 'a', 'an', 'and', 'or', 'but',
  'only', 'just', 'want', 'wants', 'wanted', 'care', 'cares', 'like', 'likes',
  'interested', 'interest', 'focus', 'focused', 'focusing', 'prefer', 'prefers',
  'about', 'with', 'from', 'into', 'that', 'this', 'these', 'those', 'is', 'are',
  'be', 'been', 'being', 'was', 'were', 'will', 'would', 'should', 'could', 'can',
  'may', 'might', 'must', 'have', 'has', 'had', 'do', 'does', 'did', 'not', 'no',
  'more', 'most', 'less', 'least', 'very', 'really', 'anything', 'something',
  'everything', 'things', 'thing', 'stuff', 'news', 'articles', 'article', 'story',
  'stories', 'content', 'results', 'result', 'show', 'shows', 'give', 'gives',
  'please', 'also', 'than', 'then', 'them', 'they', 'it', 'its', 'as', 'at', 'by',
  'for', 'of', 'on', 'to', 'in', 'up', 'out', 'off', 'via', 'per', 'vs', 'versus',
  // The exclusion markers themselves are instructions, not search terms: keeping
  // them would make "skip tutorials" search for the word "skip".
  'exclude', 'excluding', 'except', 'ignore', 'ignoring', 'skip', 'skipping',
  'avoid', 'without', 'minus', 'track', 'tracking', 'follow', 'following',
  'include', 'including', 'want', 'need', 'needs', 'looking', 'look',
  // Instruction words from a written brief. A user who writes "Find the credible
  // news on: 1) major AI companies, such as Deepseek, OpenAI…" is describing the
  // task, not the subject. Left in, they take the first query slots and the query
  // becomes "find credible major such October 27 2026" — which finds nothing, and
  // is why the digest came back empty while echoing the instruction back.
  'find', 'finds', 'finding', 'search', 'searching', 'seek', 'seeking', 'get',
  'credible', 'reliable', 'authoritative', 'trustworthy', 'reputable', 'quality',
  'major', 'main', 'key', 'important', 'significant', 'notable', 'relevant',
  'latest', 'recent', 'current', 'new', 'top', 'best', 'big',
  'such', 'including', 'eg', 'ie', 'etc',
  'detail', 'details', 'detailed', 'specific', 'specifically', 'especially',
  'information', 'info', 'update', 'updates', 'status', 'overview',
  'breakdown', 'summary', 'report', 'reports', 'reporting', 'coverage',
  'list', 'lists', 'example', 'examples', 'area', 'areas', 'kind', 'kinds',
  'type', 'types', 'category', 'categories', 'aspect', 'aspects', 'topic', 'topics',
  'develop', 'development', 'developments', 'developing', 'happen', 'happened',
  'happening', 'going', 'go', 'goes', 'occur', 'occurred', 'take', 'takes',
  'whether', 'what', 'which', 'who', 'when', 'where', 'why', 'how',
  'both', 'each', 'every', 'all', 'any', 'some', 'other', 'others', 'another',
  'one', 'two', 'three', 'first', 'second', 'third', 'next', 'last',
])

/** Chinese phrases that mark an exclusion. */
const ZH_EXCLUDE = /(?:不要|排除|忽略|除了|不看|跳过|无需|别)/

/**
 * Chinese filler that says nothing about the subject.
 *
 * A Chinese guidance clause is prose, so its leading verb phrase ("关注…",
 * "我想看…") has to be removed before what remains is a searchable term.
 */
const ZH_FILLER = /^(?:请|我想|我要|只想|只需要|关注|追踪|跟一下|看看|查找|搜索|找|浏览|了解|关心|注意|需要|要看)/

/** Separators inside a Chinese list: 、 ，, ；; 和 与 或. */
const ZH_SPLIT = /[、，,；;。\n]+|(?:和|与|或)/

/**
 * Normalise guidance text for storage.
 * @param {unknown} value - whatever the client sent.
 * @returns {string} trimmed, single-spaced, length-capped guidance.
 */
export function cleanGuidance(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_GUIDANCE)
}

/**
 * Split guidance into the clause that says what to *avoid* and the rest.
 *
 * The split is at the first exclusion marker, because guidance is written as
 * "what I want — except what I don't": the exclusion almost always trails.
 * Chinese markers are checked too, since a Chinese sentence carries no word
 * boundary for the English regex to find.
 * @param {string} guidance - the cleaned guidance.
 * @returns {{ include: string, exclude: string }} the two halves.
 */
export function splitGuidance(guidance) {
  const text = String(guidance ?? '')
  let at = -1

  const latin = EXCLUDE_MARKERS.exec(text)
  EXCLUDE_MARKERS.lastIndex = 0
  if (latin !== null) at = latin.index

  const zh = ZH_EXCLUDE.exec(text)
  if (zh !== null && (at === -1 || zh.index < at)) at = zh.index

  if (at === -1) return { include: text, exclude: '' }
  return { include: text.slice(0, at), exclude: text.slice(at) }
}

/**
 * The searchable terms in one clause.
 *
 * Latin words are kept when they look substantive: three characters or more, not
 * a stopword, not a bare number. A quoted phrase or a hyphenated product name
 * survives as one term, because "llama.cpp" and "vLLM" are the whole point.
 * @param {string} clause - part of the guidance.
 * @returns {string[]} the terms, in order, deduplicated.
 */
export function termsOf(clause) {
  const text = String(clause ?? '')
  const out = []
  const seen = new Set()

  const push = (value) => {
    const term = value.trim()
    if (term === '') return
    const key = term.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(term)
  }

  // A quoted phrase is one term, and the strongest kind: the user wrote it
  // deliberately.
  for (const quoted of text.match(/"([^"]{2,60})"|“([^”]{2,60})”/g) ?? []) {
    push(quoted.replace(/^["“]|["”]$/g, ''))
  }

  for (const word of text.match(/[A-Za-z0-9][A-Za-z0-9+#._-]*/g) ?? []) {
    const cleaned = word.replace(/[._-]+$/g, '')
    if (cleaned.length < 3) continue
    if (/^\d+$/.test(cleaned)) continue
    if (GUIDANCE_STOPWORDS.has(cleaned.toLowerCase())) continue
    // A leading capital is ordinary sentence case, not a proper noun, so the
    // term is lower-cased unless it is written in an unusual case throughout
    // ("vLLM", "SGLang", "GPT-6").
    const mixedCase = /[A-Z]/.test(cleaned.slice(1))
    push(mixedCase ? cleaned : cleaned.toLowerCase())
  }

  // CJK: split the run into list items, strip the filler verb and any trailing
  // exclusion marker, keep what is left. Chinese guidance is usually a list of
  // concepts ("开源推理、量化部署"), and treating the whole sentence as one term
  // makes it unsearchable.
  for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]{2,}/g) ?? []) {
    for (const piece of run.split(ZH_SPLIT)) {
      const cleaned = piece
        .replace(ZH_FILLER, '')
        .replace(ZH_EXCLUDE, '')
        .replace(/[的了呢吧啊]$/, '')
        .trim()
      if (cleaned.length < 2) continue
      push(cleaned)
    }
  }

  return out
}

/**
 * Parse one topic's guidance into what the pipeline can use.
 * @param {unknown} guidance - the stored guidance text.
 * @returns {{ note: string, keywords: string[], excludes: string[], empty: boolean }}
 *   `note` is the guidance as written (for the model), `keywords` and `excludes`
 *   are the searchable terms.
 */
export function parseGuidance(guidance) {
  const note = cleanGuidance(guidance)
  if (note === '') return { note: '', keywords: [], excludes: [], empty: true }

  const { include, exclude } = splitGuidance(note)
  const keywords = termsOf(include)
  const excludes = termsOf(exclude)

  // A guidance that is *only* an exclusion ("don't show tutorials") has no
  // include clause; its terms are still worth searching, so they are promoted
  // rather than silently dropped.
  if (keywords.length === 0 && excludes.length > 0) {
    return { note, keywords: excludes.slice(), excludes, empty: false }
  }

  return { note, keywords: searchableKeywords(rankKeywords(keywords)), excludes, empty: false }
}

/** Words that describe *what kind* of page or text is wanted, not its subject. */
const GENERIC_WORDS = new Set([
  'engine', 'engines', 'inference', 'model', 'models', 'deployment', 'deployments',
  'tool', 'tools', 'framework', 'frameworks', 'platform', 'platforms', 'system',
  'systems', 'server', 'servers', 'service', 'services', 'project', 'projects',
  'research', 'paper', 'papers', 'article', 'articles', 'post', 'posts', 'blog',
  'blogs', 'content', 'industry', 'company', 'companies', 'startup', 'startups',
  'technology', 'technologies', 'product', 'products', 'update', 'updates',
  'release', 'releases', 'development', 'developer', 'developers', 'usage', 'use',
  'guide', 'guides', 'review', 'reviews', 'comparison', 'comparisons',
])

/**
 * Order the guidance keywords so the specific ones come first.
 *
 * A longer keyword list makes a keyword-soup query, so the order decides what is
 * actually searched first. The user's own *names* are the valuable part: in
 * "open-source inference engines vLLM and llama.cpp" the subject is `vLLM` and
 * `llama.cpp`, not `engines`. A generic category word must not take the place of
 * a product name.
 *
 * The ranking is: a name the user wrote in an unusual case (vLLM, SGLang) or
 * with punctuation (llama.cpp) first, then anything that is not a generic
 * category word, then the generic words last — each group keeping the user's own
 * order. Generic words are kept rather than dropped, because a short guidance
 * ("model releases") is mostly generic and would otherwise become empty.
 * @param {string[]} keywords - the parsed keywords.
 * @returns {string[]} the same terms, most specific first.
 */
export function rankKeywords(keywords) {
  const list = Array.isArray(keywords) ? keywords : []
  const named = []
  const specific = []
  const generic = []
  for (const term of list) {
    // A name is written with mixed case after the first letter, or carries a dot,
    // a digit or a symbol — "vLLM", "llama.cpp", "GPT-6", "C++".
    const looksNamed = /[A-Z]/.test(term.slice(1)) || /[._+#\d]/.test(term)
    if (looksNamed) named.push(term)
    else if (GENERIC_WORDS.has(term.toLowerCase())) generic.push(term)
    else specific.push(term)
  }
  return [...named, ...specific, ...generic]
}

/**
 * Drop the keywords that carry no search value on their own.
 *
 * `rankKeywords` keeps generic words because a short guidance can be made almost
 * entirely of them. But once the specific names are known, a trailing generic word
 * only wastes a query slot: "companies models October 27 2026" searches nothing.
 * So a generic term is dropped when at least one specific term survives.
 * @param {string[]} keywords - the ranked keywords.
 * @returns {string[]} the keywords worth searching.
 */
export function searchableKeywords(keywords) {
  const list = Array.isArray(keywords) ? keywords : []
  const specific = list.filter((term) => !GENERIC_WORDS.has(String(term).toLowerCase()))
  return specific.length > 0 ? specific : list
}

/**
 * Does a hit violate the guidance's exclusions?
 *
 * Checked against the title and snippet, case-insensitively. A Chinese exclusion
 * is a substring (no word boundaries exist); a Latin one must be a whole word, so
 * "tutorial" does not match inside "tutorials-from-the-trenches" by accident —
 * though the plural is handled by matching the stem.
 * @param {object} hit - `{ title, snippet }`.
 * @param {string[]} excludes - the exclusion terms.
 * @returns {{ excluded: boolean, term: string }} the verdict and the term that caused it.
 */
export function exclusionHit(hit, excludes) {
  if (!Array.isArray(excludes) || excludes.length === 0) return { excluded: false, term: '' }
  const text = `${String(hit?.title ?? '')} ${String(hit?.snippet ?? '')}`
  const lower = text.toLowerCase()
  // A second copy with spaces removed, so a one-word exclusion ("homepages")
  // also catches the spaced form ("Home page") — the difference is only how the
  // headline happened to write it.
  const joined = lower.replace(/\s+/g, '')
  for (const term of excludes) {
    const needle = term.toLowerCase()
    if (needle === '') continue
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(needle)) {
      if (text.includes(term)) return { excluded: true, term }
      continue
    }
    // The user writes a plural ("skip tutorials", "no homepages") and the
    // headline may use the singular, a compound, or a spaced form. Strip the
    // plural, then allow only the inflections that keep the word the same: an
    // optional trailing "s"/"es", and an optional space inside a compound. A
    // loose prefix would make "guides" match "guided missiles".
    const singular = needle.replace(/(ies)$/, 'y').replace(/([a-z])s$/, '$1')
    const escaped = singular.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const flexible = escaped.split('').join('\\s?')
    if (new RegExp(`(^|[^a-z0-9])${flexible}(s|es)?($|[^a-z0-9])`, 'i').test(lower)) {
      return { excluded: true, term }
    }
    // The same test on the space-collapsed copy, for a headline that breaks the
    // compound somewhere the character-wise pattern does not expect.
    if (new RegExp(`(^|[^a-z0-9])${escaped}(s|es)?($|[^a-z0-9])`, 'i').test(joined)) {
      return { excluded: true, term }
    }
  }
  return { excluded: false, term: '' }
}
