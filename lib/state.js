/**
 * Daily News Digest — saved configuration and the last generated digest.
 *
 * The page is a small editor: a list of topics, a list of sources, one number
 * (`top`), and the digest those three produce. All of it is user-authored data
 * that cannot be regenerated from anywhere else, so it is written through a
 * temp file and renamed: a crash mid-write can never leave a truncated file.
 *
 * The file lives in the plugin's own directory under `$DSH_HOME`, beside — not
 * inside — the profile, so reinstalling the profile never touches it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { MAX_GUIDANCE } from './guidance.js'

/** Bumped when the persisted shape changes in a way older files cannot satisfy. */
export const STATE_VERSION = 1

/** Rows kept per list. A longer list is not an editor any more. */
export const MAX_ROWS = 60

/** The `top` value when the user has not chosen one. */
export const DEFAULT_TOP = 10

/** Bounds for `top`; the number input clamps to the same range. */
export const MIN_TOP = 1
export const MAX_TOP = 50

/** How many generated digests are kept for the history timeline. */
export const DIGEST_HISTORY = 50

/**
 * The digest directory for the current process.
 * @param {string} [home] - an explicit `$DSH_HOME`, for tests.
 * @returns {string} an absolute directory path.
 */
export function dataDir(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(home, 'daily-news-digest')
}

/**
 * One row's text, trimmed and length-capped.
 * @param {unknown} value - whatever the client sent.
 * @returns {string} a single-line string, possibly empty.
 */
export function cleanRow(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/**
 * Normalise one topic's guidance.
 *
 * Guidance is a paragraph, not a row: it keeps its line breaks (a user may list
 * criteria one per line) and may run to {@link MAX_GUIDANCE} characters.
 * @param {unknown} value - whatever the client sent.
 * @returns {string} the cleaned guidance, possibly empty.
 */
export function cleanGuidanceRow(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_GUIDANCE)
}

/**
 * Normalise the topic list.
 *
 * A topic is a name plus optional guidance. Older state files stored bare
 * strings, so both shapes are accepted: a string becomes a topic with no
 * guidance, and an object keeps whatever guidance it carried. That keeps an
 * existing file readable instead of silently dropping the user's topics.
 * @param {unknown} rows - the list from a request body or the state file.
 * @returns {Array<{ topic: string, guidance: string }>} the cleaned list.
 */
export function cleanTopics(rows) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(rows)) return out
  for (const row of rows) {
    const isObject = row !== null && typeof row === 'object'
    const name = cleanRow(isObject ? row.topic ?? row.name : row)
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const guidance = isObject ? cleanGuidanceRow(row.guidance) : ''
    out.push({ topic: name, guidance })
    if (out.length >= MAX_ROWS) break
  }
  return out
}

/**
 * Just the topic names, for the places that only need the labels.
 * @param {Array<{ topic: string }>} topics - the normalised topic list.
 * @returns {string[]} the names.
 */
export function topicNames(topics) {
  return (Array.isArray(topics) ? topics : []).map((entry) => entry.topic).filter((name) => name !== '')
}

/**
 * The guidance for one topic name, if any.
 * @param {Array<{ topic: string, guidance: string }>} topics - the topic list.
 * @param {string} name - the topic name.
 * @returns {string} the guidance, or an empty string.
 */
export function guidanceFor(topics, name) {
  const wanted = String(name ?? '').toLowerCase()
  for (const entry of Array.isArray(topics) ? topics : []) {
    if (String(entry?.topic ?? '').toLowerCase() === wanted) return String(entry.guidance ?? '')
  }
  return ''
}

/**
 * Normalise one list: trim, drop empties, drop case-insensitive duplicates,
 * keep the user's order, cap the length.
 * @param {unknown} rows - the list from a request body.
 * @returns {string[]} the cleaned list.
 */
export function cleanList(rows) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(rows)) return out
  for (const row of rows) {
    const text = cleanRow(row)
    if (text === '') continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= MAX_ROWS) break
  }
  return out
}

/**
 * Clamp the `top` number.
 * @param {unknown} value - a number, a numeric string, or anything else.
 * @returns {number} an integer inside [MIN_TOP, MAX_TOP].
 */
export function clampTop(value) {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return DEFAULT_TOP
  return Math.min(MAX_TOP, Math.max(MIN_TOP, number))
}

/**
 * A fresh, empty configuration.
 * @returns {object} the state document.
 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    topics: [],
    sources: [],
    top: DEFAULT_TOP,
    updatedAt: 0,
    digest: null,
    history: [],
  }
}

/**
 * Coerce a parsed file into the current shape. Every field is optional on
 * disk: a hand-edited or older file must still open.
 * @param {unknown} raw - parsed JSON.
 * @returns {object} a complete state document.
 */
