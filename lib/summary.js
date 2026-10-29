/**
 * Daily News Digest — the summarizing half.
 *
 * Ranking is deterministic (source count, then reads) so the digest is still
 * usable with no model at all. The model's job is what a ranking cannot do:
 * write one short brief per topic and one line per story, and merge stories
 * that token overlap failed to see as the same event.
 *
 * The model is asked for JSON so the page renders data rather than markup, and
 * every field is coerced on the way in: a model that returns prose, a fenced
 * block, or half an object must still produce a page.
 */

/** Characters of one story fed to the model. */
export const STORY_LIMIT = 700

/**
 * The smallest story budget a prompt uses.
 *
 * The budget follows the user's `Top`: describing only 24 of the 30 stories
 * they asked for would leave the tail of every digest without a line, which
 * reads as a truncated summary. This floor keeps a prompt useful when `Top` is
 * small, and the cap only guards against a pathological prompt size.
 */
export const STORY_BUDGET = 24

/** The hard ceiling on stories per prompt, however large `Top` is. */
export const STORY_BUDGET_MAX = 60

/**
 * How many stories to describe for one topic.
 * @param {number} [top] - the user's per-topic count.
 * @returns {number} a count between {@link STORY_BUDGET} and {@link STORY_BUDGET_MAX}.
 */
export function storyBudget(top) {
  const wanted = Math.trunc(Number(top))
  if (!Number.isFinite(wanted) || wanted <= STORY_BUDGET) return STORY_BUDGET
  return Math.min(STORY_BUDGET_MAX, wanted)
}

/**
 * The prompt that asks the model to veto off-topic hits.
 *
 * This is the second opinion the lexical screen cannot give itself. A word list
 * can tell that "model licensing terms" and "forecast model" both say "model";
 * only a reader can tell which one is about AI. So the grey-zone hits — the ones
 * with *some* topic vocabulary but no conclusive evidence — are put to the model
 * with the topic and told to answer with ids only.
 * @param {string} topic - the topic text.
 * @param {object[]} hits - the grey-zone hits, each with `id`, `title`, `snippet`.
 * @returns {{ system: string, user: string }} the prompt halves.
 */
export function buildRelevancePrompt(topic, hits) {
  const system = [
    'You are screening search results for a daily news digest.',
    'You receive ONE topic and a list of candidate pages. For each, decide whether the page is genuinely about that topic.',
    'Reply with ONE JSON object and nothing else — no prose, no code fence.',
    'Shape: {"drop": [id, ...]}',
    'Rules:',
    '- Include an id in "drop" ONLY when the page is clearly not about the topic.',
    '- A page that is plausibly about the topic, even indirectly, must NOT be listed.',
    '- Judge by the subject of the page, not by whether it shares a word with the topic.',
    '- If every page is plausibly about the topic, reply {"drop": []}.',
  ].join('\n')

  const lines = [`Topic: ${topic}`, '', 'Candidates:']
  for (const hit of hits) {
    lines.push(`[${hit.id}] ${hit.title}`)
    if (typeof hit.snippet === 'string' && hit.snippet !== '') lines.push(`    ${hit.snippet.slice(0, 300)}`)
    if (typeof hit.url === 'string' && hit.url !== '') lines.push(`    ${hit.url}`)
  }
  return { system, user: lines.join('\n') }
}

/**
 * Read the model's veto list.
 * @param {string} raw - the model's reply.
 * @param {number[]} known - the ids that were offered.
 * @returns {Set<number>} the ids to drop; empty when the reply is unusable.
 */
