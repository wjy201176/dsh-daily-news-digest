/**
 * Daily News Digest — is this page *news*?
 *
 * Relevance screening answers "is this about the topic?". It cannot answer "is
 * this an event?", and that is the remaining failure: a digest ranked a Britannica
 * entry, the OpenAI home page, and a Zhihu tutorial called "understanding LLM
 * terms in one article" as if they were the day's reporting. They are all
 * genuinely about the topic, and none of them reports anything that happened.
 *
 * So every hit gets a second judgement, separate from relevance: what *kind* of
 * page is it, and does it describe an event? The approach follows Horizon's
 * profile scoring — a 0-10 score with a threshold — but the signals are lexical
 * and deterministic, so a digest with no model still separates news from
 * evergreen material.
 *
 * Two rules do most of the work:
 *
 *   - Some page kinds are never news, however relevant: a home page, an
 *     encyclopaedia entry, a tag listing, a tutorial. These are dropped outright.
 *   - A page that is news-shaped but carries no date is kept and ranked below
 *     dated items — unless nothing about it says "event", in which case it is
 *     evergreen and dropped.
 */

/** Page kinds that can never be a news story. */
export const NON_NEWS_KINDS = new Set(['homepage', 'reference', 'tutorial', 'listing', 'aggregator'])

/** Hosts that publish reference material rather than reporting. */
const REFERENCE_HOSTS = [
  'britannica.com', 'wikipedia.org', 'baike.baidu.com', 'baike.sogou.com',
  'zhidao.baidu.com', 'jingyan.baidu.com', 'wenku.baidu.com', 'answers.microsoft.com',
  'learn.microsoft.com', 'support.microsoft.com', 'docs.python.org', 'developer.mozilla.org',
  'stackoverflow.com', 'stackexchange.com', 'superuser.com', 'askubuntu.com',
  'csdn.net',
]

/** Hosts that answer questions rather than report events. */
const QA_HOSTS = ['quora.com', 'zhidao.baidu.com', 'answers.microsoft.com', 'stackoverflow.com', 'stackexchange.com', 'superuser.com', 'askubuntu.com']

/**
 * Does `host` belong to `domain`?
 *
 * A suffix match alone is wrong for user-content hosts: `someone.quora.com` is a
 * Quora *answer* (a question page), while `stephenmillersspace5.quora.com` is a
 * personal Quora *Space*, which publishes posts like a blog. The subdomain tells
 * them apart, so only the bare domain and `www.` are treated as the Q&A site.
 * @param {string} host - the normalised hostname.
 * @param {string} domain - the domain to test.
 * @returns {boolean} whether it is that domain or its www form.
 */
function isSameSite(host, domain) {
  return host === domain || host === `www.${domain}`
}

/** Does `host` sit anywhere under `domain`? */
function isUnder(host, domain) {
  return host === domain || host.endsWith(`.${domain}`)
}

/** Hosts that are link directories or tool catalogues. */
const AGGREGATOR_HOSTS = [
  'ai-bot.cn', 'theresanaiforthat.com', 'futurepedia.io', 'toolify.ai', 'topai.tools',
  'producthunt.com', 'alternativeto.net', 'g2.com', 'capterra.com',
]

/**
 * Title shapes that mark evergreen explainer content in English.
 *
 * Each pattern is anchored to how the title *starts* or what it asks, because
 * "how to" anywhere in a headline can also describe a news event ("Russia says
 * how to end the war"). The anchored forms are the tutorial ones.
 */
const EVERGREEN_EN = [
  /^(how|what|why)\s+(to|is|are|does|do|can|should)\b/i,
  /^(a|an|the)\s+(beginner|complete|ultimate|practical|comprehensive|quick)\b/i,
  /^(introduction|intro|guide|tutorial|explainer|primer|handbook|cheat ?sheet)\b/i,
  /^(getting started|learn|understanding|explained|deep dive into)\b/i,
  /^(top|best)\s+\d+\b/i,
  /\b(explained|for beginners|step[- ]by[- ]step|cheat ?sheet|crash course)\b/i,
  /\b(what is|what are)\b.*\?/i,
  /\?$/, // a question title is a question, not a report
]

/** Title shapes that mark evergreen explainer content in Chinese. */
const EVERGREEN_ZH = [
  /一文(搞懂|读懂|看懂|了解|掌握)/,
  /(从入门到|入门|精通|进阶|零基础)/,
  /(教程|指南|攻略|详解|全解析|全攻略|必读|收藏|珍藏)/,
  /(怎么|如何|怎样)(开启|关闭|设置|修改|使用|安装|下载|配置|连接|操作|解决)/,
  /(是什么|有哪些|有什么区别|区别|对比|哪个好)/,
  /(术语|基础|原理|概念)/,
  /(翻译|译文|全文翻译)/,
]

/**
 * Event verbs that mark a report of something that happened.
 *
 * A headline is news when it says an actor *did* something. These are the verbs
 * wire services use, in English and Chinese.
 */