export function normalizeState(raw) {
  const base = emptyState()
  if (raw === null || typeof raw !== 'object') return base
  const state = {
    ...base,
    topics: cleanTopics(raw.topics),
    sources: cleanList(raw.sources),
    top: clampTop(raw.top ?? DEFAULT_TOP),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    digest: raw.digest !== null && typeof raw.digest === 'object' ? raw.digest : null,
    history: Array.isArray(raw.history) ? raw.history.filter((entry) => entry !== null && typeof entry === 'object').slice(0, DIGEST_HISTORY) : [],
  }
  return state
}

/** In-process cache: the file is read once and then kept in step with writes. */
export class StateStore {
  /**
   * @param {string} dir - the plugin's data directory.
   * @param {object} [logger] - a cordis logger.
   */
  constructor(dir, logger) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.logger = logger
    this.state = null
    this.writing = Promise.resolve()
  }

  /** Read the file once. A missing or unreadable file yields empty state. */
  load() {
    if (this.state !== null) return this.state
    if (!existsSync(this.file)) {
      this.state = emptyState()
      return this.state
    }
    try {
      this.state = normalizeState(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      // A corrupt file is not a reason to lose the page: keep the original next
      // to it and start clean, so the user can recover the text by hand.
      this.logger?.warn?.(`daily-news-digest: unreadable state file (${String(error?.message ?? error)}); starting from empty state`)
      this.state = emptyState()
    }
    return this.state
  }

  /** The current state document. */
  get() {
    return this.load()
  }

  /**
   * Replace part of the state and persist it.
   * @param {object} patch - fields to merge.
   * @returns {Promise<object>} the saved state.
   */
  async update(patch) {
    const next = { ...this.get(), ...patch, version: STATE_VERSION, updatedAt: Date.now() }
    this.state = next
    await this.save(next)
    return next
  }

  /**
   * Serialise writes: two quick edits must not interleave two renames.
   * @param {object} state - the document to write.
   */
  save(state) {
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp-${process.pid}-${Date.now().toString(36)}`
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temp, this.file)
    }
    this.writing = this.writing.then(write, write)
    return this.writing
  }
}

/**
 * Record a generated digest, keeping a history timeline.
 * @param {object} state - the state document.
 * @param {object} digest - the digest to store.
 * @returns {object} the fields to merge into the state.
 */
export function digestPatch(state, digest) {
  const history = [digest, ...(Array.isArray(state.history) ? state.history : [])].slice(0, DIGEST_HISTORY)
  return { digest, history }
}

/**
 * One entry as the timeline shows it: enough to render a row without shipping
 * every story of every past digest to the page.
 * @param {object} entry - a stored digest.
 * @returns {object} the summary row.
 */
export function historySummary(entry) {
  const topics = Array.isArray(entry?.topics) ? entry.topics : []
  const stories = topics.reduce((total, topic) => total + (Array.isArray(topic?.stories) ? topic.stories.length : 0), 0)
  return {
    id: String(entry?.id ?? ''),
    createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt : '',
    day: typeof entry?.day === 'string' ? entry.day : '',
    topics: topics.map((topic) => String(topic?.topic ?? '')).filter((name) => name !== ''),
    topicCount: topics.length,
    storyCount: stories,
    top: Number.isFinite(entry?.top) ? entry.top : null,
    model: typeof entry?.model === 'string' ? entry.model : '',
    durationMs: Number.isFinite(entry?.durationMs) ? entry.durationMs : null,
  }
}

/**
 * Remove one digest from the stored history.
 *
 * Deleting the *current* digest also clears it, so the page cannot keep showing a
 * result whose stored copy is gone. Returns the ids that were actually removed,
 * which lets the caller tell "deleted" from "was not there".
 * @param {object} state - the state document.
 * @param {string} id - the digest id to drop.
 * @returns {{ history: object[], digest: object|null, removed: boolean }} the fields to merge.
 */
export function removeFromHistory(state, id) {
  const wanted = String(id ?? '')
  const history = Array.isArray(state.history) ? state.history : []
  const kept = history.filter((entry) => String(entry?.id ?? '') !== wanted)
  const removed = kept.length !== history.length
  const current = state.digest !== null && state.digest !== undefined && String(state.digest.id ?? '') === wanted ? null : state.digest
  return { history: kept, digest: current, removed }
}
