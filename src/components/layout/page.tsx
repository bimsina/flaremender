import { Sidebar, Text, cn } from '@cloudflare/kumo'
import { ArrowSquareOutIcon } from '@phosphor-icons/react'
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

const GUTTER = 'px-4 sm:px-6 lg:px-8'

/**
 * The page chrome, laid out the way the Cloudflare dashboard lays out its own
 * pages. A list page (`compact` off) has an empty header bar and a heading block
 * with the title, a "View docs" pill and a subtitle. A detail page (`compact` on)
 * carries its breadcrumbs in the header bar and its tabs in a sticky bar under it,
 * with the page's actions on the right of that bar; a heading block is opt-in
 * through `heading="section"` for pages that need a title, badges and actions.
 */
export function PageHeader({
  title,
  description,
  actions,
  headerActions,
  breadcrumbs,
  tabs,
  tabActions,
  docsHref,
  compact = false,
  heading = compact ? 'none' : 'section',
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  headerActions?: React.ReactNode
  breadcrumbs?: React.ReactNode
  tabs?: React.ReactNode
  tabActions?: React.ReactNode
  docsHref?: string
  compact?: boolean
  heading?: 'section' | 'none'
}) {
  const controls = useContext(HeaderControls)
  const tabBar = compact && (tabs || tabActions)
  const showHeading = heading === 'section'

  return (
    <>
      <header className="page-header sticky top-0 z-10 shrink-0 border-b border-kumo-line bg-kumo-canvas text-left">
        <div className={cn('flex h-[57px] min-w-0 items-center gap-2', GUTTER)}>
          <Sidebar.Trigger className="shrink-0 md:hidden" />
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {compact && breadcrumbs ? (
              <>
                <div className="page-breadcrumbs min-w-0">{breadcrumbs}</div>
                {showHeading ? null : <h1 className="sr-only">{title}</h1>}
              </>
            ) : null}
            {compact && !breadcrumbs && !showHeading ? (
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

      {tabBar ? (
        <div
          className={cn(
            'page-tabs sticky top-[57px] z-10 flex min-h-[58px] shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-kumo-line bg-kumo-canvas py-2.5 text-left',
            GUTTER,
          )}
        >
          {tabs ? <div className="min-w-0 max-w-full shrink">{tabs}</div> : null}
          {tabActions ? (
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-1.5 sm:gap-2">
              {tabActions}
            </div>
          ) : null}
        </div>
      ) : null}

      {showHeading ? (
        <section
          className={cn('page-heading shrink-0 text-left', GUTTER, compact ? 'pt-6' : 'pt-8')}
        >
          {!compact && breadcrumbs ? (
            <div className="page-breadcrumbs mb-4 min-w-0">{breadcrumbs}</div>
          ) : null}

          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="grid min-w-0 gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="min-w-0 text-xl leading-tight font-semibold">{title}</h1>
                {docsHref ? <DocsPill href={docsHref} /> : null}
              </div>
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

          {!compact && (tabs || tabActions) ? (
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

/** The small "View docs" pill the dashboard puts next to a page title. */
function DocsPill({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-kumo-base px-2 text-xs font-medium text-kumo-default no-underline ring ring-kumo-line transition-colors hover:bg-kumo-tint"
    >
      View docs
      <ArrowSquareOutIcon size={11} className="text-kumo-subtle" />
    </a>
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
    <div className={cn('min-w-0 w-full flex-1 grid-cols-1 content-start py-6', GUTTER, className)}>
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
