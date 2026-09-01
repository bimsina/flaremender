import { Button, Popover, Sidebar, Text, cn } from '@cloudflare/kumo'
import { InfoIcon } from '@phosphor-icons/react'
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
  const controls = useContext(HeaderControls)
  const details = breadcrumbs && typeof description === 'string' ? description : null
  const metadata = details ? null : description
  const hasToolbar = tabs || actions || tabActions || metadata

  return (
    <header className="page-header sticky top-0 z-10 shrink-0 border-b border-kumo-line bg-kumo-canvas text-left">
      <div className="flex h-[57px] min-w-0 items-center gap-2 px-4 sm:px-6 lg:px-8">
        <Sidebar.Trigger className="shrink-0 md:hidden" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {breadcrumbs ? <div className="page-breadcrumbs min-w-0">{breadcrumbs}</div> : null}
          <h1 className={breadcrumbs ? 'sr-only' : 'min-w-0 truncate text-base font-medium'}>
            {title}
          </h1>
          {details ? (
            <Popover>
              <Popover.Trigger
                render={
                  <Button
                    variant="ghost"
                    shape="square"
                    size="sm"
                    aria-label="Page details"
                    className="shrink-0 text-kumo-subtle"
                  >
                    <InfoIcon size={16} />
                  </Button>
                }
              />
              <Popover.Content align="start" className="max-w-[min(320px,calc(100vw-32px))] p-4">
                <Popover.Title>{title}</Popover.Title>
                <Popover.Description className="mt-1.5 break-words">{details}</Popover.Description>
              </Popover.Content>
            </Popover>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">{controls}</div>
      </div>
      {hasToolbar ? (
        <div className="flex min-h-[58px] min-w-0 flex-wrap items-center gap-x-4 gap-y-3 border-t border-kumo-line px-4 py-2.5 sm:px-6 lg:px-8">
          {tabs ? <div className="min-w-0 max-w-full shrink">{tabs}</div> : null}
          {metadata ? <div className="min-w-0 text-base text-kumo-subtle">{metadata}</div> : null}
          {actions || tabActions ? (
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-1.5 sm:gap-2">
              {tabActions}
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
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
