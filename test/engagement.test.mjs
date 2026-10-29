import assert from 'node:assert/strict'
import { test } from 'node:test'

import { engagementFromHtml, engagementFromSnippet, measurable, parseCount } from '../lib/engagement.js'

test('parseCount reads plain, comma and scaled counts', () => {
  assert.equal(parseCount('1,234'), 1234)
  assert.equal(parseCount('12.3k'), 12300)
  assert.equal(parseCount('4万'), 40000)
  assert.equal(parseCount('abc'), 0)
})

test('engagementFromHtml reads a Reddit-style score', () => {
  const reading = engagementFromHtml('<div>1,234 points</div>')
  assert.equal(reading.reads, 1234)
  assert.equal(reading.basis, 'upvotes')
})

test('engagementFromHtml reads Hacker News points', () => {
  const reading = engagementFromHtml('<span>456 points</span> <a>78 comments</a>')
  assert.equal(reading.reads, 456)
})

test('engagementFromHtml falls back to comments at half weight', () => {
  const reading = engagementFromHtml('<span>100 comments</span>')
  assert.equal(reading.reads, 50)
  assert.match(reading.basis, /comments/)
})

test('engagementFromHtml returns null when nothing is stated', () => {
  assert.equal(engagementFromHtml('<p>No numbers here at all.</p>'), null)
  assert.equal(engagementFromHtml(''), null)
})

test('engagementFromSnippet reads a score from a search snippet', () => {
  const reading = engagementFromSnippet('1.2k points, 340 comments')
  assert.equal(reading.reads, 1200)
  assert.match(reading.basis, /snippet/)
})

test('measurable only accepts hosts that publish a count', () => {
  assert.equal(measurable('https://www.reddit.com/r/x/comments/1'), true)
  assert.equal(measurable('https://news.ycombinator.com/item?id=1'), true)
  assert.equal(measurable('https://www.cnn.com/story'), false)
  assert.equal(measurable('not a url'), false)
})
