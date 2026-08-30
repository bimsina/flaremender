import { Button, DropdownMenu, Tabs } from '@cloudflare/kumo'
import { DesktopIcon, MoonIcon, SunIcon } from '@phosphor-icons/react'

import { useTheme, type ThemePreference } from '#/lib/theme.tsx'
import { MenuRadioItem } from './menu-radio-item.tsx'

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: DesktopIcon },
]

export function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme()
  const CurrentIcon =
    preference === 'system' ? DesktopIcon : resolved === 'dark' ? MoonIcon : SunIcon

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" shape="square" size="sm" aria-label="Change theme">
            <CurrentIcon size={16} />
          </Button>
        }
      />
      <DropdownMenu.Content>
        <DropdownMenu.RadioGroup
          value={preference}
          onValueChange={(value) => setPreference(value as ThemePreference)}
        >
          {OPTIONS.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} icon={option.icon}>
              {option.label}
            </MenuRadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

export function ThemeSegmentedControl() {
  const { preference, setPreference } = useTheme()

  return (
    <Tabs
      variant="segmented"
      value={preference}
      onValueChange={(value) => setPreference(value as ThemePreference)}
      tabs={OPTIONS.map((option) => ({
        value: option.value,
        label: (
          <span className="flex items-center gap-1.5">
            <option.icon size={14} />
            {option.label}
          </span>
        ),
      }))}
    />
  )
}
