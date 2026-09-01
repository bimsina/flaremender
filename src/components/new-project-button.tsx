import { LinkButton } from '@cloudflare/kumo'
import { PlusIcon } from '@phosphor-icons/react'
import { createLink } from '@tanstack/react-router'

const RouterLinkButton = createLink(LinkButton)

export function NewProjectButton({
  children = 'New project',
  variant = 'primary',
  size = 'base',
}: {
  children?: React.ReactNode
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'xs' | 'sm' | 'base' | 'lg'
}) {
  return (
    <RouterLinkButton to="/projects/new" variant={variant} size={size} icon={PlusIcon}>
      {children}
    </RouterLinkButton>
  )
}
