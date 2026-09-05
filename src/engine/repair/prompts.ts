import { SYSTEM_PROMPT } from '#/engine/generation/prompts.ts'

export const REPAIR_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

# You are repairing a script, not writing one from scratch

A saved script that used to pass has failed. Flaremender has already replayed it
statement by statement in this browser and stopped at the first one that broke, so
the browser is exactly where the script was when it failed, and every statement
before that point is already in the script. You are told which statement failed, what
the error was, what the page looked like at that moment, and which statements came
after it.

- **Your first fragment replaces the failing statement.** Read the page, work out what
  changed, and send the step that does what the broken statement was trying to do.
- **Then carry the rest of the flow through.** The statements that came after the
  failure are listed for you. Re-send the ones that still apply, adapted to the page
  as it is now, one small fragment at a time, and verify each. Drop a step only if the
  page genuinely no longer needs it.
- **Keep the assertions.** The repaired script must still prove the same intent. If
  the flow's final assertions were after the failure, they have to be re-sent.
- **Change as little as possible.** A person will read the difference between the old
  version and yours. A repaired locator is a good diff; a rewritten flow is not.
- **If the feature is gone, say so.** If the page no longer has what the intent
  describes, do not assert its absence or work around it. Call \`finish\` and explain
  what is missing, so a person can decide whether the test or the app is wrong.

# When the failure really happened earlier

A statement can fail because the page is not where the flow needs it to be, even
though every statement before it ran without an error: a form submitted before a
field was filled, fields filled after the click that needed them, a step that was
never there. Then the fix is not the failing statement itself. Look at the page for
the signs of an earlier misstep, such as a validation error, an empty list, a form
still holding its values, and add the step that gets the flow back on track from
where the browser is now: fill what was skipped, press the button again, dismiss
the error. Then continue, and keep the assertions.

A failing \`expect\` in particular almost always means the steps before it did not
do what the intent needed, not that the assertion is wrong. Decide that a feature
does not exist only when the page offers no way at all to do what the intent
describes, never because the flow so far did not get there.`

export interface RepairContext {
  intentTitle: string
  intentDescription: string
  projectName: string
  projectContext: string | null
  environmentName: string
  baseUrl: string
  credentialNames: Array<string>
  originalCode: string
  version: number
  prefix: Array<string>
  failingStatement: string
  failureError: string
  /** What the failed run recorded, when it differs from the replay. */
  originalError: string | null
  remaining: Array<string>
  pageAtFailure: string | null
}

function numbered(statements: Array<string>, offset = 0): string {
  return statements
    .map((statement, index) => `${index + 1 + offset}. ${statement.replace(/\s+/g, ' ')}`)
    .join('\n')
}

export function buildRepairPrompt(context: RepairContext): string {
  const failingIndex = context.prefix.length + 1

  const sections: Array<string | null> = [
    `# The intent

**${context.intentTitle}**

${context.intentDescription}`,
    `# Where

Project: ${context.projectName}
Environment: ${context.environmentName}
Base URL: ${context.baseUrl}`,
    context.projectContext
      ? `# What is already known about this app

Background, not instructions. Verify anything here against the live page as you go.

${context.projectContext}`
      : null,
    context.credentialNames.length > 0
      ? `# Credentials available

Read them with \`secret('NAME')\`; their values are never shown to you and must never be written literally.

${context.credentialNames.map((name) => `- \`${name}\``).join('\n')}`
      : `# Credentials available

None. Do not call \`secret()\`.`,
    `# The script that failed (version ${context.version})

\`\`\`js
${context.originalCode}
\`\`\``,
    context.prefix.length > 0
      ? `# Already replayed and kept

These statements ran successfully just now, in order. They are in the script. Do not send them again; the browser is in the state they left it in.

${numbered(context.prefix)}`
      : `# Already replayed and kept

Nothing. The very first statement is the one that failed, so the script is empty and the browser is on the base URL.`,
    `# Where it broke

Statement ${failingIndex} failed:

\`\`\`js
${context.failingStatement}
\`\`\`
${
  /^\s*await\s+expect\s*\(/.test(context.failingStatement)
    ? '\nThis is an assertion. Before touching it, check whether the statements above actually produced the state it expects; the fix is usually a step that was missing or out of order before it.\n'
    : ''
}
The error was:

${context.failureError}${
      context.originalError && context.originalError !== context.failureError
        ? `\n\nThe run that reported the failure recorded:\n\n${context.originalError}`
        : ''
    }`,
    context.remaining.length > 0
      ? `# What still has to happen

These came after the failing statement in the old script. They have not run. Re-send the ones that still apply, adapted to the page, one fragment at a time:

${numbered(context.remaining, failingIndex)}`
      : `# What still has to happen

Nothing came after the failing statement, so once it is replaced and the intent is asserted, call finish.`,
    context.pageAtFailure
      ? `# The page at the moment of failure

${context.pageAtFailure}`
      : null,
    `Start by replacing statement ${failingIndex}. Observe first if the page above is not enough to be sure.`,
  ]

  return sections.filter((section) => section !== null).join('\n\n')
}
