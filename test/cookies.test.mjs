import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CookieJar, COOKIE_RETRY_MS, decryptValue, describeCookies, hostMatches } from '../lib/cookies.js'

test('a domain cookie matches the bare host and its subdomains', () => {
  assert.equal(hostMatches('.x.com', 'x.com'), true)
  assert.equal(hostMatches('.x.com', 'api.x.com'), true)
  assert.equal(hostMatches('.x.com', 'notx.com'), false)
  assert.equal(hostMatches('.x.com', 'x.com.evil.test'), false)
})

test('a host-only cookie matches only that exact host', () => {
  assert.equal(hostMatches('x.com', 'x.com'), true)
  assert.equal(hostMatches('x.com', 'api.x.com'), false)
})

test('hostMatches is case-insensitive and rejects empties', () => {
  assert.equal(hostMatches('.X.COM', 'API.x.com'), true)
  assert.equal(hostMatches('', 'x.com'), false)
  assert.equal(hostMatches('.x.com', ''), false)
})

test('decryptValue rejects a value that is not Chromium-encrypted', () => {
  assert.equal(decryptValue(Buffer.from('plain text, not encrypted'), Buffer.alloc(32)), '')
  assert.equal(decryptValue(Buffer.alloc(0), Buffer.alloc(32)), '')
  // A v10 blob too short to hold a nonce and a tag.
  assert.equal(decryptValue(Buffer.concat([Buffer.from('v10'), Buffer.alloc(10)]), Buffer.alloc(32)), '')
})

test('decryptValue returns empty rather than throwing on a bad tag', () => {
  // 3-byte prefix + 12-byte nonce + some ciphertext + 16-byte tag, wrong key.
  const blob = Buffer.concat([Buffer.from('v10'), Buffer.alloc(40, 7)])
  assert.equal(decryptValue(blob, Buffer.alloc(32, 1)), '')
})

test('describeCookies explains a locked Edge instead of failing', () => {
  const locked = describeCookies({ ok: false, locked: true, cookies: [] })
  assert.equal(locked.available, false)
  assert.equal(locked.locked, true)
  assert.match(locked.note, /Edge is running/)
  // The old advice — "close Edge once and run Summarize" — was impossible to
  // follow, because closing the window leaves Edge running in the background and
  // the database locked. The note must say that, and must say the save happens on
  // its own rather than asking the user to re-run anything.
  assert.match(locked.note, /Closing the window is not enough/)
  assert.match(locked.note, /background/)
  assert.match(locked.note, /automatically within seconds/)
})

test('describeCookies reports an available jar with its count', () => {
  const ok = describeCookies({ ok: true, cookies: [{ name: 'a' }, { name: 'b' }], profile: 'Default' })
  assert.equal(ok.available, true)
  assert.equal(ok.count, 2)
  assert.equal(ok.fromCache, false)
  assert.match(ok.note, /2 cookies/)
})

test('describeCookies marks a restored snapshot as cached, with its age', () => {
  const cached = describeCookies({
    ok: true,
    saved: true,
    savedAt: Date.now() - 7 * 60_000,
    cookies: [{ name: 'a' }],
    profile: 'Default',
  })
  assert.equal(cached.available, true, 'a saved snapshot is still usable')
  assert.equal(cached.fromCache, true)
  assert.equal(cached.savedAgeMinutes, 7)
  assert.match(cached.note, /saved/)
})

test('the jar falls back to a saved snapshot when the live database is locked', async () => {
  // The reported bug: with Edge running, every run showed "quit Edge" even though
  // the user had already signed in. A snapshot saved by an earlier read must be
  // reused instead.
  const dir = await mkdtemp(join(tmpdir(), 'dnd-jar-'))
  const cacheFile = join(dir, 'edge-cookies.json')
  const future = Math.floor(Date.now() / 1000) + 86_400
  await writeFile(cacheFile, JSON.stringify({
    ok: true,
    profile: 'Default',
    cookies: [{ host: '.x.com', name: 'auth_token', value: 'saved-token', path: '/', secure: true, httpOnly: true, expires: future }],
  }), 'utf8')

  const jar = new CookieJar({ cacheFile })
  const snapshot = await jar.get()
  assert.equal(snapshot.ok, true, 'the saved snapshot must be used when Edge is locked')
  assert.equal(snapshot.saved, true)
  assert.equal(await jar.headerFor('x.com'), 'auth_token=saved-token')
  await rm(dir, { recursive: true, force: true })
})

