/**
 * Daily News Digest — Client half.
 *
 * Adds the "Daily News Digest" row to the left sidebar (below Plugins) and the
 * page it selects: two editors — the topics the user follows and the sources to
 * search — then a `Top` control and a `Summarize` button, and below them the
 * digest itself, one section per topic.
 *
 * The page owns no search logic. It saves the editor, asks the Host to run, and
 * polls the run; everything that needs the network or a model happens Host-side.
 */

window.__ModuleLoader__.load({
  id: 'dsh-daily-news-digest',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dailyNewsDigest'
    const PANEL_ID = 'daily-news-digest'

    const zh = {
      panel: '每日新闻摘要',
      title: '每日新闻摘要',
      intro: '设置你关注的主题，以及要检索的来源。点击「摘要」后，按主题汇总今日要闻。',
      topicsTitle: '关注的主题',
      topicsHint: '一行一个主题，例如「AI 新闻」「具身智能」「LLM 本地部署」。点 + 可为该主题补充检索指引。',
      topicsPlaceholder: '输入一个主题',
      guidancePlaceholder: '检索指引（可选）：想看什么、不要什么。例如「只关注开源推理引擎 vLLM、llama.cpp，不要教程和百科」',
      guidanceOpen: '为该主题添加检索指引',
      guidanceClose: '收起检索指引',
      guidanceLabel: '检索指引：',
      auditTitle: '检索计划与复核（{n} 条查询）',
      auditReviewed: '已复核 {n} 条候选，移除 {dropped} 条',
      auditFallback: '其中 {n} 条来自更宽的备用检索',
      auditExcluded: '指引直接排除 {n} 条',
      auditCriteria: '指引的应用方式：',
      auditReasons: '移除原因：',
      addTopic: '添加主题',
      sourcesTitle: '指定的来源',
      sourcesHint: '一行一个来源，可以是网站（CNN.com）、公司或个人博客（QbitAI）、论坛（reddit、知乎）或新闻数据源（OpenBB）。',
      sourcesPlaceholder: '输入一个来源',
      addSource: '添加来源',
      top: 'Top',
      topHint: '每个主题保留的新闻条数',
      summarize: '摘要',
      summarizing: '正在检索并汇总…',
      running: '已检索 {done}/{total} 个主题',
      noTopics: '请先填写至少一个主题。',
      saved: '已保存',
      saving: '保存中…',
      saveFailed: '保存失败：{e}',
      busy: '已有一轮摘要正在进行。',
      runFailed: '摘要失败：{e}',
      perTopic: '每个主题取前 {n} 条',
      sourcesCount: '{n} 个来源',
      storySources: '{n} 个来源报道',
      undated: '日期未知',
      reads: '{n} 次阅读',
      readsEstimated: '约 {n} 次阅读（按检索位置估算）',
      readsMeasured: '{n} 次阅读（实测）',
      measuredNote: '阅读量来自各站点的公开计数（点赞、points、评论等）；没有公开计数的来源按检索位置估算。',
      cookiesNote: '登录凭证：{note}',
      wallNote: '部分需要登录的来源未能读取：{e}',
      searchFailedNote: '检索失败 {n}/{of} 次，因此结果可能为空：{e}',
      searchAllFailed: '全部 {of} 次检索都失败了，因此没有任何结果。这是检索服务的问题，不是今天没有新闻。原因：{e}',
      cookiesOk: '已使用 Edge 中的登录状态（{n} 条 Cookie）',
      cookiesSaved: '已使用先前保存的 Edge 登录状态（{n} 条 Cookie，{age} 分钟前读取）',
      cookiesLocked: 'Edge 正在运行，Cookie 数据库被占用，且尚无已保存的副本。请在 Edge 关闭时运行一次「摘要」，之后即可在 Edge 运行时继续使用登录状态。',
      cookiesMissing: '未找到可用的 Edge 登录状态：{e}',
      historyTitle: '历史记录',
      historyOpen: '在 Edge 窗口中打开这一条摘要',
      historyWindow: '在 Edge 中打开',
      opening: '正在打开…',
      openFailed: '无法打开窗口：{e}',
      edgeMissing: '未找到 Microsoft Edge，无法打开窗口。',
      windowOpened: '已在 Edge 窗口中打开',
      historyDelete: '从历史记录中删除',
      historyFailed: '历史记录操作失败：{e}',
      filteredNote: '已按相关性过滤掉 {n} 条无关结果（{list}）。',
      evergreenNote: '另有 {n} 条与主题相关但不是新闻（教程、百科、首页），已略过。',
      unconfirmed: '相关性待确认',
      storiesWord: '条新闻',
      noStories: '今天没有检索到这个主题的新闻。',
      partial: '部分主题因时间限制未完成。',
      model: '由 {model} 汇总',
      fallback: '未使用模型汇总，以下为检索到的原始条目。',
      searchSources: '检索来源：{list}',
      open: '打开',
      moreLinks: '其他来源',
      remove: '删除这一行',
      digestAt: '生成于 {time}',
      topicsWord: '个主题',
      sourcesWord: '个来源',
    }

    const en = {
      panel: 'Daily News Digest',
      title: 'Daily News Digest',
      intro: 'Set the topics you follow and the sources to search. Summarize turns them into today’s digest, one section per topic.',
      topicsTitle: 'Topics Interested',
      topicsHint: 'One topic per row, for example “AI News”, “Embodied AI”, “LLM Local Deployment”. Press + to add search guidance for a topic.',
      topicsPlaceholder: 'Type a topic',
      guidancePlaceholder: 'Search guidance (optional): what you want and what to skip. For example “only open-source inference engines vLLM and llama.cpp, no tutorials or encyclopaedia entries”.',
      guidanceOpen: 'Add search guidance for this topic',
      guidanceClose: 'Hide search guidance',
      guidanceLabel: 'Search guidance:',
      auditTitle: 'Search plan and review ({n} queries)',
      auditReviewed: '{n} candidate(s) reviewed, {dropped} removed',
      auditFallback: '{n} found by the wider fallback search',
      auditExcluded: '{n} excluded by the guidance',
      auditCriteria: 'How the guidance was applied:',
      auditReasons: 'Removed because:',
      addTopic: 'Add topic',
      sourcesTitle: 'Sources Specified',
      sourcesHint: 'One source per row: a website (CNN.com), a company or personal blog (QbitAI), a forum (reddit, Zhihu) or a news-data provider (OpenBB).',
      sourcesPlaceholder: 'Type a source',
      addSource: 'Add source',
      top: 'Top',
      topHint: 'How many stories to keep per topic',
      summarize: 'Summarize',
      summarizing: 'Searching and summarizing…',
      running: 'Searched {done} of {total} topics',
      noTopics: 'Add at least one topic first.',
      saved: 'Saved',
      saving: 'Saving…',
      saveFailed: 'Could not save: {e}',
      busy: 'A digest is already running.',
      runFailed: 'The digest failed: {e}',
      perTopic: 'Top {n} per topic',
      sourcesCount: '{n} sources',
      storySources: '{n} sources',
      undated: 'date unknown',
      reads: '{n} reads',
      readsEstimated: '~{n} reads (estimated from result position)',
      readsMeasured: '{n} reads (measured)',
      measuredNote: 'Reads come from the public counts each site exposes (upvotes, points, comments). A source with no public count contributes an estimate based on where it was found.',
      cookiesNote: 'Sign-in credentials: {note}',
      wallNote: 'Some sources that need a sign-in could not be read: {e}',
      searchFailedNote: '{n} of {of} searches failed, so this result may be empty: {e}',
      searchAllFailed: 'All {of} searches failed, so there are no results. This is a search service problem, not a quiet news day. Reason: {e}',
      cookiesOk: 'Using your Edge sign-ins ({n} cookies)',
      cookiesSaved: 'Using your saved Edge sign-ins ({n} cookies, read {age} min ago)',
      cookiesLocked: 'Edge is running, so its cookie database is locked, and no saved copy exists yet. Run Summarize once while Edge is closed to save your sign-ins; after that they keep working while Edge is open.',
      cookiesMissing: 'No usable Edge sign-ins were found: {e}',
      historyTitle: 'History',
      historyOpen: 'Open this digest in an Edge window',
      historyWindow: 'Open in Edge',
      opening: 'Opening…',
      openFailed: 'Could not open the window: {e}',
      edgeMissing: 'Microsoft Edge was not found, so the window cannot be opened.',
      windowOpened: 'Opened in an Edge window',
      historyDelete: 'Remove from history',
      historyFailed: 'History action failed: {e}',
      filteredNote: 'Filtered out {n} unrelated result(s) by relevance ({list}).',
      evergreenNote: 'Skipped {n} on-topic page(s) that were not news (tutorials, encyclopaedia entries, home pages).',
      unconfirmed: 'relevance unconfirmed',
      storiesWord: 'stories',
      noStories: 'No news found for this topic today.',
      partial: 'Some topics were skipped when the run hit its time limit.',
      model: 'Summarized by {model}',
      fallback: 'No model summary was produced; the collected stories are listed as found.',
      searchSources: 'Searched: {list}',
      open: 'Open',
      moreLinks: 'Other sources',
      remove: 'Remove this row',
      digestAt: 'Generated {time}',
      topicsWord: 'topics',
      sourcesWord: 'sources',
    }

    const CSS = `
.dnd-page{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;align-items:center;gap:18px;padding:0 clamp(20px,4vw,48px) 48px;overflow:auto;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dnd-page>*{width:100%;max-width:1080px;flex:none}
.dnd-head{display:flex;flex-direction:column;gap:4px;padding-top:28px}
[data-platform=darwin] .dnd-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dnd-head h1{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dnd-head p{margin:0;color:var(--dsw-alias-label-secondary)}
.dnd-editors{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.dnd-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-base);min-width:0}
.dnd-card h2{margin:0;font-size:13px;font-weight:600;letter-spacing:.01em}
.dnd-card .dnd-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dnd-rows{display:flex;flex-direction:column;gap:6px}
.dnd-row{display:flex;align-items:center;gap:6px}
.dnd-row input{flex:1;min-width:0;font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dnd-row input:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.dnd-remove{flex:none;width:26px;height:26px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:15px;line-height:1}
.dnd-remove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dnd-add{align-self:flex-start;font:inherit;font-size:12px;padding:4px 10px;border-radius:7px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dnd-add:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dnd-topic-rows{gap:10px}
.dnd-topic-row{display:flex;flex-direction:column;gap:6px}
.dnd-guidance-toggle{flex:none;width:26px;height:26px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1}
.dnd-guidance-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dnd-guidance-set{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dnd-guidance{width:100%;box-sizing:border-box;resize:vertical;font:inherit;font-size:12px;line-height:1.5;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dnd-guidance:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.dnd-controls{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l2)}
.dnd-btn{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}
.dnd-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dnd-btn[data-kind="primary"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand,#fff)}
.dnd-btn:disabled{opacity:.55;cursor:default}
.dnd-top{display:inline-flex;align-items:center;gap:8px}
.dnd-top input{width:64px;font:inherit;text-align:center;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dnd-status{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dnd-error{color:var(--dsw-alias-label-error,#f0616d)}
.dnd-spacer{flex:1}
.dnd-history{display:flex;flex-direction:column;gap:8px}
.dnd-history h2{margin:0;font-size:13px;font-weight:600}
/* Up to 50 runs are kept, so the list scrolls instead of pushing the digest
   off the page: the results must stay reachable however long the history is. */
.dnd-timeline{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;position:relative;max-height:260px;overflow-y:auto}
.dnd-timeline-item{position:relative;display:flex;align-items:center;gap:8px;padding:0 0 0 18px;min-height:38px}
.dnd-timeline-item:before{content:"";position:absolute;left:5px;top:0;bottom:0;width:1px;background:var(--dsw-alias-border-l2)}
.dnd-timeline-item:first-child:before{top:50%}
.dnd-timeline-item:last-child:before{bottom:50%}
.dnd-timeline-dot{position:absolute;left:2px;top:50%;transform:translateY(-50%);width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));z-index:1}
.dnd-timeline-item[data-active="true"] .dnd-timeline-dot{background:var(--dsw-alias-brand-primary)}
.dnd-timeline-open{flex:1;min-width:0;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;text-align:left;font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.dnd-timeline-open:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dnd-timeline-item[data-active="true"] .dnd-timeline-open{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover)}
.dnd-timeline-when{color:var(--dsw-alias-label-primary);font-weight:500}
.dnd-timeline-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dnd-timeline-topics{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dnd-timeline-action{color:var(--dsw-alias-brand-primary);font-size:11px;white-space:nowrap;opacity:.85}
.dnd-timeline-open:hover .dnd-timeline-action{opacity:1;text-decoration:underline}
.dnd-timeline-open:disabled{opacity:.6;cursor:default}
.dnd-timeline-delete{flex:none;width:24px;height:24px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1}
.dnd-timeline-delete:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-error,#f0616d)}
.dnd-timeline-delete:disabled{opacity:.5;cursor:default}
.dnd-digest{display:flex;flex-direction:column;gap:22px;margin-top:6px}
.dnd-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dnd-topic{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}
.dnd-topic h3{margin:0;font-size:15px;font-weight:600}
.dnd-brief{margin:0;color:var(--dsw-alias-label-secondary)}
.dnd-audit{margin:0 0 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dnd-audit summary{cursor:pointer;color:var(--dsw-alias-state-business-primary)}
.dnd-audit-list{margin:4px 0 8px;padding-left:18px;line-height:1.5}
.dnd-audit-angle{background:var(--dsw-alias-interactive-bg-hover);border-radius:4px;padding:0 4px;font-size:11px}
.dnd-topic-guidance{margin:0 0 6px;padding:6px 10px;border-left:3px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover);border-radius:0 6px 6px 0;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap}
.dnd-stories{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none}
.dnd-story{display:flex;gap:10px;align-items:flex-start}
.dnd-rank{flex:none;width:22px;height:22px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;margin-top:2px}
.dnd-story-body{min-width:0;display:flex;flex-direction:column;gap:3px}
.dnd-story-title{font-weight:500;color:var(--dsw-alias-label-primary);text-decoration:none}
.dnd-story-title:hover{text-decoration:underline}
.dnd-story-line{margin:0;color:var(--dsw-alias-label-secondary)}
.dnd-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}
.dnd-chip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dnd-chip[data-tone="fresh"]{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.dnd-chip[data-tone="warn"]{border-color:var(--dsw-alias-label-warning,#d97706);color:var(--dsw-alias-label-warning,#b45309)}
`

    let cssInstalled = false
    function ensureCss() {
      if (cssInstalled || typeof document === 'undefined') return
      cssInstalled = true
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-daily-news-digest'
      tag.dataset.pluginCss = 'dsh-daily-news-digest/page.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Resolve one of this plugin's Host routes against the page base. */
    function apiUrl(path) {
      const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'
      return new URL(`daily-news-digest/api/${path}`.replace(/^\/+/, ''), base).href
    }

    async function callApi(path, init) {
      const response = await fetch(apiUrl(path), { cache: 'no-store', ...init })
      const payload = await response.json().catch(() => ({ ok: false, error: 'invalid response' }))
      return payload
    }

    function DigestIcon({ size }) {
      return h(
        'svg',
        {
          width: size ?? 16,
          height: size ?? 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 5.5h13a2 2 0 0 1 2 2V19a1.5 1.5 0 0 0 1.5 1.5H6A2 2 0 0 1 4 18.5z' }),
        h('path', { d: 'M19 8.5h1.5A1.5 1.5 0 0 1 22 10v8.5' }),
        h('path', { d: 'M7 9h8M7 12.5h8M7 16h5' }),
      )
    }

    /** A list editor: one input per row, plus add/remove. */
    function RowEditor({ rows, onChange, placeholder, addLabel, removeLabel, t }) {
      const inputRefs = React.useRef([])

      const update = (index, value) => {
        const next = rows.slice()
        next[index] = value
        // Typing in the last row appends an empty row, so there is always a place
        // to type the next item without hunting for a button.
        if (index === next.length - 1 && String(value).trim() !== '') next.push('')
        onChange(next)
      }

      const remove = (index) => {
        const next = rows.slice()
        next.splice(index, 1)
        if (next.length === 0) next.push('')
        onChange(next)
        // Keep the caret in the list instead of dropping focus to the document.
        const target = inputRefs.current[Math.max(0, index - 1)]
        if (target !== undefined && typeof target.focus === 'function') target.focus()
      }

      const add = () => {
        const next = rows.slice()
        if (next.length === 0 || next[next.length - 1].trim() !== '') next.push('')
        onChange(next)
        const index = next.length - 1
        setTimeout(() => {
          const target = inputRefs.current[index]
          if (target !== undefined && typeof target.focus === 'function') target.focus()
        }, 0)
      }

      return h(
        'div',
        { className: 'dnd-rows' },
        rows.map((row, index) =>
          h(
            'div',
            { className: 'dnd-row', key: index },
            h('input', {
              ref: (node) => {
                inputRefs.current[index] = node
              },
              value: row,
              placeholder,
              'aria-label': placeholder,
              onChange: (event) => update(index, event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  add()
                }
              },
            }),
            rows.length > 1 || String(row).trim() !== ''
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dnd-remove',
                    title: removeLabel,
                    'aria-label': removeLabel,
                    onClick: () => remove(index),
                  },
                  '×',
                )
              : null,
          ),
        ),
        h('button', { type: 'button', className: 'dnd-add', onClick: add }, `+ ${addLabel}`),
      )
    }

    /**
     * A topic editor: one row per topic, each with an optional guidance box.
     *
     * The guidance box is collapsed until the user writes something or opens it,
     * because most topics do not need one — but a topic that *does* need one is
     * exactly the vague topic this feature exists for. The box opens itself when
     * the row already carries guidance, so a saved instruction is never hidden.
     */
    function TopicEditor({ rows, onChange, placeholder, guidancePlaceholder, addLabel, removeLabel, openLabel, closeLabel, t }) {
      const inputRefs = React.useRef([])
      const [open, setOpen] = React.useState(() => rows.map((row) => String(row?.guidance ?? '').trim() !== ''))

      // A row added later starts collapsed; a row that already has guidance (from
      // disk) opens. The two lists can differ in length mid-render, so the flag is
      // read defensively.
      const isOpen = (index) => open[index] === true || String(rows[index]?.guidance ?? '').trim() !== ''

      const update = (index, patch) => {
        const next = rows.slice()
        next[index] = { topic: String(next[index]?.topic ?? ''), guidance: String(next[index]?.guidance ?? ''), ...patch }
        // Typing in the last row appends an empty row, so there is always a place
        // to type the next topic without hunting for a button.
        const last = next.length - 1
        if (index === last && (next[last].topic.trim() !== '' || next[last].guidance.trim() !== '')) {
          next.push({ topic: '', guidance: '' })
        }
        onChange(next)
      }

      const remove = (index) => {
        const next = rows.slice()
        next.splice(index, 1)
        if (next.length === 0) next.push({ topic: '', guidance: '' })
        onChange(next)
        const target = inputRefs.current[Math.max(0, index - 1)]
        if (target !== undefined && typeof target.focus === 'function') target.focus()
      }

      const add = () => {
        const next = rows.slice()
        const last = next[next.length - 1]
        if (last === undefined || last.topic.trim() !== '' || String(last.guidance ?? '').trim() !== '') {
          next.push({ topic: '', guidance: '' })
        }
        onChange(next)
        const index = next.length - 1
        setTimeout(() => {
          const target = inputRefs.current[index]
          if (target !== undefined && typeof target.focus === 'function') target.focus()
        }, 0)
      }

      const toggle = (index) => {
        setOpen((current) => {
          const next = current.slice()
          next[index] = next[index] !== true
          return next
        })
      }

      return h(
        'div',
        { className: 'dnd-rows dnd-topic-rows' },
        rows.map((row, index) => {
          const topic = String(row?.topic ?? '')
          const guidance = String(row?.guidance ?? '')
          const expanded = isOpen(index)
          return h(
            'div',
            { className: 'dnd-topic-row', key: index },
            h(
              'div',
              { className: 'dnd-row' },
              h('input', {
                ref: (node) => {
                  inputRefs.current[index] = node
                },
                value: topic,
                placeholder,
                'aria-label': placeholder,
                onChange: (event) => update(index, { topic: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    add()
                  }
                },
              }),
              // The guidance toggle sits beside the name: it is a property of the
              // topic, not a separate list.
              h(
                'button',
                {
                  type: 'button',
                  className: guidance.trim() !== '' ? 'dnd-guidance-toggle dnd-guidance-set' : 'dnd-guidance-toggle',
                  title: expanded ? closeLabel : openLabel,
                  'aria-label': expanded ? closeLabel : openLabel,
                  'aria-expanded': expanded ? 'true' : 'false',
                  onClick: () => toggle(index),
                },
                expanded ? '−' : '+',
              ),
              rows.length > 1 || topic.trim() !== '' || guidance.trim() !== ''
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dnd-remove',
                      title: removeLabel,
                      'aria-label': removeLabel,
                      onClick: () => remove(index),
                    },
                    '×',
                  )
                : null,
            ),
            expanded
              ? h('textarea', {
                  className: 'dnd-guidance',
                  value: guidance,
                  placeholder: guidancePlaceholder,
                  'aria-label': guidancePlaceholder,
                  rows: 3,
                  maxLength: 600,
                  onChange: (event) => update(index, { guidance: event.target.value }),
                })
              : null,
          )
        }),
        h('button', { type: 'button', className: 'dnd-add', onClick: add }, `+ ${addLabel}`),
      )
    }

    /**
     * The audit trail for one topic: the plan it produced, the criteria the
     * guidance became, and what the review removed and why.
     *
     * Renders nothing when the digest carries no skill, so an older stored digest
     * still displays without an empty box.
     */
    function SkillAudit({ skill, t }) {
      if (skill === null || skill === undefined || typeof skill !== 'object') return null
      const plan = Array.isArray(skill.queries) ? skill.queries : []
      const criteria = Array.isArray(skill.criteria) ? skill.criteria : []
      const reasons = Array.isArray(skill.reviewReasons) ? skill.reviewReasons : []
      if (plan.length === 0 && criteria.length === 0) return null

      const notes = []
      if (Number.isFinite(skill.reviewed) && skill.reviewed > 0) {
        notes.push(t('auditReviewed').replace('{n}', String(skill.reviewed)).replace('{dropped}', String(skill.reviewDropped ?? 0)))
      }
      if (Number.isFinite(skill.usedFallback) && skill.usedFallback > 0) {
        notes.push(t('auditFallback').replace('{n}', String(skill.usedFallback)))
      }
      if (Number.isFinite(skill.excluded) && skill.excluded > 0) {
        notes.push(t('auditExcluded').replace('{n}', String(skill.excluded)))
      }

      return h(
        'details',
        { className: 'dnd-audit' },
        h('summary', null, t('auditTitle').replace('{n}', String(plan.length))),
        notes.length > 0 ? h('p', { className: 'dnd-meta' }, notes.join(' · ')) : null,
        plan.length > 0
          ? h(
              'ul',
              { className: 'dnd-audit-list' },
              plan.map((entry, index) =>
                h('li', { key: index }, h('code', { className: 'dnd-audit-angle' }, String(entry?.angle ?? '')), ' ', String(entry?.query ?? '')),
              ),
            )
          : null,
        criteria.length > 0
          ? h(
              'div',
              null,
              h('p', { className: 'dnd-meta' }, t('auditCriteria')),
              h('ul', { className: 'dnd-audit-list' }, criteria.map((line, index) => h('li', { key: index }, String(line)))),
            )
          : null,
        reasons.length > 0
          ? h(
              'div',
              null,
              h('p', { className: 'dnd-meta' }, t('auditReasons')),
              h('ul', { className: 'dnd-audit-list' }, reasons.map((line, index) => h('li', { key: index }, String(line)))),
            )
          : null,
      )
    }

    /** One topic section of the digest. */
    function TopicSection({ topic, t }) {
      const stories = Array.isArray(topic.stories) ? topic.stories : []
      return h(
        'section',
        { className: 'dnd-topic' },
        h('h3', null, String(topic.topic ?? '')),
        // The guidance the run was given, shown with its results: the reader has
        // to be able to see what the search was told.
        typeof topic.guidance === 'string' && topic.guidance.trim() !== ''
          ? h('p', { className: 'dnd-topic-guidance' }, `${t('guidanceLabel')} ${topic.guidance}`)
          : null,
        // How that guidance was applied: the plan, the criteria and what the
        // review removed. Collapsed, because it is audit detail — but present,
        // because a reader who wrote a detailed brief should not have to take the
        // result on trust.
        h(SkillAudit, { skill: topic.skill, t }),
        topic.brief !== '' && topic.brief !== undefined ? h('p', { className: 'dnd-brief' }, topic.brief) : null,
        stories.length === 0
          ? h('p', { className: 'dnd-meta' }, topic.reason === 'no results' ? t('noStories') : topic.reason || t('noStories'))
          : h(
              'ol',
              { className: 'dnd-stories' },
              stories.map((story, index) =>
                h(
                  'li',
                  { className: 'dnd-story', key: story.id ?? index },
                  h('span', { className: 'dnd-rank' }, String(index + 1)),
                  h(
                    'div',
                    { className: 'dnd-story-body' },
                    h(
                      'a',
                      { className: 'dnd-story-title', href: story.url, target: '_blank', rel: 'noreferrer noopener' },
                      story.title || story.url,
                    ),
                    story.line !== '' && story.line !== undefined ? h('p', { className: 'dnd-story-line' }, story.line) : null,
                    h(
                      'div',
                      { className: 'dnd-chips' },
                      // The publication date first: it is what makes the link a
                      // news item rather than an evergreen section page.
                      h(
                        'span',
                        { className: 'dnd-chip', 'data-tone': story.sameDay === true ? 'fresh' : undefined },
                        story.publishedAt
                          ? new Date(story.publishedAt).toLocaleDateString()
                          : t('undated'),
                      ),
                      h('span', { className: 'dnd-chip' }, t('storySources').replace('{n}', String(story.sourceCount ?? 0))),
                      // A story the relevance screen could not confirm is marked
                      // rather than presented as certain.
                      story.relevance?.decision === 'grey'
                        ? h('span', { className: 'dnd-chip', 'data-tone': 'warn' }, t('unconfirmed'))
                        : null,
                      h(
                        'span',
                        { className: 'dnd-chip' },
                        story.measured ? t('readsMeasured').replace('{n}', String(story.reads ?? 0)) : t('readsEstimated').replace('{n}', String(story.reads ?? 0)),
                      ),
                      [...new Set(Array.isArray(story.sources) ? story.sources : [])].slice(0, 8).map((name, chipIndex) => h('span', { className: 'dnd-chip', key: `${name}-${chipIndex}` }, name)),
                    ),
                    Array.isArray(story.links) && story.links.length > 1
                      ? h(
                          'details',
                          { className: 'dnd-meta' },
                          h('summary', null, `${t('moreLinks')} (${story.links.length})`),
                          h(
                            'ul',
                            { style: { margin: '4px 0 0', paddingLeft: '18px' } },
                            story.links.slice(1).map((link, linkIndex) =>
                              h(
                                'li',
                                { key: linkIndex },
                                h('a', { href: link.url, target: '_blank', rel: 'noreferrer noopener' }, link.title || link.url),
                                link.source !== '' ? ` — ${link.source}` : '',
                              ),
                            ),
                          ),
                        )
                      : null,
                  ),
                ),
              ),
            ),
      )
    }

    /**
     * The history timeline: one row per stored digest, newest first.
     *
     * Each row opens that digest in its own Edge window — the stored copy, shown
     * at full size rather than squeezed into the panel — and carries its own
     * delete button. The delete button stops propagation so removing an entry
     * never also opens it: a small thing, but the kind of bug that makes a
     * delete control feel broken.
     */
    function HistoryTimeline({ history, currentId, onOpen, onDelete, busyId, openingId, t }) {
      if (!Array.isArray(history) || history.length === 0) return null
      return h(
        'section',
        { className: 'dnd-history' },
        h('h2', null, t('historyTitle')),
        h(
          'ol',
          { className: 'dnd-timeline' },
          history.map((entry) => {
            const active = entry.id === currentId
            const when = entry.createdAt === '' ? '' : new Date(entry.createdAt).toLocaleString()
            return h(
              'li',
              { className: 'dnd-timeline-item', key: entry.id, 'data-active': active ? 'true' : undefined },
              h('span', { className: 'dnd-timeline-dot', 'aria-hidden': true }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dnd-timeline-open',
                  onClick: () => onOpen(entry),
                  title: t('historyOpen'),
                  disabled: openingId === entry.id,
                },
                h('span', { className: 'dnd-timeline-when' }, when),
                h(
                  'span',
                  { className: 'dnd-timeline-meta' },
                  `${entry.topicCount ?? entry.topics?.length ?? 0} ${t('topicsWord')} · ${entry.storyCount ?? 0} ${t('storiesWord')}`,
                ),
                entry.topics !== undefined && entry.topics.length > 0
                  ? h('span', { className: 'dnd-timeline-topics' }, entry.topics.slice(0, 4).join(' · '))
                  : null,
                h('span', { className: 'dnd-timeline-action' }, openingId === entry.id ? t('opening') : t('historyWindow')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dnd-timeline-delete',
                  title: t('historyDelete'),
                  'aria-label': t('historyDelete'),
                  disabled: busyId === entry.id,
                  onClick: (event) => {
                    // Never let a delete also select the row underneath it.
                    event.stopPropagation()
                    onDelete(entry)
                  },
                },
                busyId === entry.id ? '…' : '×',
              ),
            )
          }),
        ),
      )
    }

    function DailyNewsDigestPage({ t }) {
      ensureCss()
      const [topics, setTopics] = React.useState([{ topic: '', guidance: '' }])
      const [sources, setSources] = React.useState([''])
      const [top, setTop] = React.useState(10)
      const [digest, setDigest] = React.useState(null)
      const [cookies, setCookies] = React.useState(null)
      const [history, setHistory] = React.useState([])
      const [deletingId, setDeletingId] = React.useState(null)
      const [openingId, setOpeningId] = React.useState(null)
      const [job, setJob] = React.useState({ phase: 'idle' })
      const [note, setNote] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [error, setError] = React.useState(null)
      const topRef = React.useRef(null)
      const loadedRef = React.useRef(false)

      /** Load the saved editor. The digest area is left empty on purpose. */
      const load = React.useCallback(async () => {
        // The cookie status is advisory: a failure here must not stop the editor
        // from loading, so it is fetched alongside rather than awaited first.
        void callApi('cookies')
          .then((payload) => {
            if (payload?.ok === true) setCookies(payload.value)
          })
          .catch(() => {})

        const payload = await callApi('state').catch((failure) => ({ ok: false, error: String(failure?.message ?? failure) }))
        if (payload.ok !== true) {
          setError(payload.error ?? 'state unavailable')
          return
        }
        const value = payload.value
        // Topics arrive as `{ topic, guidance }`. A trailing blank row is kept so
        // there is always somewhere to type the next one.
        const savedTopics = Array.isArray(value.topics) ? value.topics : []
        setTopics(savedTopics.length > 0 ? [...savedTopics, { topic: '', guidance: '' }] : [{ topic: '', guidance: '' }])
        setSources(value.sources.length > 0 ? [...value.sources, ''] : [''])
        setTop(value.top ?? 10)
        setHistory(Array.isArray(value.history) ? value.history : [])
        // Deliberately NOT restored from disk: the digest area stays empty until
        // this page session runs Summarize. A digest left over from an earlier
        // visit reads as today's news when it is not, which is worse than blank.
        setDigest(null)
        const jobValue = value.job ?? { phase: 'idle' }
        setJob(jobValue)
        // A run still in flight when the page opens is resumed by the poll effect;
        // a run that failed still deserves its error rather than a silent blank.
        if (jobValue.phase === 'failed') setError(t('runFailed').replace('{e}', String(jobValue.error ?? '')))
        loadedRef.current = true
      }, [t])

      React.useEffect(() => {
        void load()
      }, [load])

      // Save the editor shortly after it stops changing. Empty rows are dropped
      // Host-side, so the trailing blank row never reaches the file.
      React.useEffect(() => {
        if (!loadedRef.current || !dirty) return undefined
        const timer = setTimeout(() => {
          void (async () => {
            setNote({ tone: 'muted', text: t('saving') })
            const payload = await callApi('save', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ topics, sources, top }),
            }).catch((failure) => ({ ok: false, error: String(failure?.message ?? failure) }))
            if (payload.ok === true) setNote({ tone: 'muted', text: t('saved') })
            else setNote({ tone: 'bad', text: t('saveFailed').replace('{e}', String(payload.error ?? '')) })
            setDirty(false)
          })()
        }, 600)
        return () => clearTimeout(timer)
      }, [topics, sources, top, dirty, t])

      // Poll the run while one is in flight.
      React.useEffect(() => {
        if (job.phase !== 'running') return undefined
        const timer = setInterval(() => {
          void (async () => {
            const payload = await callApi('job').catch(() => null)
            if (payload?.ok !== true) return
            setJob(payload.value)
            if (payload.value.phase === 'done') {
              setDigest(payload.value.digest)
              setNote(null)
              // The finished run is now the newest timeline row. Refresh it here
              // rather than on the next page load, so the row appears as soon as
              // the digest it belongs to does.
              const state = await callApi('state').catch(() => null)
              if (state?.ok === true && Array.isArray(state.value?.history)) setHistory(state.value.history)
            } else if (payload.value.phase === 'failed') {
              setError(t('runFailed').replace('{e}', String(payload.value.error ?? '')))
            }
          })()
        }, 1500)
        return () => clearInterval(timer)
      }, [job.phase, t])

      const summarize = React.useCallback(async () => {
        setError(null)
        // Only rows with a name are sent; a row holding guidance but no topic has
        // nothing to search for, so it is not a topic.
        const cleanTopics = topics
          .map((row) => ({ topic: String(row?.topic ?? '').trim(), guidance: String(row?.guidance ?? '').trim() }))
          .filter((row) => row.topic !== '')
        if (cleanTopics.length === 0) {
          setError(t('noTopics'))
          return
        }
        setJob({ phase: 'running', startedAt: Date.now() })
        const payload = await callApi('run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ topics: cleanTopics, sources, top }),
        }).catch((failure) => ({ ok: false, error: String(failure?.message ?? failure) }))
        if (payload.ok !== true) {
          setJob({ phase: 'idle' })
          setError(payload.error === 'busy' ? t('busy') : t('runFailed').replace('{e}', String(payload.error ?? '')))
          return
        }
        setJob(payload.job)
      }, [topics, sources, top, t])

      /**
       * Open one stored digest in its own Edge window.
       *
       * The window shows the stored document, not a fresh search, so it works for
       * an old run and needs no model. The Host launches Edge and answers with the
       * URL it opened; a failure is reported rather than swallowed, because a
       * button that does nothing reads as a broken button.
       */
      const openHistory = React.useCallback(async (entry) => {
        setError(null)
        setOpeningId(entry.id)
        const payload = await callApi('open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: entry.id }),
        }).catch((failure) => ({ ok: false, error: String(failure?.message ?? failure) }))
        setOpeningId(null)
        if (payload.ok !== true) {
          setError(payload.error === 'edge-missing' ? t('edgeMissing') : t('openFailed').replace('{e}', String(payload.error ?? '')))
          return
        }
        setNote({ tone: 'muted', text: t('windowOpened') })
      }, [t])

      /** Remove one stored digest, and drop it from the view if it was open. */
      const deleteHistory = React.useCallback(async (entry) => {
        setError(null)
        setDeletingId(entry.id)
        const payload = await callApi('history/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: entry.id }),
        }).catch((failure) => ({ ok: false, error: String(failure?.message ?? failure) }))
        setDeletingId(null)
        if (payload.ok !== true) {
          setError(t('historyFailed').replace('{e}', String(payload.error ?? '')))
          return
        }
        setHistory(Array.isArray(payload.value?.history) ? payload.value.history : [])
        // Deleting the digest on screen must clear it too: leaving it visible
        // would show a result whose stored copy no longer exists.
        setDigest((current) => (current !== null && current.id === entry.id ? null : current))
      }, [t])

      const focusTop = () => {
        const node = topRef.current
        if (node !== null && node !== undefined && typeof node.focus === 'function') {
          node.focus()
          if (typeof node.select === 'function') node.select()
        }
      }

      const busy = job.phase === 'running'
      // Progress is per-topic; the Host reports how many topics it has finished.
      const doneTopics = Number.isFinite(job.done) ? job.done : 0
      const topicTotal = Number.isFinite(job.total) && job.total > 0
        ? job.total
        : Math.max(1, topics.filter((row) => String(row).trim() !== '').length)

      // Whether the run produced anything at all, and whether the search failed
      // outright. Both matter for what the page says: "no model summary, stories
      // listed" is a lie when there are no stories, and a total search failure
      // must not read as a quiet news day.
      const storyTotal = digest === null || !Array.isArray(digest.topics)
        ? 0
        : digest.topics.reduce((total, topic) => total + (Array.isArray(topic?.stories) ? topic.stories.length : 0), 0)
      const searchFailure = digest?.notes?.searches ?? null
      const searchFailedEntirely = searchFailure !== null && Number(searchFailure.failed) >= Number(searchFailure.of) && Number(searchFailure.of) > 0

      return h(
        'div',
        { className: 'dnd-page' },
        h(
          'div',
          { className: 'dnd-head' },
          h('h1', null, t('title')),
          h('p', null, t('intro')),
          // Whether the user's Edge sign-ins are usable is a precondition for
          // reading x.com, Zhihu and Weibo, so it is stated before they run.
          cookies === null
            ? null
            : h(
                'p',
                { className: cookies.available ? 'dnd-meta' : 'dnd-meta dnd-error' },
                cookies.available
                  ? cookies.fromCache === true
                    ? t('cookiesSaved')
                        .replace('{n}', String(cookies.count))
                        .replace('{age}', String(cookies.savedAgeMinutes ?? 0))
                    : t('cookiesOk').replace('{n}', String(cookies.count))
                  : cookies.locked
                    ? t('cookiesLocked')
                    : t('cookiesMissing').replace('{e}', String(cookies.note ?? '')),
              ),
        ),
        h(
          'div',
          { className: 'dnd-editors' },
          h(
            'div',
            { className: 'dnd-card' },
            h('h2', null, t('topicsTitle')),
            h('p', { className: 'dnd-hint' }, t('topicsHint')),
            h(TopicEditor, {
              rows: topics,
              placeholder: t('topicsPlaceholder'),
              guidancePlaceholder: t('guidancePlaceholder'),
              addLabel: t('addTopic'),
              removeLabel: t('remove'),
              openLabel: t('guidanceOpen'),
              closeLabel: t('guidanceClose'),
              t,
              onChange: (rows) => {
                setTopics(rows)
                setDirty(true)
              },
            }),
          ),
          h(
            'div',
            { className: 'dnd-card' },
            h('h2', null, t('sourcesTitle')),
            h('p', { className: 'dnd-hint' }, t('sourcesHint')),
            h(RowEditor, {
              rows: sources,
              placeholder: t('sourcesPlaceholder'),
              addLabel: t('addSource'),
              removeLabel: t('remove'),
              t,
              onChange: (rows) => {
                setSources(rows)
                setDirty(true)
              },
            }),
          ),
        ),
        h(
          'div',
          { className: 'dnd-controls' },
          h(
            'span',
            { className: 'dnd-top' },
            h('button', { type: 'button', className: 'dnd-btn', onClick: focusTop, title: t('topHint') }, t('top')),
            h('input', {
              ref: topRef,
              type: 'number',
              min: 1,
              max: 50,
              value: top,
              'aria-label': t('topHint'),
              onChange: (event) => {
                const next = Number(event.target.value)
                setTop(Number.isFinite(next) ? Math.min(50, Math.max(1, Math.trunc(next))) : 10)
                setDirty(true)
              },
            }),
          ),
          h(
            'button',
            { type: 'button', className: 'dnd-btn', 'data-kind': 'primary', onClick: () => void summarize(), disabled: busy },
            busy ? t('summarizing') : t('summarize'),
          ),
          h('span', { className: 'dnd-spacer' }),
          busy
            ? h('span', { className: 'dnd-status' }, t('running').replace('{done}', String(doneTopics)).replace('{total}', String(topicTotal)))
            : note !== null
              ? h('span', { className: note.tone === 'bad' ? 'dnd-status dnd-error' : 'dnd-status' }, note.text)
              : null,
        ),
        error !== null ? h('div', { className: 'dnd-status dnd-error' }, error) : null,
        h(HistoryTimeline, {
          history,
          currentId: digest === null ? null : digest.id,
          onOpen: (entry) => void openHistory(entry),
          onDelete: (entry) => void deleteHistory(entry),
          busyId: deletingId,
          openingId,
          t,
        }),
        // Nothing here until the user presses Summarize: an empty results area is
        // the requested state, not a missing one. A placeholder box would still be
        // content sitting where the digest goes.
        digest === null
          ? null
          : h(
              'div',
              { className: 'dnd-digest' },
              h(
                'div',
                { className: 'dnd-meta' },
                `${t('digestAt').replace('{time}', new Date(digest.createdAt).toLocaleString())} · ${digest.topics.length} ${t('topicsWord')} · ${digest.sources.length} ${t('sourcesWord')} · ${t('perTopic').replace('{n}', String(digest.top))}`,
              ),
              digest.model !== '' ? h('div', { className: 'dnd-meta' }, t('model').replace('{model}', digest.model)) : null,
              // "No model summary, the stories are listed as found" is only true
              // when there are stories. With an empty digest it reads as a
              // partially working run instead of a broken one.
              digest.summarized === false && storyTotal > 0
                ? h('div', { className: 'dnd-meta' }, t('fallback'))
                : null,
              digest.partial === true ? h('div', { className: 'dnd-status dnd-error' }, t('partial')) : null,
              // Why a login-walled source may have come back thin, in the user's
              // terms rather than as a silent absence.
              digest.notes?.cookies !== undefined
                ? h('div', { className: 'dnd-status' }, digest.notes.cookies)
                : null,
              digest.notes?.walls !== undefined
                ? h('div', { className: 'dnd-status dnd-error' }, t('wallNote').replace('{e}', String(digest.notes.walls)))
                : null,
              // A failed search is not an empty day. Without this line an
              // unreachable search service and a genuinely quiet day look
              // identical: both render as "no news found".
              searchFailedEntirely
                ? h(
                    'div',
                    { className: 'dnd-status dnd-error' },
                    t('searchAllFailed')
                      .replace('{of}', String(searchFailure.of))
                      .replace('{e}', String(searchFailure.error ?? '')),
                  )
                : searchFailure !== null
                  ? h(
                      'div',
                      { className: 'dnd-status dnd-error' },
                      t('searchFailedNote')
                        .replace('{n}', String(searchFailure.failed))
                        .replace('{of}', String(searchFailure.of))
                        .replace('{e}', String(searchFailure.error ?? '')),
                    )
                  : null,
              // What the screens removed, stated rather than left as an
              // unexplained short digest. Two counts, because they are different
              // things: off-topic noise, and on-topic pages that were not news.
              Array.isArray(digest.filtered) && digest.filtered.some((row) => (row.dropped ?? 0) > 0)
                ? h(
                    'div',
                    { className: 'dnd-meta' },
                    t('filteredNote')
                      .replace('{n}', String(digest.filtered.reduce((total, row) => total + (row.dropped ?? 0), 0)))
                      .replace('{list}', digest.filtered.filter((row) => (row.dropped ?? 0) > 0).map((row) => `${row.topic} ${row.dropped}`).join(', ')),
                  )
                : null,
              Array.isArray(digest.filtered) && digest.filtered.some((row) => (row.evergreen ?? 0) > 0)
                ? h(
                    'div',
                    { className: 'dnd-meta' },
                    t('evergreenNote').replace(
                      '{n}',
                      String(digest.filtered.reduce((total, row) => total + (row.evergreen ?? 0), 0)),
                    ),
                  )
                : null,
              h('div', { className: 'dnd-meta' }, t('measuredNote')),
              digest.sources.length > 0
                ? h('div', { className: 'dnd-meta' }, t('searchSources').replace('{list}', digest.sources.map((source) => source.label).join(', ')))
                : null,
              digest.topics.map((topic, index) => h(TopicSection, { topic, t, key: `${topic.topic}-${index}` })),
            ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      // A handle on the topic section for tests only. The digest area renders only
      // for a run this page session started, which a fixture cannot reach, so the
      // section is exported here rather than registered as a slot: a slot name the
      // Host does not know is not a test detail, it is a startup failure.
      TopicSection,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'daily-news-digest: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              // Plugins registers at order 0 and the market at 1; a value between
              // them puts this row directly below Plugins.
              order: 0.5,
              locale: NS,
              label: () => t('panel'),
            },
            DigestIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            DailyNewsDigestPage,
          ),
        )
      },
    }
  },
})
