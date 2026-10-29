/**
 * Daily News Digest — turning what the user typed into searchable sources.
 *
 * A source row is free text, because people describe sources in four different
 * ways: a domain (`CNN.com`), a publication (`QbitAI`, `The Berkeley Artificial
 * Intelligence Research Blog`), a platform (`reddit`, `zhihu`), or a news-data
 * provider (`OpenBB`). One row has to become something a search engine can be
 * asked about, and something a result can be attributed back to.
 *
 * That is what a *plan* is: the search suffix for one source, the hosts that
 * count as that source, and a reach weight used only when a story has no
 * measurable engagement of its own.
 */

/** Platforms people name instead of a domain. `sites` are searched, `reach` is relative audience size. */
export const PLATFORMS = [
  { aliases: ['reddit'], label: 'Reddit', sites: ['reddit.com'], reach: 3.2 },
  { aliases: ['twitter', 'x', 'x.com'], label: 'X / Twitter', sites: ['x.com', 'twitter.com'], reach: 3.0 },
  { aliases: ['hacker news', 'hackernews', 'hn', 'ycombinator'], label: 'Hacker News', sites: ['news.ycombinator.com'], reach: 2.0 },
  { aliases: ['github'], label: 'GitHub', sites: ['github.com'], reach: 1.8 },
  { aliases: ['zhihu', '知乎'], label: 'Zhihu', sites: ['zhihu.com'], reach: 2.2 },
  { aliases: ['weibo', '微博'], label: 'Weibo', sites: ['weibo.com', 'weibo.cn'], reach: 3.0 },
  { aliases: ['v2ex'], label: 'V2EX', sites: ['v2ex.com'], reach: 1.2 },
  { aliases: ['bilibili', 'b站', '哔哩哔哩'], label: 'Bilibili', sites: ['bilibili.com'], reach: 2.4 },
  { aliases: ['youtube'], label: 'YouTube', sites: ['youtube.com'], reach: 3.0 },
  { aliases: ['stackoverflow', 'stack overflow'], label: 'Stack Overflow', sites: ['stackoverflow.com'], reach: 1.4 },
  { aliases: ['medium'], label: 'Medium', sites: ['medium.com'], reach: 1.6 },
  { aliases: ['substack'], label: 'Substack', sites: ['substack.com'], reach: 1.5 },
  { aliases: ['linkedin'], label: 'LinkedIn', sites: ['linkedin.com'], reach: 2.2 },
  { aliases: ['douban', '豆瓣'], label: 'Douban', sites: ['douban.com'], reach: 1.4 },
  { aliases: ['juejin', '掘金'], label: 'Juejin', sites: ['juejin.cn'], reach: 1.2 },
  { aliases: ['producthunt', 'product hunt'], label: 'Product Hunt', sites: ['producthunt.com'], reach: 1.3 },
  { aliases: ['hugging face', 'huggingface'], label: 'Hugging Face', sites: ['huggingface.co'], reach: 1.8 },
]

