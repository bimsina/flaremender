import { Text, cn } from '@cloudflare/kumo'

export interface SummaryItem {
  key: string
  label: React.ReactNode
  value: React.ReactNode
  dim?: boolean
  wide?: boolean
}

export function SummaryStrip({
  items,
  className,
}: {
  items: Array<SummaryItem>
  className?: string
}) {
  return (
    <div
      className={cn('overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-hairline', className)}
    >
      <div className="grid grid-cols-2 divide-x divide-y divide-kumo-hairline md:grid-cols-3 xl:grid-cols-6">
        {items.map((item) => (
          <div
            key={item.key}
            className={cn(
              'grid min-w-0 content-start gap-1.5 px-4 py-3',
              item.dim && 'opacity-60',
              item.wide && 'col-span-full',
            )}
          >
            <Text as="span" variant="secondary" size="base">
              <span className="flex items-center gap-1.5">{item.label}</span>
            </Text>
            <div className="min-w-0 break-words text-kumo-default">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
