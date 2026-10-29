/**
 * Tests for the scheduled delivery: PDF rendering and the email message.
 *
 * The mail transport itself is Outlook COM and needs a live Outlook, so what is
 * testable here is the part that decides *what* is sent and how failures are
 * reported — which is where a silent failure would hide.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { composeMessage, sendMail } from '../lib/mail.js'
import { pdfPath, printToPdf } from '../lib/pdf.js'

/** A digest shaped the way `runDigest` returns one. */
const digest = {
  id: 'digest-test-1',
  day: '2026-10-28',
  topics: [
    {
      topic: 'AI News',
      brief: 'Anthropic filed for its IPO.',
      stories: [
        { title: 'Anthropic files for IPO', url: 'https://example.com/a' },
        { title: 'OpenAI ships a model', url: 'https://example.com/b' },
      ],
    },
    { topic: 'Geopolitics', brief: '', stories: [] },
  ],
}

test('the email subject names the day it covers', () => {
  const { subject } = composeMessage(digest, 'en')
  assert.match(subject, /2026-10-28/)
  assert.match(subject, /Daily News Digest/)
})

test('a Chinese report produces a Chinese message', () => {
  const { subject, body } = composeMessage(digest, 'zh')
  assert.match(subject, /每日新闻摘要/)
  assert.match(body, /覆盖日期/)
})

test('the body names every topic and every story link', () => {
  const { body } = composeMessage(digest, 'en')
  assert.match(body, /AI News/)
  assert.match(body, /Geopolitics/)
  assert.match(body, /Anthropic files for IPO/)
  assert.match(body, /https:\/\/example\.com\/a/)
  // A topic with no stories says so rather than being silently omitted.
  assert.match(body, /no news found/)
})

test('the body points at the attachment', () => {
  assert.match(composeMessage(digest, 'en').body, /attached PDF/)
})

test('a digest with no topics still composes without throwing', () => {
  const { subject, body } = composeMessage({ day: '2026-10-28', topics: [] }, 'en')
  assert.match(subject, /2026-10-28/)
  assert.equal(typeof body, 'string')
  assert.ok(body.length > 0)
})

test('a malformed digest does not throw', () => {
  for (const bad of [null, undefined, {}, { topics: 'nope' }, { topics: [null] }]) {
    const { subject, body } = composeMessage(bad, 'en')
    assert.equal(typeof subject, 'string')
    assert.equal(typeof body, 'string')
  }
})

test('sending with no recipient fails with a reason, not a throw', async () => {
  const result = await sendMail({ to: '', subject: 'x', body: 'y' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /recipient/)
})

test('a send whose process produces no JSON is reported as a failure', async () => {
  // A transport that dies must not look like a successful send.
  const spawn = (_cmd, _args, _opts, callback) => {
    callback(null, '')
    return { on() {} }
  }
  const result = await sendMail({ to: 'a@b.c', subject: 's', body: 'b', spawn })
  assert.equal(result.ok, false)
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
})

test('a send that reports an Outlook error carries the reason through', async () => {
  const spawn = (_cmd, _args, _opts, callback) => {
    callback(null, '{"ok":false,"reason":"Outlook is not running"}')
    return { on() {} }
  }
  const result = await sendMail({ to: 'a@b.c', subject: 's', body: 'b', spawn })
  assert.equal(result.ok, false)
  assert.match(result.reason, /Outlook is not running/)
})

test('a successful send reports ok', async () => {
  const spawn = (_cmd, _args, _opts, callback) => {
    callback(null, '{"ok":true,"reason":""}')
    return { on() {} }
  }
  const result = await sendMail({ to: 'a@b.c', subject: 's', body: 'b', spawn })
  assert.equal(result.ok, true)
})

test('the recipient is passed as data, never interpolated into the script', async () => {
  // A quote in an address must not become PowerShell syntax. The value travels in
  // the environment, and the script text itself never contains it.
  let captured = null
  let scriptText = ''
  const spawn = (_cmd, args, opts, callback) => {
    captured = opts
    scriptText = Array.isArray(args) ? args.join(' ') : ''
    callback(null, '{"ok":true}')
    return { on() {} }
  }
  const hostile = `a"@b.c; Remove-Item C:\\ -Recurse`
  await sendMail({ to: hostile, subject: 's', body: 'b', spawn })
  assert.equal(captured.env.DND_TO, hostile, 'the address travels as an environment value')
  assert.ok(!scriptText.includes(hostile), 'the address must not appear in the argv script')
  assert.ok(!scriptText.includes('Remove-Item C:'), 'a hostile address must not reach the script text')
})

test('a PDF path is derived from the digest id and cannot escape the directory', () => {
  const normal = pdfPath('digest-abc')
  assert.match(normal, /digest-abc\.pdf$/)
  const hostile = pdfPath('../../evil:id*?')
  assert.ok(!hostile.includes('..'), 'a path traversal must be collapsed')
  assert.match(hostile, /\.pdf$/)
})

test('printing a missing HTML file fails with a reason', async () => {
  const result = await printToPdf({ htmlPath: join(tmpdir(), 'definitely-not-there-12345.html') })
  assert.equal(result.ok, false)
  assert.match(result.reason, /not written/)
})

test('printing with no Edge available fails with a reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dnd-pdf-'))
  const html = join(dir, 'r.html')
  await writeFile(html, '<!doctype html><p>x</p>', 'utf8')
  const result = await printToPdf({ htmlPath: html, locate: () => '' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /Edge was not found/)
  await rm(dir, { recursive: true, force: true })
})

test('a print that writes nothing is reported as a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dnd-pdf-'))
  const html = join(dir, 'r.html')
  await writeFile(html, '<!doctype html><p>x</p>', 'utf8')
  // A spawn that pretends to succeed but writes no file must not be taken as ok.
  const spawn = (_cmd, _args, _opts, callback) => {
    callback(null, '')
    return { on() {} }
  }
  const result = await printToPdf({ htmlPath: html, outPath: join(dir, 'out.pdf'), edgePath: 'fake', spawn })
  assert.equal(result.ok, false)
  assert.match(result.reason, /without writing/)
  assert.equal(existsSync(join(dir, 'out.pdf')), false)
  await rm(dir, { recursive: true, force: true })
})
