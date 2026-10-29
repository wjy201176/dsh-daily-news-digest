/**
 * Render one stored digest as a standalone HTML document.
 *
 * This is the page an Edge window opens for a timeline row. It is built from the
 * *stored* digest, not from a fresh search: reopening yesterday's row must show
 * yesterday's news, and must still work when no search provider is reachable.
 *
 * Everything is inlined — no external stylesheet, script, or font — because the
 * window is a throwaway browser profile with no network identity of its own.
 */

/** Escape text for HTML text and attribute positions. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Chrome labels. The digest body itself is already in the user's language. */
const LABELS = {
  en: {
    docTitle: 'Daily News Digest',
    generated: 'Generated',
    day: 'Covers',
    model: 'Summarized by {model}',
    perTopic: 'Top {n} per topic',
    topicsWord: 'topics',
    storiesWord: 'stories',
    searched: 'Searched',
    readsMeasured: '{n} reads (measured)',
    readsEstimated: '~{n} reads (estimated)',
    sources: '{n} sources',
    undated: 'date unknown',
    otherLinks: 'Other sources',
    noStories: 'No news was found for this topic.',
    fallback: 'No model summary was produced; the stories are listed as collected.',
    partial: 'Some topics were skipped when the run hit its time limit.',
    stored: 'Stored copy — this is the digest from that run, not a new search.',
    unconfirmed: 'relevance unconfirmed',
    filtered: 'Filtered out {n} unrelated result(s) by relevance.',
    evergreen: 'Skipped {n} on-topic page(s) that were not news.',
    guidance: 'Search guidance:',
    plan: 'Search plan ({n} queries)',
    criteria: 'How the guidance was applied:',
    reviewed: '{n} candidate(s) reviewed, {dropped} removed',
    reviewReasons: 'Removed because:',
    viaFallback: '{n} found by the wider fallback search',
  },
  zh: {
    docTitle: '每日新闻摘要',
    generated: '生成于',
    day: '覆盖日期',
    model: '由 {model} 汇总',
    perTopic: '每个主题取前 {n} 条',
    topicsWord: '个主题',
    storiesWord: '条新闻',
    searched: '检索来源',
    readsMeasured: '{n} 次阅读（实测）',
    readsEstimated: '约 {n} 次阅读（估算）',
    sources: '{n} 个来源',
    undated: '日期未知',
    otherLinks: '其他来源',
    noStories: '今天没有检索到这个主题的新闻。',
    fallback: '未使用模型汇总，以下为检索到的原始条目。',
    partial: '部分主题因时间限制未完成。',
    stored: '这是当时保存的摘要，不是重新检索的结果。',
    unconfirmed: '相关性待确认',
    filtered: '已按相关性过滤掉 {n} 条无关结果。',
    evergreen: '另有 {n} 条与主题相关但不是新闻，已略过。',
    guidance: '检索指引：',
    plan: '检索计划（{n} 条查询）',
    criteria: '指引的应用方式：',
    reviewed: '已复核 {n} 条候选，移除 {dropped} 条',
    reviewReasons: '移除原因：',
    viaFallback: '其中 {n} 条来自更宽的备用检索',
  },
}

/**
 * Pick a label table for a language tag.
 * @param {string} lang - e.g. `zh-CN`, `en-US`.
 * @returns {object} the label table.
 */
export function reportLabels(lang) {
  const tag = String(lang ?? '').toLowerCase()
  return tag.startsWith('zh') ? LABELS.zh : LABELS.en
}

/** Fill `{name}` placeholders. */
function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match))
}

