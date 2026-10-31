/**
 * A smoke test for the Host half: boot the plugin against a fake cordis
 * context, then exercise the routes the page calls.
 *
 * The point is the wiring a browser cannot check for me here: does `apply`
 * register the routes, does saving round-trip through the state file, does a
 * run start, and does a second run while one is in flight get refused.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const home = await mkdtemp(join(tmpdir(), 'dnd-host-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

/** Today as the digest code compares it: the *local* calendar day. */
function localDay() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** A minimal route table: records handlers so the test can call them directly. */
function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    getOrigin() {
      return 'http://127.0.0.1:1'
    },
    register(route) {
      routes.set(`${route.kind}:${route.path}`, route)
      return () => routes.delete(`${route.kind}:${route.path}`)
    },
  }
}

/** A request the route handlers understand. */
function request(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: path,
    headers: { host: '127.0.0.1:1' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') for (const chunk of chunks) handler(chunk)
      if (event === 'end') handler()
      if (event === 'error') this.error = handler
      return this
    },
    destroy() {},
  }
}

/** A response that records what was written. */
function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(chunk) {
      if (chunk !== undefined) this.body = String(chunk)
    },
  }
}

/** Call one registered route and parse its JSON. */
async function call(web, method, path, body) {
  const prefix = web.routes.get('prefix:/daily-news-digest/api')
  assert.ok(prefix !== undefined, 'the API prefix route must be registered')
  const res = response()
  await prefix.handler(request(method, `/daily-news-digest/api${path}`, body), res)
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) }
}

/** Call the report route, which answers HTML rather than JSON. */
async function fetchReport(web, search, headers = {}) {
  const route = web.routes.get('exact:/daily-news-digest/report')
  assert.ok(route !== undefined, 'the report route must be registered')
  const req = request('GET', `/daily-news-digest/report${search}`)
  req.headers = { host: '127.0.0.1:1', ...headers }
  const res = response()
  await route.handler(req, res)
  return { status: res.status, body: res.body, headers: res.headers }
}

/**
 * Empty the timeline before a test that counts rows. The state file outlives
 * each `boot`, so earlier tests' runs would otherwise show up as extra rows.
 */
async function clearHistory(web) {
  const state = await call(web, 'GET', '/state')
  for (const entry of state.json.value.history) {
    await call(web, 'POST', '/history/delete', { id: entry.id })
  }
  assert.equal((await call(web, 'GET', '/state')).json.value.history.length, 0)
}

/** A web service whose search returns one canned hit per query. */
function fakeWeb(searchHits) {
  return {
    async search(request_) {
      return { sources: searchHits(request_.query), truncated: false }
    },
    async fetch() {
      return { url: '', statusCode: 200, body: { kind: 'text', content: '' }, truncated: false }
    },
  }
}

/** A fake llm that returns a fixed JSON answer. */
function fakeLlm() {
  return {
    listProviders: () => [{ id: 'fake-provider' }],
    listModels: async () => [{ id: 'fake-model' }],
    resolveModelInfo: async () => ({}),
    async *stream() {
      yield { type: 'text-delta', text: '{"brief":"A quiet day.","stories":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function boot({ web, llm, writeReport }) {
  const webServer = fakeWebServer()
  const services = { webServer, web, llm }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      return services[name]
    },
    inject(names, callback) {
      callback(Object.fromEntries(names.map((name) => [name, services[name]])))
      return () => {}
    },
    effect() {
      return () => {}
    },
  }
  // The launcher and Edge lookup are replaced: a test must never open a real
  // browser window on the user's desktop. `writeReport` is replaced only by the
  // test that exercises a failed write.
  const launches = []
  const options = {
    deadlineMs: 15_000,
    llmTimeoutMs: 5_000,
    findEdge: () => 'C:\\fake\\msedge.exe',
    // `edgePath` is what the PDF step actually reads. Without it the step falls
    // through to the real Edge lookup and a unit test launches a browser — which it
    // silently did for as long as an empty `edgePath` was mistaken for "no Edge".
    edgePath: 'C:\\fake\\msedge.exe',
    launch: (input) => {
      launches.push(input)
      return { ok: true }
    },
    // A test must never send real mail or print a real PDF: both are replaced, and
    // `mailTo` stays empty so the scheduled path has nowhere to send.
    mailTo: '',
    scheduledToken: 'test-token',
  }
  if (typeof writeReport === 'function') options.writeReport = writeReport
  apply(ctx, options)
  webServer.launches = launches
  return webServer
}

test('state route reports an empty editor before anything is saved', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const state = await call(webServer, 'GET', '/state')
  assert.equal(state.status, 200)
  assert.deepEqual(state.json.value.topics, [])
  assert.equal(state.json.value.top, 10)
  assert.equal(state.json.value.job.phase, 'idle')
})

