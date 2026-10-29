/**
 * Daily News Digest — Host half.
 *
 * Owns everything the page cannot own: the saved topic/source lists, the digest
 * run (search, attribution, engagement, ranking, summary) and the routes the
 * page calls. The Client half is only the editor and the report.
 *
 * A digest run is long — dozens of searches and a model call per topic — so it
 * is a job, not a request: the page starts one, polls it, and gets the finished
 * document. That also means a page reload does not kill a run in progress.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { StateStore, dataDir, cleanList, cleanTopics, clampTop, digestPatch, historySummary, removeFromHistory, DEFAULT_TOP } from './lib/state.js'
import { plansForSources } from './lib/sources.js'
import { runDigest, DEFAULTS } from './lib/digest.js'
import { resolveRoute } from './lib/llm.js'
import { CookieJar, COOKIE_RETRY_MS as COOKIE_RETRY_INTERVAL, describeCookies, readEdgeCookies } from './lib/cookies.js'
import { buildReport } from './lib/report.js'
import { fileUrl, findEdge, openWindow, reportFile } from './lib/launch.js'
import { pdfPath, printToPdf } from './lib/pdf.js'
import { composeMessage, sendMail } from './lib/mail.js'
import { methodRefused, readJsonBody, sendJson } from './lib/http.js'

export const name = 'dsh-daily-news-digest'

/** Without a Web server the plugin has nothing to serve. */
export const inject = ['webServer']

const ROUTE_PREFIX = '/daily-news-digest'
const API_PREFIX = `${ROUTE_PREFIX}/api`

/** Defaults for the report window; separate from the run limits on purpose. */
const REPORT_DEFAULTS = {
  reportWidth: 1100,
  reportHeight: 900,
  edgePath: '',
  // The address a *scheduled* run emails its PDF to. Empty means "no email": a
  // manual run never emails regardless, so this only affects the scheduled path.
  mailTo: '',
  // The language of the emailed report and message.
  reportLang: 'en',
}

/** A finished job stays readable this long after the page stops asking. */
const JOB_TTL_MS = 30 * 60_000

/**
 * How often to retry saving an Edge cookie snapshot.
 *
 * Edge holds its cookie database with no sharing for as long as it runs, so a
 * snapshot can only be captured in a gap when Edge is closed. The interval is
 * short because the window is short: quitting Edge and reopening it a minute later
 * would otherwise be missed, and the user would be told to do something they had
 * just done. A failed attempt costs one failed file open, not a copy.
 */
