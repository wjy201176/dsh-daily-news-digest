/**
 * Daily News Digest — per-topic search skills.
 *
 * A topic's guidance used to be parsed into two lists and appended to queries.
 * That made the guidance *searchable* but not *operational*: there was one query
 * shape, no plan for what to do when it found nothing, and no way to judge a
 * result against what the reader actually asked for.
 *
 * A skill turns the same guidance into a small plan with three parts:
 *
 *   - a **ranked query plan** — the angles most likely to find this topic's news,
 *     ordered by precision, so the budget is spent on the best questions first;
 *   - **fallback queries** — broader phrasings used only when the plan came back
 *     empty, so a thin topic degrades to a wider search instead of a blank page;
 *   - **review criteria** — the reader's own words turned into statements a model
 *     can apply to each candidate, so "relevant" means what *they* meant.
 *
 * Everything here is deterministic. If no model is available the queries and the
 * hard filters still work; only the review step is skipped.
 */

import { parseGuidance } from './guidance.js'
import { topicQualifiers } from './relevance.js'
import { beatEntities, spokenDate } from './sources.js'

/** How many queries one topic's plan may spend. Search is rate-limited. */
export const MAX_PLAN_QUERIES = 14

/** How many extra queries a retry may spend when the plan found nothing. */
export const MAX_FALLBACK_QUERIES = 5

/** How many subject terms go into one query before it becomes keyword soup. */
const TERMS_PER_QUERY = 3

/**
 * Models whose weights are not published, so they cannot be self-hosted.
 *
 * This matters for one class of topic: "local deployment" is only possible for a
 * model whose weights you can obtain. A story about a hosted API model is about
 * *using* that model, not about running it, and it says nothing a reader who
 * deploys locally can act on.
 *
 * The list is names, not products-of-the-week, because a name is what a headline
 * carries: "Gemini 4 Carbon" and "GPT-6.1" are recognisable, whereas "the latest
 * assistant update" is not.
 */
const CLOSED_MODELS = [
  'gpt-3', 'gpt-4', 'gpt-5', 'gpt-6', 'gpt6', 'chatgpt', 'claude', 'gemini', 'grok',
  'copilot', 'character.ai', 'pi.ai', 'sora', 'dall-e', 'midjourney',
]

/**
 * Evidence that a model can actually be self-hosted.
 *
 * Only two things count here: a named open-weight family, and the licence,
 * runtime or file format that accompanies an open release. Language about running
 * *something* locally deliberately does not count — "Gemini can now run locally"
 * says where a closed model executes, which is not the same as being deployable.
 * Local-running vocabulary is already required by the topic's qualifier gate, so
 * counting it here would let a closed model through on its own.
 */
const OPEN_EVIDENCE = [
  'open-source', 'open source', 'opensource', 'open-weight', 'open weight',
  'open-weights', 'apache 2.0', 'apache-2.0', 'mit license', 'mit licence',
  'llama', 'qwen', 'deepseek', 'mistral', 'mixtral', 'phi-', 'gemma', 'olmo',
  'falcon', 'yi-', 'glm', 'kimi', 'minimax', 'minicpm', 'stablelm', 'dbrx',
  'granite', 'internlm', 'baichuan', 'ollama', 'llama.cpp', 'llamacpp', 'vllm',
  'sglang', 'gguf', 'gptq', 'awq', 'huggingface', 'hugging face',
  'weights released', 'released the weights', 'open model', 'open models',
]

/**
 * Should this topic require an open-source model?
 *
 * Not every topic: only one that is about *deploying* a model. "LLM Local
 * Deployment" qualifies because its qualifier is deployment; "AI News" does not,
 * and neither does a topic about model benchmarks. Deriving it from the qualifiers
 * keeps the rule attached to the meaning of the topic instead of to its name.
 * @param {string[]} qualifiers - the topic's qualifying words.
 * @returns {boolean} whether the rule applies.
 */