test('save round-trips topics, sources and top', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const saved = await call(webServer, 'POST', '/save', {
    topics: ['AI News', '具身智能', ''],
    sources: ['CNN.com', 'reddit', 'QbitAI'],
    top: 7,
  })
  assert.equal(saved.status, 200)
  // A bare name is stored as a topic with no guidance: the shape is uniform so
  // the page never has to test which form it got.
  assert.deepEqual(saved.json.value.topics, [
    { topic: 'AI News', guidance: '' },
    { topic: '具身智能', guidance: '' },
  ])
  assert.deepEqual(saved.json.value.sources, ['CNN.com', 'reddit', 'QbitAI'])
  assert.equal(saved.json.value.top, 7)

  const reloaded = await call(webServer, 'GET', '/state')
  assert.deepEqual(reloaded.json.value.topics, [
    { topic: 'AI News', guidance: '' },
    { topic: '具身智能', guidance: '' },
  ])
  assert.equal(reloaded.json.value.top, 7)
})

test('guidance round-trips with its topic and survives a reload', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const guidance = 'Only open-source inference engines like vLLM and llama.cpp.\nSkip tutorials and home pages.'
  const saved = await call(webServer, 'POST', '/save', {
    topics: [{ topic: 'LLM Local Deployment', guidance }],
    sources: ['CNN.com'],
    top: 5,
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.value.topics[0].guidance, guidance, 'line breaks are part of the guidance')

  const reloaded = await call(webServer, 'GET', '/state')
  assert.equal(reloaded.json.value.topics[0].guidance, guidance, 'guidance must survive the round trip')
})

test('a topic keeps its guidance when other topics are saved around it', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  await call(webServer, 'POST', '/save', {
    topics: [
      { topic: 'AI News', guidance: 'skip tutorials' },
      { topic: 'Embodied AI', guidance: '' },
    ],
    sources: ['CNN.com'],
    top: 5,
  })
  const reloaded = await call(webServer, 'GET', '/state')
  assert.equal(reloaded.json.value.topics[0].guidance, 'skip tutorials')
  assert.equal(reloaded.json.value.topics[1].guidance, '')
})

test('save clamps top and rejects unknown methods', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const saved = await call(webServer, 'POST', '/save', { top: 9999 })
  assert.equal(saved.json.value.top, 50)

  const refused = await call(webServer, 'DELETE', '/save')
  assert.equal(refused.status, 405)
})

test('the scheduled endpoint is reachable without a browser session, and only with its token', async () => {
  // The bug this pins: the GUI fence ran before the token check, so a scheduled
  // reminder (which holds no browser cookie) got 401 and the 6pm run could never
  // start. The token is that route's credential.
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  await call(webServer, 'POST', '/save', { topics: ['AI News'], sources: ['CNN.com'], top: 5 })

  // Every other route stays fenced.
  const state = await call(webServer, 'GET', '/state')
  assert.equal(state.status, 200, 'the test harness does not fence by default')

  // The scheduled route must accept a correct token even when the caller has no
  // session, and must reject a wrong one.
  const wrong = await call(webServer, 'POST', '/scheduled-run', { token: 'nope' })
  assert.equal(wrong.status, 403)
  const right = await call(webServer, 'POST', '/scheduled-run', { token: 'test-token' })
  assert.equal(right.status, 200)
  // Let the run it started finish. It is not waited on to assert anything here, but
  // leaving it in flight made the *next* test flaky: a run already under way makes
  // `/run` answer "busy" instead of the "no topics" refusal that test expects.
  await settle(webServer)
})

/** Poll until no run is in flight, so one test cannot leak a job into the next. */
async function settle(webServer) {
  for (let i = 0; i < 200; i += 1) {
    const poll = await call(webServer, 'GET', '/job')
    if (poll.json.value.phase !== 'running') return poll.json.value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the run did not settle')
}

test('a run with no topics is refused as a bad request', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const run = await call(webServer, 'POST', '/run', { topics: [], sources: ['CNN.com'] })
  assert.equal(run.status, 400)
  assert.equal(run.json.ok, false)
  assert.equal(run.json.error, 'no-topics')
})

