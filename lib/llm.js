/**
 * Daily News Digest — the LLM route used for one digest.
 *
 * The harness's `llm` service is provider-neutral: a call names a provider and a
 * model. The digest does not want to make the user choose one, so it picks: the
 * profile's configured default model first, then the first model each provider
 * advertises. A reasoning model with its default effort can spend the whole
 * output budget thinking and emit nothing, so the cheapest advertised effort is
 * pinned explicitly.
 */

/** Reasoning effort ladder, cheapest first. */
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The lowest reasoning effort a model advertises.
 * @param {unknown} efforts - `modelInfo.reasoning.efforts`.
 * @returns {string | undefined} an effort id, or undefined when there is none.
 */
export function lowestReasoningEffort(efforts) {
  if (!Array.isArray(efforts)) return undefined
  const ids = []
  for (const entry of efforts) {
    const id = entry !== null && typeof entry === 'object' ? entry.id : entry
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  let best
  let bestRank = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const rank = EFFORTS.indexOf(id)
    if (rank < 0) continue
    if (rank < bestRank) {
      best = id
      bestRank = rank
    }
  }
  return best ?? ids[0]
}

/**
 * Pick a route worth trying.
 *
 * The configured route wins when it exists. Otherwise the first provider that
 * lists a model wins — the digest only needs one working model, and asking the
 * user to pick one for a summarizer would be a setting they never revisit.
 * @param {object} llm - the harness LLM service.
 * @param {{ provider?: string, model?: string }} [preferred] - an explicit route.
 * @returns {Promise<{ provider: string, model: string, effort?: string } | null>}
 */
export async function resolveRoute(llm, preferred = {}) {
  if (llm === undefined || llm === null) return null

  if (typeof preferred.provider === 'string' && preferred.provider !== '' && typeof preferred.model === 'string' && preferred.model !== '') {
    return { provider: preferred.provider, model: preferred.model, ...(await effortFor(llm, preferred.provider, preferred.model)) }
  }

  let providers = []
  try {
    providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  } catch {
    providers = []
  }
  for (const entry of providers) {
    const provider = String(entry?.id ?? entry?.provider ?? '')
    if (provider === '') continue
    let models = []
    try {
      models = (await llm.listModels(provider)) ?? []
    } catch {
      continue
    }
    for (const model of models.slice(0, 3)) {
      const id = String(model?.id ?? '')
      if (id === '') continue
      return { provider, model: id, ...(await effortFor(llm, provider, id)) }
    }
  }
  return null
}

/** The effort field for one route, when the model advertises a ladder. */
async function effortFor(llm, provider, model) {
  if (typeof llm.resolveModelInfo !== 'function') return {}
  try {
    const info = await Promise.resolve(llm.resolveModelInfo(provider, model)).catch(() => undefined)
    const effort = lowestReasoningEffort(info?.reasoning?.efforts)
    return effort === undefined ? {} : { effort }
  } catch {
    return {}
  }
}
