/**
 * A smoke test for the Client half: evaluate client.js the way the module
 * loader does, then run its factory and `apply`, recording what it registers.
 *
 * This does not render the page — it answers the narrower question the Client
 * contract makes checkable without a browser: does the bundle parse, does the
 * factory return a plugin body, and does `apply` register the sidebar row and
 * the main panel under the same id.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** A React stand-in: the components only build elements, never render here. */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
  }
}

const registrations = []
const effects = []
const dictionaries = []

const fakeSlots = {
  inject(owner, callback) {
    effects.push(owner)
    return callback()
  },
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
}

const fakeLocale = {
  register(namespace, dicts) {
    dictionaries.push({ namespace, dicts })
    return () => {}
  },
  bind(namespace) {
    return (key) => {
      const dictionary = dictionaries.find((entry) => entry.namespace === namespace)
      const table = dictionary?.dicts.en ?? {}
      return Object.hasOwn(table, key) ? table[key] : key
    }
  },
}

const pluginContext = {
  slots: fakeSlots,
  locale: fakeLocale,
  effect(fn) {
    effects.push(fn())
    return () => {}
  },
  inject(names, callback) {
    callback({})
    return () => {}
  },
}

let factory = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(record) {
        factory = record.factory
      },
    },
  },
  console,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.equal(typeof factory, 'function', 'client.js must register a factory with the module loader')

const body = factory((request) => {
  if (request === 'react') return fakeReact()
  throw new Error(`unexpected module request: ${request}`)
})

assert.equal(typeof body?.apply, 'function', 'the factory must return a plugin body with apply()')
assert.ok(Array.isArray(body.inject), 'the body must declare its injected services')

body.apply(pluginContext)

const row = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
const panel = registrations.find((entry) => entry.options.name === 'main')

assert.ok(row !== undefined, 'a sidebar.panellist row must be registered')
assert.ok(panel !== undefined, 'a main panel must be registered')
assert.equal(row.options.id, panel.options.key, 'the row id must address the main panel key')
assert.equal(row.options.id, 'daily-news-digest')
assert.equal(typeof row.options.label, 'function', 'the row label must be locale-aware')
assert.equal(row.options.label(), 'Daily News Digest')
assert.ok(row.options.order < 1, 'the row must sort above the market row (order 1) and below Plugins (0)')
assert.equal(typeof row.component, 'function', 'the row registers an icon component')
assert.equal(typeof panel.component, 'function', 'the panel registers a page component')

// The bug this pins: a third registration was added under a made-up slot name so a
// test could render one topic block. The Host does not know that slot, so the
// plugin failed at startup and the app crashed on restart. A slot the Host does
// not define is never a test detail — it is a startup failure. Only the two slots
// the plugin genuinely owns may be registered.
const registeredSlots = registrations.map((entry) => entry.options.name).sort()
assert.deepEqual(
  registeredSlots,
  ['main', 'sidebar.panellist'],
  `only the plugin's own slots may be registered, got ${JSON.stringify(registeredSlots)}`,
)
assert.equal(
  registrations.length,
  2,
  'exactly two registrations are allowed: the sidebar row and the main panel',
)

// Both dictionaries must carry every key the page asks for, or a user in that
// locale sees a raw key instead of text.
const en = dictionaries[0]?.dicts.en ?? {}
const zh = dictionaries[0]?.dicts.zh ?? {}
assert.ok(Object.keys(en).length > 30, 'the English dictionary must be substantial')
assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'both locales must define the same keys')
for (const required of ['panel', 'topicsTitle', 'sourcesTitle', 'top', 'summarize']) {
  assert.ok(Object.hasOwn(en, required), `the English dictionary must define "${required}"`)
}
assert.equal(en.topicsTitle, 'Topics Interested')
assert.equal(en.sourcesTitle, 'Sources Specified')
assert.equal(en.top, 'Top')
assert.equal(en.summarize, 'Summarize')
assert.equal(en.panel, 'Daily News Digest')

// `meta.title` / `meta.description` are read from the exported locale JSON files
// without activating the plugin, so they live there, not in the runtime table.
const metaEn = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
const metaZh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
assert.equal(metaEn.meta.title, 'Daily News Digest')
assert.equal(metaZh.meta.title, '每日新闻摘要')
assert.ok(metaEn.meta.description.length > 40, 'the description must say what the plugin does')
assert.ok(metaZh.meta.description.length > 10)
assert.deepEqual(Object.keys(metaEn).sort(), Object.keys(metaZh).sort(), 'both locale files must define the same keys')
assert.deepEqual(
  Object.keys(metaEn).filter((key) => key !== 'meta').sort(),
  Object.keys(en).sort(),
  'the locale file must mirror the runtime dictionary',
)

// The frame's center column is `display:flex; overflow:hidden`, so it clips its
// occupant instead of scrolling it. A main panel that does not scroll itself is
// cut off at the viewport — the exact bug this asserts against.
const css = source.slice(source.indexOf('const CSS = `'), source.indexOf('`\n\n    let cssInstalled'))
assert.ok(css.includes('.dnd-page{'), 'the page class must be declared')
const pageRule = /\.dnd-page\{([^}]*)\}/.exec(css)
assert.ok(pageRule !== null, 'the page rule must be a single block')
const page = pageRule[1]
assert.match(page, /overflow:auto/, 'the page must scroll itself: the frame clips its occupant')
assert.match(page, /height:100%/, 'the page must fill the column so overflow has a height to scroll')
assert.match(page, /min-height:0/, 'the page must be allowed to shrink inside the flex column')
assert.match(page, /box-sizing:border-box/, 'the padding must not add to the 100% height')
assert.match(page, /display:flex/, 'the page keeps the column layout')

// The controls must stay reachable while the digest scrolls under them.
const controlsRule = /\.dnd-controls\{([^}]*)\}/.exec(css)
assert.ok(controlsRule !== null, 'the controls rule must exist')
assert.match(controlsRule[1], /position:sticky/, 'the Summarize controls must stay reachable while scrolling')

// The page must not pin a max-height that would re-introduce clipping.
assert.doesNotMatch(page, /max-height/, 'the page must not cap its own height')

console.log('client bundle: factory registered, slots registered, dictionaries complete, page scrolls')
