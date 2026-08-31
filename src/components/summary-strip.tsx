import { Text, cn } from '@cloudflare/kumo'

export interface SummaryItem {
  key: string
  /** Muted caption. An icon belongs here, next to the word. */
  label: React.ReactNode
  /** The number or pill the eye is meant to land on. */
  value: React.ReactNode
  /** Dims the whole segment — a count of zero is worth showing, quietly. */
  dim?: boolean
  /** Long identifiers, URLs or test names can use the full row. */
  wide?: boolean
}

/**
 * One bordered row divided into segments by hairlines: the shape the Workflows
 * dashboard uses both for a status roll-up above a table and for the key facts
 * above an instance's detail.
 *
 * Metadata reflows into a grid on narrow screens. Long names may use a full
 * row so the report's identifying context remains readable.
 */
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
