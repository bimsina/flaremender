import { Link as RouterLink, defaultParseSearch } from '@tanstack/react-router'
import { LinkProvider } from '@cloudflare/kumo'
import { forwardRef } from 'react'

import type { LinkComponentProps } from '@cloudflare/kumo'

const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function AppLink(
  { href, to, ...rest },
  ref,
) {
  const destination = href ?? to
  if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) {
    return <a ref={ref} href={destination} {...rest} />
  }
  const [pathAndSearch, hash] = destination.split('#')
  const searchIndex = pathAndSearch.indexOf('?')
  const pathname = searchIndex < 0 ? pathAndSearch : pathAndSearch.slice(0, searchIndex)
  const search = searchIndex < 0 ? {} : defaultParseSearch(pathAndSearch.slice(searchIndex))
  return <RouterLink ref={ref} to={pathname} search={search} hash={hash} {...rest} />
})

export function AppLinkProvider({ children }: { children: React.ReactNode }) {
  return <LinkProvider component={AppLink}>{children}</LinkProvider>
}