/** Publications and blogs people name by title. */
export const PUBLICATIONS = [
  { aliases: ['qbitai', '量子位'], label: 'QbitAI', sites: ['qbitai.com'], reach: 2.0, kind: 'blog' },
  { aliases: ['机器之心', 'jiqizhixin'], label: '机器之心', sites: ['jiqizhixin.com'], reach: 2.0, kind: 'blog' },
  { aliases: ['新智元'], label: '新智元', sites: ['aitop100.cn'], reach: 1.8, kind: 'blog' },
  { aliases: ['the berkeley artificial intelligence research blog', 'bair', 'berkeley ai research'], label: 'BAIR Blog', sites: ['bair.berkeley.edu'], reach: 1.6, kind: 'blog' },
  { aliases: ['openai blog', 'openai'], label: 'OpenAI', sites: ['openai.com'], reach: 2.6, kind: 'blog' },
  { aliases: ['anthropic', 'anthropic blog'], label: 'Anthropic', sites: ['anthropic.com'], reach: 2.4, kind: 'blog' },
  { aliases: ['deepmind', 'google deepmind'], label: 'Google DeepMind', sites: ['deepmind.google'], reach: 2.4, kind: 'blog' },
  { aliases: ['google research', 'google ai blog'], label: 'Google Research', sites: ['research.google', 'blog.google'], reach: 2.2, kind: 'blog' },
  { aliases: ['meta ai', 'fair'], label: 'Meta AI', sites: ['ai.meta.com'], reach: 2.0, kind: 'blog' },
  { aliases: ['microsoft research'], label: 'Microsoft Research', sites: ['microsoft.com'], reach: 2.0, kind: 'blog' },
  { aliases: ['arxiv'], label: 'arXiv', sites: ['arxiv.org'], reach: 1.6, kind: 'data' },
  { aliases: ['techcrunch'], label: 'TechCrunch', sites: ['techcrunch.com'], reach: 2.4, kind: 'news' },
  { aliases: ['the verge'], label: 'The Verge', sites: ['theverge.com'], reach: 2.4, kind: 'news' },
  { aliases: ['ars technica'], label: 'Ars Technica', sites: ['arstechnica.com'], reach: 2.2, kind: 'news' },
  { aliases: ['mit technology review', 'technology review'], label: 'MIT Technology Review', sites: ['technologyreview.com'], reach: 2.2, kind: 'news' },
  { aliases: ['ieee spectrum'], label: 'IEEE Spectrum', sites: ['spectrum.ieee.org'], reach: 2.0, kind: 'news' },
  { aliases: ['venturebeat'], label: 'VentureBeat', sites: ['venturebeat.com'], reach: 2.0, kind: 'news' },
  { aliases: ['wired'], label: 'Wired', sites: ['wired.com'], reach: 2.2, kind: 'news' },
  { aliases: ['reuters'], label: 'Reuters', sites: ['reuters.com'], reach: 3.4, kind: 'news' },
  { aliases: ['associated press', 'ap news', 'ap'], label: 'AP News', sites: ['apnews.com'], reach: 3.2, kind: 'news' },
  { aliases: ['bbc'], label: 'BBC', sites: ['bbc.com', 'bbc.co.uk'], reach: 3.4, kind: 'news' },
  { aliases: ['cnn'], label: 'CNN', sites: ['cnn.com'], reach: 3.4, kind: 'news' },
  { aliases: ['the new york times', 'new york times', 'nyt'], label: 'The New York Times', sites: ['nytimes.com'], reach: 3.4, kind: 'news' },
  { aliases: ['wall street journal', 'wsj'], label: 'The Wall Street Journal', sites: ['wsj.com'], reach: 3.2, kind: 'news' },
  { aliases: ['bloomberg'], label: 'Bloomberg', sites: ['bloomberg.com'], reach: 3.2, kind: 'news' },
  { aliases: ['financial times', 'ft'], label: 'Financial Times', sites: ['ft.com'], reach: 3.0, kind: 'news' },
  { aliases: ['the guardian'], label: 'The Guardian', sites: ['theguardian.com'], reach: 3.0, kind: 'news' },
  { aliases: ['nikkei', '日经'], label: 'Nikkei', sites: ['nikkei.com', 'asia.nikkei.com'], reach: 2.8, kind: 'news' },
  { aliases: ['36kr', '36氪'], label: '36Kr', sites: ['36kr.com'], reach: 2.2, kind: 'news' },
  { aliases: ['虎嗅', 'huxiu'], label: '虎嗅', sites: ['huxiu.com'], reach: 1.8, kind: 'news' },
  { aliases: ['少数派', 'sspai'], label: '少数派', sites: ['sspai.com'], reach: 1.4, kind: 'news' },
  { aliases: ['infoq'], label: 'InfoQ', sites: ['infoq.com', 'infoq.cn'], reach: 1.8, kind: 'news' },
  { aliases: ['nature'], label: 'Nature', sites: ['nature.com'], reach: 3.0, kind: 'news' },
  { aliases: ['science'], label: 'Science', sites: ['science.org'], reach: 2.8, kind: 'news' },
  { aliases: ['新华社', 'xinhua'], label: '新华社', sites: ['news.cn', 'xinhuanet.com'], reach: 3.4, kind: 'news' },
  { aliases: ['人民网', "people's daily", 'peoples daily'], label: '人民网', sites: ['people.com.cn'], reach: 3.4, kind: 'news' },
  { aliases: ['澎湃新闻', 'the paper'], label: '澎湃新闻', sites: ['thepaper.cn'], reach: 2.8, kind: 'news' },
  { aliases: ['财新', 'caixin'], label: '财新', sites: ['caixin.com'], reach: 2.6, kind: 'news' },
  { aliases: ['第一财经', 'yicai'], label: '第一财经', sites: ['yicai.com'], reach: 2.4, kind: 'news' },
  { aliases: ['央视新闻', 'cctv'], label: '央视新闻', sites: ['cctv.com', 'news.cctv.com'], reach: 3.2, kind: 'news' },
]

