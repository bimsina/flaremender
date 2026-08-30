import { Button, Empty, LayerCard, Text } from '@cloudflare/kumo'
import { CompassIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { Link, useRouter } from '@tanstack/react-router'

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-kumo-canvas px-5 py-12">
      <div className="w-full max-w-md">{children}</div>
    </div>
  )
}

export function NotFound() {
  return (
    <Centered>
      <Empty
        icon={<CompassIcon size={48} className="text-kumo-inactive" />}
        title="Page not found"
        description="That URL doesn't match anything in Flaremender."
        contents={
          <Link to="/">
            <Button variant="primary">Back to the start</Button>
          </Link>
        }
      />
    </Centered>
  )
}

export function RouteError({ error }: { error: Error }) {
  const router = useRouter()

  return (
    <Centered>
      <LayerCard className="px-6 py-5">
        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <div className="flex items-start gap-2">
              <span className="h-lh flex items-center">
                <WarningCircleIcon size={20} weight="fill" className="text-kumo-danger" />
              </span>
              <Text as="h1" variant="heading">
                Something went wrong
              </Text>
            </div>
            <Text variant="secondary">{error.message}</Text>
          </div>

          <div className="flex justify-end gap-2">
            <Link to="/">
              <Button variant="secondary">Go home</Button>
            </Link>
            <Button variant="primary" onClick={() => void router.invalidate()}>
              Try again
            </Button>
          </div>
        </div>
      </LayerCard>
    </Centered>
  )
}