/** A date as the user reads it, or empty when it does not parse. */
function readableDate(value) {
  if (value === null || value === undefined || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}

const CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:32px 40px 64px;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;color:#1b1d21;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6e8ec;background:#17181b}a{color:#7fb2ff}.meta{color:#9aa0a8}.chip{border-color:#33363c;color:#b6bcc6}.story{background:#1d1f23;border-color:#2a2d33}}
.wrap{max-width:920px;margin:0 auto}
h1{margin:0 0 4px;font-size:24px;letter-spacing:-.01em}
.sub{margin:0 0 20px;font-size:13px}
.meta{font-size:12px;color:#6b7280}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 0}
.chip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid #e3e5e9;color:#4b5563;white-space:nowrap}
.chip[data-fresh="true"]{border-color:#2563eb;color:#1d4ed8}
.chip-warn{border-color:#d97706;color:#b45309}
.topic{margin:34px 0 0;padding-top:20px;border-top:1px solid #eceef2}
.topic h2{margin:0 0 6px;font-size:18px}
.brief{margin:0 0 16px;color:#374151}
.guidance{margin:0 0 12px;padding:8px 12px;border-left:3px solid #6366f1;background:#eef2ff;color:#3730a3;font-size:13px;white-space:pre-wrap}
.guidance-label{font-weight:600}
.audit{margin:0 0 12px;font-size:12px;color:#4b5563}
.audit summary{cursor:pointer;color:#4f46e5}
.audit ul{margin:6px 0;padding-left:18px}
.audit code{background:#f1f3f6;border-radius:4px;padding:1px 4px;font-size:11px}
ol.stories{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px}
.story{display:flex;gap:12px;padding:12px 14px;border:1px solid #eceef2;border-radius:10px}
.rank{flex:none;width:24px;height:24px;border-radius:6px;background:#f1f3f6;color:#4b5563;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-top:2px}
.body{min-width:0;flex:1}
.title{font-weight:600;text-decoration:none;color:inherit}
.title:hover{text-decoration:underline}
.line{margin:4px 0 0;color:#4b5563;font-size:14px}
.url{margin:3px 0 0;font-size:12px;word-break:break-all}
.url a{color:#4f46e5;text-decoration:none}
details{margin-top:8px;font-size:12px;color:#6b7280}
summary{cursor:pointer}
details ul{margin:6px 0 0;padding-left:18px}
.note{margin:14px 0 0;padding:10px 12px;border-radius:8px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:13px}
`

/**
 * Build the standalone document for one stored digest.
 * @param {object} digest - a stored digest document.
 * @param {object} [options] - `{ lang }`.
 * @returns {string} the HTML.
 */
export function buildReport(digest, options = {}) {
  const labels = reportLabels(options.lang)
  const topics = Array.isArray(digest?.topics) ? digest.topics : []
  const sources = Array.isArray(digest?.sources) ? digest.sources : []
  const storyCount = topics.reduce((total, topic) => total + (Array.isArray(topic?.stories) ? topic.stories.length : 0), 0)

  const head = [
    `<h1>${escapeHtml(labels.docTitle)}</h1>`,
    `<p class="sub meta">${escapeHtml(labels.stored)}</p>`,
    '<div class="meta">',
    `${escapeHtml(labels.generated)} ${escapeHtml(readableDate(digest?.createdAt))}`,
    digest?.day !== undefined && digest.day !== '' ? ` · ${escapeHtml(labels.day)} ${escapeHtml(digest.day)}` : '',
    ` · ${topics.length} ${escapeHtml(labels.topicsWord)} · ${storyCount} ${escapeHtml(labels.storiesWord)}`,
    Number.isFinite(digest?.top) ? ` · ${escapeHtml(fill(labels.perTopic, { n: digest.top }))}` : '',
    '</div>',
    digest?.model !== undefined && digest.model !== '' ? `<div class="meta">${escapeHtml(fill(labels.model, { model: digest.model }))}</div>` : '',
    sources.length > 0
      ? `<div class="meta">${escapeHtml(labels.searched)}: ${escapeHtml(sources.map((source) => source?.label ?? '').filter((label) => label !== '').join(', '))}</div>`
      : '',
    digest?.partial === true ? `<p class="note">${escapeHtml(labels.partial)}</p>` : '',
    digest?.summarized === false ? `<p class="note">${escapeHtml(labels.fallback)}</p>` : '',
    digest?.notes?.cookies !== undefined ? `<p class="note">${escapeHtml(digest.notes.cookies)}</p>` : '',
    digest?.notes?.walls !== undefined ? `<p class="note">${escapeHtml(digest.notes.walls)}</p>` : '',
    Array.isArray(digest?.filtered) && digest.filtered.some((row) => (row?.dropped ?? 0) > 0)
      ? `<p class="meta">${escapeHtml(fill(labels.filtered, { n: digest.filtered.reduce((total, row) => total + (row?.dropped ?? 0), 0) }))}</p>`
      : '',
    Array.isArray(digest?.filtered) && digest.filtered.some((row) => (row?.evergreen ?? 0) > 0)
      ? `<p class="meta">${escapeHtml(fill(labels.evergreen, { n: digest.filtered.reduce((total, row) => total + (row?.evergreen ?? 0), 0) }))}</p>`
      : '',
  ].join('')

  const body = topics
    .map((topic) => {
      const stories = Array.isArray(topic?.stories) ? topic.stories : []
      const items = stories
        .map((story, index) => {
          const date = story?.publishedAt !== null && story?.publishedAt !== undefined
            ? readableDate(story.publishedAt)
            : ''
          const chips = [
            `<span class="chip" data-fresh="${story?.sameDay === true ? 'true' : 'false'}">${escapeHtml(date !== '' ? date : labels.undated)}</span>`,
            `<span class="chip">${escapeHtml(fill(labels.sources, { n: story?.sourceCount ?? 0 }))}</span>`,
            // A story the relevance screen could not confirm is marked, so the
            // stored copy never presents an unverified hit as certain.
            story?.relevance?.decision === 'grey' ? `<span class="chip chip-warn">${escapeHtml(labels.unconfirmed)}</span>` : '',
            Number.isFinite(story?.reads)
              ? `<span class="chip">${escapeHtml(fill(story.measured === true ? labels.readsMeasured : labels.readsEstimated, { n: story.reads }))}</span>`
              : '',
            ...(Array.isArray(story?.sources) ? [...new Set(story.sources)] : [])
              .slice(0, 8)
              .map((name) => `<span class="chip">${escapeHtml(name)}</span>`),
          ].join('')

          const others = Array.isArray(story?.links) && story.links.length > 1
            ? `<details><summary>${escapeHtml(labels.otherLinks)} (${story.links.length})</summary><ul>${story.links
                .slice(1)
                .map((link) => `<li><a href="${escapeHtml(link?.url ?? '')}" target="_blank" rel="noreferrer noopener">${escapeHtml(link?.title !== '' && link?.title !== undefined ? link.title : link?.url ?? '')}</a>${link?.source !== undefined && link.source !== '' ? ` — ${escapeHtml(link.source)}` : ''}</li>`)
                .join('')}</ul></details>`
            : ''

          // The URL is printed under the headline as well as linked. In the browser
          // window the link alone is enough, but this same HTML is printed to the
          // PDF that gets emailed, and a printed or forwarded PDF loses the click
          // target — the reader would have no way to reach the article.
          const shownUrl = String(story?.url ?? '')
          const urlLine = shownUrl !== '' && shownUrl !== String(story?.title ?? '')
            ? `<p class="url"><a href="${escapeHtml(shownUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(shownUrl)}</a></p>`
            : ''

          return `<li class="story"><span class="rank">${index + 1}</span><div class="body"><a class="title" href="${escapeHtml(story?.url ?? '')}" target="_blank" rel="noreferrer noopener">${escapeHtml(story?.title !== '' && story?.title !== undefined ? story.title : story?.url ?? '')}</a>${
            story?.line !== undefined && story.line !== '' ? `<p class="line">${escapeHtml(story.line)}</p>` : ''
          }${urlLine}<div class="chips">${chips}</div>${others}</div></li>`
        })
        .join('')

      // The guidance the run was given is shown with the topic: a stored digest
      // must say what the search was told, or a reader cannot tell why this
      // topic returned these stories and not others.
      const guidance = typeof topic?.guidance === 'string' && topic.guidance.trim() !== ''
        ? `<p class="guidance"><span class="guidance-label">${escapeHtml(labels.guidance)}</span> ${escapeHtml(topic.guidance)}</p>`
        : ''

      // How the guidance was applied: the plan it produced, the criteria the
      // review used, and what that review removed. A reader who wrote a detailed
      // brief should be able to audit the result instead of trusting it.
      const skill = topic?.skill
      const planned = Array.isArray(skill?.queries) ? skill.queries.length : 0
      const criteria = Array.isArray(skill?.criteria) ? skill.criteria : []
      const plan = Array.isArray(skill?.queries) ? skill.queries : []
      const reviewLine = Number.isFinite(skill?.reviewed) && skill.reviewed > 0
        ? fill(labels.reviewed, { n: skill.reviewed, dropped: skill.reviewDropped ?? 0 })
        : ''
      const fallbackLine = Number.isFinite(skill?.usedFallback) && skill.usedFallback > 0
        ? fill(labels.viaFallback, { n: skill.usedFallback })
        : ''
      const audit = planned > 0
        ? `<details class="audit"><summary>${escapeHtml(fill(labels.plan, { n: planned }))}</summary><ul>${
            plan.map((entry) => `<li><code>${escapeHtml(String(entry?.angle ?? ''))}</code> ${escapeHtml(String(entry?.query ?? ''))}</li>`).join('')
          }</ul>${
            criteria.length > 0
              ? `<p class="meta">${escapeHtml(labels.criteria)}</p><ul>${criteria.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
              : ''
          }${
            Array.isArray(skill?.reviewReasons) && skill.reviewReasons.length > 0
              ? `<p class="meta">${escapeHtml(labels.reviewReasons)}</p><ul>${skill.reviewReasons.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
              : ''
          }</details>`
        : ''
      const auditMeta = [reviewLine, fallbackLine].filter((line) => line !== '').length > 0
        ? `<p class="meta">${[reviewLine, fallbackLine].filter((line) => line !== '').map(escapeHtml).join(' · ')}</p>`
        : ''

      return `<section class="topic"><h2>${escapeHtml(topic?.topic ?? '')}</h2>${guidance}${auditMeta}${audit}${
        topic?.brief !== undefined && topic.brief !== '' ? `<p class="brief">${escapeHtml(topic.brief)}</p>` : ''
      }${stories.length === 0 ? `<p class="meta">${escapeHtml(labels.noStories)}</p>` : `<ol class="stories">${items}</ol>`}</section>`
    })
    .join('')

  return `<!doctype html>
<html lang="${escapeHtml(reportLabels(options.lang) === LABELS.zh ? 'zh-CN' : 'en')}">
<meta charset="utf-8">
<title>${escapeHtml(`${labels.docTitle} — ${digest?.day ?? ''}`)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style>
<body><div class="wrap">${head}${body}</div></body>
</html>`
}