/** Open news-data providers. Searching them means searching the coverage they index. */
export const DATA_PROVIDERS = [
  { aliases: ['openbb'], label: 'OpenBB', sites: ['openbb.co', 'github.com/openbb-finance'], reach: 1.6, hint: 'financial and market news' },
  { aliases: ['gdelt'], label: 'GDELT', sites: ['gdeltproject.org'], reach: 2.0, hint: 'global event coverage' },
  { aliases: ['newsapi', 'news api'], label: 'NewsAPI', sites: ['newsapi.org'], reach: 1.8, hint: 'aggregated headlines' },
  { aliases: ['common crawl', 'commoncrawl'], label: 'Common Crawl', sites: ['commoncrawl.org'], reach: 1.4, hint: 'archived web coverage' },
  { aliases: ['kaggle'], label: 'Kaggle', sites: ['kaggle.com'], reach: 1.4, hint: 'datasets and notebooks' },
]

/** Reach assumed for a source we do not recognise; the page shows it as an estimate. */
export const DEFAULT_REACH = 1.0

/** A bare domain: `cnn.com`, `top81.ws`, `news.ycombinator.com`. */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/\S*)?$/i

/** Normalise a host: lower case, no scheme, no `www.`, no path. */
export function normalizeHost(value) {
  let text = String(value ?? '').trim().toLowerCase()
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  text = text.replace(/^www\./, '')
  text = text.split(/[/?#]/)[0]
  text = text.replace(/:\d+$/, '')
  return text
}

/** Words that stay upper case when a host name is turned into a label. */
const ACRONYMS = new Set(['cnn', 'bbc', 'nyt', 'wsj', 'ft', 'ap', 'bair', 'hn', 'ai', 'mit', 'ieee', 'npr', 'usa', 'it', 'tv', 'vr', 'ar'])

/** Second-level labels that belong to the public suffix, not the site name. */
const PUBLIC_SUFFIX_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'or', 'ne', 'go'])

/**
 * The readable name for a host: `bair.berkeley.edu` → `Berkeley`, `top81.ws` → `Top81`.
 * Only used when the catalog has no better answer.
 * @param {string} host - a normalised host.
 * @returns {string} a short label.
 */
export function labelForHost(host) {
  const plain = normalizeHost(host)
  if (plain === '') return 'Unknown'
  const parts = plain.split('.').filter((part) => part !== '')
  if (parts.length === 0) return plain
  // Walk back past the public suffix: `bbc.co.uk` names the site at `bbc`,
  // `bair.berkeley.edu` at `berkeley`, `top81.ws` at `top81`.
  let index = parts.length - 2
  while (index > 0 && PUBLIC_SUFFIX_LABELS.has(parts[index])) index -= 1
  const name = index >= 0 ? parts[index] : parts[0]
  if (name === '') return plain
  // `cnn.com` is CNN, not Cnn; a plain word is capitalised.
  if (ACRONYMS.has(name)) return name.toUpperCase()
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Does a result URL belong to one of a plan's hosts?
 * @param {string} url - the result URL.
 * @param {string[]} hosts - the plan's hosts.
 * @returns {boolean} whether the result is from that source.
 */
export function matchesHosts(url, hosts) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  host = host.replace(/^www\./, '')
  return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
}