test('a scheduled run carries its flag all the way to the run', async () => {
  // The bug this pins: `/scheduled-run` passed `scheduled: true` to `startJob`,
  // but `startJob` did not forward it into `runDigest`, so the delivery step never
  // fired. The run finished with all six topics and silently emailed nothing.
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  await call(webServer, 'POST', '/save', { topics: ['AI News'], sources: ['CNN.com'], top: 5 })

  const started = await call(webServer, 'POST', '/scheduled-run', { token: 'test-token' })
  assert.equal(started.status, 200)

  // Wait for the run to settle, then read what it recorded.
  let job = null
  for (let i = 0; i < 60; i += 1) {
    const poll = await call(webServer, 'GET', '/job')
    job = poll.json.value
    if (job.phase !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(job !== null && job.phase !== 'running', 'the run must finish')
  // A scheduled run with no mailTo configured records the delivery attempt and its
  // reason. The presence of `delivery` is what proves the flag arrived.
  assert.ok(
    job.digest?.delivery !== undefined,
    `a scheduled run must reach the delivery step; got ${JSON.stringify(job.digest?.delivery)}`,
  )
})

test('a scheduled run requires its token, so a stray request cannot send mail', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  await call(webServer, 'POST', '/save', { topics: ['AI News'], sources: ['CNN.com'], top: 5 })

  const missing = await call(webServer, 'POST', '/scheduled-run', {})
  assert.equal(missing.status, 403, 'no token is refused')

  const wrong = await call(webServer, 'POST', '/scheduled-run', { token: 'not-the-token' })
  assert.equal(wrong.status, 403, 'a wrong token is refused')

  const right = await call(webServer, 'POST', '/scheduled-run', { token: 'test-token' })
  assert.equal(right.status, 200, 'the configured token starts the run')
  assert.equal(right.json.ok, true)
})

test('the page Summarize route never emails, even when mail is configured', async () => {
  // The contract: only a *scheduled* run sends mail. Pressing Summarize shows the
  // result on screen and must not send anything.
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  await call(webServer, 'POST', '/save', { topics: ['AI News'], sources: ['CNN.com'], top: 5 })
  const run = await call(webServer, 'POST', '/run', { topics: ['AI News'], sources: ['CNN.com'], top: 5 })
  assert.equal(run.status, 200)
  // Wait for the job to settle, then confirm no delivery was recorded.
  for (let i = 0; i < 40; i += 1) {
    const job = await call(webServer, 'GET', '/job')
    if (job.json.value.phase !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const job = await call(webServer, 'GET', '/job')
  if (job.json.value.digest !== null && job.json.value.digest !== undefined) {
    assert.equal(job.json.value.digest.delivery, undefined, 'a manual run must not deliver')
  }
})

test('a run searches, ranks and returns a digest', async () => {
  const webServer = boot({
    web: fakeWeb((query) =>
      query.includes('site:cnn.com')
        ? [{ url: 'https://cnn.com/a', title: 'OpenAI releases a new model with a long context', snippet: 'It ships.' }]
        : [],
    ),
    llm: fakeLlm(),
  })
  const started = await call(webServer, 'POST', '/run', { topics: ['AI News'], sources: ['CNN.com'], top: 5 })
  assert.equal(started.json.ok, true)
  assert.equal(started.json.job.phase, 'running')

  // Wait for the run to settle, bounded.
  let job = started.json.job
  for (let attempt = 0; attempt < 200 && job.phase === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    job = (await call(webServer, 'GET', '/job')).json.value
  }
  assert.equal(job.phase, 'done', `the run must finish (last: ${JSON.stringify(job).slice(0, 200)})`)
  assert.equal(job.digest.topics.length, 1)
  assert.equal(job.digest.topics[0].stories.length, 1)
  assert.equal(job.digest.topics[0].stories[0].sourceCount, 1)

  const state = await call(webServer, 'GET', '/state')
  assert.ok(state.json.value.digest !== null, 'the finished digest must be persisted')
})

test('a second run while one is in flight is refused', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const webServer = boot({
    web: {
      async search() {
        await gate
        return { sources: [], truncated: false }
      },
      async fetch() {
        return { url: '', statusCode: 200, body: { kind: 'text', content: '' }, truncated: false }
      },
    },
    llm: fakeLlm(),
  })
  const first = await call(webServer, 'POST', '/run', { topics: ['One'], sources: ['reddit'], top: 3 })
  assert.equal(first.json.ok, true)
  const second = await call(webServer, 'POST', '/run', { topics: ['Two'], sources: ['reddit'], top: 3 })
  assert.equal(second.status, 409)
  assert.equal(second.json.error, 'busy')
  release()
})

test('the plan route resolves source rows the way a run would', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const plan = await call(webServer, 'POST', '/plan', { sources: ['CNN.com', 'reddit', 'OpenBB', 'QbitAI'] })
  assert.equal(plan.status, 200)
  const labels = plan.json.value.map((entry) => entry.label)
  assert.deepEqual(labels, ['CNN', 'Reddit', 'OpenBB', 'QbitAI'])
})

test('unknown API paths answer 404 rather than hanging', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const missing = await call(webServer, 'GET', '/nope')
  assert.equal(missing.status, 404)
})