export function requiresOpenSource(qualifiers) {
  const list = Array.isArray(qualifiers) ? qualifiers.map((word) => String(word).toLowerCase()) : []
  return list.some((word) => /^(deploy|deployment|deployments|deploying|self-host|selfhost|on-prem|onprem|onpremise|local|locally|offline)$/.test(word))
}

/**
 * Is this story about a closed model and nothing open?
 *
 * @param {object} hit - `{ title, snippet }`.
 * @returns {{ closedOnly: boolean, model: string }} the verdict and the model named.
 */
export function closedModelOnly(hit) {
  const text = `${String(hit?.title ?? '')} ${String(hit?.snippet ?? '')}`.toLowerCase()
  if (text.trim() === '') return { closedOnly: false, model: '' }

  const open = OPEN_EVIDENCE.find((term) => text.includes(term))
  if (open !== undefined) return { closedOnly: false, model: '' }

  const model = CLOSED_MODELS.find((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text)
  })
  return model === undefined ? { closedOnly: false, model: '' } : { closedOnly: true, model }
}

/**
 * Split a list into chunks of at most `size`.
 * @param {string[]} list - the items.
 * @param {number} size - the chunk size.
 * @returns {string[][]} the chunks.
 */
function chunk(list, size) {
  const out = []
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
  return out
}

/**
 * Build the skill for one topic.
 * @param {string} topic - the topic name.
 * @param {unknown} [guidanceText] - the reader's guidance for it.
 * @param {object} [options] - `{ day, maxQueries, maxFallback }`.
 * @returns {object} the skill: `{ topic, note, keywords, quoted, excludes,
 *   preferHosts, avoidHosts, plan, fallback, criteria, hasGuidance }`.
 */
