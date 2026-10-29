/**
 * Daily News Digest — turning a digest into a PDF.
 *
 * The digest already renders a complete, self-contained HTML page (see
 * `lib/report.js`): inline CSS, no external assets, no server. That is exactly
 * what a headless browser needs, so the PDF is produced by asking the Edge the
 * user already has to print that page — rather than adding a second renderer that
 * would drift from the HTML one.
 *
 * `--headless` plus `--print-to-pdf` is the documented Chromium path. It needs no
 * window, no display and no user interaction, and it exits on its own. The
 * flags that matter:
 *
 *   --headless            run without a window
 *   --disable-gpu         no GPU process in a headless session
 *   --no-pdf-header-footer  no date/URL banner Chromium adds by default
 *   --print-to-pdf=<path>  write the PDF there and exit
 *
 * Edge refuses to run headless against a profile that is already open in a
 * normal window, so a throwaway `--user-data-dir` is used. That also keeps the
 * print from touching the user's real profile or its lock.
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { findEdge } from './launch.js'

/** How long a headless print may take before it is killed. */
const PRINT_TIMEOUT_MS = 60_000

/**
 * Where a digest's PDF lives.
 * @param {string} digestId - the digest id.
 * @returns {string} an absolute path.
 */
export function pdfPath(digestId) {
  const dir = join(tmpdir(), 'dsh-daily-news-digest')
  mkdirSync(dir, { recursive: true })
  const safe = String(digestId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 80) || 'report'
  return join(dir, `${safe}.pdf`)
}

/**
 * Print one HTML file to PDF with headless Edge.
 * @param {object} options - `{ htmlPath, outPath, edgePath, locate, spawn, timeoutMs }`.
 * @returns {Promise<{ ok: boolean, path?: string, bytes?: number, reason?: string }>}
 *   `ok: true` with the path and size, or `ok: false` with a reason.
 */
export async function printToPdf(options = {}) {
  const retries = Number.isFinite(options.retries) ? Math.max(0, options.retries) : 1
  let result = await printOnce(options)
  // Chromium's headless print is not reliably repeatable: it failed once while Edge
  // was busy and the identical call succeeded seconds later. A scheduled run has no
  // second chance, so it takes one itself rather than losing the day's email.
  for (let attempt = 0; attempt < retries && result.ok !== true; attempt += 1) {
    result = await printOnce(options)
  }
  return result
}

/**
 * One attempt at the headless print.
 * @param {object} options - as {@link printToPdf}.
 * @returns {Promise<object>} the result of that attempt.
 */
async function printOnce(options = {}) {
  const htmlPath = String(options.htmlPath ?? '')
  if (htmlPath === '' || !existsSync(htmlPath)) {
    return { ok: false, reason: 'the report HTML was not written' }
  }
  const outPath = String(options.outPath ?? pdfPath('report'))
  mkdirSync(dirname(outPath), { recursive: true })

  const edgePath = options.edgePath ?? (typeof options.locate === 'function' ? options.locate() : findEdge())
  if (!edgePath) return { ok: false, reason: 'Microsoft Edge was not found' }

  // A throwaway profile: Edge will not start headless against a profile that a
  // normal window already holds, and the print must not disturb the user's own.
  const profileDir = join(tmpdir(), `dnd-print-${process.pid}-${Date.now().toString(36)}`)

  const args = [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-pdf-header-footer',
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${outPath}`,
    pathToFileURL(htmlPath).href,
  ]

  const spawn = typeof options.spawn === 'function' ? options.spawn : execFile
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PRINT_TIMEOUT_MS

  const result = await new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(edgePath, args, { windowsHide: true, timeout: timeoutMs }, (error) => {
        // Chromium writes the PDF and *then* exits; a non-zero code with the file
        // present is a success. Only a missing file is a failure.
        if (error && !existsSync(outPath)) {
          finish({ ok: false, reason: String(error?.message ?? error) })
          return
        }
        finish({ ok: true })
      })
    } catch (error) {
      finish({ ok: false, reason: String(error?.message ?? error) })
      return
    }
    child?.on?.('error', (error) => finish({ ok: false, reason: String(error?.message ?? error) }))
  })

  if (result.ok !== true) return result
  if (!existsSync(outPath)) return { ok: false, reason: 'Edge exited without writing a PDF' }
  const bytes = statSync(outPath).size
  if (bytes === 0) return { ok: false, reason: 'Edge wrote an empty PDF' }
  return { ok: true, path: outPath, bytes }
}
