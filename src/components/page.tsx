import { Sidebar, Text, cn } from '@cloudflare/kumo'
import { createContext, useContext } from 'react'

const HeaderControls = createContext<React.ReactNode>(null)

export function PageHeaderControls({
  children,
  controls,
}: {
  children: React.ReactNode
  controls: React.ReactNode
}) {
  return <HeaderControls value={controls}>{children}</HeaderControls>
}

export function PageHeader({
  title,
  description,
  actions,
  headerActions,
  breadcrumbs,
  tabs,
  tabActions,
  compact = false,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  headerActions?: React.ReactNode
  breadcrumbs?: React.ReactNode
  tabs?: React.ReactNode
  tabActions?: React.ReactNode
  compact?: boolean
}) {
  const controls = useContext(HeaderControls)

  return (
    <>
      <header className="page-header sticky top-0 z-10 shrink-0 border-b border-kumo-line bg-kumo-canvas text-left">
        <div className="flex h-[57px] min-w-0 items-center gap-2 px-4 sm:px-6 lg:px-8">
          <Sidebar.Trigger className="shrink-0 md:hidden" />
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {compact && breadcrumbs ? (
              <>
                <div className="page-breadcrumbs min-w-0">{breadcrumbs}</div>
                <h1 className="sr-only">{title}</h1>
              </>
            ) : null}
            {compact && !breadcrumbs ? (
              <h1 className="min-w-0 truncate text-base font-medium">{title}</h1>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerActions ? (
              <div className="mr-1 flex items-center gap-2">{headerActions}</div>
            ) : null}
            {controls}
          </div>
        </div>
      </header>

      {!compact ? (
        <section className="page-heading shrink-0 px-4 pt-8 text-left sm:px-6 lg:px-8">
          {breadcrumbs ? <div className="page-breadcrumbs mb-4 min-w-0">{breadcrumbs}</div> : null}

          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="grid min-w-0 gap-1.5">
              <h1 className="min-w-0 text-xl leading-7 font-semibold tracking-tight">{title}</h1>
              {description ? (
                <div className="min-w-0 text-base text-kumo-subtle">{description}</div>
              ) : null}
            </div>
            {actions ? (
              <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-1.5 sm:gap-2">
                {actions}
              </div>
            ) : null}
          </div>

          {tabs || tabActions ? (
            <div className="mt-5 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
              {tabs ? <div className="min-w-0 max-w-full shrink">{tabs}</div> : null}
              {tabActions ? (
                <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-1.5 sm:gap-2">
                  {tabActions}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
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