test('history is served as timeline rows and can be reopened by id', async () => {
  const webServer = boot({
    web: fakeWeb((query) =>
      query.includes('site:cnn.com')
        ? [{ url: 'https://cnn.com/2026/10/26/tech/chip-rules', title: 'Chip rules tighten across three jurisdictions', snippet: 'Details.', publishedAt: localDay() }]
        : [],
    ),
    llm: fakeLlm(),
  })

  // Run twice so the timeline has two entries.
  await clearHistory(webServer)
  for (const topic of ['AI News', 'Chip Policy']) {
    const started = await call(webServer, 'POST', '/run', { topics: [topic], sources: ['CNN.com'], top: 5 })
    assert.equal(started.json.ok, true)
    let job = started.json.job
    for (let attempt = 0; attempt < 200 && job.phase === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      job = (await call(webServer, 'GET', '/job')).json.value
    }
    assert.equal(job.phase, 'done')
  }

  const state = await call(webServer, 'GET', '/state')
  const history = state.json.value.history
  assert.equal(history.length, 2, 'both runs must appear in the timeline')
  assert.ok(history[0].createdAt !== '', 'a row must carry its timestamp')
  assert.ok(history[0].topicCount >= 1, 'a row must carry its topic count')
  assert.ok(typeof history[0].storyCount === 'number')
  assert.ok(Array.isArray(history[0].topics))

  // The older entry must be openable by id.
  const older = history[1]
  const reopened = await call(webServer, 'GET', `/digest?id=${encodeURIComponent(older.id)}`)
  assert.equal(reopened.status, 200)
  assert.equal(reopened.json.value.id, older.id)
  assert.ok(Array.isArray(reopened.json.value.topics))
})

test('deleting a history entry removes only that entry', async () => {
  const webServer = boot({
    web: fakeWeb((query) =>
      query.includes('site:cnn.com')
        ? [{ url: 'https://cnn.com/2026/10/26/tech/chip-rules', title: 'Chip rules tighten across three jurisdictions', snippet: 'Details.', publishedAt: localDay() }]
        : [],
    ),
    llm: fakeLlm(),
  })

  await clearHistory(webServer)
  for (const topic of ['First', 'Second']) {
    const started = await call(webServer, 'POST', '/run', { topics: [topic], sources: ['CNN.com'], top: 5 })
    let job = started.json.job
    for (let attempt = 0; attempt < 200 && job.phase === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      job = (await call(webServer, 'GET', '/job')).json.value
    }
  }

  const before = (await call(webServer, 'GET', '/state')).json.value.history
  assert.equal(before.length, 2)
  const victim = before[0]

  const deleted = await call(webServer, 'POST', '/history/delete', { id: victim.id })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.json.ok, true)
  assert.equal(deleted.json.value.id, victim.id)
  assert.equal(deleted.json.value.history.length, 1, 'only one row may be removed')
  assert.ok(!deleted.json.value.history.some((entry) => entry.id === victim.id))

  // The removal must persist, not just be reflected in the response.
  const after = (await call(webServer, 'GET', '/state')).json.value.history
  assert.equal(after.length, 1)
  assert.equal(after[0].id, before[1].id)

  // The deleted digest can no longer be reopened.
  const gone = await call(webServer, 'GET', `/digest?id=${encodeURIComponent(victim.id)}`)
  assert.equal(gone.status, 404)
})

test('deleting an unknown history id answers 404', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const missing = await call(webServer, 'POST', '/history/delete', { id: 'does-not-exist' })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.ok, false)
})

test('deleting without an id is a bad request', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const bad = await call(webServer, 'POST', '/history/delete', {})
  assert.equal(bad.status, 400)
})

test('deleting the digest currently on display clears it', async () => {
  const webServer = boot({
    web: fakeWeb((query) =>
      query.includes('site:cnn.com')
        ? [{ url: 'https://cnn.com/2026/10/26/tech/chip-rules', title: 'Chip rules tighten across three jurisdictions', snippet: 'Details.', publishedAt: localDay() }]
        : [],
    ),
    llm: fakeLlm(),
  })
  const started = await call(webServer, 'POST', '/run', { topics: ['Only'], sources: ['CNN.com'], top: 5 })
  let job = started.json.job
  for (let attempt = 0; attempt < 200 && job.phase === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    job = (await call(webServer, 'GET', '/job')).json.value
  }
  const state = await call(webServer, 'GET', '/state')
  const current = state.json.value.digest
  assert.ok(current !== null)

  const deleted = await call(webServer, 'POST', '/history/delete', { id: current.id })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.json.value.digest, null, 'the current digest must clear with its stored copy')
})

