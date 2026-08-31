import { Link as RouterLink } from '@tanstack/react-router'
import { LinkProvider } from '@cloudflare/kumo'
import { forwardRef } from 'react'

import type { LinkComponentProps } from '@cloudflare/kumo'

const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function AppLink(
  { href, to: _to, ...rest },
  ref,
) {
  if (!href || /^(?:https?:)?\/\//.test(href) || href.startsWith('mailto:')) {
    return <a ref={ref} href={href} {...rest} />
  }
  return <RouterLink ref={ref} to={href} {...rest} />
})

export function AppLinkProvider({ children }: { children: React.ReactNode }) {
  return <LinkProvider component={AppLink}>{children}</LinkProvider>
}
