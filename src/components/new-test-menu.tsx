import { Button, DropdownMenu } from '@cloudflare/kumo'
import { PencilSimpleIcon, PlusIcon, SparkleIcon } from '@phosphor-icons/react'

export function NewTestMenu({
  projectId,
  onCreateManual,
  variant = 'primary',
  size = 'base',
}: {
  projectId: string
  onCreateManual: () => void
  variant?: 'primary' | 'secondary'
  size?: 'sm' | 'base'
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant={variant} size={size} icon={<PlusIcon size={16} />}>
            New test
          </Button>
        }
      />
      <DropdownMenu.Content>
        <DropdownMenu.LinkItem href={`/projects/${projectId}?tab=chat`} icon={SparkleIcon}>
          Create with AI
        </DropdownMenu.LinkItem>
        <DropdownMenu.Item icon={PencilSimpleIcon} onClick={onCreateManual}>
          Create manually
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
