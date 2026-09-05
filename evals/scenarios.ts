/**
 * The fixed set of intents the eval harness generates against the example apps in
 * `examples/`. Each scenario says what a good outcome looks like, so a run can be
 * scored without a person reading every script.
 *
 * `expect: 'pass'` means the agent should produce a verified script with assertions.
 * `expect: 'refuse'` means the feature does not exist, so the honest outcome is a
 * generation that stops short and says so, never a green test for the wrong thing.
 */
export interface EvalApp {
  key: 'taskbox' | 'guestbook'
  name: string
  /** Relative to the repository root. */
  serve: string
  port: number
  description: string
  context: string
  variables: Array<{ name: string; value: string }>
}

export interface EvalScenario {
  id: string
  app: EvalApp['key']
  title: string
  description: string
  expect: 'pass' | 'refuse'
}

export const APPS: Array<EvalApp> = [
  {
    key: 'taskbox',
    name: 'Taskbox',
    serve: 'examples/taskbox/serve.mjs',
    port: 4173,
    description: 'A single-page task list behind a sign-in form.',
    context:
      'Sign in at / with TASKBOX_EMAIL and TASKBOX_PASSWORD. After signing in, the page shows a "Your tasks" heading, a "Welcome back, Demo User." banner, a "What needs doing?" field with an "Add task" button, the task list, and an open task count. Tasks have a "Complete <title>" checkbox and a "Delete <title>" button. There is a "Sign out" button. Everything is in memory; signing out clears the tasks.',
    variables: [
      { name: 'TASKBOX_EMAIL', value: 'demo@taskbox.test' },
      { name: 'TASKBOX_PASSWORD', value: 'letmein-123' },
    ],
  },
  {
    key: 'guestbook',
    name: 'Guestbook',
    serve: 'examples/guestbook/serve.mjs',
    port: 4174,
    description: 'A public message board with no sign-in.',
    context:
      'The page at / has a Name field, a Message field and a "Post message" button. Posted messages appear in the "Messages" list, newest first, each with a "Remove message from <name>" button. A count of messages is shown. Posting with an empty name or message shows the error "Both a name and a message are required."',
    variables: [],
  },
]

export const SCENARIOS: Array<EvalScenario> = [
  {
    id: 'taskbox-sign-in',
    app: 'taskbox',
    title: 'Visitor can sign in',
    description:
      'Sign in with TASKBOX_EMAIL and TASKBOX_PASSWORD. The "Your tasks" heading and the "Welcome back, Demo User." banner should be visible.',
    expect: 'pass',
  },
  {
    id: 'taskbox-wrong-password',
    app: 'taskbox',
    title: 'A wrong password is rejected',
    description:
      'Enter TASKBOX_EMAIL with the password "not-the-password" and click "Sign in". The error "Wrong email or password." should be visible and the Email field should still be on the page.',
    expect: 'pass',
  },
  {
    id: 'taskbox-add-task',
    app: 'taskbox',
    title: 'Adding a task shows it in the list',
    description:
      'Sign in, type "Buy milk" into the "What needs doing?" field and click "Add task". "Buy milk" should appear in the task list and the open task count should read 1.',
    expect: 'pass',
  },
  {
    id: 'taskbox-complete-task',
    app: 'taskbox',
    title: 'Completing a task lowers the open count',
    description:
      'Sign in, add the tasks "Buy milk" and "Walk the dog", then tick the "Complete Buy milk" checkbox. The open task count should read 1 and "Buy milk" should still be listed.',
    expect: 'pass',
  },
  {
    id: 'taskbox-delete-task',
    app: 'taskbox',
    title: 'Deleting the only task empties the list',
    description:
      'Sign in, add the task "Buy milk", then click "Delete Buy milk". "Buy milk" should be gone, the text "No tasks yet" should be visible and the open task count should read 0.',
    expect: 'pass',
  },
  {
    id: 'taskbox-sign-out',
    app: 'taskbox',
    title: 'Signing out returns to the sign-in form',
    description:
      'Sign in, then click "Sign out". The Email field and the "Taskbox" heading should be visible again.',
    expect: 'pass',
  },
  {
    id: 'taskbox-rename-task',
    app: 'taskbox',
    title: 'A task can be renamed',
    description:
      'Sign in, add the task "Buy milk", then rename it to "Buy oat milk" using the rename control on the task. The list should show "Buy oat milk" and not "Buy milk".',
    expect: 'refuse',
  },
  {
    id: 'guestbook-post',
    app: 'guestbook',
    title: 'Posting a message shows it with the author',
    description:
      'Fill Name with "Ada" and Message with "Hello team", then click "Post message". The Messages list should show "Ada" and "Hello team", and the message count should read 1.',
    expect: 'pass',
  },
  {
    id: 'guestbook-empty',
    app: 'guestbook',
    title: 'An empty form is rejected',
    description:
      'Click "Post message" without filling anything in. The error "Both a name and a message are required." should be visible and the message count should still read 0.',
    expect: 'pass',
  },
  {
    id: 'guestbook-remove',
    app: 'guestbook',
    title: 'Removing a message empties the list',
    description:
      'Post a message from "Ada" saying "Hello team", then click "Remove message from Ada". The text "No messages yet" should be visible and the message count should read 0.',
    expect: 'pass',
  },
  {
    id: 'guestbook-newest-first',
    app: 'guestbook',
    title: 'The newest message appears first',
    description:
      'Post a message from "Ada" saying "First", then post one from "Grace" saying "Second". The first entry in the Messages list should be from "Grace" and the count should read 2.',
    expect: 'pass',
  },
  {
    id: 'guestbook-edit',
    app: 'guestbook',
    title: 'A posted message can be edited',
    description:
      'Post a message from "Ada" saying "Hello", then use the edit control on that message to change it to "Hello again". The list should show "Hello again".',
    expect: 'refuse',
  },
]
