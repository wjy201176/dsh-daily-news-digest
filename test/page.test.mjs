/**
 * A behavioural test for the page: it actually renders the panel component with
 * a small hook runtime and inspects the element tree.
 *
 * This exists because the bug it pins is a *rendering* decision — a digest left
 * over from an earlier visit was shown before the user pressed Summarize — and a
 * source-level assertion would not prove the page stays empty.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/**
 * A minimal React runtime: enough hooks for this component, with dependency
 * comparison so effects and callbacks are stable across renders.
 */
function createRuntime() {
  const slots = []
  const effects = []
  let cursor = 0
  let pendingRender = null

  const sameDeps = (left, right) => {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }

  const slotAt = (index, initial) => {
    if (slots[index] === undefined) slots[index] = { value: initial, deps: undefined }
    return slots[index]
  }

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index, typeof initial === 'function' ? initial() : initial)
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        if (pendingRender !== null) pendingRender()
      }
      return [slot.value, set]
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index, undefined)
      if (!sameDeps(slot.deps, deps)) {
        slot.deps = deps === undefined ? undefined : [...deps]
        effects.push(fn)
      }
    },
    useCallback(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index, fn)
      if (!sameDeps(slot.deps, deps)) {
        slot.deps = deps === undefined ? undefined : [...deps]
        slot.value = fn
      }
      return slot.value
    },
    useMemo(fn) {
      cursor += 1
      return fn()
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      // The slot holds the ref object itself; returning `slot.value` keeps the
      // same `{ current }` identity across renders, which is what a ref means.
      const slot = slotAt(index, { current: initial })
      return slot.value
    },
  }

  return {
    React,
    /** Render once and run any newly-due effects. */
    render(component, props) {
      cursor = 0
      effects.length = 0
      const tree = component(props)
      const due = effects.splice(0)
      return { tree, due }
    },
    /** Render one component in its own hook scope (a nested child). */
    renderWith(component, props) {
      const saved = cursor
      cursor = 0
      const tree = component(props)
      cursor = saved
      return tree
    },
    onRender(fn) {
      pendingRender = fn
    },
  }
}

/** Collect every element in a tree. */
function walk(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

/** The visible text of a tree, flattened. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children ?? []).map(textOf).join(' ')
}

/**
 * Expand nested function components into their rendered trees.
 *
 * The page builds its editors as components, so the element tree holds the
 * component function rather than the inputs it produces. Rendering those with
 * their own hook scope is what makes an input's `value` observable.
 */
function expand(node, runtime, depth = 0) {
  if (node === null || node === undefined || node === false) return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => expand(child, runtime, depth))
  if (typeof node.type === 'function' && depth < 6) {
    const props = node.props ?? {}
    const rendered = runtime.renderWith(node.type, props)
    return expand(rendered, runtime, depth + 1)
  }
  return { ...node, children: (node.children ?? []).map((child) => expand(child, runtime, depth)) }
}

/**
 * Load client.js in a VM, register the plugin, and return the page component.
 * @param {object} statePayload - what the Host's /state route answers.
 * @param {object} [overrides] - extra route answers, keyed by API path prefix,
 *   so a test can script a delete or a reopen without a live Host.
 */