/** A stable id for a plan, used as the source label on stories. */
function planId(label, kind) {
  return `${kind}:${label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')}`
}

/**
 * Turn one typed source row into searchable plans.
 *
 * A row can yield more than one plan: `x.com` and `twitter.com` are one source
 * with two hosts, and a data provider contributes both its own site and the
 * coverage it indexes.
 * @param {string} row - the user's source text.
 * @returns {object|null} a plan, or null when the row is empty.
 */
export function planForSource(row) {
  const text = String(row ?? '').trim()
  if (text === '') return null
  const lower = text.toLowerCase().replace(/\s+/g, ' ')

  const platform = PLATFORMS.find((entry) => entry.aliases.includes(lower))
  if (platform !== undefined) {
    return {
      id: planId(platform.label, 'forum'),
      label: platform.label,
      kind: 'forum',
      hosts: platform.sites,
      query: platform.sites.map((site) => `site:${site}`).join(' OR '),
      reach: platform.reach,
    }
  }

  const data = DATA_PROVIDERS.find((entry) => entry.aliases.includes(lower))
  if (data !== undefined) {
    return {
      id: planId(data.label, 'data'),
      label: data.label,
      kind: 'data',
      hosts: data.sites,
      query: data.hint === undefined ? text : `${text} ${data.hint}`,
      reach: data.reach,
    }
  }

  const publication = PUBLICATIONS.find((entry) => entry.aliases.includes(lower))
  if (publication !== undefined) {
    return {
      id: planId(publication.label, publication.kind),
      label: publication.label,
      kind: publication.kind,
      hosts: publication.sites,
      query: publication.sites.map((site) => `site:${site}`).join(' OR '),
      reach: publication.reach,
    }
  }

  if (DOMAIN_RE.test(text)) {
    const host = normalizeHost(text)
    return {
      id: planId(host, 'site'),
      label: labelForHost(host),
      kind: 'site',
      hosts: [host],
      query: `site:${host}`,
      reach: DEFAULT_REACH,
    }
  }

  // A named blog we do not know: search for the name itself. The result's host
  // is then attributed to that name only when it shares a word with it, which
  // `attribute` handles.
  return {
    id: planId(text, 'named'),
    label: text,
    kind: 'named',
    hosts: [],
    query: `"${text}"`,
    reach: DEFAULT_REACH,
    name: lower,
  }
}

/**
 * Turn every typed source row into plans, dropping duplicates.
 * @param {string[]} rows - the saved source rows.
 * @returns {object[]} the plans.
 */
export function plansForSources(rows) {
  const plans = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const plan = planForSource(row)
    if (plan === null || seen.has(plan.id)) continue
    seen.add(plan.id)
    plans.push(plan)
  }
  return plans
}

/**
 * The query used for one topic against one plan.
 *
 * A bare topic is a *definition* query, not a news query. "AI News news today"
 * returns the Britannica entry, a list of AI tool directories, and the ChatGPT
 * home page — because a search engine reads "AI News" as a thing to explain,
 * not as a beat to report. That is why a day with the largest IPO in history
 * produced "no concrete news".
 *
 * A news query needs a time signal and a news signal. The date is the strongest
 * one available: `AI news October 26 2026` returns the day's actual reporting.
 * So the open queries carry the digest's date, and the per-source queries keep
 * their `site:` restriction but gain the same date.
 *
 * When the user has written guidance for the topic, its keywords join the query:
 * the topic says *what subject*, the guidance says *which part of it*. The
 * keywords are added, never substituted, so a guidance that turns out to be too
 * narrow cannot cut the topic's own coverage out.
 * @param {string} topic - the user's topic text.
 * @param {object} plan - a source plan.
 * @param {string} [day] - the digest's day, `YYYY-MM-DD`.
 * @param {object} [guidance] - a parsed guidance, from `parseGuidance`.
 * @returns {string} a search query.
 */