const EVENT_VERBS_EN = [
  'files', 'filed', 'filing', 'launches', 'launched', 'announces', 'announced',
  'unveils', 'unveiled', 'raises', 'raised', 'acquires', 'acquired', 'buys', 'bought',
  'sells', 'sold', 'reports', 'reported', 'warns', 'warned', 'sues', 'sued',
  'appoints', 'appointed', 'resigns', 'resigned', 'steps down', 'beats', 'misses',
  'cuts', 'cut', 'ships', 'shipped', 'releases', 'released', 'confirms', 'confirmed',
  'denies', 'denied', 'faces', 'faced', 'plunges', 'plunged', 'surges', 'surged',
  'signs', 'signed', 'approves', 'approved', 'rejects', 'rejected', 'blocks', 'blocked',
  'delays', 'delayed', 'halts', 'halted', 'plans', 'planned', 'names', 'named',
  'wins', 'won', 'loses', 'lost', 'drops', 'dropped', 'hits', 'hit', 'reaches',
  'reached', 'tops', 'topped', 'slashes', 'slashed', 'settles', 'settled',
  'invests', 'invested', 'partners', 'partnered', 'expands', 'expanded',
  'closes', 'closed', 'opens', 'opened', 'tests', 'tested', 'deploys', 'deployed',
  'merges', 'merged', 'spin', 'spins', 'lists', 'listed', 'debuts', 'debuted',
  'submits', 'submitted', 'probes', 'probed', 'orders', 'ordered', 'bans', 'banned',
  'backs', 'backed', 'pledges', 'pledged', 'calls', 'called', 'urges', 'urged',
  // Launch language: a product announcement is an event.
  'introducing', 'introduces', 'introduced', 'announcing', 'unveiling', 'releasing',
  'launching', 'shipping', 'debuting', 'expanding', 'partnering', 'acquiring',
  // Scheduled and diplomatic action: "will hold exercises", "holds talks".
  // Both the third-person form and the base form, because a plural subject takes
  // the base form ("foreign ministers meet") while a singular one does not.
  'holds', 'hold', 'convenes', 'convene', 'convened', 'meets', 'meet', 'met',
  'visits', 'visit', 'visited', 'attends', 'attend', 'attended',
  'addresses', 'address', 'addressed', 'declares', 'declare', 'declared',
  'imposes', 'impose', 'imposed', 'lifts', 'lift', 'lifted',
  'withdraws', 'withdraw', 'withdrew', 'deploys', 'deploy', 'deployed',
  'mobilises', 'mobilize', 'mobilizes', 'strikes', 'strike', 'struck',
  'attacks', 'attack', 'attacked', 'agrees', 'agree', 'agreed',
  'warns', 'warn', 'warned', 'urges', 'urge', 'urged', 'calls', 'call', 'called',
]

/** Event verbs in Chinese. */
const EVENT_VERBS_ZH = [
  '发布', '推出', '宣布', '融资', '收购', '上市', '裁员', '起诉', '被判', '罚款',
  '合作', '签约', '投资', '涨价', '降价', '下架', '停运', '关停', '获批', '驳回',
  '辞职', '任命', '召回', '突破', '开源', '上线', '获批', '中标', '达成',
]

/**
 * Roundup titles: a dated digest of the day's events.
 *
 * "International News Briefs for Monday, October 26, 2026" reports what happened
 * that day; it just does so in a list rather than a verb. Treating it as
 * evergreen because no single verb appears would throw away real coverage, so a
 * dated roundup counts as reporting.
 */
const ROUNDUP_EN = /\b(briefs?|roundup|round-up|digest|recap|wrap|wrap-up|bulletin|bulletin|report|review|summary|newsletter|daily|weekly|monitor|update)\b/i
const ROUNDUP_ZH = /(简报|日报|周报|早报|晚报|快讯|汇总|综述|盘点|简报|观察)/

/** A number with a unit, which a report usually has and a definition does not. */
const AMOUNT = /(\$|€|£|¥|＄)\s?\d|\d+(\.\d+)?\s?(%|percent|billion|million|trillion|亿|万|美元|万元|亿美元)/i

/** A year that reads as news, not as a version number. */
const YEAR = /\b(19|20)\d{2}\b/

/**
 * What kind of page is this?
 * @param {object} hit - `{ url, title, snippet }`.
 * @returns {'homepage'|'reference'|'tutorial'|'listing'|'aggregator'|'qa'|'article'}
 */
