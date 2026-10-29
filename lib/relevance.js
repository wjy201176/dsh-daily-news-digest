/**
 * Daily News Digest — topical relevance.
 *
 * The ranking contract is "how many independent sources carried a story, then
 * how widely it was read". That says nothing about whether a hit is about the
 * user's topic at all, so a search engine's noise walked straight into the
 * digest: a Cadillac XT5 forum thread appeared at rank 3 under "AI News",
 * because "AI News" is two short generic words and every returned page was
 * taken at face value.
 *
 * This module answers one question per hit: *is this page about the topic?* It
 * is deliberately lexical and deterministic — no network, no model — so the
 * filter works when no provider is reachable and its decisions can be tested
 * and explained. An optional model pass (in `lib/summary.js`) handles only the
 * grey zone this cannot settle.
 *
 * The hard part is that topic words are short and ambiguous. "AI" must match
 * "AI" but not "Cadillac"; "LLM" must match "LLM" but not "llm-master" as a
 * brand name by accident. So matching is word-boundary based for Latin script,
 * alias-expanded for the concepts users actually type, and bigram-based for
 * CJK, where a two-character run is the smallest unit with meaning.
 */

/**
 * Topic words that carry no topical constraint, because they say what *kind* of
 * page is wanted rather than what it is about.
 *
 * Without this, "AI News" would require the literal word "news" on every page
 * and "LLM Local Deployment" would require "local" — which a story about
 * shipping a model on a laptop satisfies without ever using the word.
 */
const TOPIC_STOPWORDS = new Set([
  'news', 'latest', 'today', 'headlines', 'headline', 'update', 'updates', 'breaking',
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'about',
  'report', 'reports', 'article', 'articles', 'story', 'stories', 'blog', 'post', 'posts',
])

/**
 * Concept expansions, so a page can match a topic without repeating its words.
 *
 * Two tiers, because a concept word is not equally conclusive. `strong` terms
 * name the concept outright — a page saying "machine learning" or "Nvidia" is
 * about AI news and no further evidence is needed. `weak` terms only accompany
 * the concept ("benchmark", "compute", "model"), so they count as support but
 * never as proof on their own; otherwise "a weather agency upgrades its forecast
 * model" would qualify as AI news.
 */