export function queryFor(topic, plan, day = '', guidance = null) {
  const base = guidanceQuery(topic, day, guidance)
  return `${base} ${plan.query}`.trim()
}

/**
 * A topic plus its guidance keywords, framed as a news query.
 * @param {string} topic - the topic text.
 * @param {string} [day] - the digest's day.
 * @param {object} [guidance] - a parsed guidance.
 * @returns {string} the query without a source restriction.
 */
export function guidanceQuery(topic, day = '', guidance = null) {
  const dated = newsQuery(topic, day)
  const keywords = Array.isArray(guidance?.keywords) ? guidance.keywords.slice(0, 4) : []
  if (keywords.length === 0) return dated
  return `${dated} ${keywords.join(' ')}`.trim()
}

/** A date as a search engine reads it: `October 26 2026`. */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Render a `YYYY-MM-DD` day as words, which search engines index better than a
 * numeric date in many locales.
 * @param {string} day - `YYYY-MM-DD`.
 * @returns {string} e.g. `October 26 2026`, or empty when unparseable.
 */
export function spokenDate(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''))
  if (match === null) return ''
  const month = Number(match[2])
  const date = Number(match[3])
  if (month < 1 || month > 12 || date < 1 || date > 31) return ''
  return `${MONTH_NAMES[month - 1]} ${date} ${match[1]}`
}

/**
 * Turn a topic into a query that asks for today's reporting on it.
 *
 * The topic word itself is kept, because it is what makes the result *about*
 * the topic. What is added is the news framing the topic lacks.
 * @param {string} topic - the user's topic text.
 * @param {string} [day] - the digest's day.
 * @returns {string} the query.
 */
export function newsQuery(topic, day = '') {
  const spoken = spokenDate(day)
  return spoken === '' ? `${topic} news` : `${topic} news ${spoken}`
}

/**
 * The organisations that *are* a beat, for the topics that name a category.
 *
 * This is the difference between a topic and a beat. "Embodied AI" is a beat:
 * an article about a humanoid robot says "humanoid robot". "AI News" is a
 * *category*: the day's biggest AI story was "Anthropic files for IPO", which
 * never says "AI News" and is not discoverable by searching those words. The
 * same is true of "Global Economics" (the story says "Fed" or "IMF") and of
 * "LLM Local Deployment" (the story says "Ollama" or "GGUF").
 *
 * So a category topic is searched through the concrete entities that make news
 * in it. These are real, named organisations, and a story about any of them is
 * a story in that category — which is what makes the results concrete instead
 * of definitions.
 */
const BEAT_ENTITIES = {
  ai: [
    'OpenAI', 'Anthropic', 'Google DeepMind', 'Nvidia', 'Meta AI', 'Mistral',
    'Hugging Face', 'Cohere', 'Stability AI', 'xAI', 'Perplexity', 'Scale AI',
    'Databricks', 'Amazon AI', 'Microsoft AI', 'Apple AI',
  ],
  llm: ['OpenAI', 'Anthropic', 'Google DeepMind', 'Meta', 'Mistral', 'Ollama', 'vLLM'],
  embodied: ['Figure AI', 'Tesla Optimus', 'Boston Dynamics', 'Unitree', 'Agility Robotics', '1X', 'Physical Intelligence'],
  economics: ['Federal Reserve', 'European Central Bank', 'IMF', 'World Bank', 'Bank of Japan', 'US Treasury'],
  geopolitics: ['United Nations', 'NATO', 'European Union', 'State Department', 'Kremlin', 'Foreign Ministry'],
}

/** Which beat a topic belongs to, by the words it contains. */
function beatFor(topic) {
  const text = String(topic ?? '').toLowerCase()
  // Order matters: a more specific beat wins over a general one.
  if (/\b(llm|local deployment|local model|self-host)/.test(text)) return 'llm'
  if (/\b(embodied|robot|humanoid)/.test(text)) return 'embodied'
  if (/\b(economic|economy|market|finance|inflation|trade)/.test(text)) return 'economics'
  if (/\b(geopolitic|foreign|diploma|war|conflict)/.test(text)) return 'geopolitics'
  if (/\b(ai|artificial intelligence|machine learning|ml)\b/.test(text)) return 'ai'
  return null
}

