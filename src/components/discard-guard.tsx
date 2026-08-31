import { Button, Dialog, Text } from '@cloudflare/kumo'
import { useBlocker } from '@tanstack/react-router'
import { useState } from 'react'

export function useDiscardGuard(dirty: boolean) {
  const [action, setAction] = useState<(() => void) | null>(null)
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirty && current.pathname !== next.pathname,
    enableBeforeUnload: dirty,
    withResolver: true,
  })
  const open = action !== null || blocker.status === 'blocked'
  function cancel() {
    setAction(null)
    if (blocker.status === 'blocked') blocker.reset()
  }
  return {
    confirm: (next: () => void) => (dirty ? setAction(() => next) : next()),
    dialog: (
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!value) cancel()
        }}
      >
        <Dialog size="sm" className="p-6">
          <div className="grid gap-4">
            <Dialog.Title>Discard unsaved changes?</Dialog.Title>
            <Text>
              Your code and version note have not been saved. Save them first, or discard them to
              continue.
            </Text>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={cancel}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const next = action
                  setAction(null)
                  if (blocker.status === 'blocked') blocker.proceed()
                  next?.()
                }}
              >
                Discard and continue
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    ),
  }
}