const ALIASES = {
  ai: {
    strong: [
      'artificial intelligence', 'machine learning', 'deep learning', 'neural network',
      'neural networks', 'llm', 'llms', 'large language model', 'large language models',
      'foundation model', 'foundation models', 'generative ai', 'genai', 'gen ai', 'chatbot',
      'openai', 'anthropic', 'deepmind', 'hugging face', 'huggingface', 'transformer',
      'transformers', 'gpt', 'claude', 'gemini', 'llama', 'mistral', 'diffusion model',
      'ai model', 'ai models', 'agi', 'copilot', 'agentic', 'inference', 'fine-tuning',
      'finetuning', 'embeddings', 'robotics', 'robot', 'robots', 'humanoid', 'humanoids',
      'semiconductor', 'semiconductors', 'chip', 'chips', 'gpu', 'gpus', 'accelerator',
      'accelerators', 'nvidia', 'tsmc', 'foundry', 'training data', 'open weights',
      'open source weights', 'machine-learning', 'long context', 'context length',
      'reasoning model', 'reasoning models', 'benchmark suite', 'model evaluation',
    ],
    weak: [
      'embedding', 'model', 'models', 'model training', 'compute', 'datacenter',
      'data center', 'parameters', 'benchmark', 'benchmarks', 'dataset', 'datasets',
      'reasoning', 'training run', 'algorithm', 'algorithms', 'tensor', 'tensors',
      'vision models', 'language models', 'speech model', 'forecast model',
    ],
  },
  llm: {
    strong: [
      'large language model', 'large language models', 'language model', 'language models',
      'gpt', 'claude', 'gemini', 'llama', 'mistral', 'qwen', 'deepseek', 'tokenizer',
      'context window', 'fine-tuning', 'finetuning', 'quantization', 'quantized',
      'gguf', 'llama.cpp', 'ollama', 'vllm', 'transformer', 'llms',
    ],
    weak: ['inference', 'prompt', 'prompts', 'tokens', 'parameters', 'model', 'models'],
  },
  embodied: {
    strong: [
      'robotics', 'robot', 'robots', 'humanoid', 'humanoids', 'manipulation',
      'embodiment', 'locomotion', 'sim2real', 'actuator', 'actuators', 'teleoperation',
      'vision-language-action', 'vla', 'dexterous', 'gripper', 'grippers',
    ],
    weak: ['embodied', 'sensor', 'sensors', 'actuation', 'motion planning'],
  },
  robotics: {
    strong: ['robot', 'robots', 'humanoid', 'humanoids', 'manipulation', 'locomotion', 'gripper'],
    weak: ['embodied', 'actuator', 'dexterous', 'sim2real'],
  },
  deployment: {
    strong: [
      'deploy', 'deploys', 'deployed', 'deploying', 'on-device', 'on device', 'local model',
      'local models', 'self-hosted', 'selfhosted', 'self hosted', 'ollama', 'llama.cpp',
      'vllm', 'quantization', 'gguf', 'runtime',
    ],
    weak: ['offline', 'edge device', 'edge devices', 'local', 'hosting'],
  },
  geopolitics: {
    strong: [
      'diplomacy', 'diplomatic', 'sanctions', 'treaty', 'treaties', 'summit', 'nato',
      'united nations', 'foreign policy', 'foreign minister', 'state department',
      'military', 'conflict', 'ceasefire', 'sovereignty', 'bilateral', 'embassy',
      'ambassador', 'alliance', 'war', 'geopolitical', 'geopolitics',
      // Armed conflict is the bulk of geopolitics coverage, and a briefing's
      // headline often says only "Morning Briefing" while its body is a war report.
      'missile', 'missiles', 'airstrike', 'airstrikes', 'drone strike', 'drone strikes',
      'artillery', 'troops', 'invasion', 'offensive', 'hostilities', 'casualties',
      'insurgent', 'insurgents', 'militia', 'militants', 'militant', 'battalion',
      'kharkiv', 'kyiv', 'gaza', 'lebanon', 'hezbollah', 'hamas', 'kremlin', 'putin',
      'zelensky', 'netanyahu', 'taliban', 'nuclear talks', 'arms control',
      'lawmaker', 'legislature', 'parliament', 'coup', 'regime', 'dissident',
      'refugee', 'refugees', 'border dispute', 'territorial dispute', 'annexation',
      'intelligence agency', 'spy', 'espionage', 'state visit', 'envoy',
      // Named actors in world affairs. A section page whose snippet is about a
      // head of state is geopolitics coverage, even when the headline is just
      // "Foreign Affairs".
      'trump', 'biden', 'putin', 'zelensky', 'xi jinping', 'macron', 'erdogan',
      'modi', 'merkel', 'netanyahu', 'khamenei', 'white house', 'kremlin',
      'congress', 'senate', 'prime minister', 'president', 'administration',
      'politico', 'diplomat', 'diplomats', 'geopolitical risk',
    ],
    weak: [
      'border', 'borders', 'ministers', 'negotiations', 'political', 'politics',
      'attack', 'strike', 'strikes', 'security', 'roundup', 'election',
      'elections', 'vote', 'votes', 'coalition', 'opposition', 'cabinet',
      // A "Morning Briefing" over world news is geopolitics coverage even when
      // the headline says nothing else, so this word earns a second look — the
      // model pass then confirms it from the body.
      'briefing', 'briefings', 'world news', 'global affairs',
    ],
  },
  economics: {
    strong: [
      'economy', 'economic', 'gdp', 'inflation', 'recession', 'tariff', 'tariffs',
      'central bank', 'interest rate', 'interest rates', 'monetary', 'imf',
      'world bank', 'deflation', 'unemployment', 'stimulus', 'fiscal',
    ],
    weak: ['trade', 'exports', 'imports', 'growth', 'markets', 'currency'],
  },
  chips: {
    strong: [
      'semiconductor', 'semiconductors', 'chip', 'chips', 'foundry', 'tsmc', 'nvidia',
      'asml', 'wafer', 'lithography', 'gpu', 'gpus', 'silicon',
    ],
    weak: ['wafer fab', 'fab', 'fabs', 'process node', 'packaging'],
  },
}

