/**
 * Daily News Digest — reading the user's Microsoft Edge cookies.
 *
 * Some sources are only readable when signed in: `x.com` returns a login wall to
 * an anonymous request, and the same is true of Zhihu, Weibo and LinkedIn at
 * various times. The user is already signed in inside Edge, so the credentials
 * that exist on this machine are Edge's cookies.
 *
 * Chromium stores them in a SQLite database whose values are AES-256-GCM
 * ciphertext, keyed by a master key that Windows DPAPI protects in `Local State`.
 * Reading that is a two-step unwrap: DPAPI unlocks the key, the key decrypts the
 * cookie.
 *
 * The hard part is not cryptography, it is contention. While Edge is running it
 * holds the cookie database with no sharing at all: a byte copy fails, a
 * read-only SQLite open fails, and a share-mode open fails. So this module treats
 * "locked" as an expected, reported state rather than an error, retries nothing
 * in a tight loop, and lets the digest continue with an anonymous fetch and a
 * clear note about why a source came back thin.
 */

import { execFile } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Chromium profile directories that may hold a cookie database. */
const PROFILE_NAMES = ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4']

/** How long a cookie snapshot is reused before the database is re-read. */
export const COOKIE_TTL_MS = 10 * 60_000

/**
 * Candidate Edge user-data roots, most specific first.
 * @returns {string[]} existing directories.
 */
export function edgeRoots() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'User Data'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'User Data'),
    join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'User Data'),
  ]
  return candidates.filter((candidate) => candidate !== '' && existsSync(candidate))
}

/**
 * Every Edge profile that has a cookie database.
 * @param {string} root - a user-data root.
 * @returns {Array<{ name: string, dir: string }>} the profiles.
 */
export function listProfiles(root) {
  const found = []
  for (const name of PROFILE_NAMES) {
    const dir = join(root, name)
    if (existsSync(join(dir, 'Network', 'Cookies'))) found.push({ name, dir })
  }
  return found
}

/**
 * Unwrap the DPAPI-protected AES key from `Local State`.
 *
 * DPAPI has no Node binding, so this shells out to PowerShell for the one call.
 * That is the only external process in the plugin, and it reads a base64 blob on
 * stdin and writes a base64 blob on stdout — no script interpolation of secrets.
 * @param {string} localStatePath - the staged `Local State` file.
 * @returns {Promise<Buffer>} the 32-byte AES key.
 */
export async function masterKey(localStatePath) {
  const state = JSON.parse(await readFile(localStatePath, 'utf8'))
  const encoded = state?.os_crypt?.encrypted_key
  if (typeof encoded !== 'string' || encoded === '') {
    throw new Error('Edge Local State carries no os_crypt.encrypted_key')
  }
  const wrapped = Buffer.from(encoded, 'base64')
  if (wrapped.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new Error('unsupported Edge key wrapping (expected DPAPI)')
  }
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$in=[Console]::In.ReadToEnd()',
    '$b=[Convert]::FromBase64String($in)',
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,"CurrentUser")',
    '[Console]::Out.Write([Convert]::ToBase64String($p))',
  ].join('\n')

  const plain = await new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 1024 * 1024, windowsHide: true, timeout: 15_000 },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`DPAPI unlock failed: ${error.message}`))
          return
        }
        resolve(Buffer.from(stdout.trim(), 'base64'))
      },
    )
    child.stdin?.end(wrapped.subarray(5).toString('base64'))
  })
  if (plain.length !== 32) throw new Error(`DPAPI returned ${plain.length} bytes, expected 32`)
  return plain
}

/**
 * Decrypt one Chromium cookie value.
 * @param {Buffer} buffer - the stored `encrypted_value`.
 * @param {Buffer} key - the master key.
 * @returns {string} the plaintext, or '' when it cannot be read.
 */