export function buildSkill(topic, guidanceText, options = {}) {
  const name = String(topic ?? '').trim()
  const guidance = parseGuidance(guidanceText)
  const day = String(options.day ?? '')
  const spoken = spokenDate(day)
  // The words that make this topic more than its category. They decide whether the
  // beat sweep applies, and the relevance screen uses the same list.
  const qualifiers = topicQualifiers(name)
  const maxQueries = Number.isFinite(options.maxQueries) ? options.maxQueries : MAX_PLAN_QUERIES
  const maxFallback = Number.isFinite(options.maxFallback) ? options.maxFallback : MAX_FALLBACK_QUERIES

  // The subjects to search. A quoted phrase is the reader's exact wording and is
  // the highest-value term there is; the rest of the keywords follow it.
  const subjects = []
  const pushSubject = (value) => {
    const term = String(value ?? '').trim()
    if (term === '') return
    if (subjects.some((seen) => seen.toLowerCase() === term.toLowerCase())) return
    subjects.push(term)
  }
  for (const phrase of guidance.quoted) pushSubject(phrase)
  for (const word of guidance.keywords) pushSubject(word)

  const dated = (parts) => (spoken === '' ? parts.filter(Boolean).join(' ') : `${parts.filter(Boolean).join(' ')} ${spoken}`)

  // The plan, most precise first. Each entry records its angle so a log or a test
  // can say *why* a query was asked, not just that it was.
  const plan = []
  const addQuery = (query, angle) => {
    const text = String(query ?? '').trim()
    if (text === '') return
    if (plan.some((entry) => entry.query.toLowerCase() === text.toLowerCase())) return
    plan.push({ query: text, angle })
  }

  // 1. The reader's exact phrase. Highest precision: they wrote it down.
  for (const phrase of guidance.quoted) addQuery(dated([phrase]), 'quoted')

  // 2. The topic itself, as a news query.
  addQuery(dated([name, 'news']), 'topic')
  addQuery(dated([name, 'top stories']), 'roundup')

  // 3. The reader's own subjects, in small batches so each query stays specific.
  for (const batch of chunk(guidance.keywords, TERMS_PER_QUERY)) addQuery(dated(batch), 'subject')

  // 4. The same subjects anchored to the topic, so a batch cannot drift.
  if (guidance.keywords.length > 0) addQuery(dated([name, ...guidance.keywords.slice(0, TERMS_PER_QUERY)]), 'anchored')

  // 5. Sources the reader named, asked directly.
  for (const host of guidance.preferHosts) addQuery(dated([name, `site:${host}`]), 'preferred-host')
  for (const host of guidance.preferHosts) {
    for (const phrase of guidance.quoted.slice(0, 1)) addQuery(dated([phrase, `site:${host}`]), 'preferred-host')
  }

  // 6. A category topic has no reporting under its own name, so it is swept
  //    through the organisations that make its news. A *specific* topic is
  //    different and is actively harmed by the sweep: asking about "OpenAI
  //    Anthropic" for "LLM Local Deployment" returns general AI news, which is
  //    exactly what the reader did not ask for. So the sweep runs only when the
  //    topic has no qualifying words of its own.
  const entities = qualifiers.length > 0 ? [] : beatEntities(name)
  for (const pair of chunk(entities, 2)) addQuery(dated(pair), 'beat')

  // Broader phrasings, no date. Used only when the plan found nothing: a query
  // with the day in it is precise but brittle, and a thin topic needs width.
  const fallback = []
  const addFallback = (query) => {
    const text = String(query ?? '').trim()
    if (text === '') return
    if (fallback.some((entry) => entry.toLowerCase() === text.toLowerCase())) return
    fallback.push(text)
  }
  addFallback(`${name} news`)
  for (const phrase of guidance.quoted) addFallback(phrase)
  for (const word of guidance.keywords.slice(0, TERMS_PER_QUERY)) addFallback(word)
  addFallback(name)

  return {
    topic: name,
    note: guidance.note,
    keywords: guidance.keywords,
    quoted: guidance.quoted,
    excludes: guidance.excludes,
    preferHosts: guidance.preferHosts,
    avoidHosts: guidance.avoidHosts,
    // The qualifying words of the topic, and whether the topic is a category (no
    // qualifiers) or a specific subject (some). A category gets the beat sweep; a
    // specific topic is searched by its own name and its guidance.
    qualifiers,
    isCategory: qualifiers.length === 0,
    // A deployment topic can only concern a model whose weights you can obtain, so
    // a story about a hosted model is out of scope for it.
    openSourceOnly: requiresOpenSource(qualifiers),
    plan: plan.slice(0, Math.max(1, maxQueries)),
    fallback: fallback.slice(0, Math.max(1, maxFallback)),
    criteria: reviewCriteria({ topic: name, guidance, openSourceOnly: requiresOpenSource(qualifiers) }),
    hasGuidance: guidance.empty !== true,
  }
}

/**
 * Turn the guidance into statements a reviewer can apply.
 *
 * These are the sentences that go to the model, and they are also what the page
 * shows, so a reader can see how their guidance was understood.
 * @param {object} skill - `{ topic, guidance }`.
 * @returns {string[]} one criterion per line.
 */
export function reviewCriteria(skill) {
  const topic = String(skill?.topic ?? '')
  const guidance = skill?.guidance ?? skill ?? {}
  const out = []

  out.push(`Keep only stories that report an event concerning "${topic}".`)
  // The deployment rule comes before the reader's own subjects, because it decides
  // whether a story is in scope at all.
  if (skill?.openSourceOnly === true) {
    out.push(
      'Only open-source models can be deployed locally: a story about a closed model (GPT, Claude, Gemini, Grok) is out of scope unless it also concerns an open-weight model or says the weights were released.',
    )
  }
  if (Array.isArray(guidance.keywords) && guidance.keywords.length > 0) {
    out.push(`The reader asked for these subjects in particular: ${guidance.keywords.slice(0, 8).join(', ')}.`)
  }
  if (Array.isArray(guidance.quoted) && guidance.quoted.length > 0) {
    out.push(`These exact phrases matter to the reader: ${guidance.quoted.join(', ')}.`)
  }
  if (Array.isArray(guidance.excludes) && guidance.excludes.length > 0) {
    out.push(`Reject anything about: ${guidance.excludes.join(', ')}.`)
  }
  if (Array.isArray(guidance.preferHosts) && guidance.preferHosts.length > 0) {
    out.push(`Prefer reporting from: ${guidance.preferHosts.join(', ')}.`)
  }
  if (Array.isArray(guidance.avoidHosts) && guidance.avoidHosts.length > 0) {
    out.push(`Reject anything published by: ${guidance.avoidHosts.join(', ')}.`)
  }
  out.push('A story outside the reader\'s guidance is not relevant, however on-topic it looks.')
  return out
}

