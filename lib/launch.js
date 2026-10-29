/**
 * Open a digest report in its own Microsoft Edge window.
 *
 * The window is a plain `--app=<url>` launch of the user's own Edge, so the
 * links inside it open signed in with the profile the user already has. When
 * Edge is already running, Chromium hands the launch to that instance and opens
 * the app window there instead of starting a second browser — which is what we
 * want, and why no `--user-data-dir` is passed.
 *
 * The document is written to a file and opened over `file://` rather than served
 * over the plugin's HTTP route. A report is a static document — it has no
 * script, no stylesheet, and no data of its own to fetch — so it never needed a
 * server. Serving it meant the window's success depended on the app's listener,
 * a per-launch token, and the route handler not throwing; a request that threw
 * left the connection open with no response, which Chromium reports as
 * "This page isn't responding". A file cannot fail that way.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Where Edge installs itself on Windows, in the order worth trying. */
export function edgeCandidates() {
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]
  const out = []
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    out.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  return out
}

/**
 * Find `msedge.exe`.
 * @param {string} [configured] - an explicit path from config.
 * @returns {string|null} the path, or null when Edge is not installed.
 */
export function findEdge(configured) {
  if (typeof configured === 'string' && configured !== '' && existsSync(configured)) return configured
  for (const candidate of edgeCandidates()) if (existsSync(candidate)) return candidate
  return null
}

/**
 * Write one report to a file and return its path.
 *
 * One file per digest, overwritten on each open, so reopening a digest does not
 * accumulate copies. The name is derived from the digest id and sanitised,
 * because the id reaches the filesystem.
 * @param {string} digestId - the digest id.
 * @param {string} html - the document.
 * @returns {string} the absolute path written.
 */
export function reportFile(digestId, html) {
  const dir = join(tmpdir(), 'dsh-daily-news-digest')
  mkdirSync(dir, { recursive: true })
  // Keep only characters that are safe in a filename, then collapse runs of dots
  // so a `..` can never appear in the name even as an inert substring.
  const safe = String(digestId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 80) || 'report'
  const file = join(dir, `${safe}.html`)
  writeFileSync(file, html, 'utf8')
  return file
}

/**
 * A `file://` URL for a path, as Edge must load it.
 * @param {string} path - the file path.
 * @returns {string} the URL.
 */
export function fileUrl(path) {
  return pathToFileURL(path).href
}

/**
 * Launch one report window.
 *
 * `spawn` and `locate` are injectable so a test can exercise this without
 * opening a browser on the user's desktop.
 * @param {object} input - `{ url, edgePath, width, height, logger, locate, spawn }`.
 * @returns {{ ok: boolean, error?: string }} the launch result.
 */
export function openWindow(input) {
  const locate = typeof input.locate === 'function' ? input.locate : findEdge
  const edgePath = locate(input.edgePath)
  if (edgePath === null || edgePath === undefined) return { ok: false, error: 'edge-missing' }

  const width = Number.isFinite(input.width) && input.width > 0 ? Math.trunc(input.width) : 1100
  const height = Number.isFinite(input.height) && input.height > 0 ? Math.trunc(input.height) : 900

  const args = [
    `--app=${input.url}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${width},${height}`,
  ]

  const launch = typeof input.spawn === 'function' ? input.spawn : spawn

  try {
    const child = launch(edgePath, args, { detached: true, stdio: 'ignore' })
    // A detached spawn reports a failure such as ENOENT asynchronously; the route
    // has already answered by then, so it is logged rather than returned.
    child.once?.('error', (error) => {
      input.logger?.warn?.(`daily-news-digest: could not open the report window — ${String(error?.message ?? error)}`)
    })
    child.unref?.()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `launch-failed: ${String(error?.message ?? error)}` }
  }
}
