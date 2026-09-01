import { Banner, Button, Input, LayerCard, SensitiveInput, Text } from '@cloudflare/kumo'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { authClient } from '#/lib/auth-client.ts'
import { useRefreshSession } from '#/lib/use-refresh-session.ts'

export const Route = createFileRoute('/_auth/signin')({ component: SignIn })

function SignIn() {
  const navigate = useNavigate()
  const refreshSession = useRefreshSession()
  const search = Route.useSearch()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const { error: signInError } = await authClient.signIn.email({ email, password })

    if (signInError) {
      setError(signInError.message ?? 'Could not sign you in.')
      setPending(false)
      return
    }

    await refreshSession()
    await navigate({ to: search.redirect ?? '/dashboard' })
  }

  return (
    <LayerCard className="px-6 py-5">
      <form onSubmit={onSubmit} className="grid gap-5">
        <div className="grid gap-1.5">
          <Text as="h1" variant="heading" DANGEROUS_className="text-xl leading-7">
            Sign in
          </Text>
          <Text variant="secondary">Welcome back. Pick up where your suite left off.</Text>
        </div>

        {error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Sign in failed"
            description={error}
          />
        ) : null}

        <div className="grid gap-4">
          <Input
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <SensitiveInput
            label="Password"
            name="password"
            autoComplete="current-password"
            placeholder="Your password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <Button type="submit" variant="primary" loading={pending} className="w-full">
          Sign in
        </Button>

        <Text variant="secondary" DANGEROUS_className="text-center">
          No account yet?{' '}
          <Link
            to="/signup"
            search={{ redirect: search.redirect }}
            className="text-kumo-link underline underline-offset-2"
          >
            Create one
          </Link>
        </Text>
      </form>
    </LayerCard>
  )
}