/**
 * Does a hit match one of the reader's quoted phrases?
 *
 * A quoted phrase is a requirement, not a hint: the reader wrote it in quotes
 * because that wording is the point. Matching is case-insensitive and checks the
 * title and snippet.
 * @param {object} hit - `{ title, snippet }`.
 * @param {string[]} quoted - the phrases.
 * @returns {boolean} whether any phrase appears.
 */
export function matchesQuoted(hit, quoted) {
  if (!Array.isArray(quoted) || quoted.length === 0) return false
  const text = `${String(hit?.title ?? '')} ${String(hit?.snippet ?? '')}`.toLowerCase()
  return quoted.some((phrase) => {
    const needle = String(phrase ?? '').trim().toLowerCase()
    return needle !== '' && text.includes(needle)
  })
}

/**
 * Does a hit come from a host the reader rejected?
 * @param {object} hit - `{ url }`.
 * @param {string[]} avoidHosts - hosts to reject.
 * @returns {string} the offending host, or ''.
 */
export function avoidHostHit(hit, avoidHosts) {
  if (!Array.isArray(avoidHosts) || avoidHosts.length === 0) return ''
  let host = ''
  try {
    host = new URL(String(hit?.url ?? '')).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
  for (const avoid of avoidHosts) {
    const needle = String(avoid ?? '').toLowerCase()
    if (needle === '') continue
    if (host === needle || host.endsWith(`.${needle}`)) return needle
  }
  return ''
}

/**
 * The prompt that asks a model to review candidates against a topic's criteria.
 *
 * The model is asked one question per candidate — keep or drop, with a short
 * reason — and it may only *remove*. It cannot add a story, rewrite a headline or
 * reorder the ranking: those are the pipeline's decisions, and letting a model
 * make them would make the digest unreviewable.
 * @param {object} skill - the topic skill.
 * @param {object[]} hits - candidates, each with an `id`.
 * @returns {{ system: string, user: string }} the prompt halves.
 */
export function buildReviewPrompt(skill, hits) {
  const criteria = Array.isArray(skill?.criteria) ? skill.criteria : []
  const system = [
    'You are reviewing candidate news stories for a daily digest.',
    'For each candidate, decide whether it belongs in a digest built for ONE reader.',
    'The reader wrote the guidance below. Apply it strictly: a story that is on the topic but outside their guidance does not belong.',
    'Reply with ONE JSON object and nothing else — no prose, no code fence.',
    'Shape: {"drop": [{"id": number, "reason": string}]}',
    'Rules:',
    '- Drop a story only when you can name the reason in terms of the criteria. If a story plausibly belongs, keep it.',
    '- Never invent a story, never rewrite a title, never reorder anything.',
    '- If every candidate belongs, reply {"drop": []}.',
    '- A reason is at most 12 words and must be specific to that story.',
  ].join('\n')

  const lines = [`Topic: ${skill?.topic ?? ''}`, '']
  if (typeof skill?.note === 'string' && skill.note.trim() !== '') {
    lines.push('The reader\'s guidance, verbatim:')
    lines.push(skill.note.trim())
    lines.push('')
  }
  lines.push('Criteria:')
  for (const criterion of criteria) lines.push(`- ${criterion}`)
  lines.push('')
  lines.push('Candidates:')
  for (const hit of hits) {
    lines.push(`[${hit.id}] ${hit.title}`)
    const date = typeof hit.publishedAt === 'string' && hit.publishedAt !== '' ? hit.publishedAt.slice(0, 10) : 'unknown'
    lines.push(`    published: ${date}`)
    if (typeof hit.snippet === 'string' && hit.snippet.trim() !== '') {
      lines.push(`    snippet: ${hit.snippet.trim().slice(0, 280)}`)
    }
    lines.push('')
  }
  return { system, user: lines.join('\n') }
}

/**
 * Read a review reply.
 *
 * Only ids the reviewer was actually offered are honoured, so a hallucinated or
 * out-of-range id cannot remove a story that was never under review.
 * @param {string} raw - the model's reply.
 * @param {number[]} allowedIds - the ids that were offered.
 * @returns {Map<number, string>} id → reason, for the drops only.
 */
export function parseReviewReply(raw, allowedIds) {
  const allowed = new Set((Array.isArray(allowedIds) ? allowedIds : []).map(Number))
  const out = new Map()
  const text = String(raw ?? '')
  if (text.trim() === '') return out

  // Accept a bare object, a JSON array, or an object inside a code fence.
  let payload = null
  const candidates = [text, text.replace(/^```(?:json)?/i, '').replace(/```$/, '')]
  const objectMatch = text.match(/\{[\s\S]*\}/)
  if (objectMatch !== null) candidates.push(objectMatch[0])
  for (const candidate of candidates) {
    try {
      payload = JSON.parse(candidate)
      break
    } catch {
      // try the next shape
    }
  }
  if (payload === null) return out

  const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.drop) ? payload.drop : []
  for (const entry of entries) {
    const id = Number(entry?.id ?? entry)
    if (!Number.isFinite(id) || !allowed.has(id)) continue
    const reason = String(entry?.reason ?? '').trim().slice(0, 120)
    out.set(id, reason === '' ? 'outside the reader\'s guidance' : reason)
  }
  return out
}