export function parseRelevanceReply(raw, known) {
  const text = String(raw ?? '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return new Set()
  let body
  try {
    body = JSON.parse(text.slice(start, end + 1))
  } catch {
    return new Set()
  }
  const allowed = new Set(known)
  const out = new Set()
  const list = Array.isArray(body?.drop) ? body.drop : []
  for (const value of list) {
    const id = Number(value)
    if (Number.isInteger(id) && allowed.has(id)) out.add(id)
  }
  return out
}

/**
 * Apply the model's vetoes to a screened hit list.
 *
 * A veto only removes a hit the lexical screen was already unsure about: a hit
 * it called relevant is never dropped on a model's word alone, so a confused
 * reply cannot empty the digest.
 * @param {object[]} hits - the grey-zone hits, with `id`.
 * @param {Set<number>} dropped - the ids the model rejected.
 * @returns {{ kept: object[], vetoed: object[] }} the surviving and removed hits.
 */
export function applyRelevanceVeto(hits, dropped) {
  const kept = []
  const vetoed = []
  for (const hit of hits) {
    if (dropped.has(hit.id) && hit.relevance?.decision === 'grey') vetoed.push(hit)
    else kept.push(hit)
  }
  return { kept, vetoed }
}

/**
 * The prompt for one topic.
 * @param {string} topic - the topic text.
 * @param {object[]} stories - ranked stories for that topic.
 * @param {number} [budget] - how many stories to describe.
 * @param {string} [day] - the calendar day the digest covers, `YYYY-MM-DD`.
 * @param {string} [guidance] - the user's own guidance for this topic.
 * @returns {{ system: string, user: string }} the prompt halves.
 */
export function buildTopicPrompt(topic, stories, budget = STORY_BUDGET, day = '', guidance = '') {
  const system = [
    'You are the editor of a daily news digest.',
    'You receive stories already collected and ranked for ONE topic, with the sources that carried each one.',
    'Every story is a single published article, and most carry a publication date.',
    'Reply with ONE JSON object and nothing else — no prose, no code fence.',
    'Shape:',
    '{"brief": string, "stories": [{"id": number, "line": string}], "merged": [{"keep": number, "drop": number[]}]}',
    'Rules:',
    '- "brief": 2-4 sentences saying what actually happened on this topic today. Name the concrete events, not the coverage.',
    '- "stories": one entry per story you were given, with its id unchanged. "line" is ONE sentence, at most 30 words, saying what that story reports.',
    '- Describe the NEWS the article reports. Never describe a section, index page, or an organisation\'s general research areas.',
    '- "merged": only when two or more given stories are the SAME event reported separately. "keep" is the id to keep, "drop" the ids to fold into it. Omit the array entirely when every story is distinct.',
    '- Never invent facts, numbers, names, or quotes that are not in the input.',
    '- If a story has only a headline, say only what the headline says.',
    '- Write in the language of the topic when the topic is not English; otherwise English.',
    '- When the reader supplied guidance, it states what they care about within the topic: weight the brief and the story lines towards it, and do not add stories or facts outside it.',
  ].join('\n')

  const lines = [
    `Topic: ${topic}`,
    day === '' ? '' : `Date of the digest: ${day}. The stories below were published on or around this day.`,
    guidance === '' ? '' : `Reader guidance for this topic: ${guidance}`,
    '',
    'Stories, ranked by how many independent sources carried each one and then by total reads:',
    '',
  ]
  for (const story of stories.slice(0, budget)) {
    const sources = story.links.map((link) => link.source).filter((name) => name !== '')
    const unique = [...new Set(sources)]
    lines.push(`[${story.id}] ${story.title}`)
    if (typeof story.publishedAt === 'string' && story.publishedAt !== '') {
      lines.push(`    published: ${story.publishedAt.slice(0, 10)}`)
    } else {
      lines.push('    published: unknown')
    }
    lines.push(`    sources (${unique.length}): ${unique.join(', ') || 'unknown'}`)
    lines.push(`    reads: ${story.reads}${story.measured ? '' : ' (estimated from result position)'}`)
    if (story.snippet !== '') lines.push(`    snippet: ${story.snippet.slice(0, STORY_LIMIT)}`)
    lines.push('')
  }
  return { system, user: lines.join('\n') }
}

/**
 * Parse one topic's reply.
 * @param {string} raw - the model's reply.
 * @returns {{ brief: string, lines: Map<number, string>, merged: Array<{ keep: number, drop: number[] }>, parsed: boolean }}
 */
export function parseTopicReply(raw) {
  const text = String(raw ?? '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const candidate = start === -1 || end <= start ? '' : text.slice(start, end + 1)
  let body = null
  if (candidate !== '') {
    try {
      body = JSON.parse(candidate)
    } catch {
      body = null
    }
  }
  if (body === null || typeof body !== 'object') {
    // Unparsable: the model's own words still beat an empty page.
    return { brief: text.slice(0, 1200), lines: new Map(), merged: [], parsed: false }
  }

  const lines = new Map()
  if (Array.isArray(body.stories)) {
    for (const entry of body.stories) {
      if (entry === null || typeof entry !== 'object') continue
      const id = Number(entry.id)
      const line = String(entry.line ?? '').trim()
      if (!Number.isFinite(id) || line === '') continue
      lines.set(Math.trunc(id), line.slice(0, 400))
    }
  }

  const merged = []
  if (Array.isArray(body.merged)) {
    for (const entry of body.merged) {
      if (entry === null || typeof entry !== 'object') continue
      const keep = Number(entry.keep)
      if (!Number.isFinite(keep)) continue
      const drop = Array.isArray(entry.drop)
        ? entry.drop.map(Number).filter((id) => Number.isFinite(id) && id !== keep).map(Math.trunc)
        : []
      if (drop.length === 0) continue
      merged.push({ keep: Math.trunc(keep), drop })
    }
  }

  return { brief: String(body.brief ?? '').trim().slice(0, 1600), lines, merged, parsed: true }
}

/**
 * Apply the model's merge instructions to a ranked list.
 *
 * A merge only happens when both ids exist and the kept story has at least as
 * many sources as the dropped one; a model that inverts that would be folding a
 * widely reported story into a narrow one, which is exactly what the ranking is
 * there to prevent.
 * @param {object[]} stories - ranked stories with ids.
 * @param {Array<{ keep: number, drop: number[] }>} merged - the model's merges.
 * @returns {object[]} the merged list, order preserved.
 */
export function applyMerges(stories, merged) {
  if (!Array.isArray(merged) || merged.length === 0) return stories
  // Work on copies: the caller keeps its own list, and a merge must not quietly
  // rewrite the objects the fallback path may still use.
  const work = stories.map((story) => ({
    ...story,
    sources: story.sources.slice(),
    links: story.links.slice(),
  }))
  const byId = new Map(work.map((story) => [story.id, story]))
  const foldedInto = new Map()

  for (const merge of merged) {
    const keep = byId.get(merge.keep)
    if (keep === undefined) continue
    for (const dropId of merge.drop) {
      const drop = byId.get(dropId)
      if (drop === undefined || drop === keep) continue
      if (foldedInto.has(dropId)) continue
      if (drop.sourceCount > keep.sourceCount) continue
      foldedInto.set(dropId, keep.id)
      for (const source of drop.sources) if (!keep.sources.includes(source)) keep.sources.push(source)
      for (const link of drop.links) if (!keep.links.some((existing) => existing.url === link.url)) keep.links.push(link)
      keep.sourceCount = keep.sources.length
      keep.reads += drop.reads
      keep.measured = keep.measured || drop.measured
      if (keep.snippet === '') keep.snippet = drop.snippet
    }
  }

  if (foldedInto.size === 0) return stories
  const out = work.filter((story) => !foldedInto.has(story.id))
  // The merge can change the order: a story that absorbed three others now has
  // more sources than the one above it.
  out.sort((left, right) => right.sourceCount - left.sourceCount || right.reads - left.reads)
  return out
}

/**
 * A digest built without a model: the ranking plus each story's own snippet.
 * @param {string} topic - the topic text.
 * @param {object[]} stories - ranked stories.
 * @param {string} reason - why no model ran.
 * @returns {object} a topic digest.
 */
export function fallbackTopicDigest(topic, stories, reason) {
  const measured = stories.some((story) => story.measured)
  return {
    topic,
    brief: '',
    stories: stories.map((story) => ({
      id: story.id,
      title: story.title,
      url: story.url,
      line: story.snippet !== '' ? story.snippet.slice(0, 220) : '',
      publishedAt: story.publishedAt ?? null,
      dated: story.dated === true,
      sameDay: story.sameDay === true,
      sources: story.links.map((link) => link.source).filter((name) => name !== ''),
      sourceCount: story.sourceCount,
      reads: story.reads,
      measured: story.measured,
      links: story.links,
    })),
    summarized: false,
    reason,
    measured,
  }
}