export function decryptValue(buffer, key) {
  if (buffer.length < 15 + 16) return ''
  const prefix = buffer.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') return ''
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(3, 15))
    decipher.setAuthTag(buffer.subarray(buffer.length - 16))
    return Buffer.concat([decipher.update(buffer.subarray(15, buffer.length - 16)), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Does a cookie host apply to a request host?
 *
 * Chromium stores a domain cookie as `.example.com`; the leading dot means "this
 * domain and its subdomains", which is exactly how it must be matched here.
 * @param {string} cookieHost - the stored `host_key`.
 * @param {string} requestHost - the host being fetched.
 * @returns {boolean} whether the cookie should be sent.
 */
export function hostMatches(cookieHost, requestHost) {
  const cookie = String(cookieHost ?? '').toLowerCase()
  const host = String(requestHost ?? '').toLowerCase()
  if (cookie === '' || host === '') return false
  if (cookie.startsWith('.')) {
    const bare = cookie.slice(1)
    return host === bare || host.endsWith(`.${bare}`)
  }
  return host === cookie
}

/**
 * Read the cookie database and return decrypted cookies.
 *
 * The database is opened through a staged copy, because Chromium keeps the live
 * file under an exclusive lock. A failed copy is reported as `locked` — the
 * expected state while Edge runs — rather than thrown, so callers can explain it.
 * @param {object} [options] - `{ hosts }` to filter, `{ root }` to pin a root.
 * @returns {Promise<{ ok: boolean, locked?: boolean, reason?: string, cookies: Array<object>, profile?: string, root?: string }>}
 */
export async function readEdgeCookies(options = {}) {
  const roots = options.root !== undefined ? [options.root] : edgeRoots()
  if (roots.length === 0) return { ok: false, reason: 'Edge is not installed', cookies: [] }

  const root = roots[0]
  const profiles = listProfiles(root)
  if (profiles.length === 0) return { ok: false, reason: 'no Edge profile with cookies', cookies: [], root }

  const profile = profiles[0]
  let staging = null
  try {
    staging = await mkdtemp(join(tmpdir(), 'dnd-cookies-'))
    await mkdir(join(staging, 'Network'), { recursive: true })
    try {
      await copyFile(join(root, 'Local State'), join(staging, 'Local State'))
      await copyFile(join(profile.dir, 'Network', 'Cookies'), join(staging, 'Network', 'Cookies'))
    } catch (error) {
      // The live database is exclusively locked while Edge runs.
      const code = String(error?.code ?? '')
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return { ok: false, locked: true, reason: 'Edge is running and holds its cookie database open', cookies: [], root, profile: profile.name }
      }
      return { ok: false, reason: `could not read the Edge cookie database (${code || error?.message})`, cookies: [], root, profile: profile.name }
    }

    // Every failure past the copy is a *reason*, not an exception: a corrupt
    // database or an unexpected key wrapping must not take the digest down.
    let key
    try {
      key = await masterKey(join(staging, 'Local State'))
    } catch (error) {
      return { ok: false, reason: `could not unlock the Edge cookie key: ${String(error?.message ?? error)}`, cookies: [], root, profile: profile.name }
    }
    const { DatabaseSync } = await import('node:sqlite')
    let db
    try {
      db = new DatabaseSync(join(staging, 'Network', 'Cookies'), { readOnly: true })
    } catch (error) {
      return { ok: false, reason: `could not open the Edge cookie database: ${String(error?.message ?? error)}`, cookies: [], root, profile: profile.name }
    }
    let rows
    try {
      rows = db
        .prepare(
          `select host_key, name, value, encrypted_value, path,
                  cast(is_secure as integer) as is_secure,
                  cast(is_httponly as integer) as is_httponly,
                  cast(expires_utc as text) as expires_utc
             from cookies`,
        )
        .all()
    } catch (error) {
      // Not a cookie database, or an unexpected schema: report, do not throw.
      return { ok: false, reason: `the Edge cookie database could not be read: ${String(error?.message ?? error)}`, cookies: [], root, profile: profile.name }
    } finally {
      db.close()
    }

    const wanted = Array.isArray(options.hosts) ? options.hosts : null
    const cookies = []
    for (const row of rows) {
      const host = String(row.host_key ?? '')
      if (wanted !== null && !wanted.some((candidate) => hostMatches(host, candidate))) continue
      let value = typeof row.value === 'string' ? row.value : ''
      if (value === '' && row.encrypted_value !== null && row.encrypted_value !== undefined) {
        value = decryptValue(Buffer.from(row.encrypted_value), key)
      }
      if (value === '') continue
      // Chromium stores expiry as microseconds since 1601. The value exceeds
      // Number.MAX_SAFE_INTEGER, so it is read as text and scaled carefully.
      const micros = Number(String(row.expires_utc ?? '0'))
      const expires = Number.isFinite(micros) && micros > 0 ? micros / 1_000_000 - 11_644_473_600 : 0
      cookies.push({
        host,
        name: String(row.name ?? ''),
        value,
        path: String(row.path ?? '/'),
        secure: Number(row.is_secure) === 1,
        httpOnly: Number(row.is_httponly) === 1,
        expires,
      })
    }
    return { ok: true, cookies, profile: profile.name, root }
  } finally {
    if (staging !== null) await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * A cached cookie reader.
 *
 * A digest run reads the same cookie jar for every topic; re-decrypting the
 * database each time would be wasteful and would race Edge. The cache also keeps
 * a *locked* result, so a run does not retry a blocked read for every query.
 *
 * The cache is persisted to disk as well as held in memory. That is what makes
 * the locked state survivable: Edge holds the database with no sharing at all
 * while it runs, so a read is only possible while Edge is closed. Without a
 * saved copy, a user who keeps Edge open — which is most users, most of the time —
 * could never use their sign-ins at all, and every run would show "quit Edge".
 * With it, one successful read (at startup, or the first run after Edge was
 * closed) keeps working for as long as the cookies remain valid.
 */
export class CookieJar {
  /** @param {object} [options] - `{ ttlMs, cacheFile }`. */
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : COOKIE_TTL_MS
    this.cacheFile = typeof options.cacheFile === 'string' ? options.cacheFile : null
    this.cached = null
    this.readAt = 0
    this.reading = null
  }

  /**
   * The saved snapshot from disk, if one was written and is still valid.
   *
   * Validity is judged by the earliest cookie expiry: a snapshot whose cookies
   * have all expired is worse than no snapshot, because it would send dead
   * credentials and produce a login wall that looks like a broken account.
   * @returns {Promise<object|null>} the snapshot, or null.
   */
  async loadSaved() {
    if (this.cacheFile === null) return null
    let text
    try {
      text = await readFile(this.cacheFile, 'utf8')
    } catch {
      return null
    }
    let saved
    try {
      saved = JSON.parse(text)
    } catch {
      return null
    }
    if (saved === null || typeof saved !== 'object') return null
    if (saved.ok !== true || !Array.isArray(saved.cookies) || saved.cookies.length === 0) return null
    const nowSeconds = Math.floor(Date.now() / 1000)
    // `expires` is 0 for a session cookie, which is valid until the browser
    // closes; those are kept. A snapshot is stale only when every dated cookie
    // in it has passed.
    const dated = saved.cookies.filter((cookie) => Number(cookie?.expires) > 0)
    if (dated.length > 0 && dated.every((cookie) => Number(cookie.expires) <= nowSeconds)) return null
    return { ...saved, saved: true }
  }

  /** Write a successful snapshot to disk, best effort. */
  async saveSnapshot(snapshot) {
    if (this.cacheFile === null) return
    if (snapshot?.ok !== true || !Array.isArray(snapshot.cookies) || snapshot.cookies.length === 0) return
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true })
      await writeFile(this.cacheFile, JSON.stringify({ ...snapshot, savedAt: Date.now() }), 'utf8')
    } catch {
      // A cache that cannot be written is not an error: the run still works with
      // the in-memory snapshot.
    }
  }

  /**
   * The current cookie snapshot, reading it when stale.
   * @param {boolean} [force] - ignore the cache.
   * @returns {Promise<object>} the `readEdgeCookies` result.
   */
  async get(force = false) {
    if (!force && this.cached !== null && Date.now() - this.readAt < this.ttlMs) return this.cached
    if (this.reading !== null) return this.reading
    this.reading = readEdgeCookies()
      .catch((error) => ({ ok: false, reason: String(error?.message ?? error), cookies: [] }))
      .then(async (result) => {
        if (result.ok === true && Array.isArray(result.cookies) && result.cookies.length > 0) {
          this.cached = result
          this.readAt = Date.now()
          this.reading = null
          await this.saveSnapshot(result)
          return result
        }
        // The live database could not be read. Before reporting a locked Edge,
        // fall back to the snapshot saved by an earlier successful read: those
        // cookies are still the user's, and they are still valid.
        const saved = await this.loadSaved()
        if (saved !== null) {
          this.cached = saved
          this.readAt = Date.now()
          this.reading = null
          return saved
        }
        this.cached = result
        this.readAt = Date.now()
        this.reading = null
        return result
      })
    return this.reading
  }

  /** The `Cookie` header value for one request host, or ''. */
  async headerFor(host) {
    const snapshot = await this.get()
    if (snapshot.ok !== true) return ''
    const parts = []
    for (const cookie of snapshot.cookies) {
      if (!hostMatches(cookie.host, host)) continue
      parts.push(`${cookie.name}=${cookie.value}`)
    }
    return parts.join('; ')
  }
}

