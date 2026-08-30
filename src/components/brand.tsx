import { Text, cn } from '@cloudflare/kumo'
import { WrenchIcon } from '@phosphor-icons/react'

/** App mark. Deliberately not the Cloudflare logo — this isn't a CF product. */
export function BrandMark({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-md bg-kumo-brand text-white',
        className,
      )}
      style={{ width: size * 1.75, height: size * 1.75 }}
    >
      <WrenchIcon size={size} weight="bold" />
    </span>
  )
}

export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <BrandMark />
      <Text as="span" variant="heading" size="lg">
        Flaremender
      </Text>
    </span>
  )
}
