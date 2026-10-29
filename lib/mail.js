/**
 * Daily News Digest — emailing the digest.
 *
 * DSH itself has no mail capability: the whole shipped bundle contains no SMTP
 * client, no mail library and no send tool. So mail goes out through the mail
 * client that is already on this machine and already signed in — Outlook, driven
 * over its COM automation interface.
 *
 * Why COM rather than SMTP:
 *
 *   - it needs no password, no app password, and no secret stored in a config
 *     file, because it uses the account Outlook is already signed in to;
 *   - the From address is therefore the user's real mailbox, and the message
 *     lands in their Sent Items, which is what a person expects from "email me
 *     the digest".
 *
 * The cost is that Outlook must be running (or startable) and that Outlook may
 * raise a security prompt the first time an external program sends on its
 * behalf. Both are reported rather than hidden: a failed send is a reason string
 * the caller can show, never a silent success.
 *
 * The PowerShell script is passed as a single `-Command` string with the values
 * injected as *environment variables*, not interpolated into the script text.
 * That matters: a subject or file path is user-influenced data, and pasting it
 * into a script would make a quote in a headline into a code injection.
 */

import { execFile } from 'node:child_process'

/** How long a send may take before it is abandoned. */
const SEND_TIMEOUT_MS = 120_000

/**
 * The PowerShell program that drives Outlook.
 *
 * Values arrive in `$env:DND_*`, so nothing user-supplied is parsed as code. The
 * script prints a single JSON object, which is the only thing the caller reads.
 */
const SEND_SCRIPT = `
$ErrorActionPreference = 'Stop'
$result = @{ ok = $false; reason = '' }
try {
  $outlook = New-Object -ComObject Outlook.Application
  $mail = $outlook.CreateItem(0)
  $mail.To = $env:DND_TO
  $mail.Subject = $env:DND_SUBJECT
  $mail.Body = $env:DND_BODY
  if ($env:DND_ATTACH -ne '' -and (Test-Path -LiteralPath $env:DND_ATTACH)) {
    $mail.Attachments.Add($env:DND_ATTACH) | Out-Null
  }
  # Send() hands the message to Outlook's outbox. It does not guarantee delivery,
  # and Outlook may prompt; a throw here is reported as the reason.
  $mail.Send()
  $result.ok = $true
} catch {
  $result.reason = $_.Exception.Message
} finally {
  if ($mail -ne $null) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($mail) }
  if ($outlook -ne $null) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) }
}
$result | ConvertTo-Json -Compress
`

/**
 * Send one email with an optional attachment, through Outlook.
 * @param {object} options - `{ to, subject, body, attachment, spawn, timeoutMs }`.
 * @returns {Promise<{ ok: boolean, reason?: string }>} the send result.
 */
export async function sendMail(options = {}) {
  const to = String(options.to ?? '').trim()
  if (to === '') return { ok: false, reason: 'no recipient address was configured' }
  const subject = String(options.subject ?? 'Daily News Digest')
  const body = String(options.body ?? '')
  const attachment = String(options.attachment ?? '')

  const spawn = typeof options.spawn === 'function' ? options.spawn : execFile
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : SEND_TIMEOUT_MS

  const env = {
    ...process.env,
    DND_TO: to,
    DND_SUBJECT: subject,
    DND_BODY: body,
    DND_ATTACH: attachment,
  }

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SEND_SCRIPT]

  const output = await new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn('powershell.exe', args, { windowsHide: true, timeout: timeoutMs, env }, (error, stdout) => {
        finish({ error, stdout: String(stdout ?? '') })
      })
    } catch (error) {
      finish({ error, stdout: '' })
      return
    }
    child?.on?.('error', (error) => finish({ error, stdout: '' }))
  })

  const text = output.stdout.trim()
  // The script's last line is its JSON answer; anything before it is noise from
  // a profile script or a COM warning.
  const line = text.split(/\r?\n/).filter((part) => part.trim().startsWith('{')).pop()
  if (line === undefined) {
    const detail = output.error?.message ?? 'Outlook produced no result'
    return { ok: false, reason: String(detail) }
  }
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'Outlook returned an unreadable result' }
  }
  if (parsed?.ok === true) return { ok: true }
  return { ok: false, reason: String(parsed?.reason ?? 'Outlook could not send the message') }
}

/**
 * The subject and body for one digest email.
 * @param {object} digest - the digest document.
 * @param {string} [lang] - `zh` or `en`.
 * @returns {{ subject: string, body: string }} the message text.
 */
export function composeMessage(digest, lang = 'en') {
  const day = String(digest?.day ?? '')
  const topics = Array.isArray(digest?.topics) ? digest.topics : []
  const storyCount = topics.reduce((total, topic) => total + (Array.isArray(topic?.stories) ? topic.stories.length : 0), 0)
  const zh = String(lang).toLowerCase().startsWith('zh')

  const subject = zh ? `每日新闻摘要 — ${day}` : `Daily News Digest — ${day}`

  const covered = topics.filter((topic) => Array.isArray(topic?.stories) && topic.stories.length > 0).length
  const empty = topics.length - covered

  const lines = []
  lines.push(zh ? `覆盖日期：${day}` : `Date covered: ${day}`)
  lines.push(zh ? `主题 ${topics.length} 个，新闻 ${storyCount} 条。` : `${topics.length} topics, ${storyCount} stories.`)
  // Say up front when a topic came back empty. Otherwise a reader has to scroll the
  // whole message to discover that "6 topics" meant four of them.
  if (empty > 0) {
    lines.push(
      zh
        ? `其中 ${covered} 个主题有新闻，${empty} 个主题今天没有检索到内容。`
        : `${covered} of ${topics.length} topics had news; ${empty} had none today.`,
    )
  }
  lines.push('')
  for (const topic of topics) {
    const name = String(topic?.topic ?? '')
    const stories = Array.isArray(topic?.stories) ? topic.stories : []
    lines.push(zh ? `【${name}】` : `[${name}]`)
    if (typeof topic?.brief === 'string' && topic.brief.trim() !== '') lines.push(topic.brief.trim())
    for (const [index, story] of stories.entries()) {
      const title = String(story?.title ?? '').trim()
      const url = String(story?.url ?? '').trim()
      lines.push(`  ${index + 1}. ${title}`)
      if (url !== '') lines.push(`     ${url}`)
    }
    if (stories.length === 0) lines.push(zh ? '  （今天没有检索到新闻）' : '  (no news found for this topic)')
    lines.push('')
  }
  lines.push(zh ? '完整版请见附件 PDF。' : 'See the attached PDF for the full report.')

  return { subject, body: lines.join('\n') }
}
