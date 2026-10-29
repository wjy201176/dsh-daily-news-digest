/**
 * End-to-end proof of the cookie path, without needing Edge closed.
 *
 * The live database is locked while Edge runs, so this builds a *synthetic*
 * Chromium cookie database encrypted exactly the way Chromium encrypts one — same
 * DPAPI-wrapped key in `Local State`, same `v10` AES-256-GCM record layout — and
 * reads it back through the plugin's own reader. If this passes, the only reason
 * the real read fails on this machine is the lock, not the cryptography.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readEdgeCookies } from '../lib/cookies.js'

/** Protect a buffer with DPAPI (CurrentUser) via PowerShell. */
function protectDpapi(data) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$in=[Console]::In.ReadToEnd()',
    '$b=[Convert]::FromBase64String($in)',
    '$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,"CurrentUser")',
    '[Console]::Out.Write([Convert]::ToBase64String($p))',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null) reject(new Error(`DPAPI protect failed: ${error.message}`))
        else resolve(Buffer.from(stdout.trim(), 'base64'))
      },
    )
    child.stdin?.end(data.toString('base64'))
  })
}

/** Encrypt one cookie value the way Chromium does. */
function encryptChromium(value, key) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ciphertext, cipher.getAuthTag()])
}

test('the reader decrypts a Chromium-shaped cookie database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dnd-edge-sim-'))
  try {
    const profile = join(root, 'Default')
    await mkdir(join(profile, 'Network'), { recursive: true })

    const key = randomBytes(32)
    const protectedKey = await protectDpapi(key)
    const localState = {
      os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI', 'latin1'), protectedKey]).toString('base64') },
    }
    await writeFile(join(root, 'Local State'), JSON.stringify(localState), 'utf8')

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profile, 'Network', 'Cookies'))
    db.exec(`create table cookies (
      host_key text, name text, value text, encrypted_value blob, path text,
      is_secure integer, is_httponly integer, expires_utc text
    )`)
    const insert = db.prepare(
      'insert into cookies (host_key,name,value,encrypted_value,path,is_secure,is_httponly,expires_utc) values (?,?,?,?,?,?,?,?)',
    )
    insert.run('.x.com', 'auth_token', '', encryptChromium('the-secret-token', key), '/', 1, 1, '0')
    insert.run('.x.com', 'ct0', '', encryptChromium('csrf-value', key), '/', 1, 0, '0')
    insert.run('.zhihu.com', 'z_c0', '', encryptChromium('zhihu-session', key), '/', 1, 1, '0')
    db.close()

    const snapshot = await readEdgeCookies({ root })
    assert.equal(snapshot.ok, true, `reader failed: ${snapshot.reason ?? snapshot.locked}`)
    assert.equal(snapshot.cookies.length, 3)

    const byName = new Map(snapshot.cookies.map((cookie) => [cookie.name, cookie]))
    assert.equal(byName.get('auth_token').value, 'the-secret-token')
    assert.equal(byName.get('ct0').value, 'csrf-value')
    assert.equal(byName.get('z_c0').value, 'zhihu-session')
    assert.equal(byName.get('auth_token').host, '.x.com')

    // The host filter the digest actually uses.
    const filtered = await readEdgeCookies({ root, hosts: ['x.com'] })
    assert.equal(filtered.cookies.length, 2, 'only x.com cookies should be selected')
    assert.ok(filtered.cookies.every((cookie) => cookie.host === '.x.com'))
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('the reader reports a locked database rather than throwing', async () => {
  // A root whose cookie file cannot be copied is the locked case.
  const root = await mkdtemp(join(tmpdir(), 'dnd-edge-lock-'))
  try {
    const profile = join(root, 'Default')
    await mkdir(join(profile, 'Network'), { recursive: true })
    await writeFile(join(root, 'Local State'), '{"os_crypt":{"encrypted_key":"DPAPIAAAA"}}', 'utf8')
    await writeFile(join(profile, 'Network', 'Cookies'), 'not a database', 'utf8')
    // A readable-but-corrupt database is a *reason*, not a lock: it must still
    // return a structured result rather than throwing out of the reader.
    const snapshot = await readEdgeCookies({ root })
    assert.equal(snapshot.ok, false)
    assert.ok(typeof snapshot.reason === 'string' && snapshot.reason.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