/** Alias keys are matched against a topic word; longer keys are more specific. */
const ALIAS_KEYS = Object.keys(ALIASES).sort((left, right) => right.length - left.length)

/**
 * Concept words for Chinese topics.
 *
 * A CJK topic tokenizes to bigrams, and bigrams of the *topic* never appear in
 * the story — "具身智能" is "embodied intelligence", but the article says
 * "人形机器人" (humanoid robot). Without these, every Chinese topic would screen
 * out all of its own news. Matched as plain substrings, because a CJK run has no
 * word boundaries to anchor to.
 */
const CJK_CONCEPTS = {
  embodied: ['机器人', '人形', '机械臂', '抓取', '灵巧手', '具身', '运动控制', '仿真', '执行器', '无人'],
  ai: ['人工智能', '大模型', '机器学习', '深度学习', '神经网络', '智能', '算法', '芯片', '算力', '推理', '训练'],
  llm: ['大模型', '语言模型', '推理', '微调', '量化', '上下文', '智能体', '提示词'],
  deployment: ['本地', '部署', '私有化', '离线', '端侧', '量化', '推理'],
  economics: ['经济', '通胀', '利率', '关税', '贸易', '央行', '衰退', '增长', '就业'],
  geopolitics: ['外交', '制裁', '条约', '峰会', '冲突', '停火', '军事', '联合国', '地缘'],
}

/** One CJK character, for testing a character without the stateful `g` flag. */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u

/**
 * Which CJK concept groups a topic pulls in.
 *
 * A Chinese topic has no Latin words, so the alias keys cannot be looked up by
 * word. Instead the topic's own characters are matched against the concept
 * vocabulary: a topic mentioning 具身 or 机器人 pulls in the robotics concepts,
 * which is what lets "人形机器人公司完成融资" match "具身智能".
 * @param {string[]} words - the topic's Latin words.
 * @param {string} text - the whole topic text.
 * @returns {string[]} the concept words to look for in a candidate page.
 */
function cjkConceptsFor(words, text) {
  const out = []
  const add = (list) => {
    for (const concept of list) if (!out.includes(concept)) out.push(concept)
  }
  for (const word of words) {
    for (const key of ALIAS_KEYS) {
      if (word !== key && !word.split(/[-.]/).includes(key)) continue
      add(CJK_CONCEPTS[key] ?? [])
      break
    }
  }
  // A CJK topic constrains itself: a concept word sharing a character with the
  // topic is plausibly about it. This is what a bigram match alone cannot do,
  // because the article says 人形机器人 where the topic says 具身智能.
  for (const concepts of Object.values(CJK_CONCEPTS)) {
    for (const concept of concepts) {
      for (const character of concept) {
        if (CJK_CHAR.test(character) && text.includes(character)) {
          add(concepts)
          break
        }
      }
    }
  }
  return out
}

/** CJK runs are compared as bigrams, matching the grouping tokenizer. */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu

/**
 * Split a topic into its constraint terms.
/**
 * Topic words that name a broad category rather than a specific subject.
 *
 * A topic like "AI News" IS its head words: there is nothing more specific to
 * require, so its alias expansion is the whole test. A topic like "LLM Local
 * Deployment" is different — "llm" only says the domain, and "local" and
 * "deployment" are what the reader actually asked about. Treating the head word as
 * sufficient let a Gemini model review and an AI-safety policy story into a digest
 * about running models on your own hardware.
 */