/**
 * Apply the deterministic parts of a skill to a list of hits.
 *
 * The hard rules run before anything reaches a model: a rejected host is dropped,
 * and a rejected term is dropped. A quoted phrase is deliberately *not* a hard
 * filter — a story about the quoted subject may word its headline differently,
 * and dropping it would defeat the purpose — so it is passed to the reviewer as
 * evidence instead.
 * @param {object[]} hits - the candidate hits.
 * @param {object} skill - the topic skill.
 * @returns {{ kept: object[], dropped: object[] }} the survivors and the removals.
 */
export function applySkillFilters(hits, skill) {
  const list = Array.isArray(hits) ? hits : []
  const avoidHosts = Array.isArray(skill?.avoidHosts) ? skill.avoidHosts : []
  const excludes = Array.isArray(skill?.excludes) ? skill.excludes : []
  const kept = []
  const dropped = []
  for (const hit of list) {
    const host = avoidHostHit(hit, avoidHosts)
    if (host !== '') {
      dropped.push({ ...hit, droppedBy: `host ${host}` })
      continue
    }
    const text = `${String(hit?.title ?? '')} ${String(hit?.snippet ?? '')}`.toLowerCase()
    const term = excludes.find((word) => {
      const needle = String(word ?? '').trim().toLowerCase()
      if (needle === '') return false
      // A CJK exclusion has no word boundary to anchor on.
      if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(needle)) return text.includes(needle)
      const stem = needle.replace(/(ies)$/, 'y').replace(/([a-z])s$/, '$1')
      const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^a-z0-9])${escaped}(s|es)?($|[^a-z0-9])`, 'i').test(text)
    })
    if (term !== undefined) {
      dropped.push({ ...hit, droppedBy: `term ${term}` })
      continue
    }
    // A deployment topic is about models you can obtain the weights for. A story
    // about a hosted model is about consuming it, not running it, and there is
    // nothing in it for someone deploying locally.
    if (skill?.openSourceOnly === true) {
      const verdict = closedModelOnly(hit)
      if (verdict.closedOnly) {
        dropped.push({ ...hit, droppedBy: `closed model ${verdict.model}` })
        continue
      }
    }
    kept.push(hit)
  }
  return { kept, dropped }
}
