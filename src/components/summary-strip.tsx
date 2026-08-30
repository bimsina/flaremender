import { Text, cn } from '@cloudflare/kumo'

export interface SummaryItem {
  key: string
  /** Muted caption. An icon belongs here, next to the word. */
  label: React.ReactNode
  /** The number or pill the eye is meant to land on. */
  value: React.ReactNode
  /** Dims the whole segment — a count of zero is worth showing, quietly. */
  dim?: boolean
}

/**
 * One bordered row divided into segments by hairlines: the shape the Workflows
 * dashboard uses both for a status roll-up above a table and for the key facts
 * above an instance's detail.
 *
 * The row never wraps. Segments hold a minimum width and the strip scrolls
 * instead, because a summary that reflows into two ragged rows stops being
 * scannable at exactly the width where scanning matters.
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
      className={cn('overflow-x-auto rounded-lg bg-kumo-base ring ring-kumo-hairline', className)}
    >
      <div className="flex">
        {items.map((item, index) => (
          <div
            key={item.key}
            className={cn(
              'grid min-w-36 flex-1 content-start gap-1.5 px-4 py-3',
              index > 0 && 'border-l border-kumo-hairline',
              item.dim && 'opacity-60',
            )}
          >
            <Text as="span" variant="secondary" size="xs">
              <span className="flex items-center gap-1.5">{item.label}</span>
            </Text>
            <div className="text-kumo-default">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
