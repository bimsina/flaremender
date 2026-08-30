import { Banner, Button, Input, LayerCard, SensitiveInput, Text } from '@cloudflare/kumo'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { authClient } from '#/lib/auth-client.ts'
import { useRefreshSession } from '#/lib/use-refresh-session.ts'

export const Route = createFileRoute('/_auth/signup')({ component: SignUp })

const MIN_PASSWORD_LENGTH = 8

function SignUp() {
  const navigate = useNavigate()
  const refreshSession = useRefreshSession()
  const search = Route.useSearch()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const mismatch = confirm.length > 0 && confirm !== password

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Those passwords do not match.')
      return
    }

    setPending(true)
    const { error: signUpError } = await authClient.signUp.email({ name, email, password })

    if (signUpError) {
      setError(signUpError.message ?? 'Could not create your account.')
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
          <Text as="h1" variant="heading">
            Create your account
          </Text>
          <Text variant="secondary">You will set up your first organization right after this.</Text>
        </div>

        {error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Sign up failed"
            description={error}
          />
        ) : null}

        <div className="grid gap-4">
          <Input
            label="Name"
            name="name"
            autoComplete="name"
            placeholder="Ada Lovelace"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
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
            autoComplete="new-password"
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <SensitiveInput
            label="Confirm password"
            name="confirmPassword"
            autoComplete="new-password"
            placeholder="Type it again"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            variant={mismatch ? 'error' : 'default'}
            error={mismatch ? 'Those passwords do not match.' : undefined}
          />
        </div>

        <Button type="submit" variant="primary" loading={pending}>
          Create account
        </Button>

        <Text variant="secondary" DANGEROUS_className="text-center">
          Already have an account?{' '}
          <Link
            to="/signin"
            search={{ redirect: search.redirect }}
            className="text-kumo-link underline underline-offset-2"
          >
            Sign in
          </Link>
        </Text>
      </form>
    </LayerCard>
  )
}