const HEAD_WORDS = new Set([
  'ai', 'ai.', 'llm', 'llms', 'mllm', 'mllms', 'gpt', 'model', 'models', 'news',
  'tech', 'technology', 'technologies', 'science', 'sciences', 'geopolitics',
  'economics', 'economy', 'global', 'world', 'international', 'market', 'markets',
  'machine', 'learning', 'artificial', 'intelligence', 'general', 'latest', 'top',
  'daily', 'weekly', 'update', 'updates', 'report', 'reports',
])

/**
 * Words that mean the same thing as a common qualifier.
 *
 * Without these, a qualifier gate is too literal to be useful: a story about
 * self-hosting a model never says "local deployment", and dropping it would trade
 * one kind of wrong for another. The lists are small and concrete on purpose —
 * this expands the vocabulary of a check, it does not soften it.
 */
const QUALIFIER_SYNONYMS = {
  local: ['local', 'locally', 'on-device', 'on device', 'offline', 'self-host', 'selfhost', 'self host', 'on-prem', 'onprem', 'on premise', 'desktop', 'laptop', 'private cloud', 'edge device'],
  deployment: ['deploy', 'deployment', 'install', 'installed', 'installer', 'installation', 'serving', 'serve', 'hosting', 'hosted', 'setup', 'set up', 'configure', 'configuration'],
  embodied: ['embodied', 'robot', 'robots', 'robotic', 'robotics', 'humanoid', 'humanoids', 'actuator', 'manipulation'],
  retrieval: ['retrieval', 'rag', 'embedding', 'embeddings', 'vector', 'vector store'],
  security: ['security', 'secure', 'attack', 'attacks', 'vulnerability', 'vulnerabilities', 'exploit', 'prompt injection', 'jailbreak'],
}

/**
 * The words in a topic that actually discriminate it.
 *
 * These are the topic's own words minus the ones that only name a category, and
 * minus stopwords. An empty result means the topic *is* a category and needs no
 * qualifier test.
 * @param {string} topic - the topic text.
 * @returns {string[]} the qualifying words.
 */
