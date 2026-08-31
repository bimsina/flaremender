import { ScrollableTabs } from './scrollable-tabs.tsx'
import { Sidebar, Text, cn } from '@cloudflare/kumo'

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  tabs,
  tabActions,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  breadcrumbs?: React.ReactNode
  tabs?: React.ReactNode
  tabActions?: React.ReactNode
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-kumo-line bg-kumo-canvas">
      <div className="w-full px-4 text-left sm:px-6 lg:px-8">
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-4 pt-6',
            tabs ? 'pb-5' : 'pb-6',
          )}
        >
          <div className="flex min-w-0 items-end gap-3">
            <Sidebar.Trigger className="mb-1 md:hidden" />
            <div className="grid min-w-0 gap-1.5">
              {breadcrumbs}
              <Text as="h1" variant="heading" DANGEROUS_className="text-2xl">
                {title}
              </Text>
              {description ? <Text variant="secondary">{description}</Text> : null}
            </div>
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>

        {tabs ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
            <ScrollableTabs>{tabs}</ScrollableTabs>
            {tabActions ? (
              <div className="flex flex-wrap items-center gap-2">{tabActions}</div>
            ) : null}
          </div>
        ) : null}
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
    <div
      className={cn(
        'min-w-0 w-full flex-1 grid-cols-1 content-start px-4 py-6 sm:px-6 lg:px-8',
        className,
      )}
    >
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
  hint?: React.ReactNode
}) {
  return (
    <div className="grid content-start gap-1.5 rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-hairline">
      <Text as="span" variant="secondary" size="base">
        {label}
      </Text>
      <Text as="span" variant="heading" DANGEROUS_className="text-2xl tabular-nums">
        {value}
      </Text>
      {hint ? (
        <Text as="span" variant="secondary" size="base">
          {hint}
        </Text>
      ) : null}
    </div>
  )
}