export function contentKind(hit) {
  const title = String(hit?.title ?? '')
  let parsed
  try {
    parsed = new URL(String(hit?.url ?? ''))
  } catch {
    return 'article'
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const path = parsed.pathname
  const segments = path.split('/').filter((part) => part !== '')

  // A home page: no path, or a locale root such as `/zh-cn` or `/zh-Hans-CN`.
  if (segments.length === 0) return 'homepage'
  if (segments.length === 1 && /^(zh|en|ja|ko|de|fr|es|pt|ru|it)([-_][a-z0-9]+)*$/i.test(segments[0])) return 'homepage'

  // A tag or topic listing: the URL addresses a collection, and the title is
  // usually the collection's name.
  if (segments.some((part) => /^(tags?|topics?|categories?|category|labels?|archive|archives)$/i.test(part))) return 'listing'
  if (/^(tags?|topics?)\./i.test(host)) return 'listing'

  if (AGGREGATOR_HOSTS.some((known) => isUnder(host, known))) return 'aggregator'
  if (REFERENCE_HOSTS.some((known) => isUnder(host, known))) return 'reference'
  // Q&A is stricter: a personal Space on quora.com is a blog, not an answer.
  if (QA_HOSTS.some((known) => isSameSite(host, known))) return 'qa'

  // Title-shaped evergreens, wherever they are hosted. A Zhihu column post is
  // not junk because it is on Zhihu; it is junk when it is a tutorial.
  if (EVERGREEN_EN.some((pattern) => pattern.test(title))) return 'tutorial'
  if (EVERGREEN_ZH.some((pattern) => pattern.test(title))) return 'tutorial'

  return 'article'
}

/**
 * Score how much a hit reads as *news* rather than evergreen material.
 *
 * Ten points, threshold {@link NEWS_THRESHOLD}, in the shape Horizon uses for
 * its profiles: a score, the reasons behind it, and a hard gate for the page
 * kinds that can never be news.
 * @param {object} hit - `{ url, title, snippet, publishedAt, freshness }`.
 * @returns {{ score: number, kind: string, news: boolean, signals: string[], reasons: string[] }}
 */
export function newsworthinessOf(hit) {
  const title = String(hit?.title ?? '')
  const kind = contentKind(hit)
  const signals = []
  const reasons = []

  // The hard gate. A home page or a tutorial is not a news story at any score.
  if (NON_NEWS_KINDS.has(kind)) {
    reasons.push(`page kind is ${kind}`)
    return { score: 0, kind, news: false, signals, reasons }
  }

  let score = 0

  // A publication date is the strongest signal that a page is reporting.
  const freshness = hit?.freshness ?? {}
  if (freshness.sameDay === true) {
    score += 4
    signals.push('published today')
  } else if (freshness.dated === true) {
    score += 2
    signals.push('has a publication date')
  } else {
    reasons.push('no publication date')
  }

  // An event verb says something happened. It is the single strongest signal
  // after a date: "Anthropic files for IPO" is news whether or not the provider
  // supplied a publication date, and a provider that sends none must not cost us
  // real reporting.
  const lower = title.toLowerCase()
  const verb = EVENT_VERBS_EN.find((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower))
  const zhVerb = EVENT_VERBS_ZH.find((word) => title.includes(word))
  if (verb !== undefined || zhVerb !== undefined) {
    score += 4
    signals.push(`event verb: ${verb ?? zhVerb}`)
  } else {
    reasons.push('no event verb in the title')
  }

  // A dated roundup is reporting even without a verb: it is the day's events,
  // collected. Requiring a verb would discard real coverage.
  const roundup = ROUNDUP_EN.test(title) || ROUNDUP_ZH.test(title)
  if (roundup && freshness.dated === true && verb === undefined && zhVerb === undefined) {
    score += 3
    signals.push('a dated roundup')
  }

  // A figure — money, a percentage, a count — is what reporting carries and
  // reference material does not.
  if (AMOUNT.test(title)) {
    score += 2
    signals.push('carries a figure')
  }

  // A named actor plus a year reads as a report ("Poland will hold exercises").
  if (YEAR.test(title) && verb === undefined && zhVerb === undefined) {
    score += 1
    signals.push('names a year')
  }

  // A question page is a question, not a report, even off the Q&A hosts.
  if (kind === 'qa') {
    score = Math.min(score, 2)
    reasons.push('a question page, not a report')
  }

  // An undated page needs to look like an event to count at all: without a date
  // and without an event verb there is nothing that ties it to any day.
  const news = score >= NEWS_THRESHOLD
  if (!news) reasons.push(`score ${score} below ${NEWS_THRESHOLD}`)
  return { score, kind, news, signals, reasons }
}

/** The score a hit needs to be treated as news. */
export const NEWS_THRESHOLD = 4

/**
 * Judge and annotate every hit.
 *
 * The annotation travels with the hit so the page can explain a drop, and so the
 * ranking can prefer news over evergreen without re-deriving the judgement.
 * @param {object[]} hits - the screened hits.
 * @returns {{ kept: object[], dropped: object[], stats: object }} the survivors.
 */
export function screenNews(hits) {
  const list = Array.isArray(hits) ? hits : []
  const kept = []
  const dropped = []
  for (const hit of list) {
    const verdict = newsworthinessOf(hit)
    const annotated = { ...hit, newsworthiness: verdict }
    if (verdict.news) kept.push(annotated)
    else dropped.push(annotated)
  }
  return {
    kept,
    dropped,
    stats: {
      total: list.length,
      kept: kept.length,
      dropped: dropped.length,
      kinds: dropped.map((hit) => hit.newsworthiness.kind).filter((kind) => kind !== 'article'),
    },
  }
}