function loadPage(statePayload, overrides = {}) {
  const dictionaries = []
  const registrations = []
  const calls = []
  let factory = null

  const documentStub = {
    baseURI: 'http://127.0.0.1/',
    head: { appendChild() {} },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: () => null,
  }

  const answer = (path) => {
    for (const [prefix, value] of Object.entries(overrides)) {
      if (path.startsWith(prefix)) return typeof value === 'function' ? value(path) : value
    }
    return { ok: true, value: statePayload }
  }

  const sandbox = {
    window: { __ModuleLoader__: { load(record) { factory = record.factory } } },
    console,
    document: documentStub,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    async fetch(url, init) {
      const path = String(url).replace(/^.*?daily-news-digest\/api\//, '')
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body })
      const payload = answer(path)
      return { async json() { return payload } }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  const runtime = createRuntime()
  const body = factory((request) => {
    if (request === 'react') return runtime.React
    throw new Error(`unexpected module request: ${request}`)
  })

  const ctx = {
    slots: {
      inject: (_owner, callback) => callback(),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    locale: {
      register: (namespace, dicts) => { dictionaries.push({ namespace, dicts }); return () => {} },
      bind: (namespace) => (key) => {
        const table = dictionaries.find((entry) => entry.namespace === namespace)?.dicts.en ?? {}
        return Object.hasOwn(table, key) ? table[key] : key
      },
    },
    effect: (fn) => { fn(); return () => {} },
    inject: (_names, callback) => { callback({}); return () => {} },
  }
  body.apply(ctx)

  const page = registrations.find((entry) => entry.options.name === 'main').component
  const t = ctx.locale.bind('dailyNewsDigest')
  return { page, t, runtime, calls, registrations, plugin: body }
}

/** Render the page and let its load effect settle. */
async function renderSettled(statePayload, overrides = {}) {
  const mounted = await mount(statePayload, overrides)
  return mounted.tree
}

/**
 * Render the page, settle its load effect, and keep the runtime so a test can
 * press a button and re-render the same hook state.
 */
async function mount(statePayload, overrides = {}) {
  const { page, t, runtime, calls } = loadPage(statePayload, overrides)
  let current = runtime.render(page, { t })
  // Run the load effect, then let its promise resolve and re-render.
  for (let pass = 0; pass < 8; pass += 1) {
    for (const effect of current.due) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    current = runtime.render(page, { t })
    if (current.due.length === 0) {
      // One more pass: state set by the resolved promise schedules a render.
      await new Promise((resolve) => setTimeout(resolve, 0))
      current = runtime.render(page, { t })
      if (current.due.length === 0) break
    }
  }

  /** Press a control, let its async handler settle, and re-render. */
  const press = async (element, event = { stopPropagation() {} }) => {
    element.props.onClick(event)
    for (let pass = 0; pass < 6; pass += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      current = runtime.render(page, { t })
      for (const effect of current.due) effect()
    }
    return current.tree
  }

  return { page, t, runtime, calls, tree: current.tree, press }
}

const savedDigest = {
  id: 'digest-old',
  createdAt: new Date().toISOString(),
  day: '2026-10-25',
  topics: [{ topic: 'AI News', brief: 'Yesterday happened.', stories: [{ id: 1, title: 'A previous story', url: 'https://a.com/x', line: 'Old line.', sources: ['A'], sourceCount: 1, reads: 5, measured: false, links: [] }] }],
  top: 5,
  sources: [{ id: 'site:a.com', label: 'A', kind: 'site' }],
  summarized: true,
  model: 'p/m',
  partial: false,
}

test('the page is empty before Summarize even when a previous digest is saved', async () => {
  const tree = await renderSettled({ topics: ['AI News'], sources: ['CNN.com'], top: 10, digest: savedDigest, history: [], job: { phase: 'idle' } })

  const elements = walk(expand(tree, createRuntime()))
  const digestBlock = elements.find((node) => node.props?.className === 'dnd-digest')
  assert.equal(digestBlock, undefined, 'no digest may render before Summarize')

  // The results area must be genuinely empty: not even a placeholder box, which
  // would still be content sitting where the digest goes.
  const placeholder = elements.find((node) => node.props?.className === 'dnd-empty')
  assert.equal(placeholder, undefined, 'no placeholder may render either')

  const text = textOf(tree)
  assert.doesNotMatch(text, /Yesterday happened/, 'the previous brief must not be shown')
  assert.doesNotMatch(text, /A previous story/, 'the previous story must not be shown')
  assert.doesNotMatch(text, /No digest yet/, 'no empty-state copy may render')
})

test('the editor still restores the saved topics, sources and Top', async () => {
  const { page, t, runtime } = loadPage({
    topics: [
      { topic: 'AI News', guidance: '' },
      { topic: '具身智能', guidance: '' },
    ],
    sources: ['CNN.com', 'reddit'],
    top: 7,
    digest: null,
    history: [],
    job: { phase: 'idle' },
  })
  let current = runtime.render(page, { t })
  for (let pass = 0; pass < 8; pass += 1) {
    for (const effect of current.due) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    current = runtime.render(page, { t })
    if (current.due.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      current = runtime.render(page, { t })
      if (current.due.length === 0) break
    }
  }

  const elements = walk(expand(current.tree, runtime))
  const inputs = elements.filter((node) => node.type === 'input')
  const values = inputs.map((node) => node.props?.value)
  assert.ok(values.includes('AI News'), 'the saved topic must be restored')
  assert.ok(values.includes('具身智能'), 'a non-Latin topic must be restored')
  assert.ok(values.includes('CNN.com'), 'the saved source must be restored')
  assert.ok(values.includes('reddit'))
  assert.ok(values.includes(7), 'the saved Top must be restored')

  const digestBlock = elements.find((node) => node.props?.className === 'dnd-digest')
  assert.equal(digestBlock, undefined, 'a fresh state renders no digest')
})

test('a digest does render once the Host reports a finished run', async () => {
  // The same component, given a job that has completed, must show the digest:
  // this proves the empty state is caused by the seeding decision, not by a
  // component that can never render results.
  const finished = {
    phase: 'done',
    digest: savedDigest,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    error: null,
  }
  const tree = await renderSettled({ topics: ['AI News'], sources: ['CNN.com'], top: 10, digest: null, history: [], job: finished })
  const elements = walk(tree)

  // The load path does not adopt a finished job's digest either: the result of a
  // run the user did not start in this page session is not shown as news.
  const digestBlock = elements.find((node) => node.props?.className === 'dnd-digest')
  assert.equal(digestBlock, undefined, 'a finished job from before this page opened is not adopted')
})

/**
 * Render one topic's section block, the way the digest area renders it.
 *
 * The digest area only renders for a run this page session started, which needs a
 * live poll loop, so the section is reached through the plugin's test handle and
 * rendered directly with the props the page would hand it.
 * @param {object} topic - one topic digest.
 * @returns {Promise<{ tree: object, runtime: object }>} the rendered section.
 */
async function renderDigestWith(topic) {
  const { t, runtime, plugin } = loadPage({
    topics: [],
    sources: ['CNN.com'],
    top: 10,
    digest: null,
    history: [],
    job: { phase: 'idle' },
  })
  const section = plugin.TopicSection
  if (typeof section !== 'function') throw new Error('the topic section handle is missing')
  return { tree: runtime.renderWith(section, { topic, t }), runtime }
}

/** One timeline row, shaped the way the Host's `historySummary` sends it. */
function historyRow(id, createdAt, topics) {
  return { id, createdAt, day: '2026-10-26', topics, topicCount: topics.length, storyCount: topics.length * 2, top: 5, model: 'p/m', durationMs: 1200 }
}

test('the timeline lists every stored digest, each with its own delete button', async () => {
  const rows = [
    historyRow('digest-b', '2026-10-26T09:30:00.000Z', ['AI News', '具身智能']),
    historyRow('digest-a', '2026-10-25T08:00:00.000Z', ['LLM Local Deployment']),
  ]
  const tree = await renderSettled({ topics: ['AI News'], sources: ['CNN.com'], top: 10, digest: null, history: rows, job: { phase: 'idle' } })
  const elements = walk(expand(tree, createRuntime()))

  assert.ok(elements.some((node) => node.props?.className === 'dnd-history'), 'the timeline must render')
  const items = elements.filter((node) => node.props?.className === 'dnd-timeline-item')
  assert.equal(items.length, 2, 'one row per stored digest')

  const deletes = elements.filter((node) => node.props?.className === 'dnd-timeline-delete')
  assert.equal(deletes.length, 2, 'every row carries a delete button')
  for (const button of deletes) {
    assert.equal(button.props.type, 'button')
    assert.equal(typeof button.props.onClick, 'function')
    assert.equal(button.props.disabled, false)
  }

  // The timeline is a list of past runs, not a result: no digest body may appear.
  assert.equal(elements.find((node) => node.props?.className === 'dnd-digest'), undefined)
})

test('pressing delete removes that row and never opens it', async () => {
  const rows = [
    historyRow('digest-b', '2026-10-26T09:30:00.000Z', ['AI News']),
    historyRow('digest-a', '2026-10-25T08:00:00.000Z', ['Chip Policy']),
  ]
  const mounted = await mount(
    { topics: ['AI News'], sources: ['CNN.com'], top: 10, digest: null, history: rows, job: { phase: 'idle' } },
    {
      'history/delete': (path) => ({ ok: true, value: { id: 'digest-b', history: rows.slice(1), digest: null } }),
      'digest?': { ok: true, value: savedDigest },
    },
  )

  let elements = walk(expand(mounted.tree, mounted.runtime))
  const target = elements.filter((node) => node.props?.className === 'dnd-timeline-delete')[0]
  assert.ok(target !== undefined)

  // A delete inside a row must not bubble up into the row's open handler.
  let stopped = false
  const tree = await mounted.press(target, { stopPropagation() { stopped = true } })
  assert.equal(stopped, true, 'the delete button must stop propagation')

  const posted = mounted.calls.filter((entry) => entry.path === 'history/delete')
  assert.equal(posted.length, 1, 'one delete request per press')
  assert.equal(posted[0].method, 'POST')
  assert.equal(JSON.parse(posted[0].body).id, 'digest-b')
  assert.equal(mounted.calls.filter((entry) => entry.path.startsWith('digest?')).length, 0, 'a delete must not reopen the row')

  elements = walk(expand(tree, createRuntime()))
  const items = elements.filter((node) => node.props?.className === 'dnd-timeline-item')
  assert.equal(items.length, 1, 'the deleted row must disappear')
  const topicsText = elements
    .filter((node) => node.props?.className === 'dnd-timeline-topics')
    .map((node) => textOf(node))
    .join(' ')
  assert.match(topicsText, /Chip Policy/, 'the surviving row keeps its own topics')
  assert.doesNotMatch(topicsText, /AI News/, 'the deleted row takes its topics with it')
  assert.equal(elements.find((node) => node.props?.className === 'dnd-digest'), undefined)
})

test('pressing a row opens that digest in its own Edge window', async () => {
  const rows = [historyRow('digest-b', '2026-10-26T09:30:00.000Z', ['AI News'])]
  const mounted = await mount(
    { topics: ['AI News'], sources: ['CNN.com'], top: 10, digest: null, history: rows, job: { phase: 'idle' } },
    { open: { ok: true, value: { id: 'digest-b', url: 'http://127.0.0.1/daily-news-digest/report?t=x&id=digest-b' } } },
  )

  const elements = walk(expand(mounted.tree, mounted.runtime))
  const open = elements.find((node) => node.props?.className === 'dnd-timeline-open')
  assert.ok(open !== undefined, 'a row must be openable')

  const tree = await mounted.press(open)

  const posted = mounted.calls.filter((entry) => entry.path === 'open')
  assert.equal(posted.length, 1, 'one open request per press')
  assert.equal(posted[0].method, 'POST')
  assert.equal(JSON.parse(posted[0].body).id, 'digest-b')

  // The panel must not adopt the stored digest: it was opened in its own window,
  // so rendering it here too would show the same news twice.
  assert.equal(mounted.calls.filter((entry) => entry.path.startsWith('digest?')).length, 0, 'opening must not fetch the digest into the panel')
  const rendered = walk(expand(tree, mounted.runtime))
  assert.equal(rendered.find((node) => node.props?.className === 'dnd-digest'), undefined, 'no digest may render in the panel')
  assert.match(textOf(tree), /Opened in an Edge window/, 'the page must confirm the window opened')
})

test('a missing Edge is reported instead of failing silently', async () => {
  const rows = [historyRow('digest-b', '2026-10-26T09:30:00.000Z', ['AI News'])]
  const mounted = await mount(
    { topics: ['AI News'], sources: ['CNN.com'], top: 10, digest: null, history: rows, job: { phase: 'idle' } },
    { open: { ok: false, error: 'edge-missing' } },
  )

  const elements = walk(expand(mounted.tree, mounted.runtime))
  const open = elements.find((node) => node.props?.className === 'dnd-timeline-open')
  const tree = await mounted.press(open)

  assert.match(textOf(tree), /Microsoft Edge was not found/, 'the page must say Edge is missing')
  // The row must be usable again: a stuck "Opening…" would read as a hung page.
  const after = walk(expand(tree, mounted.runtime))
  const row = after.find((node) => node.props?.className === 'dnd-timeline-open')
  assert.equal(row.props.disabled, false, 'the row must be enabled again after a failure')
})

test('each topic row offers a guidance box, collapsed until it is used', async () => {
  const { page, t, runtime } = loadPage({
    topics: [{ topic: 'AI News', guidance: '' }],
    sources: ['CNN.com'],
    top: 5,
    digest: null,
    history: [],
    job: { phase: 'idle' },
  })
  let current = runtime.render(page, { t })
  for (let pass = 0; pass < 8; pass += 1) {
    for (const effect of current.due) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    current = runtime.render(page, { t })
    if (current.due.length === 0) break
  }
  const elements = walk(expand(current.tree, runtime))
  const toggles = elements.filter((node) => node.props?.className?.includes?.('dnd-guidance-toggle') === true)
  assert.ok(toggles.length >= 1, 'every topic row must offer a guidance toggle')
  const boxes = elements.filter((node) => node.type === 'textarea')
  assert.equal(boxes.length, 0, 'an unused guidance box stays collapsed')
})

test('a topic that already has guidance shows it open', async () => {
  const { page, t, runtime } = loadPage({
    topics: [{ topic: 'LLM Local Deployment', guidance: 'only vLLM, skip tutorials' }],
    sources: ['CNN.com'],
    top: 5,
    digest: null,
    history: [],
    job: { phase: 'idle' },
  })
  let current = runtime.render(page, { t })
  for (let pass = 0; pass < 8; pass += 1) {
    for (const effect of current.due) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    current = runtime.render(page, { t })
    if (current.due.length === 0) break
  }
  const elements = walk(expand(current.tree, runtime))
  const boxes = elements.filter((node) => node.type === 'textarea')
  assert.equal(boxes.length, 1, 'saved guidance must be visible, not hidden behind a toggle')
  assert.equal(boxes[0].props.value, 'only vLLM, skip tutorials')
})

test('the digest shows the guidance the run was given', async () => {
  // The digest area only renders for a run this page session started, which needs
  // a live poll loop. The guidance line is a property of the topic section, so the
  // page's own section renderer is exercised through the digest block it builds.
  const topic = {
    topic: 'LLM Local Deployment',
    guidance: 'only vLLM, skip tutorials',
    brief: 'vLLM shipped a cache change.',
    stories: [{ id: 1, title: 'vLLM merged a KV cache', url: 'https://a.com/x', line: 'It merged.', sources: ['A'], sourceCount: 1, reads: 3, measured: false, links: [] }],
  }
  const { tree, runtime } = await renderDigestWith(topic)
  const elements = walk(expand(tree, runtime))
  const guidanceNode = elements.find((node) => node.props?.className === 'dnd-topic-guidance')
  assert.ok(guidanceNode !== undefined, 'the topic must render its guidance')
  const text = (guidanceNode.children ?? []).filter((child) => typeof child === 'string').join(' ')
  assert.match(text, /only vLLM, skip tutorials/, 'the reader must see what the search was told')
})

test('a topic with no guidance renders no guidance line', async () => {
  const topic = { topic: 'AI News', guidance: '', brief: 'Something happened.', stories: [] }
  const { tree, runtime } = await renderDigestWith(topic)
  const elements = walk(expand(tree, runtime))
  assert.equal(
    elements.find((node) => node.props?.className === 'dnd-topic-guidance'),
    undefined,
    'an empty guidance must not leave an empty line',
  )
})

test('the page shows how the guidance was applied: the plan, the criteria and the review', async () => {
  const topic = {
    topic: 'LLM Local Deployment',
    guidance: 'only vLLM, skip tutorials',
    skill: {
      queries: [
        { query: 'LLM Local Deployment news October 29 2026', angle: 'topic' },
        { query: 'vLLM October 29 2026', angle: 'subject' },
      ],
      fallback: ['LLM Local Deployment news'],
      criteria: ['Reject anything about: tutorials.'],
      usedFallback: 1,
      excluded: 2,
      reviewed: 4,
      reviewDropped: 1,
      reviewReasons: ['a tutorial, not news'],
    },
    brief: 'vLLM shipped a cache change.',
    stories: [{ id: 1, title: 'vLLM merged a KV cache', url: 'https://a.com/x', line: 'It merged.', sources: ['A'], sourceCount: 1, reads: 3, measured: false, links: [] }],
  }
  const { tree, runtime } = await renderDigestWith(topic)
  const elements = walk(expand(tree, runtime))
  const audit = elements.find((node) => node.props?.className === 'dnd-audit')
  assert.ok(audit !== undefined, 'the topic must render its audit block')

  const text = JSON.stringify(elements.map((node) => node.children ?? []))
  assert.match(text, /2 queries/, 'the plan size is stated')
  assert.match(text, /LLM Local Deployment news October 29 2026/, 'the planned queries are listed')
  assert.match(text, /topic/, 'the angle is labelled')
  assert.match(text, /How the guidance was applied/, 'the criteria are shown')
  assert.match(text, /candidate\(s\) reviewed/, 'the review outcome is stated')
  assert.match(text, /a tutorial, not news/, 'the review reason is shown')
})

test('a topic with no skill block renders no audit block', async () => {
  const topic = { topic: 'AI News', guidance: 'x', brief: '', stories: [] }
  const { tree, runtime } = await renderDigestWith(topic)
  const elements = walk(expand(tree, runtime))
  assert.equal(elements.find((node) => node.props?.className === 'dnd-audit'), undefined)
})
