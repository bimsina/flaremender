import { Button, Input, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { SettingRow } from '#/components/list.tsx'

/**
 * One row to point model calls at an AI Gateway. Empty means direct to the
 * provider. The same row serves the instance (admin) and an organization override.
 */
export function AiGatewayRow({
  value,
  scope,
  inherited,
  canManage,
  save,
}: {
  value: string | null
  scope: 'instance' | 'organization'
  /** For an organization row: what the instance uses when the override is empty. */
  inherited?: string | null
  canManage: boolean
  save: (aiGatewayId: string | null) => Promise<unknown>
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [draft, setDraft] = useState(value ?? '')
  const [seen, setSeen] = useState(value ?? '')
  if (seen !== (value ?? '')) {
    setSeen(value ?? '')
    setDraft(value ?? '')
  }

  const mutation = useMutation({
    mutationFn: () => save(draft.trim() || null),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'success',
        title: draft.trim() ? 'AI Gateway saved' : 'AI Gateway turned off',
      })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not save', description: error.message }),
  })

  const dirty = draft.trim() !== (value ?? '')
  const effective = value ?? inherited ?? null

  const hint =
    scope === 'instance'
      ? effective
        ? `Every model call goes through the "${effective}" gateway: logged, cacheable, rate-limited. A provider with no key runs on the account's prepaid AI Gateway credits.`
        : 'Off. Calls go straight to each provider with its key. Enter a gateway id ("default" is created for you on first use) to log every call, and to let providers with no key run on prepaid Cloudflare credits.'
      : value
        ? `This organization's calls go through its own "${value}" gateway, so its usage and spend show up separately.`
        : inherited
          ? `Inherits the instance gateway "${inherited}". Set one here to see this organization's spend on its own.`
          : 'The instance has no gateway. Set one here to route only this organization through AI Gateway.'

  return (
    <SettingRow label="AI Gateway" hint={hint}>
      <Input
        aria-label="AI Gateway id"
        className="w-52 font-mono"
        placeholder={scope === 'organization' && inherited ? inherited : 'default'}
        spellCheck={false}
        disabled={!canManage}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {canManage ? (
        <Button
          variant={dirty ? 'primary' : 'secondary'}
          size="sm"
          loading={mutation.isPending}
          disabled={!dirty}
          onClick={() => mutation.mutate()}
        >
          Save
        </Button>
      ) : null}
      {canManage && value ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft('')
          }}
        >
          Clear
        </Button>
      ) : null}
      <Text as="span" variant="secondary" size="base">
        {scope === 'instance' ? 'Instance-wide' : 'Organization override'}
      </Text>
    </SettingRow>
  )
}
