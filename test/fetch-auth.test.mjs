import assert from 'node:assert/strict'
import { test } from 'node:test'

import { htmlToText, looksLikeLoginWall, needsAuth, pageTitle } from '../lib/fetch-auth.js'

test('login-walled hosts are recognised, including subdomains', () => {
  assert.equal(needsAuth('https://x.com/elonmusk/status/1'), true)
  assert.equal(needsAuth('https://api.x.com/2/tweets'), true)
  assert.equal(needsAuth('https://www.zhihu.com/question/1'), true)
  assert.equal(needsAuth('https://weibo.com/1/abc'), true)
  assert.equal(needsAuth('https://www.linkedin.com/posts/x'), true)
  // Ordinary outlets must not trigger an authenticated fetch.
  assert.equal(needsAuth('https://www.cnn.com/2026/10/26/tech/x'), false)
  assert.equal(needsAuth('https://openai.com/index/gpt-6'), false)
  assert.equal(needsAuth('not a url'), false)
})

test('a short sign-in page reads as a login wall', () => {
  assert.equal(looksLikeLoginWall('<html><body>Log in to X. Sign in to continue.</body></html>'), true)
  assert.equal(looksLikeLoginWall('请先登录后查看'), true)
  assert.equal(looksLikeLoginWall(''), true)
})

test('a long article that merely mentions signing in is not a wall', () => {
  const article = `<html><body>${'A long reported story about chips. '.repeat(5000)} You must log in to comment.</body></html>`
  assert.ok(article.length > 120_000)
  assert.equal(looksLikeLoginWall(article), false)
})

test('htmlToText strips scripts, styles and tags', () => {
  const html = '<html><head><style>.a{color:red}</style><script>var x=1</script></head><body><h1>Title</h1><p>First para.</p><p>Second &amp; last.</p></body></html>'
  const text = htmlToText(html)
  assert.match(text, /Title/)
  assert.match(text, /First para\./)
  assert.match(text, /Second & last\./)
  assert.doesNotMatch(text, /color:red/)
  assert.doesNotMatch(text, /var x=1/)
})

test('htmlToText honours its limit', () => {
  const text = htmlToText(`<p>${'x'.repeat(5000)}</p>`, 100)
  assert.equal(text.length, 100)
})

test('pageTitle prefers og:title then the title tag', () => {
  assert.equal(pageTitle('<meta property="og:title" content="OG Headline"><title>Tag Headline</title>'), 'OG Headline')
  assert.equal(pageTitle('<title>Tag Headline</title>'), 'Tag Headline')
  assert.equal(pageTitle('<html></html>'), '')
})
