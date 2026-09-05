/** One event, rendered for each channel. Plain words, the failing test first, a link. */
import type { NotificationEvent } from './events.ts'

function firstLine(text: string | null | undefined): string | null {
  if (!text) return null
  return text.split('\n')[0]!.slice(0, 200)
}

export interface Rendered {
  /** One line, no markup. Used as the email subject and the fallback text everywhere. */
  headline: string
  /** A few short lines, no markup. */
  lines: Array<string>
  url: string
  severity: 'good' | 'bad' | 'info'
}

export function render(event: NotificationEvent): Rendered {
  switch (event.type) {
    case 'run.passed':
    case 'run.failed':
    case 'run.error': {
      const { run, project } = event
      const verb =
        event.type === 'run.passed'
          ? 'passed'
          : event.type === 'run.failed'
            ? 'failed'
            : 'could not finish'
      const lines = [
        `${project.name} · ${run.environment.name}${run.environment.baseUrl ? ` (${run.environment.baseUrl})` : ''}`,
        `Trigger: ${run.trigger}${run.durationMs !== null ? ` · ${Math.round(run.durationMs / 1000)}s` : ''}`,
      ]
      const error = firstLine(run.errorMessage)
      if (error) lines.push(`Error: ${error}`)
      return {
        headline: `${run.test.title} ${verb}`,
        lines,
        url: run.url,
        severity: event.type === 'run.passed' ? 'good' : 'bad',
      }
    }
    case 'suite.passed':
    case 'suite.failed': {
      const { suite, project } = event
      const { counts } = suite
      const lines = [
        `${project.name} · ${suite.environment.name} · trigger: ${suite.trigger}`,
        `${counts.passed} passed, ${counts.failed} failed, ${counts.error} errored of ${counts.total}`,
      ]
      for (const failure of suite.failures.slice(0, 8)) {
        const error = firstLine(failure.errorMessage)
        lines.push(`✘ ${failure.test.title}${error ? ` — ${error}` : ''}`)
      }
      if (suite.failures.length > 8) lines.push(`…and ${suite.failures.length - 8} more`)
      return {
        headline:
          event.type === 'suite.passed'
            ? `Suite passed: ${counts.passed} of ${counts.total} in ${project.name}`
            : `Suite failed: ${counts.failed + counts.error} of ${counts.total} in ${project.name}`,
        lines,
        url: suite.url,
        severity: event.type === 'suite.passed' ? 'good' : 'bad',
      }
    }
    case 'repair.pending':
    case 'repair.adopted':
    case 'repair.failed': {
      const { repair, project } = event
      const lines = [`${project.name} · ${repair.environment.name}`]
      if (repair.whatFailed) lines.push(`What broke: ${firstLine(repair.whatFailed)}`)
      if (event.type === 'repair.pending') {
        lines.push(`Version ${repair.version} verified and is waiting for someone to accept it.`)
      } else if (event.type === 'repair.adopted') {
        lines.push(
          `Version ${repair.version} verified and is now the current version. The failed run is marked repaired.`,
        )
      } else if (repair.reason) {
        lines.push(`Why: ${firstLine(repair.reason)}`)
      }
      return {
        headline:
          event.type === 'repair.pending'
            ? `Repair ready for review: ${repair.test.title}`
            : event.type === 'repair.adopted'
              ? `Repaired automatically: ${repair.test.title}`
              : `Could not repair: ${repair.test.title}`,
        lines,
        url: repair.url,
        severity:
          event.type === 'repair.failed'
            ? 'bad'
            : event.type === 'repair.adopted'
              ? 'good'
              : 'info',
      }
    }
  }
}

const SLACK_COLOR = { good: '#2eb67d', bad: '#e01e5a', info: '#36c5f0' } as const
const DISCORD_COLOR = { good: 0x2eb67d, bad: 0xe01e5a, info: 0x36c5f0 } as const

export function slackBody(event: NotificationEvent): string {
  const view = render(event)
  return JSON.stringify({
    text: `${view.headline} — ${view.url}`,
    attachments: [
      {
        color: SLACK_COLOR[view.severity],
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*<${view.url}|${view.headline}>*` } },
          { type: 'section', text: { type: 'mrkdwn', text: view.lines.join('\n') } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `Flaremender · ${event.type}` }] },
        ],
      },
    ],
  })
}

export function discordBody(event: NotificationEvent): string {
  const view = render(event)
  return JSON.stringify({
    content: view.headline,
    embeds: [
      {
        title: view.headline,
        url: view.url,
        description: view.lines.join('\n'),
        color: DISCORD_COLOR[view.severity],
        footer: { text: `Flaremender · ${event.type}` },
      },
    ],
  })
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
}

export function emailBody(event: NotificationEvent): {
  subject: string
  text: string
  html: string
} {
  const view = render(event)
  const text = [
    view.headline,
    '',
    ...view.lines,
    '',
    view.url,
    '',
    `Sent by Flaremender (${event.type}).`,
  ].join('\n')
  const html = [
    `<p style="font:16px/1.4 -apple-system,Segoe UI,sans-serif;margin:0 0 12px"><strong><a href="${escapeHtml(view.url)}">${escapeHtml(view.headline)}</a></strong></p>`,
    `<p style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:0 0 12px">${view.lines.map(escapeHtml).join('<br>')}</p>`,
    `<p style="font:12px/1.4 -apple-system,Segoe UI,sans-serif;color:#666;margin:0">Sent by Flaremender · ${escapeHtml(event.type)}</p>`,
  ].join('\n')
  return { subject: `[Flaremender] ${view.headline}`, text, html }
}