/**
 * The open (source-agnostic) queries for one topic.
 *
 * Three shapes, because they find different things:
 *   1. the topic plus the day — finds the day's articles when the topic is a
 *      real beat;
 *   2. the topic plus "top stories" — finds the day's roundups, which surface
 *      the biggest story even when its headline never names the topic;
 *   3. for a *category* topic, its named organisations — finds the concrete
 *      reporting that the category word alone cannot.
 *
 * With guidance, two more shapes are added: one query of the guidance keywords
 * alone (which is what the user actually means), and one that combines them with
 * the topic. Both are needed: the keyword-only query finds the specific material
 * the user described, and the combined one keeps the result anchored to the
 * topic rather than drifting to a keyword that means something else.
 * @param {string} topic - the user's topic text.
 * @param {string} [day] - the digest's day.
 * @param {object} [guidance] - a parsed guidance.
 * @returns {string[]} the queries.
 */
export function openQueries(topic, day = '', guidance = null) {
  const spoken = spokenDate(day)
  const keywords = Array.isArray(guidance?.keywords) ? guidance.keywords : []

  if (spoken === '') {
    const bare = [`${topic} news`, `${topic} latest headlines`]
    if (keywords.length > 0) bare.push(`${keywords.slice(0, 6).join(' ')} news`)
    return bare
  }

  const queries = [
    `${topic} news ${spoken}`,
    `${topic} top stories ${spoken}`,
  ]

  // The guidance is the user's own description of what they want, so it gets its
  // own queries. The keywords are walked in small batches rather than truncated:
  // a brief that names twelve companies and models has twelve subjects, and
  // taking only the first four would silently search a third of what was asked
  // for. Three terms per query keeps each query readable and specific.
  for (const batch of chunk(keywords, 3)) {
    queries.push(`${batch.join(' ')} ${spoken}`)
  }
  // One anchored query, so a batch cannot drift off-topic.
  if (keywords.length > 0) queries.push(`${topic} ${keywords.slice(0, 3).join(' ')} ${spoken}`)

  // The entity sweep is what turns a category into actual news. Two entities per
  // query, not one per query: that keeps the query count bounded while still
  // asking about the organisations most likely to have made news.
  const beat = beatFor(topic)
  const entities = beat === null ? [] : BEAT_ENTITIES[beat] ?? []
  for (let index = 0; index < entities.length; index += 2) {
    const pair = entities.slice(index, index + 2)
    queries.push(`${pair.join(' ')} ${spoken}`)
  }

  return queries
}

/** Split a list into chunks of at most `size`. */
function chunk(list, size) {
  const out = []
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
  return out
}

/**
 * Which plan a result belongs to, if any.
 *
 * Host matching is the reliable case. A named source we could not resolve to a
 * host is attributed when the result's host or title carries its words, so
 * `QbitAI` still credits qbitai.com even when the catalog misses it.
 * @param {string} url - the result URL.
 * @param {string} title - the result title.
 * @param {object[]} plans - every plan for this digest.
 * @returns {object|null} the matching plan.
 */
export function attribute(url, title, plans) {
  for (const plan of plans) {
    if (plan.hosts.length > 0 && matchesHosts(url, plan.hosts)) return plan
  }
  let host = ''
  try {
    host = normalizeHost(new URL(url).hostname)
  } catch {
    host = ''
  }
  const haystack = `${host} ${String(title ?? '').toLowerCase()}`
  for (const plan of plans) {
    if (plan.kind !== 'named' || plan.name === undefined) continue
    const words = plan.name.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((word) => word.length >= 4)
    if (words.length > 0 && words.some((word) => haystack.includes(word))) return plan
  }
  return null
}
