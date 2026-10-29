import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runDigest } from '../lib/digest.js'

/** A web service stub whose search returns canned sources for the first matching key. */
function fakeWeb(table) {
  return {
    async search(request) {
      for (const [needle, sources] of Object.entries(table)) {
        if (request.query.includes(needle)) return { sources, truncated: false }
      }
      return { sources: [], truncated: false }
    },
    async fetch() {
      return { url: '', statusCode: 200, body: { kind: 'text', content: '' }, truncated: false }
    },
  }
}

/**
 * A cookie jar stand-in that records what was asked for and serves one cookie.
 * `snapshot` controls whether the jar reports usable credentials.
 */
function fakeJar(snapshot) {
  return {
    asked: [],
    async get() {
      return snapshot
    },
    async headerFor(host) {
      this.asked.push(host)
      if (snapshot.ok !== true) return ''
      return 'auth_token=secret'
    },
  }
}

/** An llm stub returning a fixed JSON answer and recording its prompt. */
function fakeLlm(answer) {
  const prompts = []
  return {
    prompts,
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    resolveModelInfo: async () => ({}),
    async *stream(request) {
      prompts.push(request.messages?.[0]?.content?.[0]?.text ?? '')
      yield { type: 'text-delta', text: JSON.stringify(answer) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('a locked Edge is reported on the digest, not silently ignored', async () => {
  const web = fakeWeb({
    'site:x.com': [{ url: 'https://x.com/user/status/1', title: 'Our new AI model ships to everyone today', snippet: '' }],
  })
  const jar = fakeJar({ ok: false, locked: true, cookies: [] })

  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['x.com'],
    top: 3,
    web,
    llm: null,
    jar,
    limits: { deadlineMs: 15_000 },
  })

  assert.ok(typeof digest.notes?.cookies === 'string' && digest.notes.cookies.length > 0, 'the run must explain the locked cookie database')
  assert.match(digest.notes.cookies, /Edge is running/)
})

test('the digest asks the jar for a cookie header for a login-walled host', async () => {
  const web = fakeWeb({
    'site:x.com': [
      { url: 'https://x.com/someone/status/1', title: 'Introducing a new AI model from the team today', snippet: '' },
    ],
  })
  const jar = fakeJar({ ok: true, cookies: [{ host: '.x.com', name: 'auth_token', value: 'secret' }], profile: 'Default' })

  await runDigest({
    topics: ['AI News'],
    sources: ['x.com'],
    top: 3,
    web,
    llm: null,
    jar,
    limits: { deadlineMs: 15_000, authBudget: 4 },
  })

  assert.ok(jar.asked.some((host) => host === 'x.com'), 'the authenticated path must request cookies for x.com')
})

test('a non-walled source never touches the cookie jar', async () => {
  const web = fakeWeb({
    'site:cnn.com': [
      { url: 'https://cnn.com/2026/10/26/tech/story', title: 'Chip rules tighten across three jurisdictions', snippet: '' },
    ],
  })
  const jar = fakeJar({ ok: true, cookies: [{ host: '.cnn.com', name: 'x', value: 'y' }], profile: 'Default' })

  await runDigest({
    topics: ['AI News'],
    sources: ['CNN.com'],
    top: 3,
    web,
    llm: null,
    jar,
    limits: { deadlineMs: 15_000 },
  })

  assert.deepEqual(jar.asked, [], 'an ordinary outlet must not trigger an authenticated fetch')
})

test('a run without a jar still works', async () => {
  const web = fakeWeb({
    'site:x.com': [{ url: 'https://x.com/a/status/2', title: 'Some post about chips and policy', snippet: '' }],
  })
  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['x.com'],
    top: 3,
    web,
    llm: null,
    limits: { deadlineMs: 15_000 },
  })
  assert.equal(digest.topics.length, 1)
  assert.equal(digest.notes?.cookies, undefined, 'no jar means no cookie note')
})

test('the prompt can carry an authenticated story', async () => {
  // The local calendar day: the digest compares local days, so a UTC date would
  // name tomorrow for part of every evening.
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const web = fakeWeb({
    'site:x.com': [
      { url: 'https://x.com/lab/status/3', title: 'A verified post announcing a new AI model release today', snippet: 'We shipped it.', publishedAt: today },
    ],
  })
  const llm = fakeLlm({ brief: 'Something shipped.', stories: [{ id: 1, line: 'It shipped.' }] })
  const digest = await runDigest({
    topics: ['AI News'],
    sources: ['x.com'],
    top: 3,
    web,
    llm,
    provider: 'p',
    model: 'm',
    jar: fakeJar({ ok: true, cookies: [], profile: 'Default' }),
    limits: { deadlineMs: 15_000, llmTimeoutMs: 5_000 },
  })

  assert.equal(digest.topics[0].stories.length, 1)
  assert.equal(digest.topics[0].summarized, true)
})