export function topicQualifiers(topic) {
  const text = String(topic ?? '').toLowerCase()
  const out = []
  for (const word of text.match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) {
    const cleaned = word.replace(/[.'-]+$/g, '')
    if (cleaned.length < 2) continue
    if (TOPIC_STOPWORDS.has(cleaned)) continue
    if (HEAD_WORDS.has(cleaned)) continue
    if (out.includes(cleaned)) continue
    out.push(cleaned)
  }
  return out
}

/**
 * The words that count as evidence for one qualifier.
 * @param {string} qualifier - a qualifying topic word.
 * @returns {string[]} the forms that satisfy it.
 */
export function qualifierForms(qualifier) {
  const word = String(qualifier ?? '').toLowerCase()
  const synonyms = QUALIFIER_SYNONYMS[word] ?? []
  return [...new Set([word, ...synonyms])]
}

/**
 *
 * @param {string} topic - the topic text, e.g. `AI News`.
 * @param {object} [options] - `{ extraTerms }`: the user's own guidance keywords.
 * @returns {{ words: string[], bigrams: string[], strong: string[], weak: string[] }}
 *   `words` are the literal topic words, `bigrams` are CJK pairs, `strong` are
 *   conclusive concept expansions and `weak` are supporting ones.
 */
export function topicTerms(topic, options = {}) {
  const text = String(topic ?? '').toLowerCase()
  const words = []
  for (const word of text.match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) {
    const cleaned = word.replace(/[.'-]+$/g, '')
    if (cleaned.length < 2) continue
    if (TOPIC_STOPWORDS.has(cleaned)) continue
    if (!words.includes(cleaned)) words.push(cleaned)
  }

  const bigrams = []
  for (const run of text.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      if (!bigrams.includes(run)) bigrams.push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      const pair = run.slice(index, index + 2)
      if (!bigrams.includes(pair)) bigrams.push(pair)
    }
  }

  const strong = []
  const weak = []
  for (const word of words) {
    for (const key of ALIAS_KEYS) {
      // A topic word matches an alias key when it *is* the key or contains it as
      // a whole-word component ("local deployment" pulls in "deployment").
      if (word === key || word.split(/[-.]/).includes(key)) {
        for (const alias of ALIASES[key].strong) if (!strong.includes(alias)) strong.push(alias)
        for (const alias of ALIASES[key].weak) if (!weak.includes(alias) && !strong.includes(alias)) weak.push(alias)
        break
      }
    }
  }

  // The user's guidance says what they mean by the topic, so its keywords are
  // literal topic words for this run: a page about vLLM *is* about "LLM Local
  // Deployment" when the user said so. They are strong, not weak, because the
  // user wrote them deliberately rather than the catalogue guessing them.
  const extra = []
  for (const term of Array.isArray(options.extraTerms) ? options.extraTerms : []) {
    const cleaned = String(term ?? '').trim()
    if (cleaned === '') continue
    const key = cleaned.toLowerCase()
    if (words.includes(key)) continue
    if (extra.includes(key)) continue
    extra.push(key)
  }

  return {
    words,
    bigrams,
    strong,
    weak,
    extra,
    // The words that make this topic more than its category. Empty means the topic
    // *is* a category, and only the alias expansion can test it.
    qualifiers: topicQualifiers(topic),
    cjk: cjkConceptsFor(words, text),
  }
}

/**
 * Does `haystack` carry evidence for one qualifier, in any of its forms?
 *
 * Matching is looser than {@link hasWord} on purpose: a qualifier is a concept, and
 * "local" has to accept "locals" and "locally". Only a short suffix is allowed, so
 * the check stays a word match rather than a substring search.
 * @param {string} haystack - the lower-cased page text.
 * @param {string} qualifier - the qualifying topic word.
 * @returns {boolean} whether any form of it appears.
 */
function hasQualifier(haystack, qualifier) {
  for (const form of qualifierForms(qualifier)) {
    const needle = form.trim()
    if (needle === '') continue
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(needle)) {
      if (haystack.includes(needle)) return true
      continue
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z0-9])${escaped}[a-z]{0,4}($|[^a-z0-9])`, 'i').test(haystack)) return true
  }
  return false
}

/** Does `haystack` contain `needle` as a whole word? */
function hasWord(haystack, needle) {
  if (needle === '') return false
  // Escape for regex, then require non-word boundaries on both sides so "ai"
  // never matches inside "cadillac" and "llm" never matches inside "llm-master"
  // being a brand name — the hyphen counts as a boundary, which is correct for
  // "llm-master" (that is a repo name, not a mention of LLMs in prose).
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i')
  return pattern.test(haystack)
}

/**
 * Score how much a hit looks like it belongs to the topic.
 *
 * @param {object} hit - `{ title, snippet, url }`.
 * @param {object} terms - the result of {@link topicTerms}.
 * @returns {{ score: number, matched: string[], missing: string[], relevant: boolean }}
 *   `score` is 0..1. `relevant` is the binary decision for the certain cases;
 *   a score in the grey zone is left for the caller (and the optional model).
 */
export function relevanceOf(hit, terms) {
  const title = String(hit?.title ?? '').toLowerCase()
  const snippet = String(hit?.snippet ?? '').toLowerCase()
  let path = ''
  let host = ''
  try {
    const parsed = new URL(String(hit?.url ?? ''))
    path = decodeURIComponent(parsed.pathname).toLowerCase().replace(/[-_/]+/g, ' ')
    // The publisher is part of the subject: a page on openai.com is about OpenAI
    // even when its headline ("Introducing GPT-6") never says so. Dots become
    // spaces so the word-boundary match sees "openai com" rather than "openai.com".
    host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/[.-]+/g, ' ')
  } catch {
    path = ''
    host = ''
  }
  const haystack = `${title} ${snippet} ${path} ${host}`

  const matched = []
  const missing = []
  let literalHits = 0
  let literalTotal = 0
  let strongHits = 0
  let weakHits = 0

  for (const word of terms.words) {
    literalTotal += 1
    // A literal topic word is worth full credit wherever it appears.
    if (hasWord(haystack, word)) {
      literalHits += 1
      matched.push(word)
    } else {
      missing.push(word)
    }
  }

  for (const alias of terms.strong) {
    if (hasWord(haystack, alias)) {
      strongHits += 1
      matched.push(alias)
    }
  }
  for (const alias of terms.weak) {
    if (hasWord(haystack, alias)) {
      weakHits += 1
      matched.push(alias)
    }
  }

  for (const bigram of terms.bigrams) {
    literalTotal += 1
    if (haystack.includes(bigram)) {
      literalHits += 1
      matched.push(bigram)
    } else {
      missing.push(bigram)
    }
  }

  // Chinese concept words: the topic's own bigrams rarely appear in the article,
  // so a matching concept word is what shows the page is about the topic.
  let cjkHits = 0
  for (const concept of terms.cjk ?? []) {
    if (haystack.includes(concept)) {
      cjkHits += 1
      matched.push(concept)
    }
  }

  // The user's guidance keywords. They count as literal topic words, because the
  // user defined the topic that way for this run.
  const extraHits = []
  for (const term of terms.extra ?? []) {
    if (hasWord(haystack, term) || haystack.includes(term)) {
      extraHits.push(term)
      matched.push(term)
    }
  }

  // An empty topic (every word a stopword) cannot constrain anything; the caller
  // keeps such hits rather than dropping the whole digest.
  if (literalTotal === 0 && terms.bigrams.length === 0) {
    const any = strongHits > 0 || weakHits > 0 || extraHits.length > 0
    return { score: any ? 1 : 0.5, matched, missing, relevant: true, evidence: { literalHits, literalTotal, strongHits, weakHits, cjkHits: 0, literalRatio: 0, extraHits: extraHits.length } }
  }

  const literalRatio = literalTotal === 0 ? 0 : literalHits / literalTotal
  // Strong concepts carry a hit on their own; weak ones only add support. A
  // Chinese concept word is as conclusive as a strong English alias, and so is a
  // keyword the user wrote themselves.
  const score = Math.min(
    1,
    0.5 * literalRatio + 0.35 * Math.min(1, strongHits + Math.min(1, cjkHits) + Math.min(1, extraHits.length)) + 0.15 * Math.min(2, weakHits),
  )

  // The decision, stated once so every caller agrees on it.
  //
  // `relevant` means *certainly* about the topic, and it needs strong evidence:
  //   - every literal topic word is present, or
  //   - a strong concept word (or a Chinese concept word) is present, or
  //   - most literal words plus at least one supporting word.
  //
  // A weak word on its own is never certain: "a weather agency upgrades its
  // forecast model" mentions a model and is not AI news, and "model licensing
  // terms" mentions one and is. Lexically those are identical, so neither is
  // called relevant — both fall into the grey zone, where the optional model
  // pass can tell them apart with the context a word list cannot have.
  // The qualifier gate. "LLM Local Deployment" is not satisfied by anything that
  // mentions a language model: the reader asked about local deployment, so a story
  // must show *that* — the topic's qualifying words, or a subject they named in
  // their guidance. Without this, the head word alone ("llm") let a Gemini model
  // review and an AI-safety policy story into a digest about running models on your
  // own hardware.
  //
  // Only topics that have qualifiers are gated. "AI News" has none, so it keeps the
  // behaviour it had.
  const qualifiers = Array.isArray(terms.qualifiers) ? terms.qualifiers : []
  let qualifierHit = null
  if (qualifiers.length > 0) {
    qualifierHit = qualifiers.find((qualifier) => hasQualifier(haystack, qualifier))
    // A subject the reader named counts as the qualifier being satisfied: their
    // guidance says what the topic means for this run.
    if (qualifierHit === undefined && extraHits.length > 0) qualifierHit = `guidance:${extraHits[0]}`
  }

  let relevant = false
  if (literalTotal > 0 && literalHits === literalTotal) relevant = true
  else if (strongHits >= 1 || cjkHits >= 1) relevant = true
  else if (extraHits.length >= 1) relevant = true
  else if (literalRatio >= 0.5 && weakHits >= 1) relevant = true

  // A topic with qualifiers that the hit does not address is not relevant, however
  // strong its domain vocabulary.
  if (qualifiers.length > 0 && qualifierHit === undefined) relevant = false

  // The evidence counts travel with the verdict: the *reason* a hit was kept or
  // dropped is what makes the decision auditable, and what lets the screen treat
  // "one generic word" differently from "two specific ones".
  return {
    score,
    matched,
    missing,
    relevant,
    evidence: {
      literalHits,
      literalTotal,
      strongHits,
      weakHits,
      cjkHits,
      literalRatio,
      extraHits: extraHits.length,
      qualifiers: qualifiers.length,
      qualifierHit: qualifierHit ?? null,
    },
  }
}

/**
 * The score floor below which a hit with no evidence structure is dropped.
 *
 * Kept as a named constant because it is the fallback path for a verdict built
 * without `evidence`; the evidence-based rule above it is the one that normally
 * decides.
 */
export const GREY_LOW = 0.34

/**
 * Words that name a different, well-populated subject.
 *
 * A single generic word is not evidence of the topic, and some words are
 * actively misleading: "model" is AI vocabulary, but it is also what a car
 * reviewer calls a car. The reported bug was a Cadillac XT5 thread whose body
 * text said "the model's common problems" — one weak word, in a page about cars.
 * When a hit carries an off-topic domain word and nothing strong for the topic,
 * it is dropped rather than sent to the grey zone.
 */
const OFF_TOPIC_DOMAINS = [
  'cadillac', 'xt5', 'car key', 'vehicle', 'sedan', 'suv', 'dealership', 'mileage',
  'engine', 'horsepower', 'test drive', 'recall notice', '论坛', '凯迪拉克', '汽车之家',
  '火锅', '菜谱', '烹饪', '美食', '百度经验', '百度知道', '百度百科',
  'file explorer', 'windows support', 'microsoft support', 'how to get help',
]

/**
 * Does the hit look like it is about a different subject entirely?
 * @param {string} haystack - the lower-cased searchable text.
 * @returns {boolean} whether an off-topic domain word is present.
 */
function looksOffTopic(haystack) {
  return OFF_TOPIC_DOMAINS.some((word) => haystack.includes(word))
}

/**
 * Should a hit be kept for the topic?
 *
 * Three-way on purpose. A certain match is kept, a certain miss is dropped, and
 * the middle is kept but marked — the digest may still show it, and a model pass
 * can veto it with context this scorer does not have.
 *
 * The decision reads the *evidence*, not just the score, because a generic word
 * produces a non-zero score whether or not the page is about the topic: "model"
 * appears in both "model licensing terms" (AI policy) and "forecast model"
 * (weather). A hit with only weak evidence is grey — kept, but flagged, so the
 * model pass gets a chance to veto it and the page can mark it as unconfirmed.
 * @param {{ score: number, relevant: boolean, evidence?: object }} verdict - from {@link relevanceOf}.
 * @param {string} [haystack] - the hit's lower-cased text, for the off-topic check.
 * @returns {'keep'|'grey'|'drop'} the decision.
 */
export function screenVerdict(verdict, haystack = '') {
  if (verdict.relevant) return 'keep'
  const evidence = verdict.evidence
  if (evidence === undefined || evidence === null) {
    return verdict.score >= GREY_LOW ? 'grey' : 'drop'
  }
  // A topic that has qualifying words has already answered the question: if the hit
  // does not address them, it is about the category, not the topic. This is a
  // certain miss, not a grey one — a Gemini model review is not "maybe about local
  // deployment", it is simply not about it.
  if (Number(evidence.qualifiers) > 0 && evidence.qualifierHit === null) return 'drop'
  // A second look is warranted when the hit carries *something* beyond a single
  // generic word. One literal word out of a two-word topic is how a dictionary
  // entry about "global" scores for "Global Economics" — real evidence of the
  // topic needs more than that.
  const conclusive =
    evidence.strongHits > 0 ||
    evidence.weakHits > 0 ||
    evidence.cjkHits > 0 ||
    evidence.literalHits >= 2 ||
    (evidence.literalTotal === 1 && evidence.literalHits === 1) ||
    // A hit that addresses the topic's qualifier is real evidence, even when its
    // headline is terse: "Locals runs coding agents on a Mac" says where it runs
    // without naming a single word the topic uses for a model.
    (Number(evidence.qualifiers) > 0 && evidence.qualifierHit !== null)
  if (!conclusive) return 'drop'
  // Nothing strong, and the page is plainly about something else: a car thread
  // that happens to say "model" is not ambiguous, it is off-topic.
  if (evidence.strongHits === 0 && evidence.cjkHits === 0 && looksOffTopic(haystack)) {
    verdict.offTopic = true
    return 'drop'
  }
  return 'grey'
}

/** The lower-cased text of a hit, for the off-topic check. */
function haystackOf(hit) {
  return `${String(hit?.title ?? '')} ${String(hit?.snippet ?? '')} ${String(hit?.url ?? '')}`.toLowerCase()
}

/**
 * Screen every hit for one topic.
 *
 * The filter never empties a digest *that has any evidence*, because a provider
 * whose titles are terse must not render as "no news". But it does not rescue
 * hits with no evidence at all: a zero score means no topic word and no concept
 * word appears anywhere, which is not a terse headline, it is an unrelated page.
 * Rescuing those would put the original bug straight back. So an all-zero screen
 * returns nothing, and the caller reports "no relevant news" — an honest answer.
 * @param {string} topic - the topic text.
 * @param {object[]} hits - the collected hits.
 * @returns {{ kept: object[], dropped: object[], stats: object }} the screened hits.
 */
export function screenTopic(topic, hits, options = {}) {
  const terms = topicTerms(topic, options)
  const list = Array.isArray(hits) ? hits : []
  const kept = []
  const dropped = []
  for (const hit of list) {
    const verdict = relevanceOf(hit, terms)
    const decision = screenVerdict(verdict, haystackOf(hit))
    const annotated = { ...hit, relevance: { ...verdict, decision } }
    if (decision === 'drop') dropped.push(annotated)
    else kept.push(annotated)
  }

  // Fail safe, but only for hits the screen did not positively reject. A hit
  // that was dropped as off-topic — a car forum thread, a Windows help page — is
  // not a terse headline, and rescuing it would put the original bug straight
  // back. So the rescue only considers hits dropped for *lack* of evidence, and
  // only when that evidence is real.
  //
  // A hit that failed the qualifier gate is excluded too: it is about the topic's
  // category, not the topic, and the whole point of the gate is that this is not a
  // borderline case.
  if (kept.length === 0 && dropped.length > 0) {
    const evidence = dropped.filter((hit) => {
      if (hit.relevance.offTopic === true) return false
      const counts = hit.relevance.evidence
      if (counts === undefined) return hit.relevance.score > 0
      if (Number(counts.qualifiers) > 0 && counts.qualifierHit === null) return false
      return counts.strongHits > 0 || counts.weakHits > 0 || counts.cjkHits > 0 || counts.extraHits > 0 || counts.literalRatio >= 1
    })
    if (evidence.length > 0) {
      const rescued = [...evidence]
        .sort((left, right) => right.relevance.score - left.relevance.score)
        .slice(0, 5)
        .map((hit) => ({ ...hit, relevance: { ...hit.relevance, decision: 'grey' } }))
      // Remove by URL, not by object identity: the rescued entries are copies, so
      // an identity check would leave the originals in `dropped` as well and the
      // same hit would be reported as both kept and dropped.
      const rescuedUrls = new Set(rescued.map((hit) => hit.url))
      return {
        kept: rescued,
        dropped: dropped.filter((hit) => !rescuedUrls.has(hit.url)),
        stats: { total: list.length, kept: rescued.length, dropped: dropped.length - rescued.length, rescued: true, terms },
      }
    }
  }

  return {
    kept,
    dropped,
    stats: { total: list.length, kept: kept.length, dropped: dropped.length, rescued: false, terms },
  }
}