/**
 * A short, user-facing description of the cookie state.
 * @param {object} snapshot - a `readEdgeCookies` result.
 * @returns {{ available: boolean, locked: boolean, count: number, note: string }}
 */
export function describeCookies(snapshot) {
  if (snapshot?.ok === true) {
    // A snapshot read from the saved copy while Edge holds the live database is
    // still the user's own cookies, so it is reported as available — but the note
    // says where it came from, so a stale session is not mistaken for a live one.
    const age = Number.isFinite(snapshot.savedAt) ? Math.max(0, Date.now() - snapshot.savedAt) : 0
    const minutes = Math.round(age / 60_000)
    const fromCache = snapshot.saved === true
    return {
      available: true,
      locked: false,
      fromCache,
      savedAgeMinutes: fromCache ? minutes : 0,
      count: snapshot.cookies.length,
      note: fromCache
        ? `${snapshot.cookies.length} cookies from Edge profile ${snapshot.profile} (saved ${minutes < 1 ? 'just now' : `${minutes} min ago`}; Edge is running, so the live database is in use)`
        : `${snapshot.cookies.length} cookies from Edge profile ${snapshot.profile}`,
    }
  }
  if (snapshot?.locked === true) {
    return {
      available: false,
      locked: true,
      count: 0,
      note: 'Edge is running, so its cookie database is locked, and no saved copy exists yet. Close Edge once and run Summarize to save your sign-ins; after that they keep working while Edge is open.',
    }
  }
  return { available: false, locked: false, count: 0, note: String(snapshot?.reason ?? 'Edge cookies are unavailable') }
}