test('the jar ignores an expired saved snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dnd-jar-'))
  const cacheFile = join(dir, 'edge-cookies.json')
  await writeFile(cacheFile, JSON.stringify({
    ok: true,
    cookies: [{ host: '.x.com', name: 'auth_token', value: 'old', path: '/', secure: true, httpOnly: true, expires: Math.floor(Date.now() / 1000) - 60 }],
  }), 'utf8')
  const jar = new CookieJar({ cacheFile })
  const snapshot = await jar.get()
  assert.notEqual(snapshot.saved, true, 'dead credentials must not be replayed')
  await rm(dir, { recursive: true, force: true })
})

test('a snapshot with only session cookies is still usable', async () => {
  // `expires: 0` means a session cookie: valid until the browser closes, so a
  // saved snapshot of them must not be discarded for having no future date.
  const dir = await mkdtemp(join(tmpdir(), 'dnd-jar-'))
  const cacheFile = join(dir, 'edge-cookies.json')
  await writeFile(cacheFile, JSON.stringify({
    ok: true,
    cookies: [{ host: '.x.com', name: 'auth_token', value: 'session', path: '/', secure: true, httpOnly: true, expires: 0 }],
  }), 'utf8')
  const jar = new CookieJar({ cacheFile })
  const snapshot = await jar.get()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.saved, true)
  await rm(dir, { recursive: true, force: true })
})

test('a corrupt saved snapshot is ignored rather than thrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dnd-jar-'))
  const cacheFile = join(dir, 'edge-cookies.json')
  await writeFile(cacheFile, 'not json at all', 'utf8')
  const jar = new CookieJar({ cacheFile })
  const snapshot = await jar.get()
  assert.notEqual(snapshot.saved, true)
  await rm(dir, { recursive: true, force: true })
})

test('describeCookies falls back to the reason', () => {
  const missing = describeCookies({ ok: false, reason: 'Edge is not installed', cookies: [] })
  assert.equal(missing.available, false)
  assert.match(missing.note, /not installed/)
})

test('the jar caches a snapshot and serves a Cookie header per host', async () => {
  const jar = new CookieJar()
  // Replace the reader with a deterministic snapshot: this tests the cache and
  // header assembly, not the machine's Edge profile.
  jar.cached = {
    ok: true,
    cookies: [
      { host: '.x.com', name: 'auth_token', value: 'abc' },
      { host: '.x.com', name: 'ct0', value: 'def' },
      { host: '.zhihu.com', name: 'z_c0', value: 'ghi' },
    ],
    profile: 'Default',
  }
  jar.readAt = Date.now()

  assert.equal(await jar.headerFor('x.com'), 'auth_token=abc; ct0=def')
  assert.equal(await jar.headerFor('api.x.com'), 'auth_token=abc; ct0=def')
  assert.equal(await jar.headerFor('zhihu.com'), 'z_c0=ghi')
  assert.equal(await jar.headerFor('example.com'), '')
})

test('the jar returns no header when Edge is locked', async () => {
  const jar = new CookieJar()
  jar.cached = { ok: false, locked: true, cookies: [] }
  jar.readAt = Date.now()
  assert.equal(await jar.headerFor('x.com'), '')
})

test('a locked read is retried within seconds, not cached for the full TTL', async () => {
  // The bug: a failed read was cached for COOKIE_TTL_MS (10 minutes). A user who
  // quit Edge to let the snapshot save still saw "locked" for up to ten minutes, so
  // the advice appeared not to work. Only a live successful read earns the long TTL.
  const jar = new CookieJar({ cacheFile: null, ttlMs: 10 * 60_000 })
  let attempts = 0
  const original = jar.get.bind(jar)
  // Drive the cache path directly: seed a failed result, then read it back.
  jar.cached = { ok: false, locked: true, cookies: [], reason: 'Edge is running' }
  jar.readAt = Date.now()
  const first = await jar.get()
  assert.equal(first.locked, true, 'the cached failure stands for a moment')
  assert.ok(COOKIE_RETRY_MS <= 10_000, `a retry must happen within seconds; got ${COOKIE_RETRY_MS}ms`)

  // After the retry window the failure must not be served from cache.
  jar.readAt = Date.now() - (COOKIE_RETRY_MS + 1)
  const second = await jar.get()
  assert.notEqual(second, first, 'the stale failure must be re-read instead of returned')
  attempts += 1
  assert.equal(attempts, 1)
})

test('a live successful read keeps the full TTL', async () => {
  const jar = new CookieJar({ cacheFile: null, ttlMs: 10 * 60_000 })
  const live = { ok: true, cookies: [{ name: 'a', value: 'b' }], profile: 'Default' }
  jar.cached = live
  jar.readAt = Date.now()
  assert.equal(await jar.get(), live, 'a live snapshot is reusable')
})
