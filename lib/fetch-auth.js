/**
 * Daily News Digest — fetching a page as the signed-in user.
 *
 * The harness `web` service has no header surface: `ctx.web.fetch({ url })` sends
 * its own product User-Agent and no cookies. That is the right default for
 * anonymous reads, but it is exactly why a login-walled source (x.com, zhihu.com,
 * weibo.com) comes back as a sign-in page instead of the article.
 *
 * So a login-walled source is fetched here instead, with the cookies read from
 * the user's Edge profile. Everything else stays on the harness service: this
 * module exists for the narrow case where credentials change the answer.
 */

import { request } from 'node:https'
import { request as httpRequest } from 'node:http'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

/** A browser-like UA: some sites serve a degraded page to unknown clients. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

/** Hosts that serve a login wall to anonymous readers. */
const LOGIN_WALLED = [
  'x.com',
  'twitter.com',
  'zhihu.com',
  'weibo.com',
  'weibo.cn',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'threads.net',
  'medium.com',
  'substack.com',
  'reddit.com',
]

/**
 * Is this host likely to require a signed-in session?
 * @param {string} url - the page URL.
 * @returns {boolean} whether cookies are worth attaching.
 */
export function needsAuth(url) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return false
  }
  return LOGIN_WALLED.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
}

/** Does the response look like a login wall rather than the article? */
const LOGIN_MARKERS = [
  /log in to x/i,
  /sign in to x/i,
  /you must log in/i,
  /登录后/i,
  /请先登录/i,
  /sign in to continue/i,
  /create an account to continue/i,
]

/**
 * Does this body look like a sign-in page?
 * @param {string} html - the fetched body.
 * @returns {boolean} whether the body is a wall.
 */
export function looksLikeLoginWall(html) {
  const text = String(html ?? '')
  if (text === '') return true
  // A wall is short and says so; a long article that mentions "log in" in a
  // footer must not be mistaken for one.
  if (text.length > 120_000) return false
  return LOGIN_MARKERS.some((marker) => marker.test(text))
}

/** Decode a response body according to its `content-encoding`. */
function decodeBody(buffer, encoding) {
  const kind = String(encoding ?? '').toLowerCase()
  try {
    if (kind === 'gzip') return gunzipSync(buffer).toString('utf8')
    if (kind === 'deflate') return inflateSync(buffer).toString('utf8')
    if (kind === 'br') return brotliDecompressSync(buffer).toString('utf8')
  } catch {
    // A body that will not decode is returned as-is rather than thrown: the
    // caller may still get a usable snippet out of it.
  }
  return buffer.toString('utf8')
}

/**
 * One HTTP GET with redirects, bounded by a timeout and a size cap.
 * @param {string} url - the page URL.
 * @param {object} options - `{ cookie, timeoutMs, maxBytes, maxRedirects, signal }`.
 * @returns {Promise<{ ok: boolean, status?: number, finalUrl?: string, body?: string, reason?: string }>}
 */
export function fetchPage(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 12_000
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 3_000_000
  const maxRedirects = Number.isFinite(options.maxRedirects) ? options.maxRedirects : 4

  const go = (target, remaining) =>
    new Promise((resolve) => {
      let parsed
      try {
        parsed = new URL(target)
      } catch {
        resolve({ ok: false, reason: 'invalid URL' })
        return
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        resolve({ ok: false, reason: `unsupported protocol ${parsed.protocol}` })
        return
      }

      const headers = {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
      }
      if (typeof options.cookie === 'string' && options.cookie !== '') headers.cookie = options.cookie

      const send = parsed.protocol === 'https:' ? request : httpRequest
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const req = send(target, { method: 'GET', headers }, (res) => {
        const status = Number(res.statusCode ?? 0)
        // Follow same-host redirects; a cross-host hop drops the cookie, because
        // sending one site's credentials to another would be a leak.
        if (status >= 300 && status < 400 && typeof res.headers.location === 'string' && remaining > 0) {
          res.resume()
          let next
          try {
            next = new URL(res.headers.location, target)
          } catch {
            finish({ ok: false, reason: 'bad redirect' })
            return
          }
          const sameHost = next.hostname === parsed.hostname
          const nextOptions = sameHost ? options : { ...options, cookie: '' }
          fetchPage(next.toString(), { ...nextOptions, maxRedirects: remaining - 1 })
            .then(finish)
            .catch((error) => finish({ ok: false, reason: String(error?.message ?? error) }))
          return
        }

        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > maxBytes) {
            res.destroy()
            finish({ ok: false, reason: `response exceeded ${maxBytes} bytes` })
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        res.on('end', () => {
          const body = decodeBody(Buffer.concat(chunks), res.headers['content-encoding'])
          finish({ ok: true, status, finalUrl: target, body })
        })
        res.on('error', (error) => finish({ ok: false, reason: String(error?.message ?? error) }))
      })

      req.setTimeout(timeoutMs, () => {
        req.destroy()
        finish({ ok: false, reason: `timed out after ${timeoutMs}ms` })
      })
      req.on('error', (error) => finish({ ok: false, reason: String(error?.message ?? error) }))
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          req.destroy()
          finish({ ok: false, reason: 'aborted' })
          return
        }
        options.signal.addEventListener('abort', () => {
          req.destroy()
          finish({ ok: false, reason: 'aborted' })
        }, { once: true })
      }
      req.end()
    })

  return go(url, maxRedirects)
}

/** Strip a page down to readable text, dropping script, style and chrome. */
export function htmlToText(html, limit = 4_000) {
  const source = String(html ?? '')
  const withoutHead = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const text = withoutHead
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return text.slice(0, limit)
}

/**
 * Pull the article title out of a page, for a story that has none.
 * @param {string} html - the page body.
 * @returns {string} the title, or ''.
 */
export function pageTitle(html) {
  const text = String(html ?? '')
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(text)
  if (og !== null) return og[1].trim()
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(text)
  return title === null ? '' : title[1].replace(/\s+/g, ' ').trim()
}

/**
 * Fetch one page as the signed-in user, and report whether the credentials helped.
 * @param {string} url - the page URL.
 * @param {object} jar - a CookieJar (from `cookies.js`).
 * @param {object} [options] - `{ timeoutMs, maxBytes }`.
 * @returns {Promise<{ ok: boolean, status?: number, text?: string, title?: string, authed?: boolean, wall?: boolean, reason?: string }>}
 */
export async function fetchAuthenticated(url, jar, options = {}) {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return { ok: false, reason: 'invalid URL' }
  }
  const cookie = typeof jar?.headerFor === 'function' ? await jar.headerFor(host) : ''
  const page = await fetchPage(url, { ...options, cookie })
  if (page.ok !== true) return { ok: false, reason: page.reason ?? 'fetch failed' }
  const text = htmlToText(page.body)
  const wall = looksLikeLoginWall(page.body)
  return {
    ok: !wall,
    status: page.status,
    text,
    title: pageTitle(page.body),
    authed: cookie !== '',
    wall,
    reason: wall ? (cookie === '' ? 'a login wall was served and no cookies were available' : 'a login wall was served despite cookies') : '',
  }
}
