import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ClipboardText,
  Dialog,
  Input,
  LayerCard,
  Select,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { BellIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { InlineEmpty } from '#/components/list.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { NOTIFICATION_KINDS, type NotificationKind } from '#/db/schema/app.ts'
import {
  DEFAULT_NOTIFICATION_EVENTS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_LABEL,
  type NotificationEventType,
} from '#/engine/notifications/events.ts'
import { notificationDeliveriesQuery, notificationDestinationsQuery } from '#/lib/queries.ts'
import {
  createNotificationDestination,
  deleteNotificationDestination,
  testNotificationDestination,
  updateNotificationDestination,
} from '#/server/notifications.ts'

const KIND_LABEL: Record<NotificationKind, string> = {
  webhook: 'Webhook',
  slack: 'Slack',
  discord: 'Discord',
  email: 'Email',
}

const KIND_HINT: Record<NotificationKind, string> = {
  webhook: 'Any HTTPS URL. Every event is POSTed as JSON and signed with a secret shown once.',
  slack: 'An incoming webhook URL from Slack (Apps → Incoming Webhooks).',
  discord: 'A channel webhook URL from Discord (Channel settings → Integrations).',
  email: 'One address. Needs Email Service enabled on this instance.',
}

type Destination =
  Awaited<ReturnType<typeof createNotificationDestination>> extends infer T
    ? Omit<T & object, 'secret'>
    : never

export function NotificationsPanel({ projectId }: { projectId: string }) {
  const { data } = useSuspenseQuery(notificationDestinationsQuery(projectId))
  const [adding, setAdding] = useState(false)

  return (
    <div className="grid gap-3">
      {data.destinations.length === 0 ? (
        <LayerCard className="px-5 py-4">
          <InlineEmpty
            message={
              data.canManage
                ? 'Nothing is told about failures yet. Add a Slack channel, a webhook or an email address.'
                : 'Nothing is told about failures yet. Owners and admins can add a destination.'
            }
          />
        </LayerCard>
      ) : (
        data.destinations.map((destination) => (
          <DestinationRow
            key={destination.id}
            projectId={projectId}
            destination={destination}
            canManage={data.canManage}
            emailEnabled={data.emailEnabled}
          />
        ))
      )}

      {data.canManage ? (
        <div>
          <Button variant="secondary" icon={<BellIcon size={16} />} onClick={() => setAdding(true)}>
            Add destination
          </Button>
        </div>
      ) : null}

      <AddDestinationDialog
        projectId={projectId}
        emailEnabled={data.emailEnabled}
        open={adding}
        onOpenChange={setAdding}
      />
    </div>
  )
}

function DestinationRow({
  projectId,
  destination,
  canManage,
  emailEnabled,
}: {
  projectId: string
  destination: Destination
  canManage: boolean
  emailEnabled: boolean
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [showDeliveries, setShowDeliveries] = useState(false)

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: notificationDestinationsQuery(projectId).queryKey })

  const toggle = useMutation({
    mutationFn: () =>
      updateNotificationDestination({
        data: { projectId, destinationId: destination.id, enabled: !destination.enabled },
      }),
    onSuccess: invalidate,
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not update', description: error.message }),
  })

  const remove = useMutation({
    mutationFn: () =>
      deleteNotificationDestination({ data: { projectId, destinationId: destination.id } }),
    onSuccess: async () => {
      await invalidate()
      toast.add({ variant: 'success', title: 'Destination removed', description: destination.name })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not remove', description: error.message }),
  })

  const send = useMutation({
    mutationFn: () =>
      testNotificationDestination({ data: { projectId, destinationId: destination.id } }),
    onSuccess: async (outcome) => {
      await invalidate()
      await queryClient.invalidateQueries({
        queryKey: notificationDeliveriesQuery(projectId, destination.id).queryKey,
      })
      toast.add(
        outcome.status === 'delivered'
          ? { variant: 'success', title: 'Test delivered', description: destination.name }
          : {
              variant: 'error',
              title: 'Test failed',
              description: outcome.error ?? 'Unknown error',
            },
      )
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not send', description: error.message }),
  })

  const emailBlocked = destination.kind === 'email' && !emailEnabled

  return (
    <LayerCard className="px-5 py-4">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="grid min-w-0 gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <Text as="span" bold>
                {destination.name}
              </Text>
              <Badge variant="secondary" className="rounded-md text-base">
                {KIND_LABEL[destination.kind]}
              </Badge>
              {!destination.enabled ? (
                <Badge variant="neutral" appearance="dot">
                  Paused
                </Badge>
              ) : destination.lastDeliveryStatus === 'failed' ? (
                <Badge variant="error" appearance="dot">
                  Last delivery failed
                </Badge>
              ) : destination.lastDeliveryStatus === 'delivered' ? (
                <Badge variant="success" appearance="dot">
                  Delivered <RelativeTime value={destination.lastDeliveryAt} />
                </Badge>
              ) : null}
            </span>
            <Text as="span" variant="mono-secondary" truncate>
              {destination.target}
            </Text>
            <Text as="span" variant="secondary" size="base">
              {destination.events
                .map((event) => NOTIFICATION_EVENT_LABEL[event as NotificationEventType] ?? event)
                .join(' · ')}
            </Text>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowDeliveries((open) => !open)}>
              {showDeliveries ? 'Hide deliveries' : 'Deliveries'}
            </Button>
            {canManage ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={send.isPending}
                  disabled={emailBlocked}
                  onClick={() => send.mutate()}
                >
                  Send test
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={toggle.isPending}
                  onClick={() => toggle.mutate()}
                >
                  {destination.enabled ? 'Pause' : 'Resume'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Remove
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {emailBlocked ? (
          <Banner
            variant="alert"
            icon={<WarningCircleIcon weight="fill" />}
            title="Email is not enabled on this instance"
            description="Enable the send_email binding and set NOTIFY_FROM_ADDRESS, then redeploy. Until then deliveries to this address are logged as failed."
          />
        ) : null}

        {showDeliveries ? (
          <DeliveryList projectId={projectId} destinationId={destination.id} />
        ) : null}
      </div>
    </LayerCard>
  )
}

function DeliveryList({ projectId, destinationId }: { projectId: string; destinationId: string }) {
  const { data, isPending, error } = useQuery(notificationDeliveriesQuery(projectId, destinationId))

  if (isPending) {
    return (
      <Text variant="secondary" size="base">
        Loading deliveries…
      </Text>
    )
  }
  if (error) {
    return (
      <Text variant="secondary" size="base">
        Could not load deliveries: {error.message}
      </Text>
    )
  }
  if (data.length === 0) {
    return (
      <Text variant="secondary" size="base">
        Nothing has been sent here yet.
      </Text>
    )
  }

  return (
    <ol className="grid gap-1.5 border-t border-kumo-hairline pt-3">
      {data.map((delivery) => (
        <li key={delivery.id} className="flex flex-wrap items-baseline gap-2">
          <Badge
            variant={delivery.status === 'delivered' ? 'success' : 'error'}
            className="rounded-md text-base"
          >
            {delivery.status === 'delivered'
              ? `Delivered${delivery.responseStatus ? ` · ${delivery.responseStatus}` : ''}`
              : 'Failed'}
          </Badge>
          <Text as="span" variant="mono-secondary">
            {delivery.event}
          </Text>
          <Text as="span" variant="secondary" size="base">
            <RelativeTime value={delivery.createdAt} />
          </Text>
          {delivery.error ? (
            <Text as="span" variant="secondary" size="base">
              {delivery.error}
            </Text>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function AddDestinationDialog({
  projectId,
  emailEnabled,
  open,
  onOpenChange,
}: {
  projectId: string
  emailEnabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [kind, setKind] = useState<NotificationKind>('slack')
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [events, setEvents] = useState<Array<NotificationEventType>>(DEFAULT_NOTIFICATION_EVENTS)
  const [secret, setSecret] = useState<string | null>(null)

  const reset = () => {
    setKind('slack')
    setName('')
    setTarget('')
    setEvents(DEFAULT_NOTIFICATION_EVENTS)
    setSecret(null)
  }

  const create = useMutation({
    mutationFn: () =>
      createNotificationDestination({
        data: { projectId, kind, name: name.trim(), target: target.trim(), events },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({
        queryKey: notificationDestinationsQuery(projectId).queryKey,
      })
      toast.add({ variant: 'success', title: 'Destination added', description: created.name })
      if (created.secret) {
        setSecret(created.secret)
      } else {
        reset()
        onOpenChange(false)
      }
    },
  })

  const kindItems = Object.fromEntries(
    NOTIFICATION_KINDS.map((value) => [
      value,
      value === 'email' && !emailEnabled
        ? `${KIND_LABEL[value]} (not enabled here)`
        : KIND_LABEL[value],
    ]),
  )

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <Dialog className="px-6 py-5">
        {secret ? (
          <div className="grid gap-5">
            <div className="grid gap-1.5">
              <Dialog.Title>
                <Text as="span" variant="heading">
                  Copy the signing secret
                </Text>
              </Dialog.Title>
              <Dialog.Description>
                <Text as="span" variant="secondary">
                  Every delivery is signed with it. It is shown once; verify the
                  X-Flaremender-Signature header with it on your side.
                </Text>
              </Dialog.Description>
            </div>
            <ClipboardText text={secret} />
            <div className="flex justify-end">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="primary">
                    Done
                  </Button>
                )}
              />
            </div>
          </div>
        ) : (
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              create.mutate()
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-1.5">
                <Dialog.Title>
                  <Text as="span" variant="heading">
                    Add a destination
                  </Text>
                </Dialog.Title>
                <Dialog.Description>
                  <Text as="span" variant="secondary">
                    {KIND_HINT[kind]}
                  </Text>
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label="Close"
                render={(props) => (
                  <Button {...props} variant="ghost" shape="square" size="sm" aria-label="Close">
                    <XIcon size={16} />
                  </Button>
                )}
              />
            </div>

            {create.error ? (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title="Could not add the destination"
                description={create.error.message}
              />
            ) : null}

            <Select
              aria-label="Kind"
              items={kindItems}
              value={kind}
              onValueChange={(value: string | null) => {
                if (value && (NOTIFICATION_KINDS as ReadonlyArray<string>).includes(value)) {
                  setKind(value as NotificationKind)
                }
              }}
            />

            <Input
              label="Name"
              placeholder={kind === 'email' ? 'On-call inbox' : '#qa-alerts'}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />

            <Input
              label={kind === 'email' ? 'Email address' : 'URL'}
              type={kind === 'email' ? 'email' : 'url'}
              placeholder={
                kind === 'slack'
                  ? 'https://hooks.slack.com/services/…'
                  : kind === 'discord'
                    ? 'https://discord.com/api/webhooks/…'
                    : kind === 'email'
                      ? 'oncall@example.com'
                      : 'https://ci.example.com/hooks/flaremender'
              }
              required
              spellCheck={false}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />

            <fieldset className="grid gap-2">
              <Text as="legend" bold>
                Send when
              </Text>
              {NOTIFICATION_EVENTS.map((event) => (
                <Checkbox
                  key={event}
                  label={NOTIFICATION_EVENT_LABEL[event]}
                  checked={events.includes(event)}
                  onCheckedChange={(checked) =>
                    setEvents((current) =>
                      checked
                        ? [...new Set([...current, event])]
                        : current.filter((item) => item !== event),
                    )
                  }
                />
              ))}
            </fieldset>

            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="secondary">
                    Cancel
                  </Button>
                )}
              />
              <Button
                type="submit"
                variant="primary"
                loading={create.isPending}
                disabled={!name.trim() || !target.trim() || events.length === 0}
              >
                Add destination
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
