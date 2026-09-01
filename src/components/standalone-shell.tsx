import { Text } from '@cloudflare/kumo'
import { FlameIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'

import { ThemeToggle } from '#/components/theme-toggle.tsx'

export function StandaloneShell({
  children,
  eyebrow,
}: {
  children: React.ReactNode
  eyebrow?: React.ReactNode
}) {
  return (
    <div className="min-h-dvh bg-kumo-canvas">
      <header className="absolute inset-x-0 top-0 border-b border-kumo-line">
        <div className="flex h-[57px] items-center justify-between px-4 sm:px-6">
          <Link
            to="/"
            aria-label="Flaremender home"
            className="flex items-center gap-2 rounded-md font-semibold focus-visible:outline-2 focus-visible:outline-kumo-focus"
          >
            <FlameIcon size={24} weight="fill" className="text-kumo-warning" />
            <span>Flaremender</span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-5 py-20">
        {eyebrow ? (
          <Text variant="secondary" DANGEROUS_className="text-center">
            {eyebrow}
          </Text>
        ) : null}
        {children}
      </main>
    </div>
  )
}
