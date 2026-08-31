import { Button, InputGroup, LayerCard, RefreshButton, Text } from '@cloudflare/kumo'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'

export function ListRow({
  icon,
  title,
  subtitle,
  meta,
  actions,
  footer,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <LayerCard className="px-5 py-4">
      <div className="grid gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            {icon ? (
              <span className="flex h-lh shrink-0 items-center text-kumo-subtle">{icon}</span>
            ) : null}
            <div className="grid min-w-0 gap-0.5">
              {title}
              {subtitle}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {meta}
            {actions}
          </div>
        </div>

        {footer ? (
          <div className="-mx-5 -mb-4 border-t border-kumo-line px-5 py-2.5">{footer}</div>
        ) : null}
      </div>
    </LayerCard>
  )
}

export function ListToolbar({
  value,
  onValueChange,
  placeholder,
  children,
  onRefresh,
  refreshing,
}: {
  value: string
  onValueChange: (value: string) => void
  placeholder: string
  children?: React.ReactNode
  onRefresh?: () => void
  refreshing?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <InputGroup className="min-w-56 flex-1">
        <InputGroup.Addon>
          <MagnifyingGlassIcon size={16} />
        </InputGroup.Addon>
        <InputGroup.Input
          type="search"
          aria-label={placeholder}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
        />
      </InputGroup>
      {children}
      {onRefresh ? (
        <RefreshButton aria-label="Refresh" loading={refreshing} onClick={onRefresh} />
      ) : null}
    </div>
  )
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <Text as="h2" variant="heading">
            {title}
          </Text>
          {description ? <Text variant="secondary">{description}</Text> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <LayerCard className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="grid min-w-0 gap-0.5">
          <Text as="span" bold>
            {label}
          </Text>
          {hint ? (
            <Text as="span" variant="secondary" size="base">
              {hint}
            </Text>
          ) : null}
        </div>
        {children ? <div className="flex items-center gap-2">{children}</div> : null}
      </div>
    </LayerCard>
  )
}

export function InlineEmpty({
  message,
  actionLabel,
  onAction,
}: {
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5 rounded-md border border-dashed border-kumo-line px-4 py-5 text-center">
      <Text as="span" variant="secondary" size="base">
        {message}
      </Text>
      {actionLabel && onAction ? (
        <Button variant="ghost" size="xs" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}
