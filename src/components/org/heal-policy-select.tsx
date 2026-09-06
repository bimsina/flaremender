import { Select } from '@cloudflare/kumo'

import type { HealPolicy, HealPolicyChoice } from '#/db/schema/app.ts'

export const HEAL_POLICY_LABEL: Record<HealPolicy, string> = {
  off: 'Off',
  draft: 'Propose a repair for review',
  auto: 'Repair and adopt automatically',
}

export function describeHealPolicy(policy: HealPolicy): string {
  switch (policy) {
    case 'off':
      return 'A failing test stays failing until a person repairs it.'
    case 'draft':
      return 'When a ready test fails, the agent replays it, replaces the broken step and verifies the result. The repaired version waits for someone to accept it.'
    case 'auto':
      return 'When a ready test fails, the agent repairs it; if the repaired script verifies, it becomes the current version and the run is marked repaired.'
  }
}

export function HealPolicySelect({
  value,
  inheritLabel,
  loading,
  disabled,
  onChange,
  className,
  'aria-label': ariaLabel,
}: {
  value: HealPolicyChoice | HealPolicy
  /** When given, an "inherit" option is offered with this label. */
  inheritLabel?: string
  loading?: boolean
  disabled?: boolean
  onChange: (value: HealPolicyChoice) => void
  className?: string
  'aria-label': string
}) {
  const items: Record<string, string> = {
    ...(inheritLabel ? { inherit: inheritLabel } : {}),
    ...HEAL_POLICY_LABEL,
  }

  return (
    <Select
      aria-label={ariaLabel}
      className={className ?? 'w-72'}
      items={items}
      loading={loading}
      disabled={disabled}
      value={value}
      onValueChange={(next: string | null) => {
        if (next === 'inherit' || next === 'off' || next === 'draft' || next === 'auto') {
          onChange(next)
        }
      }}
    />
  )
}
