import { Badge, Button, LayerCard, Text } from '@cloudflare/kumo'
import {
  ArrowRightIcon,
  ChatTeardropTextIcon,
  CloudIcon,
  CodeIcon,
  ArrowsClockwiseIcon,
} from '@phosphor-icons/react'
import { Link, createFileRoute } from '@tanstack/react-router'

import { BrandLockup } from '#/components/brand.tsx'
import { ThemeToggle } from '#/components/theme-toggle.tsx'

export const Route = createFileRoute('/')({ component: Landing })

const STEPS = [
  {
    icon: ChatTeardropTextIcon,
    title: 'Describe the test',
    body: 'Write what the user should be able to do, in plain English. No selectors, no boilerplate.',
  },
  {
    icon: CodeIcon,
    title: 'Get Playwright code',
    body: 'Each description compiles into a real spec you can read, edit and check into your repo.',
  },
  {
    icon: CloudIcon,
    title: 'Run on Cloudflare',
    body: 'Specs execute in a Cloudflare browser session — nothing to install, nothing to keep warm.',
  },
  {
    icon: ArrowsClockwiseIcon,
    title: 'Repair on failure',
    body: 'A failed run feeds its own error back into generation, so the next attempt is a fix.',
  },
]

function Landing() {
  const { session } = Route.useRouteContext()

  return (
    <div className="min-h-dvh bg-kumo-canvas">
      <header className="sticky top-0 z-10 border-b border-kumo-line bg-kumo-canvas">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-3">
          <BrandLockup />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {session ? (
              <Link to="/dashboard">
                <Button variant="primary">Open dashboard</Button>
              </Link>
            ) : (
              <>
                <Link to="/signin" search={{ redirect: undefined }}>
                  <Button variant="ghost">Sign in</Button>
                </Link>
                <Link to="/signup" search={{ redirect: undefined }}>
                  <Button variant="primary">Get started</Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-5xl gap-12 px-5 py-16">
        <section className="grid gap-6">
          <div className="grid max-w-2xl gap-3">
            <Badge variant="beta" className="w-fit">
              Open source
            </Badge>
            <Text as="h1" variant="heading" size="lg" DANGEROUS_className="text-3xl">
              Natural language tests that keep themselves green
            </Text>
            <Text variant="secondary">
              Flaremender turns a sentence into a Playwright spec, runs it in a Cloudflare browser,
              and regenerates the spec from its own failure output until it passes.
            </Text>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={session ? '/dashboard' : '/signup'}
              search={session ? undefined : { redirect: undefined }}
            >
              <Button variant="primary" icon={<ArrowRightIcon size={16} />}>
                {session ? 'Go to your projects' : 'Create a free account'}
              </Button>
            </Link>
            <Text variant="secondary">Runs entirely on the Cloudflare developer platform.</Text>
          </div>
        </section>

        <section className="grid gap-4">
          <div className="grid gap-1.5">
            <Text as="h2" variant="heading" size="lg" DANGEROUS_className="text-2xl">
              How the loop works
            </Text>
            <Text variant="secondary">Four steps, repeated until the suite is green.</Text>
          </div>

          <ol className="grid gap-4 sm:grid-cols-2">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <LayerCard className="h-full px-5 py-4">
                  <div className="grid gap-3">
                    <div className="flex items-center gap-2">
                      <span className="flex size-7 items-center justify-center rounded-md bg-kumo-recessed text-kumo-subtle">
                        <step.icon size={16} />
                      </span>
                      <Text as="span" variant="mono-secondary">
                        Step {index + 1}
                      </Text>
                    </div>
                    <div className="grid gap-1.5">
                      <Text as="h3" variant="heading">
                        {step.title}
                      </Text>
                      <Text variant="secondary">{step.body}</Text>
                    </div>
                  </div>
                </LayerCard>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid gap-4">
          <div className="grid gap-1.5">
            <Text as="h2" variant="heading" size="lg" DANGEROUS_className="text-2xl">
              Built on the Cloudflare stack
            </Text>
            <Text variant="secondary">
              Workers for the app, D1 for state, Browser Rendering for the runs.
            </Text>
          </div>
          <LayerCard className="px-5 py-4">
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
              {[
                ['Workers', 'TanStack Start rendered at the edge'],
                ['D1', 'Projects, cases and every run attempt'],
                ['Browser Rendering', 'Playwright execution without infrastructure'],
              ].map(([term, detail]) => (
                <div key={term} className="grid gap-1.5">
                  <Text as="dt" bold>
                    {term}
                  </Text>
                  <Text as="dd" variant="secondary">
                    {detail}
                  </Text>
                </div>
              ))}
            </dl>
          </LayerCard>
        </section>
      </main>
    </div>
  )
}
