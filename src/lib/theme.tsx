import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'

export const THEME_COOKIE = 'flaremender-theme'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const PREFERENCES: ReadonlyArray<ThemePreference> = ['light', 'dark', 'system']

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (PREFERENCES as ReadonlyArray<string>).includes(value)
}

export const themeInitScript = `(function(){try{
var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);
var p=localStorage.getItem('${THEME_COOKIE}')||(m&&decodeURIComponent(m[1]))||'system';
if(p!=='light'&&p!=='dark')p='system';
var r=p==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;
document.documentElement.dataset.mode=r;
document.documentElement.dataset.themePreference=p;
}catch(e){document.documentElement.dataset.mode='light'}})()`

const DARK_QUERY = '(prefers-color-scheme: dark)'

function subscribeToSystemTheme(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function readSystemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

function readSystemThemeOnServer(): ResolvedTheme {
  return 'light'
}

interface ThemeContextValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (next: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({
  children,
  initialPreference = 'system',
}: {
  children: React.ReactNode
  initialPreference?: ThemePreference
}) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference)
  const system = useSyncExternalStore(
    subscribeToSystemTheme,
    readSystemTheme,
    readSystemThemeOnServer,
  )

  const resolved: ResolvedTheme = preference === 'system' ? system : preference

  useEffect(() => {
    document.documentElement.dataset.mode = resolved
    document.documentElement.dataset.themePreference = preference
  }, [resolved, preference])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      localStorage.setItem(THEME_COOKIE, next)
    } catch {}
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
  }, [])

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>')
  return context
}
