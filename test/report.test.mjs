/**
 * Tests for the standalone report document and the Edge launcher.
 *
 * The report is what an Edge window shows, so the things worth pinning are the
 * ones a browser cannot check for me here: that it renders from the *stored*
 * digest, that every field survives, that text is escaped, and that the
 * launcher refuses rather than pretending when Edge is absent.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import { buildReport, reportLabels } from '../lib/report.js'
import { edgeCandidates, fileUrl, findEdge, openWindow, reportFile } from '../lib/launch.js'

const digest = {
  id: 'digest-abc',
  createdAt: '2026-10-26T09:30:00.000Z',
  day: '2026-10-26',
  durationMs: 4200,
  top: 5,
  model: 'provider/model',
  summarized: true,
  partial: false,
  sources: [
    { id: 'site:cnn.com', label: 'CNN', kind: 'site' },
    { id: 'forum:reddit', label: 'Reddit', kind: 'forum' },
  ],
  notes: { cookies: 'Edge is running, so its cookie database is locked.' },
  topics: [
    {
      topic: 'AI News',
      brief: 'Chips and models.',
      summarized: true,
      measured: true,
      stories: [
        {
          id: 1,
          title: 'Chip rules tighten across three jurisdictions',
          url: 'https://cnn.com/2026/10/26/tech/chip-rules',
          line: 'Three regulators moved on the same day.',
          publishedAt: '2026-10-26T08:00:00.000Z',
          dated: true,
          sameDay: true,
          sources: ['CNN', 'Reddit'],
          sourceCount: 2,
          reads: 1200,
          measured: true,
          links: [
            { url: 'https://cnn.com/2026/10/26/tech/chip-rules', title: 'Chip rules tighten', source: 'CNN', publishedAt: '2026-10-26T08:00:00.000Z', reads: 900 },
            { url: 'https://reddit.com/r/tech/abc', title: 'Discussion', source: 'Reddit', publishedAt: null, reads: 300 },
          ],
        },
      ],
    },
    { topic: '具身智能', brief: '', stories: [], summarized: false, reason: 'no results', measured: false },
  ],
}

test('the report renders the stored digest, not a placeholder', () => {
  const html = buildReport(digest, { lang: 'en' })
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /Chip rules tighten across three jurisdictions/, 'the story title must appear')
  assert.match(html, /https:\/\/cnn\.com\/2026\/10\/26\/tech\/chip-rules/, 'the article URL must be the link target')
  assert.match(html, /Three regulators moved on the same day/, 'the one-line summary must appear')
  assert.match(html, /Chips and models/, 'the topic brief must appear')
  assert.match(html, /provider\/model/, 'the model must be named')
  assert.match(html, /CNN, Reddit/, 'the searched sources must be listed')
  assert.match(html, /2 sources/, 'the source count must appear')
  assert.match(html, /1200 reads \(measured\)/, 'a measured read count must say it was measured')
  assert.match(html, /具身智能/, 'a non-Latin topic must survive')
  assert.match(html, /No news was found for this topic/, 'an empty topic must say so rather than render blank')
  assert.match(html, /Stored copy/, 'the page must say it is the stored copy, not a new search')
})

test('the report opens article links in a new tab with no referrer', () => {
  const html = buildReport(digest, { lang: 'en' })
  const anchors = [...html.matchAll(/<a class="title" href="([^"]*)"([^>]*)>/g)]
  assert.equal(anchors.length, 1, 'one story link')
  assert.equal(anchors[0][1], 'https://cnn.com/2026/10/26/tech/chip-rules')
  assert.match(anchors[0][2], /target="_blank"/)
  assert.match(anchors[0][2], /rel="noreferrer noopener"/)
})

test('the report lists the other outlets a story came from', () => {
  const html = buildReport(digest, { lang: 'en' })
  assert.match(html, /<details>/)
  assert.match(html, /https:\/\/reddit\.com\/r\/tech\/abc/, 'the other outlet must be linkable')
})

test('the report escapes text so a headline cannot inject markup', () => {
  const hostile = {
    ...digest,
    topics: [
      {
        topic: '<script>alert(1)</script>',
        brief: 'a & b "quoted"',
        stories: [
          {
            id: 1,
            title: '<img src=x onerror=alert(1)>',
            url: 'https://example.com/x?a=1&b=2',
            line: "it's <b>fine</b>",
            publishedAt: null,
            sources: ['A<B>'],
            sourceCount: 1,
            reads: 1,
            measured: false,
            links: [],
          },
        ],
      },
    ],
  }
  const html = buildReport(hostile, { lang: 'en' })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'a topic must not become a script tag')
  assert.doesNotMatch(html, /<img src=x/, 'a title must not become an image tag')
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'the topic must be escaped')
  assert.match(html, /a &amp; b &quot;quoted&quot;/, 'quotes and ampersands must be escaped')
  assert.match(html, /href="https:\/\/example\.com\/x\?a=1&amp;b=2"/, 'an ampersand in a URL must be escaped')
})

test('the report is self-contained: no external stylesheet or script', () => {
  const html = buildReport(digest, { lang: 'en' })
  assert.doesNotMatch(html, /<link\b/i, 'no external stylesheet may be referenced')
  assert.doesNotMatch(html, /<script\b/i, 'no script may be included')
  assert.match(html, /<style>/, 'the styling must be inlined')
})

test('the report follows the language of the request', () => {
  const zh = buildReport(digest, { lang: 'zh-CN' })
  assert.match(zh, /每日新闻摘要/)
  assert.match(zh, /生成于/)
  assert.match(zh, /条新闻/)
  assert.match(zh, /这是当时保存的摘要/)
  const en = buildReport(digest, { lang: 'en-US' })
  assert.match(en, /Generated/)
  assert.match(en, /stories/)
})

test('reportLabels falls back to English for an unknown language', () => {
  assert.equal(reportLabels('de-DE').generated, 'Generated')
  assert.equal(reportLabels(undefined).generated, 'Generated')
  assert.equal(reportLabels('zh').generated, '生成于')
})

test('the report marks a relevance-unconfirmed story instead of presenting it as certain', () => {
  const withGrey = {
    ...digest,
    filtered: [{ topic: 'AI News', dropped: 3 }],
    topics: [
      {
        topic: 'AI News',
        brief: 'Mixed.',
        stories: [
          {
            id: 1,
            title: 'A story the screen could not confirm',
            url: 'https://example.com/a',
            line: 'Line.',
            publishedAt: null,
            sources: ['A'],
            sourceCount: 1,
            reads: 1,
            measured: false,
            links: [],
            relevance: { decision: 'grey' },
          },
        ],
      },
    ],
  }
  const html = buildReport(withGrey, { lang: 'en' })
  assert.match(html, /relevance unconfirmed/, 'the flag must be visible in the stored copy')
  assert.match(html, /Filtered out 3 unrelated result/, 'the filtering must be stated, not left as a short digest')
})

test('the report omits the relevance notes when nothing was filtered', () => {
  const clean = { ...digest, filtered: [] }
  const html = buildReport(clean, { lang: 'en' })
  assert.doesNotMatch(html, /Filtered out/, 'a clean run must not claim filtering')
  assert.doesNotMatch(html, /relevance unconfirmed/)
})

test('the report states the two filters separately, because they differ', () => {
  const filtered = {
    ...digest,
    filtered: [{ topic: 'AI News', dropped: 3, evergreen: 4 }],
    topics: [{ topic: 'AI News', brief: '', stories: [] }],
  }
  const html = buildReport(filtered, { lang: 'en' })
  assert.match(html, /Filtered out 3 unrelated result/, 'off-topic noise is reported')
  assert.match(html, /Skipped 4 on-topic page/, 'on-topic non-news is reported separately')
})

test('the report omits the evergreen note when nothing was evergreen', () => {
  const only = { ...digest, filtered: [{ topic: 'AI News', dropped: 2 }], topics: [] }
  const html = buildReport(only, { lang: 'en' })
  assert.match(html, /Filtered out 2 unrelated result/)
  assert.doesNotMatch(html, /Skipped \d+ on-topic/, 'no claim may be made about a filter that removed nothing')
})

test('a total search failure is reported, not shown as a quiet news day', () => {
  // The reported bug: the search provider was unconfigured, every query failed,
  // and the report still said "the stories are listed as collected" with no
  // stories. That reads as a partial success instead of a broken run.
  const broken = {
    ...digest,
    topics: [{ topic: 'AI News', brief: '', stories: [] }],
    summarized: false,
    notes: { searches: { failed: 157, of: 157, error: 'DeepSeek search has no API key', query: 'x' } },
    filtered: [],
  }
  const html = buildReport(broken, { lang: 'en' })
  assert.match(html, /All 157 searches failed/, 'the failure must be stated')
  assert.match(html, /DeepSeek search has no API key/, 'the reason must be carried through')
  assert.doesNotMatch(html, /stories are listed as collected/, 'an empty digest must not claim to list stories')
})

test('a partial search failure is still reported', () => {
  const partial = { ...digest, notes: { searches: { failed: 3, of: 20, error: 'timeout', query: 'x' } } }
  const html = buildReport(partial, { lang: 'en' })
  assert.match(html, /3 of 20 searches failed/)
})

test('a digest with stories and no model summary still explains itself', () => {
  const html = buildReport({ ...digest, summarized: false }, { lang: 'en' })
  assert.match(html, /stories are listed as collected/, 'the fallback note is right when there are stories')
})

test('the report survives a malformed digest instead of throwing', () => {
  for (const bad of [null, undefined, {}, { topics: 'nope' }, { topics: [null] }]) {
    const html = buildReport(bad, { lang: 'en' })
    assert.match(html, /^<!doctype html>/, 'a malformed digest must still render a page')
  }
})

test('a report is written to a file a browser can open without a server', () => {
  // The bug this pins: the window used to load the report from the plugin's HTTP
  // route, so a handler that threw left the connection open with no response and
  // Edge showed "This page isn't responding". A static document needs no server.
  const html = buildReport(digest, { lang: 'en' })
  const file = reportFile('digest-abc', html)
  try {
    assert.ok(existsSync(file), 'the file must be written')
    assert.match(file, /\.html$/, 'the file must be an HTML document')
    const url = fileUrl(file)
    assert.match(url, /^file:\/\/\//, 'the window must load it over file://')
    assert.equal(readFileSync(file, 'utf8'), html, 'the file must contain exactly the document')
  } finally {
    rmSync(file, { force: true })
  }
})

test('the report file name is sanitised, so a digest id cannot escape the directory', () => {
  const html = buildReport(digest, { lang: 'en' })
  const nasty = reportFile('../../evil:id*?', html)
  try {
    assert.ok(!nasty.includes('..'), 'a traversal attempt must not survive in the name')
    assert.ok(nasty.startsWith(tmpdir()), 'the file must stay inside the temp directory')
    assert.ok(existsSync(nasty))
  } finally {
    rmSync(nasty, { force: true })
  }
})

test('reopening a digest overwrites its file instead of accumulating copies', () => {
  const html = buildReport(digest, { lang: 'en' })
  const first = reportFile('digest-same', html)
  try {
    const second = reportFile('digest-same', html)
    assert.equal(first, second, 'the same digest must map to the same file')
  } finally {
    rmSync(first, { force: true })
  }
})

test('findEdge returns a path only when Edge is actually installed', () => {
  const found = findEdge()
  if (found !== null) {
    assert.match(found, /msedge\.exe$/i, 'a found path must be the Edge executable')
    assert.ok(found.startsWith('C:\\'), 'a Windows install path must be absolute')
  }
  // A configured path that does not exist must not be trusted.
  assert.equal(findEdge('C:\\definitely\\not\\here\\msedge.exe'), found, 'a stale configured path must fall back to the real one')
  assert.equal(findEdge(''), found, 'an empty config must fall back')
})

test('edgeCandidates lists absolute Windows paths only', () => {
  for (const candidate of edgeCandidates()) {
    assert.match(candidate, /Microsoft[\\/]Edge[\\/]Application[\\/]msedge\.exe$/, 'every candidate must name msedge.exe')
  }
})

test('openWindow builds the right Edge command line', () => {
  const calls = []
  const fakeChild = { once() {}, unref() {} }
  const result = openWindow({
    url: 'http://127.0.0.1:1234/daily-news-digest/report?t=abc&id=d1',
    width: 1200,
    height: 800,
    locate: () => 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    spawn: (exe, args, opts) => {
      calls.push({ exe, args, opts })
      return fakeChild
    },
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1, 'exactly one process must be launched')
  assert.match(calls[0].exe, /msedge\.exe$/)
  assert.equal(opts_detached(calls[0].opts), true, 'the window must be detached from the Host process')
  const args = calls[0].args
  assert.ok(args.includes('--app=http://127.0.0.1:1234/daily-news-digest/report?t=abc&id=d1'), 'the URL must be passed as an app window')
  assert.ok(args.includes('--window-size=1200,800'), 'the configured size must be used')
  // No --user-data-dir: the window must reuse the user's signed-in profile.
  assert.ok(!args.some((arg) => arg.startsWith('--user-data-dir')), 'the user profile must not be replaced')
})

function opts_detached(opts) {
  return opts?.detached === true
}

test('openWindow refuses when Edge is not installed', () => {
  const calls = []
  const result = openWindow({
    url: 'http://127.0.0.1/x',
    locate: () => null,
    spawn: () => {
      calls.push(1)
      return { once() {}, unref() {} }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'edge-missing')
  assert.equal(calls.length, 0, 'nothing may be launched when Edge is missing')
})

test('openWindow reports a spawn failure instead of throwing', () => {
  const result = openWindow({
    url: 'http://127.0.0.1/x',
    locate: () => 'C:\\fake\\msedge.exe',
    spawn: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /launch-failed/)
})

test('openWindow defaults the window size when the config is nonsense', () => {
  const calls = []
  openWindow({
    url: 'http://127.0.0.1/x',
    width: Number.NaN,
    height: -5,
    locate: () => 'C:\\fake\\msedge.exe',
    spawn: (exe, args) => {
      calls.push(args)
      return { once() {}, unref() {} }
    },
  })
  assert.ok(calls[0].includes('--window-size=1100,900'), 'a bad size must fall back to the default')
})

test('the story URL is printed as text, not only linked', () => {
  // The same HTML is emailed as a PDF. A PDF keeps the click target but a printed
  // or forwarded copy loses it, so the URL has to be readable text as well.
  const html = buildReport(digest, { lang: 'en' })
  const visible = html.replace(/<a[^>]*href="[^"]*"[^>]*>/g, '')
  assert.match(visible, /https:\/\/cnn\.com\/2026\/10\/26\/tech\/chip-rules/, 'the URL must appear outside an href')
})