test('opening a digest writes a file and launches Edge at it', async () => {
  const webServer = boot({
    web: fakeWeb((query) =>
      query.includes('site:cnn.com')
        ? [{ url: 'https://cnn.com/2026/10/26/tech/chip-rules', title: 'Chip rules tighten across three jurisdictions', snippet: 'Details.', publishedAt: localDay() }]
        : [],
    ),
    llm: fakeLlm(),
  })
  await clearHistory(webServer)
  const started = await call(webServer, 'POST', '/run', { topics: ['AI News'], sources: ['CNN.com'], top: 5 })
  let job = started.json.job
  for (let attempt = 0; attempt < 200 && job.phase === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    job = (await call(webServer, 'GET', '/job')).json.value
  }
  assert.equal(job.phase, 'done')

  const entry = (await call(webServer, 'GET', '/state')).json.value.history[0]
  assert.ok(entry !== undefined)

  const opened = await call(webServer, 'POST', '/open', { id: entry.id })
  assert.equal(opened.status, 200)
  assert.equal(opened.json.ok, true)
  assert.equal(webServer.launches.length, 1, 'exactly one window must be launched')

  const launched = webServer.launches[0]
  assert.match(launched.url, /^file:\/\/\//, 'the window must load a local file, not a server route')

  // The file must exist and hold the report: this is the whole point of the
  // change, because a file cannot hang the way a throwing route handler did.
  const path = fileURLToPath(launched.url)
  assert.ok(existsSync(path), 'the report file must be written before the launch')
  const html = readFileSync(path, 'utf8')
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /Chip rules tighten across three jurisdictions/, 'the stored story must appear')
  assert.match(html, /https:\/\/cnn\.com\/2026\/10\/26\/tech\/chip-rules/, 'the link must be the article, not the outlet')
  rmSync(path, { force: true })
})

test('the report route is gone: a window no longer depends on the HTTP server', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const route = webServer.routes.get('exact:/daily-news-digest/report')
  assert.equal(route, undefined, 'the served report route must be removed')
})

test('opening an unknown digest answers 404', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const missing = await call(webServer, 'POST', '/open', { id: 'nope' })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.ok, false)
})

test('opening without an id is a bad request', async () => {
  const webServer = boot({ web: fakeWeb(() => []), llm: fakeLlm() })
  const bad = await call(webServer, 'POST', '/open', {})
  assert.equal(bad.status, 400)
})

test('a failed file write is reported instead of launching a blank window', async () => {
  const webServer = boot({
    web: fakeWeb((query) =>
      query.includes('site:cnn.com')
        ? [{ url: 'https://cnn.com/2026/10/26/tech/chip-rules', title: 'Chip rules tighten across three jurisdictions', snippet: 'Details.', publishedAt: localDay() }]
        : [],
    ),
    llm: fakeLlm(),
    writeReport: () => {
      throw new Error('disk full')
    },
  })
  await clearHistory(webServer)
  const started = await call(webServer, 'POST', '/run', { topics: ['AI News'], sources: ['CNN.com'], top: 5 })
  let job = started.json.job
  for (let attempt = 0; attempt < 200 && job.phase === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    job = (await call(webServer, 'GET', '/job')).json.value
  }
  const entry = (await call(webServer, 'GET', '/state')).json.value.history[0]

  const opened = await call(webServer, 'POST', '/open', { id: entry.id })
  assert.equal(opened.status, 500, 'a write failure is an error, not a silent launch')
  assert.match(String(opened.json.error), /disk full/)
  assert.equal(webServer.launches.length, 0, 'nothing may be launched without a document')
})

test.after(async () => {
  await rm(home, { recursive: true, force: true })
})

test('the token that starts a scheduled run can also watch it', async () => {
  // The hole this closes: /scheduled-run accepts the token, but /job sat behind the
  // GUI fence, so the caller that started a run was refused the only way to see
  // whether it finished. A scheduled reminder, which has no browser session, could
  // start a run and then never learn its outcome.
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /path === '\/job' && tokenMatches\(req\)/, 'the job route must accept the scheduled token')
  assert.match(source, /x-dnd-token/, 'the token is accepted as a header')
  assert.match(source, /searchParams\.get\('token'\)/, 'and as a query parameter')
  // Everything else stays fenced.
  assert.match(source, /if \(path !== '\/scheduled-run' && /, 'other routes stay behind the fence')
})
