import { DropdownMenu } from '@cloudflare/kumo'
import { CheckIcon, type Icon } from '@phosphor-icons/react'

export function MenuRadioItem({
  value,
  icon,
  children,
}: {
  value: string
  icon?: Icon
  children: React.ReactNode
}) {
  return (
    <DropdownMenu.RadioItem value={value} icon={icon}>
      <span className="flex flex-1 items-center justify-between gap-4">
        {children}
        <DropdownMenu.RadioItemIndicator>
          <CheckIcon size={14} />
        </DropdownMenu.RadioItemIndicator>
      </span>
    </DropdownMenu.RadioItem>
  )
}
