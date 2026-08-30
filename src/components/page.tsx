import { Sidebar, Text, cn } from '@cloudflare/kumo'

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  breadcrumbs?: React.ReactNode
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-kumo-line bg-kumo-canvas">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-end justify-between gap-4 px-6 py-4">
        <div className="flex min-w-0 items-end gap-3">
          {/* The sidebar is off-canvas below md, so this is the only way back. */}
          <Sidebar.Trigger className="mb-1 md:hidden" />
          <div className="grid min-w-0 gap-1.5">
            {breadcrumbs}
            <Text as="h1" variant="heading" size="lg">
              {title}
            </Text>
            {description ? <Text variant="secondary">{description}</Text> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  )
}

export function PageBody({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('mx-auto w-full max-w-6xl flex-1 content-start px-6 py-6', className)}>
      {children}
    </div>
  )
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: string
}) {
  return (
    <div className="grid gap-1.5 rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-hairline">
      <Text as="span" variant="secondary" size="xs">
        {label}
      </Text>
      <Text as="span" variant="heading" size="lg">
        {value}
      </Text>
      {hint ? (
        <Text as="span" variant="secondary" size="xs">
          {hint}
        </Text>
      ) : null}
    </div>
  )
}