const COOKIE_RETRY_MS = COOKIE_RETRY_INTERVAL

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...REPORT_DEFAULTS, ...(config ?? {}) }
  const logger = ctx.logger
  const store = new StateStore(dataDir(), logger)

  /**
   * The user's Edge cookies, for sources that only answer a signed-in request.
   *
   * One jar per plugin instance. The snapshot is cached in memory and on disk:
   * Edge holds its cookie database with no sharing while it runs, so a live read
   * only succeeds while Edge is closed. The saved copy is what lets a user who
   * keeps Edge open still use their sign-ins, instead of being told to quit Edge
   * on every run.
   */
  const jar = new CookieJar({ cacheFile: join(dataDir(), 'edge-cookies.json') })

  /**
   * The token a scheduled run must present.
   *
   * Generated once and kept on disk so it survives a restart: the scheduled
   * reminder stores it in its own instruction text, and a token that changed on
   * every launch would make that reminder fail silently after the first restart.
   * It is not a secret worth guarding — the endpoint only starts a run of the
   * user's own saved topics — but it does stop a stray request from sending mail.
   */
  const scheduledToken = (() => {
    if (typeof options.scheduledToken === 'string' && options.scheduledToken !== '') return options.scheduledToken
    const file = join(dataDir(), 'scheduled-token.txt')
    try {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing !== '') return existing
    } catch {
      // No token yet: make one below.
    }
    const made = randomUUID()
    try {
      mkdirSync(dataDir(), { recursive: true })
      writeFileSync(file, made, 'utf8')
    } catch {
      // A token that cannot be persisted still works for this process; the
      // reminder created in this session keeps working until the next restart.
    }
    return made
  })()
  options.scheduledToken = scheduledToken

  // Read the cookies once at startup. DSH is usually launched before Edge, so this
  // is the best chance to capture a live snapshot; if Edge is already running the
  // attempt fails harmlessly and the saved copy (if any) is used instead.
  void jar.get().then((snapshot) => {
    if (snapshot?.ok === true && snapshot.saved !== true) {
      logger?.info?.(`daily-news-digest: saved ${snapshot.cookies.length} Edge cookies for later runs`)
    }
  }).catch(() => {})

  // Keep trying for a snapshot while the plugin is loaded. Edge locks its cookie
  // database the whole time it runs, so the only moment a read can succeed is a
  // gap when Edge is closed. Without a retry, a user who opens DSH and Edge
  // together would never get a snapshot at all; with one, the first time Edge is
  // closed for a moment the credentials are saved and keep working afterwards.
  // The attempt is cheap: a failed read is one failed file copy.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void jar.get(true).then((snapshot) => {
          if (snapshot?.ok === true && snapshot.saved !== true) {
            logger?.info?.(`daily-news-digest: saved ${snapshot.cookies.length} Edge cookies for later runs`)
          }
        }).catch(() => {})
      }, COOKIE_RETRY_MS)
      if (typeof timer?.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'daily-news-digest: Edge cookie snapshot retry')
  }

  /**
   * Render one digest to PDF and email it.
   *
   * Only a scheduled run calls this. Both steps are reported through `logger` and
   * recorded on the digest as `delivery`, so a failed send is visible instead of
   * looking like a digest nobody asked about.
   * @param {object} digest - the finished digest.
   * @returns {Promise<void>}
   */
  async function deliver(digest) {
    const recipient = String(options.mailTo ?? '').trim()
    const result = { at: new Date().toISOString(), to: recipient, pdf: null, mail: null }

    // The PDF is produced from the same HTML the Edge window shows, so the emailed
    // copy and the on-screen report cannot drift apart. `printToPdf` retries once
    // itself: the headless print failed once while Edge was busy and succeeded
    // seconds later, and a scheduled run gets no second chance from the user.
    const html = buildReport(digest, { lang: options.reportLang })
    const htmlFile = reportFile(digest.id, html)
    const printed = await printToPdf({ htmlPath: htmlFile, outPath: pdfPath(digest.id), edgePath: options.edgePath })
    result.pdf = printed.ok === true ? { path: printed.path, bytes: printed.bytes } : { error: printed.reason }
    if (printed.ok !== true) {
      logger?.warn?.(`daily-news-digest: scheduled PDF failed — ${printed.reason}`)
      digest.delivery = result
      return
    }
    logger?.info?.(`daily-news-digest: scheduled PDF written (${printed.bytes} bytes)`)

    if (recipient === '') {
      result.mail = { error: 'no recipient address is configured' }
      logger?.warn?.('daily-news-digest: scheduled run has no mailTo configured, so no email was sent')
      digest.delivery = result
      return
    }

    const { subject, body } = composeMessage(digest, options.reportLang)
    const sent = await sendMail({ to: recipient, subject, body, attachment: printed.path })
    result.mail = sent.ok === true ? { sent: true } : { error: sent.reason }
    if (sent.ok === true) logger?.info?.(`daily-news-digest: digest emailed to ${recipient}`)
    else logger?.warn?.(`daily-news-digest: scheduled email failed — ${sent.reason}`)
    digest.delivery = result
  }

  /** The single in-flight run, or null. One digest at a time: two runs would double every search. */
  let job = null
  /** The last finished run, so a reloaded page still shows its result (or its failure). */
  let last = null

  /** The public shape of the current job. */
  function getJob() {
    if (job !== null) {
      return { phase: job.phase, digest: null, startedAt: job.startedAt, finishedAt: 0, error: job.error, done: job.done, total: job.topics }
    }
    if (last === null) return { phase: 'idle' }
    return {
      phase: last.phase,
      digest: last.digest,
      startedAt: last.startedAt,
      finishedAt: last.finishedAt,
      error: last.error,
      done: last.done,
      total: last.total,
    }
  }

  /**
   * Start one digest run.
   * @param {object} input - `{ topics, sources, top }`.
   * @returns {object} the job envelope.
   */
  function startJob(input) {
    if (job !== null) return { ok: false, error: 'busy', job: getJob() }

    const topics = cleanTopics(input.topics)
    const sources = cleanList(input.sources)
    if (topics.length === 0) return { ok: false, error: 'no-topics' }

    const run = {
      phase: 'running',
      startedAt: Date.now(),
      error: null,
      topics: topics.length,
      done: 0,
      digest: null,
    }
    job = run
    logger?.info?.(`daily-news-digest: starting a run — ${topics.length} topics, ${sources.length} sources`)

    void (async () => {
      const web = typeof ctx.get === 'function' ? ctx.get('web') : undefined
      const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
      const route = await resolveRoute(llm).catch(() => null)
      const digest = await runDigest({
        topics,
        sources,
        top: clampTop(input.top ?? store.get().top ?? DEFAULT_TOP),
        web,
        llm: route === null ? null : llm,
        provider: route?.provider,
        model: route?.model,
        logger,
        limits: options,
        // Credentials for login-walled sources: the user's Edge cookies, read
        // once per run and shared by every authenticated fetch.
        jar,
        // Whether this run may email. It has to be forwarded: the delivery step
        // keys off it, and a flag dropped here means a scheduled run finishes and
        // silently sends nothing.
        scheduled: input.scheduled === true,
        onProgress: (done, total) => {
          run.done = done
          run.topics = total
        },
      })
      // The effort chosen for the route rides along so the report can say which
      // model wrote it, and so a later run can reuse the same route.
      digest.model = route === null ? '' : `${route.provider}/${route.model}`
      return digest
    })()
      .then(async (digest) => {
        run.digest = digest
        run.phase = 'done'
        last = { phase: 'done', digest, startedAt: run.startedAt, finishedAt: Date.now(), error: null, done: run.done, total: run.topics }
        const state = store.get()
        await store.update(digestPatch(state, digest)).catch((error) => {
          logger?.warn?.(`daily-news-digest: could not save the digest — ${String(error?.message ?? error)}`)
        })
        logger?.info?.(`daily-news-digest: run finished in ${digest.durationMs}ms`)

        // A scheduled run is the only run that emails. A run the user pressed
        // Summarize for must never send mail: they are looking at the result, and
        // a surprise email is not what the button promises.
        if (input.scheduled === true) {
          await deliver(digest).catch((error) => {
            logger?.warn?.(`daily-news-digest: scheduled delivery failed — ${String(error?.message ?? error)}`)
            digest.delivery = { at: new Date().toISOString(), pdf: null, mail: { error: String(error?.message ?? error) } }
          })
          // Save again, now that `delivery` is known. The digest is written before
          // delivery runs — it has to be, or a failed send would lose the whole
          // digest — but that meant the outcome lived only in memory and vanished
          // with the process. A scheduled run that emailed nothing then looked
          // exactly like one that had.
          const current = store.get()
          await store.update(digestPatch(current, digest)).catch((error) => {
            logger?.warn?.(`daily-news-digest: could not record the delivery outcome — ${String(error?.message ?? error)}`)
          })
        }
      })
      .catch((error) => {
        run.phase = 'failed'
        run.error = String(error?.message ?? error)
        last = { phase: 'failed', digest: null, startedAt: run.startedAt, finishedAt: Date.now(), error: run.error, done: run.done, total: run.topics }
        logger?.warn?.(`daily-news-digest: run failed — ${run.error}`)
      })
      .finally(() => {
        if (job === run) job = null
      })

    return { ok: true, job: getJob() }
  }

  /** Drop a finished run nobody has asked about for a while. */
  function sweep() {
    if (job === null && last !== null && Date.now() - last.finishedAt > JOB_TTL_MS) last = null
  }

  const register = (webServer) => {
    if (webServer === null || typeof webServer !== 'object' || typeof webServer.register !== 'function') {
      logger?.warn?.('daily-news-digest: no webServer service, the page cannot be served')
      return
    }

    const routes = []
    const route = (kind, path, handler) => {
      routes.push(webServer.register({ kind, path, handler }))
    }

    /** The same Host/Origin fence the rest of the GUI uses, plus loopback only. */
    const refused = (req, res) => {
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (typeof connection?.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
          return true
        }
      }
      return false
    }

    /**
     * Does this request carry the scheduled token?
     *
     * Accepted as an `x-dnd-token` header or a `token` query parameter, because a
     * scheduled reminder assembling a plain GET has no convenient header surface.
     * @param {object} req - the request.
     * @returns {boolean} whether it matches the configured token.
     */
    const tokenMatches = (req) => {
      const expected = String(options.scheduledToken ?? '')
      if (expected === '') return false
      let given = ''
      try {
        const url = new URL(req.url ?? '/', 'http://local')
        given = String(url.searchParams.get('token') ?? '')
      } catch {
        given = ''
      }
      if (given === '') {
        const header = req.headers?.['x-dnd-token']
        given = Array.isArray(header) ? String(header[0] ?? '') : String(header ?? '')
      }
      return given !== '' && given === expected
    }

    route('prefix', API_PREFIX, async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://local').pathname.slice(API_PREFIX.length)
      // The scheduled entry point authenticates with its own token instead of the
      // GUI's browser session. It has to: the caller is a scheduled reminder in a
      // restored Session, which holds no browser cookie, so the GUI fence would
      // reject it with 401 before the token was ever read. The token is the
      // credential for that route, and nothing else is reachable without the
      // session fence.
      //
      // `/job` is the one other route the same caller needs. A scheduled run is
      // started by the token and then has to be watched until it finishes, and
      // `/job` sat behind the fence — so the caller that started the run was refused
      // the only way to see how it went. The token is accepted on that route too,
      // and only for reading the job.
      if (path !== '/scheduled-run' && !(path === '/job' && tokenMatches(req)) && refused(req, res)) return
      try {
        await dispatch(path, req, res)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    })

    async function dispatch(path, req, res) {
      switch (path) {
        case '/cookies': {
          if (methodRefused(req, res, ['GET', 'HEAD'])) return
          // Read fresh here: the page asks once on open, so it can show whether
          // the user's sign-ins are usable before they press Summarize.
          const snapshot = await readEdgeCookies().catch((error) => ({ ok: false, reason: String(error?.message ?? error), cookies: [] }))
          sendJson(res, 200, { ok: true, value: describeCookies(snapshot) })
          return
        }
        case '/state': {
          if (methodRefused(req, res, ['GET', 'HEAD'])) return
          const state = store.get()
          sendJson(res, 200, {
            ok: true,
            value: {
              topics: state.topics,
              sources: state.sources,
              top: state.top,
              updatedAt: state.updatedAt,
              digest: state.digest,
              history: state.history.map(historySummary),
              job: getJob(),
              limits: {
                minTop: 1,
                maxTop: 50,
                deadlineMs: options.deadlineMs,
              },
            },
          })
          return
        }
        case '/save': {
          if (methodRefused(req, res, ['POST'])) return
          const body = await readJsonBody(req)
          const patch = {}
          if (body.topics !== undefined) patch.topics = cleanTopics(body.topics)
          if (body.sources !== undefined) patch.sources = cleanList(body.sources)
          if (body.top !== undefined) patch.top = clampTop(body.top)
          const state = await store.update(patch)
          sendJson(res, 200, { ok: true, value: { topics: state.topics, sources: state.sources, top: state.top, updatedAt: state.updatedAt } })
          return
        }
        case '/plan': {
          if (methodRefused(req, res, ['POST'])) return
          const body = await readJsonBody(req)
          const plans = plansForSources(cleanList(body.sources))
          sendJson(res, 200, {
            ok: true,
            value: plans.map((plan) => ({ id: plan.id, label: plan.label, kind: plan.kind, hosts: plan.hosts, query: plan.query })),
          })
          return
        }
        case '/run': {
          if (methodRefused(req, res, ['POST'])) return
          const body = await readJsonBody(req)
          const saved = store.get()
          const topics = body.topics === undefined ? saved.topics : cleanTopics(body.topics)
          const sources = body.sources === undefined ? saved.sources : cleanList(body.sources)
          const top = clampTop(body.top ?? saved.top)
          // Save what the run used, so the page and the next run agree with it.
          await store.update({ topics, sources, top })
          const started = startJob({ topics, sources, top })
          if (started.ok !== true) {
            // A busy profile is a conflict; an empty topic list is a bad request
            // the page already knows how to explain.
            sendJson(res, started.error === 'busy' ? 409 : 400, started)
            return
          }
          sendJson(res, 200, started)
          return
        }
        case '/job': {
          if (methodRefused(req, res, ['GET', 'HEAD'])) return
          sweep()
          sendJson(res, 200, { ok: true, value: getJob() })
          return
        }
        case '/scheduled-run': {
          // The entry point a scheduled reminder calls. It is deliberately separate
          // from `/run`: this one emails its result, and it must not be reachable by
          // the page's Summarize button, which promises a result on screen and no
          // mail. A token is required so a stray request cannot send email.
          if (methodRefused(req, res, ['POST'])) return
          const body = await readJsonBody(req)
          const expected = String(options.scheduledToken ?? '')
          if (expected === '') {
            sendJson(res, 403, { ok: false, error: 'scheduled runs are not configured' })
            return
          }
          if (String(body.token ?? '') !== expected) {
            sendJson(res, 403, { ok: false, error: 'bad token' })
            return
          }
          const saved = store.get()
          const started = startJob({
            topics: saved.topics,
            sources: saved.sources,
            top: saved.top,
            scheduled: true,
          })
          if (started.ok !== true) {
            sendJson(res, started.error === 'busy' ? 409 : 400, started)
            return
          }
          logger?.info?.('daily-news-digest: scheduled run started')
          sendJson(res, 200, started)
          return
        }
        case '/digest': {
          if (methodRefused(req, res, ['GET', 'HEAD'])) return
          // ?id=<digest id> reopens one stored digest; without it, the current one.
          const wanted = new URL(req.url ?? '/', 'http://local').searchParams.get('id')
          const state = store.get()
          if (wanted === null || wanted === '') {
            sendJson(res, 200, { ok: true, value: state.digest })
            return
          }
          const entry = state.history.find((candidate) => String(candidate?.id ?? '') === wanted)
          if (entry === undefined) {
            sendJson(res, 404, { ok: false, error: 'unknown digest' })
            return
          }
          sendJson(res, 200, { ok: true, value: entry })
          return
        }
        case '/history/delete': {
          if (methodRefused(req, res, ['POST'])) return
          const body = await readJsonBody(req)
          const id = String(body.id ?? '')
          if (id === '') {
            sendJson(res, 400, { ok: false, error: 'missing digest id' })
            return
          }
          const before = store.get()
          const patch = removeFromHistory(before, id)
          if (patch.removed !== true) {
            sendJson(res, 404, { ok: false, error: 'unknown digest' })
            return
          }
          const state = await store.update({ history: patch.history, digest: patch.digest })
          logger?.info?.(`daily-news-digest: removed digest ${id} from history`)
          sendJson(res, 200, {
            ok: true,
            value: {
              id,
              history: state.history.map(historySummary),
              digest: state.digest,
            },
          })
          return
        }
        case '/open': {
          if (methodRefused(req, res, ['POST'])) return
          // Open one stored digest in its own Edge window.
          //
          // The document is written to a file and opened over `file://`. It used
          // to be served from this plugin's HTTP route, which made the window
          // depend on the listener, a token, and this handler not throwing — and
          // a handler that threw left the connection open with no response,
          // which Chromium shows as "This page isn't responding". A static
          // document has no reason to involve a server at all.
          const body = await readJsonBody(req)
          const id = String(body.id ?? '')
          if (id === '') {
            sendJson(res, 400, { ok: false, error: 'missing digest id' })
            return
          }
          const entry = store.get().history.find((candidate) => String(candidate?.id ?? '') === id)
          if (entry === undefined) {
            sendJson(res, 404, { ok: false, error: 'unknown digest' })
            return
          }
          // `findEdge` and `launch` are test seams: the tests drive the routes
          // without opening a real browser on the user's desktop. Production
          // never sets either.
          const locate = typeof options.findEdge === 'function' ? options.findEdge : findEdge
          if (locate(options.edgePath) === null) {
            sendJson(res, 503, { ok: false, error: 'edge-missing' })
            return
          }
          let url
          try {
            // `writeReport` is a test seam for the failure path; production uses
            // the real writer.
            const write = typeof options.writeReport === 'function' ? options.writeReport : reportFile
            const file = write(id, buildReport(entry, { lang: req.headers['accept-language'] }))
            url = fileUrl(file)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: `could not write the report: ${String(error?.message ?? error)}` })
            return
          }
          const launch = typeof options.launch === 'function' ? options.launch : openWindow
          const launched = launch({
            url,
            edgePath: options.edgePath,
            width: options.reportWidth,
            height: options.reportHeight,
            logger,
          })
          if (launched.ok !== true) {
            sendJson(res, 500, { ok: false, error: launched.error ?? 'launch-failed' })
            return
          }
          logger?.info?.(`daily-news-digest: opened digest ${id} in an Edge window`)
          sendJson(res, 200, { ok: true, value: { id, url } })
          return
        }
        default:
          sendJson(res, 404, { ok: false, error: 'unknown route' })
      }
    }

    return () => {
      for (const off of routes.splice(0)) {
        try {
          off()
        } catch {
          /* route already gone */
        }
      }
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => register(scope.webServer ?? ctx.get('webServer')))
  } else {
    register(ctx.get('webServer'))
  }
}
